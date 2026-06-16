// Saved-peers strip — surfaces the user's benchmark peers at the top of
// the Public Company Intelligence hub. Click a chip to drill into that
// company's per-ticker dashboard. Empty state nudges the user to add
// their first peer.

import { Link } from "react-router-dom";
import { Users, ArrowUpRight, X } from "lucide-react";
import { removePeer, useBenchmarkPeers } from "@/lib/benchmarkPeersStore";

export function SavedPeersStrip() {
  const peers = useBenchmarkPeers();

  return (
    <section
      data-testid="public-companies-peers-strip"
      className="
        rounded-3xl border border-rule bg-surface p-5 sm:p-6
      "
    >
      <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
        <div className="flex items-center gap-2">
          <div className="
            flex h-9 w-9 items-center justify-center
            rounded-lg bg-bg-2 text-ink-soft
          ">
            <Users size={15} strokeWidth={1.75} />
          </div>
          <div>
            <div className="text-[10.5px] uppercase tracking-[0.12em] font-semibold text-ink-mute">
              Your benchmark peers
            </div>
            <div className="text-[13.5px] text-ink font-medium">
              {peers.length === 0
                ? "Build a peer set by clicking \"Add as peer\" on any company dashboard"
                : `${peers.length} ${peers.length === 1 ? "peer" : "peers"} saved`}
            </div>
          </div>
        </div>
        <Link
          to="/benchmark"
          className="
            inline-flex items-center gap-1.5
            h-9 px-3 rounded-lg
            border border-rule bg-surface
            text-[12.5px] text-ink-soft
            hover:bg-bg-2/60 hover:text-ink
            transition-all
          "
        >
          Open benchmark
          <ArrowUpRight size={13} strokeWidth={1.75} />
        </Link>
      </div>

      {peers.length === 0 ? (
        <p className="text-[12.5px] text-ink-mute leading-relaxed">
          Saved peers appear here and feed into the Benchmark page alongside your
          private-company analysis. Start with one of the suggestion chips below
          (Apple, Microsoft, Nvidia…) — they're already SF1-covered.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {peers.map((p) => (
            <PeerChip key={p.ticker} ticker={p.ticker} name={p.name} />
          ))}
        </div>
      )}
    </section>
  );
}

function PeerChip({ ticker, name }: { ticker: string; name: string }) {
  return (
    <div
      data-testid={`peer-chip-${ticker}`}
      className="
        group inline-flex items-center
        rounded-lg border border-rule bg-bg-2/40
        hover:bg-bg-2/70 hover:border-brand/30
        transition-colors
        overflow-hidden
      "
    >
      <Link
        to={`/dashboard/public/${encodeURIComponent(ticker)}`}
        className="flex items-center gap-2 px-3 py-1.5"
      >
        <span className="font-mono text-[12px] font-semibold tabular-nums text-ink">
          {ticker}
        </span>
        <span className="text-[11.5px] text-ink-soft hidden sm:inline truncate max-w-[160px]">
          {name}
        </span>
      </Link>
      <button
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          removePeer(ticker);
        }}
        aria-label={`Remove ${ticker} from peers`}
        className="
          h-full px-2 text-ink-mute
          hover:bg-amber-500/10 hover:text-amber-700 dark:hover:text-amber-300
          opacity-0 group-hover:opacity-100
          transition-all
        "
      >
        <X size={13} strokeWidth={1.75} />
      </button>
    </div>
  );
}
