// THE CAPSULE — RETRIEVAL BEFORE GENERATION.
//
// The model never sees a question until this module has already decided
// which READ-ONLY tools answer it and collected what they returned. That
// ordering is the whole safety story of the surface:
//
//   · the model is handed FACTS, never files, never a database handle;
//   · the tools it could reach are the eight allowlisted reads in
//     `engine/api/_capsule_tools.py` — and the plan is built HERE, by
//     keyword tables, so the model does not even choose them;
//   · a question nothing matches produces an EMPTY plan, which produces
//     empty evidence, which the generator is told to answer by naming
//     what is missing. Nothing is invented to fill the hole.
//
// The planner is pure: (question, context) -> steps. No fetch, no clock,
// no i18n, no storage. `runPlan` is the only side-effecting function and
// it takes its transport as an argument, so every test and the latency
// harness drive the identical code path the browser does.
//
// ── The collision that this module exists to not have ─────────────────
//
// A trend question reads ONE metric across FOUR periods. Every one of
// those calls comes back with the engine's own fact name — `revenue`,
// four times, four different values. Merging them into one
// `{{money:revenue}}` binding would silently pick a winner and render a
// figure from the wrong month under a sentence about another. `merge`
// therefore RENAMES on collision (`revenue__2`, `revenue__3`) and keeps
// the period each renamed fact came from in `factMeta`. The renamed
// names are the ones the generator is given, so a placeholder can only
// ever resolve to the period it was retrieved for.

import { foldQuery } from "@/lib/capsuleRouter";

import {
  asUnit,
  emptyEvidence,
  type CapsuleEvidence,
  type CapsuleFactMeta,
  type CapsuleToolPayload,
  type CapsuleValue,
} from "./capsuleAnswerTypes";
import type { Currency } from "@/lib/rates";

// ── the eight tools ────────────────────────────────────────────────────

export const TOOL_GET_FACTS = "get_facts";
export const TOOL_COMPARE_PERIODS = "compare_periods";
export const TOOL_GET_ACCOUNT = "get_account";
export const TOOL_LIST_FINDINGS = "list_findings";
export const TOOL_GET_BENCHMARK = "get_benchmark";
export const TOOL_RUN_SCENARIO_PREVIEW = "run_scenario_preview";
export const TOOL_GET_PUBLIC_COMPANY = "get_public_company";
export const TOOL_SEARCH_HELP = "search_help";

export const CAPSULE_TOOLS: readonly string[] = Object.freeze([
  TOOL_GET_FACTS,
  TOOL_COMPARE_PERIODS,
  TOOL_GET_ACCOUNT,
  TOOL_LIST_FINDINGS,
  TOOL_GET_BENCHMARK,
  TOOL_RUN_SCENARIO_PREVIEW,
  TOOL_GET_PUBLIC_COMPANY,
  TOOL_SEARCH_HELP,
]);

/** Hard cap per turn. Latency and spend are both linear in this number,
 *  and no honest question needs more reads than this. */
export const MAX_STEPS = 6;

/** How many periods a trend question walks. Four points is the smallest
 *  series where a sparkline says something a delta chip does not. */
export const TREND_POINTS = 4;

// ── the rules (DATA — EN + RO, folded) ─────────────────────────────────

/** Metric name -> folded phrases that name it. Longest phrase wins, so
 *  "current assets" cannot be eaten by "assets". */
export const METRIC_PHRASES: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    total_assets: ["total assets", "active totale", "total activ", "activ total",
      "assets", "active", "activ"],
    total_liabilities: ["total liabilities", "datorii totale", "total datorii",
      "liabilities", "datorii"],
    equity: ["equity", "capitaluri proprii", "capital propriu", "capitaluri",
      "net worth", "avere neta"],
    equity_plus_liabilities: ["equity plus liabilities", "pasiv total",
      "total pasiv", "pasive"],
    current_assets: ["current assets", "active circulante", "circulante"],
    current_liabilities: ["current liabilities", "datorii curente",
      "datorii pe termen scurt", "termen scurt"],
    working_capital: ["working capital", "capital de lucru",
      "fond de rulment"],
    net_result: ["net result", "net profit", "net income", "profit net",
      "rezultat net", "rezultatul net", "profit", "pierdere", "rezultat"],
    revenue: ["net turnover", "turnover", "revenue", "sales", "top line",
      "cifra de afaceri", "venituri", "vanzari", "incasari"],
    expenses: ["expenses", "costs", "cost base", "cheltuieli", "costuri"],
    ebitda: ["ebitda"],
    difference: ["difference", "imbalance", "diferenta", "dezechilibru"],
    current_ratio: ["current ratio", "lichiditate curenta", "lichiditatea",
      "lichiditate"],
    equity_ratio: ["equity ratio", "rata capitalului", "solvabilitate",
      "capitalizare"],
    net_margin: ["net margin", "marja neta", "marja"],
  });

/** Ratio metrics — the ones the engine computes on native operands. */
export const RATIO_METRICS: readonly string[] = Object.freeze([
  "current_ratio", "equity_ratio", "net_margin",
]);

export const COMPARE_TOKENS: readonly string[] = Object.freeze([
  " vs ", " versus ", " fata de ", " compared to ", "compare", "compara",
  "year over year", "yoy", "an la an", "vs.", "against last",
  "fata de anul", "versus last",
]);

export const TREND_TOKENS: readonly string[] = Object.freeze([
  "trend", "over time", "evolution", "evolutie", "istoric", "history",
  "last months", "ultimele luni", "in timp", "de la o luna la alta",
  "month over month",
]);

export const FINDINGS_TOKENS: readonly string[] = Object.freeze([
  "finding", "findings", "anomal", "anomalii", "risk", "risks", "riscuri",
  "issues", "probleme", "alert", "alerte", "radar", "in neregula",
  "what is wrong", "ce nu e in regula", "red flag", "semnale",
]);

export const BENCHMARK_TOKENS: readonly string[] = Object.freeze([
  "benchmark", "peer", "peers", "industry", "industrie", "sector",
  "competitors", "concurenta", "media pietei", "percentile", "percentila",
]);

export const SCENARIO_TOKENS: readonly string[] = Object.freeze([
  "what if", "ce ar fi", "scenario", "scenariu", "simulate", "simulare",
  "daca ar", "daca scade", "daca creste", "if revenue", "if expenses",
]);

export const HELP_TOKENS: readonly string[] = Object.freeze([
  "how do i", "how can i", "cum pot", "cum fac", "where is", "where do i",
  "unde gasesc", "unde este", "help", "ajutor", "how to", "cum sa",
]);

/** Deliberately PHRASES, not words. "overall" or "health" on their own
 *  fire on "what is a good gross margin overall", which is an
 *  open-domain question and must plan nothing — a rule that grounds
 *  itself without the reader naming a metric has to be sure it is being
 *  asked about THIS company. */
export const HEALTH_TOKENS: readonly string[] = Object.freeze([
  "how are we doing", "how are we", "how is the company", "how is business",
  "overall health", "health check", "big picture", "summary", "rezumat",
  "cum stam", "cum merge", "cum mergem", "situatia firmei", "stare generala",
  "sanatate financiara",
]);

/** Metrics a bare "how are we doing" grounds itself in. */
export const HEALTH_METRICS: readonly string[] = Object.freeze([
  "revenue", "net_result", "equity", "total_assets",
]);

/** `cont 461`, `account 5121`, or a bare 3–8 digit run. Mirrors the
 *  router's `entity.account` rule so one shape means one thing. */
const ACCOUNT_RE = /(?:^|\s)(?:cont(?:ul)?|account|acc)?\s*([0-9]{3,8})(?=\s|$)/g;

/** "revenue drops 10%", "daca cheltuielile cresc cu 5%". Deliberately
 *  narrow: an unparsable what-if plans NO scenario call rather than a
 *  guessed one. */
const SCENARIO_RE =
  /(revenue|venituri|cifra de afaceri|expenses|cheltuieli|costuri)[^0-9%]{0,32}?(\d{1,3})\s*%/;
const SCENARIO_DOWN =
  /(drop|fall|down|decline|lower|scade|scad|reduce|mai putin|minus|-)/;

// ── the plan ───────────────────────────────────────────────────────────

export interface CapsulePlanStep {
  /** Stable within a plan — the trace list keys off it. */
  id: string;
  tool: string;
  args: Record<string, unknown>;
  /** Body-level period hint; the engine loads detail for this one. */
  period: string | null;
  /** i18n key + params for the retrieval trace line. */
  traceKey: string;
  traceParams: Record<string, string>;
}

export interface RetrievalContext {
  periodId?: string | null;
  periodLabel?: string | null;
  /** Newest first, exactly as `usePeriodStepper` serves them. */
  periods?: readonly { id: string; label: string }[];
  tickers?: readonly string[];
  peerGroup?: string | null;
}

function trace(tool: string, params: Record<string, string> = {}) {
  return { traceKey: `capsuleAnswer.trace.${tool}`, traceParams: params };
}

function hasAny(folded: string, tokens: readonly string[]): boolean {
  const padded = ` ${folded} `;
  return tokens.some((tk) =>
    tk.startsWith(" ") || tk.endsWith(" ") ? padded.includes(tk) : folded.includes(tk),
  );
}

/** Metrics the question names, in the order the tables declare them
 *  (deterministic, not query order — two spellings of the same metric
 *  must not produce two calls). */
export function matchMetrics(folded: string): string[] {
  const out: string[] = [];
  for (const metric of Object.keys(METRIC_PHRASES)) {
    const phrases = METRIC_PHRASES[metric];
    if (phrases.some((p) => folded.includes(p))) out.push(metric);
  }
  return out;
}

export function matchAccounts(folded: string): string[] {
  const out: string[] = [];
  ACCOUNT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ACCOUNT_RE.exec(folded)) !== null) {
    // A 4-digit run that reads as a year is a period label, not an
    // account code — "revenue in 2025" must not open account 2025.
    if (/^(19|20)\d{2}$/.test(m[1])) continue;
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** Period labels the question names, resolved against the known list.
 *  Returns newest-first ids, capped at two. */
export function matchPeriods(
  folded: string,
  periods: readonly { id: string; label: string }[],
): { id: string; label: string }[] {
  const hits: { id: string; label: string }[] = [];
  for (const p of periods) {
    const foldedLabel = foldQuery(p.label);
    if (!foldedLabel) continue;
    if (folded.includes(foldedLabel)) hits.push(p);
    if (hits.length >= 2) break;
  }
  return hits;
}

export function matchScenario(
  folded: string,
): { metric: string; mode: "pct"; value: number } | null {
  const m = SCENARIO_RE.exec(folded);
  if (!m) return null;
  const raw = m[1];
  const metric =
    raw === "expenses" || raw === "cheltuieli" || raw === "costuri"
      ? "expenses"
      : "revenue";
  const magnitude = Number(m[2]);
  if (!Number.isFinite(magnitude) || magnitude === 0) return null;
  const down = SCENARIO_DOWN.test(folded.slice(0, m.index + m[0].length));
  return { metric, mode: "pct", value: down ? -magnitude : magnitude };
}

/**
 * The plan. Pure, capped, and deliberately conservative: a rule fires
 * only on an explicit signal, and an unmatched question plans nothing at
 * all rather than guessing a read.
 */
export function planRetrieval(
  question: string,
  ctx: RetrievalContext = {},
): CapsulePlanStep[] {
  const folded = foldQuery(question);
  if (!folded) return [];

  const periods = ctx.periods ?? [];
  const periodHint = ctx.periodId ?? null;
  const periodLabel = ctx.periodLabel ?? "";
  const steps: CapsulePlanStep[] = [];
  const push = (
    tool: string,
    args: Record<string, unknown>,
    period: string | null,
    params: Record<string, string> = {},
  ) => {
    if (steps.length >= MAX_STEPS) return;
    steps.push({
      id: `${tool}:${steps.length}`,
      tool,
      args,
      period,
      ...trace(tool, params),
    });
  };

  // 1. A "how do I…" is a product question, not a figures question. It
  //    reads the help catalogue and nothing else — grounding it in the
  //    balance sheet would be noise with a latency cost.
  if (hasAny(folded, HELP_TOKENS)) {
    push(TOOL_SEARCH_HELP, { topic: question.trim() }, null);
    return steps;
  }

  const metrics = matchMetrics(folded);

  // 2. Shapes first — an account code or a ticker is an unambiguous read.
  for (const code of matchAccounts(folded).slice(0, 2)) {
    push(TOOL_GET_ACCOUNT, { code, period: periodHint ?? undefined }, periodHint,
      { code, period: periodLabel });
  }
  const ticker = matchTicker(question, ctx.tickers);
  if (ticker) push(TOOL_GET_PUBLIC_COMPANY, { entity: ticker }, null, { entity: ticker });

  // 3. What-if — only when the driver AND its magnitude both parse.
  const scenario = matchScenario(folded);
  if (scenario) {
    push(
      TOOL_RUN_SCENARIO_PREVIEW,
      {
        drivers: [{ metric: scenario.metric, mode: scenario.mode, value: scenario.value }],
        period: periodHint ?? undefined,
      },
      periodHint,
      { period: periodLabel },
    );
  }

  // 4. Two periods, one metric set — the comparison the engine will
  //    refuse itself when the alignment rules do not hold.
  const named = matchPeriods(folded, periods);
  const wantsCompare = hasAny(folded, COMPARE_TOKENS) || named.length >= 2;
  if (wantsCompare && periods.length >= 2) {
    const pair = named.length >= 2 ? named.slice(0, 2) : periods.slice(0, 2);
    // `p1` is the EARLIER side of the delta; the list is newest-first.
    const [later, earlier] = pair;
    push(
      TOOL_COMPARE_PERIODS,
      {
        metrics: (metrics.length ? metrics : ["revenue", "net_result"]).slice(0, 3),
        p1: earlier.id,
        p2: later.id,
      },
      later.id,
      { from: earlier.label, to: later.label },
    );
  }

  // 5. A trend needs points, not a delta — one metric read on N periods.
  const wantsTrend = hasAny(folded, TREND_TOKENS);
  if (wantsTrend && periods.length >= 3) {
    const metric = metrics[0] ?? "revenue";
    const series = periods.slice(0, TREND_POINTS).slice().reverse(); // oldest → newest
    for (const p of series) {
      push(TOOL_GET_FACTS, { metric, period: p.id }, p.id,
        { metric, period: p.label });
    }
  }

  // 6. Findings / benchmark.
  if (hasAny(folded, FINDINGS_TOKENS)) {
    push(TOOL_LIST_FINDINGS, { period: periodHint ?? undefined }, periodHint,
      { period: periodLabel });
  }
  if (hasAny(folded, BENCHMARK_TOKENS) && ctx.peerGroup) {
    push(TOOL_GET_BENCHMARK,
      { peer_group: ctx.peerGroup, metric: metrics[0] ?? "net_margin" }, null,
      { metric: metrics[0] ?? "net_margin" });
  }

  // 7. Plain metric reads — skipped when a compare or a trend already
  //    covers the same metric, so one question never pays twice.
  const covered = new Set<string>();
  for (const s of steps) {
    if (s.tool === TOOL_COMPARE_PERIODS) {
      for (const m of (s.args.metrics as string[]) ?? []) covered.add(m);
    }
    if (s.tool === TOOL_GET_FACTS) covered.add(String(s.args.metric));
  }
  for (const metric of metrics) {
    if (covered.has(metric)) continue;
    push(TOOL_GET_FACTS, { metric, period: periodHint ?? undefined }, periodHint,
      { metric, period: periodLabel });
  }

  // 8. "How are we doing" — the only rule that grounds itself without
  //    the user naming a metric, and only when nothing else fired.
  if (steps.length === 0 && hasAny(folded, HEALTH_TOKENS)) {
    for (const metric of HEALTH_METRICS) {
      push(TOOL_GET_FACTS, { metric, period: periodHint ?? undefined }, periodHint,
        { metric, period: periodLabel });
    }
    push(TOOL_LIST_FINDINGS, { period: periodHint ?? undefined }, periodHint,
      { period: periodLabel });
  }

  return steps;
}

/** An uppercase token that looks like a ticker AND is one the host knows.
 *  Without the host list we refuse — "VAT" is not a listed company. */
export function matchTicker(
  raw: string,
  known: readonly string[] | undefined,
): string | null {
  if (!known || known.length === 0) return null;
  const upper = new Set(known.map((tk) => tk.toUpperCase()));
  for (const token of raw.split(/[^A-Za-z0-9.]+/)) {
    if (token.length < 2) continue;
    if (token !== token.toUpperCase()) continue;
    if (upper.has(token.toUpperCase())) return token.toUpperCase();
  }
  return null;
}

// ── running the plan ───────────────────────────────────────────────────

/** The transport a plan runs over. One function, injected — the browser
 *  passes the engine client, tests and the latency harness pass a
 *  fixture. There is no other way for this module to reach the network. */
export type ToolTransport = (
  step: CapsulePlanStep,
  signal?: AbortSignal,
) => Promise<CapsuleToolPayload>;

export interface RunPlanResult {
  evidence: CapsuleEvidence;
  /** Per-step outcome, in plan order — drives the retrieval trace. */
  outcomes: { step: CapsulePlanStep; ok: boolean; error?: unknown }[];
}

/**
 * Execute the plan and merge what came back.
 *
 * Steps run in PARALLEL (they are independent reads) but merge in PLAN
 * ORDER, because the merge renames on collision and a rename that
 * depended on network arrival order would make the same question bind
 * different names on different days.
 *
 * A step that throws does not fail the turn: its absence becomes a typed
 * gap, which is exactly the shape the generator already knows how to
 * report. An engine that is down therefore degrades to "here is what I
 * could not read", never to a raw payload on screen (A2).
 */
export async function runPlan(
  steps: readonly CapsulePlanStep[],
  transport: ToolTransport,
  signal?: AbortSignal,
): Promise<RunPlanResult> {
  const settled = await Promise.all(
    steps.map(async (step) => {
      try {
        return { step, payload: await transport(step, signal), error: undefined as unknown };
      } catch (error) {
        return { step, payload: null as CapsuleToolPayload | null, error };
      }
    }),
  );

  const payloads: { step: CapsulePlanStep; payload: CapsuleToolPayload }[] = [];
  const outcomes: RunPlanResult["outcomes"] = [];
  for (const s of settled) {
    if (s.payload) {
      payloads.push({ step: s.step, payload: s.payload });
      outcomes.push({ step: s.step, ok: true });
    } else {
      outcomes.push({ step: s.step, ok: false, error: s.error });
    }
  }

  const evidence = mergeEvidence(payloads);
  // A read that never landed is an ABSENCE, and absence is typed here
  // the same way the engine types its own.
  for (const o of outcomes) {
    if (o.ok) continue;
    evidence.gaps.push({
      kind: "gap",
      tool: o.step.tool,
      code: "tool_unreachable",
      missing: [o.step.tool],
      detail: "",
      fix: "",
      upsell_key: "",
    });
  }
  return { evidence, outcomes };
}

// ── merge ──────────────────────────────────────────────────────────────

export function digitTokens(source: string | null | undefined): string[] {
  if (!source) return [];
  return source.match(/[\p{L}]*\d[\p{L}\d./-]*/gu) ?? [];
}

/** Pick a free binding name. Deterministic: the same payload order
 *  always yields the same names.
 *
 *  Exported so the Tier-0 turn builder binds its facts by the SAME rule
 *  the tool merge uses. Two naming disciplines would mean a `revenue`
 *  placeholder could mean one thing on a model answer and another on a
 *  local one. */
export function freeName(base: string, taken: Record<string, unknown>): string {
  if (!(base in taken)) return base;
  for (let n = 2; n < 64; n += 1) {
    const candidate = `${base}__${n}`;
    if (!(candidate in taken)) return candidate;
  }
  return `${base}__x`;
}

/**
 * Fold every tool payload into ONE evidence object.
 *
 * Currency rule (the 461 discipline, structurally): the FIRST money
 * currency seen becomes the evidence currency. A later payload in a
 * DIFFERENT currency does not get merged — its money facts are dropped
 * and a `cross_entity`-shaped limitation is recorded instead. A single
 * rendered claim can therefore never straddle the conversion boundary,
 * because the facts on the other side of it are not bindable at all.
 */
export function mergeEvidence(
  entries: readonly { step: CapsulePlanStep; payload: CapsuleToolPayload }[],
): CapsuleEvidence {
  const ev = emptyEvidence();
  const seenPeriods = new Set<string>();
  const seenSnapshots = new Set<string>();
  const literals = new Set<string>();

  entries.forEach(({ step, payload }, index) => {
    if (!payload) return;
    if (!ev.tools.includes(payload.tool)) ev.tools.push(payload.tool);
    for (const note of payload.notes ?? []) ev.notes.push(note);
    for (const gap of payload.gaps ?? []) {
      ev.gaps.push(gap);
      for (const tk of gap.missing ?? []) digitTokens(tk).forEach((d) => literals.add(d));
    }
    for (const lim of payload.limitations ?? []) ev.limitations.push(lim);

    const payloadCurrency = payload.currency ? (payload.currency as Currency) : null;
    if (payloadCurrency && !ev.currency) ev.currency = payloadCurrency;
    const currencyClash = Boolean(
      payloadCurrency && ev.currency && payloadCurrency !== ev.currency,
    );
    if (currencyClash) {
      ev.limitations.push({
        kind: "limitation",
        tool: payload.tool,
        rule: "native_units",
        detail: "",
        alternative: "",
      });
    }

    const bind = (value: CapsuleValue, tool: string) => {
      const unit = asUnit(value.unit === "money" ? "money" : value.unit);
      // An undeclared unit is a refusal — the fact simply does not become
      // bindable, so no placeholder can ever name it.
      if (!unit) return;
      if (unit === "money" && currencyClash) return;
      const name = freeName(value.fact, ev.facts);
      const meta: CapsuleFactMeta = {
        fact: name,
        metric: value.metric,
        unit,
        value: value.value,
        scope: value.scope ?? "",
        labelKey: value.label_key ?? "",
        periodId: (value.provenance?.period_id as string) ?? null,
        periodLabel: (value.provenance?.period_label as string) ?? null,
        snapshotId: (value.provenance?.snapshot_id as string) ?? null,
        currency:
          value.kind === "money" ? value.currency : value.operand_currency ?? null,
        tool,
        alias: name === value.fact ? null : value.fact,
        step: index,
      };
      // The same fact NAME with the same value from the same period is
      // one fact, not two — dedupe rather than mint `revenue__2` for a
      // metric the plan happened to ask for twice.
      const prior = ev.factMeta[value.fact];
      if (
        prior &&
        prior.value === meta.value &&
        prior.unit === meta.unit &&
        prior.periodId === meta.periodId
      ) {
        return;
      }
      ev.facts[name] = value.value;
      ev.factUnits[name] = unit;
      ev.factMeta[name] = meta;
      ev.values.push(value);
      digitTokens(meta.periodLabel).forEach((d) => literals.add(d));
      digitTokens(meta.scope).forEach((d) => literals.add(d));
      if (meta.periodId && meta.periodLabel && !seenPeriods.has(meta.periodId)) {
        seenPeriods.add(meta.periodId);
        ev.periods.push({ id: meta.periodId, label: meta.periodLabel });
      }
      if (meta.snapshotId) seenSnapshots.add(meta.snapshotId);
    };

    for (const value of payload.values ?? []) bind(value, payload.tool);
    for (const row of payload.rows ?? []) {
      ev.rows.push(row);
      for (const money of row.money ?? []) bind(money, payload.tool);
      for (const raw of Object.values(row.fields ?? {})) {
        if (typeof raw === "string") digitTokens(raw).forEach((d) => literals.add(d));
      }
      digitTokens(row.id).forEach((d) => literals.add(d));
    }
    // Account codes the step asked for are quotable even when the read
    // refused — "there is no 461 in this period" must be sayable.
    digitTokens(String(step.args.code ?? "")).forEach((d) => literals.add(d));
    for (const [, param] of Object.entries(step.traceParams ?? {})) {
      digitTokens(param).forEach((d) => literals.add(d));
    }
  });

  ev.snapshots = Array.from(seenSnapshots);
  ev.literals = Array.from(literals).sort((a, b) => b.length - a.length);
  return ev;
}
