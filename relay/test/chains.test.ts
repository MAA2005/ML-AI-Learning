import { describe, expect, it } from "vitest";
import { RelayConfigFile, stripJsonComments } from "../src/config/chains.js";

describe("stripJsonComments", () => {
  it("removes line and block comments but preserves strings", () => {
    const jsonc = `{
      // a line comment
      "name": "default", /* inline */ "strategy": "ordered",
      "url": "https://x/y", // not a comment inside the string above
      "providers": [{ "id": "a" }]
    }`;
    const parsed = JSON.parse(stripJsonComments(jsonc));
    expect(parsed.name).toBe("default");
    expect(parsed.url).toBe("https://x/y");
    expect(parsed.providers[0].id).toBe("a");
  });

  it("does not treat // inside a string literal as a comment", () => {
    const jsonc = `{ "u": "a//b/*c*/d" }`;
    expect(JSON.parse(stripJsonComments(jsonc)).u).toBe("a//b/*c*/d");
  });
});

describe("RelayConfigFile schema", () => {
  it("defaults strategy to ordered and requires >=1 provider", () => {
    const parsed = RelayConfigFile.parse({
      chains: [{ name: "c", providers: [{ id: "a" }] }],
    });
    expect(parsed.chains[0]?.strategy).toBe("ordered");
  });

  it("rejects a chain with no providers", () => {
    expect(() =>
      RelayConfigFile.parse({ chains: [{ name: "c", providers: [] }] }),
    ).toThrow();
  });
});
