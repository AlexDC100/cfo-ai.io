// decisionRules.ts — multi-rule decision system.
//
// Catalog
// ───────
// Each rule is a small declarative object that says (a) which raw SKU
// field(s) it needs, (b) how to compute its scalar value from a SKU,
// (c) whether higher values are good or bad, and (d) default cutoffs +
// axis bounds. Adding a new rule is a one-line entry in RULES — every
// downstream surface (modal, store, Products page) iterates the catalog.
//
// Final-bucket computation
// ────────────────────────
// `computeFinalBucket(sku, RULES, state)` runs each enabled rule, gets a
// per-rule bucket, and combines them under one of three modes:
//   • all_agree   — Protect requires unanimity; any wind_down → wind_down
//   • worst_wins  — Take the worst of the per-rule buckets (default)
//   • weighted    — Score per-rule buckets, weighted average → final
//
// SKUs whose raw data is missing for an enabled rule simply abstain from
// that rule (skipped, not penalised) so a partial-coverage rule doesn't
// silently push everything to wind_down.
//
// Pure: same (sku, state) always returns the same bucket. Callers wrap
// in useMemo on (rows, state).

import type { Bucket3 } from "./bucket3";

// ─── Types ──────────────────────────────────────────────────────────────────

export type CombinationMode = "all_agree" | "worst_wins" | "weighted";

export interface SkuLite {
  classification?: string | null;
  gm_krn?: number | null;
  niv_krn?: number | null;
  gm_pct?: number | null;
  real_margin_krn?: number | null;
  real_margin_pct?: number | null;
  volume_tons?: number | null;
  days_inventory_on_hand?: number | null;
  inventory_value_krn?: number | null;
  cogs_krn?: number | null;
}

/**
 * Operator-adjustable working-capital financing assumptions used by the
 * Adjusted-GM rule (and surfaced on the Products page totals once that
 * polish lands). Stored alongside `rules` in the decision-rules store so
 * dragging either slider live-rebuckets the portfolio via the same
 * useSyncExternalStore path everything else uses.
 *
 *   costOfFinancing — base annual rate on working capital (e.g. 5.5 %)
 *   bankSpread      — additional spread the bank charges (e.g. 2.0 %)
 *   totalRatePct    — derived sum, percentage points (e.g. 7.5)
 */
export interface FinancingParams {
  costOfFinancing: number;
  bankSpread: number;
}

export interface BucketContext {
  financing: FinancingParams;
}

export const DEFAULT_FINANCING: FinancingParams = {
  costOfFinancing: 5.5,
  bankSpread: 2.0,
};

/** Per-SKU financing cost = average inventory × (DIO/365) × total rate.
 * Average inventory is derived from COGS × DIO/365 when the per-SKU
 * inventory_value isn't recorded — this is the textbook DIO identity
 * (inventory = COGS × DIO/365), so the formula collapses to:
 *     financingCost = COGS × (DIO/365) × rate
 * Returns null when DIO is missing OR COGS proxy can't be derived. */
export function computeFinancingCost(
  sku: SkuLite,
  params: FinancingParams,
): number | null {
  const dio = num(sku.days_inventory_on_hand);
  if (dio === null) return null;
  // Prefer explicit COGS; fall back to NIV − GM (implied COGS by margin).
  let cogs = num(sku.cogs_krn);
  if (cogs === null) {
    const niv = num(sku.niv_krn);
    const gm = num(sku.gm_krn);
    cogs = niv !== null && gm !== null ? niv - gm : null;
  }
  if (cogs === null || cogs <= 0) return null;
  const ratePct = (params.costOfFinancing ?? 0) + (params.bankSpread ?? 0);
  return cogs * (dio / 365) * (ratePct / 100);
}

export function computeAdjustedGm(
  sku: SkuLite,
  params: FinancingParams,
): number | null {
  const finCost = computeFinancingCost(sku, params);
  if (finCost === null) return null;
  const gm = num(sku.gm_krn);
  if (gm === null) return null;
  return gm - finCost;
}

export function computeAdjustedGmPct(
  sku: SkuLite,
  params: FinancingParams,
): number | null {
  const adj = computeAdjustedGm(sku, params);
  if (adj === null) return null;
  const niv = num(sku.niv_krn);
  if (niv === null || niv === 0) return null;
  return (adj / niv) * 100;
}

export type Direction = "higher_better" | "lower_better";

export interface RuleDefinition {
  id: string;
  /** i18n key — modal calls `t(labelKey, labelDefault)`. */
  labelKey: string;
  labelDefault: string;
  unitKey: string;
  unitDefault: string;
  direction: Direction;
  /** SKU fields the compute() function relies on. Used by
   *  `getRuleAvailability` to decide if the rule should be shown as
   *  active, partial, or missing. */
  requiredFields: (keyof SkuLite)[];
  /** Maps a single SKU to the rule's scalar value. Returns null when the
   *  required fields are missing on this row (rule abstains for this SKU).
   *  `ctx` is optional; rules that depend on user-tunable assumptions
   *  (e.g. financing rate for adjusted-GM) read them off `ctx.financing`. */
  compute: (sku: SkuLite, ctx?: BucketContext) => number | null;
  /** Initial [lower, upper] cutoffs (sensible defaults for typical Romanian
   *  SME data). Operator tunes them live in the modal. */
  defaultThresholds: [number, number];
  /** Fixed axis bounds, or "auto" to derive from the loaded SKU distribution
   *  with a 5% pad on each side. */
  bounds: { min: number; max: number; step: number } | "auto";
  /** When false, the rule is shipped in the catalog but starts disabled
   *  (user must toggle on). Used for the "scaffolded but not yet active"
   *  bucket of nice-to-have rules. */
  enabledByDefault: boolean;
}

export interface RuleState {
  enabled: boolean;
  thresholds: [number, number];
  /** Used by the weighted combination mode (1–10). Ignored by all_agree /
   *  worst_wins. Stored regardless so switching modes preserves it. */
  weight: number;
}

export interface DecisionRulesState {
  combinationMode: CombinationMode;
  rules: Record<string, RuleState>;
  /** Working-capital financing assumptions threaded into compute() for
   *  rules that need them (e.g. adjusted_gm_pct). Lives on the same
   *  store so a slider drag rebuckets the portfolio via the existing
   *  useSyncExternalStore path. Optional on read for backward compat
   *  with v3 entries persisted before this field existed. */
  financing?: FinancingParams;
}

// ─── Catalog ────────────────────────────────────────────────────────────────

/** Get a SKU field defensively; null if not a finite number.
 *
 * IMPORTANT (2026-07-26): PostgREST serializes Postgres `numeric` columns as
 * JSON *strings* (to preserve arbitrary precision) — `sku_aggregates`
 * `days_inventory_on_hand`, `cogs_krn`, `inventory_value_krn` (and, depending
 * on the column type, `gm_krn` / `niv_krn` / `volume_tons`) arrive as e.g.
 * "93.00" rather than 93. The table renders them fine because JS coerces in
 * arithmetic (`"93" * 1000`, `Math.round("93")`), but the decision-rule
 * `compute()` functions ran the raw value through this helper — and the old
 * strict `typeof v === "number"` check turned every string into `null`, so
 * EVERY rule abstained and `combineBuckets([])` returned "watch" for the whole
 * portfolio (the "every SKU shows Watch" bug). Coercing numeric strings here
 * fixes the signal at the source; number-typed fields are unaffected. */
function num(v: number | string | null | undefined): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export const RULES: readonly RuleDefinition[] = [
  {
    id: "gross_profit",
    labelKey: "decision_rules.rule.gross_profit",
    labelDefault: "Gross profit per SKU",
    unitKey: "common.unit.ron",
    unitDefault: "RON",
    direction: "higher_better",
    requiredFields: ["gm_krn"],
    compute: (sku) => num(sku.gm_krn) ?? num(sku.real_margin_krn),
    defaultThresholds: [0, 50_000],
    bounds: "auto",
    enabledByDefault: true,
  },
  {
    id: "dio",
    labelKey: "decision_rules.rule.dio",
    labelDefault: "Days inventory outstanding (DIO)",
    unitKey: "common.unit.days",
    unitDefault: "days",
    direction: "lower_better",
    requiredFields: ["days_inventory_on_hand"],
    compute: (sku) => num(sku.days_inventory_on_hand),
    defaultThresholds: [30, 90],
    bounds: { min: 0, max: 365, step: 1 },
    enabledByDefault: true,
  },
  {
    id: "volume",
    labelKey: "decision_rules.rule.volume",
    labelDefault: "Volume (tons)",
    unitKey: "common.unit.tons",
    unitDefault: "tons",
    direction: "higher_better",
    requiredFields: ["volume_tons"],
    compute: (sku) => num(sku.volume_tons),
    defaultThresholds: [10, 100],
    bounds: "auto",
    enabledByDefault: true,
  },
  {
    id: "revenue",
    labelKey: "decision_rules.rule.revenue",
    labelDefault: "Revenue per SKU",
    unitKey: "common.unit.ron",
    unitDefault: "RON",
    direction: "higher_better",
    requiredFields: ["niv_krn"],
    compute: (sku) => num(sku.niv_krn),
    defaultThresholds: [100_000, 1_000_000],
    bounds: "auto",
    enabledByDefault: false,
  },
  {
    id: "adjusted_gm_pct",
    labelKey: "decision_rules.rule.adjusted_gm_pct",
    labelDefault: "Adjusted GM % (after financing)",
    unitKey: "common.unit.percent",
    unitDefault: "%",
    direction: "higher_better",
    requiredFields: ["niv_krn", "gm_krn", "days_inventory_on_hand"],
    // Killer rule: applies working-capital financing cost to the raw
    // gross margin so SKUs with high reported GM% but very long DIO
    // (e.g. JELEURI at 1001 days, ULEI at 287 days) surface as
    // wind_down candidates once the cost of capital is honest.
    // Reads financing assumptions off the BucketContext.financing slot
    // populated by computeFinalBucket — slider drags in the modal
    // recompute this on every render via the same useMemo path the
    // KPI tiles use.
    compute: (sku, ctx) => {
      if (!ctx) return null;
      return computeAdjustedGmPct(sku, ctx.financing);
    },
    defaultThresholds: [5, 12],
    bounds: { min: -50, max: 60, step: 1 },
    enabledByDefault: true,
  },
  {
    id: "margin_pct",
    labelKey: "decision_rules.rule.margin_pct",
    labelDefault: "Margin %",
    unitKey: "common.unit.percent",
    unitDefault: "%",
    direction: "higher_better",
    requiredFields: ["gm_pct"],
    // CRITICAL: the backend stores gm_pct and real_margin_pct as DECIMALS
    // (e.g. 0.1726 means 17.26%). The rule's thresholds + axis bounds are
    // expressed in PERCENTAGE POINTS (5, 20, etc.). Without this
    // normalisation every SKU's raw decimal <1 would compare under any
    // sensible threshold and the rule would push every row to wind_down
    // under `all_agree` mode — which is exactly what the operator hit on
    // the YTDMar'26 dataset (median gm_pct 0.128 = 12.8%, max 0.554 =
    // 55.4%; threshold lo=11 pp; without ×100 even the top SKU reads as
    // 0.554 < 11 → wind_down for all 358). Normalise here so the
    // user-facing slider numbers behave intuitively.
    compute: (sku) => {
      const v = num(sku.gm_pct) ?? num(sku.real_margin_pct);
      return v === null ? null : v * 100;
    },
    defaultThresholds: [5, 20],
    bounds: { min: -50, max: 100, step: 1 },
    enabledByDefault: false,
  },
];

export function getRule(id: string): RuleDefinition | undefined {
  return RULES.find((r) => r.id === id);
}

// ─── Availability ───────────────────────────────────────────────────────────

export type AvailabilityStatus = "available" | "partial" | "missing";

export interface RuleAvailability {
  status: AvailabilityStatus;
  /** SKU fields the rule needs that are missing across the entire dataset. */
  missingFields: (keyof SkuLite)[];
  /** Number of SKUs where compute() returns a non-null value. */
  coveredCount: number;
  /** Total SKU count, for the "287 of 406" line. */
  totalCount: number;
}

/**
 * Decide whether a rule is usable against the loaded dataset.
 *
 * • available — every required field appears non-null on every SKU
 * • partial   — required fields exist on the schema (at least one SKU
 *               has each), but ≥ 1 SKU is missing them; show a
 *               coverage hint but allow the rule to run
 * • missing   — at least one required field is null on every SKU; the
 *               rule cannot be evaluated and is shown disabled with a
 *               clear remediation message
 */
export function getRuleAvailability(
  rule: RuleDefinition,
  skus: readonly SkuLite[],
): RuleAvailability {
  if (skus.length === 0) {
    return {
      status: "missing",
      missingFields: rule.requiredFields,
      coveredCount: 0,
      totalCount: 0,
    };
  }

  // For each required field, check whether at least one SKU has a
  // non-null value. Fields that are null on every row are "missing".
  const trulyMissing: (keyof SkuLite)[] = [];
  for (const field of rule.requiredFields) {
    const someRowHasIt = skus.some((s) => num(s[field] as number | null | undefined) !== null);
    if (!someRowHasIt) trulyMissing.push(field);
  }
  if (trulyMissing.length > 0) {
    return {
      status: "missing",
      missingFields: trulyMissing,
      coveredCount: 0,
      totalCount: skus.length,
    };
  }

  // Schema is present — check per-row coverage via the rule's compute().
  let covered = 0;
  for (const s of skus) {
    if (rule.compute(s) !== null) covered += 1;
  }
  return {
    status: covered === skus.length ? "available" : "partial",
    missingFields: [],
    coveredCount: covered,
    totalCount: skus.length,
  };
}

// ─── Per-rule + final bucket computation ────────────────────────────────────

/** Map a scalar value through a rule's two cutoffs into a bucket. */
export function bucketForRule(
  value: number,
  rule: RuleDefinition,
  state: RuleState,
): Bucket3 {
  const [lo, hi] = state.thresholds;
  if (rule.direction === "higher_better") {
    if (value <= lo) return "wind_down";
    if (value >= hi) return "protect";
    return "watch";
  }
  // lower_better — high values are bad, so high → wind_down
  if (value >= hi) return "wind_down";
  if (value <= lo) return "protect";
  return "watch";
}

/** Combine per-rule buckets into one final bucket via the active mode. */
export function combineBuckets(
  parts: readonly { bucket: Bucket3; weight: number }[],
  mode: CombinationMode,
): Bucket3 {
  if (parts.length === 0) return "watch"; // no enabled rule with data → neutral

  switch (mode) {
    case "all_agree":
      // Any rule saying wind_down → wind_down (conservative).
      if (parts.some((p) => p.bucket === "wind_down")) return "wind_down";
      // Otherwise, Protect requires unanimous agreement.
      if (parts.every((p) => p.bucket === "protect")) return "protect";
      return "watch";

    case "worst_wins":
      // worst > best: wind_down > watch > protect
      if (parts.some((p) => p.bucket === "wind_down")) return "wind_down";
      if (parts.some((p) => p.bucket === "watch")) return "watch";
      return "protect";

    case "weighted": {
      // Convert each bucket to a score and take the weighted average.
      // wind_down=0, watch=1, protect=2. Total-weight zero (e.g., all
      // rules have weight 0) falls back to worst_wins so the user
      // doesn't silently see "watch" everywhere.
      const score = (b: Bucket3) =>
        b === "wind_down" ? 0 : b === "watch" ? 1 : 2;
      const totalW = parts.reduce((s, p) => s + p.weight, 0);
      if (totalW === 0) return combineBuckets(parts, "worst_wins");
      const avg =
        parts.reduce((s, p) => s + score(p.bucket) * p.weight, 0) / totalW;
      if (avg < 0.67) return "wind_down";
      if (avg > 1.33) return "protect";
      return "watch";
    }
  }
}

/** Compute the final bucket for a SKU under the current rule state.
 *  Pass `ctx` so rules that depend on user-tunable assumptions
 *  (financing rate, etc.) can read them. */
export function computeFinalBucket(
  sku: SkuLite,
  catalog: readonly RuleDefinition[],
  state: DecisionRulesState,
  ctx?: BucketContext,
): Bucket3 {
  const parts: { bucket: Bucket3; weight: number }[] = [];
  for (const rule of catalog) {
    const rs = state.rules[rule.id];
    if (!rs || !rs.enabled) continue;
    const value = rule.compute(sku, ctx);
    if (value === null) continue; // rule abstains for this row
    parts.push({ bucket: bucketForRule(value, rule, rs), weight: rs.weight });
  }
  return combineBuckets(parts, state.combinationMode);
}

// ─── Convenience aggregations ───────────────────────────────────────────────

export interface BucketDistribution {
  protect: number;
  watch: number;
  wind_down: number;
}

export function countFinalBuckets<T extends SkuLite>(
  rows: readonly T[],
  catalog: readonly RuleDefinition[],
  state: DecisionRulesState,
  ctx?: BucketContext,
): BucketDistribution {
  const c: BucketDistribution = { protect: 0, watch: 0, wind_down: 0 };
  for (const r of rows) c[computeFinalBucket(r, catalog, state, ctx)] += 1;
  return c;
}

export function sumRevenueFinal<
  T extends SkuLite & { niv_krn?: number | null },
>(
  rows: readonly T[],
  catalog: readonly RuleDefinition[],
  state: DecisionRulesState,
  ctx?: BucketContext,
): BucketDistribution {
  const s: BucketDistribution = { protect: 0, watch: 0, wind_down: 0 };
  for (const r of rows) s[computeFinalBucket(r, catalog, state, ctx)] += r.niv_krn ?? 0;
  return s;
}

/** Per-rule counts — used by each rule card to show "if I were the only
 *  rule, this is how SKUs would split". */
export function countPerRule<T extends SkuLite>(
  rule: RuleDefinition,
  ruleState: RuleState,
  rows: readonly T[],
  ctx?: BucketContext,
): BucketDistribution {
  const c: BucketDistribution = { protect: 0, watch: 0, wind_down: 0 };
  for (const r of rows) {
    const v = rule.compute(r, ctx);
    if (v === null) continue;
    c[bucketForRule(v, rule, ruleState)] += 1;
  }
  return c;
}

// ─── Default state + axis-bound derivation ──────────────────────────────────

export function defaultRulesState(): DecisionRulesState {
  const rules: Record<string, RuleState> = {};
  for (const r of RULES) {
    rules[r.id] = {
      enabled: r.enabledByDefault,
      thresholds: [...r.defaultThresholds],
      weight: 5,
    };
  }
  return {
    combinationMode: "worst_wins",
    rules,
    financing: { ...DEFAULT_FINANCING },
  };
}

/** Derive [min,max,step] for the slider from actual SKU values when the
 *  rule's bounds are "auto", with a 5% pad and a sane step size. */
export function deriveBounds(
  rule: RuleDefinition,
  skus: readonly SkuLite[],
): { min: number; max: number; step: number } {
  if (rule.bounds !== "auto") return rule.bounds;
  if (skus.length === 0) return { min: 0, max: 100, step: 1 };
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const s of skus) {
    const v = rule.compute(s);
    if (v === null) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) {
    return { min: 0, max: 100, step: 1 };
  }
  const pad = Math.max(1, Math.abs(hi - lo) * 0.05);
  const min = Math.floor((lo - pad) / 1) * 1;
  const max = Math.ceil((hi + pad) / 1) * 1;
  const raw = (max - min) / 200;
  // Nice step: round to nearest 1 / 10 / 100 / 1000 depending on scale.
  let step = 1;
  if (raw > 1000) step = Math.round(raw / 1000) * 1000;
  else if (raw > 100) step = Math.round(raw / 100) * 100;
  else if (raw > 10) step = Math.round(raw / 10) * 10;
  else if (raw > 1) step = Math.max(1, Math.round(raw));
  else step = 0.1;
  return { min, max, step };
}
