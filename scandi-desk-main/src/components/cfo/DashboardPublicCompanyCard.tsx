// NASDAQ-7 — Dashboard empty-state second door: "Search public companies".
//
// Mounted in FinancialStatements.tsx's empty state, below the upload zone +
// sample picker. Apple-clean styling: subtle teal accent, big serif numeral
// for "+10K", chevron-affordance CTA. One click → /dashboard/public/search.
//
// Visual contract:
//   · No technical noise unless the user opens details
//   · Source badge ("Nasdaq Data Link · Sharadar") visible but understated
//   · Polished hover state — slight lift, brighter ring
//
// This card is the entry point to the entire public-company surface. Every
// downstream component (search page, public dashboard, valuation, benchmark
// peers) is reachable from here.

import { Link } from "react-router-dom";
import { ArrowRight, Globe2, Sparkles } from "lucide-react";

interface Props {
  /** Optional className for parent-layout spacing. */
  className?: string;
}

export function DashboardPublicCompanyCard({ className = "" }: Props) {
  return (
    <Link
      to="/dashboard/public/search"
      data-testid="dashboard-public-company-card"
      className={`
        group relative overflow-hidden block
        rounded-2xl border border-rule
        bg-gradient-to-br from-surface via-surface to-bg-2/40
        p-6 sm:p-7
        transition-all
        hover:border-brand/40 hover:shadow-[0_10px_30px_-12px_rgba(45,191,179,0.25)]
        hover:-translate-y-[1px]
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50
        ${className}
      `}
    >
      {/* Atmospheric teal glow on hover */}
      <div
        aria-hidden
        className="
          pointer-events-none absolute -top-16 -right-12 h-44 w-44 rounded-full
          bg-brand/5 blur-3xl
          opacity-0 group-hover:opacity-100 transition-opacity duration-500
        "
      />

      <div className="relative flex items-start gap-4">
        {/* Icon — teal-ish accent, refined */}
        <div className="
          flex h-12 w-12 shrink-0 items-center justify-center
          rounded-2xl bg-gradient-to-br from-brand/15 to-brand-d/20 text-brand-d
          ring-1 ring-brand/15
        ">
          <Globe2 size={20} strokeWidth={1.75} />
        </div>

        <div className="flex-1 min-w-0">
          {/* Eyebrow */}
          <div className="flex items-center gap-1.5 mb-1">
            <Sparkles size={11} strokeWidth={2} className="text-brand-d" />
            <span className="text-[10.5px] uppercase tracking-[0.12em] font-semibold text-brand-d">
              Public companies · Nasdaq
            </span>
          </div>

          <h3 className="text-[18px] font-semibold text-ink tracking-[-0.005em]">
            Search any Nasdaq-listed company
          </h3>
          <p className="text-[12.5px] text-ink-soft mt-1 max-w-[440px] leading-relaxed">
            Analyse Apple, Microsoft, Tesla — or any of the 16,000+ tickers covered by
            Sharadar Equities. Same dashboard, same ratios engine, same chat. Add as a
            benchmark peer next to your private company.
          </p>

          <div className="mt-4 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-brand-d group-hover:gap-2 transition-all">
            Browse public companies
            <ArrowRight size={14} strokeWidth={2} />
          </div>
        </div>
      </div>

      {/* Bottom source tag — calm, not loud */}
      <div className="relative mt-5 pt-4 border-t border-rule/60 flex items-center justify-between gap-3 text-[10.5px]">
        <span className="text-ink-mute">
          Source: <span className="font-medium text-ink-soft">Nasdaq Data Link · Sharadar</span>
        </span>
        <span className="text-ink-mute">USD-reported · annual & quarterly</span>
      </div>
    </Link>
  );
}
