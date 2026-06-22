// One row in the public-company search results list.
//
// Default click target: navigate to /public-companies?ticker=X so the user
// lands on the redesigned hub with the snapshot panel pre-opened. The
// /dashboard/public/:ticker per-ticker page is gated until canonical-
// synthesis is calibrated per-ticker (was previously the destination).
//
// Override default behavior by passing `onSelect` — used inside the hub's
// CompanySearchPanel so a search-result click triggers in-page snapshot
// selection without navigation.

import { Link } from "react-router-dom";
import { ArrowRight, Building2 } from "lucide-react";
import type { PublicCompanyHit } from "@/lib/publicCompanyApi";

interface Props {
  hit: PublicCompanyHit;
  onSelect?: (ticker: string) => void;
}

export function PublicCompanyResultCard({ hit, onSelect }: Props) {
  const cardClassName = `
    group block
    rounded-xl border border-rule
    bg-surface hover:bg-bg-2/40
    p-4
    transition-all
    hover:border-brand/40 hover:-translate-y-[1px]
    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50
  `;
  const body = (
    <div className="flex items-start gap-3">
      <div className="
        flex h-9 w-9 shrink-0 items-center justify-center
        rounded-lg bg-bg-2 text-ink-soft
        group-hover:bg-brand/10 group-hover:text-brand-d
        transition-colors
      ">
        <Building2 size={16} strokeWidth={1.75} />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-[14px] font-mono font-semibold text-ink tabular-nums tracking-tight">
            {hit.ticker}
          </span>
          <span className="text-[13px] text-ink truncate">{hit.name}</span>
          {!hit.is_active && (
            <span className="text-[10px] uppercase tracking-[0.08em] font-semibold text-amber-600">
              Delisted
            </span>
          )}
        </div>
        <div className="mt-1 flex items-center gap-2 text-[11.5px] text-ink-mute flex-wrap">
          {hit.exchange && (
            <span className="px-1.5 py-0.5 rounded bg-bg-2/60 border border-rule/60 font-medium">
              {hit.exchange}
            </span>
          )}
          {hit.sector && <span>{hit.sector}</span>}
          {hit.industry && hit.industry !== hit.sector && (
            <span className="text-ink-mute/70">· {hit.industry}</span>
          )}
          {hit.country && <span className="text-ink-mute/70">· {hit.country}</span>}
        </div>
      </div>

      <ArrowRight
        size={16}
        strokeWidth={1.75}
        className="
          shrink-0 mt-1 text-ink-mute
          group-hover:text-brand-d group-hover:translate-x-0.5
          transition-all
        "
      />
    </div>
  );

  if (onSelect) {
    return (
      <button
        type="button"
        onClick={() => onSelect(hit.ticker)}
        data-testid={`public-company-result-${hit.ticker}`}
        className={`${cardClassName} text-left w-full`}
      >
        {body}
      </button>
    );
  }

  return (
    <Link
      to={`/public-companies?ticker=${encodeURIComponent(hit.ticker)}`}
      data-testid={`public-company-result-${hit.ticker}`}
      className={cardClassName}
    >
      {body}
    </Link>
  );
}
