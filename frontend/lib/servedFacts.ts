// servedFacts.ts — THE frontend facts gateway over the SERVED statements
// object (docs/CANONICAL_BS_V2_CONTRACT.md + docs/served_envelope.schema.json).
//
// Mirrors the engine serve gateway (`_reconcile.served_canonical_bs` applied
// by `pipeline._apply_envelope_truth_to_statements`) on the FE side: every
// surface that needs a Balance-Sheet TOTAL — periodFacts, ratios, valuation,
// recommendations, HTML/Excel exports, the BS tab builder, the chat
// dataset_summary — reads it from `factsFrom(statements)`, never from
// `statements.canonical_bs` / `statements.assembled_bs` / `deriveTotals`
// directly. The module is the ONLY place that knows whether a period is
// canonical (bs_v2) or legacy; views never branch on presence themselves.
//
// Source precedence (exactly the engine gateway's):
//   1. `statements.canonical_bs` — the SERVED object: on RECONCILED periods
//      its totals are already the ADJUSTED (reconciliation-inclusive)
//      figures; `difference` is exactly 0; the receipt + visible line ride
//      along. Served verbatim — zero FE arithmetic.
//   2. legacy envelope totals the gateway wrote onto `assembled_bs`
//      (total_assets / total_equity / total_liabilities / bs_balance_delta
//      + the current/non-current splits when present).
//   3. `deriveTotals(statements)` bucket sums — pre-envelope periods and
//      FE-sample fixtures only. The fallback lives HERE, nowhere else.
//
// ⚠ THE ONE INTENTIONAL NUMBER CHANGE of this refactor: valuation equity
// (cost-of-capital weights, Altman X4, credit score, asset-based
// `primary_value` fallback) now reads the ADJUSTED (reconciliation-
// inclusive) equity through this gateway instead of raw canonical totals.
// On BALANCED periods the figures are identical; on RECONCILED periods the
// valuation tab now agrees with the BS tab, both exports and the chip.
//
// Units: amounts are INTEGER MINOR UNITS (cents) internally — every
// comparison and derivation happens in cents; `toDisplay()` is the single
// float conversion at the edge (accessors call it once on the way out).

import {
  deriveTotals,
  type CanonicalBs,
  type CanonicalBsReconciliation,
  type CanonicalBsStatus,
  type Statements,
} from "./financialReport";
import type { CanonicalBsReconciliationExt } from "./buildBsStatement";
import { bsCanonicalEn } from "@/components/cfo/bsCanonicalStatusI18n";

// ─── Envelope contract pin ──────────────────────────────────────────────
// The schema file is the shared engine↔FE fixture contract; the vitest
// contract suite asserts every path below exists in it at THIS version.

export const SERVED_ENVELOPE_VERSION = "served_v1";
export const SERVED_ENVELOPE_SCHEMA_PATH = "docs/served_envelope.schema.json";

/** Every `statements.*` field this module reads, as dotted paths.
 *  frontend/lib/__tests__/servedFactsContract.test.ts resolves each one
 *  against docs/served_envelope.schema.json — a field the engine renames
 *  or drops fails the suite before it can fail a user. */
export const SERVED_ENVELOPE_FIELDS_READ: readonly string[] = [
  // canonical path — the served bs_v2 object (adjusted totals).
  "canonical_bs.schema",
  "canonical_bs.envelope_version",
  "canonical_bs.mapping_version",
  "canonical_bs.status",
  "canonical_bs.status_presentation.machine",
  "canonical_bs.status_presentation.display_key",
  "canonical_bs.status_presentation.display_en",
  "canonical_bs.status_presentation.display_ro",
  "canonical_bs.status_presentation.micro_caption",
  "canonical_bs.difference",
  "canonical_bs.needs_review",
  "canonical_bs.rows",
  "canonical_bs.sections",
  "canonical_bs.diagnosis",
  "canonical_bs.totals.assets",
  "canonical_bs.totals.equity",
  "canonical_bs.totals.liabilities",
  "canonical_bs.totals.equity_plus_liabilities",
  "canonical_bs.totals.current_assets",
  "canonical_bs.totals.current_liabilities",
  "canonical_bs.reconciliation.original_difference",
  "canonical_bs.reconciliation.applied_delta",
  "canonical_bs.reconciliation.origin",
  "canonical_bs.reconciliation.placement",
  "canonical_bs.reconciliation.placement_detail",
  "canonical_bs.reconciliation.diagnosis_code",
  "canonical_bs.reconciliation.rationale",
  "canonical_bs.reconciliation.applied_at",
  "canonical_bs.reconciliation.applied_by",
  "canonical_bs.reconciliation.model",
  "canonical_bs.reconciliation.prompt_version",
  // P&L-placed reconciliation — the visible line served on assembled_pl.
  "assembled_pl.reconciliation_adjustment.label",
  "assembled_pl.reconciliation_adjustment.placement",
  "assembled_pl.reconciliation_adjustment.amount",
  "assembled_pl.reconciliation_adjustment.synthetic",
  // legacy path — envelope totals the gateway wrote onto assembled_bs.
  "assembled_bs.total_assets",
  "assembled_bs.total_equity",
  "assembled_bs.total_liabilities",
  "assembled_bs.bs_balance_delta",
  "assembled_bs.total_current_assets",
  "assembled_bs.total_current_liabilities",
  "assembled_bs.total_non_current_assets",
  "assembled_bs.total_non_current_liabilities",
  // public_summary path (ps1) — reduced open-data tier: whole-RON
  // integer indicators (data.gov.ro I1..I20) + ingest-precomputed
  // derived block. Never coexists with a served canonical_bs.
  "public_summary.version",
  "public_summary.status",
  "public_summary.indicators",
  "public_summary.derived.total_assets",
  "public_summary.derived.net_result",
];

// ─── Minor-unit plumbing ────────────────────────────────────────────────

/** Display-float → integer cents. NaN/absent stays null. */
function centsOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) : null;
}

/** THE single minor-units → display-float conversion. Every accessor exits
 *  through here exactly once; nothing downstream converts again. */
export function toDisplay(cents: number): number {
  return cents / 100;
}

// ─── Facts shape ────────────────────────────────────────────────────────

export type ServedSource = "canonical" | "legacy" | "public_summary";

/** ps1 public_summary block as served under `statements.public_summary`
 *  (reduced open-data filing — data.gov.ro bilant indicators). The
 *  `Statements` type does not carry it (public periods never flow
 *  through the upload pipeline); `factsFrom` probes it structurally. */
export interface ServedPublicSummary {
  version?: string;
  status?: string;
  /** Whole-RON INTEGER indicators (I1..I20, per-year layout resolved at
   *  ingest). Empty string / missing = not reported. */
  indicators?: Record<string, number | null | undefined>;
  derived?: { total_assets?: number; net_result?: number } & Record<string, unknown>;
}

/** Reconciliation receipt as served (verbatim) + the placement the strip
 *  consumes. Only presentation reads it; arithmetic never re-applies it —
 *  the served totals already include the adjustment. */
export type ServedReconciliation = CanonicalBsReconciliationExt;

/** The one visible "Diferențe de reconciliere" line, resolved per the
 *  engine PLACEMENT RULE. On placement "pnl" this mirrors
 *  `assembled_pl.reconciliation_adjustment` (served by the pipeline hook);
 *  on "balance_sheet" it describes the synthetic BS row. */
export interface ServedReconciliationAdjustment {
  placement: "balance_sheet" | "pnl";
  placementDetail: "bs" | "pl_other_income" | "pl_other_expense";
  /** Signed applied delta (display units): effect on the E+L side —
   *  for "pnl" also the signed effect on the result (+income/−expense). */
  amount: number;
  label: string;
}

/** Internal minor-unit facts (exposed for tests / cross-surface checks). */
export interface ServedBsFactsCents {
  source: ServedSource;
  status: CanonicalBsStatus | null;
  needsReview: boolean;
  mappingVersion: string | null;
  totalAssetsCents: number;
  totalEquityCents: number;
  totalLiabilitiesCents: number;
  equityPlusLiabilitiesCents: number;
  currentAssetsCents: number;
  currentLiabilitiesCents: number;
  nonCurrentAssetsCents: number;
  nonCurrentLiabilitiesCents: number;
  /** assets − (equity + liabilities) as served; exactly 0 on RECONCILED. */
  differenceCents: number;
}

/** The engine presenter's output, stamped on every served canonical_bs
 *  (engine.serving.present_status → `status_presentation`, sv1). The FE
 *  presenter consumes it verbatim when served and mirrors it otherwise. */
export interface ServedStatusPresentation {
  machine: string;
  display_key: string;
  display_en: string;
  display_ro: string;
  micro_caption: string | null;
}

export interface ServedFacts {
  /** Which lane produced the totals — the ONLY sanctioned presence probe.
   *  Views branch on this (layout), never on `statements.canonical_bs`. */
  readonly source: ServedSource;
  readonly isCanonical: boolean;
  /** Minor-unit facts for cent-exact cross-surface assertions. */
  readonly cents: ServedBsFactsCents;
  status(): CanonicalBsStatus | null;
  needsReview(): boolean;
  mappingVersion(): string | null;
  totalAssets(): number;
  totalEquity(): number;
  totalLiabilities(): number;
  equityPlusLiabilities(): number;
  currentAssets(): number;
  currentLiabilities(): number;
  nonCurrentAssets(): number;
  nonCurrentLiabilities(): number;
  workingCapital(): number;
  /** THE drift — assets − (equity + liabilities) as served. */
  difference(): number;
  diagnosis(): { code: string; detail: string }[];
  reconciliation(): ServedReconciliation | null;
  reconciliationAdjustment(): ServedReconciliationAdjustment | null;
  /** Render-verbatim pass-through of the served object (rows/sections for
   *  the BS tab + exports). Numbers still come from the accessors above. */
  canonicalForRender(): CanonicalBs | null;
  presentStatus(currency?: string): BsStatusPresentation;
}

// ─── Core numeric picks (shared with buildBsStatement's meta) ───────────

/** Status/verdict numbers of a bare canonical_bs object, in cents. Used by
 *  `factsFrom` and by `canonicalMetaFromBs` (the undo POST response path),
 *  so the strip and every facts consumer read identical picks. */
export function canonicalStatusCore(cbs: CanonicalBs): {
  status: CanonicalBsStatus;
  needsReview: boolean;
  differenceCents: number;
  totalAssetsCents: number;
  equityPlusLiabilitiesCents: number;
} {
  const assets = centsOrNull(cbs.totals?.assets) ?? 0;
  const el =
    centsOrNull(cbs.totals?.equity_plus_liabilities) ??
    (centsOrNull(cbs.totals?.equity) ?? 0) + (centsOrNull(cbs.totals?.liabilities) ?? 0);
  return {
    status: cbs.status,
    // Boolean form only — the AI-lane ARRAY form is a different situation
    // (low-confidence lines), surfaced separately by the view meta.
    needsReview: cbs.needs_review === true,
    differenceCents: centsOrNull(cbs.difference) ?? assets - el,
    totalAssetsCents: assets,
    equityPlusLiabilitiesCents: el,
  };
}

// ─── The gateway ────────────────────────────────────────────────────────

export function factsFrom(statements: Statements): ServedFacts {
  const cbs = statements.canonical_bs;
  // ps1 probe — the engine never serves canonical_bs and public_summary
  // together; a served canonical_bs (if ever present) stays the authority.
  const ps = (statements as Statements & { public_summary?: ServedPublicSummary })
    .public_summary;
  const cents =
    cbs && cbs.totals
      ? centsFromCanonical(cbs)
      : ps && typeof ps === "object" && ps.indicators && typeof ps.indicators === "object"
        ? centsFromSummary(ps)
        : centsFromLegacy(statements);
  const rec: ServedReconciliation | null = cbs
    ? ((cbs as { reconciliation?: ServedReconciliation | null }).reconciliation ?? null)
    : null;
  // Engine-stamped presenter output (sv1 serve stamp) — the wording
  // authority when present; the FE mirror covers pre-stamp servings.
  const servedPresentation =
    (cbs as { status_presentation?: ServedStatusPresentation | null } | undefined)
      ?.status_presentation ?? null;

  const api: ServedFacts = {
    source: cents.source,
    isCanonical: cents.source === "canonical",
    cents,
    status: () => cents.status,
    needsReview: () => cents.needsReview,
    mappingVersion: () => cents.mappingVersion,
    totalAssets: () => toDisplay(cents.totalAssetsCents),
    totalEquity: () => toDisplay(cents.totalEquityCents),
    totalLiabilities: () => toDisplay(cents.totalLiabilitiesCents),
    equityPlusLiabilities: () => toDisplay(cents.equityPlusLiabilitiesCents),
    currentAssets: () => toDisplay(cents.currentAssetsCents),
    currentLiabilities: () => toDisplay(cents.currentLiabilitiesCents),
    nonCurrentAssets: () => toDisplay(cents.nonCurrentAssetsCents),
    nonCurrentLiabilities: () => toDisplay(cents.nonCurrentLiabilitiesCents),
    workingCapital: () => toDisplay(cents.currentAssetsCents - cents.currentLiabilitiesCents),
    difference: () => toDisplay(cents.differenceCents),
    diagnosis: () =>
      (cbs?.diagnosis ?? []).map((d) => ({ code: d.code, detail: d.detail })),
    reconciliation: () => rec,
    reconciliationAdjustment: () => resolveAdjustment(statements, rec),
    canonicalForRender: () => cbs ?? null,
    presentStatus: (currency?: string) =>
      presentStatus({
        status: cents.status,
        needsReview: cents.needsReview,
        reconciliation: rec,
        mappingVersion: cents.mappingVersion,
        difference: toDisplay(cents.differenceCents),
        currency: currency ?? statements.currency,
        statusPresentation: servedPresentation,
      }),
  };
  return api;
}

function centsFromCanonical(cbs: CanonicalBs): ServedBsFactsCents {
  const core = canonicalStatusCore(cbs);
  const equity = centsOrNull(cbs.totals.equity) ?? 0;
  const liabilities =
    centsOrNull(cbs.totals.liabilities) ?? core.equityPlusLiabilitiesCents - equity;
  // Contract guarantees the current splits on `totals`; the ?? 0 guards a
  // malformed envelope without inventing a mixed-lane figure.
  const currentAssets = centsOrNull(cbs.totals.current_assets) ?? 0;
  const currentLiabilities = centsOrNull(cbs.totals.current_liabilities) ?? 0;
  return {
    source: "canonical",
    status: core.status,
    needsReview: core.needsReview,
    mappingVersion: cbs.mapping_version ?? null,
    totalAssetsCents: core.totalAssetsCents,
    totalEquityCents: equity,
    totalLiabilitiesCents: liabilities,
    equityPlusLiabilitiesCents: core.equityPlusLiabilitiesCents,
    currentAssetsCents: currentAssets,
    currentLiabilitiesCents: currentLiabilities,
    nonCurrentAssetsCents: core.totalAssetsCents - currentAssets,
    nonCurrentLiabilitiesCents: liabilities - currentLiabilities,
    differenceCents: core.differenceCents,
  };
}

function centsFromLegacy(statements: Statements): ServedBsFactsCents {
  const ab = (statements.assembled_bs ?? {}) as Record<string, unknown>;
  const abAssets = centsOrNull(ab.total_assets);
  const abEquity = centsOrNull(ab.total_equity);
  const abLiabilities = centsOrNull(ab.total_liabilities);

  // The engine legacy branch writes the three grand totals together;
  // consume them as a coherent triple or not at all (mixing an engine
  // asset total with an FE-recomputed liability total would mint a fake
  // drift). deriveTotals bucket sums are the final, FE-sample fallback —
  // this is the ONE place that fallback lives now.
  const t = deriveTotals(statements);
  const hasEnvelope = abAssets !== null && abEquity !== null && abLiabilities !== null;
  const assets = hasEnvelope ? (abAssets as number) : centsOrNull(t.totalAssets) ?? 0;
  const equity = hasEnvelope ? (abEquity as number) : centsOrNull(t.totalEquity) ?? 0;
  const liabilities = hasEnvelope
    ? (abLiabilities as number)
    : centsOrNull(t.totalLiabilities) ?? 0;

  const currentAssets =
    (hasEnvelope ? centsOrNull(ab.total_current_assets) : null) ??
    centsOrNull(t.totalCurrentAssets) ??
    0;
  const currentLiabilities =
    (hasEnvelope ? centsOrNull(ab.total_current_liabilities) : null) ??
    centsOrNull(t.totalCurrentLiabilities) ??
    0;
  const nonCurrentAssets =
    (hasEnvelope ? centsOrNull(ab.total_non_current_assets) : null) ?? assets - currentAssets;
  const nonCurrentLiabilities =
    (hasEnvelope ? centsOrNull(ab.total_non_current_liabilities) : null) ??
    liabilities - currentLiabilities;

  const difference =
    (hasEnvelope ? centsOrNull(ab.bs_balance_delta) : null) ??
    assets - (equity + liabilities);

  return {
    source: "legacy",
    // Legacy periods carry no engine verdict — the FE must not claim one.
    status: null,
    needsReview: false,
    mappingVersion: null,
    totalAssetsCents: assets,
    totalEquityCents: equity,
    totalLiabilitiesCents: liabilities,
    equityPlusLiabilitiesCents: equity + liabilities,
    currentAssetsCents: currentAssets,
    currentLiabilitiesCents: currentLiabilities,
    nonCurrentAssetsCents: nonCurrentAssets,
    nonCurrentLiabilitiesCents: nonCurrentLiabilities,
    differenceCents: difference,
  };
}

/** Whole-RON INTEGER (ps1 indicator) → cents. Strict: anything that is
 *  not a finite integer stays null — never a swallowed 0 (the engine
 *  gateway refuses the same way, MissingFactError). */
function summaryRonCents(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v)
    ? v * 100
    : null;
}

/** ps1 public_summary lane. Status stays in the NULL family (the legacy
 *  precedent: "Legacy periods carry no engine verdict — the FE must not
 *  claim one") so `presentStatus` resolves to UNVERIFIED — it must NEVER
 *  fall into the `case "MATERIAL_IMBALANCE": default:` arm.
 *  Verified FY2019-FY2025 layout: I2 = Active circulante (current
 *  assets), I7 = DATORII total (NO maturity split), I10 = CAPITALURI
 *  TOTAL, derived.total_assets = I1+I2+I6 (ingest-precomputed). */
function centsFromSummary(ps: ServedPublicSummary): ServedBsFactsCents {
  const ind = ps.indicators ?? {};
  const assets =
    summaryRonCents(ps.derived?.total_assets) ??
    (summaryRonCents(ind.I1) ?? 0) +
      (summaryRonCents(ind.I2) ?? 0) +
      (summaryRonCents(ind.I6) ?? 0);
  const equity = summaryRonCents(ind.I10) ?? 0;
  const liabilities = summaryRonCents(ind.I7) ?? 0;
  const currentAssets = summaryRonCents(ind.I2) ?? 0;
  return {
    source: "public_summary",
    // Open-data summaries carry no engine verdict — null family, so the
    // presenter's UNVERIFIED arm handles it (never red imbalance copy).
    status: null,
    needsReview: false,
    mappingVersion: null,
    totalAssetsCents: assets,
    totalEquityCents: equity,
    totalLiabilitiesCents: liabilities,
    equityPlusLiabilitiesCents: equity + liabilities,
    currentAssetsCents: currentAssets,
    // I7 has no maturity split — 0 here is "no detail", and no surface
    // words a drift or a split on the null-status lane.
    currentLiabilitiesCents: 0,
    nonCurrentAssetsCents: assets - currentAssets,
    nonCurrentLiabilitiesCents: liabilities,
    // No drift concept exists on this lane: I10+I7 deliberately omits
    // I8/I9 (venituri in avans / provizioane), so assets−(E+L) would be
    // a fake imbalance. Status is null — nothing renders a difference.
    differenceCents: 0,
  };
}

/** PLACEMENT RULE resolution — mirrors the pipeline serve hook: a
 *  P&L-placed reconciliation is served on `assembled_pl` as
 *  `reconciliation_adjustment`; when that block is absent the detail is
 *  derived from the delta's sign exactly as the engine does. */
function resolveAdjustment(
  statements: Statements,
  rec: ServedReconciliation | null,
): ServedReconciliationAdjustment | null {
  if (!rec) return null;
  const placement = rec.placement === "pnl" ? "pnl" : "balance_sheet";
  const applied = typeof rec.applied_delta === "number" ? rec.applied_delta : 0;
  if (placement === "pnl") {
    const apl = (statements.assembled_pl ?? {}) as Record<string, unknown>;
    const adj = apl.reconciliation_adjustment as
      | { label?: string; placement?: string; amount?: number; synthetic?: boolean }
      | undefined;
    const detail =
      adj?.placement === "pl_other_income" || adj?.placement === "pl_other_expense"
        ? adj.placement
        : applied >= 0
          ? "pl_other_income"
          : "pl_other_expense";
    return {
      placement: "pnl",
      placementDetail: detail,
      amount: typeof adj?.amount === "number" ? adj.amount : applied,
      label: adj?.label ?? SYNTHETIC_ROW_LABEL,
    };
  }
  return {
    placement: "balance_sheet",
    placementDetail: "bs",
    amount: applied,
    label: SYNTHETIC_ROW_LABEL,
  };
}

/** The engine's synthetic-row label (fixed vocabulary, both languages
 *  render it verbatim — it names the line on the statement itself). */
export const SYNTHETIC_ROW_LABEL = "Diferențe de reconciliere";

// ─── rawFacts — audit/receipt/undo UI ONLY ──────────────────────────────

export interface RawBsFactsForAuditOnly {
  /** The TRUE pre-adjustment source drift (receipt.original_difference). */
  originalDifference: number;
  /** Pre-adjustment totals, reconstructed by reversing the served
   *  placement application. Equal to the served totals when no
   *  reconciliation is applied. */
  totalAssets: number;
  totalEquity: number;
  totalLiabilities: number;
  equityPlusLiabilities: number;
  appliedDelta: number;
  placement: "balance_sheet" | "pnl" | null;
}

/**
 * ⚠ AUDIT SURFACES ONLY — the receipt line, the Undo confirmation, and
 * audit exports that must show the PRE-reconciliation source figures.
 *
 * Every analytical surface (ratios, valuation, exports' totals, facts,
 * chat grounding) MUST use `factsFrom()` — the ADJUSTED served figures.
 * Reading raw figures into an analytical surface silently re-opens the
 * exact disagreement class this gateway exists to make impossible; the
 * name is deliberately unwieldy so a misuse is visible in review.
 */
export function rawFactsForAuditOnly(statements: Statements): RawBsFactsForAuditOnly {
  const facts = factsFrom(statements);
  const c = facts.cents;
  const rec = facts.reconciliation();
  if (!rec || facts.status() !== "RECONCILED") {
    return {
      originalDifference: facts.difference(),
      totalAssets: facts.totalAssets(),
      totalEquity: facts.totalEquity(),
      totalLiabilities: facts.totalLiabilities(),
      equityPlusLiabilities: facts.equityPlusLiabilities(),
      appliedDelta: 0,
      placement: null,
    };
  }
  const deltaCents = centsOrNull(rec.applied_delta) ?? 0;
  const placement = rec.placement === "pnl" ? "pnl" : "balance_sheet";
  let assets = c.totalAssetsCents;
  let equity = c.totalEquityCents;
  let liabilities = c.totalLiabilitiesCents;
  // Reverse of the engine's _apply_adjustment: "pnl" adjusted equity via
  // the result row; BS placement adjusted current liabilities (delta > 0)
  // or current assets (delta < 0).
  if (placement === "pnl") equity -= deltaCents;
  else if (deltaCents > 0) liabilities -= deltaCents;
  else assets -= -deltaCents;
  return {
    originalDifference:
      typeof rec.original_difference === "number"
        ? rec.original_difference
        : toDisplay(assets - (equity + liabilities)),
    totalAssets: toDisplay(assets),
    totalEquity: toDisplay(equity),
    totalLiabilities: toDisplay(liabilities),
    equityPlusLiabilities: toDisplay(equity + liabilities),
    appliedDelta: toDisplay(deltaCents),
    placement,
  };
}

// ─── presentStatus — THE status presenter ───────────────────────────────
// One presenter for every surface that words the balance verdict: the BS
// chip (i18n keys), the HTML export footer and the Excel status cell
// (English strings from the same bsCanonicalStatusI18n wording table).
// Local status→wording ladders in those surfaces are deleted — a status
// the presenter doesn't know cannot be invented downstream.

export interface BsStatusPresentation {
  /** Machine token — what the API/export vocabulary says. RECONCILED is
   *  machine-distinct from BALANCED, always. Legacy → "UNVERIFIED". */
  machineStatus: "BALANCED" | "RECONCILED" | "MINOR_DRIFT" | "MATERIAL_IMBALANCE" | "UNVERIFIED";
  /** Presentation band the chip layouts branch on (decided HERE only). */
  band: "balanced" | "reconciled" | "needs_review" | "minor_drift" | "material_imbalance" | "unverified";
  /** Green chip family (BALANCED or RECONCILED) — a COLOR family only.
   *  sv1 locked invariant: the RECONCILED display STRING is never a
   *  'balanced'-family word (engine.serving.present_status). */
  balancedFamily: boolean;
  /** Engine presenter display — served `status_presentation` verbatim
   *  when stamped; FE mirror of the engine table otherwise. */
  displayKey: string;
  displayEn: string;
  displayRo: string;
  /** "auto-adjusted {X}" on RECONCILED / "needs review" — engine mirror. */
  microCaption: string | null;
  /** i18n key for the chip headline (bsCanonical.*). RECONCILED maps to
   *  `bsCanonical.status.reconciled` ("Reconciled"), NEVER the balanced
   *  sentence. */
  chipKey: string;
  /** i18n key for the RECONCILED micro-caption; null otherwise. */
  chipCaptionKey: string | null;
  /** Value for the Excel "Balance status" cell — the machine token
   *  (never 'balanced' wording on a RECONCILED period). */
  exportStatusCell: string;
  /** One-line English headline for export footers. */
  exportHeadline: string;
  /** English receipt/body line for export footers; null when silent. */
  exportDetail: string | null;
}

export interface PresentStatusInput {
  status: CanonicalBsStatus | null;
  needsReview?: boolean;
  reconciliation?: ServedReconciliation | null;
  mappingVersion?: string | null;
  /** Display units — the served difference (for drift sentences). */
  difference?: number;
  currency?: string;
  /** Engine-stamped presenter output (canonical_bs.status_presentation)
   *  — consumed verbatim as the display authority when present. */
  statusPresentation?: ServedStatusPresentation | null;
}

/** en-US money for export sentences (receipts keep cents — sub-1-RON
 *  reconciliation deltas must not print as "RON 0"). */
function moneyEn(n: number, currency: string, decimals = 2): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}${currency} ${Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? "");
}

/** FE mirror of the engine presenter table (src/engine/serving/status.py
 *  `_DISPLAY`) — used only when the served object carries no
 *  `status_presentation` stamp (pre-sv1 servings, undo responses). The
 *  strings are byte-identical to the engine's; the contract test pins the
 *  schema so a divergence fails loudly. */
function mirrorDisplay(
  machine: "BALANCED" | "RECONCILED" | "MINOR_DRIFT" | "MATERIAL_IMBALANCE",
): { key: string; en: string; ro: string } {
  const w = bsCanonicalEn.status;
  switch (machine) {
    case "BALANCED":
      return { key: "bs.status.balanced", en: w.balanced, ro: "Echilibrat" };
    case "RECONCILED":
      return { key: "bs.status.reconciled", en: w.reconciled, ro: "Reconciliat" };
    case "MINOR_DRIFT":
      return { key: "bs.status.minor_drift", en: w.minorDrift, ro: "Abatere minoră" };
    case "MATERIAL_IMBALANCE":
      return {
        key: "bs.status.material_imbalance",
        en: w.materialImbalance,
        ro: "Dezechilibru semnificativ",
      };
  }
}

/** Engine micro-caption format mirror (`"auto-adjusted %s" % "{:,.2f}"`). */
function mirrorMicroCaption(
  machine: string,
  needsReview: boolean,
  appliedDelta: number,
): string | null {
  if (machine === "RECONCILED") {
    return `auto-adjusted ${Math.abs(appliedDelta).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  if (machine === "MINOR_DRIFT" && needsReview) return "needs review";
  return null;
}

export function presentStatus(input: PresentStatusInput): BsStatusPresentation {
  const currency = input.currency ?? "RON";
  const diff = input.difference ?? 0;
  const w = bsCanonicalEn;

  if (input.status === null || input.status === undefined) {
    // Legacy period — no engine verdict exists; the export must not claim
    // one (and the chip never renders on this lane).
    return {
      machineStatus: "UNVERIFIED",
      band: "unverified",
      balancedFamily: false,
      displayKey: "bs.status.unknown",
      displayEn: "Not engine-verified",
      displayRo: "Neverificat de motor",
      microCaption: null,
      chipKey: "bsCanonical.minorDrift",
      chipCaptionKey: null,
      exportStatusCell: "UNVERIFIED",
      exportHeadline:
        "Balance check: not engine-verified (legacy period — totals from the persisted envelope).",
      exportDetail: null,
    };
  }

  // Display authority: the engine-stamped `status_presentation` verbatim
  // when served; the FE mirror of the same table otherwise. sv1 locked
  // invariant either way: RECONCILED never displays a 'balanced'-family
  // word — the disclosure is the auto-adjusted micro-caption.
  const sp = input.statusPresentation;
  const appliedDelta = input.reconciliation?.applied_delta ?? 0;
  const mirror = mirrorDisplay(input.status);
  const displayKey = sp?.display_key ?? mirror.key;
  const displayEn = sp?.display_en ?? mirror.en;
  const displayRo = sp?.display_ro ?? mirror.ro;
  const microCaption =
    sp !== null && sp !== undefined
      ? sp.micro_caption
      : mirrorMicroCaption(input.status, input.needsReview === true, appliedDelta);

  const base = { displayKey, displayEn, displayRo, microCaption };

  switch (input.status) {
    case "RECONCILED": {
      const rec = input.reconciliation ?? null;
      const applied = rec?.applied_delta ?? 0;
      const original = rec?.original_difference ?? applied;
      const placementWord =
        rec?.placement === "pnl" ? w.reconcile.placementPnl : w.reconcile.placementBs;
      const originWord =
        rec?.origin === "llm_proposed"
          ? w.reconcile.originLlm
          : w.reconcile.originDeterministic;
      const receiptLine = fill(w.reconcile.receipt, {
        amount: moneyEn(Math.abs(applied), currency),
        placement: placementWord,
        origin: originWord,
      });
      return {
        ...base,
        machineStatus: "RECONCILED",
        band: "reconciled",
        balancedFamily: true,
        chipKey: "bsCanonical.status.reconciled",
        chipCaptionKey: "bsCanonical.reconcile.autoAdjusted",
        exportStatusCell: "RECONCILED",
        exportHeadline: `Balance check: RECONCILED (${fill(w.reconcile.autoAdjusted, {
          amount: moneyEn(Math.abs(applied), currency),
        }).replace(/^·\s*/, "")}) — reconciled is not balanced.`,
        exportDetail:
          `A source imbalance of ${moneyEn(original, currency)} was closed by the visible ` +
          `adjusting line "${SYNTHETIC_ROW_LABEL}": ${receiptLine}` +
          `${rec?.applied_at ? ` · ${rec.applied_at}` : ""} · reversible` +
          `${input.mappingVersion ? ` · mapping ${input.mappingVersion}` : ""}.`,
      };
    }
    case "BALANCED":
      return {
        ...base,
        machineStatus: "BALANCED",
        band: "balanced",
        balancedFamily: true,
        chipKey: "bsCanonical.balanced",
        chipCaptionKey: null,
        exportStatusCell: "BALANCED",
        exportHeadline: `Balance check: ${w.balanced}${
          input.mappingVersion ? ` · mapping ${input.mappingVersion}` : ""
        }.`,
        exportDetail: null,
      };
    case "MINOR_DRIFT":
      if (input.needsReview) {
        return {
          ...base,
          machineStatus: "MINOR_DRIFT",
          band: "needs_review",
          balancedFamily: false,
          chipKey: "bsCanonical.reconcile.needsReview",
          chipCaptionKey: null,
          exportStatusCell: "MINOR_DRIFT",
          exportHeadline: `Balance check: ${w.minorDrift} — ${w.reconcile.needsReview}.`,
          exportDetail: `${w.difference}: ${moneyEn(diff, currency)}. ${w.reconcile.needsReviewBody}`,
        };
      }
      return {
        ...base,
        machineStatus: "MINOR_DRIFT",
        band: "minor_drift",
        balancedFamily: false,
        chipKey: "bsCanonical.minorDrift",
        chipCaptionKey: null,
        exportStatusCell: "MINOR_DRIFT",
        exportHeadline: `Balance check: ${w.minorDrift}.`,
        exportDetail: `${w.difference}: Assets − (Equity + Liabilities) = ${moneyEn(diff, currency)}.`,
      };
    case "MATERIAL_IMBALANCE":
    default:
      return {
        ...base,
        machineStatus: "MATERIAL_IMBALANCE",
        band: "material_imbalance",
        balancedFamily: false,
        chipKey: "bsCanonical.material",
        chipCaptionKey: null,
        exportStatusCell: "MATERIAL_IMBALANCE",
        exportHeadline: `Balance check: ${w.material}.`,
        exportDetail: `${w.materialBody} ${w.difference}: Assets − (Equity + Liabilities) = ${moneyEn(diff, currency)}.`,
      };
  }
}

// Re-exported so the receipt UI can type its props without importing the
// builder module (avoids a components→lib→components loop).
export type { CanonicalBsReconciliation };
