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

import { useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  CircleDollarSign,
  LineChart,
  ShieldCheck,
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
import { AuthCard } from "@/components/cfo/AuthCard";
import { PricingTableV2 } from "@/components/cfo/PricingTableV2";
import { ThemeToggle } from "@/components/cfo/ThemeToggle";
import { FooterSocial } from "@/components/marketing/FooterSocial";
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
      <FlagshipUseCases />
      <ProductPreview />
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

/* ───────── Hero (left) + AuthCard (right) ──────────────────────────────── */

function Hero() {
  return (
    <section className="relative overflow-hidden">
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

      <motion.div
        variants={staggerChildren}
        initial="initial"
        animate="animate"
        className="relative mx-auto max-w-[1280px] px-5 sm:px-8 pt-14 sm:pt-20 pb-16 sm:pb-24 grid lg:grid-cols-[1fr_auto] gap-12 lg:gap-14 items-center"
      >
        {/* Left column — copy + CTAs */}
        <div className="max-w-[640px]">
          <motion.div variants={enterFromBelowSoft} transition={ease}>
            <Eyebrow>For CFOs · Investors · Accountants · Banks · Private Equity</Eyebrow>
          </motion.div>

          <motion.h1
            variants={enterFromBelow}
            transition={easeSlow}
            className="mt-6 font-serif text-[48px] sm:text-[64px] lg:text-[76px] leading-[0.95] tracking-[-0.03em] text-ink"
          >
            Turn invoices and balance sheets into{" "}
            <span className="text-gradient-cfo">board-ready financial intelligence</span>.
          </motion.h1>

          <motion.p
            variants={enterFromBelowSoft}
            transition={ease}
            className="mt-6 text-[16px] sm:text-[17.5px] leading-relaxed text-ink-soft max-w-[580px]"
          >
            Upload a <span className="text-ink">trial balance</span>, balance
            sheet, P&L, or invoice export. CFO AI builds the financial model,
            ratios, valuations, and strategic recommendations — in minutes.
          </motion.p>

          <motion.div
            variants={enterFromBelowSoft}
            transition={ease}
            className="mt-8 flex flex-wrap items-center gap-3"
          >
            <motion.div whileHover={{ y: -2, scale: 1.02 }} whileTap={{ scale: 0.98 }} transition={springSnappy}>
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
                Upload financial statements
                <ArrowRight size={14} strokeWidth={2.25} />
              </Link>
            </motion.div>
            <motion.div whileHover={{ y: -2 }} whileTap={{ scale: 0.98 }} transition={springSnappy}>
              <Link
                to="/dashboard"
                className="
                  inline-flex items-center
                  h-12 px-5 rounded-full
                  border border-rule hover:border-rule-strong
                  text-[14px] text-ink/90 hover:text-ink
                  transition-colors
                "
              >
                See how it works
              </Link>
            </motion.div>
          </motion.div>

          <motion.div
            variants={enterFromBelowSoft}
            transition={ease}
            className="mt-8 flex items-center gap-2 text-[12px] text-ink-soft/80"
          >
            <ShieldCheck size={13} strokeWidth={1.75} className="text-brand/70" />
            AI-assisted financial recommendations. Final decisions remain with your management team.
          </motion.div>
        </div>

        {/* Right column — embedded AuthCard. */}
        <motion.div
          variants={enterScale}
          transition={easeSlow}
          className="hidden lg:flex justify-end"
        >
          <AuthCard subtitle="Sign in to your CFO AI workspace." />
        </motion.div>
        <motion.div variants={enterScale} transition={easeSlow} className="lg:hidden">
          <AuthCard subtitle="Sign in to your CFO AI workspace." />
        </motion.div>
      </motion.div>

      <div className="hidden sm:flex justify-center pb-6 -mt-4 text-ink-soft/60">
        <ChevronDown size={18} strokeWidth={1.5} className="animate-pulse" />
      </div>
    </section>
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
          <Eyebrow>Three flagship modules</Eyebrow>
          <h2 className="mt-4 font-serif text-[32px] sm:text-[44px] leading-[1.05] tracking-[-0.02em]">
            One platform. <span className="text-gradient-cfo">Three intelligences.</span>
          </h2>
        </motion.div>
        <motion.div
          initial="initial"
          whileInView="animate"
          viewport={{ once: true, margin: "-80px" }}
          variants={staggerChildren}
          className="grid grid-cols-1 md:grid-cols-3 gap-4"
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
