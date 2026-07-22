import { createServer } from "node:http";
import type { z } from "zod";
import type { McpContext } from "./context.js";
import { MCP_TOOLS } from "./tools.js";

/**
 * MCP transport wiring. The security-critical logic (allowlisted DTOs, the tool
 * surface) lives in dto.ts/tools.ts and is SDK-independent; this module only
 * binds those tools to a transport.
 *
 * Binding policy:
 *   - stdio is the primary target (local Claude Code / Cursor): no network at all.
 *   - HTTP is opt-in and binds to 127.0.0.1 by default. Binding to any non-loopback
 *     interface REQUIRES an explicit allowExternal flag — we never default to
 *     0.0.0.0. This mirrors Relay's non-goal of exposing nothing the user didn't
 *     explicitly configure.
 *
 * The SDK is an optional dependency, dynamically imported with a clear error if
 * it isn't installed.
 */

async function loadSdk() {
  try {
    const [{ McpServer }, { StdioServerTransport }, { StreamableHTTPServerTransport }] =
      await Promise.all([
        import("@modelcontextprotocol/sdk/server/mcp.js"),
        import("@modelcontextprotocol/sdk/server/stdio.js"),
        import("@modelcontextprotocol/sdk/server/streamableHttp.js"),
      ]);
    return { McpServer, StdioServerTransport, StreamableHTTPServerTransport };
  } catch (err) {
    throw new Error(
      "The MCP SDK is not installed. Run `npm install @modelcontextprotocol/sdk` to use `relay mcp`.\n" +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/**
 * Guard the HTTP bind: loopback is always fine; any other interface (including
 * 0.0.0.0 / ::) requires an explicit opt-in. Throws otherwise. Pure + exported
 * so the refusal is unit-tested without standing up a transport.
 */
export function assertBindableHost(host: string, allowExternal: boolean): void {
  if (!isLoopbackHost(host) && !allowExternal) {
    throw new Error(
      `Refusing to bind MCP HTTP to non-loopback host "${host}" without --allow-external. ` +
        `Default is 127.0.0.1; pass --allow-external only if you really mean to expose it.`,
    );
  }
}

/** Build an McpServer with the four read-only tools registered. */
async function buildMcpServer(ctx: McpContext) {
  const { McpServer } = await loadSdk();
  const server = new McpServer({ name: "relay", version: "0.0.1" });

  for (const tool of MCP_TOOLS) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        // The zod object's shape is the SDK's expected input schema form.
        inputSchema: (tool.inputSchema as unknown as { shape: z.ZodRawShape }).shape,
        // Advertise these as read-only, non-destructive tools to the client.
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
      async (args: unknown) => {
        const result = await tool.handler(args as never, ctx);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      },
    );
  }
  return server;
}

/** Start the MCP server over stdio (no network exposure). */
export async function startStdio(ctx: McpContext): Promise<void> {
  const { StdioServerTransport } = await loadSdk();
  const server = await buildMcpServer(ctx);
  // NOTE: stdout is the MCP channel — status goes to stderr only.
  process.stderr.write("relay mcp: listening on stdio\n");
  await server.connect(new StdioServerTransport());
}

export interface HttpOptions {
  host?: string;
  port?: number;
  /** Required to bind any non-loopback interface. */
  allowExternal?: boolean;
}

/** Start the MCP server over Streamable HTTP, localhost-only by default. */
export async function startHttp(ctx: McpContext, opts: HttpOptions = {}): Promise<void> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 8788;
  assertBindableHost(host, opts.allowExternal ?? false);

  const { StreamableHTTPServerTransport } = await loadSdk();
  const server = await buildMcpServer(ctx);
  // Stateless mode: no session id generator.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);

  const http = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = body ? safeJson(body) : undefined;
      void transport.handleRequest(req, res, parsed);
    });
  });

  await new Promise<void>((resolve) => http.listen(port, host, resolve));
  process.stderr.write(`relay mcp: HTTP listening on http://${host}:${port}\n`);
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
