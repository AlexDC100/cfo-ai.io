// Benchmark Report — compares the active period's metrics against
// industry-typical percentiles for the company's confirmed CAEN code.
//
// Reads from `/api/benchmarks/report/{period_id}` — that endpoint
// composes calculated_metrics + statement_line_items + the benchmark
// catalogue into a structured payload. Front-end is purely
// presentational: section tiles, comparison tables, verdict badges,
// and the mandatory "Estimated typical" disclosure.
//
// Errors are surfaced honestly: "caen_not_set" prompts the user to
// confirm industry; "benchmarks_not_available" tells them the CAEN
// isn't in our catalogue yet.

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle, BarChart3, Info, Layers as LayersIcon, LineChart, Loader2, ShieldAlert } from "lucide-react";

import { Money } from "@/components/ui/Money";
// 2026-05-24 — first-time `caen_not_set` gate now opens IndustryPicker too
// (not the legacy IndustryConfirmModal). Operator feedback: the legacy
// modal's bare <select> dropdown was hard to use, didn't surface
// available industries clearly, and frequently rendered with an empty
// catalog when the back-end returned no rows. IndustryPicker has search,
// grouped catalog, single-click save + auto-close, internal-brand notes,
// and error humanisation — everything the legacy modal lacked. The
// legacy component is left in src/ as quiet dead code; no remaining
// callers in this codebase.
import { IndustryBadge, IndustryPicker } from "@/components/cfo/industry";
import { Level1BenchmarkView } from "@/components/cfo/Level1BenchmarkView";
import { EmptyState } from "@/components/cfo/ui/EmptyState";
import { PageHeader } from "@/components/cfo/ui/PageHeader";
import { GuideMeButton } from "@/components/learning/GuideMeButton";
import { BENCHMARK_GUIDE } from "@/components/learning/pageGuides";
import { LearnableMetricCard } from "@/components/learning/LearnableMetricCard";
import { LearnableRowLabel } from "@/components/learning/LearnableRowLabel";
import { benchmarkMetricToConcept } from "@/lib/learning/benchmarkMetricToConcept";
import { getSupabase } from "@/lib/supabase";
import { useActivePeriodFallback } from "@/hooks/useActivePeriodFallback";
import { PUBLIC_RECORDS_ENABLED } from "@/config/features";

// ─── Types (mirror the backend payload from _benchmark_engine.py) ───────────

type Verdict =
  | "top_quartile"
  | "above_median"
  | "below_median"
  | "bottom_quartile"
  | "not_available";

interface Display {
  ro: string;
  en: string;
  fmt?: "currency" | "pct" | "ratio";
}

interface Benchmark {
  p25: number | null;
  p50: number | null;
  p75: number | null;
  unit: string | null;
  source: string | null;
  notes: string | null;
  /** Year the benchmark sample was drawn from. Surfaced on the FE row so
   *  the user can see they're comparing FY2025 against FY2023 data if
   *  that's the case. */
  source_year?: number | null;
  /** Trust tier: `verified` (audited public filings / Eurostat SBS),
   *  `directional` (internal pattern derived from a small sample of
   *  Romanian peers), `estimated` (constructed from sector heuristics).
   *  Drives the confidence chip + colour code shown next to every
   *  comparison row. Without this label the product looks like it
   *  invents numbers — the warning the user explicitly flagged. */
  confidence?: "verified" | "directional" | "estimated" | string | null;
}

interface Comparison {
  metric_name: string;
  display: Display;
  company_value: number | null;
  benchmark: Benchmark;
  verdict: Verdict;
  gap_pp: number | null;
  lower_is_better: boolean;
}

interface HeadlineSection {
  title_ro: string;
  title_en: string;
  metrics: string[];
  company_values: Record<string, number | null>;
  display: Record<string, Display>;
}

interface ComparisonSection {
  title_ro: string;
  title_en: string;
  comparisons: Comparison[];
}

// Deep-analysis payload (Phase 7b). Optional — the API returns
// `deep: null` when no peer/leader data has been seeded for the
// active CAEN, in which case the FE just renders the percentile
// sections below.
interface DeepPeer {
  company_name: string;
  fiscal_year: number | null;
  revenue_mlei: number | null;
  net_profit_mlei: number | null;
  net_margin_pct: number | null;
  ebitda_margin_pct: number | null;
  equity_ratio_pct: number | null;
  debt_to_equity: number | null;
  specialization: string | null;
  tier: "leader" | "strong" | "median" | "thin_margin" | "distressed" | "self";
  source: string | null;
  display_order: number | null;
}

interface DeepReason {
  rank: number;
  title: string;
  description: string;
  margin_impact_pp: number | null;
  evidence_source: string | null;
}

interface DeepGapRow {
  key: string;
  label: string;
  unit: "pct" | "ratio";
  company_value: number;
  leader_value: number;
  gap: number;
  favorable: boolean;
}

interface TargetTier {
  net_margin_pct: number;
  ebitda_margin_pct: number;
  label: string;
  comment: string;
}

interface DeepReport {
  leader_company: string | null;
  leader_year: number | null;
  leader_revenue_mlei: number | null;
  leader_net_margin_pct: number | null;
  leader_specialization: string | null;
  peers: DeepPeer[];
  leader_reasons: DeepReason[];
  leader_total_impact_pp: number;
  gap_vs_leader: DeepGapRow[];
  target_tiers: {
    aspirational?: TargetTier;
    realistic?: TargetTier;
    minimum_viable?: TargetTier;
  } | null;
  dynamics: Record<string, { verdict: string; detail: string }> | null;
  success_patterns: string[];
  failure_modes: string[];
  market_context: string | null;
}

interface Report {
  period_id: string;
  caen_code: string;
  caen_label: string;
  industry_category: string;
  disclosure: string;
  sections: {
    headline: HeadlineSection;
    profitability?: ComparisonSection;
    cost_structure?: ComparisonSection;
    capital_structure?: ComparisonSection;
  };
  deep: DeepReport | null;
  company_metrics_raw?: Record<string, number>;
  cached?: boolean;
  generated_at?: string;
}

interface ApiError {
  error: "caen_not_set" | "benchmarks_not_available" | "period_not_found";
  message: string;
  period_id?: string;
  caen_code?: string;
  org_id?: string;
}

// ─── API helpers ────────────────────────────────────────────────────────────

const apiBase = (): string =>
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";

async function authHeaders(): Promise<Record<string, string> | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : null;
}

async function fetchReport(periodId: string): Promise<Report | ApiError | null> {
  try {
    const h = await authHeaders();
    if (!h) return { error: "caen_not_set", message: "Not signed in." };
    const r = await fetch(`${apiBase()}/api/benchmarks/report/${periodId}`, { headers: h });
    if (r.status === 404) {
      // Special sentinel — the period_id in the URL doesn't correspond
      // to a real financial_period (e.g. user has only public-records
      // uploads, but a stale `?period=<id>` was passed). Caller falls
      // through to the Level-1 view.
      return { error: "period_not_found", message: "Period not found." };
    }
    if (!r.ok) {
      // Surface backend errors as ApiError so the page renders a message
      // instead of hanging on the loading spinner. Without this, a 500
      // (e.g. missing DB column / RLS misconfig) would silently leave
      // the user stuck.
      const bodyText = await r.text().catch(() => "");
      return {
        error: "benchmarks_not_available",
        message: `Benchmark API returned ${r.status}. ${bodyText.slice(0, 200)}`,
      };
    }
    return (await r.json()) as Report | ApiError;
  } catch (e) {
    return {
      error: "benchmarks_not_available",
      message: `Couldn't reach the benchmark API: ${(e as Error).message}`,
    };
  }
}

// ─── Formatters ─────────────────────────────────────────────────────────────
// Money formatting now flows through the canonical <Money> component so the
// global RON/EUR/USD toggle converts benchmark + headline tiles uniformly.
// Sector benchmark percentiles are stored as Romanian-sector RON values,
// so the source currency is always RON here.

function formatPct(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${value.toFixed(1)}%`;
}

function formatRatio(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${value.toFixed(2)}×`;
}

function formatValue(value: number | null | undefined, unit: string | null | undefined): React.ReactNode {
  if (value === null || value === undefined) return "—";
  if (unit === "pct") return formatPct(value);
  if (unit === "ratio") return formatRatio(value);
  return <Money value={value} fromCurrency="RON" compact />;
}

// ─── Sanity check: detect obvious CAEN mismatches ──────────────────────────
//
// When the auto-classifier picks the wrong industry (or the user uploads a
// new period that drifted away from the prior CAEN), the comparison
// numbers can be nonsense — e.g. a real-estate firm being compared
// against meat-processing percentile bands. This helper looks at the
// percentile-comparison sections (cost structure + profitability), counts
// metrics whose `company_value` sits more than 30pp away from the
// industry P50, and surfaces a warning when 3+ are dramatically off.
//
// 30pp is a deliberately conservative threshold — small natural variance
// across well-classified companies stays well under it, while EEI-against-
// meat-products (0% COGS vs 58% median, 3% personnel vs 13% median, etc.)
// blows past it on 4-5 lines.

function detectClassificationMismatch(report: Report): { mismatch: boolean; reason: string } {
  const all: Comparison[] = [];
  if (report.sections.cost_structure) all.push(...report.sections.cost_structure.comparisons);
  if (report.sections.profitability) all.push(...report.sections.profitability.comparisons);

  const extremeMetrics: string[] = [];
  for (const c of all) {
    if (c.company_value === null || c.benchmark.p50 === null) continue;
    if (c.benchmark.unit !== "pct") continue;  // only flag percentage metrics
    const gap = Math.abs(c.company_value - c.benchmark.p50);
    if (gap > 30) {
      extremeMetrics.push(c.display.en);
    }
  }

  if (extremeMetrics.length >= 3) {
    const sample = extremeMetrics.slice(0, 3).join(", ");
    return {
      mismatch: true,
      reason: `Your company's numbers differ sharply from typical ${extremeMetrics.length} metrics for this industry (${sample}${extremeMetrics.length > 3 ? "…" : ""}). You probably picked the wrong industry.`,
    };
  }
  return { mismatch: false, reason: "" };
}

// ─── Page ───────────────────────────────────────────────────────────────────

// Module-level cache of the benchmark report, keyed by period id. Benchmark
// fetches manually (not via React Query), so without this the report refetched
// — and flashed the loader — on every visit. Seeding component state from this
// cache makes re-opening /benchmark instant; the fetch still runs in the
// background to pick up any changes.
const reportCache = new Map<string, Report | ApiError>();

export default function BenchmarkReportPage() {
  const navigate = useNavigate();
  // Resolve the active period via the shared, module-cached hook. When the URL
  // has no ?period=, it reads the org's active period from a cache shared with
  // the dashboard and every other page — so a no-data user hits the empty state
  // instantly instead of waiting on a per-page /periods-with-documents fetch.
  const { periodId, status } = useActivePeriodFallback();
  const [data, setData] = useState<Report | ApiError | null>(
    () => (periodId ? reportCache.get(periodId) ?? null : null),
  );
  // Only start in the "loading" (blocking spinner) state when we have NOTHING
  // cached for this period. A cached report renders immediately, no loader.
  const [loading, setLoading] = useState<boolean>(
    () => !(periodId && reportCache.has(periodId)),
  );
  // Active-period fallback (URL canonicalization + the "no documents" verdict)
  // is handled by useActivePeriodFallback above — its `status` drives the
  // resolving-spinner vs empty-state branch below.

  // 2026-05-24 — single industry-edit surface. IndustryPicker now opens
  // for BOTH the first-time caen_not_set auto-trigger AND every user-
  // initiated change-industry button. The legacy IndustryConfirmModal
  // is no longer mounted by this page.
  const [showPicker, setShowPicker] = useState(false);

  const refresh = useMemo(
    () =>
      async () => {
        if (!periodId) {
          setLoading(false);
          return;
        }
        // Seed instantly from cache when we have it; only show the blocking
        // loader on a genuine cold load. The fetch below still runs to refresh.
        const cached = reportCache.get(periodId);
        if (cached) {
          setData(cached);
          setLoading(false);
        } else {
          setLoading(true);
        }
        try {
          const result = await fetchReport(periodId);
          if (result) reportCache.set(periodId, result);
          setData(result);
          // 2026-05-24 — auto-open the NEW IndustryPicker (search + grouped
          // catalog + one-click save) on first-time caen_not_set, instead
          // of the legacy IndustryConfirmModal whose bare <select> dropdown
          // was the source of the user-reported "industry menu has bugs,
          // make it simple" complaint. The picker writes per-period via
          // /api/industry/assignment/{period_id} and onChanged triggers
          // refresh() below, so the benchmark recomputes immediately.
          if (result && "error" in result && result.error === "caen_not_set") {
            setShowPicker(true);
          }
        } catch (e) {
          // Defense-in-depth: even if fetchReport throws (it shouldn't —
          // it wraps its own errors in ApiError shape), surface the error
          // so the page never gets stuck on the loading spinner.
          setData({
            error: "benchmarks_not_available",
            message: `Unexpected error: ${(e as Error).message}`,
          });
        } finally {
          setLoading(false);
        }
      },
    [periodId],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!periodId) {
    // Still resolving active period from /api/org/periods-with-documents?
    // Show a quiet spinner instead of flashing the "no analysis" empty
    // state before the redirect lands. (When the cache already knows the org
    // has no documents, `status` is "none" from the first paint — no spinner.)
    if (status === "resolving") {
      return (
        <>
          <div className="max-w-[680px] mx-auto py-16 text-center">
            <Loader2 size={20} className="animate-spin mx-auto text-ink-mute mb-3" />
            <p className="text-[13px] text-ink-soft">Loading benchmark report…</p>
          </div>
        </>
      );
    }
    // No financial_period in scope (resolved to none — user genuinely has
    // no uploads yet). Two paths:
    //   · Flag ON  → fall through to Level-1 view (public-records data)
    //   · Flag OFF → public-records is hidden product-wide; show the
    //     plain "upload a trial balance" empty state so the page never
    //     references the listafirme.ro workflow that's currently hidden.
    if (PUBLIC_RECORDS_ENABLED) {
      return (
        <>
          <Level1BenchmarkView />
        </>
      );
    }
    return (
      <>
        <div className="max-w-[1080px]">
          <PageHeader
            eyebrow="Benchmark"
            title="See how your company compares to peers."
            subtitle="Upload a Romanian trial balance on the Dashboard and CFO AI will surface where you stand against industry-typical revenue, margin, leverage, and working-capital metrics."
            atmosphere
            hero
            testid="benchmark-pre-upload-header"
          />
          <BenchmarkPreviewStrip />
          <EmptyState
            icon={BarChart3}
            title="No analysis open yet."
            subtitle="The benchmark report unlocks the moment a trial balance is analyzed. Open the Dashboard, upload your export, and CFO AI will fan that single document out into peer-grade comparisons."
            primary={{ label: "Open Dashboard", onClick: () => navigateToDashboard(navigate), testid: "benchmark-pre-upload-cta" }}
            footnote="No fabricated peer data is ever shown — comparisons appear only once your own period is loaded."
            testid="benchmark-empty"
          />
        </div>
      </>
    );
  }

  if (loading) {
    return (
      <>
        <div className="max-w-[680px] mx-auto py-16 text-center">
          <Loader2 size={20} className="animate-spin mx-auto text-ink-mute mb-3" />
          <p className="text-[13px] text-ink-soft">Loading benchmark report…</p>
        </div>
      </>
    );
  }

  if (!data) {
    // No data + not loading + had a periodId = backend errored, fetchReport
    // returned null/undefined, or the request was cancelled. Previously we
    // rendered only the PageHeader — looked like a half-built page with no
    // way out. Now we surface the same EmptyState primitive used elsewhere
    // with two explicit recovery actions: retry the fetch, or fall back to
    // the Dashboard where the user can re-pick a period.
    return (
      <>
        <div className="max-w-[1080px]">
          <PageHeader
            eyebrow="Benchmark"
            title="Couldn't load the benchmark report."
            subtitle="The backend is unreachable, or your account doesn't have access to this period. Try again, or open the Dashboard to confirm the period is still loaded."
            atmosphere
            hero
            testid="benchmark-error-header"
          />
          <EmptyState
            icon={BarChart3}
            title="Report didn't load."
            subtitle="Click retry to re-fetch. If it keeps failing, open the Dashboard to verify the period is still active, or contact support."
            primary={{
              label: "Retry",
              onClick: () => { void refresh(); },
              testid: "benchmark-error-retry",
            }}
            secondary={{
              label: "Open Dashboard",
              onClick: () => navigateToDashboard(navigate),
              testid: "benchmark-error-dashboard",
            }}
            footnote="Persists? Email contact@cfo-ai.io with the period name."
            testid="benchmark-error-empty"
          />
        </div>
      </>
    );
  }

  // Error variants
  if ("error" in data) {
    // period_not_found ⇒ fall through to Level-1. Happens when the URL
    // carries a stale `?period=<id>` from a previous session but the
    // user's only current data is a public-records summary (no
    // financial_period row exists). The Level-1 view picks up the
    // latest public-records doc from the backend on its own.
    if (data.error === "period_not_found") {
      // Same flag check as the `!periodId` branch above — see comment there.
      if (PUBLIC_RECORDS_ENABLED) {
        return (
          <>
            <Level1BenchmarkView />
          </>
        );
      }
      // period_not_found — referenced UUID was deleted or never existed.
      // Same visual vocabulary as the other empty states: PageHeader +
      // BenchmarkPreviewStrip + EmptyState with an explicit recovery path.
      return (
        <>
          <div className="max-w-[1080px]">
            <PageHeader
              eyebrow="Benchmark"
              title="Period not found."
              subtitle="The period referenced in the URL no longer exists. It may have been deleted, or the link is from another workspace. Open the Dashboard to pick an analysis that still exists."
              atmosphere
              hero
              testid="benchmark-period-not-found-header"
            />
            <BenchmarkPreviewStrip />
            <EmptyState
              icon={BarChart3}
              title="This period is gone."
              subtitle="Periods can be cleared from the Dashboard or auto-removed when the underlying document is deleted. Open the Dashboard to pick a current analysis."
              primary={{
                label: "Open Dashboard",
                onClick: () => navigateToDashboard(navigate),
                testid: "benchmark-period-not-found-cta",
              }}
              testid="benchmark-period-not-found-empty"
            />
          </div>
        </>
      );
    }
    // caen_not_set / benchmarks_not_available — the user has a period but
    // no usable industry assignment yet. Was an amber inline box with one
    // tiny button. Now it's the full-fat empty-state surface the user
    // already sees elsewhere on the page: PageHeader → BenchmarkPreviewStrip
    // (so they SEE what they'll get) → EmptyState with the picker CTA as
    // primary action and Open Dashboard as escape hatch.
    const isCaenMissing = data.error === "caen_not_set";
    return (
      <>
        <div className="max-w-[1080px]">
          <PageHeader
            eyebrow="Benchmark"
            title={isCaenMissing
              ? "Pick an industry to unlock the benchmark."
              : "Industry coverage is still expanding."}
            subtitle={isCaenMissing
              ? "Your trial balance is loaded. One more step: confirm which industry to benchmark against. We use industry to pick the right peer median, working-capital norms, and leverage bands — picking the wrong one gives misleading comparisons, so we ask once instead of guessing."
              : "The industry you've picked doesn't have benchmark data yet. Switch to a related industry that is seeded, or contact support and we'll prioritise yours."}
            atmosphere
            hero
            testid="benchmark-needs-industry-header"
          />
          <BenchmarkPreviewStrip />
          <EmptyState
            icon={BarChart3}
            title={isCaenMissing ? "Industry not set yet." : "No benchmark data for this industry."}
            subtitle={data.message
              || (isCaenMissing
                ? "Open the industry picker — it shows the full RO CAEN catalog with a one-click pick."
                : "The picker shows which industries are currently seeded; switch to one of those.")}
            primary={{
              label: isCaenMissing ? "Confirm industry" : "Change industry",
              onClick: () => setShowPicker(true),
              testid: "benchmark-confirm-caen-btn",
            }}
            secondary={{
              label: "Open Dashboard",
              onClick: () => navigateToDashboard(navigate),
              testid: "benchmark-needs-industry-dashboard",
            }}
            footnote="No fabricated peer data is ever shown — once the industry is picked and seeded, real peer medians load instantly."
            testid="benchmark-needs-industry-empty"
          />
        </div>
        {/* 2026-05-24 — IndustryPicker is the single industry-edit surface.
            Auto-opens on caen_not_set (set above) and also opens from every
            user-initiated "Confirm / Change industry" button. Writes go to
            company_industry_assignments; onChanged → refresh() refetches
            the benchmark with the new assignment applied. */}
        {showPicker && periodId && (
          <IndustryPicker
            periodId={periodId}
            open={showPicker}
            onClose={() => setShowPicker(false)}
            onChanged={() => void refresh()}
          />
        )}
      </>
    );
  }

  const r = data;
  return (
    <>
      <section className="space-y-6 max-w-[1200px]">
        {/* 2026-05-26 (mobile fix): stack vertically on mobile so the
            CAEN industry headline doesn't get squeezed by the action
            buttons cluster. Was `flex items-start justify-between
            gap-4 flex-wrap` with `flex-1` left col — that produced the
            same column-stacking bug as the PublicCompanyIntelligence
            hero (right cluster wins the width battle, left col gets
            ~150px, 34-40px heading wraps to 4-5 lines). */}
        <header data-testid="benchmark-header" className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="min-w-0">
            <div className="label-eyebrow">Industry benchmark · your company</div>
            <h1 className="mt-2 font-serif text-[44px] sm:text-[56px] leading-[1.04] tracking-[-0.02em] text-ink">
              {r.caen_label}
            </h1>
            <p className="mt-1 text-[12.5px] text-ink-mute inline-flex items-center gap-2 flex-wrap">
              <span>
                CAEN {r.caen_code} · {r.industry_category}
              </span>
              {/* Phase E — new per-period IndustryBadge sits next to the
                  legacy CAEN strip during the dual-write window. The badge
                  reflects company_industry_assignments (preferred); the
                  CAEN strip still reflects organizations.caen_code. They
                  agree until the user re-classifies via the picker. */}
              {periodId && (
                <IndustryBadge
                  periodId={periodId}
                  variant="compact"
                  onClickChange={() => setShowPicker(true)}
                />
              )}
              {r.cached && r.generated_at ? (
                <span> · cached {new Date(r.generated_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</span>
              ) : null}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap sm:shrink-0">
            <GuideMeButton pageId="benchmark" title="Benchmark" steps={BENCHMARK_GUIDE} />
            <button
              type="button"
              data-testid="benchmark-header-change-caen"
              onClick={() => setShowPicker(true)}
              className="h-9 px-3.5 rounded-md border border-rule bg-surface text-[13px] font-medium text-ink hover:bg-bg-2 transition-colors"
            >
              Change industry
            </button>
            {/* Peer memo entry point removed — the /peer-report page
                wasn't functioning correctly (industry classification was
                misrouted; peer financial data was sparse / inconsistent).
                The route remains on disk and reachable directly so the
                page can be repaired without losing work, but the visible
                CTA is gone until the experience is reliable. To restore:
                re-add the <a href="/peer-report?period={periodId}">…</a>
                button here. */}
            <button
              type="button"
              data-testid="benchmark-header-print"
              onClick={() => window.print()}
              className="h-9 px-3.5 rounded-md bg-ink text-paper text-[13px] font-medium hover:bg-ink/90 transition-colors"
            >
              Export PDF
            </button>
          </div>
        </header>

        {/* Mandatory disclosure — appears prominently on every report so a
            sophisticated CFO can never confuse this with licensed
            third-party benchmarks. */}
        <DisclosureBox text={r.disclosure} />

        {/* Sanity-check banner — fires when 3+ comparison rows are
            dramatically off (>30pp gap) from the assigned-CAEN median.
            Catches "EEI is real estate but was tagged as meat" kind of
            mismatches before the user reads nonsense benchmarks. */}
        {(() => {
          const m = detectClassificationMismatch(r);
          if (!m.mismatch) return null;
          return (
            <div
              data-testid="benchmark-mismatch-warning"
              className="flex items-start gap-3 rounded-lg border border-[#8FE3D9]/60 bg-[#E6F7F4]/60 dark:bg-[#5CD3C5]/[0.08] px-4 py-3"
            >
              <AlertTriangle size={18} strokeWidth={1.75} className="text-[#2AA89B] mt-0.5 shrink-0" />
              <div className="flex-1 text-[12.5px] leading-relaxed text-ink-soft">
                <strong className="text-ink">Possible industry misclassification.</strong>
                <p className="mt-1">{m.reason}</p>
                <button
                  type="button"
                  data-testid="benchmark-mismatch-cta"
                  onClick={() => setShowPicker(true)}
                  className="mt-1.5 inline-flex items-center text-[12.5px] font-semibold text-[#1B7268] hover:text-[#1B7268] underline-offset-2 hover:underline"
                >
                  Change industry →
                </button>
              </div>
            </div>
          );
        })()}

        {/* HEADLINE — the company's own values. No comparison column here;
            this is "here's what we extracted from your books." */}
        <HeadlineGrid section={r.sections.headline} />

        {/* DEEP analysis sections (Phase 7b) — only render when peer data
            has been seeded for this CAEN. Sits ABOVE the percentile bands
            because named-peer comparison is what the CFO actually reads
            first ("how do I compare to Transavia?"), with the P25/P75
            envelope as backup context. */}
        {r.deep && r.deep.peers.length > 0 && (
          <DeepPeerSection deep={r.deep} />
        )}
        {r.deep && r.deep.leader_reasons.length > 0 && (
          <DeepLeaderWhySection deep={r.deep} />
        )}
        {r.deep && r.deep.gap_vs_leader.length > 0 && (
          <DeepGapSection deep={r.deep} />
        )}
        {r.deep && r.deep.target_tiers && (
          <DeepTargetTiersSection deep={r.deep} />
        )}
        {r.deep && r.deep.dynamics && (
          <DeepDynamicsSection deep={r.deep} />
        )}
        {r.deep && (r.deep.success_patterns.length > 0 || r.deep.failure_modes.length > 0) && (
          <DeepPatternsFailuresSection deep={r.deep} />
        )}
        {r.deep && r.deep.market_context && (
          <DeepMarketContextSection text={r.deep.market_context} />
        )}

        {/* Compare sections — render only when the API returned them. */}
        {r.sections.profitability && (
          <ComparisonSection section={r.sections.profitability} testId="benchmark-profitability" />
        )}
        {r.sections.cost_structure && (
          <ComparisonSection section={r.sections.cost_structure} testId="benchmark-cost-structure" />
        )}
        {r.sections.capital_structure && (
          <ComparisonSection section={r.sections.capital_structure} testId="benchmark-capital-structure" />
        )}

        {/* Footer: the print / PDF affordance only. The "Change industry"
            link used to live here as well — it's been promoted to a
            persistent header button so users can always reach it. */}
        <div className="flex items-center gap-3 pt-4 border-t border-rule">
          <button
            type="button"
            onClick={() => window.print()}
            data-testid="benchmark-print"
            className="text-[12px] text-ink-soft hover:text-ink underline-offset-2 hover:underline"
          >
            Print / save as PDF
          </button>
        </div>
      </section>

      {/* 2026-05-24 — single industry surface. Header / mismatch-banner /
          row-pencil all open IndustryPicker. Legacy modal removed. */}
      {showPicker && periodId && (
        <IndustryPicker
          periodId={periodId}
          open={showPicker}
          onClose={() => setShowPicker(false)}
          onChanged={() => void refresh()}
        />
      )}
    </>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function DisclosureBox({ text }: { text: string }) {
  return (
    <div
      data-testid="benchmark-disclosure"
      className="rounded-lg border-l-[3px] border-[#5CD3C5] bg-[#E6F7F4]/40 dark:bg-[#5CD3C5]/[0.06] px-4 py-3"
    >
      <div className="flex items-start gap-2.5 text-[12.5px] leading-relaxed text-ink-soft">
        <Info size={13} strokeWidth={1.75} className="text-[#2AA89B] mt-0.5 shrink-0" />
        <div>
          <strong className="text-ink">Estimated typical · methodology note.</strong> {text}
        </div>
      </div>
    </div>
  );
}

function HeadlineGrid({ section }: { section: HeadlineSection }) {
  return (
    <section data-testid="benchmark-headline" data-guide="benchmark-headline" className="space-y-3">
      <h2 className="font-serif text-[18px] text-ink">{section.title_en}</h2>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {section.metrics.map((m) => {
          const value = section.company_values[m] ?? 0;
          const label = section.display[m]?.en ?? m;
          const conceptKey = benchmarkMetricToConcept(m);
          // When the metric maps to a concept, render the premium
          // LearnableMetricCard primitive — the whole tile becomes a
          // tap-target. When it doesn't map, fall back to the plain
          // card so we don't regress the visual.
          if (conceptKey) {
            return (
              <LearnableMetricCard
                key={m}
                label={label}
                conceptKey={conceptKey}
                value={value}
                display={
                  section.company_values[m] != null ? (
                    <Money value={value} fromCurrency="RON" compact />
                  ) : (
                    "—"
                  )
                }
                tone="default"
                data-testid={`benchmark-headline-${m}`}
              />
            );
          }
          return (
            <div key={m} className="rounded-2xl border border-rule bg-surface p-4">
              <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium">{label}</div>
              <div className="mt-2 font-serif text-[24px] text-ink tabular-nums">
                {section.company_values[m] != null ? <Money value={section.company_values[m] ?? 0} fromCurrency="RON" compact /> : "—"}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ComparisonSection({ section, testId }: { section: ComparisonSection; testId: string }) {
  if (section.comparisons.length === 0) {
    return null;
  }
  return (
    <section data-testid={testId} className="space-y-3">
      <h2 className="font-serif text-[18px] text-ink">{section.title_en}</h2>
      <div className="rounded-2xl border border-rule bg-surface overflow-x-auto">
        <table className="w-full text-[12.5px] min-w-[640px] sm:min-w-0">
          <thead className="bg-bg-2/40 text-[10.5px] uppercase tracking-[0.08em] text-ink-mute font-medium">
            <tr>
              <th className="text-left px-4 py-2.5">Metric</th>
              <th className="text-right px-3 py-2.5">Your company</th>
              <th className="text-right px-3 py-2.5">P25</th>
              <th className="text-right px-3 py-2.5">Median</th>
              <th className="text-right px-3 py-2.5">P75</th>
              <th className="text-left px-3 py-2.5">Verdict</th>
              <th className="text-left px-3 py-2.5">Source</th>
            </tr>
          </thead>
          <tbody>
            {section.comparisons.map((c) => {
              const conceptKey = benchmarkMetricToConcept(c.metric_name);
              return (
              <tr
                key={c.metric_name}
                data-testid={`benchmark-row-${c.metric_name}`}
                className="border-t border-rule/60"
              >
                <td className="px-4 py-2.5 text-ink">
                  {conceptKey ? (
                    <LearnableRowLabel
                      conceptKey={conceptKey}
                      value={c.company_value ?? 0}
                      data-testid={`benchmark-label-${c.metric_name}`}
                    >
                      {c.display.en}
                    </LearnableRowLabel>
                  ) : (
                    c.display.en
                  )}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums font-medium">
                  {formatValue(c.company_value, c.benchmark.unit)}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-ink-mute">
                  {formatValue(c.benchmark.p25, c.benchmark.unit)}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-ink-soft">
                  {formatValue(c.benchmark.p50, c.benchmark.unit)}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-ink-mute">
                  {formatValue(c.benchmark.p75, c.benchmark.unit)}
                </td>
                <td className="px-3 py-2.5">
                  <VerdictBadge verdict={c.verdict} />
                </td>
                <td className="px-3 py-2.5">
                  <SourceChip
                    source={c.benchmark.source}
                    year={c.benchmark.source_year ?? null}
                    confidence={c.benchmark.confidence ?? null}
                    notes={c.benchmark.notes}
                  />
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// Confidence chip — surfaces the trust tier of each benchmark row. The
// product warning the user flagged was that benchmarks can look like
// "AI invented numbers"; this is the explicit fix. Every cell carries
// its source, year, and confidence tier so the user can audit each
// number rather than trusting the headline.
function SourceChip({
  source, year, confidence, notes,
}: {
  source: string | null;
  year: number | null;
  confidence: string | null;
  notes: string | null;
}) {
  // Tier → label + colour. `verified` is the only tier that should look
  // authoritative; everything else gets a neutral / cautionary tone so
  // we don't pretend a directional range is an audited figure.
  const tier = (confidence ?? "directional").toLowerCase();
  const tierStyle =
    tier === "verified"
      ? "border-[#8FE3D9]/50 bg-[#E6F7F4]/60 text-[#1B7268] dark:bg-[#5CD3C5]/[0.10] dark:text-[#8FE3D9]"
      : tier === "estimated"
      ? "border-[#8FE3D9]/50 bg-[#E6F7F4]/50 text-[#1B7268] dark:bg-[#5CD3C5]/[0.10] dark:text-[#8FE3D9]"
      : "border-[#8FE3D9]/60 bg-[#E6F7F4]/40 text-[#1B7268] dark:bg-[#5CD3C5]/[0.08] dark:text-[#8FE3D9]";
  const tierLabel =
    tier === "verified" ? "Verified"
    : tier === "estimated" ? "Estimated"
    : "Directional";

  // Tooltip aggregates the long-form source + year + notes so the chip
  // stays compact in the table cell.
  const tooltipLines: string[] = [];
  if (source) tooltipLines.push(source);
  if (year) tooltipLines.push(`Year: ${year}`);
  if (notes) tooltipLines.push(notes);
  const tooltip = tooltipLines.join("\n");

  return (
    <span
      title={tooltip}
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${tierStyle}`}
      data-testid="benchmark-source-chip"
      data-confidence={tier}
    >
      {tierLabel}
      {year && <span className="opacity-70">· {year}</span>}
    </span>
  );
}

function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const meta: Record<Verdict, { label: string; cls: string }> = {
    top_quartile: { label: "Top 25%", cls: "bg-[#E6F7F4] text-[#1B7268] border-[#8FE3D9]" },
    above_median: { label: "Peste median", cls: "bg-[#E6F7F4] text-[#2AA89B] border-[#8FE3D9]" },
    below_median: { label: "Sub median", cls: "bg-[#E6F7F4] text-[#1B7268] border-[#8FE3D9]" },
    bottom_quartile: { label: "Sub 25%", cls: "bg-red-50 text-red-800 border-red-200" },
    not_available: { label: "N/A", cls: "bg-stone-100 text-ink-mute border-rule" },
  };
  const m = meta[verdict];
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[10.5px] uppercase tracking-[0.06em] font-semibold ${m.cls}`}>
      {m.label}
    </span>
  );
}

// ─── Deep-analysis sections (Phase 7b) ──────────────────────────────────────
//
// These render the rich Transavia-style peer comparison the CFO actually
// reads first: who's in the industry, why the leader wins, where my
// numbers sit vs the leader, what targets are realistic.

// TIER_META holds the visual class per tier. The user-facing label is
// translated at render time via t('benchmarkPage.peersTable.tiers.<tier>'),
// not baked in here, so EN→RO/DE/FR/ES toggle re-paints the badge text.
const TIER_META: Record<DeepPeer["tier"], { cls: string }> = {
  leader:       { cls: "bg-[#2AA89B] text-white" },
  strong:       { cls: "bg-[#2AA89B] text-white" },
  median:       { cls: "bg-stone-500 text-white" },
  thin_margin:  { cls: "bg-[#5CD3C5] text-white" },
  distressed:   { cls: "bg-red-700 text-white" },
  self:         { cls: "bg-ink text-paper" },
};

function fmtM(value: number | null): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const sign = value < 0 ? "−" : value > 0 ? "+" : "";
  return `${sign}${Math.abs(value).toFixed(1)}`;
}

function fmtPct1(value: number | null): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${value.toFixed(1)}%`;
}

function fmtRatio2(value: number | null): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${value.toFixed(2)}×`;
}

function DeepPeerSection({ deep }: { deep: DeepReport }) {
  const { t } = useTranslation();

  // Backend ships `revenue_mlei` + `net_profit_mlei` in millions of RON.
  // Convert to raw RON (×1e6) so <Money fromCurrency="RON" compact /> can
  // re-display in whatever currency the top-bar toggle is set to — flips
  // RON → EUR → USD live without a page refresh. fmtM is kept as a tiny
  // signed-number helper for things that aren't currency (margins, etc.).
  const moneyFromMlei = (mlei: number | null) => {
    if (mlei === null || mlei === undefined || Number.isNaN(mlei)) return null;
    return mlei * 1_000_000;
  };

  return (
    <section data-testid="benchmark-deep-peers" className="space-y-3">
      <h2 className="font-serif text-[20px] text-ink">{t("benchmarkPage.peersTable.heading")}</h2>
      {deep.leader_company && (
        <div className="rounded-lg border-l-[3px] border-[#5CD3C5] bg-[#E6F7F4]/40 dark:bg-[#5CD3C5]/[0.06] px-4 py-3 text-[13px] text-ink-soft leading-relaxed">
          <strong className="text-ink">{t("benchmarkPage.peersTable.leaderIntro")}</strong>{" "}
          {deep.leader_company}
          {deep.leader_year ? (
            <> ({deep.leader_year},{" "}
              <Money
                value={moneyFromMlei(deep.leader_revenue_mlei)}
                fromCurrency="RON"
                compact
              />
              {" "}{t("benchmarkPage.peersTable.leaderRevenue")},{" "}
              {fmtPct1(deep.leader_net_margin_pct)} {t("benchmarkPage.peersTable.leaderMargin")})
            </>
          ) : null}.{" "}
          {deep.leader_specialization && (
            <>
              <strong>{t("benchmarkPage.peersTable.leaderSpec")}:</strong> {deep.leader_specialization}.
            </>
          )}
        </div>
      )}
      <div className="rounded-2xl border border-rule bg-surface overflow-x-auto">
        <table className="w-full text-[12.5px] min-w-[640px] sm:min-w-0">
          <thead className="bg-bg-2/40 text-[10.5px] uppercase tracking-[0.08em] text-ink-mute font-medium">
            <tr>
              <th className="text-left px-4 py-2.5">{t("benchmarkPage.peersTable.cols.company")}</th>
              <th className="text-right px-3 py-2.5">{t("benchmarkPage.peersTable.cols.year")}</th>
              <th className="text-right px-3 py-2.5">{t("benchmarkPage.peersTable.cols.revenue")}</th>
              <th className="text-right px-3 py-2.5">{t("benchmarkPage.peersTable.cols.netProfit")}</th>
              <th className="text-right px-3 py-2.5">{t("benchmarkPage.peersTable.cols.netMargin")}</th>
              <th className="text-left px-3 py-2.5">{t("benchmarkPage.peersTable.cols.specialization")}</th>
              <th className="text-center px-3 py-2.5">{t("benchmarkPage.peersTable.cols.verdict")}</th>
            </tr>
          </thead>
          <tbody>
            {deep.peers.map((p, idx) => {
              const positive = (p.net_margin_pct ?? 0) >= 0;
              const profitColor = positive ? "text-[#2AA89B]" : "text-red-700";
              const isSelf = p.tier === "self";
              const isLeader = p.tier === "leader";
              // Self-row specialization is set by backend to a localized
              // sentinel ("Compania ta" / "Your company"). Re-derive on
              // FE so the cell follows the active language regardless of
              // what the backend baked in.
              const specCell = isSelf
                ? t("benchmarkPage.yourCompany")
                : (p.specialization ?? "—");
              return (
                <tr
                  key={`${p.company_name}-${p.fiscal_year}-${idx}`}
                  data-testid={`peer-row-${p.tier}`}
                  className={`border-t border-rule/60 ${isLeader ? "bg-[#E6F7F4]/30" : isSelf ? "bg-ink/[0.03] font-medium" : ""}`}
                >
                  <td className="px-4 py-2.5">{p.company_name}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-ink-mute">{p.fiscal_year ?? "—"}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    <Money value={moneyFromMlei(p.revenue_mlei)} fromCurrency="RON" compact />
                  </td>
                  <td className={`px-3 py-2.5 text-right tabular-nums font-medium ${profitColor}`}>
                    <Money value={moneyFromMlei(p.net_profit_mlei)} fromCurrency="RON" compact signed />
                  </td>
                  <td className={`px-3 py-2.5 text-right tabular-nums font-medium ${profitColor}`}>
                    {fmtPct1(p.net_margin_pct)}
                  </td>
                  <td className="px-3 py-2.5 text-ink-soft">{specCell}</td>
                  <td className="px-3 py-2.5 text-center">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold tracking-[0.06em] ${TIER_META[p.tier].cls}`}>
                      {t(`benchmarkPage.peersTable.tiers.${p.tier}`)}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DeepLeaderWhySection({ deep }: { deep: DeepReport }) {
  return (
    <section data-testid="benchmark-deep-why" className="space-y-3">
      <h2 className="font-serif text-[20px] text-ink">
        2. Why the leader ({deep.leader_company}) dominates — {deep.leader_reasons.length} structural reasons
      </h2>
      <p className="text-[13px] text-ink-soft leading-relaxed">
        Cumulative impact is approximately{" "}
        <strong>+{deep.leader_total_impact_pp.toFixed(1)}pp margin</strong> above the industry average.
        These are structural advantages (not cyclical) — competitors would have to replicate them
        simultaneously to close the gap.
      </p>
      <div className="space-y-2.5">
        {deep.leader_reasons.map((reason) => (
          <div
            key={reason.rank}
            data-testid={`leader-reason-${reason.rank}`}
            className="rounded-xl border-l-[3px] border-[#5CD3C5] bg-surface px-4 py-3.5"
          >
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <strong className="text-[13.5px] text-ink leading-tight">
                {reason.rank}. {reason.title}
              </strong>
              {reason.margin_impact_pp !== null && (
                <span className="inline-flex items-center px-2.5 py-0.5 rounded bg-ink text-paper text-[11px] font-semibold whitespace-nowrap">
                  +{reason.margin_impact_pp.toFixed(1)}pp margin impact
                </span>
              )}
            </div>
            <p className="mt-1.5 text-[12.5px] text-ink-soft leading-relaxed">{reason.description}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function DeepGapSection({ deep }: { deep: DeepReport }) {
  return (
    <section data-testid="benchmark-deep-gap" className="space-y-3">
      <h2 className="font-serif text-[20px] text-ink">
        3. Your company vs the leader ({deep.leader_company}) — Gap analysis
      </h2>
      <div className="rounded-2xl border border-rule bg-surface overflow-x-auto">
        <table className="w-full text-[12.5px] min-w-[640px] sm:min-w-0">
          <thead className="bg-bg-2/40 text-[10.5px] uppercase tracking-[0.08em] text-ink-mute font-medium">
            <tr>
              <th className="text-left px-4 py-2.5">Metric</th>
              <th className="text-right px-3 py-2.5">Your company</th>
              <th className="text-right px-3 py-2.5">{deep.leader_company ?? "Leader"}</th>
              <th className="text-right px-3 py-2.5">Gap</th>
            </tr>
          </thead>
          <tbody>
            {deep.gap_vs_leader.map((row) => {
              const fmt = (v: number): string =>
                row.unit === "pct" ? fmtPct1(v) : fmtRatio2(v);
              const arrow = row.gap >= 0 ? "↑" : "↓";
              const gapColor = row.favorable ? "text-[#2AA89B]" : "text-red-700";
              return (
                <tr key={row.key} className="border-t border-rule/60">
                  <td className="px-4 py-2.5 text-ink">{row.label}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{fmt(row.company_value)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{fmt(row.leader_value)}</td>
                  <td className={`px-3 py-2.5 text-right tabular-nums font-bold ${gapColor}`}>
                    {arrow} {fmt(Math.abs(row.gap))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DeepTargetTiersSection({ deep }: { deep: DeepReport }) {
  const t = deep.target_tiers;
  if (!t) return null;
  const rows: Array<{ tier: TargetTier; bg: string; icon: string }> = [];
  if (t.aspirational) rows.push({ tier: t.aspirational, bg: "bg-[#E6F7F4]/60", icon: "🎯" });
  if (t.realistic) rows.push({ tier: t.realistic, bg: "bg-[#E6F7F4]/60", icon: "✓" });
  if (t.minimum_viable) rows.push({ tier: t.minimum_viable, bg: "bg-red-50/40", icon: "⚠" });
  return (
    <section data-testid="benchmark-deep-tiers" className="space-y-3">
      <h2 className="font-serif text-[20px] text-ink">4. Target margin tiers for this industry</h2>
      <div className="rounded-2xl border border-rule bg-surface overflow-x-auto">
        <table className="w-full text-[12.5px] min-w-[640px] sm:min-w-0">
          <thead className="bg-bg-2/40 text-[10.5px] uppercase tracking-[0.08em] text-ink-mute font-medium">
            <tr>
              <th className="text-left px-4 py-2.5">Tier</th>
              <th className="text-right px-3 py-2.5">Net margin</th>
              <th className="text-right px-3 py-2.5">EBITDA margin</th>
              <th className="text-left px-3 py-2.5">Comment</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={`border-t border-rule/60 ${r.bg}`}>
                <td className="px-4 py-2.5 font-medium">
                  <span className="mr-1.5">{r.icon}</span>
                  {r.tier.label}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums font-medium">{fmtPct1(r.tier.net_margin_pct)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums font-medium">{fmtPct1(r.tier.ebitda_margin_pct)}</td>
                <td className="px-3 py-2.5 text-ink-soft">{r.tier.comment}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="rounded-lg border-l-[3px] border-[#5CD3C5] bg-[#E6F7F4]/30 dark:bg-[#5CD3C5]/[0.06] px-4 py-3 text-[12.5px] text-ink-soft leading-relaxed">
        <strong className="text-ink">How to read the table:</strong>{" "}
        Aspirational is the top-quartile threshold (10-15% of the industry); it requires the kind of
        structural advantages described above plus 5-10+ years of execution. Realistic is the
        reasonable target for a well-run company without extreme structural advantages. Minimum
        viable is the threshold below which operations become fragile (capex inability, refinancing
        pressure).
      </div>
    </section>
  );
}

function DeepDynamicsSection({ deep }: { deep: DeepReport }) {
  const d = deep.dynamics;
  if (!d) return null;
  const labels: Record<string, string> = {
    concentration: "Concentration",
    growth: "Growth",
    regulation: "Regulation",
    barriers: "Entry barriers",
  };
  return (
    <section data-testid="benchmark-deep-dynamics" className="space-y-3">
      <h2 className="font-serif text-[20px] text-ink">5. Industry dynamics</h2>
      <div className="rounded-2xl border border-rule bg-surface overflow-x-auto">
        <table className="w-full text-[12.5px] min-w-[640px] sm:min-w-0">
          <thead className="bg-bg-2/40 text-[10.5px] uppercase tracking-[0.08em] text-ink-mute font-medium">
            <tr>
              <th className="text-left px-4 py-2.5">Aspect</th>
              <th className="text-left px-3 py-2.5">Verdict</th>
              <th className="text-left px-3 py-2.5">Detail</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(d).map(([key, val]) => (
              <tr key={key} className="border-t border-rule/60">
                <td className="px-4 py-2.5 font-medium">{labels[key] ?? key}</td>
                <td className="px-3 py-2.5 text-ink-soft">{val.verdict}</td>
                <td className="px-3 py-2.5 text-ink-soft">{val.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DeepPatternsFailuresSection({ deep }: { deep: DeepReport }) {
  return (
    <section data-testid="benchmark-deep-patterns" className="space-y-4">
      {deep.success_patterns.length > 0 && (
        <div>
          <h2 className="font-serif text-[20px] text-ink mb-2">6. Success patterns in this industry</h2>
          <ul className="list-disc pl-5 text-[12.5px] text-ink-soft leading-relaxed space-y-1">
            {deep.success_patterns.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {deep.failure_modes.length > 0 && (
        <div>
          <h2 className="font-serif text-[20px] text-ink mb-2">7. Typical failure modes</h2>
          <ul className="list-disc pl-5 text-[12.5px] text-ink-soft leading-relaxed space-y-1">
            {deep.failure_modes.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function DeepMarketContextSection({ text }: { text: string }) {
  return (
    <section data-testid="benchmark-deep-market" className="space-y-2">
      <h2 className="font-serif text-[20px] text-ink">8. Romania market context</h2>
      <div className="rounded-lg border-l-[3px] border-[#5CD3C5] bg-[#E6F7F4]/40 dark:bg-[#5CD3C5]/[0.06] px-4 py-3 text-[13px] text-ink-soft leading-relaxed">
        {text}
      </div>
    </section>
  );
}

// ─── Pre-upload helpers ──────────────────────────────────────────
// `BenchmarkPreviewStrip` shows three feature cards INSIDE the
// pre-upload state — the spec's "small visual previews of future
// insights" requirement. NO fabricated peer numbers; every card
// describes a CATEGORY of comparison that becomes available once
// real data is loaded. Honest pre-data surface.

function BenchmarkPreviewStrip() {
  const items = [
    {
      icon: LineChart,
      eyebrow: "Headline",
      title: "Revenue, EBITDA, margin",
      body: "Where your top-line and operating margin land relative to industry-typical bands.",
    },
    {
      icon: LayersIcon,
      eyebrow: "Capital structure",
      title: "Leverage & equity",
      body: "Debt / EBITDA, equity ratio, interest coverage — how your balance sheet compares.",
    },
    {
      icon: ShieldAlert,
      eyebrow: "Working capital",
      title: "Cash conversion cycle",
      body: "DSO, DIO, DPO and CCC versus the median for your CAEN bracket.",
    },
  ];
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-8" data-testid="benchmark-preview-strip">
      {items.map((it) => {
        const Icon = it.icon;
        return (
          <div
            key={it.title}
            className="
              relative overflow-hidden
              rounded-2xl border border-rule
              bg-gradient-to-br from-bg-2/30 via-surface to-surface
              ring-1 ring-inset ring-white/[0.03]
              px-4 py-4
            "
          >
            <div className="flex items-center gap-2.5">
              <div className="inline-flex shrink-0 items-center justify-center h-8 w-8 rounded-xl bg-brand-tint text-brand-d ring-1 ring-brand/15">
                <Icon size={14} strokeWidth={1.75} />
              </div>
              <div className="min-w-0">
                <div className="text-[14px] font-medium text-ink leading-tight">{it.title}</div>
                <div className="mt-0.5 text-[10px] uppercase tracking-[0.14em] text-ink-mute font-semibold">
                  {it.eyebrow}
                </div>
              </div>
            </div>
            {/* Divider with edges faded to transparent — separates the
                title/eyebrow header from the descriptive body. */}
            <div className="my-2.5 h-px bg-gradient-to-r from-transparent via-rule-strong to-transparent" />
            <p className="text-[12px] text-ink-soft leading-relaxed">{it.body}</p>
          </div>
        );
      })}
    </div>
  );
}

function navigateToDashboard(navigate: (to: string) => void): void {
  navigate("/dashboard");
}
