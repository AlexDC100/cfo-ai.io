// THE CAPSULE — answer-surface fixtures.
//
// Twelve questions that between them exercise every retrieval branch,
// plus transports that stand in for the engine and the Edge Function.
// The transports SYNTHESISE payloads from the plan's own arguments
// rather than replaying twelve hand-written blobs: a hand-written blob
// drifts from the contract silently, whereas a synthesiser that reads
// `step.args` breaks loudly the moment the planner starts sending
// something the tool layer does not accept.
//
// Figures are Scandia-FY2025-shaped (the calibration company in
// CLAUDE.md) so a reviewer eyeballing a screenshot sees plausible
// magnitudes rather than 1/2/3.
//
// These are also the LATENCY fixtures (C9): `capsuleAnswerLatency.test`
// runs all twelve through the real pipeline with a deterministic
// transport and reports p50 time-to-first-token.

import type {
  CapsuleMoneyValue,
  CapsuleRatioValue,
  CapsuleRowPayload,
  CapsuleToolPayload,
} from "./capsuleAnswerTypes";
import type { CapsulePlanStep, ToolTransport } from "./capsuleRetrieval";
import type { GenerationTransport } from "./capsuleAnswerClient";

// ── the fixture workspace ──────────────────────────────────────────────

export const FIXTURE_PERIODS = [
  { id: "p-2025-12", label: "Dec 2025", snapshot: "snap-a1b2c3d4" },
  { id: "p-2025-11", label: "Nov 2025", snapshot: "snap-b2c3d4e5" },
  { id: "p-2025-10", label: "Oct 2025", snapshot: "snap-c3d4e5f6" },
  { id: "p-2025-09", label: "Sep 2025", snapshot: "snap-d4e5f6a7" },
] as const;

export const FIXTURE_CURRENCY = "RON";

/** Minor units, per metric, per period index (0 = newest). Deliberately
 *  not round: a formatter bug shows up at the cents, not the millions. */
const SERIES: Record<string, number[]> = {
  total_assets: [29305008511, 28840112077, 28511900042, 28002443190],
  total_liabilities: [14289853400, 14401220050, 14620044118, 14733001987],
  equity: [15015155111, 14438892027, 13891855924, 13269441203],
  equity_plus_liabilities: [29305008511, 28840112077, 28511900042, 28002443190],
  current_assets: [17422900033, 17110044821, 16988712204, 16544019887],
  current_liabilities: [12844100255, 12977300118, 13122004471, 13288120004],
  working_capital: [4578799778, 4132744703, 3866707733, 3255899883],
  net_result: [3678735300, 3402118844, 3188400211, 2944012006],
  revenue: [41372756000, 37880114500, 34011229900, 30122880400],
  expenses: [37694020700, 34477995656, 30822829689, 27178868394],
  ebitda: [5444383400, 5011229800, 4588119220, 4103880110],
  difference: [0, 0, 0, 0],
};

const RATIOS: Record<string, { unit: string; series: number[]; num: string; den: string }> = {
  current_ratio: {
    unit: "ratio",
    series: [1.36, 1.32, 1.29, 1.24],
    num: "current_assets",
    den: "current_liabilities",
  },
  equity_ratio: {
    unit: "percent",
    series: [51.2, 50.1, 48.7, 47.4],
    num: "equity",
    den: "total_assets",
  },
  net_margin: {
    unit: "percent",
    series: [8.9, 9.0, 9.4, 9.8],
    num: "net_result",
    den: "revenue",
  },
};

function periodIndex(ref: string | null | undefined): number {
  if (!ref) return 0;
  const byId = FIXTURE_PERIODS.findIndex((p) => p.id === ref);
  if (byId >= 0) return byId;
  const byLabel = FIXTURE_PERIODS.findIndex(
    (p) => p.label.toLowerCase() === String(ref).toLowerCase(),
  );
  return byLabel >= 0 ? byLabel : 0;
}

function provenance(idx: number) {
  const p = FIXTURE_PERIODS[idx] ?? FIXTURE_PERIODS[0];
  return {
    period_id: p.id,
    period_label: p.label,
    entity_id: "org-fixture",
    source: "assembled_canonical_v1",
    tier: "served",
    snapshot_id: p.snapshot,
  };
}

export function fixtureMoney(
  fact: string,
  metric: string,
  amountMinor: number,
  idx: number,
  scope = "",
): CapsuleMoneyValue {
  return {
    kind: "money",
    fact,
    metric,
    unit: "money",
    amount_minor: amountMinor,
    value: amountMinor / 100,
    currency: FIXTURE_CURRENCY,
    scope: scope || (FIXTURE_PERIODS[idx]?.label ?? ""),
    label_key: "",
    provenance: provenance(idx),
  };
}

export function fixtureRatio(
  fact: string,
  metric: string,
  unit: string,
  value: number,
  idx: number,
  numeratorMinor: number,
  denominatorMinor: number,
): CapsuleRatioValue {
  return {
    kind: "ratio",
    fact,
    metric,
    unit,
    value,
    numerator_minor: numeratorMinor,
    denominator_minor: denominatorMinor,
    operand_currency: FIXTURE_CURRENCY,
    scope: FIXTURE_PERIODS[idx]?.label ?? "",
    label_key: "",
    provenance: provenance(idx),
  };
}

function emptyPayload(tool: string): CapsuleToolPayload {
  return {
    version: "ct1",
    tool,
    read_only: true,
    ok: false,
    values: [],
    rows: [],
    gaps: [],
    limitations: [],
    notes: [],
    facts: {},
    fact_units: {},
    currency: null,
  };
}

function seal(payload: CapsuleToolPayload): CapsuleToolPayload {
  const facts: Record<string, number> = {};
  const units: Record<string, string> = {};
  let currency: string | null = null;
  const take = (v: CapsuleMoneyValue | CapsuleRatioValue) => {
    facts[v.fact] = v.value;
    units[v.fact] = v.kind === "money" ? "money" : v.unit;
    if (v.kind === "money") currency = v.currency;
  };
  for (const v of payload.values) take(v as CapsuleMoneyValue | CapsuleRatioValue);
  for (const r of payload.rows) for (const m of r.money) take(m);
  payload.facts = facts;
  payload.fact_units = units;
  payload.currency = currency;
  payload.ok = payload.values.length > 0 || payload.rows.length > 0;
  return payload;
}

function valueFor(metric: string, idx: number, factName = metric) {
  if (metric in RATIOS) {
    const spec = RATIOS[metric];
    return fixtureRatio(
      factName,
      metric,
      spec.unit,
      spec.series[idx] ?? spec.series[0],
      idx,
      SERIES[spec.num]?.[idx] ?? 0,
      SERIES[spec.den]?.[idx] ?? 1,
    );
  }
  const series = SERIES[metric];
  if (!series) return null;
  return fixtureMoney(factName, metric, series[idx] ?? series[0], idx);
}

/** Payload synthesiser — the shape the real tool layer emits, built from
 *  the plan's own arguments. */
export function fixturePayload(step: CapsulePlanStep): CapsuleToolPayload {
  const p = emptyPayload(step.tool);
  const args = step.args as Record<string, unknown>;

  if (step.tool === "get_facts") {
    const metric = String(args.metric ?? "");
    const idx = periodIndex((args.period as string) ?? step.period);
    const value = valueFor(metric, idx);
    if (!value) {
      p.gaps.push({
        kind: "gap", tool: step.tool, code: "unknown_metric",
        missing: [metric], detail: `No metric named ${metric}.`,
        fix: "Ask for one of the served metrics.", upsell_key: "",
      });
      return seal(p);
    }
    p.values.push(value);
    return seal(p);
  }

  if (step.tool === "compare_periods") {
    const metrics = (args.metrics as string[]) ?? [];
    const ia = periodIndex(args.p1 as string);
    const ib = periodIndex(args.p2 as string);
    for (const metric of metrics) {
      const a = valueFor(metric, ia, `${metric}_a`);
      const b = valueFor(metric, ib, `${metric}_b`);
      if (!a || !b) continue;
      p.values.push(a, b);
      if (a.kind === "money" && b.kind === "money") {
        p.values.push(
          fixtureMoney(`${metric}_delta`, metric, b.amount_minor - a.amount_minor, ib,
            `${FIXTURE_PERIODS[ia].label} → ${FIXTURE_PERIODS[ib].label}`),
        );
      }
    }
    // The alignment rules held for these fixtures, so no limitation is
    // recorded — a comparison that DID trip one is covered by the
    // `cross-currency` case in `capsuleRetrieval.test.ts`.
    return seal(p);
  }

  if (step.tool === "get_account") {
    const code = String(args.code ?? "");
    const idx = periodIndex((args.period as string) ?? step.period);
    if (code === "461") {
      const money = fixtureMoney(`account_${code}`, `account_${code}`, 769220300, idx,
        "Debitori diverși");
      const row: CapsuleRowPayload = {
        kind: "account", id: code,
        fields: { code, name: "Debitori diverși", statement: "BS", bucket: "otherCurrentAssets" },
        money: [money],
      };
      p.rows.push(row);
      return seal(p);
    }
    p.gaps.push({
      kind: "gap", tool: step.tool, code: "concept_absent",
      missing: [code], detail: `Account ${code} is not in this period.`,
      fix: "Check the code, or upload the period's trial balance.", upsell_key: "",
    });
    return seal(p);
  }

  if (step.tool === "list_findings") {
    const idx = periodIndex((args.period as string) ?? step.period);
    p.rows.push({
      kind: "finding", id: "finding.receivable_concentration",
      fields: { severity: "high", title_key: "findings.receivableConcentration" },
      money: [fixtureMoney("finding_receivables", "accounts_receivable", 769220300, idx,
        "Debitori diverși")],
    });
    p.rows.push({
      kind: "silence", id: "checks.ran",
      fields: { checks: "12", fired: "1" },
      money: [],
    });
    return seal(p);
  }

  if (step.tool === "run_scenario_preview") {
    const idx = periodIndex((args.period as string) ?? step.period);
    const drivers = (args.drivers as { metric: string; value: number }[]) ?? [];
    const base = SERIES.revenue[idx];
    const pct = drivers[0]?.value ?? 0;
    const moved = Math.round(base * (1 + pct / 100));
    p.values.push(
      fixtureMoney("revenue_base", "revenue", base, idx),
      fixtureMoney("revenue_moved", "revenue", moved, idx, "what-if"),
      fixtureMoney("net_result_moved", "net_result",
        SERIES.net_result[idx] + (moved - base), idx, "what-if"),
    );
    p.limitations.push({
      kind: "limitation", tool: step.tool, rule: "preview_scope",
      detail: "Arithmetic over served figures; nothing was re-run.",
      alternative: "",
    });
    return seal(p);
  }

  if (step.tool === "get_benchmark") {
    p.rows.push({
      kind: "benchmark", id: "peer.food_manufacturing",
      fields: { peer_group: String(args.peer_group ?? ""), metric: String(args.metric ?? "") },
      money: [],
    });
    p.limitations.push({
      kind: "limitation", tool: step.tool, rule: "sample_size",
      detail: "The peer sample is thin.", alternative: "",
    });
    return seal(p);
  }

  if (step.tool === "get_public_company") {
    p.gaps.push({
      kind: "gap", tool: step.tool, code: "feed_input_absent",
      missing: [String(args.entity ?? "")], detail: "The feed did not publish that input.",
      fix: "Try a different listed company.", upsell_key: "",
    });
    return seal(p);
  }

  if (step.tool === "search_help") {
    p.rows.push({
      kind: "help", id: "help.export",
      fields: { title_key: "help.export.title", route: "/dashboard?tab=export" },
      money: [],
    });
    return seal(p);
  }

  return seal(p);
}

// ── transports ─────────────────────────────────────────────────────────

/** The engine stand-in. `delayMs` is per call and applied with real
 *  timers, so the latency harness measures a realistic serial cost even
 *  though the calls run in parallel. */
export function fixtureToolTransport(delayMs = 0): ToolTransport {
  return async (step) => {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    return fixturePayload(step);
  };
}

/** An engine that is down. Every read throws; the pipeline must still
 *  produce a calm turn. */
export function deadToolTransport(): ToolTransport {
  return async () => {
    throw new TypeError("Failed to fetch");
  };
}

/** The Edge Function stand-in. Yields `chunks` pieces so first-token and
 *  completion are distinguishable even though the live transport is
 *  single-shot. */
export function fixtureGenerationTransport(
  text: string | ((brief: string) => string),
  opts: { chunks?: number; firstTokenMs?: number; chunkMs?: number } = {},
): GenerationTransport {
  const chunks = opts.chunks ?? 3;
  const first = opts.firstTokenMs ?? 0;
  const per = opts.chunkMs ?? 0;
  return async function* generate(req) {
    const brief = req.messages[req.messages.length - 1]?.content ?? "";
    const body = typeof text === "function" ? text(brief) : text;
    if (first > 0) await new Promise((r) => setTimeout(r, first));
    const size = Math.ceil(body.length / chunks);
    for (let i = 0; i < body.length; i += size) {
      if (i > 0 && per > 0) await new Promise((r) => setTimeout(r, per));
      yield body.slice(i, i + size);
    }
  };
}

// ── the twelve questions ───────────────────────────────────────────────

export interface AnswerFixture {
  id: string;
  question: string;
  /** Tools the planner must reach for. */
  tools: string[];
  /** A contract-abiding answer for that question. */
  answer: string;
}

export const ANSWER_FIXTURES: readonly AnswerFixture[] = Object.freeze([
  {
    id: "assets",
    question: "what are our total assets",
    tools: ["get_facts"],
    answer: "Total assets stand at {{money:total_assets}} for the period on file.",
  },
  {
    id: "equity-ratio",
    question: "what is the equity ratio",
    tools: ["get_facts"],
    answer: "Equity funds {{fact:equity_ratio}} of the balance sheet.",
  },
  {
    id: "working-capital",
    question: "what is our working capital",
    tools: ["get_facts"],
    answer: "Working capital is {{money:working_capital}}.",
  },
  {
    id: "compare-revenue",
    question: "how did revenue change vs last month",
    tools: ["compare_periods"],
    answer:
      "Revenue moved from {{money:revenue_a}} to {{money:revenue_b}}, a change of {{money:revenue_delta}}.",
  },
  {
    id: "trend-revenue",
    question: "show me the revenue trend over time",
    tools: ["get_facts"],
    answer: "Revenue has risen across the months read, ending at {{money:revenue}}.",
  },
  {
    id: "account-461",
    question: "what is sitting in account 461",
    tools: ["get_account"],
    answer: "Account 461 holds {{money:account_461}}.",
  },
  {
    id: "findings",
    question: "what findings fired this month",
    tools: ["list_findings"],
    answer:
      "One finding fired: a receivable concentration of {{money:finding_receivables}}.",
  },
  {
    id: "liquidity-ro",
    question: "cum stăm cu lichiditatea curentă",
    tools: ["get_facts"],
    answer: "Lichiditatea curentă este {{fact:current_ratio}}.",
  },
  {
    id: "scenario",
    question: "what if revenue drops 10%",
    tools: ["run_scenario_preview"],
    answer:
      "Revenue would move from {{money:revenue_base}} to {{money:revenue_moved}}, leaving {{money:net_result_moved}}.",
  },
  {
    id: "health",
    question: "how are we doing overall",
    tools: ["get_facts", "list_findings"],
    answer:
      "Revenue is {{money:revenue}} with a net result of {{money:net_result}} and equity of {{money:equity}}.",
  },
  {
    id: "help",
    question: "how do i export the balance sheet",
    tools: ["search_help"],
    answer: "Use the export action on the dashboard; the help entry walks through it.",
  },
  {
    id: "margin-ro",
    question: "care e marja netă față de luna trecută",
    tools: ["compare_periods"],
    answer: "Marja netă a trecut de la {{fact:net_margin_a}} la {{fact:net_margin_b}}.",
  },
]);

/** Answers that MUST be refused by the guard. */
export const VIOLATING_ANSWERS: readonly { id: string; text: string; kind: string }[] =
  Object.freeze([
    // A hardcoded money string is the POINT here: this is the model
    // output the guard must refuse, so it may not be routed through the
    // money renderer the lint rule normally insists on.
    // eslint-disable-next-line no-restricted-syntax
    { id: "bare-numeral", text: "Total assets are 293,050,085 RON.", kind: "numeral" },
    { id: "rounded", text: "Assets sit near 293 million.", kind: "numeral" },
    { id: "unknown-fact", text: "Cash is {{money:cash_at_bank}}.", kind: "unknown_fact" },
    { id: "wrong-unit", text: "Liquidity is {{money:current_ratio}}.", kind: "unit_mismatch" },
    { id: "malformed", text: "Assets are {{revenue}}.", kind: "malformed_placeholder" },
    { id: "empty", text: "   ", kind: "empty" },
  ]);
