// PM-UI honest states — the copy contract for a market surface.
//
// These assertions are the reason the surface exists. A market with no
// feed must SAY it has no feed and name the switch that turns it on; a
// count we could not ask for must never render as zero; a server refusal
// must reach the screen with its own sentence rather than a generic
// "not found". Each of those is a one-word edit away from becoming a
// lie, so each gets a test.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MarketDataStatusLine } from "../MarketDataStatusLine";
import { MarketAwaitingPanel } from "../MarketAwaitingPanel";
import { MarketNotAddressablePanel, MarketRefusalNote } from "../MarketSurface";
import { BUNDLED_MARKETS, PROVIDER_ENV_VAR, type MarketEntry } from "@/lib/marketApi";

const byId = (id: string): MarketEntry =>
  BUNDLED_MARKETS.find((m) => m.market_id === id)!;

const HOME = byId("ro");
const LIVE = byId("us");
const NO_FEED = byId("cn");
const FILINGS_ONLY = byId("fr");

describe("holdings — an absent count is not a zero", () => {
  it("says holdings are unknown when the registry endpoint did not answer", () => {
    render(<MarketDataStatusLine market={LIVE} holdingsKnown={false} bundled />);
    const line = screen.getByTestId(`market-holdings-${LIVE.market_id}`);
    expect(line.textContent ?? "").toMatch(/unknown/i);
    expect(line.textContent ?? "").not.toMatch(/\b0\b/);
  });

  it("says zero ONLY when a real zero came back", () => {
    render(
      <MarketDataStatusLine
        market={{ ...LIVE, entities_held: 0 }}
        holdingsKnown
      />,
    );
    expect(
      screen.getByTestId(`market-holdings-${LIVE.market_id}`).textContent ?? "",
    ).toMatch(/no companies cached/i);
  });

  it("renders a real count when one arrived", () => {
    render(
      <MarketDataStatusLine market={{ ...LIVE, entities_held: 7 }} holdingsKnown />,
    );
    expect(
      screen.getByTestId(`market-holdings-${LIVE.market_id}`).textContent ?? "",
    ).toContain("7");
  });
});

describe("holdings — the home market never reports a spine-store count", () => {
  it("says what serves Romania instead of 'no companies cached'", () => {
    // PM7: this package never caches a Romanian entity, so `ro`'s count
    // is structurally 0. Printing "no companies cached yet" beside the
    // 88 Romanian companies the same page renders is true about the
    // store and false to the reader.
    render(
      <MarketDataStatusLine market={{ ...HOME, entities_held: 0 }} holdingsKnown />,
    );
    const line = screen.getByTestId(`market-holdings-${HOME.market_id}`);
    expect(line.textContent ?? "").toMatch(/Romanian storefront/i);
    expect(line.textContent ?? "").not.toMatch(/no companies cached/i);
  });
});

describe("holdings — a feedless market prints no count at all", () => {
  it("omits the line rather than reporting a zero that reads as a shortfall", () => {
    render(
      <MarketDataStatusLine market={{ ...NO_FEED, entities_held: 0 }} holdingsKnown />,
    );
    expect(screen.queryByTestId(`market-holdings-${NO_FEED.market_id}`)).toBeNull();
  });

  it("but DOES print a non-zero count, which would be a real anomaly", () => {
    render(
      <MarketDataStatusLine market={{ ...NO_FEED, entities_held: 3 }} holdingsKnown />,
    );
    expect(
      screen.getByTestId(`market-holdings-${NO_FEED.market_id}`).textContent ?? "",
    ).toContain("3");
  });
});

describe("data-status line", () => {
  it("shows the registry's verbatim licence line, not a paraphrase", () => {
    render(<MarketDataStatusLine market={LIVE} holdingsKnown={false} />);
    expect(screen.getByTitle(LIVE.license_notes)).toBeInTheDocument();
  });

  it("does not tell the home market it has no prices", () => {
    // Romania's price_source is `none` because BVB quotes are not
    // licensed in THIS registry — the page still shows quotes, served by
    // the pipeline that already serves Romania. "No price feed" here
    // would contradict the prices on screen.
    render(<MarketDataStatusLine market={HOME} holdingsKnown={false} />);
    const el = screen.getByTestId(`market-data-status-${HOME.market_id}`);
    expect(el.textContent ?? "").toMatch(/Bucharest Stock Exchange feed/i);
    expect(el.textContent ?? "").not.toMatch(/No price feed in this registry/i);
  });

  it("says 'no price feed' for a market that genuinely has none configured", () => {
    render(<MarketDataStatusLine market={LIVE} holdingsKnown={false} />);
    expect(
      screen.getByTestId(`market-data-status-${LIVE.market_id}`).textContent ?? "",
    ).toMatch(/no key configured/i);
  });
});

describe("awaiting_provider — the calm state", () => {
  it("names the environment variable that activates the market", () => {
    render(
      <MarketAwaitingPanel market={NO_FEED} holdingsKnown={false} />,
    );
    expect(
      screen.getByTestId(`market-activate-env-${NO_FEED.market_id}`).textContent,
    ).toBe(PROVIDER_ENV_VAR);
  });

  it("states what is missing and never says 'no results'", () => {
    render(<MarketAwaitingPanel market={NO_FEED} holdingsKnown={false} />);
    const el = screen.getByTestId(`market-awaiting-${NO_FEED.market_id}`);
    const text = el.textContent ?? "";
    expect(text).toMatch(/no fundamentals feed is connected/i);
    // "No results" would imply a search ran and came back empty.
    expect(text).not.toMatch(/no results/i);
  });

  it("renders no figure at all — a placeholder number is worse than a gap", () => {
    const { container } = render(
      <MarketAwaitingPanel market={NO_FEED} holdingsKnown={false} />,
    );
    // The only digits allowed on this panel come from the (absent)
    // holdings count and from copy; there is no <Amount> anywhere.
    expect(container.querySelectorAll("[data-provenance]").length).toBe(0);
  });
});

describe("fundamentals_only — figures exist, the lookup does not", () => {
  it("names the feed and the missing capability, distinctly", () => {
    render(
      <MarketNotAddressablePanel market={FILINGS_ONLY} holdingsKnown={false} />,
    );
    const text =
      screen.getByTestId(`market-not-addressable-${FILINGS_ONLY.market_id}`)
        .textContent ?? "";
    expect(text).toContain(FILINGS_ONLY.fundamentals_source);
    expect(text).toMatch(/ticker to legal-entity to filing resolution/i);
  });
});

describe("refusals reach the screen intact", () => {
  it("shows the server's own sentence and its machine code", () => {
    render(
      <MarketRefusalNote
        refusal={{
          status: "refused",
          code: "NOT_CACHED",
          detail:
            "AAPL is not in the public_market store for United States yet — this route reads the store",
          ticker: "AAPL",
        }}
      />,
    );
    const el = screen.getByTestId("market-refusal-NOT_CACHED");
    expect(el.textContent ?? "").toContain("reads the store");
    expect(el.textContent ?? "").toContain("AAPL");
  });

  it("distinguishes 'no feed' from 'not cached'", () => {
    const { unmount } = render(
      <MarketRefusalNote
        refusal={{ status: "refused", code: "NOT_CACHED", detail: "x" }}
      />,
    );
    const notCached = screen.getByTestId("market-refusal-NOT_CACHED").textContent;
    unmount();
    render(
      <MarketRefusalNote
        refusal={{ status: "refused", code: "MARKET_AWAITING_PROVIDER", detail: "y" }}
      />,
    );
    const awaiting = screen.getByTestId("market-refusal-MARKET_AWAITING_PROVIDER")
      .textContent;
    expect(notCached).not.toBe(awaiting);
  });
});
