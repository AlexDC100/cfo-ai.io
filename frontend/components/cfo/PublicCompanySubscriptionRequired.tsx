// NASDAQ-12 — §24-compliant "subscription required" empty state.
//
// Rendered on the public-company dashboard when the API responds with
// `subscription_required: true` (Nasdaq returned 200 + empty data + the
// SF1 column schema — the free-tier indicator that the operator needs to
// add Sharadar Equities). Apple-clean: no traceback, single CTA, hint
// about what changes when activated.

import { Lock, ArrowRight } from "lucide-react";

interface Props {
  ticker: string;
}

export function PublicCompanySubscriptionRequired({ ticker }: Props) {
  return (
    <div
      data-testid="public-company-subscription-required"
      className="
        max-w-2xl mx-auto my-12
        rounded-2xl border border-amber-300/40
        bg-gradient-to-br from-amber-50/40 to-surface
        dark:from-amber-500/[0.06] dark:to-surface
        p-7 sm:p-9
      "
    >
      <div className="
        flex h-12 w-12 items-center justify-center
        rounded-2xl bg-amber-500/15 text-amber-700 dark:text-amber-300
        mb-4
      ">
        <Lock size={22} strokeWidth={1.75} />
      </div>

      <h2 className="font-serif text-[24px] text-ink tracking-[-0.005em]">
        Sharadar SF1 subscription required to load {ticker} financials
      </h2>
      <p className="text-[13.5px] text-ink-soft mt-3 leading-relaxed max-w-[480px]">
        Nasdaq returned the column schema for SF1 fundamentals but no row data —
        the standard signal that the operator's API key is on the free tier and
        doesn't include the paid Sharadar Equities Bundle.
      </p>

      <div className="
        mt-6 grid sm:grid-cols-2 gap-3
      ">
        <div className="
          rounded-xl border border-rule bg-surface p-4
        ">
          <div className="text-[11px] uppercase tracking-[0.1em] font-semibold text-ink-mute">
            Available now (free tier)
          </div>
          <ul className="mt-2 text-[12.5px] text-ink-soft space-y-1">
            <li>· Ticker search across 16,000+ companies</li>
            <li>· Sector + industry classification</li>
            <li>· Exchange + listing status</li>
          </ul>
        </div>
        <div className="
          rounded-xl border border-amber-300/40 bg-amber-50/40
          dark:bg-amber-500/[0.06]
          p-4
        ">
          <div className="text-[11px] uppercase tracking-[0.1em] font-semibold text-amber-800 dark:text-amber-300">
            Unlocked with SF1 (~$49/mo)
          </div>
          <ul className="mt-2 text-[12.5px] text-ink-soft space-y-1">
            <li>· 25 years of annual + quarterly financials</li>
            <li>· Income statement · BS · cash flow</li>
            <li>· Daily market cap, EV, P/E, EV/EBITDA</li>
            <li>· Add as benchmark peer to your private company</li>
          </ul>
        </div>
      </div>

      <a
        href="https://data.nasdaq.com/databases/SF1"
        target="_blank"
        rel="noopener noreferrer"
        className="
          mt-6 inline-flex items-center gap-1.5
          h-10 px-5 rounded-lg
          bg-gradient-to-b from-brand to-brand-d text-paper
          text-[13px] font-medium
          shadow-[0_8px_22px_-8px_rgba(45,191,179,0.6)]
          hover:shadow-[0_10px_26px_-8px_rgba(45,191,179,0.75)]
          ring-1 ring-inset ring-white/15
          transition-all
        "
      >
        Subscribe to Sharadar Equities
        <ArrowRight size={14} strokeWidth={2} />
      </a>
      <p className="text-[11px] text-ink-mute mt-3">
        Subscription is managed in your Nasdaq Data Link account. Once active,
        refresh this page — the dashboard populates automatically.
      </p>
    </div>
  );
}
