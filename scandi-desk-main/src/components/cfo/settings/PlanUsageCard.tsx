// PlanUsageCard.tsx — Settings page card showing the caller's current
// plan + live usage vs caps.
//
// READS
//   GET /api/plan/state — server is source of truth for billing state.
//
// WHAT IT SHOWS
//   · Current plan name + price + recurring/one-time
//   · Documents used / included this period + extras billed
//   · Chat usage today vs daily cap, monthly vs monthly cap
//   · Intro-unlock expiry when present
//   · Upgrade CTA when on trial or near a cap
//
// WHAT IT DOES NOT DO
//   · Charge for upgrades — that's the existing Stripe checkout flow
//     in `BillingSection.tsx`. This card LINKS to it but never bills.
//   · Trust the client clock — `today` and `period_month` come from
//     the server response.

import { AlertCircle, CreditCard, ExternalLink, MessageSquare, RotateCcw, Sparkles, UploadCloud } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { planUsagePct, usePlanState } from "@/lib/planState";

export function PlanUsageCard() {
  const { state, loading, error, refresh } = usePlanState();
  const navigate = useNavigate();

  if (loading) {
    return (
      <div
        data-testid="plan-usage-card-loading"
        className="rounded-xl border border-rule bg-surface px-4 py-3 text-[13px] text-ink-mute"
      >
        Loading plan…
      </div>
    );
  }

  if (error || !state) {
    return (
      <div
        data-testid="plan-usage-card-error"
        className="rounded-xl border border-amber-300/60 bg-amber-50/40 px-4 py-3"
      >
        <div className="flex items-center gap-2 text-[12.5px] text-amber-800">
          <AlertCircle size={13} strokeWidth={1.75} />
          Couldn't load plan state.{" "}
          <button
            onClick={() => void refresh()}
            className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
          >
            <RotateCcw size={11} strokeWidth={2} /> retry
          </button>
        </div>
      </div>
    );
  }

  const docPct = planUsagePct(state.docs_used, state.included_docs);
  const dailyPct = planUsagePct(state.chat_used_today, state.chat_daily_cap);
  const monthlyPct = planUsagePct(state.chat_used_this_period, state.chat_monthly_cap);
  const onTrial = state.plan_key === "trial" || state.plan_key === "intro";
  const docOverage = state.docs_used >= state.included_docs;
  const chatBlocked =
    (state.chat_daily_cap !== null && state.chat_used_today >= state.chat_daily_cap) ||
    (state.chat_monthly_cap !== null && state.chat_used_this_period >= state.chat_monthly_cap);

  return (
    <div
      data-testid="plan-usage-card"
      data-plan={state.plan_key}
      className="rounded-xl border border-rule bg-surface divide-y divide-rule"
    >
      {/* ── Plan header ─────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium">
            Current plan
          </div>
          <div className="mt-0.5 flex items-baseline gap-2">
            <span className="text-[15px] font-medium text-ink">
              {state.plan_display_name}
            </span>
            <span className="text-[12px] text-ink-soft">
              €{state.plan_price_eur.toFixed(2)}{" "}
              {state.plan_recurring ? "/ mo" : state.plan_price_eur > 0 ? "one-time" : ""}
            </span>
          </div>
          {state.window_expires_at && (
            <div className="text-[11.5px] text-ink-mute mt-0.5">
              Window expires {new Date(state.window_expires_at).toLocaleDateString("en-GB", { dateStyle: "medium" })}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => navigate("/pricing")}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-rule bg-bg-2 text-[12px] font-medium text-ink hover:bg-bg-2/70 transition-colors"
        >
          {onTrial ? "Upgrade" : "Manage plan"}
          <ExternalLink size={11} strokeWidth={1.75} />
        </button>
      </div>

      {/* ── Documents this period ─────────────────────────────── */}
      <div className="px-4 py-3">
        <UsageBar
          icon={UploadCloud}
          label="Documents this period"
          used={state.docs_used}
          cap={state.included_docs}
          pct={docPct}
          extraInfo={(() => {
            // Pricing V3 (gap D) — distinguish "billed" vs "pending"
            // extras. Pending = user confirmed the charge but the
            // analysis is still running; it'll flip to billed on
            // success or evaporate on failure (no charge).
            const billed = state.extra_docs_billed_this_period;
            const pending = state.extra_docs_pending_this_period ?? 0;
            if (billed === 0 && pending === 0) return null;
            const parts: string[] = [];
            if (billed > 0) parts.push(`${billed} extra${billed === 1 ? "" : "s"} billed`);
            if (pending > 0) parts.push(`${pending} pending`);
            return parts.join(" · ");
          })()}
          overText={
            docOverage && state.extra_doc_eur !== null
              ? `Next document: +€${state.extra_doc_eur.toFixed(2)} extra`
              : docOverage && state.extra_doc_eur === null
              ? "Upgrade to analyze more documents"
              : null
          }
        />
        {/* Gap-D explicit copy — users need to know that failed
            analyses don't count. Only renders when the user has at
            least one extra in flight (billed or pending), so it
            doesn't clutter the card otherwise. */}
        {(state.extra_docs_billed_this_period > 0 ||
          (state.extra_docs_pending_this_period ?? 0) > 0) && (
          <p
            data-testid="plan-failed-doc-note"
            className="mt-1.5 text-[11px] text-ink-mute leading-snug"
          >
            You're only charged for documents that finish analysis
            successfully. Failed runs (parse error, unsupported format)
            release the slot and don't appear here.
          </p>
        )}
      </div>

      {/* ── Ask CFO AI chat ─────────────────────────────────────── */}
      <div className="px-4 py-3 space-y-3">
        {state.chat_daily_cap !== null && (
          <UsageBar
            icon={MessageSquare}
            label="Ask CFO AI — today"
            used={state.chat_used_today}
            cap={state.chat_daily_cap}
            pct={dailyPct}
            extraInfo={null}
            overText={
              state.chat_used_today >= state.chat_daily_cap
                ? "Daily cap reached — resets at midnight UTC"
                : null
            }
          />
        )}
        {state.chat_monthly_cap !== null && (
          <UsageBar
            icon={MessageSquare}
            label="Ask CFO AI — this month"
            used={state.chat_used_this_period}
            cap={state.chat_monthly_cap}
            pct={monthlyPct}
            extraInfo={null}
            overText={
              state.chat_used_this_period >= state.chat_monthly_cap
                ? "Monthly cap reached — resets at the start of your next billing period"
                : null
            }
          />
        )}
        {chatBlocked && (
          <button
            type="button"
            onClick={() => navigate("/pricing")}
            className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-brand-d hover:text-brand transition-colors"
          >
            <Sparkles size={12} strokeWidth={2} />
            Upgrade for more headroom →
          </button>
        )}
      </div>

      {/* ── Billing footer ─────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3 px-4 py-2.5 text-[11.5px] text-ink-mute">
        <span>Period: {state.period_month} · Today: {state.today}</span>
        <button
          type="button"
          onClick={() => navigate("/settings#billing")}
          className="inline-flex items-center gap-1 hover:text-ink transition-colors"
        >
          <CreditCard size={11} strokeWidth={1.75} />
          Billing details
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// UsageBar — a single labeled used/cap bar
// ─────────────────────────────────────────────────────────────────────

function UsageBar({
  icon: Icon,
  label,
  used,
  cap,
  pct,
  extraInfo,
  overText,
}: {
  icon: typeof UploadCloud;
  label: string;
  used: number;
  cap: number;
  pct: number;
  extraInfo: string | null;
  overText: string | null;
}) {
  const reached = used >= cap;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <div className="inline-flex items-center gap-2 text-[12.5px] text-ink-soft">
          <Icon size={12} strokeWidth={1.75} />
          {label}
        </div>
        <div className={`font-mono tabular-nums text-[12px] ${reached ? "text-amber-700" : "text-ink-soft"}`}>
          {used} / {cap}
        </div>
      </div>
      <div className="mt-1.5 h-1.5 rounded-full bg-rule overflow-hidden">
        <div
          className={`h-full rounded-full transition-[width] ${reached ? "bg-amber-500" : "bg-brand"}`}
          style={{ width: `${pct}%` }}
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          role="progressbar"
          aria-label={label}
        />
      </div>
      {(extraInfo || overText) && (
        <div className="mt-1 flex items-center justify-between gap-2 text-[11px]">
          <span className={overText ? "text-amber-700" : "text-ink-mute"}>{overText ?? ""}</span>
          <span className="text-ink-mute">{extraInfo ?? ""}</span>
        </div>
      )}
    </div>
  );
}
