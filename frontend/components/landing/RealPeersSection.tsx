// RealPeersSection — replaces the old AAPL/MSFT/NVDA showcase with a
// sector grid of $50M-$5B "you-sized" public companies.
// =========================================================================
// Strategic repositioning (2026-05-27): the prior PublicCompanyShowcase
// led with AAPL/MSFT/NVDA/TSLA/GOOGL — cognitive noise for a Romanian SMB
// founder who runs a €5-50M business. This component shows companies they
// can actually peer against: Hain Celestial ($1B), Lifeway Foods ($0.4B),
// US Physical Therapy ($1.1B). Six sector cards, ~4 tickers each, all
// market-capped between $100M and $5B so the visitor's mental model
// becomes "I could find peers here" rather than "this tool analyzes Apple."
//
// Cards link to /public-companies?sector=<slug>. The existing markets
// surface already filters by sector via query param; no new route needed.
// Lock #11 (audit shared hub before per-surface plumbing) applies — the
// `/public-companies` page is the existing hub, we route through it
// rather than create `/markets/sector/:slug` parallel routes.
import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";

interface PeerCompany {
  ticker: string;
  name: string;
  marketCap: string;
}

interface PeerCategory {
  icon: string;
  labelKey: string;
  labelFallback: string;
  descriptionKey: string;
  descriptionFallback: string;
  examples: PeerCompany[];
  sectorSlug: string;
}

const PEER_CATEGORIES: PeerCategory[] = [
  {
    icon: "🥫",
    labelKey: "landing.realPeers.categories.consumer.label",
    labelFallback: "Consumer goods / Food",
    descriptionKey: "landing.realPeers.categories.consumer.description",
    descriptionFallback: "Packaged foods, beverages, household products",
    examples: [
      { ticker: "HAIN", name: "Hain Celestial", marketCap: "$1.0B" },
      { ticker: "LWAY", name: "Lifeway Foods", marketCap: "$0.4B" },
      { ticker: "JJSF", name: "J&J Snack Foods", marketCap: "$2.8B" },
      { ticker: "BGS", name: "B&G Foods", marketCap: "$0.6B" },
    ],
    sectorSlug: "consumer-goods",
  },
  {
    icon: "🛢️",
    labelKey: "landing.realPeers.categories.energy.label",
    labelFallback: "Energy / Industrials",
    descriptionKey: "landing.realPeers.categories.energy.description",
    descriptionFallback: "Resource extraction, equipment, logistics",
    examples: [
      { ticker: "SXC", name: "SunCoke Energy", marketCap: "$0.9B" },
      { ticker: "NRP", name: "Natural Resource Partners", marketCap: "$1.1B" },
      { ticker: "HCC", name: "Warrior Met Coal", marketCap: "$3.3B" },
      { ticker: "NC", name: "NACCO Industries", marketCap: "$0.3B" },
    ],
    sectorSlug: "energy-industrials",
  },
  {
    icon: "🏭",
    labelKey: "landing.realPeers.categories.manufacturing.label",
    labelFallback: "Manufacturing",
    descriptionKey: "landing.realPeers.categories.manufacturing.description",
    descriptionFallback: "Industrial equipment, components, specialty",
    examples: [
      { ticker: "CMCO", name: "Columbus McKinnon", marketCap: "$0.8B" },
      { ticker: "GHM", name: "Graham Corp", marketCap: "$0.4B" },
      { ticker: "PKE", name: "Park Aerospace", marketCap: "$0.5B" },
      { ticker: "PRLB", name: "Proto Labs", marketCap: "$1.0B" },
    ],
    sectorSlug: "manufacturing",
  },
  {
    icon: "💊",
    labelKey: "landing.realPeers.categories.healthcare.label",
    labelFallback: "Healthcare / Services",
    descriptionKey: "landing.realPeers.categories.healthcare.description",
    descriptionFallback: "Specialty clinics, home care, devices",
    examples: [
      { ticker: "USPH", name: "US Physical Therapy", marketCap: "$1.1B" },
      { ticker: "ADUS", name: "Addus HomeCare", marketCap: "$1.6B" },
      { ticker: "FONR", name: "Fonar Corp", marketCap: "$0.1B" },
      { ticker: "PDCO", name: "Patterson Companies", marketCap: "$2.4B" },
    ],
    sectorSlug: "healthcare",
  },
  {
    icon: "🛒",
    labelKey: "landing.realPeers.categories.retail.label",
    labelFallback: "Retail / E-commerce",
    descriptionKey: "landing.realPeers.categories.retail.description",
    descriptionFallback: "Specialty stores, online, distribution",
    examples: [
      { ticker: "CATO", name: "Cato Corp", marketCap: "$0.1B" },
      { ticker: "HZO", name: "MarineMax", marketCap: "$0.5B" },
      { ticker: "ETD", name: "Ethan Allen", marketCap: "$0.7B" },
      { ticker: "BBW", name: "Build-A-Bear Workshop", marketCap: "$0.5B" },
    ],
    sectorSlug: "retail",
  },
  {
    icon: "💻",
    labelKey: "landing.realPeers.categories.software.label",
    labelFallback: "Software / Tech services",
    descriptionKey: "landing.realPeers.categories.software.description",
    descriptionFallback: "SaaS, IT services, software distribution",
    examples: [
      { ticker: "BIGC", name: "BigCommerce", marketCap: "$0.6B" },
      { ticker: "GLBE", name: "Global-E Online", marketCap: "$4.1B" },
      { ticker: "EVBG", name: "Everbridge", marketCap: "$1.2B" },
      { ticker: "BAND", name: "Bandwidth Inc.", marketCap: "$0.4B" },
    ],
    sectorSlug: "software",
  },
];

export function RealPeersSection() {
  const { t } = useTranslation();

  return (
    <section className="relative border-t border-rule/40 bg-surface/20">
      <div className="relative mx-auto max-w-[1100px] px-5 sm:px-8 py-20 sm:py-28">
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="text-center max-w-3xl mx-auto mb-12 sm:mb-14"
        >
          <div className="inline-flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.18em] text-ink-soft font-medium mb-4">
            <span className="inline-block h-[7px] w-[7px] bg-[hsl(var(--brand))]" aria-hidden />
            {t("landing.realPeers.eyebrow", "Real peers, not mega-caps")}
          </div>
          <h2 className="text-3xl sm:text-4xl md:text-[44px] font-semibold tracking-tight leading-[1.05] text-ink mb-4">
            {t(
              "landing.realPeers.headline",
              "Browse 5,000+ public companies. Find the 5 that look like you.",
            )}
          </h2>
          <p className="text-[15px] sm:text-base text-ink-soft leading-relaxed max-w-2xl mx-auto">
            {t(
              "landing.realPeers.subhead",
              "Filter by size, sector, geography. Add peers one at a time. They join your Benchmark page as named comparison anchors.",
            )}
          </p>
          <p className="text-[13px] text-info mt-4 font-medium">
            {t(
              "landing.realPeers.notMegaCaps",
              "These companies actually look like yours — $50M to $5B market cap, not trillion-dollar tech.",
            )}
          </p>
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-5">
          {PEER_CATEGORIES.map((cat, i) => (
            <motion.div
              key={cat.sectorSlug}
              initial={{ opacity: 0, y: 8 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.06, duration: 0.4 }}
            >
              <Link
                to={`/public-companies?sector=${cat.sectorSlug}`}
                data-testid={`landing-peer-sector-${cat.sectorSlug}`}
                className="
                  group block text-left p-5 rounded-2xl
                  bg-surface border border-rule
                  hover:border-rule-strong hover:bg-surface
                  shadow-[0_2px_8px_-4px_rgba(0,0,0,0.15)]
                  hover:shadow-[0_8px_24px_-12px_rgba(0,0,0,0.25)]
                  hover:-translate-y-0.5 transition-all duration-200
                "
              >
                <div className="flex items-start gap-3 mb-4">
                  <div className="text-2xl flex-shrink-0 leading-none">{cat.icon}</div>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-[15px] font-semibold leading-tight text-ink mb-1">
                      {t(cat.labelKey, cat.labelFallback)}
                    </h3>
                    <p className="text-[11.5px] text-ink-mute leading-relaxed">
                      {t(cat.descriptionKey, cat.descriptionFallback)}
                    </p>
                  </div>
                </div>

                <div className="space-y-1.5 mb-4">
                  {cat.examples.map((co) => (
                    <div key={co.ticker} className="flex items-center justify-between text-[12px]">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-mono font-semibold text-ink tabular-nums">
                          {co.ticker}
                        </span>
                        <span className="text-ink-soft truncate">{co.name}</span>
                      </div>
                      <span className="text-ink-mute tabular-nums flex-shrink-0">
                        {co.marketCap}
                      </span>
                    </div>
                  ))}
                </div>

                <div className="flex items-center justify-between pt-3 border-t border-rule/60">
                  <span className="text-[11.5px] text-ink-mute">
                    {t("landing.realPeers.moreInSector", "More in this sector")}
                  </span>
                  <ArrowRight
                    size={14}
                    className="text-ink-mute group-hover:text-info group-hover:translate-x-0.5 transition-all"
                  />
                </div>
              </Link>
            </motion.div>
          ))}
        </div>

        <div className="text-center mt-10">
          <Link
            to="/public-companies"
            data-testid="landing-peer-browse-all"
            className="inline-flex items-center gap-2 text-[13px] text-ink-soft hover:text-ink font-medium transition-colors"
          >
            {t("landing.realPeers.browseAll", "Browse all 5,000+ public companies")}
            <ArrowRight size={14} />
          </Link>
        </div>
      </div>
    </section>
  );
}
