// NASDAQ-12 — §24-compliant "subscription required" empty state.
//
// Rendered on the public-company dashboard when the API responds with
// `subscription_required: true` (Nasdaq returned 200 + empty data + the
// SF1 column schema — the free-tier indicator that the operator needs to
// add Sharadar Equities). No traceback, single CTA, hint about what
// changes when activated. Instrument pass (2026-08): tokens only, no
// resting glow, sans headline.

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
        rounded-md border border-rule bg-surface
        p-7 sm:p-9
      "
    >
      <div className="
        flex h-12 w-12 items-center justify-center
        rounded-md bg-brand-tint text-brand-d dark:text-brand-l
        mb-4
      ">
        <Lock size={22} strokeWidth={1.75} />
      </div>

      <h2 className="text-[20px] font-semibold text-ink tracking-[-0.005em] leading-snug">
        Sharadar SF1 subscription required to load {ticker} financials
      </h2>
      <p className="text-[13.5px] text-ink-soft mt-3 leading-relaxed max-w-[480px]">
        Nasdaq returned the column schema for SF1 fundamentals but no row data —
        the standard signal that the operator's API key is on the free tier and
        doesn't include this dataset.
      </p>

      <div className="
        mt-6 grid sm:grid-cols-2 gap-3
      ">
        <div className="
          rounded-md border border-rule bg-bg-2 p-4
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
          rounded-md border border-brand/30 bg-brand-tint/60
          p-4
        ">
          <div className="text-[11px] uppercase tracking-[0.1em] font-semibold text-brand-d dark:text-brand-l">
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
          h-10 px-5 rounded-md
          bg-ink text-paper
          text-[13px] font-medium
          hover:bg-ink/90
          transition-colors duration-micro
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
