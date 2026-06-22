// CFO AI — public landing page.
//
// Dark fintech style. Sections:
//   1. Header — logo + nav + Sign in + Get started — free
//   2. Hero (left)  + AuthCard (right, embedded — desktop only)
//   3. Flagship modules — 3 product pillars
//   4. Product preview — AI CFO Briefing dashboard mock
//   5. How it works — 3 steps
//   6. Use cases — CFO / CEO / Procurement / Commercial / Operations
//   7. Pricing
//   8. Final CTA
//   9. Footer
//
// Typography rule: serif headlines are UPRIGHT only (no italic). Eyebrows
// across the page use the techy UPPERCASE monospace style with a brand-teal
// square bullet — the user's preferred eyebrow treatment.

import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "framer-motion";
import { CompanyLogo } from "@/components/public-companies/CompanyLogo";
// 2026-05-27 — strategic repositioning. The prior PublicCompanyShowcase
// led with AAPL/MSFT/NVDA/TSLA/GOOGL mega-caps, implicitly pitching "this
// tool analyzes Apple." Real users are SMB / mid-market operators who
// want benchmarks against companies their size. These three sections
// replace that showcase: BridgeSection (3-step illustration) sells the
// mental model; RealPeersSection (sector grid, $50M-$5B tickers) gives
// relatable starting points; PrivateBusinessDemo shows "Acme Foods SRL +
// 3 real peers + multi-dot benchmark + insight callout" — the product's
// value in one frame. PublicCompanyShowcase function stays in the file
// for tree-shaking only; it's no longer rendered.
import { BridgeSection } from "@/components/landing/BridgeSection";
// F5.0 Phase 9 — Landing-side packaging of the CFO AI Learn layer.
// Lives between ProductPreview and HowItWorks so it lands right after
// the visitor sees the product output — the click-to-learn proof is
// fresh in their mind.
import { LearningLayerSection } from "@/components/landing/LearningLayerSection";
import { RealPeersSection } from "@/components/landing/RealPeersSection";
import { PrivateBusinessDemo } from "@/components/landing/PrivateBusinessDemo";
import {
  ArrowRight,
  BarChart3,
  CheckCircle2,
  ChevronDown,
  CircleDollarSign,
  LineChart,
  ShieldCheck,
  Globe2,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Truck,
  Upload,
  Users,
  Wallet,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { Logo } from "@/components/cfo/Logo";
// AuthCard import retired — the rev3 twin-card hero replaces the
// embedded sign-in card; users hit /signup or /signin via the header
// nav. Kept this comment so the next reader doesn't re-add it on autopilot.
import { PricingTableV2 } from "@/components/cfo/PricingTableV2";
import { ThemeToggle } from "@/components/cfo/ThemeToggle";
import { FooterSocial } from "@/components/marketing/FooterSocial";
import { EntryCard } from "@/components/landing/EntryCard";
import { ReassuranceCard } from "@/components/landing/ReassuranceCard";
import { useAuth } from "@/lib/auth";
import {
  ease,
  easeSlow,
  enterFromBelow,
  enterFromBelowSoft,
  enterScale,
  springSnappy,
  staggerChildren,
} from "@/lib/motion";

export default function Landing() {
  const { isAuthenticated } = useAuth();
  const navigate = useNavigate();

  // Already authed? Don't make them re-sign-in — bounce to the app.
  useEffect(() => {
    if (isAuthenticated) navigate("/dashboard", { replace: true });
  }, [isAuthenticated, navigate]);

  return (
    <div className="min-h-screen bg-bg text-ink selection:bg-brand/30 selection:text-ink">
      <Header />
      <Hero />
      {/* The repositioning trio — replaces the AAPL/MSFT/NVDA showcase.
          Order matters: Bridge sets the mental model (upload → pick peers
          → see context), then Real Peers shows what "your-sized" public
          companies actually look like, then the Private Business Demo
          shows the product output (Acme Foods + 3 peers + insight). */}
      <BridgeSection />
      <RealPeersSection />
      <PrivateBusinessDemo />
      <FlagshipUseCases />
      <ProductPreview />
      {/* F5.0 Phase 9 — landing-side packaging of CFO AI Learn. Sits
          immediately after the product preview so the click-to-learn
          differentiator lands while the visitor still has the dashboard
          mental model in their head. */}
      <LearningLayerSection />
      <HowItWorks />
      <UseCases />
      {/* V2 pricing — single source of truth pulled from GET /api/pricing/config
          (trial / intro / starter / pro). Wrapped in a section with id="pricing"
          so the in-page anchors in the header nav + footer still resolve. */}
      <section id="pricing" className="border-t border-rule/40">
        <PricingTableV2 />
      </section>
      <FinalCTA />
      <Footer />
    </div>
  );
}

/* ───────── Reusable techy eyebrow ──────────────────────────────────────
   UPPERCASE monospace with a small brand-teal square bullet. */

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="inline-flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.18em] text-ink-soft font-medium">
      <span className="inline-block h-[7px] w-[7px] bg-[hsl(var(--brand))]" aria-hidden />
      {children}
    </div>
  );
}

/* ───────── Header ──────────────────────────────────────────────────────── */

function Header() {
  return (
    <header
      className="
        sticky top-0 z-40
        backdrop-blur-xl
        bg-bg/70
        border-b border-rule/40
      "
    >
      <div className="mx-auto max-w-[1280px] px-5 sm:px-8 h-16 flex items-center gap-6">
        <Link to="/" className="flex items-center gap-3 shrink-0">
          <Logo size={26} compact />
          <span className="hidden sm:inline-flex font-mono text-[10.5px] uppercase tracking-[0.18em] text-ink-soft pl-3 border-l border-rule h-6 items-center">
            Financial Intelligence
          </span>
        </Link>
        <nav className="hidden md:flex items-center gap-7 ml-2 font-mono text-[11.5px] uppercase tracking-[0.14em] text-ink-soft">
          <a href="#preview" className="hover:text-ink transition-colors">Product</a>
          <a href="#use-cases" className="hover:text-ink transition-colors">Use cases</a>
          <a href="#pricing" className="hover:text-ink transition-colors">Pricing</a>
        </nav>
        <div className="flex-1" />
        <ThemeToggle compact />
        <Link
          to="/login"
          className="hidden sm:inline-flex items-center font-mono text-[11.5px] uppercase tracking-[0.14em] text-ink-soft hover:text-ink transition-colors"
        >
          Sign in
        </Link>
        <motion.div whileHover={{ y: -1, scale: 1.03 }} whileTap={{ scale: 0.97 }} transition={springSnappy}>
          <Link
            to="/signup"
            className="
              inline-flex items-center gap-1.5
              h-9 px-4 rounded-full
              bg-gradient-cfo text-white
              text-[13px] font-medium
              shadow-1 hover:shadow-2
              transition-shadow
            "
          >
            Get started — free
            <ArrowRight size={13} strokeWidth={2.25} />
          </Link>
        </motion.div>
      </div>
    </header>
  );
}

/* ───────── Hero — twin entry points ────────────────────────────────────────

   2026-05-24 rev3 per operator spec: replace the single-CTA hero with a
   pair of co-equal entry-point cards (Upload-your-data vs Public-Companies).
   Equal weight is the design contract — neither card overshadows the
   other; only the accent colour (brand-green vs info-blue) differentiates
   them. Below the cards, a row of quick-try ticker chips lets visitors
   jump straight into the public-company snapshot with no signup gate.

   The embedded AuthCard from rev2 moved out — sign-in / sign-up are still
   one click away via the Header's existing top-right buttons, and the
   twin-card layout needs the full hero width to read as balanced. */

/** Featured ticker chips on the hero quick-try strip + the showcase
 *  ticker switcher. Kept in one place so the two surfaces always agree
 *  on the recommended starter set. AAPL leads because the public-company
 *  canonical synthesis is calibrated against it. */
const FEATURED_TICKERS: ReadonlyArray<{ ticker: string; name: string }> = [
  { ticker: "AAPL",  name: "Apple" },
  { ticker: "MSFT",  name: "Microsoft" },
  { ticker: "NVDA",  name: "NVIDIA" },
  { ticker: "TSLA",  name: "Tesla" },
  { ticker: "GOOGL", name: "Alphabet" },
];

function Hero() {
  // ── 2026-05-27 rev4: single-workflow hero ────────────────────────────
  // The prior twin-card hero ("Upload your data" + "Analyze a public
  // company") presented two parallel choices with an "OR" between them.
  // That mental model was wrong — a private-business owner doesn't
  // decide between "analyze Apple" vs "analyze myself," those are
  // different mental tasks entirely.
  //
  // The real product is ONE workflow with two inputs: your private
  // books + your chosen public peers → benchmarked together. The
  // public-company side isn't a separate destination, it's the
  // comparison anchor for the user's business.
  //
  // This hero now communicates: upload → we match peers → see how you
  // compare. Single primary CTA ("Start free — no card required") that
  // is the conversion path. Tertiary "Browse the public-company
  // library" link acknowledges the explore-first audience
  // (researchers, students, advisors) without making them primary.
  //
  // Removed entirely: twin EntryCard grid, "Quick try" ticker chips
  // (FEATURED_TICKERS still exists in the file but no longer rendered
  // from the hero — kept for any future explore surface).
  const navigate = useNavigate();
  const { t } = useTranslation();

  return (
    <section
      data-testid="landing-hero-workflow"
      className="relative overflow-hidden"
    >
      {/* Ambient glow plumbing — preserved verbatim from rev2/3 so the
       *  hero retains its Apple-style light wash. */}
      <motion.div
        aria-hidden
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ ...easeSlow, duration: 1.6 }}
        className="pointer-events-none absolute -top-40 -left-32 w-[640px] h-[640px] rounded-full bg-brand/10 blur-[120px]"
      />
      <motion.div
        aria-hidden
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ ...easeSlow, duration: 1.6, delay: 0.2 }}
        className="pointer-events-none absolute -top-32 right-0 w-[520px] h-[520px] rounded-full bg-info/10 blur-[120px]"
      />
      <motion.div
        aria-hidden
        initial={{ opacity: 0 }}
        animate={{ opacity: 0.5 }}
        transition={{ duration: 2 }}
        className="pointer-events-none absolute top-[260px] left-1/2 -translate-x-1/2 w-[780px] h-[420px] rounded-full bg-[radial-gradient(ellipse_at_center,_rgba(139,92,246,0.18),_transparent_70%)] blur-[80px]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[1px] bg-gradient-to-r from-transparent via-white/10 to-transparent"
      />

      <div className="relative mx-auto max-w-[1100px] px-5 sm:px-8 pt-14 sm:pt-20 pb-14 sm:pb-20 flex flex-col items-center text-center">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...ease, delay: 0.04 }}
        >
          <Eyebrow>CFO AI · {t("landing.hero.eyebrow", "Built for private businesses")}</Eyebrow>
        </motion.div>

        {/* Defensive render: plain elements (no motion wrappers) for
            the critical above-the-fold copy + workflow card. The hero
            content MUST be visible immediately; entrance animation is
            nice-to-have, not must-have. (Prior version had motion.h1 +
            motion.div here; the dev preview's framer-motion stalled
            at opacity:0 on these specific elements while the inner
            button's springSnappy/whileHover still worked. Plain DOM
            elements avoid any animation-trigger risk; prod is safe
            either way.) */}
        <h1 className="mt-7 font-serif text-[40px] sm:text-[54px] lg:text-[64px] leading-[1.05] tracking-[-0.025em] text-ink max-w-[920px]">
          {t(
            "landing.hero.headline",
            "The first benchmark tool built for private businesses.",
          )}
        </h1>

        <p className="mt-5 text-[16px] sm:text-[17.5px] leading-relaxed text-ink-soft max-w-[680px]">
          {t(
            "landing.hero.subhead",
            "Upload your trial balance. We match you with public companies your size, in your sector. See exactly how you compare on margin, growth, leverage, and cash — with named comparisons, not vague industry averages.",
          )}
        </p>

        {/* Workflow card — single unified surface that holds the 3-step
         *  visualization, primary CTA, reassurance row, and tertiary
         *  link. One mental model: this card IS the product story. */}
        <div
          className="
            mt-12 sm:mt-14 w-full max-w-[680px]
            rounded-3xl border border-rule
            bg-surface/80 backdrop-blur-xl
            p-6 sm:p-8
            shadow-[0_24px_80px_-40px_rgba(0,0,0,0.5)]
          "
          data-testid="landing-hero-workflow-card"
        >
          {/* Workflow label */}
          <div className="text-[10.5px] uppercase tracking-[0.18em] text-ink-mute font-mono font-medium text-center mb-7">
            {t("landing.hero.workflowLabel", "The full workflow")}
          </div>

          {/* 3-step inline visualization. CSS grid with
              [step][arrow][step][arrow][step] columns; gap shrinks on
              mobile but never collapses (steps stay readable). */}
          <div className="grid grid-cols-[1fr_auto_1fr_auto_1fr] gap-1 sm:gap-3 items-start mb-8">
            <WorkflowStep
              n="1"
              icon={Upload}
              title={t("landing.hero.step1.title", "Upload your books")}
              sub={t("landing.hero.step1.sub", "Bilanț, P&L, any format · 90s")}
            />
            <WorkflowConnector />
            <WorkflowStep
              n="2"
              icon={Sparkles}
              title={t("landing.hero.step2.title", "Get peer matches")}
              sub={t("landing.hero.step2.sub", "Public companies your size in your sector")}
              accent
            />
            <WorkflowConnector />
            <WorkflowStep
              n="3"
              icon={BarChart3}
              title={t("landing.hero.step3.title", "See yourself in context")}
              sub={t("landing.hero.step3.sub", "Named peers, not vague averages")}
            />
          </div>

          {/* Primary CTA — single conversion path */}
          <motion.div
            whileHover={{ y: -1, scale: 1.01 }}
            whileTap={{ scale: 0.985 }}
            transition={springSnappy}
          >
            <button
              type="button"
              onClick={() => navigate("/signup?plan=trial")}
              data-testid="landing-hero-primary-cta"
              className="
                w-full min-h-[52px] py-3.5 px-6 rounded-full
                bg-gradient-cfo text-white font-medium text-[15px]
                shadow-1 hover:shadow-2 transition-shadow
                inline-flex items-center justify-center gap-2
              "
            >
              {t("landing.hero.primaryCta", "Start free — no card required")}
              <ArrowRight size={15} strokeWidth={2.25} />
            </button>
          </motion.div>

          {/* Reassurance row — three checks, brand-coloured dots */}
          <ul className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-[11.5px] text-ink-soft">
            <li className="inline-flex items-center gap-1.5">
              <CheckCircle2 size={11} className="text-brand" />
              {t("landing.hero.noCard", "No credit card")}
            </li>
            <li className="inline-flex items-center gap-1.5">
              <CheckCircle2 size={11} className="text-brand" />
              {t("landing.hero.fast", "90 seconds")}
            </li>
            <li className="inline-flex items-center gap-1.5">
              <CheckCircle2 size={11} className="text-brand" />
              {t("landing.hero.cancel", "Cancel anytime")}
            </li>
          </ul>

          {/* Tertiary link — for the explore-first audience that's not
              ready to upload yet. Below the dividing line so it reads
              as a secondary option, not a parallel choice. */}
          <div className="mt-6 pt-5 border-t border-rule/50 text-center">
            <p className="text-[12.5px] text-ink-mute mb-1.5">
              {t(
                "landing.hero.alreadyExploring",
                "Just exploring? Researching a public company first?",
              )}
            </p>
            <button
              type="button"
              onClick={() => navigate("/public-companies")}
              data-testid="landing-hero-browse-public"
              className="
                inline-flex items-center gap-1.5
                text-[12.5px] font-medium text-ink-soft hover:text-ink
                transition-colors
              "
            >
              {t("landing.hero.browsePublicCompanies", "Browse the public-company library")}
              <ArrowRight size={12} strokeWidth={2.25} />
            </button>
          </div>
        </div>

        {/* Disclaimer — defensive plain div, see workflow-card note above */}
        <div
          className="mt-8 flex items-center justify-center gap-2 text-[11.5px] text-ink-soft/75 max-w-md text-center"
        >
          <ShieldCheck size={12} strokeWidth={1.75} className="text-brand/70 flex-shrink-0" />
          {t(
            "landing.hero.disclaimer",
            "AI-assisted analysis. Final decisions remain with your management team.",
          )}
        </div>
      </div>

      <div className="hidden sm:flex justify-center pb-6 -mt-2 text-ink-soft/60">
        <ChevronDown size={18} strokeWidth={1.5} className="animate-pulse" />
      </div>
    </section>
  );
}

/* ───────── WorkflowStep — one tile in the hero's 3-step strip ──────────
   Each tile is a centered icon-circle (with a small ribbon-style step
   number) + bold title + a sub line that collapses to icon-only on
   very small viewports via the `hidden sm:block` on the sub. */
interface WorkflowStepProps {
  n: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  title: string;
  sub: string;
  accent?: boolean;
}

function WorkflowStep({ n, icon: Icon, title, sub, accent = false }: WorkflowStepProps) {
  return (
    <div className="text-center px-0.5 sm:px-1 min-w-0">
      <div
        className={`
          relative inline-flex items-center justify-center
          w-10 h-10 sm:w-11 sm:h-11 rounded-full mb-2.5
          ${accent ? "bg-info/15 text-info" : "bg-surface border border-rule text-ink-soft"}
        `}
      >
        <span
          className="
            absolute -top-1 -right-1
            w-4 h-4 rounded-full bg-bg
            text-[9px] font-mono font-semibold text-ink
            flex items-center justify-center
            border border-rule
          "
        >
          {n}
        </span>
        <Icon size={16} strokeWidth={2} />
      </div>
      <div className="text-[12.5px] sm:text-[13.5px] font-semibold text-ink leading-tight mb-1 break-words">
        {title}
      </div>
      <div className="text-[10.5px] sm:text-[11px] text-ink-mute leading-snug hidden sm:block">
        {sub}
      </div>
    </div>
  );
}

function WorkflowConnector() {
  return (
    <div className="flex items-center justify-center pt-4 sm:pt-4">
      <ArrowRight size={12} strokeWidth={2} className="text-ink-mute" />
    </div>
  );
}

/* ───────── Public Company Intelligence showcase ────────────────────────────

   Sits directly under the hero and exists to make the second entry-point
   feel real before anyone signs up. Operator spec: visitors see a live
   preview frame (browser-chrome window with the actual hub UI), a ticker
   switcher to swap the preview, three reassurance tiles, and a soft
   transition back to "upload your own data" so the path doesn't dead-end.

   Preview surface: ideally autoplay-muted-loop MP4s recorded against the
   real product. Until those land in `public/landing/preview-<ticker>.mp4`
   we fall back to a clean placeholder card that mirrors the hub's KPI-
   strip layout — same Apple-quality "this is what you'll get" framing. */

function PublicCompanyShowcase() {
  const navigate = useNavigate();
  const [selectedTicker, setSelectedTicker] = useState<string>("AAPL");

  return (
    <section
      id="public-company-intelligence"
      data-testid="landing-public-company-showcase"
      className="relative border-t border-rule/40"
    >
      <div className="relative mx-auto max-w-[1100px] px-5 sm:px-8 py-20 sm:py-28">
        <div className="text-center max-w-[760px] mx-auto mb-12 sm:mb-14">
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-80px" }}
            transition={ease}
          >
            <Eyebrow>Public Company Intelligence</Eyebrow>
          </motion.div>
          <motion.h2
            initial={{ opacity: 0, y: 10 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-80px" }}
            transition={{ ...easeSlow, delay: 0.06 }}
            className="mt-5 font-serif text-[34px] sm:text-[44px] lg:text-[50px] leading-[1.08] tracking-[-0.02em] text-ink"
          >
            Read 5,000+ public companies the way a CFO does.
          </motion.h2>
          <motion.p
            initial={{ opacity: 0, y: 8 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-80px" }}
            transition={{ ...ease, delay: 0.14 }}
            className="mt-4 text-[15.5px] sm:text-[17px] leading-relaxed text-ink-soft"
          >
            No upload. No signup. Pick a ticker, see the full analysis in under
            10 seconds.
          </motion.p>
        </div>

        {/* Preview frame — browser-chrome wrapper. Inside: an autoplaying
         *  MP4 when the asset exists, else a graceful KPI-strip placeholder
         *  so visitors still see a "live" hub-looking surface. */}
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-60px" }}
          transition={{ ...easeSlow, delay: 0.1 }}
          className="relative rounded-2xl overflow-hidden border border-rule bg-surface shadow-[0_24px_80px_-30px_rgba(0,0,0,0.45)]"
        >
          {/* Chrome strip */}
          <div className="flex items-center gap-3 px-4 py-2.5 border-b border-rule bg-bg-2/60 backdrop-blur">
            <div className="flex gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-red-400/45" />
              <span className="h-2.5 w-2.5 rounded-full bg-yellow-400/45" />
              <span className="h-2.5 w-2.5 rounded-full bg-green-400/45" />
            </div>
            <div className="flex-1 text-center text-[11px] text-ink-mute font-mono tabular-nums">
              cfo-ai.io / {selectedTicker} · Live preview
            </div>
            <div className="w-12" /> {/* spacer to balance the chrome dots */}
          </div>

          <PreviewSurface ticker={selectedTicker} />

          <div className="border-t border-rule bg-bg-2/40 px-4 py-3 text-center">
            <button
              type="button"
              onClick={() => navigate(`/public-companies?ticker=${selectedTicker}`)}
              data-testid={`landing-showcase-open-${selectedTicker.toLowerCase()}`}
              className="inline-flex items-center gap-1.5 text-[13px] font-medium text-info hover:text-info/80 transition-colors"
            >
              Open full {selectedTicker} analysis
              <ArrowRight size={13} strokeWidth={2.25} />
            </button>
          </div>
        </motion.div>

        {/* Ticker switcher — same FEATURED_TICKERS list as the hero chips
         *  so the showcase reinforces the muscle memory the visitor just
         *  built one section above. */}
        <div className="mt-8 flex flex-col items-center gap-3">
          <span className="text-[10.5px] uppercase tracking-[0.16em] text-ink-mute font-medium">
            Try another
          </span>
          <div className="flex flex-wrap justify-center gap-2 max-w-[640px]">
            {FEATURED_TICKERS.map((c) => {
              const isActive = c.ticker === selectedTicker;
              return (
                <button
                  key={c.ticker}
                  type="button"
                  onClick={() => setSelectedTicker(c.ticker)}
                  data-testid={`landing-showcase-pick-${c.ticker.toLowerCase()}`}
                  className={`
                    inline-flex items-center gap-2
                    h-8 px-3 rounded-full
                    text-[12.5px]
                    border transition-all
                    ${isActive
                      ? "bg-info/[0.08] border-info/40 text-ink"
                      : "bg-surface border-rule text-ink-soft hover:text-ink hover:border-rule-strong"
                    }
                  `}
                >
                  <span className="font-mono font-semibold tabular-nums">{c.ticker}</span>
                  <span className="text-ink-mute">{c.name}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Three reassurance tiles. */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4 mt-14">
          <ReassuranceCard
            stat="5,000+"
            label="Tickers covered"
            detail="All NASDAQ + NYSE-listed companies, latest 10-K and 10-Q filings."
            testid="landing-reassurance-coverage"
          />
          <ReassuranceCard
            stat="Official"
            label="SEC EDGAR data"
            detail="Direct from the regulator's XBRL feed via Nasdaq Sharadar — always current."
            testid="landing-reassurance-source"
          />
          <ReassuranceCard
            stat="Identical"
            label="Same as your data"
            detail="What you see for Apple is what you'll see for your own trial balance — same engine."
            testid="landing-reassurance-engine"
          />
        </div>

        {/* Soft transition back to the upload funnel. */}
        <div className="mt-16 text-center">
          <p className="text-[14.5px] text-ink-soft mb-3">
            Want to compare your own business?
          </p>
          <Link
            to="/signup?plan=trial"
            data-testid="landing-showcase-back-to-upload"
            className="inline-flex items-center gap-2 text-[14.5px] font-medium text-brand hover:text-brand-dark transition-colors"
          >
            Upload your trial balance
            <ArrowRight size={15} strokeWidth={2.25} />
          </Link>
        </div>
      </div>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────────
// PreviewSurface — the inside of the landing page's "Live preview" frame.
//
// 2026-05-27 rewrite. The prior version tried to render an autoplaying
// MP4 (`/landing/preview-<ticker>.mp4`) that doesn't actually exist on
// disk, so every visitor saw the bare placeholder layer behind it: a
// label-on-top-of-value KPI strip plus a half-empty "Snapshot · trend
// · peer benchmark" stub with no actual chart. Read as a broken table.
//
// New design — three layered surfaces that genuinely sell the product:
//   1. Company header (logo + name + sector chip)
//   2. Three KPI cards with deltas (revenue TTM, EBITDA TTM, P/E)
//   3. Sparkline of revenue trend (12 normalized bars; CSS-only, no chart lib)
//   4. Peer benchmark bars (4 tickers, the active one highlighted)
//   5. Open-full CTA
//
// All data hardcoded. We do NOT fetch from the backend on the marketing
// surface — the LCP hit would punish landing-page conversion. Strings
// stay in English here matching the rest of Landing.tsx; i18n sweep
// for Landing is its own ticket (already pending: I18n batch 2).
// ──────────────────────────────────────────────────────────────────────

interface CompanyData {
  ticker: string;
  name: string;
  sector: string;
  revenue: { value: string; delta: string };
  ebitda: { value: string; delta: string };
  pe: string;
  /** 12 quarter values normalized 0-1 for the sparkline. Last bar = latest. */
  trend: number[];
  /** Peer comparison rows. First entry should match the company itself. */
  peers: Array<{ ticker: string; ebitdaMargin: number }>;
}

const PREVIEW_COMPANIES: Record<string, CompanyData> = {
  AAPL: {
    ticker: "AAPL", name: "Apple Inc.", sector: "Consumer Electronics",
    revenue: { value: "$391.0B", delta: "+2.0%" },
    ebitda:  { value: "$131.8B", delta: "+3.2%" },
    pe: "31.5×",
    trend: [0.55, 0.58, 0.62, 0.61, 0.65, 0.68, 0.71, 0.72, 0.75, 0.78, 0.82, 0.85],
    peers: [
      { ticker: "AAPL",  ebitdaMargin: 33.7 },
      { ticker: "MSFT",  ebitdaMargin: 36.1 },
      { ticker: "GOOGL", ebitdaMargin: 32.8 },
      { ticker: "META",  ebitdaMargin: 52.0 },
    ],
  },
  MSFT: {
    ticker: "MSFT", name: "Microsoft Corp.", sector: "Software · Cloud",
    revenue: { value: "$245.1B", delta: "+11.2%" },
    ebitda:  { value: "$133.6B", delta: "+14.5%" },
    pe: "37.8×",
    trend: [0.42, 0.48, 0.51, 0.55, 0.58, 0.62, 0.68, 0.71, 0.75, 0.80, 0.85, 0.90],
    peers: [
      { ticker: "MSFT",  ebitdaMargin: 48.1 },
      { ticker: "ORCL",  ebitdaMargin: 41.2 },
      { ticker: "AAPL",  ebitdaMargin: 33.7 },
      { ticker: "GOOGL", ebitdaMargin: 32.8 },
    ],
  },
  NVDA: {
    ticker: "NVDA", name: "NVIDIA Corp.", sector: "Semiconductors · AI",
    revenue: { value: "$130.5B", delta: "+125.9%" },
    ebitda:  { value: " $84.5B", delta: "+248.3%" },
    pe: "65.2×",
    trend: [0.18, 0.20, 0.24, 0.28, 0.35, 0.45, 0.55, 0.68, 0.78, 0.85, 0.92, 0.98],
    peers: [
      { ticker: "NVDA", ebitdaMargin: 55.7 },
      { ticker: "TSM",  ebitdaMargin: 41.5 },
      { ticker: "AMD",  ebitdaMargin: 14.2 },
      { ticker: "INTC", ebitdaMargin: 11.8 },
    ],
  },
  TSLA: {
    ticker: "TSLA", name: "Tesla Inc.", sector: "Auto · Energy",
    revenue: { value: " $97.7B", delta: "+18.8%" },
    ebitda:  { value: " $14.7B", delta: "-12.4%" },
    pe: "85.4×",
    trend: [0.45, 0.52, 0.58, 0.64, 0.68, 0.72, 0.75, 0.78, 0.74, 0.71, 0.68, 0.70],
    peers: [
      { ticker: "TSLA", ebitdaMargin: 13.6 },
      { ticker: "TM",   ebitdaMargin: 14.7 },
      { ticker: "GM",   ebitdaMargin: 10.2 },
      { ticker: "F",    ebitdaMargin:  7.8 },
    ],
  },
  GOOGL: {
    ticker: "GOOGL", name: "Alphabet Inc.", sector: "Internet · Cloud",
    revenue: { value: "$350.0B", delta: "+8.7%" },
    ebitda:  { value: "$131.0B", delta: "+22.1%" },
    pe: "23.6×",
    trend: [0.50, 0.54, 0.58, 0.61, 0.64, 0.68, 0.71, 0.74, 0.78, 0.82, 0.85, 0.88],
    peers: [
      { ticker: "GOOGL", ebitdaMargin: 32.8 },
      { ticker: "META",  ebitdaMargin: 52.0 },
      { ticker: "AAPL",  ebitdaMargin: 33.7 },
      { ticker: "AMZN",  ebitdaMargin: 18.4 },
    ],
  },
};


function PreviewSurface({ ticker }: { ticker: string }) {
  const company = PREVIEW_COMPANIES[ticker] ?? PREVIEW_COMPANIES.AAPL;
  const peerMax = Math.max(...company.peers.map((p) => p.ebitdaMargin));

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={ticker}
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
        className="bg-bg p-5 sm:p-7 space-y-5 sm:space-y-6"
      >
        {/* Company header — logo, ticker, name, sector, SAMPLE pill */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <CompanyLogo ticker={company.ticker} size={40} className="shrink-0" />
            <div className="min-w-0">
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="font-mono font-semibold text-[15px] text-ink tabular-nums">
                  {company.ticker}
                </span>
                <span className="text-[15px] font-medium text-ink truncate">
                  {company.name}
                </span>
              </div>
              <div className="text-[11.5px] text-ink-soft mt-0.5">
                {company.sector} · NASDAQ
              </div>
            </div>
          </div>
          <span className="
            text-[9.5px] uppercase tracking-[0.14em] font-semibold
            px-2 py-1 rounded-full shrink-0
            bg-info/[0.10] text-info border border-info/20
          ">
            Sample preview
          </span>
        </div>

        {/* KPI cards — three, side-by-side even on mobile (375px-tested). */}
        <div className="grid grid-cols-3 gap-2 sm:gap-3">
          <PreviewKpi
            label="Revenue (TTM)"
            value={company.revenue.value}
            delta={company.revenue.delta}
          />
          <PreviewKpi
            label="EBITDA (TTM)"
            value={company.ebitda.value}
            delta={company.ebitda.delta}
          />
          <PreviewKpi
            label="P / E ratio"
            value={company.pe}
          />
        </div>

        {/* Mini revenue trend — 12 CSS bars, staggered grow-in animation.
            Intentionally NOT recharts: 12 divs are smaller + faster + look
            identical at this size. Save the JS budget. */}
        <div>
          <div className="flex items-center gap-1.5 mb-2.5">
            <TrendingUp size={12} strokeWidth={2.25} className="text-ink-mute" />
            <span className="text-[10px] uppercase tracking-[0.12em] text-ink-mute font-semibold">
              Revenue trend · last 12 quarters
            </span>
          </div>
          <div className="flex items-end gap-1 h-10 sm:h-12" aria-hidden>
            {company.trend.map((v, i) => (
              <motion.div
                key={i}
                initial={{ height: 0 }}
                animate={{ height: `${Math.max(v * 100, 4)}%` }}
                transition={{
                  delay: i * 0.035,
                  duration: 0.45,
                  ease: [0.16, 1, 0.3, 1],
                }}
                className={`
                  flex-1 rounded-sm
                  ${i === company.trend.length - 1 ? "bg-info" : "bg-info/35"}
                `}
              />
            ))}
          </div>
        </div>

        {/* Peer benchmark — 4 horizontal bars, active company highlighted */}
        <div>
          <div className="flex items-center gap-1.5 mb-2.5">
            <BarChart3 size={12} strokeWidth={2.25} className="text-ink-mute" />
            <span className="text-[10px] uppercase tracking-[0.12em] text-ink-mute font-semibold">
              Peer benchmark · EBITDA margin
            </span>
          </div>
          <div className="space-y-1.5">
            {company.peers.map((peer) => (
              <PreviewPeerBar
                key={peer.ticker}
                ticker={peer.ticker}
                value={peer.ebitdaMargin}
                max={peerMax}
                highlight={peer.ticker === company.ticker}
              />
            ))}
          </div>
        </div>

        {/* Footer note — the reassurance that this is REAL data the user
            will get on their own. Quiet typography; not a billboard. */}
        <p className="text-[11.5px] text-ink-mute text-center leading-relaxed pt-2 border-t border-rule/40">
          Snapshot · 12-quarter trend · peer benchmark — all live in the
          full hub. <span className="text-info font-medium">No sign-in required.</span>
        </p>
      </motion.div>
    </AnimatePresence>
  );
}

// KPI card with optional delta. Delta is sign-derived (+/-) — green for
// positive, red for negative. Tight padding so 3 fit at 375px viewport.
function PreviewKpi({ label, value, delta }: { label: string; value: string; delta?: string }) {
  const positive = delta?.trim().startsWith("+");
  const negative = delta?.trim().startsWith("-");
  return (
    <div className="
      rounded-xl border border-rule/60 bg-surface/60
      px-3 py-3 sm:px-4 sm:py-3.5
      transition-colors hover:border-rule
    ">
      <div className="text-[9.5px] uppercase tracking-[0.1em] text-ink-mute font-semibold leading-tight">
        {label}
      </div>
      <div className="font-serif text-[17px] sm:text-[20px] text-ink leading-none tabular-nums mt-2 sm:mt-2.5">
        {value}
      </div>
      {delta && (
        <div className={`
          text-[10.5px] font-medium mt-1.5 inline-flex items-center gap-0.5 tabular-nums
          ${positive ? "text-success" : negative ? "text-alert" : "text-ink-mute"}
        `}>
          {positive && <TrendingUp size={9} strokeWidth={2.5} />}
          {negative && <TrendingDown size={9} strokeWidth={2.5} />}
          {delta.replace(/^[+-]/, "")}
        </div>
      )}
    </div>
  );
}

// Single peer-comparison bar. The active company's ticker gets the
// brand colour; peers get a muted tone. Bar width is proportional to
// peerMax, NOT to 100%, so even the lowest peer reads as a real bar
// (otherwise META at 52% would make AAPL at 33% look tiny).
function PreviewPeerBar({
  ticker,
  value,
  max,
  highlight,
}: {
  ticker: string;
  value: number;
  max: number;
  highlight: boolean;
}) {
  const widthPct = Math.min((value / max) * 100, 100);
  return (
    <div className="flex items-center gap-2.5">
      <span className={`
        font-mono text-[11px] font-semibold w-12 flex-shrink-0 tabular-nums
        ${highlight ? "text-info" : "text-ink-soft"}
      `}>
        {ticker}
      </span>
      <div className="flex-1 h-5 sm:h-6 rounded bg-bg-2/60 relative overflow-hidden">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${widthPct}%` }}
          transition={{ duration: 0.65, ease: [0.16, 1, 0.3, 1] }}
          className={`
            h-full rounded
            ${highlight ? "bg-info" : "bg-ink-mute/30"}
          `}
        />
        <span className={`
          absolute top-1/2 -translate-y-1/2 right-2
          text-[10.5px] font-medium tabular-nums
          ${highlight ? "text-info" : "text-ink-soft"}
        `}>
          {value.toFixed(1)}%
        </span>
      </div>
    </div>
  );
}

/* ───────── Flagship Use Cases — 3 product pillars ──────────────────────── */

function FlagshipUseCases() {
  const cards = [
    {
      icon: LineChart,
      title: "Financial Statement Intelligence",
      tagline: "Trial balance → board-ready report",
      body: "Ministry-of-Finance filings, accountant exports, annual reports — from any European country. Auto-detected, normalized, ratioed, valued, and explained.",
      href: "/dashboard",
      cta: "Open module",
      live: true,
    },
    {
      icon: Wallet,
      title: "Inventory Intelligence",
      tagline: "Cash trapped → recovered",
      body: "Stock days, working capital, SKU bucketing. Tells your team what to protect, fix, reduce, liquidate, or scale.",
      href: "/dashboard",
      cta: "Open module",
      live: true,
    },
    {
      icon: Upload,
      title: "Invoice Intelligence",
      tagline: "ERP exports → cash forecast",
      body: "Customer & supplier concentration, margin by client, VAT reconciliation, payment timing — built into Financial Statements as dedicated tabs.",
      href: "/dashboard?tab=customers",
      cta: "Open module",
      live: true,
    },
    // NASDAQ-7 — public-company analysis surfaced on the public landing page
    // so prospects see the dual-path positioning ("upload your books OR analyse
    // any Nasdaq-listed company") before they sign up.
    {
      icon: Globe2,
      title: "Public Company Intelligence",
      tagline: "Nasdaq tickers → board-ready analysis",
      body: "Search any of 16,000+ US-listed companies on Sharadar. Same dashboard, ratios, valuation, and CFO chat as your private books. Add as a benchmark peer next to your own.",
      href: "/dashboard/public/search",
      cta: "Search Nasdaq",
      live: true,
    },
  ];

  return (
    <section className="relative">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[1px] bg-gradient-to-r from-transparent via-white/10 to-transparent"
      />
      <div className="mx-auto max-w-[1280px] px-5 sm:px-8 py-16 sm:py-20">
        <motion.div
          initial="initial"
          whileInView="animate"
          viewport={{ once: true, margin: "-80px" }}
          variants={enterFromBelow}
          transition={easeSlow}
          className="text-center max-w-[680px] mx-auto mb-10"
        >
          <Eyebrow>Four flagship modules</Eyebrow>
          <h2 className="mt-4 font-serif text-[32px] sm:text-[44px] leading-[1.05] tracking-[-0.02em]">
            One platform. <span className="text-gradient-cfo">Your books, or any public company.</span>
          </h2>
        </motion.div>
        <motion.div
          initial="initial"
          whileInView="animate"
          viewport={{ once: true, margin: "-80px" }}
          variants={staggerChildren}
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4"
        >
          {cards.map(({ icon: Icon, title, tagline, body, href, cta, live }) => (
            <motion.div
              key={title}
              variants={enterFromBelowSoft}
              transition={ease}
              whileHover={{ y: -4 }}
            >
              <Link
                to={href}
                className="group rounded-2xl border border-rule bg-bg-2/30 hover:border-brand/40 hover:bg-bg-2/50 p-6 transition-colors flex flex-col h-full"
              >
                <div className="flex items-start gap-3 mb-4">
                  <div className="h-11 w-11 rounded-xl bg-brand/10 text-brand flex items-center justify-center shrink-0">
                    <Icon size={20} strokeWidth={1.75} />
                  </div>
                  {live ? (
                    <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] font-medium text-emerald-800 bg-emerald-100 dark:text-emerald-300 dark:bg-emerald-900/30 px-2 py-0.5 rounded-full">
                      <Sparkles size={10} strokeWidth={2} /> Live
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] font-medium text-ink-mute bg-bg-2 px-2 py-0.5 rounded-full">
                      Soon
                    </span>
                  )}
                </div>
                <div className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-ink-mute font-medium mb-1.5">
                  {tagline}
                </div>
                <h3 className="font-serif text-[20px] text-ink leading-tight">{title}</h3>
                <p className="mt-2 text-[13.5px] text-ink-soft leading-relaxed flex-1">{body}</p>
                <div className="mt-4 inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.14em] font-medium text-brand-d group-hover:text-brand transition-colors">
                  {cta}
                  <ArrowRight size={13} strokeWidth={2} />
                </div>
              </Link>
            </motion.div>
          ))}
        </motion.div>

        <motion.div
          initial="initial"
          whileInView="animate"
          viewport={{ once: true, margin: "-80px" }}
          variants={staggerChildren}
          className="mt-10 grid grid-cols-2 sm:grid-cols-4 gap-4 text-center"
        >
          {[
            ["100+", "Financial ratios"],
            ["EBITDA×", "Multiple-based valuation"],
            ["Altman Z", "Bankruptcy screen"],
            ["8-sheet", "Excel model export"],
          ].map(([n, l]) => (
            <motion.div
              key={l}
              variants={enterFromBelowSoft}
              transition={ease}
              whileHover={{ y: -3, scale: 1.02 }}
              className="rounded-xl border border-rule bg-bg-2/20 p-4"
            >
              <div className="num-hero text-[32px] text-gradient-cfo leading-none">{n}</div>
              <div className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-ink-soft mt-3">{l}</div>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}

/* ───────── Product Preview ─────────────────────────────────────────────── */

function ProductPreview() {
  return (
    <section id="preview" className="relative">
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 h-[1px] bg-gradient-to-r from-transparent via-white/10 to-transparent"
      />
      <div className="mx-auto max-w-[1280px] px-5 sm:px-8 py-16 sm:py-24">
        <motion.div
          initial="initial"
          whileInView="animate"
          viewport={{ once: true, margin: "-80px" }}
          variants={enterFromBelow}
          transition={easeSlow}
          className="text-center max-w-[680px] mx-auto"
        >
          <Eyebrow>What CFO AI sees</Eyebrow>
          <h2 className="mt-4 font-serif text-[32px] sm:text-[44px] leading-[1.05] tracking-[-0.02em]">
            Every morning, your CFO briefing — <span className="text-gradient-cfo">already written.</span>
          </h2>
          <p className="mt-4 text-[15px] text-ink-soft leading-relaxed">
            Real margin, capital trapped, urgent actions. Across categories,
            customers, suppliers, and channels. Computed on your data, with the
            reasoning shown.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 40, rotateX: 4 }}
          whileInView={{ opacity: 1, y: 0, rotateX: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ ...easeSlow, duration: 0.9 }}
          style={{ perspective: 1200 }}
          className="mt-12 rounded-3xl border border-rule bg-surface shadow-[0_60px_120px_-30px_rgba(0,0,0,0.6)] overflow-hidden"
        >
          <div className="px-5 py-3 border-b border-rule/40 flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-bg-2/90" />
            <span className="h-2.5 w-2.5 rounded-full bg-bg-2/90" />
            <span className="h-2.5 w-2.5 rounded-full bg-bg-2/90" />
            <div className="ml-3 font-mono text-[10.5px] uppercase tracking-[0.16em] text-ink-soft/70">
              cfo-ai · today's briefing · 06:14
            </div>
          </div>

          <div className="p-6 sm:p-8 grid lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 grid sm:grid-cols-2 gap-4">
              <Stat label="Cash trapped"      value="11.2" unit="M RON"   trend="down" delta="−0.8M vs Apr"        Icon={Wallet}            accent="#3BA7FF" />
              <Stat label="Recoverable cash"  value="2.4"  unit="M RON"   trend="up"   delta="liquidate + reduce" Icon={CircleDollarSign}  accent="#2ED3C6" />
              <Stat label="Urgent decisions"  value="12"   unit=""        trend="flat" delta="3 critical"          Icon={Zap}               accent="#D6A84F" />
              <Stat label="ROIC"              value="17.7" unit="%"       trend="up"   delta="+2.1pp YoY"          Icon={LineChart}         accent="#2ED3C6" />
            </div>

            <div className="rounded-2xl border border-rule bg-bg-2/40 p-5">
              <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.16em] text-brand">
                <Sparkles size={12} strokeWidth={2} />
                AI CFO Briefing
              </div>
              <p className="mt-3 text-[14px] text-ink leading-relaxed">
                Your anchor products remain healthy, but long-tail SKUs are
                tying up capital. The system recommends{" "}
                <span className="text-brand">liquidations</span>,{" "}
                <span className="text-info">supplier renegotiations</span>,
                and{" "}
                <span className="text-accent2">reorder reductions</span> today.
              </p>
              <ul className="mt-4 space-y-2 text-[12.5px] text-ink-soft">
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={13} className="mt-0.5 text-brand shrink-0" strokeWidth={2} />
                  Liquidate Specialty Imports (−92% real margin, 6k EUR trapped)
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={13} className="mt-0.5 text-info shrink-0" strokeWidth={2} />
                  Renegotiate Core Range supplier — 4pp margin upside
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={13} className="mt-0.5 text-accent2 shrink-0" strokeWidth={2} />
                  Cut Pantry Essentials reorder by 25% → release ~120k
                </li>
              </ul>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}

function Stat({
  label, value, unit, trend, delta, Icon, accent,
}: {
  label: string;
  value: string;
  unit: string;
  trend: "up" | "down" | "flat";
  delta: string;
  Icon: LucideIcon;
  accent: string;
}) {
  const TrendIcon = trend === "up" ? TrendingUp : trend === "down" ? TrendingDown : null;
  return (
    <motion.div
      whileHover={{ y: -3, scale: 1.015 }}
      transition={springSnappy}
      className="relative rounded-2xl border border-rule bg-bg-2/40 p-5 overflow-hidden group"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -top-12 -right-12 w-32 h-32 rounded-full opacity-0 group-hover:opacity-30 transition-opacity duration-500 blur-2xl"
        style={{ backgroundColor: accent }}
      />
      <div className="relative flex items-center justify-between">
        <div className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-ink-soft">{label}</div>
        <Icon size={14} strokeWidth={1.75} className="text-ink-soft/80" />
      </div>
      <div className="relative mt-3 flex items-baseline gap-1.5">
        <div className="num-hero text-[44px] leading-none" style={{ color: accent }}>
          {value}
        </div>
        {unit && <div className="text-[12.5px] text-ink-soft">{unit}</div>}
      </div>
      <div className="relative mt-2 flex items-center gap-1.5 text-[11.5px] text-ink-soft">
        {TrendIcon && <TrendIcon size={11} strokeWidth={2} />}
        {delta}
      </div>
    </motion.div>
  );
}

/* ───────── How It Works ────────────────────────────────────────────────── */

function HowItWorks() {
  const steps = [
    { n: "01", title: "Upload your data",                  body: "Excel, CSV, ERP export, or live connector. We map columns automatically.",                       Icon: Upload },
    { n: "02", title: "CFO AI calculates real economics",  body: "Real margin, DIO, CCC, ROIC, GMROII, capital trapped — every SKU, every category.",              Icon: LineChart },
    { n: "03", title: "Your team acts",                    body: "Protect, fix, reduce, liquidate, or scale. With reasoning for every recommendation.",            Icon: CheckCircle2 },
  ];
  return (
    <section className="border-t border-rule/40">
      <div className="mx-auto max-w-[1280px] px-5 sm:px-8 py-16 sm:py-24">
        <motion.div
          initial="initial"
          whileInView="animate"
          viewport={{ once: true, margin: "-80px" }}
          variants={enterFromBelow}
          transition={easeSlow}
        >
          <Eyebrow>How it works</Eyebrow>
          <h2 className="mt-4 font-serif text-[32px] sm:text-[44px] leading-[1.05] tracking-[-0.02em] max-w-[680px]">
            Three steps from spreadsheet to <span className="text-gradient-cfo">action plan.</span>
          </h2>
        </motion.div>
        <motion.div
          initial="initial"
          whileInView="animate"
          viewport={{ once: true, margin: "-80px" }}
          variants={staggerChildren}
          className="mt-12 grid md:grid-cols-3 gap-6"
        >
          {steps.map(({ n, title, body, Icon }) => (
            <motion.div
              key={n}
              variants={enterFromBelowSoft}
              transition={ease}
              whileHover={{ y: -4, scale: 1.01 }}
              className="rounded-2xl border border-rule bg-bg-2/40 p-7 hover:border-rule-strong/80 transition-colors"
            >
              <div className="flex items-center justify-between">
                <div className="num-hero text-[28px] text-gradient-cfo leading-none">{n}</div>
                <Icon size={16} strokeWidth={1.75} className="text-ink-soft" />
              </div>
              <h3 className="mt-5 font-serif text-[20px] leading-[1.2] tracking-[-0.01em]">{title}</h3>
              <p className="mt-2 text-[13.5px] text-ink-soft leading-relaxed">{body}</p>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}

/* ───────── Use Cases ───────────────────────────────────────────────────── */

function UseCases() {
  const cards = [
    { role: "CFO",         body: "See where capital is trapped, what's eroding margin, and what to do this week.",   Icon: Wallet },
    { role: "CEO",         body: "One executive briefing per day with the moves that matter most.",                  Icon: LineChart },
    { role: "Procurement", body: "Reorder smarter — never pile on slow-movers, always restock the scale candidates.", Icon: Truck },
    { role: "Commercial",  body: "Spot price-action SKUs and customers running below the portfolio average.",         Icon: TrendingUp },
    { role: "Operations",  body: "Drive DIO down without breaking service. Track recoverable cash week over week.",   Icon: Users },
  ];
  return (
    <section id="use-cases" className="border-t border-rule/40">
      <div className="mx-auto max-w-[1280px] px-5 sm:px-8 py-16 sm:py-24">
        <motion.div
          initial="initial"
          whileInView="animate"
          viewport={{ once: true, margin: "-80px" }}
          variants={enterFromBelow}
          transition={easeSlow}
        >
          <Eyebrow>Built for the team that decides</Eyebrow>
          <h2 className="mt-4 font-serif text-[32px] sm:text-[44px] leading-[1.05] tracking-[-0.02em] max-w-[680px]">
            One product, <span className="text-gradient-cfo">five seats</span> at the table.
          </h2>
        </motion.div>
        <motion.div
          initial="initial"
          whileInView="animate"
          viewport={{ once: true, margin: "-80px" }}
          variants={staggerChildren}
          className="mt-12 grid sm:grid-cols-2 lg:grid-cols-3 gap-5"
        >
          {cards.map(({ role, body, Icon }) => (
            <motion.div
              key={role}
              variants={enterFromBelowSoft}
              transition={ease}
              whileHover={{ y: -3, scale: 1.01 }}
              className="rounded-2xl border border-rule bg-bg-2/40 p-6 hover:border-rule-strong/80 transition-colors"
            >
              <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.16em] text-ink-soft">
                <Icon size={14} strokeWidth={1.75} className="text-brand" />
                {role}
              </div>
              <p className="mt-3 text-[14px] text-ink leading-relaxed">{body}</p>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}

/* ───────── Final CTA ───────────────────────────────────────────────────── */

function FinalCTA() {
  return (
    <section className="relative border-t border-rule/40">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,_rgba(46,211,198,0.08),_transparent_60%)]"
      />
      <motion.div
        initial="initial"
        whileInView="animate"
        viewport={{ once: true, margin: "-80px" }}
        variants={enterFromBelow}
        transition={easeSlow}
        className="relative mx-auto max-w-[1280px] px-5 sm:px-8 py-20 sm:py-28 text-center"
      >
        <h2 className="font-serif text-[40px] sm:text-[64px] leading-[1.02] tracking-[-0.03em] max-w-[820px] mx-auto">
          Inventory is not storage. It is <span className="text-gradient-cfo">deployed capital</span>.
        </h2>
        <p className="mt-5 text-[15px] text-ink-soft max-w-[560px] mx-auto">
          Spin up CFO AI on your data in under five minutes. No credit card.
        </p>
        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <motion.div whileHover={{ y: -2, scale: 1.04 }} whileTap={{ scale: 0.96 }} transition={springSnappy}>
            <Link
              to="/signup"
              className="
                inline-flex items-center gap-2
                h-12 px-6 rounded-full
                bg-gradient-cfo text-white
                text-[14px] font-medium
                shadow-2 hover:shadow-3
                transition-shadow
              "
            >
              Get started — free
              <ArrowRight size={14} strokeWidth={2.25} />
            </Link>
          </motion.div>
          <motion.div whileHover={{ y: -2 }} whileTap={{ scale: 0.98 }} transition={springSnappy}>
            <Link
              to="/login"
              className="
                inline-flex items-center
                h-12 px-5 rounded-full
                border border-rule hover:border-rule-strong
                text-[14px] text-ink/90 hover:text-ink
                transition-colors
              "
            >
              Sign in
            </Link>
          </motion.div>
        </div>

        {/* Watch-the-demo escape hatch — rendered only when the demo video
            URL is configured. Visitors who aren't ready to sign up but want
            to evaluate the product first end here. */}
        <DemoVideoLine />

        {/* Building-in-public follow row — three platforms only (LinkedIn,
            X, YouTube — the channels where the B2B audience lives). The
            top-of-funnel ones (Instagram, TikTok) stay in the footer.
            Renders only if at least one of the three env vars is set. */}
        <BuildingInPublic />
      </motion.div>
    </section>
  );
}

function DemoVideoLine() {
  const url = import.meta.env.VITE_DEMO_VIDEO_URL as string | undefined;
  if (!url) return null;
  return (
    <p className="mt-6 text-[13.5px] text-ink-soft/80">
      Or — if you'd rather watch first:{" "}
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-ink hover:opacity-80 underline underline-offset-4 decoration-rule"
      >
        Watch the 60-second demo →
      </a>
    </p>
  );
}

function BuildingInPublic() {
  const linkedin = import.meta.env.VITE_SOCIAL_LINKEDIN as string | undefined;
  const x        = import.meta.env.VITE_SOCIAL_X as string | undefined;
  const youtube  = import.meta.env.VITE_SOCIAL_YOUTUBE as string | undefined;
  const links = [
    linkedin && { label: "LinkedIn", href: linkedin },
    x        && { label: "X",        href: x },
    youtube  && { label: "YouTube",  href: youtube },
  ].filter(Boolean) as { label: string; href: string }[];
  if (links.length === 0) return null;
  return (
    <div className="mt-12 pt-8 border-t border-rule/40 max-w-[420px] mx-auto">
      <p className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-ink-mute mb-3">
        Building in public
      </p>
      <div className="flex items-center justify-center gap-3 text-[14px] text-ink-soft">
        {links.map(({ label, href }, i) => (
          <span key={label} className="inline-flex items-center gap-3">
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-ink hover:text-brand transition-colors"
            >
              {label}
            </a>
            {i < links.length - 1 && <span aria-hidden className="text-ink-mute">·</span>}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ───────── Footer ──────────────────────────────────────────────────────── */

function Footer() {
  return (
    <footer className="border-t border-rule/40">
      <div className="mx-auto max-w-[1280px] px-5 sm:px-8 py-10">
        {/* Top row — content nav, unchanged. */}
        <div className="flex flex-wrap items-center justify-between gap-4 text-[12px] text-ink-soft/80">
          <div className="flex items-center gap-3">
            <Logo size={20} compact />
            <span>© {new Date().getFullYear()} CFO AI</span>
            <span className="text-ink-soft/40">·</span>
            <span>Inventory Intelligence</span>
          </div>
          <div className="flex items-center gap-5 font-mono text-[10.5px] uppercase tracking-[0.16em]">
            <a href="#preview" className="hover:text-ink transition-colors">Product</a>
            <a href="#use-cases" className="hover:text-ink transition-colors">Use cases</a>
            <a href="#pricing" className="hover:text-ink transition-colors">Pricing</a>
            <Link to="/login" className="hover:text-ink transition-colors">Sign in</Link>
          </div>
        </div>

        {/* Bottom row — social icons. Renders only when at least one social
            URL is configured in env (hard rule: never ship dead links). */}
        <FooterSocialRow />
      </div>
    </footer>
  );
}

function FooterSocialRow() {
  // Read once on first paint to know whether to render the row at all.
  const anyConfigured =
    !!import.meta.env.VITE_SOCIAL_LINKEDIN ||
    !!import.meta.env.VITE_SOCIAL_X ||
    !!import.meta.env.VITE_SOCIAL_YOUTUBE ||
    !!import.meta.env.VITE_SOCIAL_INSTAGRAM ||
    !!import.meta.env.VITE_SOCIAL_TIKTOK;

  if (!anyConfigured) return null;

  return (
    <div className="mt-8 pt-6 border-t border-rule/30 flex flex-wrap items-center justify-between gap-4">
      <p className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-ink-mute">
        Stay updated
      </p>
      <FooterSocial tone="muted" />
    </div>
  );
}
