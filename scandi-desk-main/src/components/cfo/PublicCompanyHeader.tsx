// NASDAQ-9 — Public-company dashboard header.
//
// Sticky-ish header row: ticker monogram + company name + sector chip
// + last-synced timestamp + currency badge + manual Refresh button.
// Apple-clean: minimal chrome, tabular ticker mono, refined hover states.

import { Building2, RefreshCw, ChevronLeft, Globe2, Plus, Check } from "lucide-react";
import { Link } from "react-router-dom";
import type { PublicCompanyTickerInfo } from "@/lib/publicCompanyApi";
import { addPeer, isPeer, removePeer, useBenchmarkPeers } from "@/lib/benchmarkPeersStore";

interface Props {
  ticker: string;
  info: PublicCompanyTickerInfo | null;
  syncedAt: string | null;       // ISO timestamp, "" / null when fresh-loading
  onRefresh: () => void;
  refreshing: boolean;
}

export function PublicCompanyHeader({ ticker, info, syncedAt, onRefresh, refreshing }: Props) {
  // Subscribe to peers store so the button label flips Add ↔ Added
  useBenchmarkPeers();
  const alreadyPeer = isPeer(ticker);
  const togglePeer = () => {
    if (alreadyPeer) {
      removePeer(ticker);
    } else {
      addPeer({
        ticker,
        name: info?.name ?? ticker,
        sector: info?.sector ?? null,
        exchange: info?.exchange ?? null,
        currency: info?.currency ?? "USD",
      });
    }
  };
  return (
    <header
      data-testid="public-company-header"
      className="
        sticky top-0 z-10
        bg-surface/85 backdrop-blur-md
        border-b border-rule
        px-4 sm:px-6 py-3 sm:py-4
        flex items-center gap-3 sm:gap-4
      "
    >
      <Link
        to="/dashboard/public/search"
        className="
          flex items-center gap-1.5
          h-9 px-2.5 rounded-lg
          text-[12.5px] text-ink-soft
          hover:bg-bg-2/60 hover:text-ink transition-colors
        "
      >
        <ChevronLeft size={14} strokeWidth={1.75} />
        Search
      </Link>

      <div className="
        flex h-9 w-9 shrink-0 items-center justify-center
        rounded-lg bg-bg-2 text-ink-soft
      ">
        <Building2 size={16} strokeWidth={1.75} />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-mono text-[16px] sm:text-[18px] font-semibold text-ink tabular-nums tracking-tight">
            {ticker}
          </span>
          <span className="text-[13.5px] sm:text-[14px] text-ink truncate">
            {info?.name ?? "Loading…"}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-ink-mute flex-wrap">
          {info?.exchange && (
            <span className="px-1.5 py-0.5 rounded bg-bg-2/60 border border-rule/60 font-medium uppercase tracking-wider">
              {info.exchange}
            </span>
          )}
          {info?.sector && <span>{info.sector}</span>}
          {info?.currency && (
            <span className="inline-flex items-center gap-1 text-ink-mute/80">
              <Globe2 size={10} strokeWidth={2} />
              Reported in {info.currency}
            </span>
          )}
          {syncedAt && (
            <span className="text-ink-mute/70">· Synced {formatRelative(syncedAt)}</span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={togglePeer}
          data-testid="public-company-toggle-peer"
          aria-pressed={alreadyPeer}
          className={`
            inline-flex items-center gap-1.5
            h-9 px-3 rounded-lg
            text-[12.5px] font-medium
            ring-1 ring-inset
            transition-all
            ${alreadyPeer
              ? "bg-brand/10 text-brand-d ring-brand/30 hover:bg-brand/15"
              : "bg-gradient-to-b from-brand to-brand-d text-paper ring-white/15 shadow-[0_6px_18px_-8px_rgba(45,191,179,0.55)] hover:shadow-[0_8px_22px_-8px_rgba(45,191,179,0.7)]"
            }
          `}
        >
          {alreadyPeer ? <Check size={13} strokeWidth={2} /> : <Plus size={13} strokeWidth={2} />}
          {alreadyPeer ? "Peer · saved" : "Add as peer"}
        </button>
        <button
          onClick={onRefresh}
          disabled={refreshing}
          data-testid="public-company-refresh"
          className="
            inline-flex items-center gap-1.5
            h-9 px-3 rounded-lg
            border border-rule bg-surface
            text-[12.5px] text-ink
            hover:bg-bg-2/60 hover:border-brand/30
            disabled:opacity-50 disabled:cursor-not-allowed
            transition-all
          "
        >
          <RefreshCw
            size={13}
            strokeWidth={1.75}
            className={refreshing ? "animate-spin" : ""}
          />
          {refreshing ? "Syncing…" : "Refresh"}
        </button>
      </div>
    </header>
  );
}

// "Synced 2 min ago" — calm, no false precision.
function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}
