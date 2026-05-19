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
import { useNavigate, useSearchParams } from "react-router-dom";
import { AlertTriangle, BarChart3, Info, Layers as LayersIcon, LineChart, Loader2, ShieldAlert } from "lucide-react";

import { AppShell } from "@/components/cfo/AppShell";
import { IndustryConfirmModal } from "@/components/cfo/IndustryConfirmModal";
// Phase E — additive: the new picker/badge use the per-period
// `company_industry_assignments` table; the legacy modal still writes
// `organizations.caen_code`. Both work in parallel during the dual-write
// window. The header now opens IndustryPicker; the first-time "caen_not_set"
// gate keeps IndustryConfirmModal because it's the only flow that maps to
// the legacy benchmark engine's required input today.
import { IndustryBadge, IndustryPicker } from "@/components/cfo/industry";
import { Level1BenchmarkView } from "@/components/cfo/Level1BenchmarkView";
import { EmptyState } from "@/components/cfo/ui/EmptyState";
import { PageHeader } from "@/components/cfo/ui/PageHeader";
import { getSupabase } from "@/lib/supabase";
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

function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const abs = Math.abs(value);
  const sign = value < 0 ? "−" : "";
  if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(2)}B RON`;
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}M RON`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(0)}K RON`;
  return `${sign}${abs.toFixed(0)} RON`;
}

function formatPct(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${value.toFixed(1)}%`;
}

function formatRatio(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${value.toFixed(2)}×`;
}

function formatValue(value: number | null | undefined, unit: string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (unit === "pct") return formatPct(value);
  if (unit === "ratio") return formatRatio(value);
  return formatCurrency(value);
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
      extremeMetrics.push(c.display.ro);
    }
  }

  if (extremeMetrics.length >= 3) {
    const sample = extremeMetrics.slice(0, 3).join(", ");
    return {
      mismatch: true,
      reason: `Datele companiei tale sunt foarte diferite de tipicul industriei selectate pe ${extremeMetrics.length} indicatori (${sample}${extremeMetrics.length > 3 ? "…" : ""}). Probabil ai selectat industria greșită.`,
    };
  }
  return { mismatch: false, reason: "" };
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function BenchmarkReportPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const periodId = params.get("period");
  const [data, setData] = useState<Report | ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  // Phase E — separate state for the new IndustryPicker so the legacy
  // modal (gated on `caen_not_set`) and the new picker (user-initiated
  // change) can coexist during the dual-write window. setShowModal
  // remains tied to the legacy first-time confirmation.
  const [showPicker, setShowPicker] = useState(false);

  const refresh = useMemo(
    () =>
      async () => {
        if (!periodId) {
          setLoading(false);
          return;
        }
        setLoading(true);
        try {
          const result = await fetchReport(periodId);
          setData(result);
          if (result && "error" in result && result.error === "caen_not_set") {
            setShowModal(true);
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
    // No financial_period in scope. Two paths:
    //   · Flag ON  → fall through to Level-1 view (public-records data)
    //   · Flag OFF → public-records is hidden product-wide; show the
    //     plain "upload a trial balance" empty state so the page never
    //     references the listafirme.ro workflow that's currently hidden.
    if (PUBLIC_RECORDS_ENABLED) {
      return (
        <AppShell>
          <Level1BenchmarkView />
        </AppShell>
      );
    }
    return (
      <AppShell>
        <div className="max-w-[1080px] mx-auto py-8 sm:py-10">
          <PageHeader
            eyebrow="Benchmark"
            title="See how your company compares to peers."
            subtitle="Upload a Romanian trial balance on the Dashboard and CFO AI will surface where you stand against industry-typical revenue, margin, leverage, and working-capital metrics."
            atmosphere
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
      </AppShell>
    );
  }

  if (loading) {
    return (
      <AppShell>
        <div className="max-w-[680px] mx-auto py-16 text-center">
          <Loader2 size={20} className="animate-spin mx-auto text-ink-mute mb-3" />
          <p className="text-[13px] text-ink-soft">Loading benchmark report…</p>
        </div>
      </AppShell>
    );
  }

  if (!data) {
    return (
      <AppShell>
        <div className="max-w-[1080px] mx-auto py-10">
          <PageHeader
            eyebrow="Benchmark"
            title="Couldn't load the benchmark report."
            subtitle="The backend is unreachable, or your account doesn't have access to this period. Try again in a moment, or open the Dashboard to confirm the period is still loaded."
          />
        </div>
      </AppShell>
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
          <AppShell>
            <Level1BenchmarkView />
          </AppShell>
        );
      }
      return (
        <AppShell>
          <div className="max-w-[640px] mx-auto py-24 text-center">
            <h1 className="font-serif text-[24px] text-ink mb-2">Period not found</h1>
            <p className="text-[13.5px] text-ink-soft">
              The period referenced in the URL no longer exists. Open the Dashboard
              and select an analysis to view its benchmark.
            </p>
          </div>
        </AppShell>
      );
    }
    return (
      <AppShell>
        <section className="max-w-[800px] mx-auto py-12 space-y-4">
          <div className="rounded-lg border border-amber-300/60 bg-amber-50/40 p-5">
            <h1 className="font-serif text-[24px] text-ink mb-2">Benchmark not available yet</h1>
            <p className="text-[13.5px] text-ink-soft">{data.message}</p>
            {data.error === "caen_not_set" && (
              // Phase F — gate now opens the new IndustryPicker. The
              // backend (`_benchmarks.py`) accepts EITHER path as a
              // valid classification, so the user can satisfy the gate
              // by writing a company_industry_assignments row alone —
              // no need to touch `organizations.caen_code`. The legacy
              // IndustryConfirmModal remains mounted below for
              // reversibility; remove after backfill verifies.
              <button
                type="button"
                onClick={() => setShowPicker(true)}
                data-testid="benchmark-confirm-caen-btn"
                className="mt-4 inline-flex h-9 px-4 rounded-md bg-ink text-paper text-[13px] font-medium hover:bg-ink/90 transition-colors"
              >
                Confirm industry
              </button>
            )}
          </div>
        </section>
        {showModal && periodId && (
          <IndustryConfirmModal
            periodId={periodId}
            open={showModal}
            onClose={() => setShowModal(false)}
            onConfirmed={() => {
              setShowModal(false);
              void refresh();
            }}
          />
        )}
        {/* Phase E — IndustryPicker is mounted in parallel; it only opens
            when the user explicitly triggers it (header buttons, mismatch
            banner CTA). Writes go to company_industry_assignments, so the
            page refresh below picks up the change on the next render. */}
        {showPicker && periodId && (
          <IndustryPicker
            periodId={periodId}
            open={showPicker}
            onClose={() => setShowPicker(false)}
            onChanged={() => void refresh()}
          />
        )}
      </AppShell>
    );
  }

  const r = data;
  return (
    <AppShell>
      <section className="space-y-6 max-w-[1200px]">
        <header data-testid="benchmark-header" className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="label-eyebrow">Industry benchmark · your company</div>
            <h1 className="mt-2 font-serif text-[34px] sm:text-[40px] leading-[1.05] tracking-[-0.02em] text-ink">
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
          <div className="flex items-center gap-2 shrink-0">
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
              className="flex items-start gap-3 rounded-lg border border-amber-300/60 bg-amber-50/60 dark:bg-amber-500/[0.08] px-4 py-3"
            >
              <AlertTriangle size={18} strokeWidth={1.75} className="text-amber-600 mt-0.5 shrink-0" />
              <div className="flex-1 text-[12.5px] leading-relaxed text-ink-soft">
                <strong className="text-ink">Possible industry misclassification.</strong>
                <p className="mt-1">{m.reason}</p>
                <button
                  type="button"
                  data-testid="benchmark-mismatch-cta"
                  onClick={() => setShowPicker(true)}
                  className="mt-1.5 inline-flex items-center text-[12.5px] font-semibold text-amber-800 hover:text-amber-900 underline-offset-2 hover:underline"
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

      {showModal && periodId && (
        <IndustryConfirmModal
          periodId={periodId}
          // Pass the active CAEN so the modal renders in
          // reclassification mode (title "Change industry",
          // "Current industry" banner, save disabled until different).
          currentCaen={r.caen_code}
          open={showModal}
          onClose={() => setShowModal(false)}
          onConfirmed={() => {
            setShowModal(false);
            void refresh();
          }}
        />
      )}
      {/* Phase E — IndustryPicker (per-period assignment). Coexists with
          the legacy modal during dual-write. */}
      {showPicker && periodId && (
        <IndustryPicker
          periodId={periodId}
          open={showPicker}
          onClose={() => setShowPicker(false)}
          onChanged={() => void refresh()}
        />
      )}
    </AppShell>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function DisclosureBox({ text }: { text: string }) {
  return (
    <div
      data-testid="benchmark-disclosure"
      className="rounded-lg border-l-[3px] border-blue-400 bg-blue-50/40 dark:bg-blue-500/[0.06] px-4 py-3"
    >
      <div className="flex items-start gap-2.5 text-[12.5px] leading-relaxed text-ink-soft">
        <Info size={13} strokeWidth={1.75} className="text-blue-600 mt-0.5 shrink-0" />
        <div>
          <strong className="text-ink">Estimated typical · methodology note.</strong> {text}
        </div>
      </div>
    </div>
  );
}

function HeadlineGrid({ section }: { section: HeadlineSection }) {
  return (
    <section data-testid="benchmark-headline" className="space-y-3">
      <h2 className="font-serif text-[18px] text-ink">{section.title_ro}</h2>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {section.metrics.map((m) => {
          const value = section.company_values[m];
          const label = section.display[m]?.ro ?? m;
          return (
            <div key={m} className="rounded-2xl border border-rule bg-surface p-4">
              <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium">{label}</div>
              <div className="mt-2 font-serif text-[24px] text-ink tabular-nums">
                {formatCurrency(value)}
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
      <h2 className="font-serif text-[18px] text-ink">{section.title_ro}</h2>
      <div className="rounded-2xl border border-rule bg-surface overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead className="bg-bg-2/40 text-[10.5px] uppercase tracking-[0.08em] text-ink-mute font-medium">
            <tr>
              <th className="text-left px-4 py-2.5">Indicator</th>
              <th className="text-right px-3 py-2.5">Compania</th>
              <th className="text-right px-3 py-2.5">P25</th>
              <th className="text-right px-3 py-2.5">Median</th>
              <th className="text-right px-3 py-2.5">P75</th>
              <th className="text-left px-3 py-2.5">Verdict</th>
              <th className="text-left px-3 py-2.5">Sursă</th>
            </tr>
          </thead>
          <tbody>
            {section.comparisons.map((c) => (
              <tr
                key={c.metric_name}
                data-testid={`benchmark-row-${c.metric_name}`}
                className="border-t border-rule/60"
              >
                <td className="px-4 py-2.5 text-ink">{c.display.ro}</td>
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
            ))}
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
      ? "border-emerald-300/50 bg-emerald-50/60 text-emerald-800 dark:bg-emerald-500/[0.10] dark:text-emerald-300"
      : tier === "estimated"
      ? "border-amber-300/50 bg-amber-50/50 text-amber-800 dark:bg-amber-500/[0.10] dark:text-amber-300"
      : "border-blue-200/60 bg-blue-50/40 text-blue-800 dark:bg-blue-500/[0.08] dark:text-blue-300";
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
    top_quartile: { label: "Top 25%", cls: "bg-emerald-100 text-emerald-800 border-emerald-200" },
    above_median: { label: "Peste median", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
    below_median: { label: "Sub median", cls: "bg-amber-50 text-amber-800 border-amber-200" },
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

const TIER_META: Record<DeepPeer["tier"], { label: string; cls: string }> = {
  leader:       { label: "LIDER",         cls: "bg-emerald-700 text-white" },
  strong:       { label: "PUTERNIC",      cls: "bg-blue-700 text-white" },
  median:       { label: "MEDIE",         cls: "bg-stone-500 text-white" },
  thin_margin:  { label: "MARJĂ SUBȚIRE", cls: "bg-amber-500 text-white" },
  distressed:   { label: "DISTRESSED",    cls: "bg-red-700 text-white" },
  self:         { label: "COMPANIA TA",   cls: "bg-ink text-paper" },
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
  return (
    <section data-testid="benchmark-deep-peers" className="space-y-3">
      <h2 className="font-serif text-[20px] text-ink">1. Peers — cine ocupă pozițiile în industrie</h2>
      {deep.leader_company && (
        <div className="rounded-lg border-l-[3px] border-blue-400 bg-blue-50/40 dark:bg-blue-500/[0.06] px-4 py-3 text-[13px] text-ink-soft leading-relaxed">
          <strong className="text-ink">Lider de industrie identificat:</strong>{" "}
          {deep.leader_company}
          {deep.leader_year ? <> ({deep.leader_year}, {fmtM(deep.leader_revenue_mlei)}M lei revenue, {fmtPct1(deep.leader_net_margin_pct)} margin)</> : null}.{" "}
          {deep.leader_specialization && (
            <>
              <strong>Specializare:</strong> {deep.leader_specialization}.
            </>
          )}
        </div>
      )}
      <div className="rounded-2xl border border-rule bg-surface overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead className="bg-bg-2/40 text-[10.5px] uppercase tracking-[0.08em] text-ink-mute font-medium">
            <tr>
              <th className="text-left px-4 py-2.5">Companie</th>
              <th className="text-right px-3 py-2.5">An</th>
              <th className="text-right px-3 py-2.5">CA (M lei)</th>
              <th className="text-right px-3 py-2.5">Profit net (M lei)</th>
              <th className="text-right px-3 py-2.5">Marjă netă</th>
              <th className="text-left px-3 py-2.5">Specializare</th>
              <th className="text-center px-3 py-2.5">Verdict</th>
            </tr>
          </thead>
          <tbody>
            {deep.peers.map((p, idx) => {
              const positive = (p.net_margin_pct ?? 0) >= 0;
              const profitColor = positive ? "text-emerald-700" : "text-red-700";
              const isSelf = p.tier === "self";
              const isLeader = p.tier === "leader";
              return (
                <tr
                  key={`${p.company_name}-${p.fiscal_year}-${idx}`}
                  data-testid={`peer-row-${p.tier}`}
                  className={`border-t border-rule/60 ${isLeader ? "bg-amber-50/30" : isSelf ? "bg-ink/[0.03] font-medium" : ""}`}
                >
                  <td className="px-4 py-2.5">{p.company_name}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-ink-mute">{p.fiscal_year ?? "—"}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{fmtM(p.revenue_mlei)}</td>
                  <td className={`px-3 py-2.5 text-right tabular-nums font-medium ${profitColor}`}>
                    {fmtM(p.net_profit_mlei)}
                  </td>
                  <td className={`px-3 py-2.5 text-right tabular-nums font-medium ${profitColor}`}>
                    {fmtPct1(p.net_margin_pct)}
                  </td>
                  <td className="px-3 py-2.5 text-ink-soft">{p.specialization ?? "—"}</td>
                  <td className="px-3 py-2.5 text-center">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold tracking-[0.06em] ${TIER_META[p.tier].cls}`}>
                      {TIER_META[p.tier].label}
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
        2. De ce liderul ({deep.leader_company}) domină — {deep.leader_reasons.length} motive structurale
      </h2>
      <p className="text-[13px] text-ink-soft leading-relaxed">
        Suma impacturilor cumulate este de aproximativ{" "}
        <strong>+{deep.leader_total_impact_pp.toFixed(1)}pp marjă</strong> peste media industriei.
        Acestea sunt avantaje structurale (nu conjuncturale) — competitorii ar trebui să le replice
        simultan pentru a închide gap-ul.
      </p>
      <div className="space-y-2.5">
        {deep.leader_reasons.map((reason) => (
          <div
            key={reason.rank}
            data-testid={`leader-reason-${reason.rank}`}
            className="rounded-xl border-l-[3px] border-amber-400 bg-surface px-4 py-3.5"
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
        3. Compania ta vs Liderul ({deep.leader_company}) — Gap analysis
      </h2>
      <div className="rounded-2xl border border-rule bg-surface overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead className="bg-bg-2/40 text-[10.5px] uppercase tracking-[0.08em] text-ink-mute font-medium">
            <tr>
              <th className="text-left px-4 py-2.5">Metric</th>
              <th className="text-right px-3 py-2.5">Compania ta</th>
              <th className="text-right px-3 py-2.5">{deep.leader_company ?? "Leader"}</th>
              <th className="text-right px-3 py-2.5">Gap</th>
            </tr>
          </thead>
          <tbody>
            {deep.gap_vs_leader.map((row) => {
              const fmt = (v: number): string =>
                row.unit === "pct" ? fmtPct1(v) : fmtRatio2(v);
              const arrow = row.gap >= 0 ? "↑" : "↓";
              const gapColor = row.favorable ? "text-emerald-700" : "text-red-700";
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
  if (t.aspirational) rows.push({ tier: t.aspirational, bg: "bg-amber-50/60", icon: "🎯" });
  if (t.realistic) rows.push({ tier: t.realistic, bg: "bg-emerald-50/60", icon: "✓" });
  if (t.minimum_viable) rows.push({ tier: t.minimum_viable, bg: "bg-red-50/40", icon: "⚠" });
  return (
    <section data-testid="benchmark-deep-tiers" className="space-y-3">
      <h2 className="font-serif text-[20px] text-ink">4. Target margin tiers pentru această industrie</h2>
      <div className="rounded-2xl border border-rule bg-surface overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead className="bg-bg-2/40 text-[10.5px] uppercase tracking-[0.08em] text-ink-mute font-medium">
            <tr>
              <th className="text-left px-4 py-2.5">Tier</th>
              <th className="text-right px-3 py-2.5">Marja netă</th>
              <th className="text-right px-3 py-2.5">Marja EBITDA</th>
              <th className="text-left px-3 py-2.5">Comentariu</th>
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
      <div className="rounded-lg border-l-[3px] border-amber-400 bg-amber-50/30 dark:bg-amber-500/[0.06] px-4 py-3 text-[12.5px] text-ink-soft leading-relaxed">
        <strong className="text-ink">Cum citești tabelul:</strong>{" "}
        Aspirational este pragul top quartile (10-15% din industrie), necesită avantaje structurale ca cele
        descrise mai sus și 5-10+ ani execuție. Realistic este targetul rezonabil pentru o companie bine
        condusă, fără avantaje structurale extreme. Minimum viable este pragul sub care continuarea
        operațiunilor devine fragilă (incapacitate de capex, refinanțare).
      </div>
    </section>
  );
}

function DeepDynamicsSection({ deep }: { deep: DeepReport }) {
  const d = deep.dynamics;
  if (!d) return null;
  const labels: Record<string, string> = {
    concentration: "Concentrare",
    growth: "Creștere",
    regulation: "Reglementare",
    barriers: "Bariere intrare",
  };
  return (
    <section data-testid="benchmark-deep-dynamics" className="space-y-3">
      <h2 className="font-serif text-[20px] text-ink">5. Dinamica industriei</h2>
      <div className="rounded-2xl border border-rule bg-surface overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead className="bg-bg-2/40 text-[10.5px] uppercase tracking-[0.08em] text-ink-mute font-medium">
            <tr>
              <th className="text-left px-4 py-2.5">Aspect</th>
              <th className="text-left px-3 py-2.5">Verdict</th>
              <th className="text-left px-3 py-2.5">Detaliu</th>
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
          <h2 className="font-serif text-[20px] text-ink mb-2">6. Pattern-uri de succes în această industrie</h2>
          <ul className="list-disc pl-5 text-[12.5px] text-ink-soft leading-relaxed space-y-1">
            {deep.success_patterns.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {deep.failure_modes.length > 0 && (
        <div>
          <h2 className="font-serif text-[20px] text-ink mb-2">7. Moduri tipice de eșec</h2>
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
      <h2 className="font-serif text-[20px] text-ink">8. Context piața România</h2>
      <div className="rounded-lg border-l-[3px] border-blue-400 bg-blue-50/40 dark:bg-blue-500/[0.06] px-4 py-3 text-[13px] text-ink-soft leading-relaxed">
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
            <div className="inline-flex items-center justify-center h-8 w-8 rounded-xl bg-brand-tint text-brand-d ring-1 ring-brand/15">
              <Icon size={14} strokeWidth={1.75} />
            </div>
            <div className="mt-2 text-[10px] uppercase tracking-[0.14em] text-ink-mute font-semibold">
              {it.eyebrow}
            </div>
            <div className="mt-1 text-[14px] font-medium text-ink">{it.title}</div>
            <p className="mt-1 text-[12px] text-ink-soft leading-relaxed">{it.body}</p>
          </div>
        );
      })}
    </div>
  );
}

function navigateToDashboard(navigate: (to: string) => void): void {
  navigate("/dashboard");
}
