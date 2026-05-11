// CFO AI — public landing page.
//
// Premium dark fintech style. Sections:
//   1. Header — logo + nav + Sign in + Get started — free
//   2. Hero (left)  + AuthCard (right, embedded — desktop only)
//   3. Product preview — AI CFO Briefing dashboard mock
//   4. How it works — 3 steps
//   5. Use cases — CFO / CEO / Procurement / Commercial / Operations
//   6. Final CTA
//   7. Footer
//
// The dark fintech tokens (#05070A bg, #2ED3C6 teal, #3BA7FF blue, #D6A84F gold)
// are scoped to this page only via inline arbitrary values so authenticated
// pages keep their warm-cream theme.

import { useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowRight,
  Building2,
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
} from "lucide-react";
import { Logo } from "@/components/cfo/Logo";
import { AuthCard } from "@/components/cfo/AuthCard";
import { PricingSection } from "@/components/cfo/PricingSection";
import { ThemeToggle } from "@/components/cfo/ThemeToggle";
import { useAuth } from "@/lib/auth";

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
      <PricingSection />
      <FinalCTA />
      <Footer />
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
          <span className="hidden sm:inline-flex text-[10.5px] uppercase tracking-[0.18em] text-ink-soft pl-3 border-l border-rule h-6 items-center">
            Financial Intelligence
          </span>
        </Link>
        <nav className="hidden md:flex items-center gap-6 ml-2 text-[13px] text-ink-soft">
          <a href="#preview" className="hover:text-ink transition-colors">Product</a>
          <a href="#use-cases" className="hover:text-ink transition-colors">Use cases</a>
          <a href="#pricing" className="hover:text-ink transition-colors">Pricing</a>
        </nav>
        <div className="flex-1" />
        <ThemeToggle compact />
        <Link
          to="/login"
          className="hidden sm:inline-flex items-center text-[13.5px] text-ink-soft hover:text-ink transition-colors"
        >
          Sign in
        </Link>
        <Link
          to="/signup"
          className="
            inline-flex items-center gap-1.5
            h-9 px-4 rounded-full
            bg-brand text-[#05070A]
            text-[13px] font-medium
            hover:bg-brand/90
            hover:shadow-[0_0_24px_-4px_rgba(46,211,198,0.45)]
            transition-all
          "
        >
          Get started — free
          <ArrowRight size={13} strokeWidth={2.25} />
        </Link>
      </div>
    </header>
  );
}

/* ───────── Hero (left) + AuthCard (right) ──────────────────────────────── */

function Hero() {
  return (
    <section className="relative overflow-hidden">
      {/* Glow accents */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 -left-32 w-[640px] h-[640px] rounded-full bg-brand/10 blur-[120px]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -top-32 right-0 w-[520px] h-[520px] rounded-full bg-info/10 blur-[120px]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[1px] bg-gradient-to-r from-transparent via-white/10 to-transparent"
      />

      <div className="relative mx-auto max-w-[1280px] px-5 sm:px-8 pt-14 sm:pt-20 pb-16 sm:pb-24 grid lg:grid-cols-[1fr_auto] gap-12 lg:gap-14 items-center">
        {/* Left column — copy + CTAs */}
        <div className="max-w-[640px]">
          {/* Mixed-case eyebrow — using `uppercase` here was breaking the
              "CFOs" abbreviation (forcing the lowercase "s" to UPPERCASE
              and then leaving a visible letter-spacing gap when we tried
              to override it). Modern fintech brands (Linear, Stripe) use
              mixed-case meta rows like this and it reads cleaner. */}
          <div className="inline-flex items-center gap-2 rounded-full border border-rule bg-bg-2/60 px-3.5 py-1.5 text-[12px] font-medium tracking-[0.02em] text-ink-soft">
            <Building2 size={11} strokeWidth={2} />
            For CFOs · Investors · Accountants · Banks · Private Equity
          </div>

          <h1 className="mt-6 font-serif text-[44px] sm:text-[58px] lg:text-[64px] leading-[0.98] tracking-[-0.02em] text-ink">
            Turn invoices and balance sheets into{" "}
            <span className="bg-gradient-to-r from-[#2ED3C6] via-[#3BA7FF] to-[#2ED3C6] bg-clip-text text-transparent">
              board-ready financial intelligence
            </span>
            .
          </h1>

          <p className="mt-6 text-[16px] sm:text-[17.5px] leading-relaxed text-ink-soft max-w-[580px]">
            Upload a{" "}
            <span className="text-ink">trial balance</span> — balanță de
            verificare, bilanț, P&L, or invoice export. CFO AI builds the
            financial model, ratios, valuations, and strategic recommendations —
            in minutes.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              to="/signup"
              className="
                inline-flex items-center gap-2
                h-12 px-5 rounded-full
                bg-brand text-[#05070A]
                text-[14px] font-medium
                hover:bg-brand/90
                hover:shadow-[0_0_32px_-6px_rgba(46,211,198,0.55)]
                transition-all
              "
            >
              Upload financial statements
              <ArrowRight size={14} strokeWidth={2.25} />
            </Link>
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
          </div>

          <div className="mt-8 flex items-center gap-2 text-[12px] text-ink-soft/80">
            <ShieldCheck size={13} strokeWidth={1.75} className="text-brand/70" />
            AI-assisted financial recommendations. Final decisions remain with your management team.
          </div>
        </div>

        {/* Right column — embedded AuthCard. Renders once per breakpoint. */}
        <div className="hidden lg:flex justify-end">
          <AuthCard subtitle="Sign in to your CFO AI workspace." />
        </div>
        <div className="lg:hidden">
          <AuthCard subtitle="Sign in to your CFO AI workspace." />
        </div>
      </div>

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
        <div className="text-center max-w-[680px] mx-auto mb-10">
          <div className="text-[11px] uppercase tracking-[0.18em] text-ink-soft">
            Three flagship modules
          </div>
          <h2 className="mt-3 font-serif text-[32px] sm:text-[40px] leading-[1.05] tracking-[-0.02em]">
            One platform. Three intelligences.
          </h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {cards.map(({ icon: Icon, title, tagline, body, href, cta, live }) => (
            <Link
              key={title}
              to={href}
              className="group rounded-2xl border border-rule bg-bg-2/30 hover:border-brand/40 hover:bg-bg-2/50 p-6 transition-colors flex flex-col"
            >
              <div className="flex items-start gap-3 mb-4">
                <div className="h-11 w-11 rounded-xl bg-brand/10 text-brand flex items-center justify-center shrink-0">
                  <Icon size={20} strokeWidth={1.75} />
                </div>
                {live ? (
                  <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.12em] font-medium text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full">
                    <Sparkles size={10} strokeWidth={2} /> Live
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.12em] font-medium text-ink-mute bg-bg-2 px-2 py-0.5 rounded-full">
                    Soon
                  </span>
                )}
              </div>
              <div className="text-[10.5px] uppercase tracking-[0.14em] text-ink-mute font-medium mb-1">
                {tagline}
              </div>
              <h3 className="font-serif text-[20px] text-ink leading-tight">{title}</h3>
              <p className="mt-2 text-[13.5px] text-ink-soft leading-relaxed flex-1">{body}</p>
              <div className="mt-4 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-brand-d group-hover:text-brand transition-colors">
                {cta}
                <ArrowRight size={13} strokeWidth={2} />
              </div>
            </Link>
          ))}
        </div>

        <div className="mt-10 grid grid-cols-2 sm:grid-cols-4 gap-4 text-center">
          {[
            ["100+", "Financial ratios"],
            ["DCF", "Intrinsic valuation"],
            ["Altman Z", "Bankruptcy screen"],
            ["8-sheet", "Excel model export"],
          ].map(([n, l]) => (
            <div key={l} className="rounded-xl border border-rule bg-bg-2/20 p-4">
              <div className="font-serif text-[22px] text-ink leading-none">{n}</div>
              <div className="text-[11.5px] text-ink-soft mt-1">{l}</div>
            </div>
          ))}
        </div>
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
        <div className="text-center max-w-[680px] mx-auto">
          <div className="text-[11px] uppercase tracking-[0.18em] text-ink-soft">
            What CFO AI sees
          </div>
          <h2 className="mt-3 font-serif text-[32px] sm:text-[40px] leading-[1.05] tracking-[-0.02em]">
            Every morning, your CFO briefing — already written.
          </h2>
          <p className="mt-4 text-[15px] text-ink-soft leading-relaxed">
            Real margin, capital trapped, urgent actions. Across categories,
            customers, suppliers, and channels. Computed on your data, with the
            reasoning shown.
          </p>
        </div>

        {/* Dashboard preview card */}
        <div className="mt-12 rounded-3xl border border-rule bg-surface shadow-[0_60px_120px_-30px_rgba(0,0,0,0.6)] overflow-hidden">
          <div className="px-5 py-3 border-b border-rule/40 flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-bg-2/90" />
            <span className="h-2.5 w-2.5 rounded-full bg-bg-2/90" />
            <span className="h-2.5 w-2.5 rounded-full bg-bg-2/90" />
            <div className="ml-3 text-[10.5px] uppercase tracking-[0.14em] text-ink-soft/70">
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
              <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-brand">
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
        </div>
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
  Icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  accent: string;
}) {
  const TrendIcon = trend === "up" ? TrendingUp : trend === "down" ? TrendingDown : null;
  return (
    <div className="rounded-2xl border border-rule bg-bg-2/40 p-5">
      <div className="flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-[0.12em] text-ink-soft">{label}</div>
        <Icon size={14} strokeWidth={1.75} className="text-ink-soft/80" />
      </div>
      <div className="mt-3 flex items-baseline gap-1.5">
        <div className="font-serif text-[34px] leading-none tracking-[-0.02em]" style={{ color: accent }}>
          {value}
        </div>
        {unit && <div className="text-[12.5px] text-ink-soft">{unit}</div>}
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-[11.5px] text-ink-soft">
        {TrendIcon && <TrendIcon size={11} strokeWidth={2} />}
        {delta}
      </div>
    </div>
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
        <div className="text-[11px] uppercase tracking-[0.18em] text-ink-soft">How it works</div>
        <h2 className="mt-3 font-serif text-[32px] sm:text-[40px] leading-[1.05] tracking-[-0.02em] max-w-[680px]">
          Three steps from spreadsheet to action plan.
        </h2>
        <div className="mt-12 grid md:grid-cols-3 gap-6">
          {steps.map(({ n, title, body, Icon }) => (
            <div key={n} className="rounded-2xl border border-rule bg-bg-2/40 p-7 hover:border-rule-strong/80 transition-colors">
              <div className="flex items-center justify-between">
                <div className="text-[12px] uppercase tracking-[0.12em] text-brand">{n}</div>
                <Icon size={16} strokeWidth={1.75} className="text-ink-soft" />
              </div>
              <h3 className="mt-5 font-serif text-[20px] leading-[1.2] tracking-[-0.01em]">{title}</h3>
              <p className="mt-2 text-[13.5px] text-ink-soft leading-relaxed">{body}</p>
            </div>
          ))}
        </div>
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
        <div className="text-[11px] uppercase tracking-[0.18em] text-ink-soft">Built for the team that decides</div>
        <h2 className="mt-3 font-serif text-[32px] sm:text-[40px] leading-[1.05] tracking-[-0.02em] max-w-[680px]">
          One product, five seats at the table.
        </h2>
        <div className="mt-12 grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {cards.map(({ role, body, Icon }) => (
            <div key={role} className="rounded-2xl border border-rule bg-bg-2/40 p-6 hover:border-rule-strong/80 transition-colors">
              <div className="flex items-center gap-2 text-[11.5px] uppercase tracking-[0.14em] text-ink-soft">
                <Icon size={14} strokeWidth={1.75} className="text-brand" />
                {role}
              </div>
              <p className="mt-3 text-[14px] text-ink leading-relaxed">{body}</p>
            </div>
          ))}
        </div>
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
      <div className="relative mx-auto max-w-[1280px] px-5 sm:px-8 py-20 sm:py-28 text-center">
        <h2 className="font-serif text-[40px] sm:text-[56px] leading-[1.02] tracking-[-0.02em] max-w-[820px] mx-auto">
          Inventory is not storage. It is{" "}
          <span className="bg-gradient-to-r from-[#2ED3C6] via-[#3BA7FF] to-[#2ED3C6] bg-clip-text text-transparent">
            deployed capital
          </span>
          .
        </h2>
        <p className="mt-5 text-[15px] text-ink-soft max-w-[560px] mx-auto">
          Spin up CFO AI on your data in under five minutes. No credit card.
        </p>
        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <Link
            to="/signup"
            className="
              inline-flex items-center gap-2
              h-12 px-6 rounded-full
              bg-brand text-[#05070A]
              text-[14px] font-medium
              hover:bg-brand/90
              hover:shadow-[0_0_32px_-6px_rgba(46,211,198,0.55)]
              transition-all
            "
          >
            Get started — free
            <ArrowRight size={14} strokeWidth={2.25} />
          </Link>
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
        </div>
      </div>
    </section>
  );
}

/* ───────── Footer ──────────────────────────────────────────────────────── */

function Footer() {
  return (
    <footer className="border-t border-rule/40">
      <div className="mx-auto max-w-[1280px] px-5 sm:px-8 py-8 flex flex-wrap items-center justify-between gap-4 text-[12px] text-ink-soft/80">
        <div className="flex items-center gap-3">
          <Logo size={20} compact />
          <span>© CFO AI</span>
          <span className="text-ink-soft/40">·</span>
          <span>Inventory Intelligence</span>
        </div>
        <div className="flex items-center gap-5">
          <a href="#preview" className="hover:text-ink transition-colors">Product</a>
          <a href="#use-cases" className="hover:text-ink transition-colors">Use cases</a>
          <Link to="/login" className="hover:text-ink transition-colors">Sign in</Link>
        </div>
      </div>
    </footer>
  );
}
