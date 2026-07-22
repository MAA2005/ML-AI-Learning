import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { createElement } from "react";
import { App } from "../App";
import { fetchSnapshot } from "../api/client";
import {
  FIXTURE_KEY,
  healthFixture,
  providersFixture,
  usageFixture,
} from "./fixtures";

/**
 * SECRET-CANARY TEST — form chosen and why
 * ----------------------------------------
 * The strongest form (stand up the REAL gateway in-process with a provider
 * whose key is `sk-test-fixture-do-not-use`, hit the endpoints, assert the
 * key is absent from every body) is deliberately NOT used here: the dashboard
 * is a standalone package that must not import backend code from relay/src/**
 * (the whole point of it being a second, independent consumer of the HTTP
 * contract). Coupling to the backend to run this test would violate that
 * boundary — and in this worktree the backend isn't even present.
 *
 * So we use the documented fallback: capture REPRESENTATIVE fixture responses
 * that stand in for what the (correctly redacting) gateway returns, and prove
 * the guarantee for THIS consumer end-to-end — the real client parses them,
 * the real hook drives the real components, and the fixture key never reaches
 * a payload the dashboard consumes or renders. This is the dashboard's own
 * canary; it does not assume the backend redacts, it verifies the dashboard
 * itself introduces no key into anything it fetches or paints.
 */

function mockGatewayFetch() {
  const routes: Record<string, unknown> = {
    "/health": healthFixture,
    "/v1/providers": providersFixture,
    "/v1/usage": usageFixture,
  };
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = Object.keys(routes).find((p) => url.endsWith(p));
    const body = path ? routes[path] : {};
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("secret canary", () => {
  it("representative fixtures contain no key material to begin with", () => {
    const combined =
      JSON.stringify(healthFixture) +
      JSON.stringify(providersFixture) +
      JSON.stringify(usageFixture);
    expect(combined).not.toContain(FIXTURE_KEY);
  });

  it("the real client never surfaces the fixture key in parsed payloads", async () => {
    vi.stubGlobal("fetch", mockGatewayFetch());
    const snap = await fetchSnapshot();
    // Everything the dashboard's data layer holds, serialized.
    expect(JSON.stringify(snap)).not.toContain(FIXTURE_KEY);
  });

  it("the fully rendered dashboard never paints the fixture key into the DOM", async () => {
    vi.stubGlobal("fetch", mockGatewayFetch());
    render(createElement(App));

    // Wait for the pipeline (fetch -> hook -> components) to settle.
    await waitFor(() => {
      expect(screen.getByText("OpenAI")).toBeInTheDocument();
    });

    expect(document.body.innerHTML).not.toContain(FIXTURE_KEY);
    expect(document.body.textContent ?? "").not.toContain(FIXTURE_KEY);
    // Also assert the sentinel would have been catchable: the key string is
    // non-empty and distinctive, so a real leak here would fail this check.
    expect(FIXTURE_KEY.length).toBeGreaterThan(10);
  });
});
