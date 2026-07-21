// Compact market-search bar — financial workspace style.
//
// Redesign per spec: drops "Step 1" label, removes the standalone API-key
// status badge (moved up to the page-level StatusBanner), inlines the
// saved-peers chips so search + peers feel like one bar, not two
// stacked sections.

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight,
  ChevronDown,
  Loader2,
  Search,
  Upload,
  X,
  CheckCircle2,
} from "lucide-react";
import {
  searchPublicCompanies,
  type NasdaqErrorEnvelope,
  type PublicCompanyHealth,
  type PublicCompanyHit,
} from "@/lib/publicCompanyApi";
import { watchlistAsHits } from "@/lib/publicCompanyWatchlist";
import { PublicCompanyResultCard } from "@/components/cfo/PublicCompanyResultCard";
import {
  removePeer, useBenchmarkPeers,
} from "@/lib/benchmarkPeersStore";

type Source = "nasdaq" | "sec" | "manual";

interface Props {
  health: PublicCompanyHealth | null;
  /** When set, picking a result selects it instead of navigating away. */
  onSelect?: (ticker: string) => void;
}

const SOURCES: { code: Source; label: string; sub: string; disabled?: boolean }[] = [
  { code: "nasdaq", label: "Nasdaq Data Link", sub: "Sharadar SF1 + DAILY" },
  { code: "sec",    label: "SEC EDGAR",        sub: "Coming soon", disabled: true },
  { code: "manual", label: "Manual / CSV",     sub: "Coming soon", disabled: true },
];

export function CompanySearchPanel({ health, onSelect }: Props) {
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<Source>("nasdaq");
  const [results, setResults] = useState<PublicCompanyHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<NasdaqErrorEnvelope["error"] | null>(null);
  const navigate = useNavigate();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const peers = useBenchmarkPeers();

  const suggestions = useMemo(() => watchlistAsHits().slice(0, 9), []);
  const keyMissing = !health?.key_configured;

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (abortRef.current) abortRef.current.abort();
    const q = query.trim();
    if (!q || source !== "nasdaq") {
      setResults([]);
      setError(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const r = await searchPublicCompanies(q, { limit: 10, signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      if (r.ok) { setResults(r.value.results); setError(null); }
      else      { setResults([]); setError(r.error); }
      setSearching(false);
    }, 250);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, source]);

  const handleHitClick = (ticker: string) => {
    if (onSelect) onSelect(ticker);
    else navigate(`/dashboard/public/${encodeURIComponent(ticker)}`);
  };

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
            // 2026-05-26 (mobile fix): the prior 50-char placeholder
            // "Search ticker or company — AAPL, Microsoft, Nvidia"
            // truncated mid-word on iPhone widths (input never wraps,
            // visible region was ~35 chars). The shorter form below
            // still cues the user but reads cleanly end-to-end at 375px.
            placeholder="Search ticker or company"
            spellCheck={false}
            autoCapitalize="characters"
            data-testid="public-companies-search-input"
            className="
              flex-1 min-w-0 bg-transparent outline-none
              text-[14px] text-ink placeholder:text-ink-mute
              tracking-[-0.005em]
            "
          />
          {searching && (
            <Loader2 size={14} strokeWidth={1.75} className="shrink-0 text-brand-d animate-spin" />
          )}
        </div>

        <SourceSelector value={source} onChange={setSource} />

        <button
          onClick={() => {
            const top = results[0] ?? suggestions[0];
            if (top) handleHitClick(top.ticker);
          }}
          disabled={keyMissing || (results.length === 0 && !suggestions.length)}
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
          title={keyMissing ? "Demo mode — connect NASDAQ_DATA_LINK_API_KEY for live data" : undefined}
        >
          Fetch Data
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
      ) : !query.trim() && source === "nasdaq" ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="text-[10px] uppercase tracking-[0.12em] text-ink-mute mr-1">
            Quick pick
          </span>
          {suggestions.map((h) => (
            <button
              key={h.ticker}
              onClick={() => handleHitClick(h.ticker)}
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

      {/* Inline error */}
      {error && (
        <div className="mt-4 rounded-xl border border-rule bg-bg-2/40 px-4 py-3 text-[12.5px] text-ink">
          {friendlyError(error)}
        </div>
      )}

      {/* Source caveat */}
      {source !== "nasdaq" && (
        <div className="
          mt-4 rounded-xl border border-[#8FE3D9]/40 bg-[#E6F7F4]/30
          dark:bg-[#5CD3C5]/[0.05]
          px-4 py-3 text-[12.5px] text-[#1B7268] dark:text-[#E6F7F4]
        ">
          <strong className="font-semibold">{SOURCES.find((s) => s.code === source)?.label} is coming soon.</strong>{" "}
          For now, Nasdaq Data Link covers 16,000+ US-listed tickers.
        </div>
      )}
    </section>
  );
}


// ── Source selector dropdown ─────────────────────────────────────────

function SourceSelector({ value, onChange }: { value: Source; onChange: (s: Source) => void }) {
  const [open, setOpen] = useState(false);
  const current = SOURCES.find((s) => s.code === value)!;
  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className="
          inline-flex items-center gap-2
          h-12 px-3.5 rounded-xl
          border border-rule bg-surface
          text-[12.5px] text-ink
          hover:bg-bg-2/40
          transition-colors
        "
      >
        <Upload size={14} strokeWidth={1.75} className="text-ink-mute" />
        <span className="hidden sm:inline">{current.label}</span>
        <span className="sm:hidden">Source</span>
        <ChevronDown size={13} strokeWidth={1.75} className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="
            absolute right-0 mt-1 z-20 min-w-[220px]
            rounded-xl border border-rule bg-surface
            shadow-[0_12px_32px_-12px_rgba(0,0,0,0.18)]
            py-1
          ">
            {SOURCES.map((s) => (
              <button
                key={s.code}
                disabled={s.disabled}
                onClick={() => { onChange(s.code); setOpen(false); }}
                className="
                  w-full text-left px-3 py-2
                  flex items-start justify-between gap-3
                  hover:bg-bg-2/50
                  disabled:opacity-50 disabled:cursor-not-allowed
                  transition-colors
                "
              >
                <div>
                  <div className="text-[12.5px] text-ink font-medium">{s.label}</div>
                  <div className="text-[10.5px] text-ink-mute mt-0.5">{s.sub}</div>
                </div>
                {value === s.code && <CheckCircle2 size={14} className="text-brand-d mt-0.5" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function friendlyError(err: NasdaqErrorEnvelope["error"]): string {
  const map: Record<string, string> = {
    nasdaq_key_missing: "Nasdaq API key is not configured on the backend.",
    nasdaq_entitlement_missing: "Your Nasdaq subscription does not include this dataset.",
    nasdaq_not_found: "No matching public company found. Try the ticker or a different name.",
    nasdaq_rate_limited: "Nasdaq rate limit reached. Try again in a minute.",
    nasdaq_error: "Couldn't reach Nasdaq right now. Try again in a moment.",
  };
  return map[err.code] ?? err.message;
}
