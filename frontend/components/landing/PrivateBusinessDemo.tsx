// PrivateBusinessDemo — the live-preview frame that sells the product
// =========================================================================
// Strategic repositioning (2026-05-27): the prior live preview showed a
// single public company (AAPL/MSFT/etc.) with its own KPIs in isolation.
// That's the wrong story — the product's value is comparing a PRIVATE
// business to public peers, not analyzing public companies standalone.
// This frame shows "Acme Foods SRL" (private demo) alongside 3 real
// public peers (Hain Celestial / Lifeway / J&J Snack Foods) with a
// multi-dot benchmark per metric + an insight callout that names what
// the product actually delivers: interpretation, not just data.
//
// The insight callout ("Below peer EBITDA, above growth median.
// Investment in margin = leverage point.") is the product in one line.
// It shows that CFO AI doesn't just visualize — it interprets. This
// stays prominent.
//
// All data is hardcoded — no backend fetches on the marketing surface.
// LCP-friendly: SVG + Tailwind only, no chart library, no remote
// images. The MultiDotMetric component (inline at bottom) is a
// purpose-built mini-bar visualization for "P25-P75 range + median
// tick + your dot + peer dots" — the literal output the Benchmark
// page shows post-upload.
import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Sparkles } from "lucide-react";
import { CompanyLogo } from "@/components/public-companies/CompanyLogo";

interface PeerData {
  ticker: string;
  name: string;
  marketCap: string;
}

interface MetricRow {
  labelKey: string;
  labelFallback: string;
  /** P25-P75 industry range. */
  industryP25: number;
  industryP75: number;
  industryMedian: number;
  /** Acme Foods' value. */
  your: number;
  peers: Array<{ ticker: string; value: number }>;
  /** Format hint for the data labels under the bar. */
  unit: "pct" | "days";
}

const DEMO_PEERS: PeerData[] = [
  { ticker: "HAIN", name: "Hain Celestial", marketCap: "$1.0B" },
  { ticker: "LWAY", name: "Lifeway Foods", marketCap: "$0.4B" },
  { ticker: "JJSF", name: "J&J Snack Foods", marketCap: "$2.8B" },
];

const DEMO_METRICS: MetricRow[] = [
  {
    labelKey: "landing.demo.metrics.ebitdaMargin",
    labelFallback: "EBITDA margin",
    industryP25: 9.5,
    industryP75: 16.5,
    industryMedian: 12.1,
    your: 8.2,
    peers: [
      { ticker: "HAIN", value: 14.5 },
      { ticker: "JJSF", value: 16.8 },
      { ticker: "LWAY", value: 11.2 },
    ],
    unit: "pct",
  },
  {
    labelKey: "landing.demo.metrics.revenueGrowth",
    labelFallback: "Revenue growth YoY",
    industryP25: 4.0,
    industryP75: 14.0,
    industryMedian: 12.0,
    your: 9.5,
    peers: [
      { ticker: "HAIN", value: 18.3 },
      { ticker: "JJSF", value: 11.5 },
      { ticker: "LWAY", value: 2.1 },
    ],
    unit: "pct",
  },
];

export function PrivateBusinessDemo() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <section className="relative border-t border-rule/40">
      <div className="relative mx-auto max-w-[900px] px-5 sm:px-8 py-20 sm:py-28">
        {/* Section caption — sets expectation before the frame */}
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="text-center max-w-2xl mx-auto mb-10"
        >
          <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight text-ink mb-3">
            {t("landing.demo.sectionHeadline", "This is what you'll see, in 90 seconds.")}
          </h2>
          <p className="text-[14px] text-ink-soft leading-relaxed">
            {t(
              "landing.demo.sectionSubhead",
              "Your numbers as a private business, side-by-side with real public peers and the industry range. No more guessing where you stand.",
            )}
          </p>
        </motion.div>

        {/* The frame */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
          className="
            rounded-2xl overflow-hidden border border-rule bg-surface
            shadow-[0_24px_80px_-30px_rgba(0,0,0,0.45)]
          "
        >
          {/* Window chrome */}
          <div className="flex items-center gap-3 px-4 py-2.5 border-b border-rule/60 bg-bg-2/80 backdrop-blur">
            <div className="flex gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-red-400/40" aria-hidden />
              <span className="w-2.5 h-2.5 rounded-full bg-[#5CD3C5]/40" aria-hidden />
              <span className="w-2.5 h-2.5 rounded-full bg-[#5CD3C5]/40" aria-hidden />
            </div>
            <div className="flex-1 text-center text-[11px] text-ink-mute font-mono truncate">
              cfo-ai.io / demo · {t("landing.demo.frameLabel", "This is what you'll see")}
            </div>
          </div>

          <div className="p-5 sm:p-7 space-y-6">
            {/* Company header */}
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <h3 className="text-lg font-semibold text-ink">Acme Foods SRL</h3>
                <p className="text-[13px] text-ink-soft mt-0.5">
                  {t("landing.demo.companySector", "Consumer goods")} · €12M{" "}
                  {t("landing.demo.revenue", "revenue")}
                </p>
              </div>
              <span className="text-[9.5px] uppercase tracking-[0.14em] px-2 py-1 rounded-full bg-info/10 text-info font-semibold flex-shrink-0">
                {t("landing.demo.samplePrivate", "Sample private business")}
              </span>
            </div>

            {/* Peers added */}
            <div>
              <div className="text-[10.5px] uppercase tracking-[0.14em] text-ink-mute font-medium mb-2.5">
                {t("landing.demo.peersAdded", "Peers you've added")}
              </div>
              <div className="flex flex-wrap gap-2">
                {DEMO_PEERS.map((p) => (
                  <div
                    key={p.ticker}
                    className="
                      inline-flex items-center gap-2 px-2.5 py-1.5 rounded-full
                      bg-bg-2 border border-info/25
                    "
                  >
                    <CompanyLogo ticker={p.ticker} size={16} />
                    <span className="font-mono font-semibold text-[12px] text-ink">{p.ticker}</span>
                    <span className="text-[12px] text-ink-soft hidden sm:inline">{p.name}</span>
                    <span className="text-[10.5px] text-ink-mute tabular-nums">{p.marketCap}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Multi-dot benchmark bars */}
            <div className="space-y-5">
              {DEMO_METRICS.map((m) => (
                <MultiDotMetric key={m.labelKey} {...m} t={t} />
              ))}
            </div>

            {/* Insight callout — the product in one line */}
            <div className="p-4 rounded-xl bg-info/8 border border-info/25">
              <div className="flex items-start gap-2.5">
                <Sparkles size={16} className="text-info flex-shrink-0 mt-0.5" />
                <p className="text-[13px] leading-relaxed">
                  <strong className="text-ink">
                    {t("landing.demo.insightLabel", "Insight")}:{" "}
                  </strong>
                  <span className="text-ink-soft">
                    {t(
                      "landing.demo.insightBody",
                      "Below peer EBITDA, above growth median. Investment in margin = leverage point.",
                    )}
                  </span>
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => navigate("/signup")}
              data-testid="landing-demo-try-mine"
              className="
                w-full py-3 rounded-full
                bg-gradient-cfo text-white font-medium
                hover:shadow-2 transition-shadow
                inline-flex items-center justify-center gap-2 min-h-[48px]
              "
            >
              {t("landing.demo.tryWithMine", "Try with my own data")}
              <ArrowRight size={15} />
            </button>
          </div>
        </motion.div>
      </div>
    </section>
  );
}

// ───────────────────────────────────────────────────────────────────────
// MultiDotMetric — purpose-built mini-bar showing P25-P75 industry range
// + median tick + YOUR dot (green) + peer dots (info blue). The exact
// shape the Benchmark page renders post-upload, scaled to the demo
// frame.
// ───────────────────────────────────────────────────────────────────────

interface MultiDotMetricProps extends MetricRow {
  t: (key: string, fallback: string) => string;
}

function MultiDotMetric({
  labelKey,
  labelFallback,
  industryP25,
  industryP75,
  industryMedian,
  your,
  peers,
  unit,
  t,
}: MultiDotMetricProps) {
  // Normalize all values onto a 0-100 scale for positioning. Padded by
  // 10 % on each side so dots near the extremes don't clip the bar.
  const all = [industryP25, industryP75, industryMedian, your, ...peers.map((p) => p.value)];
  const min = Math.min(...all);
  const max = Math.max(...all);
  const range = max - min || 1;
  const padded_min = min - range * 0.15;
  const padded_max = max + range * 0.15;
  const norm = (v: number) =>
    ((v - padded_min) / (padded_max - padded_min)) * 100;

  const fmt = (v: number) =>
    unit === "pct" ? `${v.toFixed(1)}%` : `${v.toFixed(0)}d`;

  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <span className="text-[13px] font-medium text-ink">
          {t(labelKey, labelFallback)}
        </span>
        <span className="text-[10.5px] text-ink-mute">
          {t("landing.demo.vsPeers", "vs peers")}
        </span>
      </div>

      <div className="relative h-9 bg-bg-2/50 rounded-lg border border-rule/60">
        {/* Industry P25-P75 range */}
        <div
          className="absolute h-full bg-info/15 rounded-lg pointer-events-none"
          style={{
            left: `${norm(industryP25)}%`,
            width: `${norm(industryP75) - norm(industryP25)}%`,
          }}
          aria-hidden
        />
        {/* Median marker */}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-ink-soft/60 pointer-events-none"
          style={{ left: `${norm(industryMedian)}%` }}
          aria-hidden
        />

        {/* YOUR dot — success green, bigger so it reads as the anchor */}
        <div
          className="
            absolute top-1/2 -translate-y-1/2 -translate-x-1/2
            w-3.5 h-3.5 rounded-full bg-[hsl(var(--success))]
            ring-[3px] ring-surface
            cursor-default
          "
          style={{ left: `${norm(your)}%` }}
          title={`Acme Foods: ${fmt(your)}`}
          aria-label={`Acme Foods: ${fmt(your)}`}
        />

        {/* Peer dots — info blue */}
        {peers.map((peer) => (
          <div
            key={peer.ticker}
            className="
              absolute top-1/2 -translate-y-1/2 -translate-x-1/2
              w-3 h-3 rounded-full bg-info ring-2 ring-surface
              cursor-default
            "
            style={{ left: `${norm(peer.value)}%` }}
            title={`${peer.ticker}: ${fmt(peer.value)}`}
            aria-label={`${peer.ticker}: ${fmt(peer.value)}`}
          />
        ))}
      </div>

      {/* Data legend */}
      <div className="flex items-center flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px]">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-2 h-2 rounded-full bg-[hsl(var(--success))]" aria-hidden />
          <span className="text-ink-soft">
            {t("landing.demo.you", "You")}:{" "}
            <strong className="tabular-nums text-[hsl(var(--success))]">{fmt(your)}</strong>
          </span>
        </span>
        <span className="text-ink-soft">
          {t("landing.demo.median", "Median")}:{" "}
          <strong className="tabular-nums text-ink">{fmt(industryMedian)}</strong>
        </span>
        {peers.slice(0, 2).map((p) => (
          <span key={p.ticker} className="text-ink-soft">
            <span className="font-mono">{p.ticker}</span>:{" "}
            <strong className="tabular-nums text-ink">{fmt(p.value)}</strong>
          </span>
        ))}
      </div>
    </div>
  );
}
