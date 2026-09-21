// THE BALANCE SHEET'S PRIOR COLUMN FOOTS TO ITS PRIOR SUBTOTALS.
//
// Live on cfo-ai.io (dashboard Balance Sheet tab, Scandia Dec 2025 vs Dec
// 2024): the prior "Total current" printed 106,860,762.45 over listed rows
// summing to 101,885,227.96. The 4,975,534.49 gap was exactly two rows the
// prior period had and the current one does not — "Short-term investments"
// 4,974,100.00 and "Other receivables" 1,434.49 — which the engine's own
// variance bridge lists as no longer present. `buildFromCanonicalBs`
// iterated only the CURRENT rows, so a prior-only row was never rendered
// while the section's served prior subtotal counted it.
//
// The committed hermetic pair (agras Dec 2025 vs carniprod Dec 2024) has
// the same shape six times over: ar_doubtful_gross, ar_personnel,
// ppe_advances, legal_reserves, retained_earnings_prior_years and
// unclassified_credit exist only in the prior period.
//
// ── WHAT IT REDS ON, after the repair (TC-11) ─────────────────────────
//  · a section whose rendered prior rows do not sum to its served prior
//    subtotal (to the cent) on the pair;
//  · any change to the CURRENT column — every closing, in order, every
//    current subtotal and both grand totals must equal a build with no
//    prior at all (the current column cannot depend on the prior);
//  · a prior-only row carrying a closing, a Δ, an account code or a bucket
//    (a provenance card or a traceable target claiming the current period);
//  · a flipped result row (current_year_profit ↔ current_year_loss)
//    re-appearing as a prior-only line;
//  · a rendered prior-only row that does not read "no longer present", or
//    that prints a 0 closing or a ±100% change.

import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { renderWithProviders } from "@/test/renderWithProviders";
import { BSStatementView } from "@/components/cfo/BSStatementView";
import { ComparativeProvider } from "@/components/cfo/ComparativeCells";
import { buildBSStatement, type BSStatementWithCanonical } from "@/lib/buildBsStatement";
import type { BSSection } from "@/lib/bsStructure";
import type { ComparativesResponse } from "@/lib/comparatives";
import { canonicalBsSectionMeta, type CanonicalBs } from "@/lib/financialReport";
import i18n from "@/i18n";

import pairJson from "./fixtures/comparatives/pair_served.json";

interface Pair {
  current_body: { statements: { canonical_bs: CanonicalBs } };
  comparatives: ComparativesResponse;
}

const fresh = (): Pair => JSON.parse(JSON.stringify(pairJson)) as Pair;

function build(p: Pair, withPrior = true): BSStatementWithCanonical {
  return buildBSStatement({
    lineItems: [],
    entity: "agras",
    asOf: "Dec 2025",
    comparativeDate: "Dec 2024",
    currency: "RON",
    canonicalBs: p.current_body.statements.canonical_bs,
    priorCanonicalBs: withPrior ? p.comparatives.prior_canonical_bs : null,
  });
}

const sections = (st: BSStatementWithCanonical): BSSection[] => [
  ...st.assetSections,
  ...st.equityLiabSections,
];
const cents = (v: number) => Math.round(v * 100);

/** The prior ids the current period does not carry (flip-aware). */
function priorOnlyIds(p: Pair): string[] {
  const cur = new Set(p.current_body.statements.canonical_bs.rows.map((r) => r.id));
  return Object.entries(p.comparatives.prior_canonical_bs!.rows)
    .filter(([id, r]) => !cur.has(id) && typeof r.amount === "number" && r.amount !== 0)
    .map(([id]) => id);
}

/** The current column, serialised: every row's label + closing + Δ in
 *  order, every section's closing subtotal, both closing grand totals. */
function currentColumn(st: BSStatementWithCanonical): string {
  return JSON.stringify({
    sections: sections(st).map((s) => ({
      header: s.header,
      rows: s.lines
        .filter((l) => typeof l.closing === "number")
        .map((l) => [l.label, l.accountCode ?? null, l.closing]),
      subtotal: s.subtotalClosing,
    })),
    assets: st.totalAssets.closing,
    el: st.totalEquityLiab.closing,
    balance: st.balanceCheck,
  });
}

describe("the fixture is the subject", () => {
  it("the prior period carries rows the current one does not, in several sections", () => {
    const p = fresh();
    const ids = priorOnlyIds(p);
    expect(ids.length, "no prior-only rows: every law below is vacuous (TC-3)").toBeGreaterThanOrEqual(4);
    const secs = new Set(ids.map((id) => p.comparatives.prior_canonical_bs!.rows[id].section));
    expect(secs.size).toBeGreaterThanOrEqual(3);
  });
});

describe("the prior column foots", () => {
  it("every section's rendered prior rows sum to its served prior subtotal, to the cent", () => {
    const p = fresh();
    const st = build(p);
    let checked = 0;
    for (const s of sections(st)) {
      if (typeof s.subtotalOpening !== "number") continue;
      const sum = s.lines.reduce((a, l) => a + (typeof l.opening === "number" ? l.opening : 0), 0);
      expect(cents(sum), `${s.header}: prior rows sum vs prior subtotal`).toBe(cents(s.subtotalOpening));
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(6);
  });

  it("each prior-only row renders once, with its prior amount and label, and nothing claiming the current period", () => {
    const p = fresh();
    const st = build(p);
    const lines = sections(st).flatMap((s) => s.lines);
    for (const id of priorOnlyIds(p)) {
      const pr = p.comparatives.prior_canonical_bs!.rows[id];
      const hits = lines.filter((l) => l.label === pr.label && l.opening === pr.amount);
      expect(hits.length, `${id} rendered`).toBe(1);
      const l = hits[0];
      expect(l.closing, `${id} closing must be ABSENT, not 0`).toBeUndefined();
      expect(l.delta, `${id} Δ must be unmeasured`).toBeUndefined();
      expect(l.accountCode).toBeUndefined();
      expect(l.bucket).toBeUndefined();
      // and in the section the prior period filed it under
      const home = sections(st).find((s) => s.lines.includes(l))!;
      expect(home.header).toBe(canonicalBsSectionMeta(pr.section!).header);
    }
  });
});

describe("the current column is untouched", () => {
  it("byte-identical to a build with no prior period at all", () => {
    const p = fresh();
    expect(currentColumn(build(p, true))).toBe(currentColumn(build(p, false)));
  });

  it("every served current row and subtotal, in the object's order", () => {
    const p = fresh();
    const cbs = p.current_body.statements.canonical_bs;
    const st = build(p);
    for (const s of sections(st)) {
      const secId = cbs.sections.find((x) => canonicalBsSectionMeta(x.id).header === s.header)!.id;
      const served = cbs.rows.filter((r) => r.section === secId).map((r) => r.amount);
      const shown = s.lines.filter((l) => typeof l.closing === "number").map((l) => l.closing);
      expect(shown, s.header).toEqual(served);
      // prior-only rows follow the current rows; they never interleave
      const firstGone = s.lines.findIndex((l) => typeof l.closing !== "number");
      if (firstGone >= 0) expect(s.lines.slice(firstGone).every((l) => typeof l.closing !== "number")).toBe(true);
    }
  });
});

describe("the result row's flip is not a line that went away", () => {
  it("a prior current_year_profit beside a current current_year_loss is left absent", () => {
    const p = fresh();
    const cbs = p.current_body.statements.canonical_bs;
    const row = cbs.rows.find((r) => r.id === "current_year_profit")!;
    expect(row, "fixture carries the result row").toBeDefined();
    row.id = "current_year_loss";
    row.label = "Current year loss";
    const priorProfit = p.comparatives.prior_canonical_bs!.rows.current_year_profit;
    expect(priorProfit?.amount).toBeTypeOf("number");
    const lines = sections(build(p)).flatMap((s) => s.lines);
    expect(lines.filter((l) => l.label === priorProfit.label && typeof l.closing !== "number")).toEqual([]);
    const loss = lines.find((l) => l.label === "Current year loss")!;
    expect(loss.opening).toBeUndefined();
  });
});

describe("the view words it", () => {
  beforeEach(() => {
    if (!("ResizeObserver" in globalThis)) {
      (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }
    localStorage.setItem("cfo-view-mode-v1", "pro");
  });

  it("a prior-only row reads 'no longer present' — never a 0 closing, never ±100%", async () => {
    await i18n.changeLanguage("en");
    const p = fresh();
    renderWithProviders(
      <ComparativeProvider
        doc={p.comparatives}
        columns={{ prior: true, delta: true, deltaPct: true, share: true }}
        statement="BS"
        currency="RON"
      >
        <BSStatementView statement={build(p)} hideGuide />
      </ComparativeProvider>,
    );
    expect(screen.getByTestId("bs-statement")).toBeTruthy();
    const gone = i18n.t("statements.cmp.gone");
    expect(gone).toBe("no longer present");
    const rows = Array.from(document.querySelectorAll<HTMLElement>(".bs-statement .bs-row.bs-row-item"));
    for (const id of priorOnlyIds(p)) {
      const label = p.comparatives.prior_canonical_bs!.rows[id].label!;
      const row = rows.find((r) => (r.querySelector(".bs-label")?.textContent ?? "").trim() === label);
      expect(row, `${label} is on screen`).toBeDefined();
      const text = (row!.textContent ?? "").replace(/\s+/g, " ");
      expect(text, label).toContain(gone);
      expect(text, label).not.toMatch(/[+−-]\s?100(\.0)?%/);
      const amounts = Array.from(row!.querySelectorAll<HTMLElement>(":scope > .bs-amount"));
      expect(amounts.length).toBe(2);
      expect((amounts[1].textContent ?? "").trim(), `${label} closing`).toBe("—");
      expect((amounts[1].textContent ?? "").trim()).not.toBe("0");
      expect((row!.querySelector(":scope > .bs-delta")?.textContent ?? "").trim(), `${label} Δ`).toBe("—");
    }
    // The mirror word still belongs to the current-only rows.
    const cur = new Set(Object.keys(p.comparatives.prior_canonical_bs!.rows));
    const newRow = p.current_body.statements.canonical_bs.rows.find((r) => !cur.has(r.id))!;
    // (a current row's label cell also carries its account-code chip)
    const nr = rows.find((r) => (r.querySelector(".bs-label")?.textContent ?? "").trim().startsWith(newRow.label))!;
    expect(nr, `${newRow.label} is on screen`).toBeDefined();
    expect((nr.textContent ?? "")).toContain(i18n.t("statements.cmp.new"));
    expect((nr.textContent ?? "")).not.toContain(gone);
  });
});
