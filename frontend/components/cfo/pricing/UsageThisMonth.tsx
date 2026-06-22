// UsageThisMonth.tsx — usage cards rendered on the authed view of
// /pricing (spec §7). Reads server truth via `usePlanState` and renders
// up to 4 cards:
//
//   1. Documents uploaded  ─ used / included (+ extras inline)
//   2. Ask CFO AI          ─ monthly + today/daily
//   3. Reports generated   ─ usage only (no cap on the report layer
//                            today — analyses ≈ reports)
//   4. Storage             ─ HIDDEN. Spec §7: "If storage backend not
//                            implemented: hide this card or mark
//                            Coming soon. Do not show fake usage."
//                            We chose hide.
//
// All numbers come from /api/plan/state. If the request fails or the
// user isn't authenticated, the whole section silently renders nothing
// — /pricing is also the public marketing surface and an error card
// here would be noise for unauthed visitors.

import { MessageSquare, ScrollText, UploadCloud } from "lucide-react";

import { planUsagePct, usePlanState, type PlanState } from "@/lib/planState";

export function UsageThisMonth() {
  const { state, loading, error } = usePlanState();
  // Unauthed / not-loaded / error → render nothing. The /pricing page
  // is also the public marketing surface; this section is only
  // meaningful for signed-in users. PlanUsageCard in Settings has the
  // explicit error/retry surface for the authed Settings view.
  if (loading || error || !state) return null;

  return (
    <section
      data-testid="usage-this-month"
      className="max-w-[1080px] mx-auto px-5 sm:px-8 py-10"
    >
      <header className="mb-6">
        <div className="text-[10.5px] uppercase tracking-[0.16em] text-ink-mute font-medium">
          This month's usage
        </div>
        <h2 className="mt-2 font-serif text-[26px] sm:text-[32px] leading-[1.1] text-ink">
          Where you stand right now.
        </h2>
      </header>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <DocumentsCard state={state} />
        <ChatCard state={state} />
        <ReportsCard state={state} />
        {/* Storage card intentionally omitted — spec §7 forbids fake
            usage. When the storage backend ships, render a 4th card
            with the same shape (used / cap + progress bar). */}
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Documents card
// ─────────────────────────────────────────────────────────────────────

function DocumentsCard({ state }: { state: PlanState }) {
  const pct = planUsagePct(state.docs_used, state.included_docs);
  const extrasBilled = state.extra_docs_billed_this_period;
  const extrasPending = state.extra_docs_pending_this_period ?? 0;
  return (
    <UsageCard
      icon={UploadCloud}
      testId="usage-documents"
      label="Financial documents"
      primary={`${state.docs_used} / ${state.included_docs} included`}
      meta={`Cap: ${state.included_docs}`}
      pct={pct}
      footnote={
        extrasBilled + extrasPending > 0
          ? `${extrasBilled} extra billed${extrasPending > 0 ? ` · ${extrasPending} pending` : ""}`
          : null
      }
    />
  );
}

// ─────────────────────────────────────────────────────────────────────
// Chat card — combines monthly + daily into one card so the user sees
// both caps at a glance. Spec §7 example: "23 / 200 messages · Today
// 7 / 40".
// ─────────────────────────────────────────────────────────────────────

function ChatCard({ state }: { state: PlanState }) {
  const monthly = state.chat_monthly_cap;
  const daily = state.chat_daily_cap;
  const monthlyPct = planUsagePct(state.chat_used_this_period, monthly);
  return (
    <UsageCard
      icon={MessageSquare}
      testId="usage-chat"
      label="Ask CFO AI"
      primary={
        monthly !== null
          ? `${state.chat_used_this_period} / ${monthly} messages`
          : `${state.chat_used_this_period} messages`
      }
      meta={
        daily !== null
          ? `Today: ${state.chat_used_today} / ${daily}`
          : null
      }
      pct={monthlyPct}
      footnote={null}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────
// Reports card — usage-only, no enforced cap. Reports are 1:1 with
// successful analyses today, so we surface `docs_used` as the proxy.
// When a separate report-generation surface lands (PDF/HTML export with
// its own counter), this card switches to that counter.
// ─────────────────────────────────────────────────────────────────────

function ReportsCard({ state }: { state: PlanState }) {
  const reports = state.docs_used;
  return (
    <UsageCard
      icon={ScrollText}
      testId="usage-reports"
      label="Reports generated"
      primary={`${reports} generated`}
      meta={null}
      pct={null}
      footnote="Usage only — no cap on report exports"
    />
  );
}

// ─────────────────────────────────────────────────────────────────────
// UsageCard — shared shell. pct=null renders no progress bar (used
// for the cap-less Reports card).
// ─────────────────────────────────────────────────────────────────────

function UsageCard({
  icon: Icon,
  testId,
  label,
  primary,
  meta,
  pct,
  footnote,
}: {
  icon: typeof UploadCloud;
  testId: string;
  label: string;
  primary: string;
  meta: string | null;
  pct: number | null;
  footnote: string | null;
}) {
  return (
    <article
      data-testid={testId}
      className="rounded-2xl border border-rule bg-surface/70 backdrop-blur-sm px-5 py-4"
    >
      <div className="inline-flex items-center gap-2 text-[12px] text-ink-soft">
        <Icon size={13} strokeWidth={1.75} />
        {label}
      </div>
      <div className="mt-2 text-[18px] font-semibold text-ink tabular-nums">
        {primary}
      </div>
      {meta && (
        <div className="text-[11.5px] text-ink-mute tabular-nums mt-0.5">
          {meta}
        </div>
      )}
      {pct !== null && (
        <div className="mt-3 h-1.5 rounded-full bg-rule overflow-hidden">
          <div
            className={`h-full rounded-full transition-[width] ${pct >= 100 ? "bg-amber-500" : "bg-brand"}`}
            style={{ width: `${pct}%` }}
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={label}
          />
        </div>
      )}
      {footnote && (
        <div className="text-[11px] text-ink-mute mt-2 leading-snug">
          {footnote}
        </div>
      )}
    </article>
  );
}
