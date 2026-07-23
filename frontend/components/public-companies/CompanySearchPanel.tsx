// Compact market-search bar — financial workspace style.
//
// Romania-only rework (2026-07-23, operator directive): the old panel
// searched Nasdaq Data Link server-side and carried a data-source dropdown
// (Nasdaq / SEC / Manual). The universe is now BVB-only, so:
//   · the dropdown is gone;
//   · search runs CLIENT-SIDE over the loaded Romanian universe rows —
//     ticker or company name, diacritic-insensitive ("tara" finds Țara),
//     instant, no API key required;
//   · quick-pick chips are the largest Romanian companies by market cap
//     instead of the US watchlist.

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Search, X, CheckCircle2 } from "lucide-react";
import type { PublicCompanyHit } from "@/lib/publicCompanyApi";
import type { PublicCompanyFinancialSnapshot } from "@/lib/publicCompanyUniverse";
import { PublicCompanyResultCard } from "@/components/cfo/PublicCompanyResultCard";
import { removePeer, useBenchmarkPeers } from "@/lib/benchmarkPeersStore";
import { staticBvbRows } from "@/lib/bvbStaticUniverse";

interface Props {
  /** The loaded (Romania-only) universe — the search corpus. */
  rows: PublicCompanyFinancialSnapshot[];
  /** When set, picking a result selects it instead of navigating away. */
  onSelect?: (ticker: string) => void;
}

/** Diacritic-insensitive, case-insensitive normalizer. */
const norm = (s: string | null | undefined): string =>
  (s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

function toHit(r: PublicCompanyFinancialSnapshot): PublicCompanyHit {
  return {
    ticker: r.ticker,
    name: r.companyName,
    sector: r.sector ?? null,
    industry: r.industry ?? null,
    exchange: r.exchange ?? "BVB",
    country: r.country ?? "RO",
    currency: r.currency,
    is_active: true,
  };
}

export function CompanySearchPanel({ rows, onSelect }: Props) {
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const peers = useBenchmarkPeers();

  // Search corpus: the live universe when loaded; otherwise the bundled
  // static BVB list, so search always finds Romanian companies even while
  // the universe fetch is loading / failing.
  const corpus = rows.length > 0 ? rows : staticBvbRows();

  // Quick picks — the largest Romanian companies by market cap.
  const suggestions = useMemo(
    () =>
      [...corpus]
        .sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0))
        .slice(0, 9),
    [corpus],
  );

  // Client-side search: ticker prefix matches rank first, then ticker
  // substring, then company-name substring. Diacritic-insensitive.
  const results = useMemo(() => {
    const q = norm(query.trim());
    if (!q) return [];
    const scored = corpus
      .map((r) => {
        const t = norm(r.ticker);
        const n = norm(r.companyName);
        let score = -1;
        if (t.startsWith(q)) score = 0;
        else if (t.includes(q)) score = 1;
        else if (n.startsWith(q)) score = 2;
        else if (n.includes(q)) score = 3;
        return { r, score };
      })
      .filter((x) => x.score >= 0)
      .sort(
        (a, b) =>
          a.score - b.score || (b.r.marketCap ?? 0) - (a.r.marketCap ?? 0),
      );
    return scored.slice(0, 10).map((x) => toHit(x.r));
  }, [corpus, query]);

  const handleHitClick = (ticker: string) => {
    if (onSelect) onSelect(ticker);
    else navigate(`/dashboard/public/${encodeURIComponent(ticker)}`);
  };

  const noMatches = query.trim().length > 0 && results.length === 0;

  return (
    <section
      data-testid="public-companies-search-panel"
      className="
        rounded-3xl border border-rule
        bg-gradient-to-br from-surface to-bg-2/30
        p-5 sm:p-6
      "
    >
      {/* Search row */}
      <div className="flex flex-col sm:flex-row items-stretch gap-2.5">
        <div className="
          flex-1 min-w-0
          flex items-center gap-3 h-12 px-4
          rounded-xl border border-rule bg-surface
          focus-within:border-brand/50 focus-within:ring-2 focus-within:ring-brand/20
          transition-all
        ">
          <Search size={18} strokeWidth={1.75} className="text-ink-mute shrink-0" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search Romanian companies"
            spellCheck={false}
            autoCapitalize="characters"
            data-testid="public-companies-search-input"
            className="
              flex-1 min-w-0 bg-transparent outline-none
              text-[14px] text-ink placeholder:text-ink-mute
              tracking-[-0.005em]
            "
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="shrink-0 text-ink-mute hover:text-ink transition-colors"
            >
              <X size={14} strokeWidth={2} />
            </button>
          )}
        </div>

        <button
          onClick={() => {
            const top = results[0] ?? (suggestions[0] ? toHit(suggestions[0]) : null);
            if (top) handleHitClick(top.ticker);
          }}
          disabled={results.length === 0 && suggestions.length === 0}
          data-testid="public-companies-fetch"
          className="
            inline-flex items-center justify-center gap-1.5
            h-12 px-5 rounded-xl
            bg-gradient-to-b from-brand to-brand-d text-paper
            text-[13.5px] font-medium
            shadow-[0_8px_22px_-8px_rgba(42,168,155,0.6)]
            hover:shadow-[0_10px_26px_-8px_rgba(42,168,155,0.75)]
            ring-1 ring-inset ring-white/15
            disabled:opacity-50 disabled:cursor-not-allowed
            transition-all
            shrink-0
          "
        >
          Open Company
          <ArrowRight size={14} strokeWidth={2} />
        </button>
      </div>

      {/* Below-bar row: peers OR suggestion chips */}
      {peers.length > 0 ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="
            inline-flex items-center gap-1.5
            text-[10px] uppercase tracking-[0.12em] font-semibold text-ink-mute mr-1
          ">
            <CheckCircle2 size={10} strokeWidth={2.25} className="text-brand-d" />
            Your peers
          </span>
          {peers.map((p) => (
            <span
              key={p.ticker}
              className="
                group inline-flex items-center
                rounded-md border border-brand/25 bg-brand/8
                overflow-hidden
              "
            >
              <button
                onClick={() => handleHitClick(p.ticker)}
                className="flex items-center gap-1.5 px-2 py-1 text-left"
                title={p.name}
              >
                <span className="font-mono text-[11.5px] font-semibold text-brand-d tabular-nums">
                  {p.ticker}
                </span>
              </button>
              <button
                onClick={(e) => { e.preventDefault(); removePeer(p.ticker); }}
                aria-label={`Remove ${p.ticker} from peers`}
                className="
                  px-1.5 py-1 text-brand-d/60 hover:text-[#2AA89B] hover:bg-[#5CD3C5]/10
                  transition-colors
                "
              >
                <X size={10} strokeWidth={2} />
              </button>
            </span>
          ))}
        </div>
      ) : !query.trim() ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="text-[10px] uppercase tracking-[0.12em] text-ink-mute mr-1">
            Quick pick
          </span>
          {suggestions.map((h) => (
            <button
              key={h.ticker}
              onClick={() => handleHitClick(h.ticker)}
              title={h.companyName}
              className="
                inline-flex items-center
                h-7 px-2 rounded-md
                font-mono text-[11px] font-semibold tabular-nums
                bg-bg-2/60 text-ink-soft border border-rule/60
                hover:bg-brand/10 hover:text-brand-d hover:border-brand/25
                transition-colors
              "
            >
              {h.ticker}
            </button>
          ))}
        </div>
      ) : null}

      {/* Live search results */}
      {results.length > 0 && (
        <div
          className="mt-4 space-y-2 max-h-[300px] overflow-y-auto pr-1"
          data-testid="public-companies-search-results"
        >
          {results.map((hit) => (
            <PublicCompanyResultCard
              key={hit.ticker}
              hit={hit}
              onSelect={onSelect ? handleHitClick : undefined}
            />
          ))}
        </div>
      )}

      {/* No-match note */}
      {noMatches && (
        <div className="mt-4 rounded-xl border border-rule bg-bg-2/40 px-4 py-3 text-[12.5px] text-ink">
          No BVB-listed company matches “{query.trim()}”. Try the ticker
          (e.g. TLV, SNP, H2O) or part of the company name.
        </div>
      )}
    </section>
  );
}
