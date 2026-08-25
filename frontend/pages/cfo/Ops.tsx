// Ops — read-only engine-health surface (Part D observability wave).
//
// One glance = engine health: last full-battery result per gate, deployed
// versions (engine + jurisdiction packs + AI model registry), AI spend vs
// the breaker's daily caps, run-journal verification + DLQ depth, and the
// drift-sentinel notices. Everything on this page comes from a single
// GET /api/ops (see src/engine/api/_ops_routes.py) and the page never
// writes anything — the sentinel baseline is owned by the nightly
// `scripts/engine_ops.py sentinels` run, not by rendering this view.
//
// Aggregate operational metadata only: no statement amounts, no line
// items, no tenant financial data. Calm language throughout — a drift
// departure is a NOTICE to read, never a red alarm.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Activity,
  BookOpenCheck,
  CircleDollarSign,
  FlaskConical,
  Gauge,
  Layers,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { PageHeader } from "@/components/cfo/ui/PageHeader";
import { getSupabase } from "@/lib/supabase";
import { formatDateTime, useActiveLocale } from "@/lib/locale";
import { cn } from "@/lib/utils";
import "./opsI18n";

const apiBase = (): string =>
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";

// ── payload (mirrors engine.obs.status.ops_snapshot — every field
//    optional: each backend section degrades independently) ─────────────

interface BatteryGate {
  ok?: boolean;
  exit_code?: number;
  detail?: string | null;
}

interface ErrorBudgetLane {
  rate?: number | null;
  n?: number;
  ci_low?: number | null;
  ci_high?: number | null;
  sufficient?: boolean;
  silent_mismatches?: number;
  flagged_mismatches?: number;
}

interface OpsSnapshot {
  schema?: string;
  generated_at?: string;
  error_budget?: {
    measured?: boolean;
    path?: string;
    budgets?: { extraction?: number; classification?: number };
    per_lane?: Record<string, ErrorBudgetLane>;
  };
  battery?: {
    recorded?: boolean;
    ran_at?: string | null;
    gates?: Record<string, BatteryGate>;
    total?: number;
    passed?: number;
    all_green?: boolean;
  };
  versions?: {
    engine?: string;
    packs?:
      | Array<{
          jurisdiction?: string;
          pack_id?: string;
          version?: string;
          effective_from?: string;
          pack_hash_short?: string;
        }>
      | { error?: string };
    models?:
      | Record<string, { model_id?: string | null; prompt_version?: string | null }>
      | { error?: string };
  };
  ai_spend?: {
    day?: string;
    roles?: Record<
      string,
      {
        calls?: number;
        tokens?: number;
        limits?: { max_calls_per_day?: number; max_tokens_per_day?: number };
      }
    >;
    error?: string;
  };
  journal?: {
    enabled?: boolean;
    chains?: number;
    dlq_depth?: number;
    verified_ok?: boolean;
    verification?: { checked?: number; failed?: number };
  };
  sentinels?: {
    rates?: Record<string, number | null>;
    notices?: string[];
    departures?: Array<{ sentinel?: string }>;
  };
  metrics?: { rates?: Record<string, number | null> };
}

// ── tiny presentation helpers ──────────────────────────────────────────

function Card({
  icon: Icon,
  title,
  children,
  className,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-2xl border border-rule bg-surface p-5", className)}>
      <div className="mb-3 flex items-center gap-2">
        <Icon className="h-4 w-4 text-brand" />
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function Dot({ tone }: { tone: "ok" | "warn" | "mute" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block h-2 w-2 shrink-0 rounded-full",
        tone === "ok" && "bg-emerald-500",
        tone === "warn" && "bg-amber-500",
        tone === "mute" && "bg-ink-faint",
      )}
    />
  );
}

function CapBar({ used, cap }: { used: number; cap: number | undefined }) {
  const pct = cap && cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-bg-2">
      <div
        className={cn("h-full rounded-full", pct >= 90 ? "bg-amber-500" : "bg-brand/70")}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

// ── the page ───────────────────────────────────────────────────────────

export default function Ops() {
  const { t } = useTranslation();
  const locale = useActiveLocale();
  const [snapshot, setSnapshot] = useState<OpsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const sb = getSupabase();
      const { data } = sb ? await sb.auth.getSession() : { data: { session: null } };
      const token = data?.session?.access_token;
      const r = await fetch(`${apiBase()}/api/ops`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setSnapshot((await r.json()) as OpsSnapshot);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const fmtInt = (n: number | undefined) =>
    typeof n === "number" ? n.toLocaleString(locale) : "—";
  const fmtRate = (v: number | null | undefined) =>
    typeof v === "number" ? `${(v * 100).toFixed(1)}%` : t("ops.drift.noCoverage");

  const battery = snapshot?.battery;
  const packs = snapshot?.versions?.packs;
  const models = snapshot?.versions?.models;
  const roles = snapshot?.ai_spend?.roles ?? {};
  const journal = snapshot?.journal;
  const verification = journal?.verification ?? {};
  const notices = snapshot?.sentinels?.notices ?? [];
  const departures = snapshot?.sentinels?.departures ?? [];
  const rates = snapshot?.metrics?.rates ?? {};
  const errorBudget = snapshot?.error_budget;

  const fmtPct = (v: number | null | undefined, digits = 4) =>
    typeof v === "number" ? `${(v * 100).toFixed(digits)}%` : "—";
  const budgetLaneOrder = [
    "deterministic",
    "mechanical_mapped",
    "llm",
    "classification",
  ];
  const budgetLanes = errorBudget?.per_lane
    ? [
        ...budgetLaneOrder.filter((l) => errorBudget.per_lane?.[l]),
        ...Object.keys(errorBudget.per_lane).filter(
          (l) => !budgetLaneOrder.includes(l),
        ),
      ]
    : [];

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-16 sm:px-6">
      <PageHeader
        eyebrow={t("ops.eyebrow")}
        title={t("ops.title")}
        subtitle={t("ops.subtitle")}
        testid="ops-header"
        actions={
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-xl border border-rule bg-surface px-3.5 py-2 text-sm font-medium text-ink-soft transition-colors hover:bg-bg-2 disabled:opacity-50"
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            {t("ops.refresh")}
          </button>
        }
      />

      {loading && !snapshot && (
        <p className="text-sm text-ink-soft">{t("ops.loading")}</p>
      )}

      {failed && !snapshot && (
        <div className="rounded-2xl border border-rule bg-surface p-6 text-sm text-ink-soft">
          {t("ops.error")}{" "}
          <button
            type="button"
            onClick={() => void load()}
            className="font-medium text-brand hover:underline"
          >
            {t("ops.retry")}
          </button>
        </div>
      )}

      {snapshot && (
        <>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {/* Test battery */}
            <Card icon={FlaskConical} title={t("ops.battery.title")}>
              {battery?.recorded ? (
                <>
                  <p className="mb-3 flex items-center gap-2 text-sm text-ink">
                    <Dot tone={battery.all_green ? "ok" : "warn"} />
                    {t("ops.battery.gatesGreen", {
                      passed: battery.passed ?? 0,
                      total: battery.total ?? 0,
                    })}
                    {battery.ran_at ? (
                      <span className="text-xs text-ink-mute">
                        · {t("ops.battery.ranAt", { when: formatDateTime(battery.ran_at) })}
                      </span>
                    ) : null}
                  </p>
                  <ul className="space-y-1.5">
                    {Object.entries(battery.gates ?? {}).map(([name, gate]) => (
                      <li key={name} className="flex items-center gap-2 text-[13px]">
                        <Dot tone={gate?.ok ? "ok" : "warn"} />
                        <span className="font-mono text-ink-soft">{name}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="flex items-center gap-2 text-sm text-ink-soft">
                  <Dot tone="mute" />
                  {t("ops.battery.notRecorded")}
                </p>
              )}
            </Card>

            {/* Run journal */}
            <Card icon={BookOpenCheck} title={t("ops.journal.title")}>
              {journal?.enabled ? (
                <ul className="space-y-2 text-sm text-ink">
                  <li className="flex items-center gap-2">
                    <Dot tone="ok" />
                    {fmtInt(journal.chains)} {t("ops.journal.chains")}
                  </li>
                  <li className="flex items-center gap-2">
                    {verification.checked ? (
                      journal.verified_ok ? (
                        <>
                          <Dot tone="ok" />
                          {t("ops.journal.verified", { checked: verification.checked })}
                        </>
                      ) : (
                        <>
                          <Dot tone="warn" />
                          {t("ops.journal.failed", {
                            failed: verification.failed ?? 0,
                            checked: verification.checked,
                          })}
                        </>
                      )
                    ) : (
                      <>
                        <Dot tone="mute" />
                        {t("ops.journal.noChains")}
                      </>
                    )}
                  </li>
                  <li className="flex items-center gap-2">
                    <Dot tone={(journal.dlq_depth ?? 0) > 0 ? "warn" : "ok"} />
                    {t("ops.journal.dlq")}: {fmtInt(journal.dlq_depth ?? 0)}
                  </li>
                </ul>
              ) : (
                <p className="flex items-center gap-2 text-sm text-ink-soft">
                  <Dot tone="mute" />
                  {t("ops.journal.disabled")}
                </p>
              )}
            </Card>

            {/* Drift sentinels */}
            <Card icon={Activity} title={t("ops.drift.title")}>
              <p className="mb-3 flex items-center gap-2 text-sm text-ink">
                <Dot tone={departures.length ? "warn" : "ok"} />
                {departures.length
                  ? t("ops.drift.departures", { count: departures.length })
                  : t("ops.drift.steady")}
              </p>
              <dl className="mb-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[13px] sm:grid-cols-4">
                {(
                  [
                    ["rateUnclassified", "unclassified_rate"],
                    ["rateLlmFallback", "frontend_fallback_rate"],
                    ["rateAiProposals", "ai_proposal_rate"],
                    ["rateCacheHits", "cache_hit_rate"],
                    ["rateConsensus", "consensus_agreement_rate"],
                    ["rateInterpreter", "interpreter_call_rate"],
                    ["rateTemplateHits", "template_hit_rate"],
                  ] as const
                ).map(([labelKey, rateKey]) => (
                  <div key={rateKey}>
                    <dt className="text-[11px] uppercase tracking-wide text-ink-mute">
                      {t(`ops.drift.${labelKey}`)}
                    </dt>
                    <dd className="font-mono tabular-nums text-ink">
                      {fmtRate(rates[rateKey])}
                    </dd>
                  </div>
                ))}
              </dl>
              {notices.length > 0 && (
                <div>
                  <p className="mb-1 text-[11px] uppercase tracking-wide text-ink-mute">
                    {t("ops.drift.noticesLabel")}
                  </p>
                  <ul className="space-y-1">
                    {notices.map((notice, i) => (
                      <li
                        key={i}
                        className="break-words font-mono text-[11.5px] leading-relaxed text-ink-soft"
                      >
                        {notice}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Card>

            {/* AI spend vs caps */}
            <Card icon={CircleDollarSign} title={t("ops.spend.title")}>
              {Object.keys(roles).length ? (
                <>
                  {snapshot.ai_spend?.day && (
                    <p className="mb-3 text-xs text-ink-mute">
                      {t("ops.spend.day", { day: snapshot.ai_spend.day })}
                    </p>
                  )}
                  <ul className="space-y-2.5">
                    {Object.entries(roles).map(([role, entry]) => (
                      <li key={role}>
                        <div className="mb-1 flex items-baseline justify-between gap-2 text-[13px]">
                          <span className="font-mono text-ink-soft">{role}</span>
                          <span className="font-mono tabular-nums text-ink-mute">
                            {fmtInt(entry.calls ?? 0)}/{fmtInt(entry.limits?.max_calls_per_day)}{" "}
                            {t("ops.spend.calls")} · {fmtInt(entry.tokens ?? 0)}/
                            {fmtInt(entry.limits?.max_tokens_per_day)} {t("ops.spend.tokens")}
                          </span>
                        </div>
                        <CapBar
                          used={entry.tokens ?? 0}
                          cap={entry.limits?.max_tokens_per_day}
                        />
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="flex items-center gap-2 text-sm text-ink-soft">
                  <Dot tone="mute" />
                  {t("ops.spend.none")}
                </p>
              )}
            </Card>

            {/* Error budget — silent-error rate per lane, honest about N */}
            <Card icon={Gauge} title={t("ops.errorBudget.title")}>
              {errorBudget?.measured && budgetLanes.length ? (
                <>
                  <p className="mb-3 text-xs text-ink-mute">
                    {t("ops.errorBudget.definition")}
                  </p>
                  <ul className="space-y-2.5">
                    {budgetLanes.map((lane) => {
                      const row = errorBudget.per_lane?.[lane] ?? {};
                      const n = row.n ?? 0;
                      const silent = row.silent_mismatches ?? 0;
                      return (
                        <li key={lane}>
                          <div className="flex items-baseline justify-between gap-2 text-[13px]">
                            <span className="flex items-center gap-2">
                              <Dot tone={n === 0 ? "mute" : silent > 0 ? "warn" : "ok"} />
                              <span className="font-mono text-ink-soft">
                                {t(`ops.errorBudget.lane.${lane}`, {
                                  defaultValue: lane,
                                })}
                              </span>
                            </span>
                            <span className="font-mono tabular-nums text-ink">
                              {n === 0
                                ? t("ops.errorBudget.noSource")
                                : t("ops.errorBudget.measured", {
                                    rate: fmtPct(row.rate),
                                    n: fmtInt(n),
                                  })}
                            </span>
                          </div>
                          {n > 0 && (
                            <p className="mt-0.5 pl-4 text-[11.5px] text-ink-mute">
                              {t("ops.errorBudget.ci", {
                                low: fmtPct(row.ci_low),
                                high: fmtPct(row.ci_high),
                              })}
                              {!row.sufficient &&
                                ` · ${t("ops.errorBudget.insufficient")}`}
                              {(row.flagged_mismatches ?? 0) > 0 &&
                                ` · ${t("ops.errorBudget.flagged", {
                                  count: row.flagged_mismatches,
                                })}`}
                            </p>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </>
              ) : (
                <p className="flex items-center gap-2 text-sm text-ink-soft">
                  <Dot tone="mute" />
                  {t("ops.errorBudget.notMeasured")}
                </p>
              )}
            </Card>
          </div>

          {/* Deployed versions — full width */}
          <Card icon={Layers} title={t("ops.versions.title")} className="mt-4">
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
              <div>
                <p className="mb-1.5 text-[11px] uppercase tracking-wide text-ink-mute">
                  {t("ops.versions.engine")}
                </p>
                <p className="mb-4 font-mono text-[13px] text-ink">
                  {snapshot.versions?.engine ?? "—"}
                </p>
                <p className="mb-1.5 text-[11px] uppercase tracking-wide text-ink-mute">
                  {t("ops.versions.packs")}
                </p>
                <ul className="space-y-1.5">
                  {Array.isArray(packs) ? (
                    packs.map((pack) => (
                      <li
                        key={`${pack.jurisdiction}-${pack.pack_id}`}
                        className="flex flex-wrap items-baseline gap-x-2 font-mono text-[12.5px] text-ink-soft"
                      >
                        <span className="font-semibold text-ink">{pack.jurisdiction}</span>
                        <span>
                          {pack.pack_id} v{pack.version}
                        </span>
                        <span className="text-ink-mute">
                          {t("ops.versions.packFrom", { date: pack.effective_from })}
                        </span>
                        <span className="text-ink-faint">
                          {t("ops.versions.hash")} {pack.pack_hash_short}
                        </span>
                      </li>
                    ))
                  ) : (
                    <li className="text-[13px] text-ink-mute">—</li>
                  )}
                </ul>
              </div>
              <div>
                <p className="mb-1.5 text-[11px] uppercase tracking-wide text-ink-mute">
                  {t("ops.versions.models")}
                </p>
                <ul className="space-y-1.5">
                  {models && !("error" in models) ? (
                    Object.entries(models).map(([role, row]) => (
                      <li
                        key={role}
                        className="flex flex-wrap items-baseline gap-x-2 font-mono text-[12.5px]"
                      >
                        <span className="text-ink-soft">{role}</span>
                        <span className="text-ink">{row?.model_id ?? "—"}</span>
                      </li>
                    ))
                  ) : (
                    <li className="text-[13px] text-ink-mute">—</li>
                  )}
                </ul>
              </div>
            </div>
          </Card>

          <p className="mt-4 flex items-center gap-1.5 text-[11.5px] text-ink-faint">
            <ShieldCheck className="h-3.5 w-3.5" />
            {snapshot.generated_at
              ? t("ops.generatedAt", { when: formatDateTime(snapshot.generated_at) })
              : null}
          </p>
        </>
      )}
    </div>
  );
}
