// THE DIAL — gate M1 harness smoke test.
//
// Proves the shared renderBothModes machinery before any lane depends on
// it: the mode plumbing actually flips (via <Term>'s dual labels), the
// parity assertion catches a one-cent drift, and the story-dashboard
// coordination is reported honestly — if the story components haven't
// landed yet the deep test SKIPS WITH A WARNING instead of failing a
// lane that hasn't shipped.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { formatAmount, MAGNITUDE_UNIT } from "@/lib/amountFormat";
import { getViewMode } from "@/lib/viewMode";
import { Term } from "@/components/instrument/Term";

import {
  ensureTestLocalStorage,
  expectParityBySelector,
  forceViewMode,
  MODE_STORAGE_KEY,
  numericStrings,
  renderBothModes,
  textsBySelector,
} from "./modeParityHarness";

// ── the storage-key contract with lib/viewMode.ts ──────────────────────

describe("M1 harness — mode forcing", () => {
  it("MODE_STORAGE_KEY still steers getViewMode()", () => {
    forceViewMode("pro");
    expect(getViewMode()).toBe("pro");
    forceViewMode("simple");
    expect(getViewMode()).toBe("simple");
  });

  it("renderBothModes actually flips the mode between renders", () => {
    // <Term> is mode-aware by construction: Simple leads with the plain
    // name, Pro with the bare term. If both renders agreed, the harness
    // would be rendering one mode twice.
    const both = renderBothModes(<Term id="ebitda" />);
    expect(both.simple.text).toContain("Profit before financing");
    expect(both.simple.text).toContain("(EBITDA)");
    expect(both.pro.text.trim()).toBe("EBITDA");
  });
});

// ── the parity assertion itself ────────────────────────────────────────

function Figure({ value }: { value: number }) {
  return (
    <span data-testid="m1-figure">
      {formatAmount(value, { locale: "en-GB", magnitude: MAGNITUDE_UNIT, fractionDigits: 2 })}
    </span>
  );
}

describe("M1 harness — cent-identical figures across arrangements", () => {
  it("same value, different arrangement per mode → parity holds", () => {
    const both = renderBothModes((mode) =>
      mode === "simple" ? (
        <section>
          <p>The business holds</p>
          <Figure value={1_234_567.89} />
        </section>
      ) : (
        <div>
          <Figure value={1_234_567.89} />
        </div>
      ),
    );
    expectParityBySelector(both, '[data-testid="m1-figure"]');
  });

  it("a one-cent drift between modes FAILS the assertion", () => {
    const both = renderBothModes((mode) => (
      <Figure value={mode === "simple" ? 1_234_567.89 : 1_234_567.9} />
    ));
    expect(() => expectParityBySelector(both, '[data-testid="m1-figure"]')).toThrow();
  });

  it("helpers: textsBySelector and numericStrings read the clones", () => {
    const both = renderBothModes(<Figure value={42_000} />);
    expect(textsBySelector(both.pro.container, '[data-testid="m1-figure"]')).toHaveLength(1);
    expect(numericStrings(both.simple).length).toBeGreaterThan(0);
  });

  it("ensureTestLocalStorage round-trips", () => {
    const s = ensureTestLocalStorage();
    s.setItem(MODE_STORAGE_KEY, "simple");
    expect(s.getItem(MODE_STORAGE_KEY)).toBe("simple");
  });
});

// ── story-dashboard lane coordination ──────────────────────────────────
//
// The story lane owns the Simple dashboard (data-testid="story-overview")
// and its own parity test importing this harness. This block only
// REPORTS whether those components exist yet — it must not fail a lane
// that hasn't shipped, and it cannot dynamically import an alias path.

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPONENTS = join(HERE, "..", "..", "components");

function findStoryOverviewFiles(): string[] {
  const hits: string[] = [];
  if (!existsSync(COMPONENTS)) return hits;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (name !== "node_modules") walk(p);
      } else if (/\.tsx?$/.test(name)) {
        try {
          if (readFileSync(p, "utf8").includes("story-overview")) hits.push(p);
        } catch {
          /* unreadable file — skip */
        }
      }
    }
  };
  walk(COMPONENTS);
  return hits;
}

describe("M1 harness — story-dashboard coordination", () => {
  it("story components exist and should import this harness for their parity test", (ctx) => {
    const files = findStoryOverviewFiles();
    if (files.length === 0) {
      console.warn(
        "[M1 harness] no component under frontend/components carries " +
          'data-testid="story-overview" yet — the story-dashboard lane has not ' +
          "shipped. Skipping the coordination check; their parity test must " +
          "import renderBothModes/expectParityBySelector from modeParityHarness.",
      );
      ctx.skip();
      return;
    }
    // Shipped: record where, so the parity-test obligation is traceable.
    console.log(`[M1 harness] story-overview found in: ${files.join(", ")}`);
    expect(files.length).toBeGreaterThan(0);
  });
});
