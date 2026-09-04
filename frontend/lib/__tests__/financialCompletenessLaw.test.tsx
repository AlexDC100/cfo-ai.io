// THE COMPLETENESS LAW.
//
//     A VERDICT MUST NOT BE A FUNCTION OF ENVELOPE COMPLETENESS.
//
// This is a PROPERTY test, not a list of cases. It takes a REAL corpus
// envelope, deletes each engine-emitted field IN TURN, and asserts that
// what the product CLAIMS is unchanged. Deleting a field may reduce what
// is SHOWN — a row disappears, a cell says "not reported" — but it must
// never produce a plausible substitute number and never a different
// verdict.
//
// ─── WHY A PROPERTY TEST AND NOT MORE CASES ────────────────────────────
// Four waves have now fixed absent-read-as-zero at whichever surface a
// critic named, and each time the same class was alive one file over.
// Enumerating fields mechanically is the only method that does not
// depend on someone guessing the right field. The sweep below is derived
// from the fixture itself, so a field the engine adds tomorrow is covered
// the day it appears.
//
// ─── WHAT THIS REPLACES ────────────────────────────────────────────────
// Measured on `served_balanced.json` before the fix, deleting ONLY
// envelope fields — same company, same statements, same line items:
//
//     envelope             Z"        zone       composite   RATING
//     intact               5.3313    safe          88.80     A
//     no totals.assets     1.6451    grey          66.80     BB+
//     no totals.equity     5.3313    safe          88.80     A
//     totals: {}           0.0000    DISTRESS      52.30     B
//
// Not even monotone — dropping one field read SAFER than dropping
// everything. And it reached the workbook: the Credit & Risk sheet
// printed `Rating B` and `Altman Z"-Score 0.00` with no cell saying
// anything was unavailable. A lender reading that workbook is told the
// company is distressed because our parser missed a line.
//
// ─── THE FOUR SURFACES ─────────────────────────────────────────────────
//   1. the Risks tab          (RisksPanel, rendered — real DOM)
//   2. the recommendations    (RecommendationsView, rendered — real DOM)
//   3. the balance-sheet tab  (buildBSStatement → BSStatementView)
//   4. the exported workbook  (buildExcelWorkbook — the forwarded file)
//
// RATING and ZONE are asserted EXPLICITLY on every mutation, because
// those two words are what a lender reads.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as XLSX from "xlsx";

vi.mock("@/stores/currency", () => ({
  useAmountFormatter:
    () =>
    (v: number | null | undefined): string =>
      v === null || v === undefined ? "—" : String(Math.round(v * 100) / 100),
  useDisplayCurrency: () => "RON",
  useCurrency: () => ({ display: "RON", rates: { rates: {} } }),
  useRates: () => ({ rates: {} }),
  CurrencyProvider: ({ children }: { children: unknown }) => children,
}));

import {
  computeCreditScore,
  altmanZScore,
  creditModelLabel,
  engineSpokeInMetrics,
  type CreditEnvelope,
  type CreditScoreResult,
  type PiotroskiEnvelope,
} from "@/lib/financialValuation";
import { buildExcelWorkbook } from "@/lib/financialExports";
import { buildPeriodFacts } from "@/lib/periodFacts";
import { detectConditions } from "@/lib/recommendationRules";
import { buildBSStatement } from "@/lib/buildBsStatement";
import type { Statements } from "@/lib/financialReport";

// ─── The real corpus envelope ───────────────────────────────────────────
// Scandia FY2025, the calibration company — a full served period with
// canonical_bs, assembled_bs/pl/cf, assembled_metrics.credit (composite
// 24.4 / CC / Z" 0.22 with all seven sub-scores) and assembled_piotroski.
// Not a hand-written fixture: it is a captured period.
const CORPUS = resolve(
  __dirname,
  "../../../design_review/capsule/fixtures/period-scandia-fy2025.json",
);

interface Corpus {
  statements: Statements;
  assembled_metrics: { credit: CreditEnvelope; piotroski: PiotroskiEnvelope };
  metrics?: Array<{ name: string; value: number | null }>;
  line_items?: unknown[];
}

const raw = JSON.parse(readFileSync(CORPUS, "utf-8")) as Corpus;
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** One mutable copy of the whole period per case.
 *
 *  The three ENGINE inputs are typed OPTIONAL, because "this envelope
 *  did not arrive" is a state the sweep must be able to express — it is
 *  the state production spent weeks in (CLAUDE.md §14). They are always
 *  populated here; only `applied({ wholeTarget })` clears one. */
interface Case {
  statements: Statements;
  credit?: CreditEnvelope;
  piotroski?: PiotroskiEnvelope;
  metricsByName?: Record<string, number | null>;
}
function freshCase(): Case {
  const c = clone(raw);
  const metricsByName: Record<string, number | null> = {};
  for (const m of c.metrics ?? []) metricsByName[m.name] = m.value;
  return { statements: c.statements, credit: c.assembled_metrics.credit, piotroski: c.assembled_metrics.piotroski, metricsByName };
}

// ─── The field sweep ────────────────────────────────────────────────────
// Every ENGINE-EMITTED leaf the four surfaces read, as a dotted path
// into one of the four inputs. Derived, not hand-listed, for the two
// objects whose shape the engine controls (credit sub-scores + weights,
// and the served BS totals) so a new field is swept automatically.

type Target = "statements" | "credit" | "piotroski" | "metrics";
interface Mutation {
  label: string;
  target: Target;
  path: string[];
  /** Delete the WHOLE INPUT, not a path inside it. `applied()` could only
   *  ever reach INSIDE one of the four targets, so `assembled_piotroski`
   *  and `assembled_metrics.credit` were never removed AS OBJECTS — and
   *  that is precisely the shape the defect had. See `WHOLE_TARGETS`. */
  wholeTarget?: true;
}

function pathsOf(obj: unknown, prefix: string[] = []): string[][] {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return [prefix];
  return Object.keys(obj as Record<string, unknown>).flatMap((k) =>
    pathsOf((obj as Record<string, unknown>)[k], [...prefix, k]),
  );
}

/** ── THE DERIVATION SCOPE THAT MISSED, WIDENED ───────────────────────
 *
 *  `pathsOf` returns LEAVES only. A sweep built from it can delete
 *  `credit.subscores.altman` but never `credit.subscores`, and never
 *  `credit` itself — so the gate's own mutation list structurally could
 *  not express "this envelope did not arrive", which is the commonest
 *  real regression there is (CLAUDE.md §14: `assembled_piotroski`
 *  returned null on EVERY period in production for weeks after F1.j).
 *  The two whole-block cases the previous wave added by hand
 *  (`subscores`, `composite_weights`) prove the shape was known; hand-
 *  listing it is what left the level above them uncovered.
 *
 *  This returns EVERY path — every intermediate object as well as every
 *  leaf, at every depth — so a nested object the engine adds tomorrow is
 *  swept as a block the day it appears, without anyone naming it. */
function allPathsOf(obj: unknown, prefix: string[] = []): string[][] {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return prefix.length ? [prefix] : [];
  }
  const here = prefix.length ? [prefix] : [];
  return here.concat(
    Object.keys(obj as Record<string, unknown>).flatMap((k) =>
      allPathsOf((obj as Record<string, unknown>)[k], [...prefix, k]),
    ),
  );
}

function deleteAt(root: unknown, path: string[]): void {
  let cur = root as Record<string, unknown> | undefined;
  for (const seg of path.slice(0, -1)) {
    if (!cur || typeof cur !== "object") return;
    cur = cur[seg] as Record<string, unknown> | undefined;
  }
  if (cur && typeof cur === "object") delete cur[path[path.length - 1]];
}

const seed = freshCase();

/** Each engine input, removed ENTIRELY. Three of the four; `statements`
 *  has no "absent" state (there is no period without statements). */
const WHOLE_TARGETS: Mutation[] = [
  { label: "assembled_piotroski (WHOLE ENVELOPE absent)", target: "piotroski", path: [], wholeTarget: true },
  { label: "assembled_metrics.credit (WHOLE ENVELOPE absent)", target: "credit", path: [], wholeTarget: true },
  { label: "calculated_metrics (WHOLE MAP absent)", target: "metrics", path: [], wholeTarget: true },
];

const MUTATIONS: Mutation[] = [
  // The served BS totals — the operands the whole credit stack divides by.
  ...pathsOf(seed.statements.canonical_bs?.totals ?? {}).map((p) => ({
    label: `canonical_bs.totals.${p.join(".")}`,
    target: "statements" as Target,
    path: ["canonical_bs", "totals", ...p],
  })),
  // …and the legacy envelope totals the gateway writes onto assembled_bs.
  ...["total_assets", "total_equity", "total_liabilities", "bs_balance_delta"].map((k) => ({
    label: `assembled_bs.${k}`,
    target: "statements" as Target,
    path: ["assembled_bs", k],
  })),
  // Whole blocks, not just leaves: the shape a cache miss actually has.
  { label: "canonical_bs.totals (emptied)", target: "statements", path: ["canonical_bs", "totals"] },
  { label: "canonical_bs (absent — legacy period)", target: "statements", path: ["canonical_bs"] },
  // The credit envelope — EVERY path, blocks as well as leaves
  // (composite, grade, Altman, `altman_components` whole and by term,
  // `subscores` whole and by term, `composite_weights` likewise), all
  // derived from the fixture's own shape. `allPathsOf` supersedes the
  // two hand-listed whole-block cases that used to sit here.
  ...allPathsOf(seed.credit).map((p) => ({
    label: `assembled_metrics.credit.${p.join(".")}`,
    target: "credit" as Target,
    path: p,
  })),
  // The Piotroski envelope — same treatment, same reason.
  ...allPathsOf(seed.piotroski).map((p) => ({
    label: `assembled_piotroski.${p.join(".")}`,
    target: "piotroski" as Target,
    path: p,
  })),
  // The calculated_metrics map the Altman reader prefers.
  ...["altman_z_score", "altman_x1", "altman_x2", "altman_x3", "altman_x4"].map((k) => ({
    label: `calculated_metrics.${k}`,
    target: "metrics" as Target,
    path: [k],
  })),
  // ── AND THE WHOLE ENVELOPE, WHICH THIS SWEEP COULD NOT REACH ───────
  // `applied()` deletes a path INSIDE one of the four inputs, so no
  // mutation above can express "the engine sent no Piotroski envelope"
  // — the single field CLAUDE.md §14 records as null on every
  // production period for weeks. Measured on this fixture before the
  // fix: with the credit envelope fully intact (composite 24.4, letter
  // CC, all seven sub-scores), removing ONLY this object answered CCC /
  // 36 / Z" 0.2013 from the other model's weights and band ladder.
  ...WHOLE_TARGETS,
];

// ─── The CONCEPT sweep ──────────────────────────────────────────────────
// A single-field sweep cannot reach absence for any figure the engine
// emits TWICE. `altman_x1` lives in BOTH `calculated_metrics` and
// `assembled_metrics.credit.altman_components`, so deleting either one
// leaves the other standing and the field-by-field sweep above never
// exercises the absent branch at all — a hole this gate had until a
// planted `?? 0` survived it.
//
// These mutations delete a CONCEPT from every source that carries it,
// which is the shape a real envelope regression takes.
interface ConceptMutation {
  label: string;
  apply: (c: ReturnType<typeof freshCase>) => void;
}

const CONCEPTS: ConceptMutation[] = [
  ...["altman_z_score", "altman_x1", "altman_x2", "altman_x3", "altman_x4"].map((k) => ({
    label: `concept ${k} (every source)`,
    apply: (c: Case) => {
      // `metricsByName` is optional since the sweep can remove it whole;
      // the concept mutations only ever run on a fresh case where it is
      // present, and the guard keeps the null-boundary gate honest
      // rather than reaching for `!`.
      if (c.metricsByName) delete c.metricsByName[k];
      const e = c.credit as unknown as Record<string, unknown>;
      delete e[k];
      const comp = e.altman_components as Record<string, unknown> | undefined;
      if (comp) delete comp[k.replace("altman_", "")];
    },
  })),
  {
    label: "concept: every served BS total (canonical + legacy)",
    apply: (c) => {
      if (c.statements.canonical_bs) {
        (c.statements.canonical_bs as unknown as Record<string, unknown>).totals = {};
      }
      const ab = c.statements.assembled_bs as Record<string, unknown> | undefined;
      if (ab) {
        for (const k of [
          "total_assets", "total_equity", "total_liabilities", "bs_balance_delta",
          "total_current_assets", "total_current_liabilities",
        ]) delete ab[k];
      }
    },
  },
  {
    label: "concept: the whole credit envelope is empty",
    apply: (c) => {
      for (const k of Object.keys(c.credit as unknown as Record<string, unknown>)) {
        delete (c.credit as unknown as Record<string, unknown>)[k];
      }
    },
  },
];

function appliedConcept(m: ConceptMutation) {
  const c = freshCase();
  m.apply(c);
  return c;
}

/** The ONE reader, over a case — so a test asserting a rendered sentence
 *  compares against the sentence THAT PERIOD composes, never a constant. */
function readerFor(c: Case): CreditScoreResult {
  return computeCreditScore(c.statements, c.credit, c.piotroski, c.metricsByName);
}

function applied(m: Mutation) {
  const c = freshCase();
  // A WHOLE INPUT, GONE. `computeCreditScore` takes the three engine
  // inputs as separate arguments, so "the envelope did not arrive" is
  // `undefined` in the argument position — not an empty object, which is
  // a DIFFERENT and materially different case (an empty credit envelope
  // is still the engine's claim and is answered by the engine reader;
  // an absent one is no claim at all). Both are swept.
  if (m.wholeTarget) {
    if (m.target === "credit") c.credit = undefined;
    else if (m.target === "piotroski") c.piotroski = undefined;
    else if (m.target === "metrics") c.metricsByName = undefined;
    return c;
  }
  const root =
    m.target === "statements" ? (c.statements as unknown)
    : m.target === "credit" ? (c.credit as unknown)
    : m.target === "piotroski" ? (c.piotroski as unknown)
    : (c.metricsByName as unknown);
  if (m.label.endsWith("(emptied)")) {
    const holder = (c.statements as unknown as Record<string, Record<string, unknown>>)["canonical_bs"];
    if (holder) holder["totals"] = {};
  } else {
    deleteAt(root, m.path);
  }
  return c;
}

// ─── The intact baseline — NON-VACUITY ──────────────────────────────────
// Every assertion below compares against these. A fix that made the
// product refuse everything would fail here, so "renders nothing" cannot
// pass this gate.
const BASE = (() => {
  const c = freshCase();
  const credit = computeCreditScore(c.statements, c.credit, c.piotroski, c.metricsByName);
  return { ...c, result: credit };
})();

describe("completeness law — non-vacuity: the intact envelope produces a FULL verdict", () => {
  it("rating, composite, Altman score, zone and all seven components are present", () => {
    const r = BASE.result;
    expect(r.rating, "intact envelope must yield a letter grade").toBe("CC");
    expect(r.score, "intact envelope must yield a composite").toBeCloseTo(24.4, 6);
    expect(r.altman.score, "intact envelope must yield a Z\" score").toBeCloseTo(0.22, 6);
    expect(r.altman.zone, "intact envelope must yield a zone").toBe("distress");
    expect(r.components).toHaveLength(7);
    for (const c of r.components) {
      expect(c.value, `${c.label}.value present on intact envelope`).not.toBeNull();
      expect(c.read, `${c.label}.read present on intact envelope`).not.toBeNull();
      expect(c.contribution, `${c.label}.contribution present on intact envelope`).not.toBeNull();
    }
    for (const w of r.altman.weightedComponents) {
      expect(w.value, `${w.label} present on intact envelope`).not.toBeNull();
    }
  });
});

// ─── SURFACE 1 + the law itself ─────────────────────────────────────────

/** THE LAW, as one assertion set, applied to every mutation of both
 *  sweeps. Factored so a case cannot be added to one sweep and quietly
 *  checked less than the other. */
function assertVerdictUnmoved(label: string, c: Case) {
      const r = computeCreditScore(c.statements, c.credit, c.piotroski, c.metricsByName);
      const m = { label };

      // ── THE LAW ABOUT WHICH MODEL ANSWERED ────────────────────────
      //
      // ⚠ THIS IS THE ASSERTION WHOSE ABSENCE LET THE DEFECT THROUGH.
      // Every check below compares a rating, a zone or a score — and all
      // of them can COINCIDE across two different models. The rating is
      // only meaningful with the model that minted it: on this fixture
      // the engine says CC / 24.4 off 30/20/15/10/10/10/5, the client
      // fallback says CCC / 36 off 40/20/15/10/10/5, and there is no
      // reason a different fixture could not land both on the same
      // letter and pass a rating-only gate while the weights, the band
      // ladder and the Altman derivation had all silently changed.
      //
      // Deleting a FIELD may never change the model. Only removing the
      // engine's credit envelope ITSELF may — the engine then made no
      // credit claim for the period — and when it does, the result must
      // SAY the model changed, in the sentence every surface prints.
      //
      // ⚠ THIS BRANCHED ON `c.credit !== undefined` ALONE, and that was
      // the F2 defect written into the law. `calculated_metrics` is the
      // engine's SECOND emission path — the very one CLAUDE.md §14 records
      // as the only one that survived in production for weeks — so a
      // period keeps its model when the envelope goes and the rows stay.
      // Under the old rule this sweep positively REQUIRED the swap that
      // printed 24.4 on /report and 36 on the hero.
      if (c.credit !== undefined || engineSpokeInMetrics(c.metricsByName)) {
        expect(
          r.model,
          `deleting ${m.label} SWAPPED THE SCORING MODEL while the engine had still spoken for this period`,
        ).toBe(BASE.result.model);
      } else {
        expect(
          r.modelLabel,
          `the model changed and the result did not say so — a reader cannot tell which model produced the letter`,
        ).not.toBe(BASE.result.modelLabel);
      }
      // The sentence is COMPOSED from the bands the letter was banded
      // with and the weights the rows were scored with — never a frozen
      // constant keyed by the model id, which is what let a re-band print
      // "AAA≥90 … CC<25" two lines under a letter banded at 20.
      expect(
        r.modelLabel,
        `${m.label}: the model label is not composed from this result's own ladder + weights`,
      ).toBe(creditModelLabel(r.model, r.letterBands, r.components));

      // A letter minted by a DIFFERENT model is not "the same verdict
      // moved" — it is a different claim, correctly labelled as such, and
      // comparing its number to this model's is meaningless. The value
      // comparisons below therefore run WITHIN one model; what holds
      // across the boundary is the existence and finiteness law at the
      // bottom of this function, which runs unconditionally.
      const sameModel = r.model === BASE.result.model;

      // THE LAW, stated twice — once for the letter a lender reads, once
      // for the word beside the Altman score.
      if (sameModel && r.rating !== null) {
        expect(r.rating, `deleting ${m.label} changed the RATING`).toBe(BASE.result.rating);
      }
      if (sameModel && r.altman.zone !== null) {
        expect(r.altman.zone, `deleting ${m.label} changed the ZONE`).toBe(BASE.result.altman.zone);
      }
      if (sameModel && r.score !== null) {
        expect(r.score, `deleting ${m.label} changed the COMPOSITE`).toBeCloseTo(
          BASE.result.score as number, 6,
        );
      }
      if (sameModel && r.altman.score !== null) {
        expect(r.altman.score, `deleting ${m.label} changed the Z\" SCORE`).toBeCloseTo(
          BASE.result.altman.score as number, 6,
        );
      }

      // No substituted zero anywhere in the breakdown: a component whose
      // sub-score the envelope stopped carrying must be ABSENT, never 0.
      for (let i = 0; i < r.components.length; i++) {
        const now = r.components[i];
        const before = BASE.result.components[i];
        if (sameModel && now.value !== null) {
          expect(now.value, `${m.label}: component "${now.label}" value moved`).toBeCloseTo(
            before.value as number, 6,
          );
        }
        // The "read" is a VERDICT SENTENCE. It must match the intact one
        // or be absent — never a different sentence. (F1: six rows read
        // "weak" off absent sub-scores under an unchanged headline.)
        if (sameModel && now.read !== null) {
          expect(now.read, `${m.label}: component "${now.label}" READ changed`).toBe(before.read);
        }
        // …and value/read must agree about existence. (F3: value 3.09
        // beside "Distress zone — immediate action required".)
        expect(
          now.read === null,
          `${m.label}: component "${now.label}" has a ${now.value === null ? "sentence with no number" : "number with no sentence"}`,
        ).toBe(now.value === null);
      }

      // Altman component rows: absent, or the intact value. (F2: four
      // 0.0000 rows printed under an unchanged 3.09 total.)
      for (let i = 0; i < r.altman.weightedComponents.length; i++) {
        const now = r.altman.weightedComponents[i];
        const before = BASE.result.altman.weightedComponents[i];
        if (sameModel && now.value !== null) {
          expect(now.value, `${m.label}: Altman "${now.label}" moved`).toBeCloseTo(
            before.value as number, 6,
          );
        }
        expect(
          now.weighted === null,
          `${m.label}: Altman "${now.label}" weighted/value disagree about existence`,
        ).toBe(now.value === null);
      }

      // Never Infinity / NaN — `n / null` is Infinity, which a
      // `>= threshold` read calls PERFECT HEALTH.
      const numbers = [
        r.score, r.altman.score,
        ...r.components.flatMap((x) => [x.value, x.contribution, x.weight]),
        ...r.altman.weightedComponents.flatMap((x) => [x.value, x.weighted]),
      ];
      for (const n of numbers) {
        expect(n === null || Number.isFinite(n), `${m.label}: produced ${n}`).toBe(true);
      }
}

describe("completeness law — the verdict never MOVES when a field is deleted", () => {
  it.each(MUTATIONS.map((m) => [m.label, m] as const))(
    "delete %s → the rating and the zone are the intact ones or absent, never different",
    (label, m) => assertVerdictUnmoved(label, applied(m)),
  );

  // The concept sweep — the one that can actually reach absence for a
  // figure the engine emits from two places.
  it.each(CONCEPTS.map((m) => [m.label, m] as const))(
    "delete %s → the rating and the zone are the intact ones or absent, never different",
    (label, m) => assertVerdictUnmoved(label, appliedConcept(m)),
  );

  it("non-vacuity of the CONCEPT sweep: deleting every Altman source really does refuse", () => {
    // If this reads a number, the sweep above is asserting nothing about
    // absence and a planted `?? 0` would survive it — which is exactly
    // what happened before this case existed.
    const c = appliedConcept(CONCEPTS.find((x) => x.label.startsWith("concept altman_x1"))!);
    const r = computeCreditScore(c.statements, c.credit, c.piotroski, c.metricsByName);
    expect(r.altman.components.x1_wc_to_assets, "x1 must be ABSENT once every source is gone").toBeNull();
    expect(r.altman.weightedComponents[0].weighted).toBeNull();

    const z = appliedConcept(CONCEPTS.find((x) => x.label.startsWith("concept altman_z_score"))!);
    const rz = computeCreditScore(z.statements, z.credit, z.piotroski, z.metricsByName);
    expect(rz.altman.score, "the Z\" score must be ABSENT once every source is gone").toBeNull();
    expect(rz.altman.zone, "…and so must its zone").toBeNull();
  });
});

// ─── THE FE-FALLBACK CORPUS ─────────────────────────────────────────────
// `served_balanced.json` carries NO `assembled_metrics`, so it drives the
// FE-fallback path: the inline Z" arithmetic and the parallel
// 40/20/15/10/10/5 composite. That path is not optional cover — it is
// where the headline table at the top of this file was measured, and
// `buildExcelWorkbook` calls `computeCreditScore(s)` with no envelopes at
// all, so EVERY exported workbook goes through it.
//
// The engine-envelope sweep above cannot reach it (it always supplies a
// credit envelope), which a planted `safeDiv` in the Altman fallback
// proved by surviving.

const BALANCED = resolve(__dirname, "fixtures", "served_balanced.json");
const balancedRaw = JSON.parse(readFileSync(BALANCED, "utf-8")) as Statements;
const freshBalanced = () => clone(balancedRaw);

const BALANCED_MUTATIONS: { label: string; apply: (s: Statements) => void }[] = [
  ...pathsOf(balancedRaw.canonical_bs?.totals ?? {}).map((p) => ({
    label: `canonical_bs.totals.${p.join(".")}`,
    apply: (s: Statements) => {
      deleteAt(s, ["canonical_bs", "totals", ...p]);
      // The legacy mirror carries the same concept — delete both, or the
      // gateway simply reads the survivor and nothing is ever absent.
      const legacy: Record<string, string> = {
        assets: "total_assets", equity: "total_equity", liabilities: "total_liabilities",
        current_assets: "total_current_assets", current_liabilities: "total_current_liabilities",
      };
      const k = legacy[p[0]];
      if (k) deleteAt(s, ["assembled_bs", k]);
    },
  })),
  {
    label: "canonical_bs.totals emptied + legacy totals gone",
    apply: (s: Statements) => {
      if (s.canonical_bs) (s.canonical_bs as unknown as Record<string, unknown>).totals = {};
      const ab = s.assembled_bs as Record<string, unknown> | undefined;
      if (ab) for (const k of ["total_assets", "total_equity", "total_liabilities",
        "total_current_assets", "total_current_liabilities"]) delete ab[k];
    },
  },
];

describe("completeness law — the FE-fallback path (no engine envelope)", () => {
  const BASE_B = computeCreditScore(freshBalanced());

  it("non-vacuity: the intact balanced fixture produces the FULL verdict", () => {
    // These are the intact figures from the headline table. If this case
    // ever reads null, the sweep below is asserting nothing.
    expect(BASE_B.altman.score).toBeCloseTo(5.3313, 3);
    expect(BASE_B.altman.zone).toBe("safe");
    expect(BASE_B.score).toBeCloseTo(88.8, 6);
    expect(BASE_B.rating).toBe("A");
  });

  it.each(BALANCED_MUTATIONS.map((m) => [m.label, m] as const))(
    "delete %s → A stays A or becomes absent; SAFE stays SAFE or becomes absent",
    (_label, m) => {
      const s = freshBalanced();
      m.apply(s);
      const r = computeCreditScore(s);
      // The four rows of the headline table, as a law.
      if (r.rating !== null) expect(r.rating, `${m.label} changed the RATING`).toBe("A");
      if (r.altman.zone !== null) expect(r.altman.zone, `${m.label} changed the ZONE`).toBe("safe");
      if (r.score !== null) expect(r.score, `${m.label} changed the COMPOSITE`).toBeCloseTo(88.8, 6);
      if (r.altman.score !== null) {
        expect(r.altman.score, `${m.label} changed the Z" SCORE`).toBeCloseTo(5.3313, 3);
      }
      // Specifically: never the 0.0000 / DISTRESS / B that this fixture
      // used to produce off an emptied `totals`.
      expect(r.altman.zone, `${m.label} painted DISTRESS off a missing field`).not.toBe("distress");
      expect(r.rating, `${m.label} downgraded the company to B`).not.toBe("B");
    },
  );

  it("emptying every served total refuses the whole verdict — it does not print 0.00 / DISTRESS / B", () => {
    const s = freshBalanced();
    BALANCED_MUTATIONS[BALANCED_MUTATIONS.length - 1].apply(s);
    const r = computeCreditScore(s);
    expect(r.altman.score, "Z\" was 0.0000 here").toBeNull();
    expect(r.altman.zone, "the zone was DISTRESS here").toBeNull();
    expect(r.score, "the composite was 52.30 here").toBeNull();
    expect(r.rating, "the rating was B here").toBeNull();
  });
});

// ─── THE FALLBACK PATH, SWEPT WITH THE SAME DERIVATION SCOPE ────────────
//
// The sweep above deletes served BS TOTALS only — a hand-chosen slice of
// one object. The engine path gets a sweep derived from its whole
// fixture; this path got five keys. That asymmetry is why the four
// defects below lived here, on THE PATH EVERY EXPORTED WORKBOOK TAKES,
// while the gate stayed green:
//
//   delete canonical_bs.totals.assets               Piotroski 5 → 4
//                                                   ("ROA positive ✗ —
//                                                    0.00% on an
//                                                    unreported total")
//   delete canonical_bs.totals.current_liabilities  cash ratio 0.0433 → 0
//                                                   ("Thin cash buffer")
//   delete assembled_bs.current_year_pnl            Z" 0.20131 → 0.19070
//   delete assembled_bs.retained_earnings           Z" 0.20131 → 0.18591
//
// The last two never touch a "total" at all, so no widening of the
// hand-listed slice would have found them. This sweeps EVERY path —
// objects and leaves, every level — of BOTH fixtures, which is 1,067
// deletions rather than six.
//
// It runs as a collected-violations loop rather than 1,067 `it.each`
// cases (the rendered surfaces below cannot be swept that way, and a
// per-path test name for each would drown the report). The cost of a
// loop is that it can go vacuous silently, so it declares its WORK and
// a FLOOR — the battery's own doctrine in scripts/run_battery.py: a
// census that finds nothing is a broken gate, never a passing one.

/** The two objects the sweep deletes LEAF BY LEAF but never whole.
 *
 *  They are non-optional on `Statements`: a period without an income
 *  statement or a balance sheet is not a period the app can hold, and
 *  removing them models a malformed object rather than an engine that
 *  omitted a field — which is what this law is about. Their LEAVES are
 *  swept in full (a parser CAN miss a line), and every other top-level
 *  object, including every engine book, is swept whole. Named here, and
 *  the count asserted below, so the exclusion cannot quietly widen. */
const REQUIRED_SCAFFOLDING = new Set(["balanceSheet", "incomeStatement"]);

const FALLBACK_SUBJECTS: { name: string; statements: () => Statements; floor: number }[] = [
  {
    name: "Scandia FY2025 (the real corpus, read through the fallback — the workbook's path)",
    statements: () => clone(raw.statements),
    floor: 800,
  },
  {
    name: "served_balanced (the fixture the headline table was measured on)",
    statements: () => freshBalanced(),
    floor: 60,
  },
];

describe("completeness law — the FE-fallback path, swept at the engine path's scope", () => {
  it.each(FALLBACK_SUBJECTS.map((s) => [s.name, s] as const))(
    "%s: no deletion moves the verdict, and the sweep is not vacuous",
    (_name, subject) => {
      const base = computeCreditScore(subject.statements());

      // NON-VACUITY, per subject. If the intact fixture has no verdict
      // there is nothing for the loop below to move, and it would pass
      // over nothing.
      expect(base.rating, `${subject.name}: intact must yield a letter`).not.toBeNull();
      expect(base.score, `${subject.name}: intact must yield a composite`).not.toBeNull();
      expect(base.altman.score, `${subject.name}: intact must yield a Z"`).not.toBeNull();
      expect(base.model, "the fallback subject must actually take the fallback path").toBe(
        "client-fallback-v1",
      );

      const violations: string[] = [];
      const paths = allPathsOf(subject.statements()).filter(
        (p) => !(p.length === 1 && REQUIRED_SCAFFOLDING.has(p[0])),
      );
      // What was filtered out, and why, asserted rather than assumed —
      // an exclusion nobody can see is a hole. Every OTHER top-level
      // object, engine envelope or not, is swept whole.
      expect(
        allPathsOf(subject.statements()).length - paths.length,
        "the scaffolding exclusion removed something other than the two required FE objects",
      ).toBe(REQUIRED_SCAFFOLDING.size);
      for (const p of paths) {
        const s = subject.statements();
        deleteAt(s, p);
        const label = p.join(".");
        let r: ReturnType<typeof computeCreditScore>;
        try {
          r = computeCreditScore(s);
        } catch (e) {
          violations.push(`${label}: THREW ${(e as Error).message}`);
          continue;
        }
        // Same law, same words as the engine sweep.
        if (r.model !== base.model) violations.push(`${label}: MODEL ${base.model} → ${r.model}`);
        if (r.rating !== null && r.rating !== base.rating) {
          violations.push(`${label}: RATING ${base.rating} → ${r.rating}`);
        }
        if (r.altman.zone !== null && r.altman.zone !== base.altman.zone) {
          violations.push(`${label}: ZONE ${base.altman.zone} → ${r.altman.zone}`);
        }
        if (r.score !== null && Math.abs(r.score - (base.score as number)) > 1e-6) {
          violations.push(`${label}: COMPOSITE ${base.score} → ${r.score}`);
        }
        if (r.altman.score !== null && Math.abs(r.altman.score - (base.altman.score as number)) > 1e-9) {
          violations.push(`${label}: Z" ${base.altman.score} → ${r.altman.score}`);
        }
        for (let i = 0; i < r.components.length; i++) {
          const now = r.components[i];
          const before = base.components[i];
          if (now.value !== null && before.value !== null
              && Math.abs(now.value - before.value) > 1e-9) {
            violations.push(`${label}: component "${now.label}" ${before.value} → ${now.value}`);
          }
          if (now.value !== null && before.value === null) {
            violations.push(`${label}: component "${now.label}" INVENTED ${now.value}`);
          }
          // A number with no sentence, or a sentence with no number.
          if ((now.read === null) !== (now.value === null)) {
            violations.push(
              `${label}: component "${now.label}" has a ${
                now.value === null ? "sentence with no number" : "number with no sentence"
              }`,
            );
          }
          for (const n of [now.value, now.contribution, now.weight]) {
            if (!(n === null || Number.isFinite(n))) {
              violations.push(`${label}: component "${now.label}" produced ${n}`);
            }
          }
        }
        // A Piotroski check that could not be RUN must not read as one
        // the company FAILED — the ✗ that an unfiled total-assets used
        // to print.
        for (const chk of r.piotroski?.checks ?? []) {
          if (chk.unresolved && chk.result === "fail") {
            violations.push(`${label}: Piotroski "${chk.key}" marked FAIL for an unfiled figure`);
          }
        }
      }

      // WORK + FLOOR. A loop that swept nothing passes every assertion
      // above; the floor is what makes that state loud.
      expect(
        paths.length,
        `${subject.name}: the sweep examined ${paths.length} path(s) — below the floor of ${subject.floor}. ` +
          "A completeness sweep over nothing is not a clean completeness sweep.",
      ).toBeGreaterThanOrEqual(subject.floor);
      expect(violations, `${subject.name}: ${violations.length} completeness violation(s)`).toEqual([]);
    },
  );

  it("non-vacuity of the SWEEP ITSELF: the corpus really does reach both defect families", () => {
    // If either of these stops being absent-capable, the loop above is
    // asserting nothing about the two shapes it was written for and a
    // re-planted `?? 0` would survive it.
    const a = clone(raw.statements);
    deleteAt(a, ["canonical_bs", "totals", "current_liabilities"]);
    deleteAt(a, ["assembled_bs", "total_current_liabilities"]);
    const ra = computeCreditScore(a);
    const cash = ra.components.find((c) => c.label.startsWith("Cash ratio"));
    expect(cash?.value, "the cash-ratio row must REFUSE, not print 0.00").toBeNull();
    expect(cash?.read, "…and carry no sentence either").toBeNull();

    const b = clone(raw.statements);
    deleteAt(b, ["assembled_bs", "current_year_pnl"]);
    const rb = computeCreditScore(b);
    expect(rb.altman.score, "an incomplete cumulative book must refuse Z\", not shrink it").toBeNull();
    expect(rb.rating, "…and a refused Z\" refuses the letter").toBeNull();
  });
});

// ─── SURFACE 1 — the Risks tab, in the DOM ──────────────────────────────

describe("completeness law — surface 1: the Risks tab (rendered)", () => {
  afterEach(cleanup);

  const renderPanel = async (c: ReturnType<typeof freshCase>) => {
    const { RisksPanel } = await import("@/pages/cfo/FinancialStatements");
    render(
      <RisksPanel
        statements={c.statements}
        creditEnvelope={c.credit}
        piotroskiEnvelope={c.piotroski}
        metricsByName={c.metricsByName}
      />,
    );
  };

  it("non-vacuity: the intact envelope renders the rating and the zone", async () => {
    await renderPanel(freshCase());
    expect(screen.getByTestId("credit-rating").textContent).toBe("CC");
    expect(screen.getByTestId("altman-zone").getAttribute("data-zone")).toBe("distress");
    expect(screen.getByTestId("altman-score").textContent).toBe("0.22");
  });

  it("subscores deleted from ONE emission path → nothing moves at all", async () => {
    // ⚠ THE ENGINE WRITES THE SUB-SCORES TWICE — into
    // `assembled_metrics.credit.subscores` and into the
    // `calculated_metrics.credit_subscore_*` rows. Deleting one copy is
    // not "the engine did not carry it": it is one of two engine mouths
    // going quiet, and the completeness law says a verdict may not be a
    // function of WHICH survived. `/report`'s card has always read the
    // metric rows first; the shared reader read only the envelope, which
    // is the same split that gave one period two composites.
    const c = applied({ label: "assembled_metrics.credit.subscores (whole block)", target: "credit", path: ["subscores"] });
    await renderPanel(c);
    expect(screen.getByTestId("credit-rating").textContent).toBe("CC");
    expect(
      screen.queryAllByText(/component: (weak|watch zone|adequate|strong)/).length,
      "one engine emission path was deleted and the six reads vanished — a verdict that " +
        "is a function of which path survived",
    ).toBe(6);
    cleanup();
  });

  it("subscores deleted from BOTH → the six component READS are gone, and the headline is unchanged", async () => {
    const c = applied({ label: "assembled_metrics.credit.subscores (whole block)", target: "credit", path: ["subscores"] });
    for (const k of Object.keys(c.metricsByName ?? {})) {
      if (k.startsWith("credit_subscore_")) delete c.metricsByName![k];
    }
    await renderPanel(c);
    // The headline verdict is untouched — the engine still emitted it.
    expect(screen.getByTestId("credit-rating").textContent).toBe("CC");
    // …and NO row claims a component is "weak". The Altman row's read is
    // a zone sentence, not a sub-score sentence, so the correct count of
    // "<label> component: <verdict>" strings here is exactly zero.
    expect(
      screen.queryAllByText(/component: (weak|watch zone|adequate|strong)/).length,
      "a sub-score the envelope did not carry produced a verdict sentence",
    ).toBe(0);
    // Non-vacuity for THIS case: the intact envelope does produce them.
    cleanup();
    await renderPanel(freshCase());
    expect(
      screen.queryAllByText(/component: (weak|watch zone|adequate|strong)/).length,
      "the intact envelope must produce the six sub-score reads",
    ).toBe(6);
  });

  // ── THE SWAP THAT SHIPPED, AT THE SURFACE ───────────────────────────
  it("assembled_piotroski absent → the SAME model, the SAME letter, one block fewer", async () => {
    // Measured before the fix, with the credit envelope fully intact:
    // this deletion answered CCC / 36 / Z" 0.2013 from the client
    // fallback's 40/20/15/10/10/5 weights and its own band ladder. It is
    // the field CLAUDE.md §14 records as null on EVERY production period
    // for weeks after F1.j — so every Risks tab in that window printed a
    // letter the engine did not mint, and nothing on screen said so.
    const c = applied(WHOLE_TARGETS.find((m) => m.target === "piotroski")!);
    await renderPanel(c);
    expect(screen.getByTestId("credit-rating").textContent).toBe("CC");
    expect(screen.getByTestId("credit-model").getAttribute("data-model")).toBe(
      "engine-canonical-v1",
    );
    // The Piotroski BLOCK is gone — not silently replaced by the other
    // model's nine checks under the engine's letter.
    expect(screen.getByTestId("piotroski-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("altman-score")?.textContent).toBe("0.22");
  });

  it("a printed LETTER always carries its MODEL — on both models", async () => {
    // The law that makes a swap impossible to have silently: the letter
    // and the name of the model that minted it are rendered together, so
    // a reader can never be shown one without the other.
    const base = freshCase();
    await renderPanel(base);
    expect(screen.getByTestId("credit-rating").textContent).toBe("CC");
    const engine = screen.getByTestId("credit-model");
    expect(engine.getAttribute("data-model")).toBe("engine-canonical-v1");
    expect(engine.textContent).toBe(readerFor(base).modelLabel);
    expect(engine.textContent).toMatch(/30\/20\/15\/10\/10\/10\/5/);

    cleanup();
    // …and the other model names itself as the other model, in words a
    // reader can act on, not a code.
    //
    // ⚠ THIS USED TO DELETE THE ENVELOPE ONLY, and passed — because the
    // reader then answered with the OTHER model off `calculated_metrics`
    // that were still sitting right there. Reaching the fallback now takes
    // silencing the engine on BOTH emission paths, which is what "no
    // engine credit envelope for this period" was always supposed to mean.
    const noEngine = applied(WHOLE_TARGETS.find((m) => m.target === "credit")!);
    noEngine.metricsByName = undefined;
    await renderPanel(noEngine);
    const fe = screen.getByTestId("credit-model");
    expect(fe.getAttribute("data-model")).toBe("client-fallback-v1");
    expect(fe.textContent).toBe(readerFor(noEngine).modelLabel);
    expect(fe.textContent, "the fallback must say WHY it is the fallback").toMatch(
      /no engine credit envelope/i,
    );
    expect(
      screen.getByTestId("credit-rating").textContent,
      "non-vacuity: the two models really do print different letters here",
    ).toBe("CCC");
  });

  it("the Altman zone chip is NEVER 'distress' by fall-through", async () => {
    // Delete the engine Z" from BOTH sources and empty the BS totals the
    // FE fallback would divide by: nothing left to place in a zone.
    const c = freshCase();
    delete (c.credit as Record<string, unknown>).altman_z_score;
    if (c.metricsByName) delete c.metricsByName["altman_z_score"];
    if (c.statements.canonical_bs) (c.statements.canonical_bs as unknown as Record<string, unknown>).totals = {};
    const ab = c.statements.assembled_bs as Record<string, unknown> | undefined;
    if (ab) { delete ab.total_assets; delete ab.total_equity; delete ab.total_liabilities; }

    await renderPanel(c);
    const chip = screen.getByTestId("altman-zone");
    expect(
      chip.getAttribute("data-zone"),
      "an unplaceable score must not be painted DISTRESS",
    ).toBe("unavailable");
    expect(chip.textContent).not.toMatch(/distress/i);
    expect(screen.getByTestId("altman-score").textContent).toBe("—");
  });
});

// ─── SURFACE 2 — the recommendations ────────────────────────────────────

describe("completeness law — surface 2: recommendation cards", () => {
  const factsFor = (c: ReturnType<typeof freshCase>) =>
    buildPeriodFacts({
      periodId: "p1",
      statements: c.statements,
      lineItems: (raw.line_items ?? []) as never,
      valuation: null,
      industry: c.statements.industry ?? null,
    });

  it("non-vacuity: the intact envelope measures a real equity ratio", () => {
    const f = factsFor(freshCase());
    expect(f.ratios.equity_ratio).toBeCloseTo(0.147, 3);
  });

  it.each(MUTATIONS.filter((m) => m.target === "statements").map((m) => [m.label, m] as const))(
    "delete %s → no card CITES a fabricated ratio",
    (_label, m) => {
      const f = factsFor(applied(m));
      const intact = factsFor(freshCase()).ratios;

      // ── THE LAW AT THE RATIO LEVEL ────────────────────────────────
      // Asserting only that a ratio is FINITE — which is what the
      // previous gate did — passes every substituted 0, and matching on
      // prose only catches rules that happen to FIRE on this fixture
      // (the covenant-audit rule needs 95% lender concentration and
      // Scandia is at 72.6%, so its "equity ratio 0.0%" sentence is
      // never reached here). The property that holds regardless: a
      // deletion may make a ratio ABSENT, never DIFFERENT.
      for (const [k, v] of Object.entries(f.ratios)) {
        const before = (intact as unknown as Record<string, number | null>)[k];
        expect(v === null || Number.isFinite(v), `ratios.${k} = ${v}`).toBe(true);
        if (v !== null) {
          expect(
            before,
            `deleting ${m.label} INVENTED ratios.${k} = ${v} (it was absent intact)`,
          ).not.toBeNull();
          expect(
            v,
            `deleting ${m.label} MOVED ratios.${k} from ${before} to ${v}`,
          ).toBeCloseTo(before as number, 9);
        }
      }
      for (const cond of detectConditions(f)) {
        const prose = [cond.title, cond.rationaleFallback].join(" ");
        // The exact sentence F4 produced: an unread equity ratio printed
        // as a covenant breach.
        expect(
          prose,
          `${m.label}: "${cond.ruleKey}" cites a fabricated 0.0% equity ratio`,
        ).not.toMatch(/equity ratio 0\.0%/);
        expect(
          prose,
          `${m.label}: "${cond.ruleKey}" cites a fabricated 0.00× DSCR`,
        ).not.toMatch(/DSCR 0\.00×/);
        // A cited fact is a measurement or an absence, never NaN/Infinity.
        for (const [k, v] of Object.entries(cond.factsCited)) {
          expect(
            v === null || Number.isFinite(v),
            `${m.label}: ${cond.ruleKey} cites ${k} = ${v}`,
          ).toBe(true);
        }
      }
    },
  );
});

// ─── SURFACE 3 — the balance-sheet tab ──────────────────────────────────

describe("completeness law — surface 3: the balance-sheet tab", () => {
  const build = (c: ReturnType<typeof freshCase>) =>
    buildBSStatement({
      lineItems: [],
      assembledBs: c.statements.assembled_bs as never,
      canonicalBs: c.statements.canonical_bs as never,
      entity: "Scandia",
      asOf: "31.12.2025",
      comparativeDate: "01.01.2025",
      currency: "RON",
    });

  it("non-vacuity: the intact envelope produces both grand totals", () => {
    const st = build(freshCase());
    expect(st.totalAssets.closing).not.toBeNull();
    expect(st.totalEquityLiab.closing).not.toBeNull();
  });

  it("F6 — one side of the legacy envelope absent must NOT publish the other side as the total", () => {
    // The legacy `assembled_bs` path, reached on every cached and
    // pre-canonical period. `(equity ?? 0) + (liabilities ?? 0)` used to
    // publish whichever side survived AS the whole E&L total, and
    // `bs_balance_delta ?? 0` then called that book perfectly balanced.
    const c = freshCase();
    delete (c.statements as unknown as Record<string, unknown>).canonical_bs;
    const ab = c.statements.assembled_bs as Record<string, unknown>;
    const equityOnly = ab.total_equity as number;
    delete ab.total_liabilities;
    delete ab.bs_balance_delta;

    const st = build(c);
    expect(
      st.totalEquityLiab.closing,
      "an absent liabilities total must refuse the E&L grand total",
    ).toBeNull();
    expect(st.totalEquityLiab.closing).not.toBe(equityOnly);
    expect(
      st.balanceCheck,
      "a drift the envelope could not state is not a zero drift",
    ).toBeNull();
    // …and NO NEW synthetic plug appeared because of the deletion. The
    // per-bucket residual rows that the intact envelope already carries
    // are legitimate (they surface FE-coverage gaps); what must not
    // happen is a SECTION-LEVEL plug sized to close a gap against a
    // grand total that was never served — the row that used to make an
    // unserved total look internally consistent.
    const plugsOf = (s: typeof st) =>
      s.equityLiabSections.flatMap((sec) =>
        sec.lines.filter((l) => /carve-outs/i.test(l.label)).map((l) => l.label),
      );
    expect(plugsOf(st), "a plug row closed a gap that does not exist").toEqual([]);
  });

  it.each(
    ["total_assets", "total_equity", "total_liabilities", "bs_balance_delta"].map((k) => [k] as const),
  )("delete assembled_bs.%s → totals are absent or intact, never invented", (key) => {
    const intact = build(freshCase());
    const c = freshCase();
    delete (c.statements as unknown as Record<string, unknown>).canonical_bs;
    delete (c.statements.assembled_bs as Record<string, unknown>)[key];
    const st = build(c);
    for (const side of ["totalAssets", "totalEquityLiab"] as const) {
      const now = st[side].closing;
      if (now !== null) {
        expect(now, `deleting ${key} moved ${side}`).toBeCloseTo(intact[side].closing as number, 2);
      }
    }
    expect(st.balanceCheck === null || Number.isFinite(st.balanceCheck)).toBe(true);
  });
});

// ─── SURFACE 4 — the exported workbook ──────────────────────────────────

describe("completeness law — surface 4: the workbook people forward", () => {
  const sheetOf = (wb: XLSX.WorkBook): string[][] =>
    XLSX.utils.sheet_to_json(wb.Sheets["Credit & Risk"], {
      header: 1,
      raw: false,
      defval: "",
    }) as string[][];
  const creditSheet = (c: Case): string[][] => sheetOf(buildExcelWorkbook(c.statements));
  /** The workbook as the APP builds it — with the period's engine
   *  envelopes, which is what the one caller in FinancialStatements.tsx
   *  now passes. */
  const creditSheetWithEngine = (c: Case): string[][] =>
    sheetOf(
      buildExcelWorkbook(c.statements, undefined, {
        credit: c.credit,
        piotroski: c.piotroski,
        metricsByName: c.metricsByName,
      }),
    );

  const cellAfter = (rows: string[][], label: string): string | undefined =>
    rows.find((r) => r[0] === label)?.[1];

  it("non-vacuity: the intact envelope prints a Score and a Rating", () => {
    const rows = creditSheet(freshCase());
    expect(cellAfter(rows, "Score (0–100)")).toBeTruthy();
    expect(cellAfter(rows, "Rating")).toBeTruthy();
    expect(cellAfter(rows, "Rating")).not.toBe("not reported");
  });

  // ── THE WORKBOOK AND THE SCREEN PRINT THE SAME LETTER ───────────────
  it("the exported letter is the one on screen, and the sheet names the model", () => {
    // MEASURED, ON THE INTACT CORPUS, BEFORE THE ENVELOPES WERE THREADED:
    // the app showed CC / 24.4 (engine) and the workbook the user
    // forwarded to a lender showed CCC / 36 (client fallback), because
    // `buildExcelWorkbook` called `computeCreditScore(s)` with no
    // envelopes and `Statements` does not carry `assembled_metrics`.
    // Same company, same period, same click — two letters, and the
    // wrong one is the one that leaves the building.
    const c = freshCase();
    const onScreen = computeCreditScore(c.statements, c.credit, c.piotroski, c.metricsByName);
    const rows = creditSheetWithEngine(c);
    expect(cellAfter(rows, "Rating"), "the workbook printed a different letter than the app")
      .toBe(onScreen.rating);
    expect(cellAfter(rows, "Scoring model")).toBe(onScreen.model);
    expect(cellAfter(rows, "Model")).toBe(onScreen.modelLabel);
    // Non-vacuity: the two models genuinely disagree on this period, so
    // the assertion above is not satisfiable by accident.
    expect(onScreen.rating).toBe("CC");
    expect(cellAfter(creditSheet(c), "Rating"), "the envelope-less workbook is the OTHER model")
      .toBe("CCC");
  });

  it("a workbook NEVER prints a letter without naming the model that minted it", () => {
    // On both models, and whether the verdict is present or refused —
    // the recipient of a forwarded file cannot ask the app which one ran.
    const engineCase = freshCase();
    const bareCase = freshCase();
    for (const [rows, expected] of [
      [creditSheetWithEngine(engineCase), readerFor(engineCase)],
      // `creditSheet` builds the workbook with NO envelopes and no metric
      // map at all, so this row really is the other model.
      [creditSheet(bareCase), computeCreditScore(bareCase.statements)],
    ] as [ string[][], CreditScoreResult ][]) {
      const model = cellAfter(rows, "Scoring model");
      expect(model, "the Credit & Risk sheet carried no model id").toBeTruthy();
      expect(["engine-canonical-v1", "client-fallback-v1"]).toContain(model);
      expect(
        cellAfter(rows, "Model"),
        "the model id shipped without the sentence that explains it",
      ).toBe(expected.modelLabel);
    }
  });

  it("engine period, no Piotroski envelope → the sheet says so, it does not run the other screen", () => {
    const c = applied(WHOLE_TARGETS.find((m) => m.target === "piotroski")!);
    const rows = creditSheetWithEngine(c);
    const flat = rows.flat().map(String);
    expect(cellAfter(rows, "Rating"), "the letter is still the engine's").toBe("CC");
    expect(cellAfter(rows, "Score (0–9)"), "…and the F-score is not substituted").toBe(
      "not reported",
    );
    expect(
      flat.some((v) => /piotroski screen was not reported/i.test(v)),
      "the workbook withheld the screen without saying anything was unavailable",
    ).toBe(true);
    // Non-vacuity: the intact envelope DOES print the screen.
    const intact = creditSheetWithEngine(freshCase());
    expect(cellAfter(intact, "Score (0–9)")).not.toBe("not reported");
  });

  it("an unavailable figure SAYS SO in the cell — it never prints 0.00", () => {
    // The exact shape a lender received: BS totals absent, so the FE
    // fallback composite cannot complete.
    const c = freshCase();
    if (c.statements.canonical_bs) (c.statements.canonical_bs as unknown as Record<string, unknown>).totals = {};
    const ab = c.statements.assembled_bs as Record<string, unknown>;
    delete ab.total_assets; delete ab.total_equity; delete ab.total_liabilities;

    const rows = creditSheet(c);
    const flat = rows.flat().map(String);

    expect(cellAfter(rows, "Rating"), "the workbook printed a rating it could not compute")
      .toBe("not reported");
    expect(cellAfter(rows, "Score (0–100)")).toBe("not reported");

    // The Altman component row must not carry a printed 0.00.
    const altmanRow = rows.find((r) => /Altman/.test(String(r[0])));
    expect(altmanRow?.[1], "the Credit & Risk sheet printed Altman 0.00").not.toBe("0.00");
    expect(altmanRow?.[1]).toBe("not reported");

    // And the sheet must SAY why, in words, because the recipient of a
    // forwarded workbook cannot ask the app.
    expect(
      flat.some((v) => /not enough of the source book was recognised/i.test(v)),
      "the workbook withheld a verdict without saying anything was unavailable",
    ).toBe(true);
    expect(
      flat.some((v) => /do not read it as distress/i.test(v)),
      "the workbook must say the absence is an extraction limit, not a finding",
    ).toBe(true);
  });

  it.each(MUTATIONS.filter((m) => m.target === "statements").map((m) => [m.label, m] as const))(
    "delete %s → the workbook's Rating cell is the intact one or 'not reported'",
    (_label, m) => {
      const intact = cellAfter(creditSheet(freshCase()), "Rating");
      const now = cellAfter(creditSheet(applied(m)), "Rating");
      expect(
        now === "not reported" || now === intact,
        `deleting ${m.label} changed the workbook RATING from ${intact} to ${now}`,
      ).toBe(true);
    },
  );
});
