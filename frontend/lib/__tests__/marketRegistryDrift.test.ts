// PM-DRIFT — the bundled market registry must not separate from the
// engine's markets.yaml.
//
// lib/marketApi.ts ships a copy of the registry so the market tabs
// render when the engine is unreachable (DOD3: never a blank tab). A
// second copy of a fact is a second place for it to be wrong, so this
// test re-derives every field from
// `src/engine/public_market/markets.yaml` and fails the build the
// moment the two disagree.
//
// Deliberately dependency-free: no YAML parser is a direct dependency of
// this repo, and adding one to satisfy a gate would make the gate the
// reason a package exists. The file is read as text and compared on
// whitespace-normalized content — which is exactly the right comparison
// for the folded scalars (`license_notes`, `coverage_note`), whose YAML
// line breaks are not part of their value.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { BUNDLED_MARKETS, BUNDLED_REGISTRY, orderMarkets } from "../marketApi";

const YAML_PATH = join(
  __dirname,
  "..", "..", "..",
  "src", "engine", "public_market", "markets.yaml",
);

const raw = readFileSync(YAML_PATH, "utf-8");
/** Whitespace-collapsed file text — folded scalars rejoin into one line. */
const flat = raw.replace(/\s+/g, " ");

function marketIdsInFileOrder(): string[] {
  return [...raw.matchAll(/^\s*-\s*market_id:\s*(\S+)\s*$/gm)].map((m) => m[1]);
}

describe("PM-DRIFT — bundled registry mirrors markets.yaml", () => {
  it("carries exactly the same markets, in the same file order", () => {
    expect(BUNDLED_MARKETS.map((m) => m.market_id)).toEqual(marketIdsInFileOrder());
  });

  it("is not empty (a vacuous mirror would pass every other check)", () => {
    expect(BUNDLED_MARKETS.length).toBeGreaterThanOrEqual(5);
  });

  it.each([...BUNDLED_MARKETS])("$market_id — scalars match the file", (m) => {
    // Simple scalars are written `key: value` in the YAML.
    for (const [key, value] of [
      ["display_name", m.display_name],
      ["currency", m.currency],
      ["accounting_standard", m.accounting_standard],
      ["price_source", m.price_source],
      ["fundamentals_source", m.fundamentals_source],
      ["refresh_cadence", m.refresh_cadence],
      ["status", m.status],
      ["marquee_rank", String(m.marquee_rank)],
    ] as const) {
      expect(flat, `${m.market_id}.${key}`).toContain(`${key}: ${value}`);
    }
    expect(flat, `${m.market_id}.exchanges`).toContain(
      `exchanges: [${m.exchanges.join(", ")}]`,
    );
  });

  it.each([...BUNDLED_MARKETS])(
    "$market_id — licence + coverage notes are verbatim",
    (m) => {
      // These two are the ones that MUST be word-for-word: the licence
      // line is a legal statement recorded from the source, and the
      // coverage note is the engine authors' own sentence about what a
      // market can and cannot deliver. Paraphrasing either in the UI
      // copy would be the drift this whole file exists to prevent.
      expect(flat, `${m.market_id}.license_notes`).toContain(
        m.license_notes.replace(/\s+/g, " ").trim(),
      );
      expect(flat, `${m.market_id}.coverage_note`).toContain(
        m.coverage_note.replace(/\s+/g, " ").trim(),
      );
    },
  );

  it("never bundles a holdings count", () => {
    // `entities_held` is a claim about what this deployment actually
    // cached. It cannot be known offline, so it must never ship in the
    // mirror — and the bundled registry must say holdings are unknown.
    for (const m of BUNDLED_MARKETS) {
      expect(m).not.toHaveProperty("entities_held");
    }
    expect(BUNDLED_REGISTRY.holdingsKnown).toBe(false);
    expect(BUNDLED_REGISTRY.origin).toBe("bundled");
  });

  it("orders Romania first and in its own group", () => {
    const ordered = orderMarkets(BUNDLED_MARKETS);
    expect(ordered[0].marquee_rank).toBe(0);
    expect(ordered[0].market_id).toBe(marketIdsInFileOrder()[0]);
  });

  it("declares no status the engine does not know", () => {
    for (const m of BUNDLED_MARKETS) {
      expect(BUNDLED_REGISTRY.statuses).toContain(m.status);
    }
  });
});
