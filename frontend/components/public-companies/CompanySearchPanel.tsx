// Compact market-search bar — financial workspace style.
//
// Romania-only rework (2026-07-23, operator directive): the old panel
// searched Nasdaq Data Link server-side and carried a data-source dropdown
// (Nasdaq / SEC / Manual). The universe is now BVB-only, so:
//   · the dropdown is gone;
//   · search runs CLIENT-SIDE over the loaded Romanian universe rows —
//     ticker or company name, diacritic-insensitive ("tara" finds Țara),
//     instant, no API key required.
//
// 2026-07-24: the "Quick pick" chip row (top-9-by-market-cap, shown below
// the bar when idle) was removed — MarketsOverview's "Browse companies"
// grid now does that job with logos for the whole universe, not just 9.
// `suggestions` (still computed below) is kept only as the fallback target
// for the "Search" button when the field is empty. Same day: the outer
// rounded-3xl card wrapper around the whole panel was dropped (it duplicated
// the input field's own border/focus-ring framing), and the button label
// changed from "Open Company" to "Search".

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Search, X, CheckCircle2 } from "lucide-react";
import "./pciI18n";
import type { PublicCompanyHit } from "@/lib/publicCompanyApi";
import type { PublicCompanyFinancialSnapshot } from "@/lib/publicCompanyUniverse";
import { removePeer, useBenchmarkPeers } from "@/lib/benchmarkPeersStore";
import { DataSourcesInfoButton } from "./MarketsOverview";
import { staticBvbRows } from "@/lib/bvbStaticUniverse";

interface Props {
  /** The loaded (Romania-only) universe — the search corpus. */
  rows: PublicCompanyFinancialSnapshot[];
  /** When set, picking a result selects it instead of navigating away. */
  onSelect?: (ticker: string) => void;
  /** Controlled query (2026-07-24) — the page owns the text so it can
   *  turn matches into a grid filter. Falls back to internal state when
   *  absent. */
  query?: string;
  onQueryChange?: (query: string) => void;
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

/** Client-side universe search — ticker prefix matches rank first, then
 *  ticker substring, then company-name prefix/substring; ties break by
 *  market cap. Diacritic-insensitive. Exported so the page can turn the
 *  full match set into a company-grid filter. */
export function searchUniverse(
  corpus: PublicCompanyFinancialSnapshot[],
  query: string,
): PublicCompanyFinancialSnapshot[] {
  const q = norm(query.trim());
  if (!q) return [];
  return corpus
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
    )
    .map((x) => x.r);
}

export function CompanySearchPanel({
  rows,
  onSelect,
  query: queryProp,
  onQueryChange,
}: Props) {
  const { t } = useTranslation();
  const [internalQuery, setInternalQuery] = useState("");
  const query = queryProp ?? internalQuery;
  const setQuery = onQueryChange ?? setInternalQuery;
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

  // Top matches — used by the "Search" button (opens the best hit) and
  // the no-match note. The full match list itself renders in the
  // company grid below (via the page's search grid-filter), not as a
  // dropdown here.
  const results = useMemo(
    () => searchUniverse(corpus, query).slice(0, 10).map(toHit),
    [corpus, query],
  );

  const handleHitClick = (ticker: string) => {
    if (onSelect) onSelect(ticker);
    else navigate(`/dashboard/public/${encodeURIComponent(ticker)}`);
  };

  const noMatches = query.trim().length > 0 && results.length === 0;

  return (
    <section data-testid="public-companies-search-panel">
      {/* Search row. The only bordered/rounded chrome is the input+icon
          field itself (focus ring below) — the outer card wrapper that
          used to duplicate that framing (rounded-3xl border + gradient
          bg) was removed 2026-07-24, so there's one selection style, not
          two nested ones. */}
      {/* One row at every width — the info button rides beside the field
          rather than floating centered under it on mobile. */}
      <div className="flex flex-row items-center gap-2.5">
        <div className="
          flex-1 min-w-0
          flex items-center gap-3 h-11 px-4
          rounded-md border border-rule bg-surface
          focus-within:border-brand/50 focus-within:ring-2 focus-within:ring-brand/20
          transition-all duration-micro
        ">
          <Search size={18} strokeWidth={1.75} className="text-ink-mute shrink-0" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("pci.search.placeholder")}
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
              aria-label={t("pci.search.clear")}
              className="shrink-0 text-ink-mute hover:text-ink transition-colors"
            >
              <X size={14} strokeWidth={2} />
            </button>
          )}
        </div>

        {/* Data-sources "i" — relocated from the company grid's header
            (2026-07-24) to sit beside the search field. */}
        <div className="shrink-0">
          <DataSourcesInfoButton />
        </div>
      </div>

      {/* Below-bar row: peer chips. The "Quick pick" chip row that used to
          render here (top-9-by-market-cap) was removed 2026-07-24 — the
          "Browse companies" grid on MarketsOverview now covers the same
          job (every company, with logos) directly below this panel. */}
      {peers.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="
            inline-flex items-center gap-1.5
            text-[10px] uppercase tracking-[0.12em] font-semibold text-ink-mute mr-1
          ">
            <CheckCircle2 size={10} strokeWidth={2.25} className="text-brand-dark dark:text-brand-light" />
            {t("pci.search.yourPeers")}
          </span>
          {peers.map((p) => (
            <span
              key={p.ticker}
              className="
                group inline-flex items-center
                rounded-full bg-brand-tint
                overflow-hidden
              "
            >
              <button
                onClick={() => handleHitClick(p.ticker)}
                className="flex items-center gap-1.5 pl-2.5 pr-1 py-0.5 text-left"
                title={p.name}
              >
                <span className="font-mono text-[11px] font-medium text-brand-dark dark:text-brand-light tabular-nums">
                  {p.ticker}
                </span>
              </button>
              <button
                onClick={(e) => { e.preventDefault(); removePeer(p.ticker); }}
                aria-label={t("pci.search.removePeer", { ticker: p.ticker })}
                className="
                  px-1.5 py-1 text-brand-dark/60 hover:text-brand-dark dark:text-brand-light/60 dark:hover:text-brand-light
                  transition-colors duration-micro
                "
              >
                <X size={10} strokeWidth={2} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* The result-card dropdown that used to render here was removed
          2026-07-24 — matches now display IN the company grid below,
          flagged by a selected "Search" filter pill. */}

      {/* No-match note */}
      {noMatches && (
        <div className="mt-4 rounded-md border border-rule bg-bg-2 px-4 py-3 text-[12.5px] text-ink">
          {t("pci.search.noMatch", { query: query.trim() })}
        </div>
      )}
    </section>
  );
}
