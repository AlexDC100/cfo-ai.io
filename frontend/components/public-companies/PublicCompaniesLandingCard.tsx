// Premium landing-page module card for Public Company Intelligence.
//
// Mounted on the Dashboard empty state next to the Upload zone. Same visual
// weight as Trial Balances — full-bleed card with ticker chips, mini KPI
// row, atmospheric teal glow, polished hover state. Click anywhere → routes
// to /public-companies (the dedicated hub page).

import { Link } from "react-router-dom";
import { ArrowRight, Globe2, Sparkles, TrendingUp } from "lucide-react";
import { DEMO_WATCHLIST } from "@/lib/publicCompanyWatchlist";

const PREVIEW_TICKERS = DEMO_WATCHLIST.slice(0, 6).map((r) => r.ticker);

interface Props {
  className?: string;
}

export function PublicCompaniesLandingCard({ className = "" }: Props) {
  return (
    <Link
      to="/public-companies"
      data-testid="public-companies-landing-card"
      className={`
        group relative overflow-hidden block
        rounded-3xl border border-rule
        bg-gradient-to-br from-surface via-surface to-bg-2/40
        p-7 sm:p-8
        transition-all
        hover:border-brand/40 hover:shadow-[0_20px_60px_-20px_rgba(42,168,155,0.25)]
        hover:-translate-y-[1px]
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50
        ${className}
      `}
    >
      {/* Atmospheric teal glow on hover */}
      <div
        aria-hidden
        className="
          pointer-events-none absolute -top-24 -right-16 h-72 w-72 rounded-full
          bg-brand/8 blur-3xl
          opacity-0 group-hover:opacity-100 transition-opacity duration-500
        "
      />
      <div
        aria-hidden
        className="
          pointer-events-none absolute -bottom-20 -left-16 h-56 w-56 rounded-full
          bg-brand-2/6 blur-3xl
        "
      />

      <div className="relative flex flex-col gap-6 sm:gap-7">
        {/* Header row — icon + title block + CTA chevron */}
        <div className="flex items-start gap-4">
          <div className="
            flex h-14 w-14 shrink-0 items-center justify-center
            rounded-2xl bg-gradient-to-br from-brand/20 to-brand-d/25 text-brand-d
            ring-1 ring-brand/15
          ">
            <Globe2 size={24} strokeWidth={1.75} />
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 mb-1.5">
              <Sparkles size={11} strokeWidth={2} className="text-brand-d" />
              <span className="text-[10.5px] uppercase tracking-[0.14em] font-semibold text-brand-d">
                Module · Nasdaq / SEC public data
              </span>
            </div>
            <h3 className="font-serif text-[24px] sm:text-[28px] text-ink leading-tight tracking-[-0.012em]">
              Public Company Intelligence
            </h3>
            <p className="text-[13.5px] text-ink-soft mt-2 max-w-[520px] leading-relaxed">
              Benchmark public companies, pull market data, and compare financial
              performance side-by-side with your private books.
            </p>
          </div>

          <ArrowRight
            size={18}
            strokeWidth={1.75}
            className="
              hidden sm:block shrink-0 mt-2 text-ink-mute
              group-hover:text-brand-d group-hover:translate-x-1
              transition-all
            "
          />
        </div>

        {/* Ticker chips strip */}
        <div className="flex flex-wrap items-center gap-2" data-testid="public-companies-landing-tickers">
          {PREVIEW_TICKERS.map((t) => (
            <span
              key={t}
              className="
                inline-flex items-center
                h-7 px-2.5 rounded-md
                font-mono text-[11.5px] font-semibold tabular-nums
                bg-bg-2/60 text-ink-soft
                border border-rule/60
                group-hover:bg-brand/8 group-hover:border-brand/25 group-hover:text-brand-d
                transition-colors
              "
            >
              {t}
            </span>
          ))}
          <span className="text-[11px] text-ink-mute ml-1">+ 16,000 more</span>
        </div>

        {/* Mini KPI tiles — what the module gives you */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5" data-testid="public-companies-landing-kpis">
          <MiniKpi label="Market Cap" sample="$3.78T" />
          <MiniKpi label="EV / EBITDA" sample="28.4×" />
          <MiniKpi label="FCF Yield" sample="2.9%" />
          <MiniKpi label="Debt / EBITDA" sample="0.31×" />
        </div>

        {/* Footer — CTA + secondary line */}
        <div className="flex items-center justify-between gap-3 pt-1">
          <div className="
            inline-flex items-center gap-1.5
            h-10 px-4 rounded-lg
            bg-gradient-to-b from-brand to-brand-d text-paper
            text-[13px] font-medium
            shadow-[0_8px_22px_-8px_rgba(42,168,155,0.6)]
            ring-1 ring-inset ring-white/15
            group-hover:shadow-[0_12px_28px_-8px_rgba(42,168,155,0.75)]
            transition-all
          ">
            Open Public Companies
            <ArrowRight size={14} strokeWidth={2} />
          </div>
          <span className="hidden sm:inline-flex items-center gap-1 text-[11px] text-ink-mute">
            <TrendingUp size={11} strokeWidth={1.75} />
            Live with Sharadar SF1
          </span>
        </div>
      </div>
    </Link>
  );
}

function MiniKpi({ label, sample }: { label: string; sample: string }) {
  return (
    <div
      className="
        rounded-xl border border-rule/60 bg-surface/50
        backdrop-blur-sm
        px-3 py-2.5
      "
    >
      <div className="text-[10px] uppercase tracking-[0.1em] font-semibold text-ink-mute">
        {label}
      </div>
      <div className="mt-0.5 font-serif text-[15px] text-ink tabular-nums leading-tight">
        {sample}
      </div>
    </div>
  );
}
