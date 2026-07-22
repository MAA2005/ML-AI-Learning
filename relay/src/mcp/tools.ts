import { z } from "zod";
import type { McpContext } from "./context.js";

/**
 * The MCP tool surface — deliberately narrow and read-only.
 *
 * Present: list_providers, list_chains, get_usage, get_recent_attempts.
 * Absent by design: NO add/remove_provider, NO get_config / env access, NO
 * arbitrary query over the store. Every handler returns an allowlisted DTO built
 * in dto.ts, so no secret can ride along. If a write capability is ever wanted,
 * that's a separate, deliberate decision — not a door left open here.
 *
 * Tools are defined as plain data (name, description, zod input schema, handler)
 * so the security tests can exercise them directly, independent of the MCP SDK.
 */

export interface McpTool<A = unknown> {
  name: string;
  description: string;
  // Third generic (Input) is `any` so schemas with `.default()` (optional input,
  // required output) still fit.
  inputSchema: z.ZodType<A, z.ZodTypeDef, any>;
  handler: (args: A, ctx: McpContext) => Promise<unknown>;
}

const ListProvidersInput = z.object({
  probe: z
    .boolean()
    .default(false)
    .describe("If true, make a live health probe to each provider (external call)."),
});

const EmptyInput = z.object({});

const RecentAttemptsInput = z.object({
  limit: z.number().int().positive().max(200).default(20),
});

export const listProvidersTool: McpTool<z.infer<typeof ListProvidersInput>> = {
  name: "list_providers",
  description:
    "List configured providers with enabled/health/circuit-breaker state and known model ids. Never returns base URLs, keys, or raw config.",
  inputSchema: ListProvidersInput,
  handler: async (args, ctx) => ({ providers: await ctx.listProviderStatus(args.probe) }),
};

export const listChainsTool: McpTool<z.infer<typeof EmptyInput>> = {
  name: "list_chains",
  description:
    "List routing chains: name, strategy, and the ordered provider names in each. No credentials.",
  inputSchema: EmptyInput,
  handler: async (_args, ctx) => ({ chains: ctx.listChains() }),
};

export const getUsageTool: McpTool<z.infer<typeof EmptyInput>> = {
  name: "get_usage",
  description:
    "Token and cost totals per provider and per chain, from the local usage ledger.",
  inputSchema: EmptyInput,
  handler: async (_args, ctx) => ctx.getUsage(),
};

export const getRecentAttemptsTool: McpTool<z.infer<typeof RecentAttemptsInput>> = {
  name: "get_recent_attempts",
  description:
    "Recent gateway requests: provider, chain, outcome, latency, and cost. Redacted — never headers or request/response bodies.",
  inputSchema: RecentAttemptsInput,
  handler: async (args, ctx) => ({ attempts: ctx.getRecentAttempts(args.limit) }),
};

/** The complete, ordered tool list. Adding/removing here is a reviewable change
 *  the tool-manifest snapshot test will flag. */
export const MCP_TOOLS: McpTool<any>[] = [
  listProvidersTool,
  listChainsTool,
  getUsageTool,
  getRecentAttemptsTool,
];
