// GATE F1-OPENING — an opening balance the engine never served is ABSENT.
//
// THE DEFECT THIS GATE EXISTS FOR. `buildFromCanonicalBs` used to read
//
//     opening: row.opening ?? row.amount
//
// with the comment "a null opening mirrors closing (Δ 0) so both columns
// stay symmetric". On the real carniprod envelope all 44 rows serve
// `opening: null`, so the entire comparative column was the closing
// column repainted: every opening figure equal to its closing figure, 47
// of them wearing a provenance card naming sheet Balanta, account 211,
// method deterministic, pack ro_omfp1802_v2 — for a balance that is in
// none of them — under a column header claiming a comparative date, with
// Δ 0 beside it. The previous wave's `isAbsentFigure` guard could not
// refuse any of it, because by the time the value reached the guard it
// was a finite number.
//
// TC-1 — the fixture is REAL ENGINE OUTPUT, `corpus/saga_10_col_carniprod/
// expected/served_envelope.json`, not a hand-written double. The subject
// floors below are read back OUT of it, so if the corpus ever starts
// serving openings this gate says so instead of silently passing.
//
// TC-7 — the component under test is the real `BSStatementView` through
// the real provider stack. A builder-only assertion would not have caught
// the renderer's own `(closing ?? 0) - (opening ?? 0)`, which turns an
// absent opening into a Δ equal to the whole closing balance.
//
// TC-9 — every law here is paired with its opposite on the CLOSING
// column, which the same envelope does serve. A clean result is therefore
// distinguishable from an empty render: if the statement failed to mount,
// the closing assertions fail too.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { renderWithProviders } from "@/test/renderWithProviders";
import { BSStatementView } from "@/components/cfo/BSStatementView";
import { buildBSStatement } from "@/lib/buildBsStatement";
import type { CanonicalBs } from "@/lib/financialReport";

const repoRoot = resolve(__dirname, "../../../..");
const envelope = JSON.parse(
  readFileSync(
    resolve(repoRoot, "corpus/saga_10_col_carniprod/expected/served_envelope.json"),
    "utf-8",
  ),
) as CanonicalBs;

/** The gap glyph `formatAmountFrom` paints for an absent figure. */
const GAP = "—";
/** The header the call site hands the builder — the string the column
 *  must NOT show once the comparative turns out to be absent. */
const COMPARATIVE_LABEL = "01.01.2025";

beforeEach(() => {
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  // PRO, so ITEM rows render. Simple collapses them behind "Show all
  // lines" and this gate would then be about six subtotals.
  localStorage.setItem("cfo-view-mode-v1", "pro");
});

function mount() {
  return renderWithProviders(
    <BSStatementView
      statement={buildBSStatement({
        lineItems: [],
        entity: "Carniprod",
        asOf: "31.12.2025",
        comparativeDate: COMPARATIVE_LABEL,
        currency: "RON",
        canonicalBs: envelope,
      })}
    />,
  );
}

/** Every amount-bearing row on screen, as [openingCell, closingCell]. The
 *  BS grid is label · opening · closing · Δ, and both `BsAmountCell` and
 *  `BsLearnableCell` emit exactly one `.bs-amount` node per column. */
function rows(): { el: HTMLElement; opening: HTMLElement; closing: HTMLElement; delta: HTMLElement | null }[] {
  const out: { el: HTMLElement; opening: HTMLElement; closing: HTMLElement; delta: HTMLElement | null }[] = [];
  const all = document.querySelectorAll<HTMLElement>(
    ".bs-statement .bs-row, .bs-statement .bs-total-row",
  );
  for (const el of Array.from(all)) {
    const amounts = Array.from(el.querySelectorAll<HTMLElement>(":scope > .bs-amount"));
    if (amounts.length !== 2) continue;
    out.push({
      el,
      opening: amounts[0],
      closing: amounts[1],
      delta: el.querySelector<HTMLElement>(":scope > .bs-delta"),
    });
  }
  return out;
}

const text = (el: HTMLElement) => (el.textContent ?? "").trim();
const wearsCard = (el: HTMLElement) =>
  el.getAttribute("data-provenance") === "true" ||
  el.querySelector('[data-provenance="true"]') !== null;

// ── TC-3: is there a subject at all? ───────────────────────────────────

describe("the fixture is the right subject", () => {
  it("serves an opening on NO row, and a closing on every row", () => {
    const withOpening = envelope.rows.filter(
      (r) => typeof r.opening === "number" && Number.isFinite(r.opening),
    );
    const withAmount = envelope.rows.filter((r) => typeof r.amount === "number");
    expect(
      envelope.rows.length,
      "the corpus envelope has no rows, so every law below is vacuous (TC-3)",
    ).toBeGreaterThan(20);
    expect(
      withOpening.length,
      "this envelope now serves opening balances, so it is no longer the " +
        "fixture this gate is about — point the gate at one that does not, " +
        "or the absence laws below prove nothing.",
    ).toBe(0);
    expect(withAmount.length).toBe(envelope.rows.length);
  });

  it("carries no opening subtotal and no opening total either", () => {
    for (const s of envelope.sections) {
      expect(Object.keys(s)).not.toContain("subtotal_opening");
    }
    expect(Object.keys(envelope.totals)).not.toContain("assets_opening");
  });
});

// ── the laws ───────────────────────────────────────────────────────────

describe("F1 — an absent opening stays absent", () => {
  it("NO row paints an opening figure", () => {
    mount();
    const r = rows();
    expect(
      r.length,
      "no amount rows rendered — the statement did not mount, so the " +
        "absence assertions below would pass on an empty screen (TC-9)",
    ).toBeGreaterThan(20);

    const painted = r.filter((x) => text(x.opening) !== GAP);
    expect(
      painted.length,
      `${painted.length} of ${r.length} rows paint an opening figure the ` +
        "engine never served. First few: " +
        painted.slice(0, 4).map((x) => `"${text(x.el).slice(0, 60)}"`).join(" · "),
    ).toBe(0);
  });

  it("NO opening cell wears a provenance card", () => {
    mount();
    const r = rows();
    expect(r.length).toBeGreaterThan(20);
    const carded = r.filter((x) => wearsCard(x.opening));
    expect(
      carded.length,
      `${carded.length} opening cell(s) offer a provenance card — a receipt ` +
        "naming a sheet, an account and a mapping pack for a figure that is " +
        "in none of them. This is the worst outcome in this codebase.",
    ).toBe(0);
  });

  it("NO opening figure equals its closing figure, because there is none", () => {
    mount();
    const r = rows();
    const mirrored = r.filter(
      (x) => text(x.opening) !== GAP && text(x.opening) === text(x.closing),
    );
    expect(
      mirrored.length,
      `${mirrored.length} row(s) show an opening balance identical to the ` +
        "closing balance — the mirroring convention, back.",
    ).toBe(0);
  });

  it("the Δ column is ABSENT, not 0 and not the closing balance", () => {
    mount();
    const r = rows().filter((x) => x.delta !== null);
    expect(r.length).toBeGreaterThan(20);
    const claimed = r.filter((x) => text(x.delta!) !== GAP);
    expect(
      claimed.length,
      `${claimed.length} Δ cell(s) state a change over a period that was ` +
        "never measured. Samples: " +
        claimed.slice(0, 4).map((x) => `"${text(x.delta!)}"`).join(" · "),
    ).toBe(0);
  });

  it("the column header does not claim a comparative date", () => {
    mount();
    const header = screen.getByTestId("bs-comparative-header");
    expect(text(header)).not.toBe(COMPARATIVE_LABEL);
    // …and it says what is missing, in the product's own voice, rather
    // than leaving a blank a reader could take for a formatting slip.
    expect(text(header).length).toBeGreaterThan(0);
    expect(text(header)).toMatch(/not filed/i);
  });
});

// ── TC-9: the same probes on the column that IS served ─────────────────

describe("the closing column is untouched — a clean result is not an empty one", () => {
  it("every row paints a closing figure", () => {
    mount();
    const r = rows();
    const blank = r.filter((x) => text(x.closing) === GAP);
    // The envelope has genuinely-zero sections (provisions,
    // non_current_liabilities), whose subtotal formats as the gap glyph
    // below 0.005 — so this is a floor on real figures, not an equality.
    expect(r.length - blank.length).toBeGreaterThan(20);
  });

  it("closing cells still carry their provenance cards", () => {
    mount();
    const carded = rows().filter((x) => wearsCard(x.closing));
    expect(
      carded.length,
      "no closing cell carries a card either, so the opening-column laws " +
        "above are passing because NOTHING renders a card (TC-9)",
    ).toBeGreaterThan(10);
  });
});
