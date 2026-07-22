import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicAdapter } from "../src/adapters/anthropic.js";
import type { ChatMessage } from "../src/adapters/types.js";
import { compressMessages, getEngine } from "../src/compression/index.js";

/**
 * Compression × Anthropic interaction.
 *
 * Anthropic is the first adapter where "the request" is NOT a flat string — the
 * adapter builds typed content blocks. Compression runs earlier, on the
 * normalized (string) messages, so the invariant to prove is: compression only
 * rewrites the TEXT that ends up inside a block, and never disturbs the block
 * structure or the protected spans (code / URLs / JSON) inside it.
 */

const FENCE = ["```py", "def f(x):    # spaces    inside    must    survive", "    return x", "```"].join("\n");
const URL = "https://example.com/a?b=1&c=2";
const JSON_BLOB = '{"k":   1, "nested": {"a":    [1,2]}}';

const VERBOSE_SYSTEM = "You    are    a    terse    assistant.";
const VERBOSE_USER = [
  `Please    review    this:`,
  FENCE,
  `See ${URL}   for   context.`,
  `Config: ${JSON_BLOB}  done.`,
].join("\n");

function jsonRes(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.restoreAllMocks());

describe("prose compression through the Anthropic adapter", () => {
  it("preserves block structure and protected spans while shrinking prose", async () => {
    let sent: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sent = JSON.parse(String(init.body));
        return jsonRes({
          model: "claude-opus-4-8",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      }),
    );

    const messages: ChatMessage[] = [
      { role: "system", content: VERBOSE_SYSTEM },
      { role: "user", content: VERBOSE_USER },
    ];

    // 1. Compress at the normalized layer (what the server does).
    const engine = getEngine("prose")!;
    const compressed = compressMessages(messages, engine);
    expect(compressed.after).toBeLessThan(compressed.before);

    // 2. Hand the compressed request to the native adapter.
    const adapter = new AnthropicAdapter({
      id: "anthropic",
      kind: "anthropic",
      baseUrl: "https://api.anthropic.test/v1",
      apiKey: "sk-ant-x",
    });
    await adapter.chat({ model: "claude-opus-4-8", messages: compressed.messages });

    // --- Block STRUCTURE is intact -----------------------------------------
    expect(Array.isArray(sent.messages)).toBe(true);
    expect(sent.messages).toHaveLength(1); // system was hoisted, not a turn
    expect(sent.messages[0].role).toBe("user");
    expect(Array.isArray(sent.messages[0].content)).toBe(true);
    expect(sent.messages[0].content[0].type).toBe("text");
    expect(typeof sent.messages[0].content[0].text).toBe("string");
    // System is still a top-level string field, and was compressed too.
    expect(sent.system).toBe("You are a terse assistant.");

    // --- Protected spans survive byte-for-byte INSIDE the block -------------
    const blockText: string = sent.messages[0].content[0].text;
    expect(blockText).toContain(FENCE);
    expect(blockText).toContain(URL);
    expect(blockText).toContain(JSON_BLOB);

    // --- Surrounding prose shrank ------------------------------------------
    expect(blockText).toContain("Please review this:");
    expect(blockText).not.toContain("Please    review");
  });

  it("leaves the request untouched when compression is off", async () => {
    let sent: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sent = JSON.parse(String(init.body));
        return jsonRes({
          model: "claude-opus-4-8",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      }),
    );
    expect(getEngine(undefined)).toBeNull(); // off by default

    const adapter = new AnthropicAdapter({
      id: "anthropic",
      kind: "anthropic",
      baseUrl: "https://api.anthropic.test/v1",
      apiKey: "sk-ant-x",
    });
    await adapter.chat({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: VERBOSE_USER }],
    });

    expect(sent.messages[0].content[0].text).toBe(VERBOSE_USER); // verbatim
  });
});
