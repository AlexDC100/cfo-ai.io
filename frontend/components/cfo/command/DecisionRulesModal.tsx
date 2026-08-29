// DecisionRulesModal.tsx — multi-rule decision-rules modal.
//
// Layout
// ──────
//   • Header — title, subtitle, "Reset to defaults"
//   • Combination-mode selector (all_agree / worst_wins / weighted)
//   • A list of rule cards, one per RuleDefinition in the catalog.
//     Each card handles three availability states (Available / Partial
//     / Missing) with appropriate UI, an on/off toggle, the two-handle
//     slider when data is available, numeric inputs, and live per-rule
//     bucket counts.
//   • Footer — combined-distribution summary + Done button.
//
// Live binding stays the same: the store is the single source of
// truth; the Products page subscribes to the same store; every change
// here reflects on both surfaces synchronously.
//
// Deferred (tracked open items): histogram strip behind each slider,
// drag-to-reorder cards, "+ Add rule" picker (catalog already shows
// all rules so the picker is cosmetic until we have more rules than
// fit), per-card preview table, count-up animation. Weight sliders
// for the weighted mode ARE wired (visible only when mode === weighted).

import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Check, FileSpreadsheet, RotateCcw } from "lucide-react";

import { toast } from "@/components/ui/sonner";
import { isProductIndustry } from "@/components/cfo/workspace/wsSetI18n";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { FilterDropdown } from "@/components/ui/FilterDropdown";

import {
  DEFAULT_FINANCING,
  RULES,
  computeFinancingCost,
  countFinalBuckets,
  countPerRule,
  deriveBounds,
  getRuleAvailability,
  type BucketContext,
  type CombinationMode,
  type FinancingParams,
  type RuleDefinition,
  type RuleState,
  type SkuLite,
} from "@/lib/decisionRules";
import {
  applyPresetById,
  readActivePresetId,
  readDecisionRules,
  setActivePresetId,
  setCombinationMode,
  setFinancing,
  updateRuleState,
  useActivePresetId,
  useDecisionRules,
  writeDecisionRules,
} from "@/lib/decisionRulesStore";
import { PRESETS, getPreset, isStateDrifted } from "@/lib/presets";

interface ActiveDatasetPayload {
  active_dataset_id?: string | null;
}
interface DatasetSkusPayload {
  skus?: SkuLite[];
}

// Authenticated fetch against the engine — the SAME endpoints + query keys
// Products uses, so the two share one cache entry. These queries used to pass
// no queryFn at all (reading only whatever Products had cached), which
// (a) logged a TanStack "No queryFn" warning on every mount and (b) left the
// rules preview with zero SKUs unless the user had already visited /products
// this session. Null on any failure — the panel degrades to its no-data state.
const RULES_API_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";
async function fetchEngineJson<T>(path: string): Promise<T | null> {
  const { getSupabase } = await import("@/lib/supabase");
  const sb = getSupabase();
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  try {
    const r = await fetch(`${RULES_API_URL}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where to navigate the user when they close the modal via Done or
   *  backdrop dismiss. Default `/products` — that's where SKU-level
   *  results land. Pass `null` to disable navigation (modal stays put
   *  on whatever surface opened it). Added 2026-06-02 to fix the
   *  mobile-modal-trap bug where users couldn't find their way back
   *  to the Products list to see results of their rule changes. */
  returnTo?: string | null;
}

// CUR-FIX — `formatVal` now reads the global display currency from
// <CurrencyProvider> for any value whose unit is "RON" (the rules-engine
// emits values in source currency, defaulting to RON). When the user
// flips the TopHeader toggle the modal's threshold sliders + tooltips
// re-render in the new currency without a remount.
import { useCurrency } from "@/stores/currency";
import { formatMoneyFrom } from "@/lib/money";
import type { Currency } from "@/lib/rates";

function useFormatVal() {
  const { display, rates } = useCurrency();
  return (value: number, unit: string): string => {
    if (unit === "RON" || unit === "EUR" || unit === "USD") {
      // Rule thresholds are expressed in their stated source unit; convert
      // to whatever the user is viewing globally. `compact: true` keeps the
      // slider labels short ("12k €" / "1.2M RON").
      return formatMoneyFrom(value, unit as Currency, display, rates.rates, {
        compact: true,
      });
    }
    if (unit === "%") return `${value.toFixed(1)}%`;
    return `${value.toLocaleString("en-GB")} ${unit}`;
  };
}

/** @deprecated CUR-FIX — kept for rule-card sub-labels that aren't in the
 *  React tree yet. Prefer `useFormatVal()` from inside a component. */
function formatVal(value: number, unit: string): string {
  if (unit === "RON") {
    const abs = Math.abs(value);
    const sign = value < 0 ? "−" : "";
    if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M RON`;
    if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(0)}K RON`;
    return `${sign}${abs.toLocaleString("en-GB")} RON`;
  }
  if (unit === "%") return `${value.toFixed(1)}%`;
  return `${value.toLocaleString("en-GB")} ${unit}`;
}

export function DecisionRulesModal({ open, onOpenChange, returnTo = "/products" }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  // Snapshot of the rules store taken when the modal OPENS — edits apply
  // to the live store instantly, so "Revert" means "put back what was
  // active when I opened this dialog", not "reset to defaults" (that's
  // the header's Reset button).
  const openSnapshot = useRef<{
    state: ReturnType<typeof readDecisionRules>;
    presetId: string | null;
  } | null>(null);
  useEffect(() => {
    if (open) {
      openSnapshot.current = {
        state: readDecisionRules(),
        presetId: readActivePresetId(),
      };
    }
  }, [open]);

  const revertToOpenState = () => {
    const snap = openSnapshot.current;
    if (!snap) return;
    writeDecisionRules(snap.state);
    setActivePresetId(snap.presetId);
  };

  // Single close path. Used by the sticky Done buttons (top + bottom)
  // and by radix's onOpenChange (which fires on backdrop tap, swipe-down
  // dismiss, and Esc). Navigation is opt-out via returnTo={null}.
  const closeAndReturn = () => {
    onOpenChange(false);
    if (returnTo) {
      // Defer the navigate by a tick so radix can play the close anim
      // first — instant navigate while the dialog is dismissing causes
      // a layout snap on iOS Safari.
      setTimeout(() => navigate(returnTo), 0);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          onOpenChange(true);
        } else {
          // Swipe-down / backdrop tap / Esc → same path as the Done button.
          // Without this hook, users on mobile dismiss the modal and land
          // wherever they were (often Command Center root, NOT the Products
          // SKU list where they want to see results).
          closeAndReturn();
        }
      }}
    >
      <DialogContent
        className="
          max-w-[900px] p-0 gap-0
          inset-x-0 bottom-0 top-auto translate-x-0 translate-y-0
          w-full h-[88dvh] max-h-[88dvh] rounded-t-2xl rounded-b-none
          overflow-hidden
          flex flex-col
          data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom
          sm:inset-auto sm:top-1/2 sm:left-1/2 sm:bottom-auto
          sm:-translate-x-1/2 sm:-translate-y-1/2
          sm:w-[min(900px,calc(100vw-2rem))] sm:h-auto sm:max-h-[78vh]
          sm:rounded-[var(--radius-lg)]
          sm:data-[state=open]:slide-in-from-top-[48%] sm:data-[state=closed]:slide-out-to-top-[48%]
        "
        data-testid="decision-rules-modal"
      >
        {/* ── STICKY HEADER ─────────────────────────────────────────
             Always visible regardless of scroll. Left side: explicit
             back affordance with text on mobile (icon-only on narrow
             viewports would leave users guessing). Right side: reset.
             Done button moved to the sticky footer below for thumb-
             zone reachability.
         */}
        <DialogHeader
          className="
            shrink-0 px-4 sm:px-6 pb-3 border-b border-rule bg-surface z-10
            flex-row items-start justify-between gap-3
          "
          style={{ paddingTop: "max(20px, env(safe-area-inset-top))" }}
        >
          {/* "Back to Products" + "Reset to defaults" removed 2026-07-24
              — the footer's Revert/Apply pair (plus backdrop/Esc) covers
              both jobs. */}
          <div className="min-w-0 flex-1 text-center pt-1.5">
            <DialogTitle className="text-[15px] sm:text-[18px] text-ink font-semibold leading-tight truncate">
              {t("decision_rules.title", "Decision rules")}
            </DialogTitle>
            <DialogDescription className="hidden sm:block mt-1 text-[12.5px] text-ink-soft leading-snug">
              {t(
                "decision_rules.subtitle_multi",
                "Combine multiple rules to categorize SKUs. Changes apply instantly and are saved to this browser.",
              )}
            </DialogDescription>
          </div>
        </DialogHeader>

        {/* ── SCROLLABLE BODY ──────────────────────────────────────
             Mobile users see a brief subtitle here that was hidden
             from the header to keep the header height down on small
             screens. */}
        <div className="flex-1 overflow-y-auto">
          <p className="sm:hidden px-4 pt-3 pb-1 text-[11.5px] text-ink-soft leading-snug">
            {t(
              "decision_rules.subtitle_multi",
              "Combine multiple rules to categorize SKUs. Changes apply instantly and are saved to this browser.",
            )}
          </p>
          <div className="px-4 sm:px-6 py-5 sm:py-6">
            <DecisionRulesPanel />
          </div>
        </div>

        {/* ── STICKY FOOTER ─────────────────────────────────────────
             Thumb-zone primary action. Always reachable without
             scrolling. Same close-and-return behaviour as the back
             button, but framed as "see results" — that's what the
             user actually wants. Safe-area-inset preserves bottom
             reachability on devices with a home indicator. */}
        <footer
          className="
            shrink-0 border-t border-rule bg-surface
            px-4 sm:px-6 pt-3
            flex items-center justify-between gap-3
          "
          style={{ paddingBottom: "max(12px, env(safe-area-inset-bottom))" }}
        >
          <p className="text-[11.5px] text-ink-mute hidden sm:block flex-1 min-w-0">
            {t(
              "decision_rules.footer_note",
              "Changes apply instantly. Threshold values are saved to this browser.",
            )}
          </p>
          <span className="text-[11px] text-ink-mute sm:hidden flex-1 min-w-0 truncate">
            {t("decision_rules.changes_apply_instantly", "Changes apply instantly")}
          </span>
          <button
            type="button"
            onClick={revertToOpenState}
            data-testid="decision-rules-revert"
            className="
              shrink-0 inline-flex items-center gap-1.5
              h-11 sm:h-9 px-5 sm:px-4 rounded-full sm:rounded-lg
              text-[13px] sm:text-[12.5px] font-medium
              border border-rule bg-surface text-ink
              hover:bg-bg-2/60 hover:border-rule-strong transition-colors
              min-w-[44px]
            "
          >
            <RotateCcw size={12} strokeWidth={2} />
            {t("decision_rules.revert", "Revert")}
          </button>
          <button
            type="button"
            onClick={closeAndReturn}
            data-testid="decision-rules-done"
            className="
              shrink-0 inline-flex items-center gap-1.5
              h-11 sm:h-9 px-5 sm:px-4 rounded-full sm:rounded-lg
              text-[13px] sm:text-[12.5px] font-medium
              bg-ink text-paper hover:bg-ink/90 transition-colors
              min-w-[44px]
            "
          >
            {t("decision_rules.apply", "Apply")}
          </button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

// ─── DecisionRulesPanel ──────────────────────────────────────────────────────
//
// The decision-rules body WITHOUT any dialog chrome — preset picker,
// combination-mode selector, financing assumptions, rule cards, and the
// combined distribution. Rendered inside `DecisionRulesModal` above AND
// inline elsewhere (e.g. the Workspace onboarding step 2 and the Workspace
// Settings redesign) so the same controls appear in a plain page section,
// not a modal.
//
// 2026-08-04 (settings redesign):
//   · `industryKey` — when provided, the panel is CONDITIONAL: product
//     industries (fmcg, retail_ecom, manufacturing, agriculture, logistics)
//     get the full panel; everything else gets one compact "not applicable"
//     card with a change-industry link (`onChangeIndustryRequest`). Callers
//     that pass nothing (modal, onboarding wizard) keep the full panel.
//   · Rules whose data columns are missing no longer render per-card error
//     blocks with internal tokens ("gm_krn") — ONE friendly setup card lists
//     the human column names and links to the products template.
//   · `applyBar` — sticky bottom Apply/Discard bar that appears only while
//     the state differs from the snapshot taken on mount.
//   · `showFinancing={false}` lets the settings surface host the financing
//     assumptions in its own section without showing them twice.

/** Human names for the SKU columns the rules read — internal field tokens
 *  must NEVER reach the UI. */
const FIELD_COLUMN_KEYS: Record<string, string> = {
  gm_krn: "wsSet.columns.gm",
  niv_krn: "wsSet.columns.revenue",
  days_inventory_on_hand: "wsSet.columns.dio",
  volume_tons: "wsSet.columns.volume",
  gm_pct: "wsSet.columns.marginPct",
};

export function DecisionRulesPanel({
  industryKey,
  onChangeIndustryRequest,
  showFinancing = true,
  applyBar = false,
}: {
  /** Workspace industry key. Omit (undefined) to always show the full panel. */
  industryKey?: string | null;
  /** Invoked by the compact card's "Change industry" link. */
  onChangeIndustryRequest?: () => void;
  showFinancing?: boolean;
  applyBar?: boolean;
} = {}) {
  const { t } = useTranslation();
  const state = useDecisionRules();

  const { data: datasetsList } = useQuery<ActiveDatasetPayload | null>({
    queryKey: ["sales-datasets"],
    queryFn: () => fetchEngineJson<ActiveDatasetPayload>("/api/sales-datasets"),
  });
  const activeId = datasetsList?.active_dataset_id ?? null;
  const { data: dsPayload } = useQuery<DatasetSkusPayload | null>({
    queryKey: ["sales-dataset", activeId],
    queryFn: () => fetchEngineJson<DatasetSkusPayload>(`/api/sales-datasets/${activeId}/skus`),
    enabled: !!activeId,
  });
  const skus = useMemo<SkuLite[]>(() => dsPayload?.skus ?? [], [dsPayload]);

  // Threaded into compute() for rules that depend on user-tunable
  // assumptions (Adjusted GM% reads financing rate off here). Falls back to
  // DEFAULT_FINANCING for stores persisted before the field existed.
  const financing = state.financing ?? DEFAULT_FINANCING;
  const ctx: BucketContext = useMemo(() => ({ financing }), [financing]);
  const combined = useMemo(() => countFinalBuckets(skus, RULES, state, ctx), [skus, state, ctx]);
  const isWeighted = state.combinationMode === "weighted";
  const totalFinancingCost = useMemo(() => {
    let total = 0;
    for (const s of skus) {
      const fc = computeFinancingCost(s, financing);
      if (fc !== null) total += fc;
    }
    return total;
  }, [skus, financing]);

  // Availability split — rules with data render as cards; rules whose columns
  // are missing across the dataset are summarized by ONE setup card instead.
  const availabilities = useMemo(
    () => RULES.map((rule) => ({ rule, availability: getRuleAvailability(rule, skus) })),
    [skus],
  );
  const availableRules = availabilities.filter((a) => a.availability.status !== "missing");
  const missingRules = availabilities.filter((a) => a.availability.status === "missing");
  const missingColumns = useMemo(() => {
    const keys = new Set<string>();
    for (const m of missingRules) {
      for (const f of m.availability.missingFields) {
        keys.add(FIELD_COLUMN_KEYS[f as string] ?? "wsSet.columns.revenue");
      }
    }
    return [...keys].map((k) => t(k));
  }, [missingRules, t]);

  // Safety net (moved up from the per-card effect): a rule that is enabled
  // but has no data must not silently push every SKU to wind_down under
  // all_agree — force it off until the data arrives.
  useEffect(() => {
    for (const m of missingRules) {
      if (state.rules[m.rule.id]?.enabled) {
        updateRuleState(m.rule.id, { enabled: false });
      }
    }
  }, [missingRules, state.rules]);

  // Dirty tracking for the sticky Apply/Discard bar (settings surface only).
  // Edits still hit the live store instantly — the preview counts ARE the
  // point — so "Apply" adopts the current state as the new baseline and
  // "Discard" writes the baseline back through the store's existing API.
  const [baseline, setBaseline] = useState<{
    state: ReturnType<typeof readDecisionRules>;
    presetId: string | null;
  } | null>(() =>
    applyBar ? { state: readDecisionRules(), presetId: readActivePresetId() } : null,
  );
  const dirty =
    applyBar && baseline !== null && JSON.stringify(state) !== JSON.stringify(baseline.state);

  // Conditional surface — after all hooks so React's rules hold. Product
  // industries get the full panel; anything else (real estate, SaaS,
  // services, no industry yet) has no SKU catalog to classify.
  if (industryKey !== undefined && !isProductIndustry(industryKey)) {
    return (
      <div
        className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between"
        data-testid="wsset-rules-na"
      >
        <p className="text-[13px] text-ink-soft leading-relaxed">
          {t("wsSet.rules.notApplicable")}
        </p>
        {onChangeIndustryRequest && (
          <button
            type="button"
            onClick={onChangeIndustryRequest}
            data-testid="wsset-rules-change-industry"
            className="shrink-0 inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg border border-rule text-[12.5px] font-medium text-ink hover:bg-bg-2/60 hover:border-rule-strong transition-colors"
          >
            {t("wsSet.general.changeIndustry")}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-5">
      {/* Preset · Combination logic — side by side; Financing assumptions
          sits full-width below the grid. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
      {/* Preset picker — one-click rule packages with percentile-based
          thresholds so the chosen preset behaves sensibly on any dataset. */}
      <PresetPicker skus={skus} />

      {/* Combination-mode selector */}
      <section>
        <label
          htmlFor="dr-mode"
          className="block text-[11px] uppercase tracking-[0.12em] text-ink-mute font-semibold mb-1.5"
        >
          {t("decision_rules.combination_logic", "Combination logic")}
        </label>
        {/* Shared pill dropdown (2026-07-26 per operator) — the same control
            the Products filters use, replacing the native <select> that
            rendered with the OS widget and ignored the design tokens. */}
        <FilterDropdown
          id="dr-mode"
          fullWidth
          value={state.combinationMode}
          onChange={(v) => setCombinationMode(v as CombinationMode)}
          testid="decision-rules-mode"
          placeholder={t("decision_rules.combination_logic", "Combination logic")}
          options={[
            {
              value: "worst_wins",
              label: t("decision_rules.mode.worst_wins", "Worst bucket wins (recommended)"),
            },
            {
              value: "all_agree",
              label: t("decision_rules.mode.all_agree", "All must agree (most conservative)"),
            },
            {
              value: "weighted",
              label: t("decision_rules.mode.weighted", "Weighted score"),
            },
          ]}
        />
        <p className="mt-1.5 text-[11.5px] text-ink-soft">
          {state.combinationMode === "worst_wins" &&
            t(
              "decision_rules.mode.worst_wins_hint",
              "If any rule flags a SKU for Wind down, the SKU is Wind down. Recommended.",
            )}
          {state.combinationMode === "all_agree" &&
            t(
              "decision_rules.mode.all_agree_hint",
              "Protect requires every active rule to agree. Most conservative.",
            )}
          {state.combinationMode === "weighted" &&
            t(
              "decision_rules.mode.weighted_hint",
              "Each rule contributes a score, weighted average decides the final bucket.",
            )}
        </p>
      </section>
      </div>

      {/* Financing assumptions — applied to the Adjusted GM% rule below.
          Full-width, under the Preset/Combination grid. Hidden when the host
          surface (Workspace Settings) shows them in its own section. */}
      {showFinancing && (
        <FinancingSection
          financing={financing}
          totalCost={totalFinancingCost}
          skuCount={skus.length}
        />
      )}

      {/* ONE friendly setup card for every rule whose data columns are
          missing — human column names only, never internal field tokens. */}
      {missingRules.length > 0 && (
        <section
          className="rounded-xl border border-rule bg-bg-2/30 px-4 py-4 flex flex-col sm:flex-row sm:items-center gap-3"
          data-testid="wsset-rules-setup"
        >
          <span className="grid place-items-center h-9 w-9 shrink-0 rounded-lg bg-brand/10 text-brand-d">
            <FileSpreadsheet size={17} strokeWidth={1.75} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-ink">{t("wsSet.rules.setupTitle")}</p>
            <p className="text-[12px] text-ink-soft leading-snug mt-0.5">
              {t("wsSet.rules.setupBody", { columns: missingColumns.join(", ") })}
            </p>
          </div>
          <Link
            to="/products"
            data-testid="wsset-rules-see-format"
            className="shrink-0 inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg border border-brand/40 text-[12.5px] font-medium text-ink hover:border-brand/60 hover:bg-brand/10 transition-colors"
          >
            {t("wsSet.rules.seeFormat")}
          </Link>
        </section>
      )}

      {/* Rule cards — in a grid so the metric previews sit side by side. */}
      {availableRules.length > 0 && (
        <section className="grid grid-cols-1 md:grid-cols-2 gap-3 items-start">
          {availableRules.map(({ rule }) => (
            <RuleCard
              key={rule.id}
              rule={rule}
              ruleState={state.rules[rule.id]!}
              skus={skus}
              showWeight={isWeighted}
              ctx={ctx}
            />
          ))}
        </section>
      )}

      {/* Sticky Apply/Discard bar — settings surface only, shown only while
          dirty. Edits are live; Apply adopts them as the saved baseline,
          Discard restores the snapshot through the store's existing API. */}
      {dirty && baseline !== null && (
        <div
          className="sticky bottom-3 z-10 flex items-center gap-3 rounded-xl border border-rule bg-surface/95 backdrop-blur-sm px-4 py-3 shadow-[0_12px_40px_-16px_rgba(0,0,0,0.6)]"
          data-testid="wsset-rules-applybar"
        >
          <span className="flex-1 min-w-0 truncate text-[12px] text-amber-500 font-medium">
            {t("wsSet.rules.unsaved")}
          </span>
          <button
            type="button"
            onClick={() => {
              writeDecisionRules(baseline.state);
              setActivePresetId(baseline.presetId);
              toast.success(t("wsSet.rules.discarded"));
            }}
            data-testid="wsset-rules-discard"
            className="shrink-0 inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg border border-rule text-[12.5px] font-medium text-ink hover:bg-bg-2/60 transition-colors"
          >
            {t("wsSet.rules.discard")}
          </button>
          <button
            type="button"
            onClick={() => {
              setBaseline({ state: readDecisionRules(), presetId: readActivePresetId() });
              toast.success(t("wsSet.rules.applied"));
            }}
            data-testid="wsset-rules-apply"
            className="shrink-0 inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg ask-ai-anim-fill [animation-duration:10s] border border-brand/40 text-[12.5px] font-medium text-ink hover:border-brand/60 transition-colors"
          >
            <Check size={14} strokeWidth={2} />
            {t("ws.applyChanges")}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Rule card ──────────────────────────────────────────────────────────────

function RuleCard({
  rule,
  ruleState,
  skus,
  showWeight,
  ctx,
}: {
  rule: RuleDefinition;
  ruleState: RuleState;
  skus: readonly SkuLite[];
  showWeight: boolean;
  ctx: BucketContext;
}) {
  const { t } = useTranslation();
  // CUR-FIX — currency-aware formatter for the Range hint (lines 453-ish).
  const formatVal = useFormatVal();
  const availability = useMemo(() => getRuleAvailability(rule, skus), [rule, skus]);
  const bounds = useMemo(() => deriveBounds(rule, skus), [rule, skus]);
  const perRule = useMemo(
    () => countPerRule(rule, ruleState, skus, ctx),
    [rule, ruleState, skus, ctx],
  );

  // (The missing-data auto-disable safety moved up to DecisionRulesPanel —
  // rules without data no longer render a card at all.)

  const unit = t(rule.unitKey, rule.unitDefault);
  const label = t(rule.labelKey, rule.labelDefault);

  // A disabled rule is a CHOICE, not an unavailable feature (2026-07-26 per
  // operator): dimming the whole card — header, label and toggle included —
  // read as "this isn't available to you". Now the header stays at full
  // contrast, the card stays expanded, and only the controls blur out, so the
  // card still shows what it would configure and the toggle that brings it
  // back is the most legible thing on it.
  const off = !ruleState.enabled && availability.status !== "missing";

  return (
    <div
      data-testid={`rule-card-${rule.id}`}
      data-availability={availability.status}
      data-rule-off={off ? "true" : "false"}
      className="rounded-xl border border-rule bg-surface"
    >
      <div className="px-4 py-3 flex items-center gap-3 border-b border-rule/50">
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium text-ink leading-tight">
            {label}
            <span className="ml-1.5 text-[11px] text-ink-mute font-normal">({unit})</span>
            {rule.direction === "lower_better" && (
              <span className="ml-1.5 text-[10px] uppercase tracking-[0.08em] text-ink-mute">
                ↓ {t("decision_rules.lower_better", "lower is better")}
              </span>
            )}
          </div>
          {availability.status === "partial" && (
            <div className="mt-1 text-[11px] text-brand">
              {t("decision_rules.partial_coverage", "Available for {{covered}} of {{total}} SKUs", {
                covered: availability.coveredCount.toLocaleString("en-GB"),
                total:   availability.totalCount.toLocaleString("en-GB"),
              })}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* Threshold value chips — the two cutoffs at a glance. */}
          {!off && (
            <span
              className="hidden sm:inline-flex items-center gap-1 text-[10.5px] tabular-nums"
              data-testid={`wsset-rule-chips-${rule.id}`}
            >
              <span className="rounded-md border border-rule bg-bg-2/60 px-1.5 py-0.5 text-ink-soft">
                {formatVal(ruleState.thresholds[0], unit)}
              </span>
              <span className="text-ink-mute">–</span>
              <span className="rounded-md border border-rule bg-bg-2/60 px-1.5 py-0.5 text-ink-soft">
                {formatVal(ruleState.thresholds[1], unit)}
              </span>
            </span>
          )}
          {off && (
            <span className="text-[10.5px] uppercase tracking-[0.1em] font-semibold text-ink-soft">
              {t("decision_rules.rule_off", "Off")}
            </span>
          )}
          <ToggleSwitch
            checked={ruleState.enabled}
            disabled={availability.status === "missing"}
            onChange={(v) => updateRuleState(rule.id, { enabled: v })}
            testId={`rule-toggle-${rule.id}`}
          />
        </div>
      </div>

      {(
        (
          <div
            aria-hidden={off}
            className={`px-4 py-3 space-y-3 transition-[filter,opacity] duration-200 ${
              off ? "blur-[2px] opacity-45 pointer-events-none select-none" : ""
            }`}
          >
            <Slider
              min={bounds.min}
              max={bounds.max}
              step={bounds.step}
              value={[ruleState.thresholds[0], ruleState.thresholds[1]]}
              onValueChange={(v) => {
                if (v.length < 2) return;
                let [lo, hi] = [v[0]!, v[1]!];
                if (lo > hi) [lo, hi] = [hi, lo];
                updateRuleState(rule.id, { thresholds: [lo, hi] });
              }}
              aria-label={`${label} ${t("decision_rules.slider_aria", "Bucket cutoffs")}`}
              data-testid={`rule-slider-${rule.id}`}
              className="my-1"
            />
            <div className="grid grid-cols-2 gap-3">
              <NumericInput
                label={
                  rule.direction === "higher_better"
                    ? t("decision_rules.lower_cutoff", "Wind down ⟶ Watch")
                    : t("decision_rules.upper_cutoff_inv", "Protect ⟶ Watch")
                }
                value={ruleState.thresholds[0]}
                bounds={bounds}
                onCommit={(v) =>
                  updateRuleState(rule.id, {
                    thresholds: [Math.min(v, ruleState.thresholds[1]), ruleState.thresholds[1]],
                  })
                }
                testId={`rule-input-lo-${rule.id}`}
              />
              <NumericInput
                label={
                  rule.direction === "higher_better"
                    ? t("decision_rules.upper_cutoff", "Watch ⟶ Protect")
                    : t("decision_rules.lower_cutoff_inv", "Watch ⟶ Wind down")
                }
                value={ruleState.thresholds[1]}
                bounds={bounds}
                onCommit={(v) =>
                  updateRuleState(rule.id, {
                    thresholds: [ruleState.thresholds[0], Math.max(v, ruleState.thresholds[0])],
                  })
                }
                testId={`rule-input-hi-${rule.id}`}
              />
            </div>
            <div className="flex items-baseline gap-4 flex-wrap text-[11.5px] text-ink-soft tabular-nums">
              <span><span className="inline-block w-2 h-2 rounded-full bg-brand mr-1.5 align-baseline" />{t("buckets.wind_down","Wind down")}: <span className="text-ink font-medium">{perRule.wind_down}</span></span>
              <span><span className="inline-block w-2 h-2 rounded-full bg-brand mr-1.5 align-baseline" />{t("buckets.watch","Watch")}: <span className="text-ink font-medium">{perRule.watch}</span></span>
              <span><span className="inline-block w-2 h-2 rounded-full bg-brand mr-1.5 align-baseline" />{t("buckets.protect","Protect")}: <span className="text-ink font-medium">{perRule.protect}</span></span>
              <span className="ml-auto text-[10.5px] text-ink-mute">
                {t("decision_rules.range_hint", "Range")}: {formatVal(bounds.min, unit)} – {formatVal(bounds.max, unit)}
              </span>
            </div>
            {showWeight && (
              <div>
                <label className="block text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-semibold mb-1">
                  {t("decision_rules.weight", "Weight")}: <span className="text-ink">{ruleState.weight}</span>
                </label>
                <input
                  type="range"
                  min={0}
                  max={10}
                  step={1}
                  value={ruleState.weight}
                  onChange={(e) => {
                    const v = parseFloat(e.currentTarget.value);
                    if (Number.isFinite(v)) updateRuleState(rule.id, { weight: v });
                  }}
                  data-testid={`rule-weight-${rule.id}`}
                  className="w-full h-1.5 rounded-full appearance-none cursor-pointer bg-rule"
                />
              </div>
            )}
          </div>
        )
      )}
    </div>
  );
}

// MissingDataNotice removed 2026-08-04 — rules without data are summarized
// by the panel-level setup card (human column names, no internal tokens).

function ToggleSwitch({
  checked,
  disabled,
  onChange,
  testId,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      data-testid={testId}
      className={`
        relative inline-flex h-5 w-9 shrink-0 items-center rounded-full
        border transition-colors
        ${checked && !disabled
          ? "bg-brand border-brand"
          : "bg-bg-2 border-rule-strong hover:border-brand/50"}
        ${disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}
      `}
    >
      <span
        className={`
          inline-block h-4 w-4 rounded-full shadow transform transition-transform
          ${checked ? "bg-surface" : "bg-ink-mute"}
          ${checked ? "translate-x-[18px]" : "translate-x-0.5"}
        `}
      />
    </button>
  );
}

function NumericInput({
  label,
  value,
  bounds,
  onCommit,
  testId,
}: {
  label: string;
  value: number;
  bounds: { min: number; max: number; step: number };
  onCommit: (v: number) => void;
  testId?: string;
}) {
  return (
    <label className="block">
      <span className="block text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-semibold mb-1">
        {label}
      </span>
      <input
        type="number"
        value={value}
        min={bounds.min}
        max={bounds.max}
        step={bounds.step}
        onChange={(e) => {
          const v = parseFloat(e.currentTarget.value);
          if (Number.isFinite(v)) onCommit(Math.max(bounds.min, Math.min(bounds.max, v)));
        }}
        data-testid={testId}
        className="
          w-full h-9 px-3 rounded-lg
          border border-rule bg-surface
          text-[13px] tabular-nums text-ink
          focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand-d/40
        "
      />
    </label>
  );
}

/**
 * PresetPicker — dropdown of canned rule packages. Selecting a preset +
 * clicking Apply writes the full DecisionRulesState atomically (all
 * rules, thresholds, financing, combination mode in one shot) — which
 * via useSyncExternalStore re-renders the rest of the modal + the
 * Products page in lock-step.
 *
 * Drift detection: once a preset is applied, if the operator drags any
 * threshold, the label shows "Preset · modified" so they know they've
 * left the recipe behind.
 *
 * Default behaviour: when no preset has ever been applied (first visit),
 * the dropdown shows "— Pick a preset —" with the first preset
 * (logical_default) highlighted in the dropdown. Apply still requires
 * an explicit click so the operator opts in.
 */
function PresetPicker({ skus }: { skus: readonly SkuLite[] }) {
  const { t } = useTranslation();
  const state = useDecisionRules();
  const activePresetId = useActivePresetId();
  const [selected, setSelected] = useState<string>(activePresetId ?? PRESETS[0]!.id);

  // Keep dropdown in sync when an external action (a different tab,
  // resetDecisionRulesToDefaults) changes the active preset.
  useEffect(() => {
    if (activePresetId && activePresetId !== selected) {
      setSelected(activePresetId);
    }
  }, [activePresetId]);

  const drifted = useMemo(() => {
    if (!activePresetId) return false;
    return isStateDrifted(state, activePresetId, skus);
  }, [state, activePresetId, skus]);

  // Localized preset copy — the catalog's English label/description are the
  // t() fallbacks, so an unknown future preset still renders something.
  const presetLabel = (id: string) =>
    t(`wsSet.presets.${id}.label`, getPreset(id)?.label ?? id);
  const presetDesc = (id: string) =>
    t(`wsSet.presets.${id}.desc`, getPreset(id)?.description ?? "");

  const previewPreset = getPreset(selected);
  const activePresetLabel = activePresetId
    ? `${presetLabel(activePresetId)}${drifted ? ` · ${t("wsSet.rules.modified")}` : ""}`
    : null;

  // The explicit "Apply preset" button (and its needs-data hint) was
  // removed 2026-07-24 — picking a preset in the dropdown applies it
  // immediately (no-op while no dataset is loaded, since percentile
  // thresholds need SKU data).

  return (
    <section className="space-y-3" data-testid="preset-picker">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 className="text-[11px] uppercase tracking-[0.12em] text-ink-mute font-semibold">
          {t("decision_rules.preset.title", "Preset")}
        </h3>
        {activePresetLabel && (
          <span
            className={`text-[11px] tabular-nums ${drifted ? "text-brand" : "text-ink-mute"}`}
            data-testid="preset-active-label"
          >
            {t("decision_rules.preset.active", "Active")}: <span className="font-medium">{activePresetLabel}</span>
          </span>
        )}
      </div>

      <div className="flex flex-col gap-2">
        {/* Shared pill dropdown — see the combination-mode selector above.
            Each preset carries its description into the menu, so the
            trade-off is visible while choosing rather than only after. */}
        <FilterDropdown
          fullWidth
          value={selected}
          onChange={(id) => {
            setSelected(id);
            applyPresetById(id, skus);
          }}
          testid="preset-select"
          placeholder={t("decision_rules.preset.title", "Preset")}
          options={PRESETS.map((p) => ({
            value: p.id,
            label: presetLabel(p.id),
            description: presetDesc(p.id),
          }))}
        />
        {previewPreset && (
          <p className="text-[11.5px] text-ink-soft leading-snug">
            {presetDesc(previewPreset.id)}
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * FinancingSection — two-slider block at the top of the modal exposing
 * the working-capital financing assumptions used by the Adjusted-GM
 * rule. Reads + writes via setFinancing() so every drag tick rebuckets
 * the portfolio via the shared useSyncExternalStore path.
 *
 * Shows the derived total annual rate + portfolio financing cost summary
 * so the operator can see the impact live before scrolling down to the
 * rule cards.
 */
function FinancingSection({
  financing,
  totalCost,
  skuCount,
}: {
  financing: FinancingParams;
  totalCost: number;
  skuCount: number;
}) {
  const { t } = useTranslation();
  const totalRate = (financing.costOfFinancing ?? 0) + (financing.bankSpread ?? 0);
  const avgCost = skuCount > 0 ? totalCost / skuCount : 0;

  // CUR-FIX — financing-section monetary values now route through the
  // global currency switcher. SKU money is denominated in source RON;
  // we hand it to `formatMoneyFrom` with the active display so toggling
  // EUR/USD in TopHeader updates the "Portfolio cost" + "Avg per SKU"
  // figures live without remounting the modal.
  const { display, rates } = useCurrency();
  function fmtRon(n: number): string {
    return formatMoneyFrom(n, "RON", display, rates.rates, { compact: true });
  }

  return (
    <section
      className="border-t border-rule/60 pt-4 space-y-3"
      data-testid="financing-section"
    >
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 className="text-[11px] uppercase tracking-[0.12em] text-ink-mute font-semibold">
          {t("decision_rules.financing.title", "Financing assumptions")}
        </h3>
        <div className="flex items-baseline gap-3 text-[11.5px] text-ink-soft tabular-nums">
          <span>
            {t("decision_rules.financing.total_rate", "Total annual rate")}:{" "}
            <span className="text-ink font-medium">{totalRate.toFixed(1)}%</span>
          </span>
          <span>
            {t("decision_rules.financing.portfolio_cost", "Portfolio cost")}:{" "}
            <span className="text-ink font-medium">{fmtRon(totalCost)}</span>
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-3">
        <FinancingSlider
          label={t("decision_rules.financing.cost_label", "Cost of financing")}
          hint={t(
            "decision_rules.financing.cost_hint",
            "Annual interest rate on working capital. Typical RON corporate financing is 5–8%.",
          )}
          value={financing.costOfFinancing}
          min={0}
          max={20}
          step={0.1}
          onCommit={(v) => setFinancing({ costOfFinancing: v })}
          testId="financing-cost-of-financing"
        />
        <FinancingSlider
          label={t("decision_rules.financing.spread_label", "Bank margin spread")}
          hint={t(
            "decision_rules.financing.spread_hint",
            "Additional spread above the base rate the bank charges. Tune to model different banking relationships.",
          )}
          value={financing.bankSpread}
          min={0}
          max={10}
          step={0.1}
          onCommit={(v) => setFinancing({ bankSpread: v })}
          testId="financing-bank-spread"
        />
      </div>

      {skuCount > 0 && totalCost > 0 && (
        <p className="text-[11px] text-ink-mute">
          {t(
            "decision_rules.financing.avg_per_sku",
            "Avg per SKU: {{avg}} · DIO and inventory required to compute; SKUs without either skip the financing rule.",
            { avg: fmtRon(avgCost) },
          )}
        </p>
      )}
    </section>
  );
}

function FinancingSlider({
  label,
  hint,
  value,
  min,
  max,
  step,
  onCommit,
  testId,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onCommit: (v: number) => void;
  testId?: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <label
          htmlFor={testId}
          className="text-[12px] text-ink font-medium"
          title={hint}
        >
          {label}
        </label>
        <span className="font-mono text-[12px] tabular-nums text-brand-d">
          {value.toFixed(1)}%
        </span>
      </div>
      <Slider
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={(v) => {
          if (v.length > 0 && Number.isFinite(v[0])) onCommit(v[0]!);
        }}
        aria-label={label}
        data-testid={testId}
        className="my-1"
      />
      <p className="text-[10.5px] text-ink-mute leading-snug">{hint}</p>
    </div>
  );
}

function FinalCount({ label, count, dot }: { label: string; count: number; dot: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className={`inline-block w-2 h-2 rounded-full ${dot}`} aria-hidden />
      <span className="text-[12px] text-ink-soft">{label}:</span>
      <span className="text-[16px] font-semibold tabular-nums text-ink">
        {count.toLocaleString("en-GB")}
      </span>
    </span>
  );
}
