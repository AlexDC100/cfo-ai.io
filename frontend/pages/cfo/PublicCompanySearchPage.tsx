// NASDAQ-8 — Public-company search page (/dashboard/public/search).
//
// Apple-clean: big centered search bar, debounced, lightweight result list.
// On health check fail (no NASDAQ_API_KEY set on backend) renders the
// §24-compliant "Nasdaq API key is not configured" state with operator
// guidance instead of just a broken search.
//
// Click on a result → /dashboard/public/:ticker (PublicCompanyDashboard,
// NASDAQ-9 — not yet shipped; placeholder route works, page lands on
// "loading" state until NASDAQ-9 lands).

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, AlertTriangle, Search as SearchIcon } from "lucide-react";
import { PageHeader } from "@/components/instrument/Panel";
import { PublicCompanySearchInput } from "@/components/cfo/PublicCompanySearchInput";
import { PublicCompanyResultCard } from "@/components/cfo/PublicCompanyResultCard";
import {
  getPublicCompanyHealth,
  searchPublicCompanies,
  type NasdaqErrorEnvelope,
  type PublicCompanyHit,
} from "@/lib/publicCompanyApi";

export default function PublicCompanySearchPage() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PublicCompanyHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<NasdaqErrorEnvelope["error"] | null>(null);
  const [keyConfigured, setKeyConfigured] = useState<boolean | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ── Health probe on mount ──────────────────────────────────────────
  useEffect(() => {
    getPublicCompanyHealth().then((r) => {
      if (r.ok) setKeyConfigured(r.value.key_configured);
      else setKeyConfigured(false);
    });
  }, []);

  // ── Debounced search ───────────────────────────────────────────────
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (abortRef.current) abortRef.current.abort();
    const q = query.trim();
    if (!q) {
      setResults([]);
      setError(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const r = await searchPublicCompanies(q, { limit: 20, signal: ctrl.signal });
      // Drop response if a newer search has started
      if (ctrl.signal.aborted) return;
      if (r.ok) {
        setResults(r.value.results);
        setError(null);
      } else {
        setResults([]);
        setError(r.error);
      }
      setSearching(false);
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  const showEmptyState = !searching && query.trim() && results.length === 0 && !error;
  const showStartState = !query.trim();

  return (
    <>
      <div className="max-w-3xl" data-testid="public-company-search-page">
        {/* Back link */}
        <Link
          to="/dashboard"
          className="
            inline-flex items-center gap-1.5 text-[12.5px] text-ink-mute
            hover:text-ink-soft transition-colors mb-6
          "
        >
          <ArrowLeft size={14} strokeWidth={1.75} />
          Back to dashboard
        </Link>

        {/* A3 hero eviction — compact instrument header instead of the
            centered serif display. */}
        <div className="mb-6 pb-4 border-b border-rule">
          <PageHeader
            eyebrow="Public companies"
            title="Search public companies"
          />
          <p className="text-[13px] text-ink-soft mt-1 max-w-xl leading-relaxed">
            Search by ticker (<span className="font-mono">AAPL</span>) or company name
            (<span className="italic">Apple Inc</span>). Analyse any of the 16,000+ US-listed
            tickers in Sharadar Equities with the same dashboard as your private
            company.
          </p>
        </div>

        {/* Search input */}
        <PublicCompanySearchInput
          value={query}
          onChange={setQuery}
          loading={searching}
        />

        {/* States */}
        <div className="mt-6">
          {keyConfigured === false && (
            <KeyMissingPanel />
          )}

          {error && keyConfigured !== false && (
            <ErrorPanel error={error} />
          )}

          {results.length > 0 && (
            <div className="space-y-2" data-testid="public-company-results">
              {results.map((hit) => (
                <PublicCompanyResultCard key={hit.ticker} hit={hit} />
              ))}
            </div>
          )}

          {showEmptyState && (
            <div className="
              text-center py-12 text-ink-mute text-[13px]
              border border-dashed border-rule rounded-md
            ">
              <SearchIcon size={20} strokeWidth={1.5} className="mx-auto mb-3 text-ink-mute/70" />
              No matching public company found.<br />
              <span className="text-[12px] text-ink-mute/80">
                Try the ticker (AAPL, MSFT) or a different name variant.
              </span>
            </div>
          )}

          {showStartState && keyConfigured !== false && (
            <div className="text-center py-12 text-ink-mute text-[12.5px]">
              Start typing a ticker or company name to search Nasdaq.
            </div>
          )}
        </div>

        {/* Footer source attribution */}
        <div className="mt-12 pt-6 border-t border-rule/60 text-[11px] text-ink-mute text-center">
          Data source: <span className="font-medium">Nasdaq Data Link · Sharadar Equities</span>
          {" · "}
          <span>US-listed only in v1</span>
        </div>
      </div>
    </>
  );
}

// ── §24 empty-state panels ─────────────────────────────────────────────

function KeyMissingPanel() {
  // Operator-config blocked state — caution semantics, never brand teal.
  return (
    <div
      data-testid="public-company-key-missing"
      className="rounded-md border border-l-[3px] border-rule border-l-caution bg-surface px-5 py-4"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle size={18} className="text-caution shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-ink">
            Nasdaq API key is not configured
          </div>
          <p className="text-[12.5px] text-ink-soft mt-1 leading-relaxed">
            The operator needs to set <code className="font-mono text-[11.5px] px-1 py-0.5 rounded-sm bg-bg-2">NASDAQ_API_KEY</code>
            {" "}on the backend host before public-company search becomes available.
          </p>
        </div>
      </div>
    </div>
  );
}

function ErrorPanel({ error }: { error: NasdaqErrorEnvelope["error"] }) {
  // Map error.code → friendly inline message per §24.
  const friendly: Record<string, string> = {
    nasdaq_key_missing: "Nasdaq API key is not configured.",
    nasdaq_entitlement_missing: "Your Nasdaq subscription does not include the requested dataset.",
    nasdaq_not_found: "No matching public company found.",
    nasdaq_rate_limited: "Nasdaq rate limit reached. Try again later.",
    nasdaq_partial_data: "Some fields are unavailable from Nasdaq for this company.",
    nasdaq_error: "Couldn't reach Nasdaq right now. Try again in a moment.",
  };
  const message = friendly[error.code] ?? error.message;
  return (
    <div
      data-testid="public-company-search-error"
      className="
        rounded-md border border-rule bg-bg-2/40 px-4 py-3
      "
    >
      <div className="text-[13px] text-ink">{message}</div>
      {error.message && error.message !== message && (
        <div className="text-[11.5px] text-ink-mute mt-1 font-mono">{error.message}</div>
      )}
    </div>
  );
}
