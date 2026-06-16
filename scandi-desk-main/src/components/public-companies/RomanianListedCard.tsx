// RomanianListedCard — Markets-page primary section for BVB-listed names.
//
// 2026-05-31 — BVB Phase 1.
//
// Context: the previous Markets page led with the NASDAQ 200-row
// universe. A Romanian meat-processor like Scandia comparing themselves
// to Apple is absurd — relevant peers for the actual customer base
// (Romanian SMEs, mid-caps, financial advisors serving them) are on
// the BVB. This component bumps the BVB seed to the TOP of the page
// and treats NASDAQ as the secondary universe.
//
// Layout: a vertically-stacked card with three zones.
//
//   ┌──────────────────────────────────────────────────────────────┐
//   │ Header: title + BVB badge + count                            │
//   │ Peer-pair callout: CFH ↔ private comparison (Scandia)        │
//   │ List rows: top BET-20 names — ticker / name / metrics / chev │
//   └──────────────────────────────────────────────────────────────┘
//
// The card NEVER promises a row that isn't in the loaded universe. If
// a BET ticker hasn't been hydrated yet (operator hasn't run the seed
// loader / admin upload), it's silently filtered out so we don't show
// "—" everywhere. The header count reflects what's actually loaded.
//
// CFH ↔ Scandia callout: CFH (Cris-Tim Family Holding) is Scandia's
// closest BVB-listed peer — meat processor, Romanian-based, similar
// scale. The callout is the visual anchor for "this is your real peer
// group" and is what replaces the absurd "Analyze Apple" entry hero
// that used to dominate the Markets surface.

import { useMemo } from "react";
import { ChevronRight, Sparkles } from "lucide-react";
import type { PublicCompanyFinancialSnapshot } from "@/lib/publicCompanyUniverse";
import { CompanyLogo } from "./CompanyLogo";
import { BVBBadge } from "./BVBBadge";

interface Props {
  rows: PublicCompanyFinancialSnapshot[];
  /** Click handler for the whole-section "Explore BVB" button. Same
   *  contract as MarketsOverview's `onExplore`. */
  onExplore: (tickers: string[]) => void;
  /** Click handler for a single-ticker row. */
  onSelectTicker: (ticker: string) => void;
}

// ── Featured peer pairings ───────────────────────────────────────────────
// Hardcoded "your private company ↔ this BVB-listed peer" anchors.
// These are the comparisons that actually answer the question users
// arrive at the Markets page with: "how do I compare against listed
// names in my sector?" Sector-matched, scale-matched, geography-matched.

interface PeerPair {
  /** Anchor ticker on BVB. */
  bvbTicker: string;
  /** Customer-side label (a private comparable from the upload corpus). */
  privateLabel: string;
  /** One-line rationale shown in the callout body. */
  rationale: string;
}

const FEATURED_PEER_PAIRS: ReadonlyArray<PeerPair> = [
  {
    bvbTicker: "CFH",
    privateLabel: "Scandia Food",
    rationale:
      "Both are Romanian meat processors. Comparable scale (CFH ~RON 1.2B turnover · Scandia ~RON 414M). Closer peer than any US name.",
  },
];

// Display order — top names by index weight, with CFH bumped just under
// the largest two so the Scandia-peer callout's anchor is visible.
const PREFERRED_ORDER: ReadonlyArray<string> = [
  "TLV",   // 20.26% — largest BET name
  "SNP",   // 15.87% — OMV Petrom
  "CFH",   // 0.51%  — featured because Scandia's peer (bumped from natural position)
  "H2O",   // 12.85% — Hidroelectrica
  "SNG",   // 12.33% — Romgaz
  "BRD",   // 7.04%  — BRD
  "TGN",   // 6.57%  — Transgaz
  "DIGI",  // 4.56%  — Digi
  "EL.BVB", // 4.52% — Electrica (namespaced — collides with NASDAQ Estée Lauder)
  "M",     // 3.39%  — MedLife
  "SNN",   // 3.31%  — Nuclearelectrica
  "TEL",   // 2.13%  — Transelectrica
  "PE",    // 1.59%  — Premier Energy
  "FP",    // 1.17%  — Fondul Proprietatea
  "ONE",   // 1.07%  — One United Properties
  "AQ",    // 0.72%  — Aquila
  "TTS",   // 0.57%  — TTS
  "ATB",   // 0.55%  — Antibiotice
  "TRP",   // 0.52%  — Teraplast
  "SFG",   // 0.47%  — Sphera
];

export function RomanianListedCard({ rows, onExplore, onSelectTicker }: Props) {
  // Filter to BVB only, then re-order by PREFERRED_ORDER, then drop any
  // that aren't loaded.
  const { bvbRows, byTicker } = useMemo(() => {
    const m = new Map<string, PublicCompanyFinancialSnapshot>();
    for (const r of rows) {
      if (r.exchange === "BVB") m.set(r.ticker, r);
    }
    const ordered: PublicCompanyFinancialSnapshot[] = [];
    for (const t of PREFERRED_ORDER) {
      const row = m.get(t);
      if (row) ordered.push(row);
    }
    // Append any BVB rows not in PREFERRED_ORDER (future BET expansion).
    for (const [t, row] of m) {
      if (!PREFERRED_ORDER.includes(t)) ordered.push(row);
    }
    return { bvbRows: ordered, byTicker: m };
  }, [rows]);

  // Pick the first peer pair whose anchor is loaded.
  const activePair = useMemo(() => {
    for (const p of FEATURED_PEER_PAIRS) {
      const row = byTicker.get(p.bvbTicker);
      if (row) return { pair: p, row };
    }
    return null;
  }, [byTicker]);

  // Empty state — no BVB rows loaded yet (seed not run, or live source
  // gated). Surface this loudly because the whole Markets page leads
  // here; silent empty would look broken.
  if (bvbRows.length === 0) {
    return (
      <section
        data-testid="romanian-listed-card-empty"
        className="rounded-3xl border border-rule bg-surface overflow-hidden"
      >
        <header className="px-5 sm:px-6 pt-4 pb-3 flex items-center gap-3">
          <BVBBadge variant="section" />
          <h2 className="font-serif text-[16px] text-ink tracking-[-0.005em]">
            Romanian Listed (BVB)
          </h2>
        </header>
        <div className="px-5 sm:px-6 pb-5 text-[13px] text-ink-mute">
          BVB universe is loading. If this persists, the seed loader
          hasn't been run yet — see{" "}
          <code className="text-[11.5px] bg-bg-2 px-1 py-0.5 rounded">
            scripts/seed_bvb_companies.py
          </code>
          .
        </div>
      </section>
    );
  }

  return (
    <section
      data-testid="romanian-listed-card"
      className="rounded-3xl border border-emerald-600/15 bg-surface overflow-hidden ring-1 ring-emerald-600/10"
    >
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header className="px-5 sm:px-6 pt-4 pb-3 flex items-baseline justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <BVBBadge variant="section" />
          <h2 className="font-serif text-[16px] text-ink tracking-[-0.005em]">
            Romanian Listed (BVB)
          </h2>
        </div>
        <span className="text-[11px] text-ink-mute">
          {bvbRows.length} of 20 BET-index names
        </span>
      </header>

      {/* ── Peer-pair callout (CFH ↔ Scandia) ──────────────────────────── */}
      {activePair && (
        <div className="px-5 sm:px-6 py-3 bg-emerald-50/40 dark:bg-emerald-900/10 border-y border-emerald-600/10">
          <div className="flex items-start gap-3">
            <Sparkles
              size={15}
              strokeWidth={2}
              className="text-emerald-600 dark:text-emerald-300 shrink-0 mt-0.5"
            />
            <div className="flex-1 min-w-0">
              <div className="text-[12.5px] font-semibold text-ink mb-0.5">
                Your real peer · {activePair.pair.privateLabel} vs.{" "}
                {activePair.row.companyName}
              </div>
              <div className="text-[11.5px] text-ink-soft leading-relaxed">
                {activePair.pair.rationale}
              </div>
            </div>
            <button
              type="button"
              onClick={() => onSelectTicker(activePair.row.ticker)}
              data-testid={`peer-pair-cta-${activePair.row.ticker}`}
              className="
                shrink-0 inline-flex items-center gap-1 h-7 px-2.5 rounded-full
                text-[11.5px] font-medium
                bg-emerald-600 text-white hover:bg-emerald-700
                dark:bg-emerald-500 dark:hover:bg-emerald-400 dark:text-emerald-950
                transition-colors
              "
            >
              Compare
              <ChevronRight size={11} strokeWidth={2.5} />
            </button>
          </div>
        </div>
      )}

      {/* ── Rows ───────────────────────────────────────────────────────── */}
      <ul className="divide-y divide-rule/40">
        {bvbRows.slice(0, 6).map((r) => (
          <BvbRow
            key={r.ticker}
            row={r}
            onSelect={() => onSelectTicker(r.ticker)}
          />
        ))}
      </ul>

      {/* ── Footer: Explore all + sparse-data hint ─────────────────────── */}
      <div className="px-5 sm:px-6 py-3 flex items-center justify-between gap-3 border-t border-rule/40">
        <span className="text-[11px] text-ink-mute">
          {bvbRows.filter((r) => r.revenue == null).length > 0
            ? `${bvbRows.filter((r) => r.revenue == null).length} rows pending operator data fill`
            : "All loaded rows have FY2024 numbers"}
        </span>
        <button
          type="button"
          onClick={() => onExplore(bvbRows.map((r) => r.ticker))}
          data-testid="romanian-listed-explore-all"
          className="
            inline-flex items-center gap-1.5 h-8 px-3 rounded-full
            border border-rule bg-surface text-[12px] font-medium text-ink-soft
            hover:text-ink hover:bg-bg-2 transition-colors
          "
        >
          Browse all {bvbRows.length}
          <ChevronRight size={12} strokeWidth={2} />
        </button>
      </div>
    </section>
  );
}

// ── Row ──────────────────────────────────────────────────────────────────

function BvbRow({
  row,
  onSelect,
}: {
  row: PublicCompanyFinancialSnapshot;
  onSelect: () => void;
}) {
  // For the inline ticker display strip the namespacing suffix (".BVB")
  // so end users see the bare BVB ticker. Programmatic lookups still use
  // the namespaced form via `row.ticker`.
  const displayTicker = row.ticker.replace(/\.BVB$/, "");
  const isPending = row.revenue == null;
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        data-testid={`bvb-row-${row.ticker}`}
        className="
          w-full flex items-center gap-3 px-5 sm:px-6 py-3
          hover:bg-bg-2/40 transition-colors text-left
        "
      >
        <CompanyLogo ticker={displayTicker} size={32} />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="font-mono font-semibold text-[12.5px] text-ink tabular-nums">
              {displayTicker}
            </span>
            <span
              className="text-[12.5px] text-ink-soft truncate"
              title={row.companyName}
            >
              {row.companyName}
            </span>
          </div>
          <div className="text-[11px] text-ink-mute mt-0.5">
            {row.sector ?? "—"}
            {row.industry ? ` · ${row.industry}` : ""}
          </div>
        </div>
        <div className="flex flex-col items-end shrink-0 min-w-0">
          {isPending ? (
            <span className="text-[11px] text-ink-mute italic">
              data pending
            </span>
          ) : (
            <>
              <span className="text-[12.5px] tabular-nums text-ink">
                {fmtRonShort(row.revenue)}
              </span>
              <span className="text-[11px] text-ink-mute tabular-nums">
                Rev · {row.latestPeriod ?? "FY2024"}
              </span>
            </>
          )}
        </div>
        <ChevronRight
          size={14}
          strokeWidth={2}
          className="text-ink-mute shrink-0"
        />
      </button>
    </li>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Compact RON formatting. Skips the FX-aware Money component on purpose
 *  — this card is RON-native and shouldn't double-convert if the user
 *  has the global currency toggle set to EUR/USD. The drawer + tables
 *  do the FX-aware rendering. */
function fmtRonShort(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `RON ${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `RON ${(value / 1e6).toFixed(0)}M`;
  if (abs >= 1e3) return `RON ${(value / 1e3).toFixed(0)}K`;
  return `RON ${value.toFixed(0)}`;
}
