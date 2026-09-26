// THE FORECAST COCKPIT — the one reader of the engine's cockpit payload
// (owner-approved spec, 2026-09-21: "four numbers, one chart, sliders").
//
// ── THE ONE RULE ────────────────────────────────────────────────────────
//
// THE PAGE DOES NO MATH. Every number the cockpit shows — the four numbers a
// bank asks for, every bar and point of the chart, the funding need and its
// interest, the DSCR and its verdict against the bank's threshold, every step
// of the bridge from the base case, every cell of the statements, the sentence
// under the numbers — is served by the engine that also produces the report
// the bank receives (`engine.forecast.cockpit`, POST /api/forecast/{id}/
// cockpit). The Scenarios page once ran its own cascade in the browser and
// showed a recession with cash at −107.6M; this module exists so that can
// never happen here, and `frontend/components/forecast/cockpit/__tests__/
// cockpitNoMoneyMath.test.ts` greps every cockpit source for arithmetic on an
// amount and plants violations to prove it reds.
//
// So this module does three things and nothing else:
//   · reads the served payload (`forecast_cockpit/1`) into typed objects.
//     Every money amount becomes an opaque `CockpitMinor` inside a
//     `CockpitAmount` — `a + b` over two of them does not compile — and comes
//     out only through `cockpitDisplay` (the one division, minor → major, with
//     the projected marker handed over in the same call; painted by
//     <CockpitAmountView>, ◇ and all) or `cockpitPlot` (a chart coordinate);
//   · keeps the ENGINE's own formatted text where it serves one (the four
//     numbers and the sentence arrive formatted, per language);
//   · holds a slider POSITION as the exact decimal the wire carries and
//     derives integer TICKS for the thumb at render, at the lever's FIXED
//     scale — the pack's `decimals`, served on every lever (engine gate F10),
//     never derived from an answer. Integer string arithmetic (`exactDecimal`,
//     `ticksOf`, `leverTicks`): never a float on the wire. The 2026-09-26
//     verifier repro: a scale derived from each ANSWER's value flipped after
//     one honest move (a six-decimal growth default → "0.05": ±300000/1000
//     became ±300/1), the stored ticks were re-read at the new scale, and
//     the next move of any other slider sent revenue_growth "50" → 422; DSO
//     40 read "4.000.000 zile". A position that is a decimal cannot be
//     re-read.
// It formats nothing (no Intl, no toFixed): painting is the components' job
// (components/forecast/cockpit/format.ts), exactly as forecastFacts.ts leaves
// it to <ProjectedAmount>.
//
// ── THE WIRE (`forecast_cockpit/1`, the engine lane's contract) ───────────
//
//   POST /api/forecast/{period_id}/cockpit
//     body    {case_id, levers: {<lever id>: "<exact decimal>"}}
//             case_id: an engine case (base | optimist | pesimist) or a saved
//             one ("saved:<id>", which the ENGINE reads from the company's
//             own org_prefs.forecast_cases); levers: only the sliders the
//             reader moved. An empty object IS the case.
//   POST /api/forecast/{period_id}/cockpit/export   (same body)
//     answer  {document, cockpit, assumptions_page}: the bank export's data.
//
// A payload that is not a cockpit reads as `null`; one that claims to be and
// breaks the contract throws `CockpitContractError` — a producer defect paints
// nothing, not half a cockpit.

import { exactDecimal } from "@/lib/forecastFacts";

export const COCKPIT_VERSION = "forecast_cockpit/1";
export const BASE_CASE_ID = "base";
export const SAVED_CASE_PREFIX = "saved:";

/** THE OWNER'S NUMBER for the slider debounce ("debounce ~250 ms", spec
 *  2026-09-21), used only until the engine states its own
 *  (`client.debounce_ms` on the payload, which wins when served). */
export const SPEC_DEBOUNCE_MS = 250;

export type Lang = "ro" | "en";

export interface Bilingual {
  readonly ro: string;
  readonly en: string;
}

/** A served text in the reader's language. */
export function pick(text: Bilingual | null | undefined, lang: string | undefined): string {
  if (!text) return "";
  return (lang ?? "").toLowerCase().startsWith("ro") ? text.ro : text.en;
}

// ── the opaque amount ────────────────────────────────────────────────────

declare const COCKPIT_MINOR: unique symbol;

/** An integer count of minor units that is NOT a `number` to the type
 *  checker: no arithmetic compiles over it, and it reaches a number only
 *  through `cockpitDisplay` / `cockpitPlot` below. */
export type CockpitMinor = { readonly [COCKPIT_MINOR]: "cockpit_minor" };

export interface CockpitAmount {
  /** "projected" (◇) or "actual" (year 0, out of the book). */
  readonly kind: "projected" | "actual";
  readonly period: string;
  /** Null when the engine refused the figure — never a zero. */
  readonly minor: CockpitMinor | null;
  readonly refusal: Bilingual | null;
}

export interface AmountMarker {
  readonly projected: boolean;
  readonly period: string;
}

/** THE ONE DOOR to a display value: minor units to major units (the single
 *  division, at the edge), with the marker in the same call. `null` for a
 *  refusal, which has no number. */
export function cockpitDisplay<T>(
  amount: CockpitAmount,
  consume: (major: number, marker: AmountMarker) => T,
): T | null {
  if (amount.minor === null) return null;
  const minor = amount.minor as unknown as number;
  return consume(minor / 100, { projected: amount.kind === "projected", period: amount.period });
}

/** THE ONE DOOR to a chart coordinate: the served minor units, for pixels
 *  only (nothing a reader reads is printed from it). */
export function cockpitPlot(amount: CockpitAmount): number | null {
  return amount.minor === null ? null : (amount.minor as unknown as number);
}

/** An ACTUAL of the book the engine serves as bare minor units (the bank
 *  export's assumptions page: a cost pool's base, the cash floor), read
 *  through the same opaque type. Anything but an integer is a refusal. */
export function bookAmount(minor: unknown, period: string): CockpitAmount {
  return typeof minor === "number" && Number.isInteger(minor)
    ? { kind: "actual", period, minor: minor as unknown as CockpitMinor, refusal: null }
    : { kind: "actual", period, minor: null, refusal: { ro: "nu este servit", en: "not served" } };
}

/** The sign of a served amount: -1, 0, 1, or null for a refusal. */
export function cockpitSign(amount: CockpitAmount): -1 | 0 | 1 | null {
  const v = cockpitPlot(amount);
  return v === null ? null : v < 0 ? -1 : v > 0 ? 1 : 0;
}

// ── the view ─────────────────────────────────────────────────────────────

export type LeverUnit = "pct" | "days";

export interface CockpitLever {
  readonly id: string;
  readonly group: "primary" | "more";
  readonly unit: LeverUnit;
  readonly shape: "per_year" | "scalar";
  readonly label: Bilingual;
  /** The lever's FIXED decimal scale — the pack's `decimals`, served on
   *  every lever of every answer (engine gate F10). Read from the payload,
   *  never derived from a value's decimals: the same lever has the same
   *  scale in every answer of a session. */
  readonly decimals: number;
  /** Slider ticks per unit: 10^decimals. */
  readonly scale: number;
  /** The served range in TICKS at `scale` (min, max and step are exact at
   *  the lever's decimals: every tick is a value the engine accepts back). */
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** The value in force for plan year one — the exact decimal the engine
   *  serves (the wire form; a position is the same kind of string, and it
   *  may carry more decimals than the step: a measured growth of six
   *  decimals on a 0.001 slider); null when
   *  the book cannot measure the lever and nothing set it. */
  readonly value: string | null;
  /** The value in force differs by plan year (a dated path, e.g. the BNR's
   *  projected inflation). */
  readonly path: boolean;
  /** The ENGINE's own display of the value in force, per language. */
  readonly display: Bilingual | null;
  readonly origin: "default" | "case" | "user";
  readonly isDefault: boolean;
  /** Beneath the slider: what the value stands on, per language. */
  readonly basis: Bilingual;
  readonly measured: boolean;
  /** Why a move of this lever reaches nothing on this book, when it does not. */
  readonly inert: Bilingual | null;
  /** Why this lever cannot be moved on this book; the slider is disabled. */
  readonly locked: string | null;
}

export interface CockpitCase {
  readonly id: string;
  readonly label: Bilingual;
  readonly basis: Bilingual;
  /** The case's own lever set, as the engine serves it (exact decimals, one
   *  per plan year): what "save my case" stores beneath the reader's moves. */
  readonly levers: Readonly<Record<string, readonly string[]>>;
}

export type CashNumber =
  | { readonly kind: "min_cash"; readonly amount: Bilingual; readonly when: Bilingual; readonly note: Bilingual | null }
  | {
      readonly kind: "funding_need";
      readonly amount: Bilingual;
      readonly when: Bilingual;
      readonly interest: Bilingual;
      readonly firstPeriod: string;
      /** How finely the ENGINE knows the first draw: "monthly" (a month of
       *  plan year one) or "annual" (a later year — the plan is monthly only
       *  in year one, so the draw is known to the year, never to a month). */
      readonly firstGranularity: string;
    };

export type DscrNumber =
  | {
      readonly kind: "served";
      readonly period: string;
      readonly value: Bilingual;
      readonly threshold: Bilingual;
      /** The ENGINE's verdict; the page never compares the two numbers. */
      readonly below: boolean;
      readonly formula: Bilingual | null;
    }
  | { readonly kind: "not_applicable"; readonly period: string; readonly formula: Bilingual | null };

export interface ChartBar {
  readonly period: string;
  readonly amount: CockpitAmount;
}

export interface ChartCashPoint {
  readonly period: string;
  readonly granularity: string;
  readonly cash: CockpitAmount;
  readonly cashBeforeFunding: CockpitAmount;
  readonly fundingLine: CockpitAmount;
  /** The ENGINE's own flag: cash would have gone below zero here before the
   *  funding line caught it. */
  readonly gap: boolean;
}

export interface BridgeStep {
  readonly id: string;
  readonly label: Bilingual;
  readonly subtotal: boolean;
  readonly total: boolean;
  readonly amount: CockpitAmount;
}

export interface CockpitBridge {
  readonly window: string;
  readonly period: string;
  readonly sumsExactly: boolean;
  readonly steps: readonly BridgeStep[];
}

export interface StatementRow {
  readonly line: string;
  readonly label: Bilingual;
  readonly year0: CockpitAmount | null;
  readonly values: readonly CockpitAmount[];
}

export interface CockpitStatements {
  readonly years: readonly string[];
  readonly pl: readonly StatementRow[];
  readonly bs: readonly StatementRow[];
  readonly cf: readonly StatementRow[];
}

export interface CockpitView {
  readonly version: typeof COCKPIT_VERSION;
  readonly currency: string;
  readonly companyName: string | null;
  readonly basePeriodLabel: string;
  readonly years: readonly string[];
  readonly caseId: string;
  readonly caseLabel: Bilingual;
  readonly caseModified: boolean;
  readonly cases: readonly CockpitCase[];
  readonly levers: readonly CockpitLever[];
  readonly numbers: {
    readonly ebitda: {
      readonly period: string;
      readonly amount: Bilingual;
      readonly margin: Bilingual | null;
      readonly marginYear0: Bilingual | null;
    };
    readonly fcf: { readonly from: string; readonly to: string; readonly amount: Bilingual; readonly formula: Bilingual | null };
    readonly cash: CashNumber;
    readonly dscr: DscrNumber;
  };
  readonly sentence: Bilingual;
  readonly chart: {
    readonly ebitda: readonly ChartBar[];
    readonly cash: readonly ChartCashPoint[];
    readonly fundingGap: boolean;
  };
  readonly bridge: { readonly yearOne: CockpitBridge | null; readonly horizon: CockpitBridge | null };
  readonly statements: CockpitStatements;
  readonly conventions: readonly { id: string; sentence: string }[];
  readonly notModelled: readonly { id: string; sentence: string }[];
  readonly fundingLine: { readonly pricedAt: string; readonly referenceBasis: Bilingual | null } | null;
  readonly recomputeMs: number | null;
  readonly debounceMs: number;
  readonly bodyHash: string | null;
}

// ── reading ──────────────────────────────────────────────────────────────

type Raw = Record<string, unknown>;

const rec = (x: unknown): Raw | null =>
  typeof x === "object" && x !== null && !Array.isArray(x) ? (x as Raw) : null;
const str = (x: unknown): string => (typeof x === "string" ? x : "");
const int = (x: unknown): number | null =>
  typeof x === "number" && Number.isInteger(x) ? x : null;
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);

/** {ro, en} (or a bare served string, read the same in both languages). */
function bilingual(x: unknown): Bilingual | null {
  const r = rec(x);
  if (r && (typeof r.ro === "string" || typeof r.en === "string")) {
    return { ro: str(r.ro) || str(r.en), en: str(r.en) || str(r.ro) };
  }
  if (r && typeof r.text === "string") return { ro: r.text, en: r.text };
  const s = str(x);
  return s ? { ro: s, en: s } : null;
}

const EMPTY: Bilingual = { ro: "", en: "" };

export class CockpitContractError extends Error {}

function need(cond: boolean, what: string): void {
  if (!cond) {
    throw new CockpitContractError(
      `forecastCockpit: the served cockpit breaks its own contract — ${what}. ` +
        `A payload that claims to be the cockpit and is not whole paints nothing.`,
    );
  }
}

/** One served amount block ({kind, amount_minor} or {kind, refused}). */
function amountOf(raw: unknown, period: string, fallbackKind: "projected" | "actual" = "projected"): CockpitAmount {
  const r = rec(raw);
  const kind = r?.kind === "actual" ? "actual" : r?.kind === "projected" ? "projected" : fallbackKind;
  const minor = r ? int(r.amount_minor) : null;
  if (minor === null) {
    const refused = rec(r?.refused);
    return {
      kind,
      period,
      minor: null,
      refusal: bilingual(refused?.text) ?? { ro: "nu este servit", en: "not served" },
    };
  }
  return { kind, period, minor: minor as unknown as CockpitMinor, refusal: null };
}

/** A decimal string's count of fraction digits ("0.0005" → 4); -1 when it
 *  is not a decimal at all. Never a lever's scale: that is served. */
function fractionDigits(d: string): number {
  const m = /^-?\d+(?:\.(\d+))?$/.exec(d);
  return m ? (m[1] ?? "").length : -1;
}

function readLever(raw: unknown): CockpitLever {
  const l = rec(raw);
  need(!!l, "a lever is not an object");
  const r = l as Raw;
  const id = str(r.id);
  need(id.length > 0, "a lever carries no id");
  const unit = str(r.unit) as LeverUnit;
  need(unit === "pct" || unit === "days", `lever ${id} has unit ${JSON.stringify(r.unit)}`);
  // THE SCALE IS SERVED, and it is the same in every answer: the pack's
  // `decimals` on the lever. Never the decimals of min/max/step/value — a
  // scale derived from an answer changes with the answer (the 2026-09-26
  // repro), and a position held in ticks is then re-read at another scale.
  const decimals = int(r.decimals);
  need(decimals !== null && decimals >= 0 && decimals <= 12, `lever ${id} states no decimal scale`);
  const scale = Number(`1${"0".repeat(decimals)}`);
  const range = rec(r.range) ?? {};
  const served = [str(range.min), str(range.max), str(range.step)];
  const min = ticksOf(served[0], scale);
  const max = ticksOf(served[1], scale);
  const step = ticksOf(served[2], scale);
  need(
    min !== null && max !== null && step !== null && step > 0 && min <= max,
    `lever ${id} has no range exact at ${decimals} decimals (${served.join(" / ")})`,
  );
  const values = Array.isArray(r.value) ? r.value.map(str) : r.value === null || r.value === undefined ? [] : [str(r.value)];
  need(values.every((d) => fractionDigits(d) >= 0), `lever ${id} has a value that is not a decimal`);
  const first = values.length > 0 ? values[0] : null;
  const origin = str(r.origin);
  const lockedRaw = r.locked;
  const locked =
    lockedRaw === null || lockedRaw === undefined
      ? null
      : str(rec(lockedRaw)?.text) || str(lockedRaw) || "locked";
  return {
    id,
    group: r.group === "more" ? "more" : "primary",
    unit,
    shape: r.shape === "scalar" ? "scalar" : "per_year",
    label: bilingual(r.label) ?? { ro: id, en: id },
    decimals,
    scale,
    min: min as number,
    max: max as number,
    step: step as number,
    value: first,
    path: new Set(values).size > 1,
    display: bilingual(r.display),
    origin: origin === "case" || origin === "user" ? origin : "default",
    isDefault: r.is_default === true,
    basis: bilingual(r.basis) ?? EMPTY,
    measured: r.measured !== false,
    inert: bilingual(r.inert),
    locked,
  };
}

function readBridge(raw: unknown): CockpitBridge | null {
  const r = rec(raw);
  if (!r) return null;
  const period = str(r.period);
  return {
    window: str(r.window),
    period,
    sumsExactly: r.sums_exactly === true,
    steps: arr(r.steps).flatMap((s) => {
      const x = rec(s);
      if (!x) return [];
      return [
        {
          id: str(x.id),
          label: bilingual(x.label) ?? EMPTY,
          subtotal: x.subtotal === true,
          total: x.total === true,
          amount: amountOf(x.figure, period),
        },
      ];
    }),
  };
}

function readRows(raw: unknown, years: readonly string[]): StatementRow[] {
  const planYears = years.slice(1);
  return arr(raw).flatMap((row) => {
    const r = rec(row);
    if (!r) return [];
    const byPeriod = new Map<string, unknown>();
    for (const v of arr(r.values)) {
      const x = rec(v);
      if (x) byPeriod.set(str(x.period), x);
    }
    const y0 = rec(r.year0);
    return [
      {
        line: str(r.line),
        label: bilingual(r.label) ?? { ro: str(r.line), en: str(r.line) },
        year0: y0 ? amountOf(y0, str(y0.period) || years[0] || "", "actual") : null,
        values: planYears.map((p) => amountOf(byPeriod.get(p), p)),
      },
    ];
  });
}

/** The cockpit over one served payload, or `null` when the payload is not a
 *  cockpit (it carries no `cockpit_version`). */
export function readCockpit(payload: unknown): CockpitView | null {
  const root = rec(payload);
  if (!root || root.cockpit_version === undefined) return null;
  need(root.cockpit_version === COCKPIT_VERSION,
    `version ${JSON.stringify(root.cockpit_version)}; this reader speaks ${COCKPIT_VERSION}`);

  const base = rec(root.base_period) ?? {};
  const horizon = rec(root.horizon) ?? {};
  const years = arr(horizon.years).map(str);
  need(years.length > 0, "the horizon names no plan year");
  const caseRaw = rec(root.case) ?? {};
  const numbers = rec(root.numbers) ?? {};
  const lang2 = (display: unknown, key: string): Bilingual | null => {
    const d = rec(display);
    if (!d) return null;
    const ro = rec(d.ro);
    const en = rec(d.en);
    const a = ro ? str(ro[key]) : "";
    const b = en ? str(en[key]) : "";
    return a || b ? { ro: a || b, en: b || a } : null;
  };

  const ebitdaRaw = rec(numbers.ebitda_final_year) ?? {};
  const ebitdaAmount = lang2(ebitdaRaw.display, "amount");
  need(!!ebitdaAmount, "the final-year EBITDA carries no display");

  const fcfRaw = rec(numbers.cumulative_fcf) ?? {};
  const fcfAmount = bilingual(fcfRaw.display);
  need(!!fcfAmount, "the cumulative free cash flow carries no display");

  const cashRaw = rec(numbers.cash) ?? {};
  const cashKind = str(cashRaw.kind);
  need(cashKind === "min_cash" || cashKind === "funding_need", `numbers.cash.kind is ${JSON.stringify(cashRaw.kind)}`);
  const cash: CashNumber =
    cashKind === "funding_need"
      ? {
          kind: "funding_need",
          amount: lang2(cashRaw.display, "amount") ?? EMPTY,
          when: lang2(cashRaw.display, "when") ?? EMPTY,
          interest: lang2(cashRaw.display, "interest") ?? EMPTY,
          firstPeriod: str(cashRaw.first_period),
          firstGranularity: str(cashRaw.first_granularity),
        }
      : {
          kind: "min_cash",
          amount: lang2(cashRaw.display, "amount") ?? EMPTY,
          when: lang2(cashRaw.display, "when") ?? EMPTY,
          note: bilingual(cashRaw.granularity_note),
        };

  const dscrRaw = rec(numbers.dscr_year_one) ?? {};
  const dscrStatus = str(dscrRaw.status);
  need(["above", "below", "not_applicable"].includes(dscrStatus), `numbers.dscr_year_one.status is ${JSON.stringify(dscrRaw.status)}`);
  const dscr: DscrNumber =
    dscrStatus === "not_applicable"
      ? { kind: "not_applicable", period: str(dscrRaw.period), formula: bilingual(dscrRaw.formula) }
      : {
          kind: "served",
          period: str(dscrRaw.period),
          value: lang2(dscrRaw.display, "value") ?? EMPTY,
          threshold: lang2(dscrRaw.display, "threshold") ?? EMPTY,
          below: dscrStatus === "below",
          formula: bilingual(dscrRaw.formula),
        };

  const chartRaw = rec(root.chart) ?? {};
  const statementsRaw = rec(root.statements) ?? {};
  const statementYears = arr(statementsRaw.years).map(str);
  const bridgeRaw = rec(root.bridge) ?? {};
  const fundingRaw = rec(root.funding_line);
  const client = rec(root.client) ?? {};
  const levers = arr(root.levers).map(readLever);
  need(levers.length > 0, "no lever is served");

  return {
    version: COCKPIT_VERSION,
    currency: str(root.currency) || "RON",
    companyName: str(root.company_name) || null,
    basePeriodLabel: str(base.label),
    years,
    caseId: str(caseRaw.id) || BASE_CASE_ID,
    caseLabel: bilingual(caseRaw.label) ?? { ro: str(caseRaw.id), en: str(caseRaw.id) },
    caseModified: caseRaw.modified === true,
    cases: arr(root.cases).flatMap((c) => {
      const x = rec(c);
      if (!x || !str(x.id)) return [];
      const lv: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(rec(x.levers) ?? {})) {
        lv[k] = Array.isArray(v) ? v.map(str) : [str(v)];
      }
      return [{ id: str(x.id), label: bilingual(x.label) ?? { ro: str(x.id), en: str(x.id) }, basis: bilingual(x.basis) ?? EMPTY, levers: lv }];
    }),
    levers,
    numbers: {
      ebitda: {
        period: str(ebitdaRaw.period),
        amount: ebitdaAmount as Bilingual,
        margin: lang2(ebitdaRaw.display, "margin"),
        marginYear0: lang2(ebitdaRaw.display, "margin_year0"),
      },
      fcf: {
        from: str(fcfRaw.from),
        to: str(fcfRaw.to),
        amount: fcfAmount as Bilingual,
        formula: bilingual(fcfRaw.formula),
      },
      cash,
      dscr,
    },
    sentence: bilingual(root.sentence) ?? EMPTY,
    chart: {
      ebitda: arr(chartRaw.ebitda).flatMap((p) => {
        const x = rec(p);
        return x ? [{ period: str(x.period), amount: amountOf(x, str(x.period)) }] : [];
      }),
      cash: arr(chartRaw.cash).flatMap((p) => {
        const x = rec(p);
        if (!x) return [];
        const period = str(x.period);
        const kind = x.kind === "actual" ? "actual" : "projected";
        const at = (key: string) =>
          amountOf({ kind, amount_minor: x[key] }, period, kind);
        return [
          {
            period,
            granularity: str(x.granularity),
            cash: at("cash_minor"),
            cashBeforeFunding: at("cash_before_funding_minor"),
            fundingLine: at("funding_line_minor"),
            gap: x.gap === true,
          },
        ];
      }),
      fundingGap: chartRaw.funding_gap === true,
    },
    bridge: { yearOne: readBridge(bridgeRaw.year_one), horizon: readBridge(bridgeRaw.horizon) },
    statements: {
      years: statementYears,
      pl: readRows(statementsRaw.pl, statementYears),
      bs: readRows(statementsRaw.bs, statementYears),
      cf: readRows(statementsRaw.cf, statementYears),
    },
    conventions: arr(root.conventions).flatMap((c) => {
      const x = rec(c);
      const s = x ? str(x.sentence) || str(rec(x.sentence)?.text) : "";
      return x && s ? [{ id: str(x.id), sentence: s }] : [];
    }),
    notModelled: arr(root.not_modelled).flatMap((c) => {
      const x = rec(c);
      const s = x ? str(x.sentence) || str(rec(x.sentence)?.text) : "";
      return x && s ? [{ id: str(x.id), sentence: s }] : [];
    }),
    fundingLine: fundingRaw
      ? {
          pricedAt: str(fundingRaw.priced_at),
          referenceBasis: bilingual(rec(fundingRaw.reference)?.basis),
        }
      : null,
    recomputeMs: int(root.recompute_ms),
    debounceMs: int(client.debounce_ms) ?? SPEC_DEBOUNCE_MS,
    bodyHash: str(rec(root.pins)?.body_hash) || null,
  };
}

// ── the request ──────────────────────────────────────────────────────────

/** Slider positions the reader moved: lever id → the exact decimal the wire
 *  carries (`leverDecimal`, at the lever's fixed scale). A position is never
 *  a tick count: ticks are derived at render (`leverTicks`) from a scale that
 *  is served, so no answer can re-interpret a position. */
export type LeverPositions = Readonly<Record<string, string>>;

export interface CockpitRequest {
  /** An engine case id, or "saved:<id>". */
  readonly caseId: string;
  readonly levers: LeverPositions;
}

/** The wire body of one cockpit request. Keys sorted, values the exact
 *  decimals the positions already are — the same request is always the same
 *  bytes, and the same bytes are the same projection (gate F3). */
export function cockpitRequestBody(request: CockpitRequest): { case_id: string; levers: Record<string, string> } {
  const levers: Record<string, string> = {};
  for (const id of Object.keys(request.levers).sort()) {
    const decimal = request.levers[id];
    if (fractionDigits(decimal) < 0) continue; // not a decimal: never sent
    levers[id] = decimal;
  }
  return { case_id: request.caseId, levers };
}

/** The request identity: case + moved levers, canonical. */
export function cockpitRequestKey(request: CockpitRequest): string {
  const keys = Object.keys(request.levers).sort();
  return JSON.stringify([request.caseId, keys.map((k) => [k, request.levers[k]])]);
}

/** A slider moved to `decimal` (the wire form, from `leverDecimal`). Reset
 *  (`null`) DROPS the lever rather than sending the case's value, so the
 *  request is exactly the case — which is what makes "reset" land on the
 *  case byte for byte (gate F4). */
export function withLever(
  positions: LeverPositions,
  lever: Pick<CockpitLever, "id">,
  decimal: string | null,
): LeverPositions {
  const next: Record<string, string> = { ...positions };
  if (decimal === null) delete next[lever.id];
  else next[lever.id] = decimal;
  return next;
}

/** A slider position (ticks at the lever's fixed scale) as the exact decimal
 *  the wire carries — THE ONE WAY a position is made. */
export function leverDecimal(lever: Pick<CockpitLever, "scale">, ticks: number): string {
  return exactDecimal(ticks, lever.scale);
}

/** A decimal as TICKS at the lever's fixed scale, for the thumb: exact when
 *  the decimal is representable there (a reader's own position always is);
 *  otherwise the NEAREST tick (half up, away from zero) — the served value in
 *  force may be finer than the step (a six-decimal measured growth on a
 *  0.001 slider)
 *  and a thumb can only stand on a tick. Clamped to the lever's range. Only
 *  the thumb reads this: a request never carries the rounding, because a
 *  position IS the exact decimal and an unmoved lever is not sent at all.
 *  String arithmetic, never a float. */
export function leverTicks(lever: Pick<CockpitLever, "scale" | "min" | "max">, decimal: string): number | null {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(decimal.trim());
  if (!m) return null;
  const digits = String(lever.scale).length - 1;
  const frac = (m[3] ?? "").padEnd(digits, "0");
  let whole = Number(`${m[2]}${frac.slice(0, digits)}`);
  if (frac.length > digits && frac[digits] >= "5") whole += 1;
  if (!Number.isSafeInteger(whole)) return null;
  const signed = m[1] === "-" ? -whole : whole;
  return Math.min(lever.max, Math.max(lever.min, signed));
}

/** An exact decimal as ticks at `scale` (a power of ten), or null when it is
 *  not exactly representable there. String arithmetic, the inverse of
 *  `exactDecimal`: "0.052" at 1,000 is 52, never `Math.round(0.052 * 1e3)`. */
export function ticksOf(decimal: string, scale: number): number | null {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(decimal.trim());
  if (!m || !Number.isInteger(scale) || scale < 1) return null;
  const digits = String(scale).length - 1;
  if (`1${"0".repeat(digits)}` !== String(scale)) return null;
  const frac = m[3] ?? "";
  if (/[1-9]/.test(frac.slice(digits))) return null;
  const whole = Number(`${m[2]}${frac.padEnd(digits, "0").slice(0, digits)}`);
  if (!Number.isSafeInteger(whole)) return null;
  return m[1] === "-" && whole !== 0 ? -whole : whole;
}
