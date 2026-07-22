import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../src/adapters/types.js";
import { compressMessages, getEngine } from "../src/compression/index.js";
import { ProseShrinkEngine, segment } from "../src/compression/prose.js";
import { estimateTokens } from "../src/compression/tokens.js";

/**
 * The load-bearing test: prose shrinks, but code blocks, inline code, URLs, and
 * structured JSON survive byte-for-byte.
 */

const FENCED = ["```js", "const x = 1;    // spaces    inside    must    survive", "function  f() { return   42; }", "```"].join("\n");
const INLINE = "`let   y = 2;`";
const URL = "https://example.com/path?a=1&b=2";
const JSON_BLOB = '{"a":   1, "nested": {"b":    [1,2,3]}}';

const FIXTURE = [
  "Here    is     some      very    spaced   prose.",
  "",
  "",
  "",
  "Look at this code:",
  FENCED,
  `And inline ${INLINE} too.`,
  `See ${URL}   for   details.`,
  `Config: ${JSON_BLOB}  end.`,
  "More     prose      here.",
].join("\n");

describe("ProseShrinkEngine preservation", () => {
  const { text: out, before, after } = new ProseShrinkEngine().compress(FIXTURE);

  it("preserves fenced code blocks byte-for-byte", () => {
    expect(out).toContain(FENCED);
  });
  it("preserves inline code byte-for-byte", () => {
    expect(out).toContain(INLINE);
  });
  it("preserves URLs byte-for-byte", () => {
    expect(out).toContain(URL);
  });
  it("preserves structured JSON byte-for-byte", () => {
    expect(out).toContain(JSON_BLOB);
  });
  it("shrinks the surrounding prose", () => {
    expect(out).toContain("Here is some very spaced prose.");
    expect(out).toContain("More prose here.");
    expect(out).not.toContain("Here    is"); // the wide run is gone
    expect(after).toBeLessThan(before);
  });
  it("collapses 3+ blank lines to one", () => {
    expect(out).not.toMatch(/\n{3,}/);
  });
});

describe("segment", () => {
  it("treats an unbalanced brace as prose, not JSON", () => {
    const segs = segment("text { not json here");
    expect(segs.every((s) => !s.protected)).toBe(true);
  });
  it("does not misclassify a JSON-looking-but-invalid span", () => {
    const segs = segment("{not: valid json}");
    // Not valid JSON (unquoted key) → prose, not protected.
    expect(segs.some((s) => s.protected)).toBe(false);
  });
});

describe("engine registry", () => {
  it("returns null for off/empty/unknown, the engine for a known mode", () => {
    expect(getEngine(undefined)).toBeNull();
    expect(getEngine("")).toBeNull();
    expect(getEngine("off")).toBeNull();
    expect(getEngine("bogus")).toBeNull();
    expect(getEngine("prose")?.mode).toBe("prose");
  });
});

describe("compressMessages", () => {
  it("compresses each message and sums before/after estimates", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "You    are    helpful." },
      { role: "user", content: `Run this: ${INLINE}` },
    ];
    const engine = getEngine("prose")!;
    const r = compressMessages(messages, engine);
    expect(r.messages[0]!.content).toBe("You are helpful.");
    expect(r.messages[1]!.content).toContain(INLINE); // inline code preserved
    expect(r.before).toBeGreaterThan(0);
    expect(r.after).toBeGreaterThan(0);
    expect(r.before).toBe(
      estimateTokens("You    are    helpful.") + estimateTokens(`Run this: ${INLINE}`),
    );
  });
});
