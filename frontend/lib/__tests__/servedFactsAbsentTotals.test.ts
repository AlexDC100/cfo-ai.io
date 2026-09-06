// GATE F4-ABSENT-TOTALS — an incomplete pair makes EVERY value derived
// from it absent, not just the one the previous gate looked at.
//
// ── THE DEFECT ────────────────────────────────────────────────────────
//
// The F3 fix made `difference()` null when a term of the subtraction was
// missing, and deliberately kept the two TOTALS on `?? 0`:
//
//     totalAssetsCents: assets ?? 0,
//     equityPlusLiabilitiesCents: el ?? 0,
//
// and then, in `centsFromCanonical`:
//
//     const equity = centsOrNull(cbs.totals.equity) ?? 0;
//     const liabilities =
//       centsOrNull(cbs.totals.liabilities) ?? core.equityPlusLiabilitiesCents - equity;
//
// so on the envelope shape F3's OWN gate builds — the real carniprod
// object with `difference`, `totals.liabilities` and
// `totals.equity_plus_liabilities` deleted — the fallback computed
// `0 − equity`:
//
//     OLD  totalLiabilities()      =              0
//     NEW  totalLiabilities()      =  −106,895,967.91
//     NEW  nonCurrentLiabilities() =  −123,975,776.45
//     Altman X4 = equity / liabilities = −1
//
// F3's gate stayed GREEN through all of that, because it asserted
// `differenceTerms()`, `differenceOrigin()` and the affordance sentence —
// and never once called a totals accessor. The strip honestly said no
// drift could be stated while the same object handed −106.9 M to the
// balance-sheet tab, to `money(ctx, "total_liabilities")` in
// `capsuleFactIndex` (where it is FINITE, so it passed the F1 guard AND
// earned a provenance card), to both exports, and to the distress score.
//
// A wrong zero became a wrong nine-figure negative — produced by the fix
// for the wrong zero.
//
// ── WHAT THIS GATE ASSERTS ────────────────────────────────────────────
//
// THE VALUE A CONSUMER RECEIVES, at every accessor and at four downstream
// surfaces. Not the sentence beside it. §A walks every accessor on the
// gateway; §B walks the consumers; §C is the control (TC-9) proving the
// unmutated fixture still produces identical, complete figures — so a
// clean result is distinguishable from no subject.
//
// TC-1 — the fixture is the real carniprod served envelope from
// corpus/. The removal of named keys is the ONLY mutation.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { factsFrom, rawFactsForAuditOnly } from "@/lib/servedFacts";
import { buildBSStatement } from "@/lib/buildBsStatement";
import { buildPeriodFacts } from "@/lib/periodFacts";
import { buildFactIndex } from "@/lib/capsuleFactIndex";
import type { CanonicalBs, Statements } from "@/lib/financialReport";

const repoRoot = resolve(__dirname, "../../..");
const envelope = JSON.parse(
  readFileSync(
    resolve(repoRoot, "corpus/saga_10_col_carniprod/expected/served_envelope.json"),
    "utf-8",
  ),
) as CanonicalBs;

const TOTALS = envelope.totals as unknown as Record<string, number>;

/** A zero-filled line-item shell, so the ONLY variable in this suite is
 *  what the served envelope carries. Every figure below is a real,
 *  reported 0 — never an absence — which is exactly what makes the
 *  gateway's own absences the only thing under test. */
const ZERO_BS: Statements["balanceSheet"] = {
  cash: 0, accountsReceivable: 0, inventory: 0, otherCurrentAssets: 0,
  propertyPlantEquipment: 0, intangibles: 0, otherNonCurrentAssets: 0,
  accountsPayable: 0, shortTermDebt: 0, otherCurrentLiabilities: 0,
  longTermDebt: 0, otherNonCurrentLiabilities: 0,
  shareCapital: 0, retainedEarnings: 0, otherEquity: 0,
} as Statements["balanceSheet"];
const ZERO_PL: Statements["incomeStatement"] = {
  revenue: 0, costOfGoodsSold: 0, operatingExpenses: 0,
  depreciationAmortization: 0, interestExpense: 0, otherIncome: 0,
  taxExpense: 0,
} as Statements["incomeStatement"];

function statementsWith(cbs: CanonicalBs): Statements {
  return {
    companyName: "Carniprod",
    currency: "RON",
    periodLabel: "FY 2025",
    balanceSheet: ZERO_BS,
    incomeStatement: ZERO_PL,
    supplementary: {} as Statements["supplementary"],
    canonical_bs: cbs,
  };
}

/** The exact shape F3's own gate builds: no served difference, and the
 *  whole equity-and-liabilities side of the subtraction missing. */
function withoutLiabilities(): CanonicalBs {
  const { difference: _d, ...rest } = envelope as CanonicalBs & { difference?: number };
  void _d;
  const totals = { ...(rest.totals as unknown as Record<string, number>) };
  delete totals.liabilities;
  delete totals.equity_plus_liabilities;
  return { ...rest, totals } as unknown as CanonicalBs;
}

/** An envelope with no totals at all. */
function withEmptyTotals(): CanonicalBs {
  const { difference: _d, ...rest } = envelope as CanonicalBs & { difference?: number };
  void _d;
  return { ...rest, totals: {} } as unknown as CanonicalBs;
}

/** Every served total in the fixture, big enough to be recognised if one
 *  of them leaked out of a subtraction wearing another name. */
const RECOGNISABLE: [string, number][] = Object.entries(TOTALS).filter(
  ([, v]) => typeof v === "number" && Math.abs(v) > 1_000,
);

/** Assert `v` is not any served total, nor the negation of one. The tell
 *  of a `?? 0` completion is precisely that: what comes back is the OTHER
 *  term, or minus it. */
const OWN_TOTAL: Record<string, string> = {
  totalAssets: "assets",
  totalEquity: "equity",
  totalLiabilities: "liabilities",
  equityPlusLiabilities: "equity_plus_liabilities",
  currentAssets: "current_assets",
  currentLiabilities: "current_liabilities",
  "rawFactsForAuditOnly.totalLiabilities": "liabilities",
  "periodFacts.bs.total_liabilities": "liabilities",
};

function isNotALeakedTotal(v: number | null, accessor: string): void {
  if (v === null) return;
  const own = OWN_TOTAL[accessor];
  const ownValue = own === undefined ? undefined : TOTALS[own];
  for (const [name, total] of RECOGNISABLE) {
    // An accessor IS allowed to return its own served total — that is the
    // whole point of the gateway. It is also indistinguishable from any
    // total that HAPPENS to carry the same value in this fixture: the
    // envelope balances, so `assets === equity_plus_liabilities`, and an
    // equality that cannot discriminate is not evidence of a leak.
    if (name === own) continue;
    if (ownValue !== undefined && Math.abs(total - ownValue) < 0.01) continue;
    expect(
      Math.min(Math.abs(v - total), Math.abs(v + total)),
      `${accessor}() returned ${v}, which is ±the served total \`${name}\` ` +
        `(${total}) — an absent term leaking out of a subtraction.`,
    ).not.toBeLessThan(0.01);
  }
}

// ── §A THE ACCESSORS ───────────────────────────────────────────────────

describe("§A — every gateway accessor refuses when its terms are absent", () => {
  const SHAPES = [
    ["liabilities + equity_plus_liabilities removed", withoutLiabilities()],
    ["totals: {} (nothing served at all)", withEmptyTotals()],
  ] as const;

  describe.each(SHAPES)("%s", (_label, cbs) => {
    const f = factsFrom(cbs as CanonicalBs ? statementsWith(cbs as CanonicalBs) : statementsWith(envelope));

    it("totalLiabilities() is ABSENT, not 0 − equity", () => {
      const v = f.totalLiabilities();
      expect(
        v,
        "the liabilities total was completed from a side total the envelope " +
          "never served; this is the −106,895,967.91 the critic measured.",
      ).toBeNull();
      isNotALeakedTotal(v, "totalLiabilities");
    });

    it("nonCurrentLiabilities() is ABSENT — a split of an absent total", () => {
      expect(f.nonCurrentLiabilities()).toBeNull();
    });

    it("no accessor returns a leaked served total", () => {
      const probes: [string, number | null][] = [
        ["totalAssets", f.totalAssets()],
        ["totalEquity", f.totalEquity()],
        ["totalLiabilities", f.totalLiabilities()],
        ["equityPlusLiabilities", f.equityPlusLiabilities()],
        ["currentAssets", f.currentAssets()],
        ["currentLiabilities", f.currentLiabilities()],
        ["nonCurrentAssets", f.nonCurrentAssets()],
        ["nonCurrentLiabilities", f.nonCurrentLiabilities()],
        ["workingCapital", f.workingCapital()],
        ["difference", f.difference()],
      ];
      for (const [name, v] of probes) {
        // Nothing may be an Infinity or a NaN either — those are the two
        // other spellings of "the arithmetic ran on something absent".
        if (v !== null) {
          expect(Number.isFinite(v), `${name}() returned ${v}`).toBe(true);
        }
        isNotALeakedTotal(v, name);
      }
    });

    it("the audit receipt reads absent too, rather than a reconstructed 0", () => {
      const raw = rawFactsForAuditOnly(statementsWith(cbs as CanonicalBs));
      expect(raw.totalLiabilities).toBeNull();
      isNotALeakedTotal(raw.totalLiabilities, "rawFactsForAuditOnly.totalLiabilities");
      isNotALeakedTotal(raw.originalDifference, "rawFactsForAuditOnly.originalDifference");
    });
  });

  it("EMPTY TOTALS: every total is absent — not a zero balance sheet", () => {
    const f = factsFrom(statementsWith(withEmptyTotals()));
    expect(f.totalAssets()).toBeNull();
    expect(f.totalEquity()).toBeNull();
    expect(f.totalLiabilities()).toBeNull();
    expect(f.equityPlusLiabilities()).toBeNull();
    expect(f.currentAssets()).toBeNull();
    expect(f.currentLiabilities()).toBeNull();
    expect(f.nonCurrentAssets()).toBeNull();
    expect(f.nonCurrentLiabilities()).toBeNull();
    expect(f.workingCapital()).toBeNull();
  });

  it("ONE HALF SERVED: equity alone does not manufacture liabilities", () => {
    // Only `equity` survives. There is no side total to subtract from, so
    // completing `liabilities` is impossible — and completing it from a
    // side total that was itself derived FROM equity+liabilities would be
    // circular (it hands back the term it was built from).
    const { difference: _d, ...rest } = envelope as CanonicalBs & { difference?: number };
    void _d;
    const totals = { ...(rest.totals as unknown as Record<string, number>) };
    delete totals.liabilities;
    delete totals.equity_plus_liabilities;
    const f = factsFrom(statementsWith({ ...rest, totals } as unknown as CanonicalBs));
    expect(f.totalEquity()).toBe(TOTALS.equity);
    expect(f.totalLiabilities()).toBeNull();
    expect(f.equityPlusLiabilities()).toBeNull();
  });

  it("THE PAIR COMPLETES ONLY FROM SERVED TERMS: e+l minus a served half", () => {
    // Legitimate completion: the envelope serves `equity_plus_liabilities`
    // and `equity`, so `liabilities` is recoverable exactly. This is the
    // control that proves §A is a refusal, not a blanket "return null".
    const { difference: _d, ...rest } = envelope as CanonicalBs & { difference?: number };
    void _d;
    const totals = { ...(rest.totals as unknown as Record<string, number>) };
    delete totals.liabilities;
    const f = factsFrom(statementsWith({ ...rest, totals } as unknown as CanonicalBs));
    expect(f.totalLiabilities()).toBeCloseTo(
      TOTALS.equity_plus_liabilities - TOTALS.equity,
      2,
    );
    expect(f.totalLiabilities()).toBeCloseTo(TOTALS.liabilities, 2);
  });
});

// ── §B THE CONSUMERS ───────────────────────────────────────────────────

describe("§B — the surfaces that received the −106.9 M", () => {
  const s = statementsWith(withoutLiabilities());

  it("the capsule fact index offers NO total_liabilities fact, and no card for one", () => {
    const index = buildFactIndex({
      periods: [
        { periodId: "p1", periodLabel: "FY 2025", statements: s, docId: "doc-1" },
      ],
    } as unknown as Parameters<typeof buildFactIndex>[0]);
    const facts = index.facts ?? [];
    const leaked = facts.filter(
      (f) =>
        f.factKey === "total_liabilities" ||
        f.factKey === "non_current_liabilities" ||
        f.factKey === "equity_plus_liabilities",
    );
    expect(
      leaked.map((f) => `${f.factKey}=${f.value}`),
      "a fact index entry for a total the envelope never served — it is " +
        "FINITE, so `money()`'s F1 guard passes it and it earns a " +
        "provenance card for a figure nothing measured.",
    ).toEqual([]);
  });

  it("the BS tab's grand totals and balance check are absent, not zero", () => {
    const st = buildBSStatement({
      lineItems: [],
      canonicalBs: s.canonical_bs as CanonicalBs,
      entity: "Carniprod",
      asOf: "31.12.2025",
      comparativeDate: "01.01.2025",
      currency: "RON",
    });
    // `balanceCheck` was `toDisplay(core.differenceCents)` — and
    // `null / 100` is 0 in JavaScript, so an unstateable drift arrived at
    // the statement as a PERFECT BALANCE.
    expect(st.balanceCheck).toBeNull();
    expect(st.totalEquityLiab.closing).toBeNull();
  });

  it("periodFacts carries the absence through to the rule engine", () => {
    const facts = buildPeriodFacts({
      periodId: "p1",
      statements: s,
      lineItems: [],
      valuation: null,
      industry: null,
    });
    expect(facts.bs.total_liabilities).toBeNull();
    expect(facts.bs.bs_balance_check).toBeNull();
    isNotALeakedTotal(facts.bs.total_liabilities, "periodFacts.bs.total_liabilities");
    // …and no ratio built on it is Infinity or NaN — `n / null` is
    // Infinity in JavaScript, which a `>= threshold` rule reads as
    // perfect health.
    //
    // ⚠ THIS ASSERTION USED TO READ `.toBe(true)` — i.e. "every ratio is
    // FINITE". It passed on every substituted 0, which is why a lane
    // could close with equity_ratio reading 0.0% under a CRITICAL card
    // and a green suite. FINITENESS IS NOT HONESTY: the honest property
    // is that a ratio is either a real measurement or `null`, and NEVER
    // Infinity / NaN / a fabricated 0. Absence is now a first-class
    // value in `RatioFacts`, so it is asserted as one.
    for (const [k, v] of Object.entries(facts.ratios)) {
      const ok = v === null || (typeof v === "number" && Number.isFinite(v));
      expect(ok, `ratios.${k} = ${v} — must be a finite number or null`).toBe(true);
      expect(v, `ratios.${k} must never be Infinity`).not.toBe(Infinity);
      expect(v, `ratios.${k} must never be -Infinity`).not.toBe(-Infinity);
    }
    // Non-vacuity: this envelope is missing only `totals.liabilities`,
    // so the ratios whose operands DID arrive must still be real
    // numbers. A suite where the fix had nulled everything would pass
    // the loop above and assert nothing at all. 0.849 is the measured
    // equity ratio of this book — the same figure that a `?? 0` on
    // `totals.equity` turns into the "0.0% vs typical 30% floor"
    // sentence on a CRITICAL card.
    expect(facts.ratios.equity_ratio, "equity_ratio was measurable here").toBeCloseTo(0.8491, 4);
  });
});

// ── §D THE ps1 PUBLIC-SUMMARY LANE ─────────────────────────────────────
//
// PS1 in this repo's own invariant list: "Summary facts REFUSE rather
// than approximate. ABSENT ≠ ZERO." The lane's `total_assets` fallback
// was `(I1 ?? 0) + (I2 ?? 0) + (I6 ?? 0)`, so a filing whose I1 did not
// parse published its CURRENT assets as its TOTAL assets — on a page
// that is public, cached and indexed.

describe("§D — the open-data lane sums three terms or none", () => {
  const IND = { I1: 1_000_000, I2: 2_500_000, I6: 50_000, I7: 1_200_000, I10: 2_300_000 };
  const summary = (indicators: Record<string, number>, derived?: { total_assets?: number }) =>
    ({
      companyName: "Public SRL",
      currency: "RON",
      periodLabel: "FY 2024",
      balanceSheet: {},
      incomeStatement: {},
      supplementary: {},
      public_summary: { version: "ps1", status: "PUBLIC_SUMMARY", indicators, derived },
    }) as unknown as Statements;

  it("CONTROL — all three terms present: I1 + I2 + I6", () => {
    const f = factsFrom(summary(IND));
    expect(f.source).toBe("public_summary");
    expect(f.totalAssets()).toBe(3_550_000);
  });

  it("I1 missing: total assets is ABSENT, not I2 + I6", () => {
    const { I1: _drop, ...rest } = IND;
    void _drop;
    const f = factsFrom(summary(rest as Record<string, number>));
    expect(
      f.totalAssets(),
      "the total is the sum of the terms that happened to parse — on this " +
        "shape that is 2,550,000, i.e. current assets published as total assets.",
    ).toBeNull();
    expect(f.totalAssets()).not.toBe(2_550_000);
  });

  it("the ingest-precomputed derived total still wins when it is there", () => {
    const { I1: _drop, ...rest } = IND;
    void _drop;
    const f = factsFrom(summary(rest as Record<string, number>, { total_assets: 3_550_000 }));
    expect(f.totalAssets()).toBe(3_550_000);
  });

  it("an absent equity or liabilities indicator does not become 0", () => {
    const { I10: _e, I7: _l, ...rest } = IND;
    void _e;
    void _l;
    const f = factsFrom(summary(rest as Record<string, number>));
    expect(f.totalEquity()).toBeNull();
    expect(f.totalLiabilities()).toBeNull();
    expect(f.equityPlusLiabilities()).toBeNull();
  });
});

// ── §C THE CONTROL (TC-9) ──────────────────────────────────────────────

describe("§C — the unmutated fixture is UNCHANGED by all of the above", () => {
  const f = factsFrom(statementsWith(envelope));

  it("every accessor still returns the served figure to the cent", () => {
    expect(f.totalAssets()).toBe(TOTALS.assets);
    expect(f.totalEquity()).toBe(TOTALS.equity);
    expect(f.totalLiabilities()).toBe(TOTALS.liabilities);
    expect(f.equityPlusLiabilities()).toBe(TOTALS.equity_plus_liabilities);
    expect(f.currentAssets()).toBe(TOTALS.current_assets);
    expect(f.currentLiabilities()).toBe(TOTALS.current_liabilities);
    expect(f.difference()).toBe(0);
  });

  it("the derived splits are still derived, not refused", () => {
    expect(f.nonCurrentAssets()).toBeCloseTo(TOTALS.assets - TOTALS.current_assets, 2);
    expect(f.nonCurrentLiabilities()).toBeCloseTo(
      TOTALS.liabilities - TOTALS.current_liabilities,
      2,
    );
    expect(f.workingCapital()).toBeCloseTo(
      TOTALS.current_assets - TOTALS.current_liabilities,
      2,
    );
  });

  it("the fact index still publishes total_liabilities WITH its value", () => {
    const index = buildFactIndex({
      periods: [
        {
          periodId: "p1",
          periodLabel: "FY 2025",
          statements: statementsWith(envelope),
          docId: "doc-1",
        },
      ],
    } as unknown as Parameters<typeof buildFactIndex>[0]);
    const tl = index.facts.find((x) => x.factKey === "total_liabilities");
    expect(tl, "the control lost the fact too — this gate has no subject").toBeTruthy();
    expect(tl!.value).toBe(TOTALS.liabilities);
  });
});
