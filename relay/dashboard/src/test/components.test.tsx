import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { UsageView } from "../components/UsageView";
import { RecentView } from "../components/RecentView";
import { ProvidersView } from "../components/ProvidersView";
import { healthFixture, providersFixture, usageFixture } from "./fixtures";

afterEach(cleanup);

describe("UsageView", () => {
  it("renders a dollar total and flags unpriced requests with a footnote", () => {
    render(<UsageView byProvider={usageFixture.byProvider} />);
    expect(screen.getByText(/Total: \$0\.73/)).toBeInTheDocument();
    // Footnote explaining unpriced requests is present.
    expect(screen.getByText(/could not be priced/i)).toBeInTheDocument();
    // The unpriced row shows an asterisk marker.
    const marks = screen.getAllByText("*");
    expect(marks.length).toBeGreaterThan(0);
  });

  it("shows an empty state when there is no usage", () => {
    render(<UsageView byProvider={[]} />);
    expect(screen.getByText(/no usage recorded/i)).toBeInTheDocument();
  });

  it("tolerates undefined byProvider", () => {
    render(<UsageView byProvider={undefined} />);
    expect(screen.getByText(/no usage recorded/i)).toBeInTheDocument();
  });
});

describe("RecentView", () => {
  it("lists attempts newest-first with outcome and renders null cost as a dash", () => {
    render(<RecentView recent={usageFixture.recent} />);
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    // Newest (ts ...060_000) is the groq error, so it should be first.
    expect(within(rows[0]).getByText("groq")).toBeInTheDocument();
    expect(within(rows[0]).getByText("error")).toBeInTheDocument();
    // Null cost renders as an em dash, not $0 or a fabricated value.
    expect(within(rows[0]).getByText("—")).toBeInTheDocument();
  });

  it("shows an empty state for no attempts", () => {
    render(<RecentView recent={[]} />);
    expect(screen.getByText(/no recent attempts/i)).toBeInTheDocument();
  });
});

describe("ProvidersView", () => {
  it("shows the key-store backend and per-provider health", () => {
    render(
      <ProvidersView
        providers={providersFixture}
        health={healthFixture}
        byChain={usageFixture.byChain}
      />
    );
    expect(screen.getByText(/Key store: OS keychain/i)).toBeInTheDocument();
    expect(screen.getByText("OpenAI")).toBeInTheDocument();
    // Unhealthy provider surfaces its detail.
    expect(screen.getByText(/connection refused/i)).toBeInTheDocument();
    // Chains subsection renders when byChain is present.
    expect(screen.getByText("Chains")).toBeInTheDocument();
  });

  it("omits the chains subsection gracefully when byChain is absent", () => {
    render(
      <ProvidersView providers={providersFixture} health={healthFixture} byChain={undefined} />
    );
    expect(screen.queryByText("Chains")).not.toBeInTheDocument();
  });

  it("renders an empty state with no providers", () => {
    render(<ProvidersView providers={{ providers: [] }} health={null} />);
    expect(screen.getByText(/no providers reported/i)).toBeInTheDocument();
  });
});
