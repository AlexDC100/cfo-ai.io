// MarketPeerAdd — "Add as peer" for a NON-Romanian market company card.
//
// The Romanian flow already existed (PeerSuggestRail → addPeer →
// benchmarkPeersStore → the Benchmarking panel's groups). This is the
// SAME flow, not a parallel one: same store, same added-state chip, same
// toast. What it adds is the part a BVB ticker never needed —
//
//   the peer carries its MARKET, its NATIVE currency and its ACCOUNTING
//   STANDARD, because that triple is what `lib/benchmarkGroups.ts` uses
//   to decide which population it may sit in. Drop it and a USD US_GAAP
//   filer lands inside a RON RAS/IFRS median, which is the exact defect
//   PM7 exists to prevent.
//
// ── WHAT A PEER IS ALLOWED TO CARRY ────────────────────────────────────
// The Benchmarking panel compares RATIOS. A pm1 envelope carries FIGURES,
// so a ratio only exists here when the document itself supports it end to
// end. `peerMetricsFromEnvelope` therefore computes a ratio only when:
//
//   · both figures are present, and
//   · both are money in the SAME currency, and
//   · both describe the SAME fiscal period end, and
//   · the denominator is finite and non-zero.
//
// Anything else is ABSENT, never zero. Today's US envelope (revenue,
// net_income, total_assets, equity, total_debt — no EBITDA, no cash by
// design, no prior year) therefore yields exactly two: net margin and
// debt / equity. EBITDA margin, leverage, FCF yield, EV/EBITDA and
// dividend yield stay absent, and the panel renders no tile for them
// rather than a tile whose number was invented here.

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useInRouterContext, useSearchParams } from "react-router-dom";
import { Check, Plus } from "lucide-react";

import i18n from "@/i18n";
import { toast } from "@/hooks/use-toast";
import { Chip } from "@/components/instrument/Panel";
import {
  MARKET_TAB_PARAM,
  type MarketCompanyDocument,
  type MarketEnvelope,
  type MarketFigure,
} from "@/lib/marketApi";
import {
  addPeer,
  removePeer,
  useBenchmarkPeers,
  type PeerEntry,
  type PeerMetrics,
} from "@/lib/benchmarkPeersStore";
import { figureFiscal, figureMajor } from "./marketFigures";

// ── i18n (per-feature bundle, EN + RO tu-form) ─────────────────────────

const peerEn = {
  add: "Add as peer",
  added: "Peer",
  remove: "Remove {{ticker}} from peers",
  toastAdded: "{{ticker}} added as a benchmark peer.",
  toastRemoved: "{{ticker}} removed from peers.",
  open: "See it in Benchmark",
  // The whole point of the control, said once beside it.
  cohortNote:
    "Added peers keep their own population — {{standard}} figures in {{currency}} are compared with {{standard}} figures, never folded into the Romanian cohort.",
  carriesOne: "Carries 1 comparable ratio",
  carriesMany: "Carries {{count}} comparable ratios",
  carriesNone: "No ratio in this filing is comparable yet",
  carriesNoneWhy:
    "This document states figures, not ratios, and nothing in it supports one of the benchmark metrics — so the peer joins its population without a value rather than with a computed guess.",
};

const peerRo = {
  add: "Adaugă ca peer",
  added: "Peer",
  remove: "Elimină {{ticker}} din peers",
  toastAdded: "{{ticker}} a fost adăugat ca peer de comparație.",
  toastRemoved: "{{ticker}} a fost eliminat din peers.",
  open: "Vezi în Benchmark",
  cohortNote:
    "Peers adăugați își păstrează propria populație — cifrele {{standard}} în {{currency}} se compară cu cifre {{standard}}, niciodată amestecate în cohorta românească.",
  carriesOne: "Aduce 1 indicator comparabil",
  carriesMany: "Aduce {{count}} indicatori comparabili",
  carriesNone: "Niciun indicator din acest raport nu este încă comparabil",
  carriesNoneWhy:
    "Documentul conține cifre, nu indicatori, și niciunul dintre indicatorii de benchmark nu poate fi calculat din el — așa că peer-ul intră în populația lui fără valoare, nu cu una inventată.",
};

i18n.addResourceBundle("en", "translation", { pcm: { peer: peerEn } }, true, false);
i18n.addResourceBundle("ro", "translation", { pcm: { peer: peerRo } }, true, false);

// ── deriving a peer from a market document ─────────────────────────────

/** True when two figures describe the same money in the same period —
 *  the only case in which their ratio is a fact about one company rather
 *  than an arithmetic accident across two. */
function comparable(a: MarketFigure | undefined, b: MarketFigure | undefined): boolean {
  if (!a || !b) return false;
  const ca = (a.currency ?? "").toUpperCase();
  const cb = (b.currency ?? "").toUpperCase();
  if (!ca || ca !== cb) return false;
  const fa = figureFiscal(a)?.end ?? null;
  const fb = figureFiscal(b)?.end ?? null;
  return !!fa && fa === fb;
}

function ratio(
  figures: Record<string, MarketFigure>,
  numerator: string,
  denominator: string,
): number | null {
  const n = figures[numerator];
  const d = figures[denominator];
  if (!comparable(n, d)) return null;
  const nv = figureMajor(n!);
  const dv = figureMajor(d!);
  if (nv === null || dv === null) return null;
  if (!Number.isFinite(nv) || !Number.isFinite(dv) || dv === 0) return null;
  const out = nv / dv;
  return Number.isFinite(out) ? out : null;
}

/** The ratios this envelope honestly supports. Keys mirror the
 *  Benchmarking panel's metric keys. Absent stays absent. */
export function peerMetricsFromEnvelope(env: MarketEnvelope): PeerMetrics {
  const figures = env.figures ?? {};
  const out: PeerMetrics = {};

  const netMargin = ratio(figures, "net_income", "revenue");
  if (netMargin !== null) out.net_margin_pct = netMargin * 100;

  const debtToEquity = ratio(figures, "total_debt", "equity");
  if (debtToEquity !== null) out.debt_to_equity = debtToEquity;

  // EBITDA-based metrics are deliberately NOT approximated from
  // operating income or from net income + a guessed D&A. The US adapter
  // does not extract EBITDA or cash (its own coverage note says so), so
  // ebitda_margin_pct / net_debt_to_ebitda / ev_ebitda / fcf_yield_pct /
  // dividend_yield_pct / revenue_growth_pct have no honest source here.
  return out;
}

/** Fiscal label for the figures a peer actually carries — read off the
 *  figures the ratios used, not off the envelope's newest fact (shares
 *  outstanding is a later quarter and would mislabel the annual set). */
export function peerFiscalLabel(env: MarketEnvelope): string | null {
  const figures = env.figures ?? {};
  for (const name of ["revenue", "net_income", "equity", "total_assets"]) {
    const fy = figureFiscal(figures[name])?.fy;
    if (typeof fy === "number" && Number.isFinite(fy)) return `FY${fy}`;
  }
  const anchor = env.fiscal_anchor as { latest_fy?: unknown } | undefined;
  if (anchor && typeof anchor.latest_fy === "number") return `FY${anchor.latest_fy}`;
  return null;
}

/** The currency the peer's OWN figures are stated in — only when every
 *  money figure agrees. A mixed-currency document declares none, and the
 *  registry currency is then the fallback the market itself states. */
export function peerNativeCurrency(env: MarketEnvelope): string | null {
  const currencies = new Set(
    Object.values(env.figures ?? {})
      .map((f) => f.currency)
      .filter((c): c is string => typeof c === "string" && !!c)
      .map((c) => c.toUpperCase()),
  );
  return currencies.size === 1 ? [...currencies][0]! : null;
}

export type PeerDraft = Omit<PeerEntry, "addedAt" | "source">;

/** Everything the store needs, read off ONE market document. Returns
 *  null when the document does not name a ticker — an entry keyed on an
 *  internal entity id would be unrecognisable in the peer tray. */
export function peerDraftFromMarketDocument(
  doc: MarketCompanyDocument,
): PeerDraft | null {
  const env = doc.envelope;
  const entity = (env.entity ?? {}) as { ticker?: unknown; name?: unknown };
  const ticker =
    typeof entity.ticker === "string" && entity.ticker.trim()
      ? entity.ticker.trim().toUpperCase()
      : null;
  if (!ticker) return null;

  const name =
    typeof entity.name === "string" && entity.name.trim() ? entity.name.trim() : ticker;

  return {
    ticker,
    name,
    // The universe's sector taxonomy is a BVB-side classification; a pm1
    // envelope carries none, and borrowing one would put this company in
    // a sector subgroup it was never classified into.
    sector: null,
    // No exchange: the US registry lists NYSE *and* NASDAQ and the
    // envelope names neither, so picking one would be a guess. The
    // market id below is the fact the document actually carried.
    exchange: null,
    marketId: doc.market.market_id,
    accountingStandard: doc.market.accounting_standard ?? null,
    currency: peerNativeCurrency(env) ?? doc.market.currency,
    fiscalLabel: peerFiscalLabel(env),
    metrics: peerMetricsFromEnvelope(env),
  };
}

// ── the control ────────────────────────────────────────────────────────

export function MarketPeerButton({ document: doc }: { document: MarketCompanyDocument }) {
  const { t } = useTranslation();
  const peers = useBenchmarkPeers();
  // The card renders in tests (and could render in any future non-routed
  // context) without a Router. `useSearchParams` THROWS there, so the
  // navigation affordance is a separate child mounted only when a Router
  // is actually present — the add/remove control itself must never need
  // one to work.
  const inRouter = useInRouterContext();

  const draft = useMemo(() => peerDraftFromMarketDocument(doc), [doc]);
  if (!draft) return null;

  // Read the added state off the SUBSCRIBED snapshot, not off the
  // module-level `isPeer`, so the chip re-renders the moment the store
  // changes — including when the same peer is removed from the tray.
  const added = peers.some(
    (p) =>
      p.ticker === draft.ticker &&
      (p.marketId ?? null) === (draft.marketId ?? null),
  );

  const metricCount = Object.keys(draft.metrics ?? {}).length;

  const handleAdd = () => {
    addPeer(draft);
    toast({ title: t("pcm.peer.toastAdded", { ticker: draft.ticker }) });
  };

  const handleRemove = () => {
    removePeer(draft.ticker, draft.marketId);
    toast({ title: t("pcm.peer.toastRemoved", { ticker: draft.ticker }) });
  };

  return (
    <div
      className="flex flex-wrap items-center gap-2 border-t border-rule-soft pt-2.5"
      data-testid={`market-peer-add-${draft.marketId}-${draft.ticker}`}
    >
      {added ? (
        <>
          <Chip tone="success" data-testid={`market-peer-added-${draft.ticker}`}>
            <Check size={11} strokeWidth={2.5} />
            {t("pcm.peer.added")}
          </Chip>
          {inRouter && <OpenBenchmarkLink ticker={draft.ticker} />}
          <button
            type="button"
            onClick={handleRemove}
            aria-label={t("pcm.peer.remove", { ticker: draft.ticker })}
            data-testid={`market-peer-remove-${draft.ticker}`}
            className="text-[11.5px] text-ink-mute transition-colors hover:text-ink"
          >
            ×
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={handleAdd}
          data-testid={`market-peer-add-button-${draft.ticker}`}
          className="
            inline-flex h-8 items-center justify-center gap-1.5 rounded-sm border border-rule
            px-3 text-[11.5px] font-medium text-ink
            transition-colors duration-micro hover:border-rule-strong hover:bg-bg-2
          "
        >
          <Plus size={12} strokeWidth={2.5} />
          {t("pcm.peer.add")}
        </button>
      )}

      <span className="font-mono text-[10.5px] text-ink-mute" data-testid="market-peer-carries">
        {metricCount === 0
          ? t("pcm.peer.carriesNone")
          : metricCount === 1
            ? t("pcm.peer.carriesOne")
            : t("pcm.peer.carriesMany", { count: metricCount })}
      </span>

      {/* The law, stated where the action is taken. Shown once the peer
          is in, when it is a claim about what just happened; and after a
          fresh add, when it is the answer to "where did it go?". */}
      {added && (
        <p className="w-full text-[10.5px] leading-relaxed text-ink-soft">
          {metricCount === 0
            ? t("pcm.peer.carriesNoneWhy")
            : t("pcm.peer.cohortNote", {
                standard: draft.accountingStandard ?? doc.market.accounting_standard,
                currency: draft.currency,
              })}
        </p>
      )}
    </div>
  );
}

/** "See it in Benchmark" — switches to the home-market tab (where the
 *  universe surface, and therefore the Benchmarking panel, renders) and
 *  scrolls to the panel. A peer the user cannot see landing is
 *  indistinguishable from one that was silently dropped. */
function OpenBenchmarkLink({ ticker }: { ticker: string }) {
  const { t } = useTranslation();
  const [, setSearchParams] = useSearchParams();

  const open = () => {
    setSearchParams(
      (sp) => {
        const next = new URLSearchParams(sp);
        next.delete(MARKET_TAB_PARAM); // absent = the home market tab
        next.delete("country");
        next.set("tab", "overview");
        return next;
      },
      { replace: false },
    );
    // After the tab swap paints. The panel is a page below the fold on
    // the home tab, so without the scroll the reader lands on the market
    // header and has to hunt for the thing they were promised.
    window.setTimeout(() => {
      window.document
        .querySelector('[data-testid="public-companies-benchmark-panel"]')
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 150);
  };

  return (
    <button
      type="button"
      onClick={open}
      data-testid={`market-peer-open-benchmark-${ticker}`}
      className="
        text-[11.5px] font-medium text-brand-dark underline underline-offset-2
        transition-colors hover:text-brand dark:text-brand-light
      "
    >
      {t("pcm.peer.open")}
    </button>
  );
}
