// CFO AI marketing website.
//
// Ported from the "CFO AI Website" design canvas: a dark, self-contained
// marketing site (home / pricing / privacy / cookies / terms / contact) plus
// a GDPR cookie-consent modal. The design's palette already matches our
// teal / greyscale / red system.
//
// Implementation notes:
//   · The large section markup is static, so it's rendered as scoped HTML
//     strings (keeping the design's exact inline styles verbatim) into a
//     `.cfo-site` wrapper. All CSS variables (--bg, --brand, …) are scoped to
//     that wrapper so this always-dark site never clobbers the app theme.
//   · Interactivity is wired via ONE delegated click handler that reads
//     `data-act` attributes — internal page switches, router navigation
//     (Sign in → /login, Get started → /signup, App → /dashboard), and the
//     cookie-consent actions.
//   · The design's `.dc.html` canvas directives (`{{ handler }}`, `sc-if`,
//     `style-hover`) are replaced with `data-act`, conditional string
//     assembly, and scoped `:hover` CSS classes respectively.

import {
  type FormEvent as ReactFormEvent,
  type MouseEvent as ReactMouseEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { pickLanguageWithProfileSync, SUPPORTED_LANGUAGES } from "@/i18n";
import { MARQUEE } from "@/lib/markets";
import { landingStringsFor, type LandingStrings } from "./landingStrings";

type Page = "home" | "pricing" | "contact" | "legal";
const VALID_PAGES: Page[] = ["home", "pricing", "contact", "legal"];

// The three legal documents live as SECTIONS of the single legal page.
// Legacy acts/hashes (privacy/cookies/terms) resolve to legal + a scroll.
type LegalDoc = "privacy" | "cookies" | "terms";
const LEGAL_DOCS: LegalDoc[] = ["privacy", "cookies", "terms"];

const CONSENT_KEY = "cfoai_consent";

// ── Scoped design system + hover rules ────────────────────────────────────
const SITE_CSS = `
.cfo-site{
  /* Scoped palette DEFINITION for the self-contained marketing site — this
     string template cannot use Tailwind classes, and the always-dark site
     must never inherit the app theme. Values mirror the marketing dark
     gradient family in index.css. (design-lint-allow-hex, whole block) */
  --bg:#080D0B; --bg-2:#0C1210; --surface:#101614; --surface-hi:#1A211E; /* design-lint-allow-hex scoped marketing palette */
  --ink:#F5F5F5; --ink-2:#DBDBDB; --ink-soft:#ABABAB; --ink-mute:#8C8C8C; /* design-lint-allow-hex scoped marketing palette */
  --rule:#252D2A; --rule-soft:#181E1C; --rule-strong:#39443F; /* design-lint-allow-hex scoped marketing palette */
  --brand:#4BBFA8; --brand-d:#37A18C; --brand-l:#6FD2BE; --brand-deep:#1E5A4E; /* design-lint-allow-hex scoped marketing palette */
  --alert:#FF6B6B; /* design-lint-allow-hex scoped marketing palette */
  --on-brand:#05110D;      /* ink on the bright gradient CTAs */ /* design-lint-allow-hex scoped marketing palette */
  --bg-deep:#070C0A;       /* hero / proof-strip deep ground */ /* design-lint-allow-hex scoped marketing palette */
  --board-hi:#BFD2CB; --board-mid:#6F8A82; --board-dim:#5C7169; /* ticker-board terminal shades */ /* design-lint-allow-hex scoped marketing palette */
  --serif:"Instrument Serif",Georgia,serif;
  --sans:"Inter Variable","Inter",system-ui,sans-serif;
  --mono:"JetBrains Mono",ui-monospace,monospace;
  --grad:linear-gradient(135deg,#1E5A4E 0%,#2C7A68 25%,#37A18C 55%,#41B09A 80%,#4BBFA8 100%); /* design-lint-allow-hex scoped marketing palette */
  --grad-text:linear-gradient(120deg,#37A18C 0%,#4BBFA8 55%,#6FD2BE 100%); /* design-lint-allow-hex scoped marketing palette */
  --maxw:1440px;
  min-height:100vh;background:var(--bg);color:var(--ink);
  font-family:var(--sans);font-size:16px;line-height:1.55;
  -webkit-font-smoothing:antialiased;font-feature-settings:"tnum" 1;
}
.cfo-site *{box-sizing:border-box}
.cfo-site--bare{min-height:0;background:transparent}
.cfo-site a{color:var(--brand);text-decoration:none;transition:color .15s ease;cursor:pointer}
.cfo-site a:hover{color:var(--brand-l)}
.cfo-site p{margin:0 0 1em}
.cfo-site h1,.cfo-site h2,.cfo-site h3,.cfo-site h4{margin:0}
.cfo-site ::selection{background:rgba(75,191,168,.28);color:var(--ink)}
.cfo-site summary::-webkit-details-marker{display:none}
.cfo-site summary::marker{content:""}
.cfo-site .grad-text{background:var(--grad-text);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent}
.cfo-site .btn-grad{transition:filter .15s ease,transform .15s ease}
.cfo-site .btn-grad:hover{filter:brightness(1.08);transform:translateY(-1px)}
.cfo-site .btn-ghost2{transition:border-color .15s ease,background .15s ease}
.cfo-site .btn-ghost2:hover{border-color:var(--ink-mute);background:var(--surface-hi)}
.cfo-site .hv-brand:hover{border-color:var(--brand);color:var(--brand)}
.cfo-site .card-hl{transition:border-color .15s ease}
.cfo-site .card-hl:hover{border-color:rgba(75,191,168,.4) !important}
.cfo-site .pricing-card{transition:transform .2s ease,box-shadow .2s ease,border-color .2s ease}
.cfo-site .pricing-card:hover{transform:translateY(-2px);border-color:rgba(75,191,168,.5) !important;box-shadow:0 20px 40px -30px rgba(75,191,168,.3)}
.cfo-site nav button:hover,.cfo-site nav a:hover{color:var(--ink)}
.cfo-site footer a,.cfo-site footer button{opacity:.7;transition:opacity .15s ease}
.cfo-site footer a:hover,.cfo-site footer button:hover{opacity:1}
.cfo-site .navbtn{background:none;border:none;cursor:pointer;font-family:var(--mono);font-size:11.5px;text-transform:uppercase;letter-spacing:.14em;color:var(--ink-soft)}
.cfo-site .navbtn.is-active{color:var(--brand);position:relative}
.cfo-site .navbtn.is-active::after{content:"";position:absolute;left:0;right:0;bottom:-6px;height:2px;background:var(--brand);border-radius:2px}
.cfo-site nav .navbtn.is-active:hover{color:var(--brand)}
.cfo-site .menu-item{display:flex;width:100%;align-items:center;padding:10px 12px;border:none;background:none;border-radius:9px;font-size:13.5px;color:var(--ink-2);cursor:pointer;font-family:inherit;text-align:left;transition:background .15s,color .15s}
.cfo-site .menu-item:hover{background:var(--surface-hi);color:var(--ink)}
.cfo-site .field{width:100%;background:var(--bg-2);border:1px solid var(--rule);border-radius:10px;padding:11px 14px;color:var(--ink);font-family:inherit;font-size:14px;outline:none;transition:border-color .15s}
.cfo-site .field:focus{border-color:var(--brand)}
.cfo-site .field::placeholder{color:var(--ink-mute)}
.cfo-site .site-header{background:rgba(8,13,11,.72);backdrop-filter:blur(18px);border-bottom:1px solid var(--rule-soft);transition:background .35s ease,backdrop-filter .35s ease,border-color .35s ease}
.cfo-site.at-top .site-header{background:rgba(8,13,11,0);backdrop-filter:blur(0px);border-bottom-color:transparent}
.cfo-site .site-header-row{height:66px;transition:height .35s ease}
.cfo-site .desktop-nav{display:flex}
.cfo-site .desktop-actions{display:flex}
.cfo-site .burger-btn{display:none;background:none;border:none;cursor:pointer;padding:6px;color:var(--ink);align-items:center;justify-content:center;border-radius:8px}
.cfo-site .burger-btn:hover{background:var(--surface-hi)}
.cfo-site .mobile-menu-panel{display:none}
/* The panel is deliberately position:absolute — a normal-flow child would
   grow .cred-pill's own box as it opens, and since only the outermost
   .site-header-row has a fixed height (not the intermediate .desktop-actions
   flex container), that growth was propagating up and visibly resizing the
   header row itself. Absolute positioning removes the panel from flow
   entirely, so .cred-pill's box (and everything above it) never changes
   size — it just LOOKS attached (zero gap, matching border/radius/color). */
.cfo-site .cred-pill{position:relative;border:1px solid var(--rule-strong);background:var(--bg-2);border-radius:999px}
.cfo-site .cred-pill-panel{position:absolute;top:calc(100% + 10px);left:-1px;right:-1px;background:var(--bg-2);border:1px solid var(--rule-strong);border-radius:14px;box-shadow:0 20px 60px -20px rgba(0,0,0,.8);opacity:0;transform:translateY(-4px);pointer-events:none;transition:opacity .2s ease,transform .2s ease;z-index:1}
.cfo-site .cred-pill.is-open .cred-pill-panel{opacity:1;transform:translateY(0);pointer-events:auto}
.cfo-site .cred-pill-arrow svg{transform:rotate(0deg)}
.cfo-site .cred-pill.is-open .cred-pill-arrow svg{transform:rotate(180deg)}
@media (max-width:760px){
  .cfo-site .desktop-nav{display:none}
  .cfo-site .desktop-actions{display:none}
  .cfo-site .burger-btn{display:inline-flex}
  .cfo-site .mobile-menu-panel{display:block}
  /* Narrow screens: the readability overlay's ellipse covers less of the
     text column, so the board itself dims further to hold AA behind the
     stacked headline. */
  .cfo-site #cfo-ticker-board{opacity:.32 !important}
}
.cfo-site.at-top .site-header-row{height:96px}
@keyframes cfo-heroBoardDrift{0%{transform:perspective(1400px) rotateX(8deg) rotateY(-6deg) scale(1.75)}50%{transform:perspective(1400px) rotateX(6deg) rotateY(-3deg) scale(1.8)}100%{transform:perspective(1400px) rotateX(8deg) rotateY(-6deg) scale(1.75)}}
/* Reduced motion: freeze the board's drift (the live row updates are
   paused in <HeroTicker> itself under the same media query). */
@media (prefers-reduced-motion:reduce){
  .cfo-site #cfo-ticker-board{animation:none}
  .cfo-site .btn-grad:hover{transform:none}
}
@keyframes cfo-sectionPulse{0%,100%{box-shadow:inset 0 0 0 0 rgba(75,191,168,0)}50%{box-shadow:inset 0 0 0 3px rgba(75,191,168,.35)}}
.cfo-site .section-pulse{animation:cfo-sectionPulse .8s ease-in-out 2}
@media (max-width:680px){
  .cfo-site .mock-grid{grid-template-columns:1fr !important}
  .cfo-site .mock-kpis{grid-template-columns:repeat(2,1fr) !important}
}
`;

// Inline SVG logo baked into the template string — presentation `fill`
// attributes can't be Tailwind classes; brand + off-white from the scoped palette.
// design-lint-allow-hex scoped marketing palette (logo mark)
const LOGO = `<svg width="26" height="26" viewBox="0 0 64 64" aria-hidden="true"><path d="M 30 4 L 4 20 L 4 44 L 30 60 L 30 50 L 14 41 L 14 23 L 30 14 Z" fill="#4BBFA8"></path><path d="M 38 14 L 60 60 L 48 60 L 38 38 Z" fill="#F4F6F8"></path><rect x="34" y="34" width="14" height="3" fill="#F4F6F8"></rect></svg>`;

function eyebrow(label: string) {
  return `<div style="display:inline-flex;align-items:center;gap:12px;font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.18em;color:var(--ink-soft);font-weight:500"><span style="width:7px;height:7px;background:var(--brand);display:inline-block"></span>${label}</div>`;
}

// Escape user-controlled strings (name / email) before splicing them into
// the innerHTML header — the rest of the markup is static and trusted.
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface HeaderAccount {
  name: string;
  email: string;
  initials: string;
}

// Localized in-page link button (used inside FAQ answers / consent body).
const inlineLink = (act: string, label: string) =>
  `<button data-act="${act}" style="background:none;border:none;padding:0;color:var(--brand);cursor:pointer;font:inherit">${label}</button>`;

function header(
  account: HeaderAccount | null,
  page: Page | null,
  L: LandingStrings,
  // true only for the home page: the header floats over the hero (out of
  // flow) so the ticker board can show through it at the top. Every other
  // usage (pricing/contact/legal, and MarketingHeader on /account/settings)
  // keeps the normal sticky, in-flow header — those pages have no hero
  // background to reveal, and their own top spacing already assumes the
  // header pushes content down like a normal sticky bar.
  overlay = false,
  mobileMenuOpen = false,
) {
  // Nav tabs — the current internal page gets the brand highlight.
  const tab = (act: Page, label: string) =>
    `<button class="navbtn${page === act ? " is-active" : ""}" data-act="${act}">${label}</button>`;
  const mobileTab = (act: Page, label: string) =>
    `<button class="menu-item" data-act="${act}" style="${page === act ? "color:var(--brand)" : ""}">${label}</button>`;

  // Signed out: Sign in + Get started. Signed in: an account chip (avatar
  // with initials, name, email underneath) that opens a dropdown with
  // Settings + Sign out.
  // The account chip IS the dropdown: one bordered container whose border
  // radius morphs from a full pill to a rounded rect and whose bottom edge
  // expands to reveal the menu buttons — no separate floating popup.
  // Always rendered CLOSED here — open/close is a classList.toggle("is-open")
  // in Landing()'s click handler (direct DOM mutation, not React state), so
  // the CSS transitions actually animate. If this were driven by a state
  // variable feeding back into this string (like it used to be), every
  // toggle would regenerate + replace the header's DOM subtree, and a
  // freshly-created element has no "previous" style to transition from —
  // the exact bug reported ("dropdown does not animate").
  const authArea = account
    ? `
    <div class="cred-pill">
      <button data-act="account" style="display:flex;width:100%;align-items:center;gap:11px;background:transparent;border:none;border-radius:inherit;overflow:hidden;padding:5px 16px 5px 6px;cursor:pointer;font-family:inherit">
        <span style="width:34px;height:34px;border-radius:50%;background:var(--grad);color:var(--on-brand);display:inline-flex;align-items:center;justify-content:center;font-size:12.5px;font-weight:700;letter-spacing:.02em;flex-shrink:0">${esc(account.initials)}</span>
        <span style="display:inline-flex;flex-direction:column;align-items:flex-start;line-height:1.3;text-align:left">
          <span style="font-size:13px;font-weight:600;color:var(--ink)">${esc(account.name)}</span>
          <span style="font-size:11px;color:var(--ink-mute)">${esc(account.email)}</span>
        </span>
        <span class="cred-pill-arrow" style="flex-shrink:0;width:16px;height:16px;display:flex;align-items:center;justify-content:center;color:var(--ink-mute);margin-left:2px">
          <svg width="10" height="7" viewBox="0 0 10 7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 1L5 5.5L9 1"></path></svg>
        </span>
      </button>
      <div class="cred-pill-panel">
        <div style="padding:6px">
          <button data-act="workspace" class="menu-item">${L.nav.workspace}</button>
          <button data-act="account:settings" class="menu-item">${L.menu.settings}</button>
          <div style="height:1px;background:var(--rule-soft);margin:6px 8px"></div>
          <button data-act="account:signout" class="menu-item" style="color:var(--alert)">${L.menu.signOut}</button>
        </div>
      </div>
    </div>`
    : `
    <button class="navbtn" data-act="signin">${L.auth.signIn}</button>
    <a href="/login?next=/&mode=sign_up" data-act="getstarted" class="btn-grad" style="display:inline-flex;align-items:center;gap:7px;height:38px;padding:0 18px;border-radius:999px;background:var(--grad);color:var(--on-brand);font-size:13px;font-weight:500;box-shadow:0 4px 16px -6px rgba(75,191,168,.5)">${L.auth.getStartedFree}</a>`;

  return `
<header class="site-header" style="position:${overlay ? "fixed" : "sticky"};top:0;left:0;right:0;z-index:50">
  <div class="site-header-row" style="max-width:var(--maxw);margin:0 auto;padding:0 24px;display:flex;align-items:center;gap:24px;flex-wrap:wrap">
    <button data-act="home" style="display:inline-flex;align-items:center;gap:11px;background:none;border:none;cursor:pointer;padding:0">
      ${LOGO}
      <span style="display:inline-flex;flex-direction:column;line-height:1"><span style="font-size:15px;font-weight:600;letter-spacing:-.01em;color:var(--ink)">CFO <span style="color:var(--brand)">AI</span></span></span>
    </button>
    <nav class="desktop-nav" style="align-items:center;gap:26px;margin-left:8px;flex-wrap:wrap">
      ${tab("home", L.nav.home)}
      ${tab("pricing", L.nav.pricing)}
      ${tab("legal", L.nav.legal)}
      ${tab("contact", L.nav.contact)}
      <button class="navbtn" data-act="workspace" style="color:var(--brand)">${L.nav.workspace}</button>
    </nav>
    <div style="flex:1"></div>
    <div class="desktop-actions" style="align-items:center;gap:24px">${authArea}
    </div>
    <button class="burger-btn" data-act="burger" aria-label="Menu">
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><line x1="2.5" y1="5" x2="17.5" y2="5"></line><line x1="2.5" y1="10" x2="17.5" y2="10"></line><line x1="2.5" y1="15" x2="17.5" y2="15"></line></svg>
    </button>
  </div>
  ${mobileMenuOpen ? `
  <div class="mobile-menu-panel" style="border-top:1px solid var(--rule-soft);padding:10px 14px 14px">
    <div style="display:flex;flex-direction:column;gap:2px">
      ${mobileTab("home", L.nav.home)}
      ${mobileTab("pricing", L.nav.pricing)}
      ${mobileTab("legal", L.nav.legal)}
      ${mobileTab("contact", L.nav.contact)}
      <button class="menu-item" data-act="workspace" style="color:var(--brand)">${L.nav.workspace}</button>
    </div>
    <div style="height:1px;background:var(--rule-soft);margin:10px 4px"></div>
    <div style="display:flex;flex-direction:column;gap:8px;padding:0 4px">
      ${account ? `
      <button class="menu-item" data-act="workspace">${L.nav.workspace}</button>
      <button class="menu-item" data-act="account:settings">${L.menu.settings}</button>
      <button class="menu-item" data-act="account:signout" style="color:var(--alert)">${L.menu.signOut}</button>` : `
      <button class="menu-item" data-act="signin">${L.auth.signIn}</button>
      <a href="/login?next=/&mode=sign_up" data-act="getstarted" class="btn-grad" style="display:flex;align-items:center;justify-content:center;height:44px;border-radius:999px;background:var(--grad);color:var(--on-brand);font-size:14px;font-weight:500">${L.auth.getStartedFree}</a>`}
    </div>
  </div>` : ""}
</header>`;
}

// Pricing cards — shared between the home page's #pricing section (footer
// anchor target) and the standalone pricing page.
const featureLi = (x: string) => `<li style="display:flex;gap:10px"><span style="color:var(--brand)">✓</span> ${x}</li>`;

type BillingCycle = "monthly" | "yearly";

// 2026-08 tier restructure: RO Solo / Pro / Multi-Country — must match
// the in-app /pricing page (backend _pricing_config.py is the source of
// truth; these are marketing-copy mirrors).
const SOLO_MONTHLY = 4.99;
const BUSINESS_MONTHLY = 9.99;

const billingToggle = (cycle: BillingCycle) => `
  <div style="display:flex;justify-content:center;margin-bottom:28px">
    <div style="display:inline-flex;padding:4px;border-radius:999px;background:var(--bg-2);border:1px solid var(--rule)">
      <button data-act="billing:monthly" style="padding:8px 20px;border-radius:999px;border:none;cursor:pointer;font-family:inherit;font-size:13px;font-weight:500;transition:background .15s,color .15s;background:${cycle === "monthly" ? "var(--surface-hi)" : "transparent"};color:${cycle === "monthly" ? "var(--ink)" : "var(--ink-soft)"}">Monthly</button>
      <button data-act="billing:yearly" style="padding:8px 20px;border-radius:999px;border:none;cursor:pointer;font-family:inherit;font-size:13px;font-weight:500;transition:background .15s,color .15s;background:${cycle === "yearly" ? "var(--surface-hi)" : "transparent"};color:${cycle === "yearly" ? "var(--ink)" : "var(--ink-soft)"}">Annual <span style="color:var(--brand)">· save ~17%</span></button>
    </div>
  </div>`;

// Annual billing intentionally NOT offered on the landing grid: checkout
// carries monthly Stripe prices only — never promise a price that cannot
// be purchased. (billingToggle kept above for a future annual launch.)
const pricingGrid = (L: LandingStrings, cycle: BillingCycle = "monthly") => `
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:18px;align-items:stretch;max-width:1320px;margin:0 auto">
    <div class="pricing-card" style="border:1px solid var(--rule);background:var(--surface);border-radius:20px;padding:30px;display:flex;flex-direction:column">
      <div style="font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.16em;color:var(--ink-soft)">${L.pricing.solo.name}</div>
      <div style="margin-top:14px;display:flex;align-items:baseline;gap:6px"><span style="font-family:var(--serif);font-size:52px;line-height:1;color:var(--ink)">€${SOLO_MONTHLY}</span><span style="font-size:14px;color:var(--ink-soft)">${L.pricing.perMonth}</span></div>
      <div style="font-size:12.5px;color:var(--ink-mute);margin-top:6px">${L.pricing.solo.yearly}</div>
      <p style="margin-top:14px;font-size:13.5px;color:var(--ink-soft)">${L.pricing.solo.blurb}</p>
      <a href="/signup?plan=solo" data-act="signup:solo" class="hv-brand" style="margin-top:22px;display:inline-flex;align-items:center;justify-content:center;height:46px;border-radius:999px;background:transparent;border:1px solid var(--rule-strong);color:var(--ink);font-weight:500;font-size:14px;transition:border-color .15s,color .15s">${L.pricing.solo.cta}</a>
      <ul style="margin:24px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:11px;font-size:13.5px;color:var(--ink-2)">
        ${L.pricing.solo.features.map(featureLi).join("")}
      </ul>
    </div>
    <div class="pricing-card" style="border:1.5px solid var(--brand);background:var(--surface);border-radius:20px;padding:30px;display:flex;flex-direction:column;position:relative;box-shadow:0 24px 60px -30px rgba(75,191,168,.5)">
      <span style="position:absolute;top:-11px;left:30px;font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.14em;font-weight:600;color:var(--on-brand);background:var(--brand);padding:4px 12px;border-radius:999px">${L.pricing.business.badge}</span>
      <div style="font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.16em;color:var(--brand)">${L.pricing.business.name}</div>
      <div style="margin-top:14px;display:flex;align-items:baseline;gap:6px"><span style="font-family:var(--serif);font-size:52px;line-height:1;color:var(--ink)">€${BUSINESS_MONTHLY}</span><span style="font-size:14px;color:var(--ink-soft)">${L.pricing.perMonth}</span></div>
      <div style="font-size:12.5px;color:var(--ink-mute);margin-top:6px">${L.pricing.business.yearly}</div>
      <p style="margin-top:14px;font-size:13.5px;color:var(--ink-soft)">${L.pricing.business.blurb}</p>
      <a href="/signup?plan=pro" data-act="signup:pro" class="btn-grad" style="margin-top:22px;display:inline-flex;align-items:center;justify-content:center;height:46px;border-radius:999px;background:var(--grad);color:var(--on-brand);font-weight:500;font-size:14px">${L.pricing.business.cta}</a>
      <ul style="margin:24px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:11px;font-size:13.5px;color:var(--ink-2)">
        ${featureLi(L.pricing.business.lead[0])}
        ${featureLi(`<strong>${L.pricing.business.lead[1]}</strong>`)}
        ${L.pricing.business.features.map(featureLi).join("")}
      </ul>
    </div>
    <div class="pricing-card" style="border:1px solid var(--rule);background:var(--surface);border-radius:20px;padding:30px;display:flex;flex-direction:column">
      <div style="font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.16em;color:var(--ink-soft)">${L.pricing.pro.name}</div>
      <div style="margin-top:14px;display:flex;align-items:baseline;gap:6px"><span style="font-family:var(--serif);font-size:44px;line-height:1;color:var(--ink)">${L.pricing.pro.price}</span></div>
      <div style="font-size:12.5px;color:var(--ink-mute);margin-top:6px">${L.pricing.pro.priceNote}</div>
      <p style="margin-top:14px;font-size:13.5px;color:var(--ink-soft)">${L.pricing.pro.blurb}</p>
      <a href="/signup?plan=multi" data-act="signup:multi" class="hv-brand" style="margin-top:22px;display:inline-flex;align-items:center;justify-content:center;height:46px;border-radius:999px;background:transparent;border:1px solid var(--rule-strong);color:var(--ink);font-weight:500;font-size:14px;transition:border-color .15s,color .15s">${L.pricing.pro.cta}</a>
      <ul style="margin:24px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:11px;font-size:13.5px;color:var(--ink-2)">
        ${featureLi(L.pricing.pro.lead[0])}
        ${featureLi(`<strong>${L.pricing.pro.lead[1]}</strong>`)}
        ${L.pricing.pro.features.map(featureLi).join("")}
      </ul>
    </div>
  </div>
  <p style="text-align:center;margin-top:28px;font-size:12.5px;color:var(--ink-mute)">${L.pricing.note}</p>`;

// ── Hero ticker board — a performance-tuned port of the reference design's
// "Animated ticker board background" + "Readability overlays": row
// mechanics (price drift, flash-on-update, digit-scramble while updating,
// hi/lo band, 7-bar sparkline) are kept, but tuned for FPS — see the perf
// notes below — and the up-color now uses the site's own
// brand accent instead of the reference's generic green. Values are
// synthetic (non-real) market data — pure decoration, not depicting actual
// securities. The reference's own nav bar and the scrolling ticker strip
// are intentionally NOT ported (real header already exists; the strip was
// cut for FPS). The reference's hero copy/CTAs are intentionally NOT
// ported either — this app's hero keeps its own localized headline/CTAs.
//
// Perf notes (this board was laggy at the reference's literal fidelity):
//   · 135 rows → 60: cuts baseline DOM node + style-recalc count by >50%.
//   · Per-row formatting is cached by row-object IDENTITY in a WeakMap, so
//     a tick only recomputes rows whose underlying state actually changed
//     (~28% of rows per tick) instead of all of them; combined with
//     React.memo on the row component, unchanged rows do zero React/DOM
//     work per tick.
//   · Dropped the `text-shadow` glow on flash (kept the reference's
//     `filter: blur()` shuffle effect, per an explicit ask, even though
//     it's the pricier of the two to animate on many elements at once).
//   · Shorter shuffle window (3 ticks @ 90ms vs. 5 @ 70ms) shrinks the
//     average number of rows mid-animation at any moment.
//
// The surrounding page is a static HTML string (see homeMain below), so
// the live grid is portalled in from the Landing() component into the
// #cfo-ticker-board placeholder that string emits.
const TICKER_SYMS = [
  "LRTX", "TSPN", "YFGO", "JTZU", "RHVX", "KLAE", "MIPX", "TDBS", "PGFX", "OXNR",
  "VRTX", "QMEL", "HXOM", "ZBRN", "FLKT", "DWSA", "NPRL", "CVGT", "SBKO", "ULMD",
  "ARNQ", "EFJT", "GHWX", "ORBD", "MSTV", "KDPL", "BNRC", "TQIL", "WXZO", "JPHA",
  "CETR", "LUVN", "FGDM", "RYKO", "SNTE", "HBQI", "PVAX", "XLOR", "DZMK", "TWEB",
  "ONYX", "GRFC", "MABL", "KVST", "EPRO", "ZUNI", "CLDH", "ITRX", "BLQM", "TARN",
  "VOXE", "HMKD", "SPRW", "JULE", "CRNT", "FYBR", "NODZ", "GLNT", "PIRA", "MERX",
  "QUOD", "AXIL", "WREN", "TOVA", "KYRO", "ZELP", "DRUM", "NAVI", "OPLE", "SIFT",
  "HULM", "EMBR", "ACRU", "BEXT", "CYND", "DOVR", "ELMX", "FINT", "GORM", "HYVE",
  "IRUX", "JAXN", "KELP", "LUMO", "MIRV", "NEXA", "OBRN", "PLYT", "QIRO", "RUVA",
  "STRN", "TUNK", "UVIA", "VELT", "WOLM", "XANT", "YODL", "ZEPH", "ARBO", "BRUX",
];

const UP_COLOR = "var(--brand)"; // the site's accent teal, in place of the reference's generic green
const DOWN_COLOR = "var(--alert)";
const UP_FLASH_BG = "rgba(75,191,168,0.14)";
const DOWN_FLASH_BG = "rgba(255,107,107,0.12)";

interface BoardRowState { sym: string; price: number; pct: number; flash: 0 | 1 | -1; shuffle: number }

function makeInitialBoardRows(): BoardRowState[] {
  return TICKER_SYMS.map((sym) => ({
    sym,
    price: 20 + Math.random() * 900,
    pct: Math.random() * 12 - 6,
    flash: 0,
    shuffle: 0,
  }));
}

function scrambleDigits(str: string): string {
  return str.replace(/\d/g, () => String(Math.floor(Math.random() * 10)));
}

function volOfRow(price: number): string {
  return (((price * 137) % 900) + 40).toFixed(1) + "K";
}

interface BoardBar { height: number; opacity: number }

// A fixed "shape" for the 7-bar sparkline (with index jitter for variety) —
// the actual reaction to live data is the whole cluster's scale, below.
function barsOfRow(i: number): BoardBar[] {
  return [4, 7, 5, 9, 6, 10, 7].map((h, k) => ({
    height: h + ((i * 3 + k * 5) % 5),
    opacity: 0.5 + k * 0.07,
  }));
}

interface FormattedBoardRow {
  sym: string; price: string; arrow: string; pct: string; vol: string; hiLo: string;
  color: string; priceColor: string; rowBg: string;
  numOpacity: number; numFilter: string; barScale: number;
  bars: BoardBar[];
}

function formatBoardRow(r: BoardRowState, i: number): FormattedBoardRow {
  const up = r.pct >= 0;
  const flashColor = r.flash === 1 ? UP_COLOR : DOWN_COLOR;
  const color = up ? UP_COLOR : DOWN_COLOR;
  const rawPrice = r.price.toFixed(2);
  const rawPct = `${up ? "+" : ""}${r.pct.toFixed(2)}%`;
  const rawVol = volOfRow(r.price);
  return {
    sym: r.sym,
    price: r.shuffle > 0 ? scrambleDigits(rawPrice) : rawPrice,
    pct: r.shuffle > 0 ? scrambleDigits(rawPct) : rawPct,
    vol: r.shuffle > 0 ? scrambleDigits(rawVol) : rawVol,
    hiLo: `${(r.price * 0.96).toFixed(2)}–${(r.price * 1.04).toFixed(2)}`,
    arrow: up ? "▲" : "▼",
    color,
    priceColor: r.flash ? flashColor : "var(--board-hi)",
    rowBg: r.flash ? (r.flash === 1 ? UP_FLASH_BG : DOWN_FLASH_BG) : "transparent",
    numOpacity: r.shuffle > 0 ? 0.4 : 1,
    numFilter: r.shuffle > 0 ? "blur(2.5px)" : "blur(0px)",
    // The sparkline cluster scales with the row's actual move size (0.4–1.3x)
    // instead of bouncing decoratively — bigger movers get visibly bigger bars.
    barScale: 0.4 + Math.min(1, Math.abs(r.pct) / 14) * 0.9,
    bars: barsOfRow(i),
  };
}

const BoardRowView = memo(function BoardRowView({ row }: { row: FormattedBoardRow }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, borderBottom: "1px solid rgba(110,150,138,0.12)", padding: "5px 2px", whiteSpace: "nowrap", background: row.rowBg, transition: "background 0.6s ease" }}>
      <span style={{ color: "var(--board-mid)", fontWeight: 600, width: 52 }}>{row.sym}</span>
      <span style={{ color: row.priceColor, width: 74, textAlign: "right", opacity: row.numOpacity, filter: row.numFilter, transition: "color 0.6s ease, opacity 0.2s ease, filter 0.2s ease" }}>{row.price}</span>
      <span style={{ width: 14, textAlign: "center", color: row.color }}>{row.arrow}</span>
      <span style={{ color: row.color, width: 72, textAlign: "right", opacity: row.numOpacity, filter: row.numFilter, transition: "opacity 0.2s ease, filter 0.2s ease" }}>{row.pct}</span>
      <span style={{ color: "var(--board-dim)", fontSize: 12, width: 58, textAlign: "right" }}>{row.vol}</span>
      <span style={{ color: "var(--board-dim)", fontSize: 12, width: 108, textAlign: "right" }}>{row.hiLo}</span>
      <span
        style={{
          display: "inline-flex",
          alignItems: "flex-end",
          gap: 2,
          height: 13,
          transformOrigin: "bottom",
          transform: `scaleY(${row.barScale})`,
          transition: "transform 0.4s ease",
        }}
      >
        {row.bars.map((b, k) => (
          <span key={k} style={{ width: 3, height: b.height, background: row.color, opacity: b.opacity, borderRadius: 1 }} />
        ))}
      </span>
    </div>
  );
});

const HERO_UPDATE_MS = 200; // explicit ask — the reference's own default is 900ms
const HERO_SHUFFLE_MS = 90; // digit-scramble tick — slowed slightly from the reference's 70ms for FPS
const HERO_SHUFFLE_STEPS = 3; // shortened from the reference's 5 steps for FPS

function HeroTicker({ boardHost }: { boardHost: HTMLElement }) {
  const [rows, setRows] = useState<BoardRowState[]>(makeInitialBoardRows);
  // Keyed by row-object identity so a row that didn't change this tick
  // (same object reference) returns the SAME formatted object — letting
  // React.memo skip it entirely. A WeakMap lets stale entries get GC'd once
  // a row updates to a new object.
  const formatCache = useRef(new WeakMap<BoardRowState, FormattedBoardRow>());

  useEffect(() => {
    // prefers-reduced-motion pauses the live updates entirely — the board
    // renders once, static, and the CSS drift is frozen by the matching
    // media query in SITE_CSS. Not reactive to mid-session OS changes on
    // purpose (a reload is fine; wiring a listener isn't worth the churn).
    if (typeof window !== "undefined" &&
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    const tick = setInterval(() => {
      setRows((prev) => prev.map((r) => {
        // 72% of ticks: just let any active flash fade back to neutral.
        if (Math.random() > 0.28) return r.flash ? { ...r, flash: 0 } : r;
        const drift = r.price * (Math.random() * 0.02 - 0.01);
        return {
          ...r,
          price: Math.max(1, r.price + drift),
          pct: Math.max(-14, Math.min(14, r.pct + (Math.random() * 1.6 - 0.8))),
          flash: drift >= 0 ? 1 : -1,
          shuffle: HERO_SHUFFLE_STEPS,
        };
      }));
    }, HERO_UPDATE_MS);
    const shuffle = setInterval(() => {
      setRows((prev) => (prev.some((r) => r.shuffle > 0)
        ? prev.map((r) => (r.shuffle > 0 ? { ...r, shuffle: r.shuffle - 1 } : r))
        : prev));
    }, HERO_SHUFFLE_MS);
    return () => { clearInterval(tick); clearInterval(shuffle); };
  }, []);

  const formatted = useMemo(() => rows.map((r, i) => {
    const cache = formatCache.current;
    let f = cache.get(r);
    if (!f) {
      f = formatBoardRow(r, i);
      cache.set(r, f);
    }
    return f;
  }), [rows]);

  return createPortal(
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, max-content)", justifyContent: "center", columnGap: 12, rowGap: 10, padding: 40, fontFamily: "'IBM Plex Mono', monospace", fontSize: 15 }}>
      {formatted.map((row) => <BoardRowView key={row.sym} row={row} />)}
    </div>,
    boardHost,
  );
}

// ── Global-positioning strip (directive 2026-08-29) ──────────────────────
// One quiet line + the marquee market row, rendered under the hero mock.
// The row comes STRAIGHT from lib/markets.ts MARQUEE so its order can never
// drift from the canonical taxonomy (gate G4: US, DE, GB, FR, IT, ES, AE —
// Hungary never appears in this row). No flags, no country singled out —
// every name renders in the same quiet mono caps, and the line itself keeps
// the ACCEPTANCE_LINE phrasing discipline (gate G3: "accepted" /
// "machine-verified", never "supported / certified / guaranteed" beside a
// global claim).
const marqueeMarketRow = (langCode: string) => {
  const lang: "en" | "ro" = langCode === "ro" ? "ro" : "en";
  return MARQUEE
    .map((m) => `<span style="white-space:nowrap">${m.displayName[lang]}</span>`)
    .join(`<span aria-hidden="true" style="color:var(--rule-strong)">·</span>`);
};

const globalStrip = (L: LandingStrings, langCode: string) => `
      <div style="margin-top:64px;width:100%;max-width:820px;border-top:1px solid var(--rule-soft);padding-top:26px">
        <p style="margin:0;font-size:13.5px;line-height:1.6;color:var(--ink-soft)">${L.global.line}</p>
        <div style="margin-top:16px;display:flex;flex-wrap:wrap;align-items:baseline;justify-content:center;column-gap:14px;row-gap:8px;font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.18em;color:var(--ink-mute)">${marqueeMarketRow(langCode)}</div>
      </div>`;

const homeMain = (L: LandingStrings, signedIn: boolean, billingCycle: BillingCycle = "monthly", langCode = "en") => `
<main>
  <section style="position:relative;overflow:hidden;background:var(--bg-deep);min-height:100vh">
    <!-- Ticker layer capped at .55 — with the readability overlays above
         it, the board behind the headline zone stays well below the AA
         contrast floor for the F5F5F5 display text. -->
    <div id="cfo-ticker-board" aria-hidden="true" style="position:absolute;top:30%;left:-8%;right:-8%;bottom:-46%;z-index:0;animation:cfo-heroBoardDrift 22s ease-in-out infinite;opacity:.55;pointer-events:none;will-change:transform"></div>
    <div aria-hidden="true" style="position:absolute;inset:0;z-index:1;pointer-events:none;background:radial-gradient(ellipse 70% 90% at 38% 50%,rgba(7,12,10,.96) 0%,rgba(7,12,10,.84) 45%,rgba(7,12,10,.38) 100%)"></div>
    <div aria-hidden="true" style="position:absolute;inset:0;z-index:1;pointer-events:none;background:linear-gradient(to bottom,rgba(7,12,10,.9),transparent 20%,transparent 72%,var(--bg-deep))"></div>
    <div style="position:relative;z-index:2;max-width:1000px;margin:0 auto;padding:220px 24px 56px;display:flex;flex-direction:column;align-items:center;text-align:center">
      ${eyebrow(L.hero.eyebrow)}
      <h1 style="margin-top:26px;font-family:var(--serif);font-weight:400;font-size:clamp(40px,6.4vw,66px);line-height:1.04;letter-spacing:-.025em;max-width:920px;color:var(--ink)">${L.hero.t1}<span class="grad-text">${L.hero.thl}</span>${L.hero.t2}</h1>
      <p style="margin-top:22px;font-size:clamp(16px,2vw,18px);line-height:1.6;color:var(--ink-soft);max-width:660px">${L.hero.body}</p>
      <div style="margin-top:34px;display:flex;flex-wrap:wrap;gap:14px;justify-content:center">
        ${signedIn
          ? `<button data-act="workspace" class="btn-grad" style="display:inline-flex;align-items:center;gap:8px;height:52px;padding:0 28px;border-radius:999px;background:var(--grad);color:var(--on-brand);font-weight:500;font-size:15px;box-shadow:0 10px 30px -10px rgba(75,191,168,.55);border:none;cursor:pointer;font-family:inherit">${L.cta.goWorkspace}</button>`
          : `<a href="/login?next=/&mode=sign_up" data-act="getstarted" class="btn-grad" style="display:inline-flex;align-items:center;gap:8px;height:52px;padding:0 28px;border-radius:999px;background:var(--grad);color:var(--on-brand);font-weight:500;font-size:15px;box-shadow:0 10px 30px -10px rgba(75,191,168,.55)">${L.hero.ctaStart}</a>
        <a href="/login?next=/" data-act="signin" class="btn-ghost2" style="display:inline-flex;align-items:center;height:52px;padding:0 24px;border-radius:999px;background:transparent;border:1px solid var(--rule-strong);color:var(--ink);font-weight:500;font-size:15px">${L.hero.ctaSignIn}</a>`}
      </div>
      <div style="margin-top:52px;width:100%;max-width:900px;border-radius:20px;border:1px solid var(--rule);background:var(--surface);overflow:hidden;box-shadow:0 50px 120px -40px rgba(0,0,0,.8);text-align:left">
        <div style="display:flex;align-items:center;gap:8px;padding:12px 18px;border-bottom:1px solid var(--rule-soft);background:var(--bg-2)">
          <span style="width:10px;height:10px;border-radius:50%;background:var(--rule-strong)"></span><span style="width:10px;height:10px;border-radius:50%;background:var(--rule-strong)"></span><span style="width:10px;height:10px;border-radius:50%;background:var(--rule-strong)"></span>
          <span style="margin-left:12px;font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.14em;color:var(--ink-mute)">${L.hero.mockTitle}</span>
        </div>
        <div class="mock-grid" style="padding:24px;display:grid;grid-template-columns:2fr 1fr;gap:20px">
          <div class="mock-kpis" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px">
            <div style="border:1px solid var(--rule);background:var(--bg-2);border-radius:14px;padding:16px"><div style="font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.14em;color:var(--ink-soft)">EBITDA margin</div><div style="font-family:var(--serif);font-size:40px;line-height:1;margin-top:8px;color:var(--brand)">11.4<span style="font-size:18px;color:var(--ink-soft)">%</span></div><div style="font-size:11.5px;color:var(--ink-soft);margin-top:6px">+1.8pp vs sector</div></div>
            <div style="border:1px solid var(--rule);background:var(--bg-2);border-radius:14px;padding:16px"><div style="font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.14em;color:var(--ink-soft)">Altman Z″</div><div style="font-family:var(--serif);font-size:40px;line-height:1;margin-top:8px;color:var(--brand)">3.12</div><div style="font-size:11.5px;color:var(--ink-soft);margin-top:6px">Safe zone</div></div>
            <div style="border:1px solid var(--rule);background:var(--bg-2);border-radius:14px;padding:16px"><div style="font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.14em;color:var(--ink-soft)">Net debt / EBITDA</div><div style="font-family:var(--serif);font-size:40px;line-height:1;margin-top:8px;color:var(--brand)">1.8<span style="font-size:18px;color:var(--ink-soft)">×</span></div><div style="font-size:11.5px;color:var(--ink-soft);margin-top:6px">Comfortable</div></div>
            <div style="border:1px solid var(--rule);background:var(--bg-2);border-radius:14px;padding:16px"><div style="font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.14em;color:var(--ink-soft)">ROIC</div><div style="font-family:var(--serif);font-size:40px;line-height:1;margin-top:8px;color:var(--brand)">17.7<span style="font-size:18px;color:var(--ink-soft)">%</span></div><div style="font-size:11.5px;color:var(--ink-soft);margin-top:6px">+2.1pp YoY</div></div>
          </div>
          <div style="border:1px solid var(--rule);background:var(--bg-2);border-radius:14px;padding:18px">
            <div style="display:flex;align-items:center;gap:7px;font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.14em;color:var(--brand)">✦ AI CFO Briefing</div>
            <p style="margin-top:12px;font-size:13.5px;line-height:1.6;color:var(--ink-2)">Profitability is above sector median, and the balance sheet is conservatively levered. Two watch-items: receivable days drifting up, and one supplier concentration above 30%.</p>
            <ul style="margin:10px 0 0;padding:0;list-style:none;font-size:12.5px;color:var(--ink-soft);display:flex;flex-direction:column;gap:8px">
              <li style="display:flex;gap:8px"><span style="color:var(--brand)">→</span> DSO up 6 days — tighten collections</li>
              <li style="display:flex;gap:8px"><span style="color:var(--brand)">→</span> Refinance short-term line before Q3</li>
              <li style="display:flex;gap:8px"><span style="color:var(--brand)">→</span> Benchmark vs 3 named peers ready</li>
            </ul>
          </div>
        </div>
      </div>
      <p style="margin-top:22px;font-size:11.5px;color:var(--ink-mute);max-width:520px">${L.hero.mockNote}</p>
      ${globalStrip(L, langCode)}
    </div>
  </section>

  <div style="height:1px;background:rgba(255,255,255,.25);transform:scaleY(.5)"></div>

  <section id="product" style="max-width:var(--maxw);margin:0 auto;padding:80px 24px 20px;scroll-margin-top:88px">
    <div style="text-align:center;max-width:680px;margin:0 auto 42px">
      ${eyebrow(L.modules.eyebrow)}
      <h2 style="margin-top:16px;font-family:var(--serif);font-weight:400;font-size:clamp(30px,4.5vw,46px);line-height:1.06;letter-spacing:-.02em">${L.modules.t1}<span class="grad-text">${L.modules.thl}</span></h2>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px">
      ${L.modules.cards.map((card, i) => {
        return `
      <div class="card-hl" style="border:1px solid var(--rule);background:var(--surface);border-radius:18px;padding:26px;display:flex;flex-direction:column;text-align:left">
        <div style="display:flex;align-items:flex-start;gap:14px">
          <div style="color:var(--brand);display:flex;align-items:center;justify-content:center;font-size:40px;line-height:1;flex-shrink:0">${["▤", "◎", "▦", "✦"][i]}</div>
          <div>
            <h3 style="font-family:var(--serif);font-weight:400;font-size:21px">${card.title}</h3>
            <div style="font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.14em;color:var(--ink-mute);margin-top:6px">${card.kicker}</div>
          </div>
        </div>
        <div style="height:1px;background:var(--rule);margin:16px 0"></div>
        <p style="font-size:13.5px;color:var(--ink-soft);flex:1">${card.body}</p>
      </div>`;
      }).join("")}
    </div>
  </section>

  <section id="how" style="max-width:var(--maxw);margin:0 auto;padding:70px 24px;scroll-margin-top:88px">
    ${eyebrow(L.how.eyebrow)}
    <h2 style="margin-top:16px;font-family:var(--serif);font-weight:400;font-size:clamp(30px,4.5vw,46px);line-height:1.06;letter-spacing:-.02em;max-width:680px">${L.how.t1}<span class="grad-text">${L.how.thl}</span></h2>
    <div id="how-steps" style="margin-top:48px;position:relative;display:grid;grid-template-columns:repeat(3,1fr);gap:24px">
      <div aria-hidden="true" style="position:absolute;top:22px;left:0;right:0;height:2px;background:var(--rule);z-index:0"></div>
      ${L.how.steps.map((step, i) => {
        const delay = (i * 0.45).toFixed(2);
        return `
      <div class="how-step" style="position:relative;z-index:1;text-align:left">
        <div class="how-step-circle" style="width:46px;height:46px;border-radius:50%;background:var(--surface);border:2px solid var(--rule);color:var(--ink-mute);display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-weight:600;font-size:15px;box-shadow:0 0 0 6px var(--bg);transition:border-color .5s ease,color .5s ease;transition-delay:${delay}s">0${i + 1}</div>
        <div class="how-step-text" style="opacity:0;transition:opacity .6s ease;transition-delay:${delay}s">
          <h3 style="font-family:var(--serif);font-weight:400;font-size:21px;margin-top:18px">${step.title}</h3>
          <p style="margin-top:8px;font-size:13.5px;color:var(--ink-soft)">${step.body}</p>
        </div>
      </div>`;
      }).join("")}
    </div>
  </section>

  <section id="trust" style="border-top:1px solid var(--rule-soft);background:var(--bg-2);scroll-margin-top:88px">
    <div style="max-width:var(--maxw);margin:0 auto;padding:74px 24px;display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:44px;align-items:center">
      <div>
        ${eyebrow(L.defensible.eyebrow)}
        <h2 style="margin-top:16px;font-family:var(--serif);font-weight:400;font-size:clamp(28px,4vw,42px);line-height:1.08;letter-spacing:-.02em">${L.defensible.title}</h2>
        <p style="margin-top:16px;font-size:15px;color:var(--ink-soft)">${L.defensible.body}</p>
        <ul style="margin:20px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:12px">
          ${L.defensible.bullets.map((b) => `<li style="display:flex;gap:12px;align-items:flex-start"><span style="color:var(--brand);margin-top:2px">✓</span><div><strong style="color:var(--ink)">${b.strong}</strong> <span style="color:var(--ink-soft)">${b.rest}</span></div></li>`).join("\n          ")}
        </ul>
      </div>
      <!-- Proof strip — replaces the former decorative peer-bar numbers
           with REAL measured stats (they mirror the claims in the copy to
           the left). Terminal register: near-black panel, mono readouts,
           phosphor values. No animation — proof doesn't perform. -->
      <div id="proof-strip" style="border:1px solid var(--rule);background:var(--bg-deep);border-radius:18px;padding:24px 26px">
        <div style="display:flex;align-items:center;gap:10px;font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.16em;color:var(--brand)">
          <span style="width:7px;height:7px;background:var(--brand);display:inline-block"></span>${L.defensible.proof.label}
        </div>
        <div style="margin-top:18px;display:flex;flex-direction:column">
          ${L.defensible.proof.stats.map((s, i) => `
          <div style="display:flex;align-items:baseline;gap:16px;padding:11px 0;${i > 0 ? "border-top:1px solid var(--rule-soft)" : ""}">
            <span style="font-family:var(--mono);font-size:20px;line-height:1.2;color:var(--brand-l);white-space:nowrap;font-variant-numeric:tabular-nums">${s.value}</span>
            <span style="font-size:12.5px;line-height:1.55;color:var(--ink-soft)">${s.caption}</span>
          </div>`).join("")}
        </div>
        <p style="margin:14px 0 0;font-family:var(--mono);font-size:11px;letter-spacing:.02em;color:var(--ink-mute);border-top:1px solid var(--rule-soft);padding-top:12px">${L.defensible.proof.note}</p>
      </div>
    </div>
  </section>

  <section id="audiences" style="max-width:var(--maxw);margin:0 auto;padding:74px 24px;scroll-margin-top:88px">
    ${eyebrow(L.audiences.eyebrow)}
    <h2 style="margin-top:16px;font-family:var(--serif);font-weight:400;font-size:clamp(30px,4.5vw,46px);line-height:1.06;letter-spacing:-.02em;max-width:680px">${L.audiences.t1}<span class="grad-text">${L.audiences.thl}</span></h2>
    <div style="margin-top:36px;display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px">
      ${L.audiences.cards.map((card) => `
      <div style="border:1px solid var(--rule);background:var(--bg-2);border-radius:16px;padding:24px"><div style="font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:var(--brand)">${card.title}</div><p style="margin-top:10px;font-size:14px;color:var(--ink-2)">${card.body}</p></div>`).join("")}
    </div>
  </section>

  <section id="pricing" style="border-top:1px solid var(--rule-soft);scroll-margin-top:88px">
    <div style="max-width:var(--maxw);margin:0 auto;padding:74px 24px">
      <div style="text-align:center;max-width:680px;margin:0 auto 42px">
        ${eyebrow(L.pricing.eyebrow)}
        <h2 style="margin-top:16px;font-family:var(--serif);font-weight:400;font-size:clamp(30px,4.5vw,46px);line-height:1.06;letter-spacing:-.02em">${L.pricing.t1}<span class="grad-text">${L.pricing.thl}</span></h2>
        <p style="margin-top:14px;font-size:15px;color:var(--ink-soft)">${L.pricing.subtitle}</p>
      </div>
      ${pricingGrid(L, billingCycle)}
    </div>
  </section>

  <section id="faq" style="border-top:1px solid var(--rule-soft);background:var(--bg-2);scroll-margin-top:88px">
    <div style="max-width:1200px;margin:0 auto;padding:74px 24px">
      <div style="text-align:center;margin-bottom:36px">
        ${eyebrow(L.faq.eyebrow)}
        <h2 style="margin-top:16px;font-family:var(--serif);font-weight:400;font-size:clamp(28px,4vw,42px);line-height:1.06;letter-spacing:-.02em">${L.faq.title}</h2>
      </div>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:14px">
        ${L.faq.items.map((item) => `
        <div style="border:1px solid var(--rule);background:var(--surface);border-radius:14px;padding:20px">
          <div style="font-weight:600;font-size:15px;color:var(--ink)">${item.q}</div>
          <p style="margin:10px 0 0;font-size:14px;color:var(--ink-soft)">${item.a
            .replace("{privacy}", inlineLink("privacy", L.legal.privacy))
            .replace("{terms}", inlineLink("terms", L.legal.terms))}</p>
        </div>`).join("")}
      </div>
    </div>
  </section>

  <section style="position:relative;overflow:hidden;border-top:1px solid var(--rule-soft)">
    <div aria-hidden="true" style="position:absolute;inset:0;background:radial-gradient(ellipse at center,rgba(75,191,168,.10),transparent 62%);pointer-events:none"></div>
    <div style="position:relative;max-width:820px;margin:0 auto;padding:88px 24px;text-align:center">
      <h2 style="font-family:var(--serif);font-weight:400;font-size:clamp(34px,5.5vw,58px);line-height:1.03;letter-spacing:-.03em">${L.cta.t1}<span class="grad-text">${L.cta.thl}</span></h2>
      <p style="margin-top:18px;font-size:16px;color:var(--ink-soft);max-width:520px;margin-left:auto;margin-right:auto">${L.cta.body}</p>
      <div style="margin-top:32px;display:flex;flex-wrap:wrap;gap:14px;justify-content:center">
        ${signedIn
          ? `<button data-act="workspace" class="btn-grad" style="display:inline-flex;align-items:center;gap:8px;height:52px;padding:0 28px;border-radius:999px;background:var(--grad);color:var(--on-brand);font-weight:500;font-size:15px;box-shadow:0 10px 30px -10px rgba(75,191,168,.55);border:none;cursor:pointer;font-family:inherit">${L.cta.goWorkspace}</button>`
          : `<a href="/login?next=/&mode=sign_up" data-act="getstarted" class="btn-grad" style="display:inline-flex;align-items:center;gap:8px;height:52px;padding:0 28px;border-radius:999px;background:var(--grad);color:var(--on-brand);font-weight:500;font-size:15px;box-shadow:0 10px 30px -10px rgba(75,191,168,.55)">${L.cta.start}</a>
        <a href="/login?next=/" data-act="signin" class="btn-ghost2" style="display:inline-flex;align-items:center;height:52px;padding:0 24px;border-radius:999px;background:transparent;border:1px solid var(--rule-strong);color:var(--ink);font-weight:500;font-size:15px">${L.cta.signIn}</a>`}
      </div>
    </div>
  </section>
</main>`;

const pricingMain = (L: LandingStrings, cycle: BillingCycle = "monthly") => `
<main style="max-width:var(--maxw);margin:0 auto;padding:64px 24px 40px">
  <div style="text-align:center;max-width:680px;margin:0 auto 44px">
    ${eyebrow(L.pricing.eyebrow)}
    <h1 style="margin-top:16px;font-family:var(--serif);font-weight:400;font-size:clamp(34px,5vw,52px);line-height:1.05;letter-spacing:-.025em">${L.pricing.t1}<span class="grad-text">${L.pricing.thl}</span></h1>
    <p style="margin-top:16px;font-size:16px;color:var(--ink-soft)">${L.pricing.subtitle}</p>
  </div>
  ${pricingGrid(L, cycle)}
</main>`;

function legalHeader(title: string, note?: string) {
  return `
  <div style="font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.18em;color:var(--ink-soft)">Legal</div>
  <h1 style="margin-top:12px;font-family:var(--serif);font-weight:400;font-size:clamp(32px,5vw,48px);line-height:1.05;letter-spacing:-.02em">${title}</h1>
  <p style="margin-top:10px;font-size:13px;color:var(--ink-mute)">Last updated: 20 July 2026</p>
  ${note ? `<div style="margin-top:14px;padding:16px 18px;border:1px solid var(--rule);background:var(--bg-2);border-radius:12px;font-size:13px;color:var(--ink-mute)">${note}</div>` : ""}`;
}
const h2 = (t: string) => `<h2 style="font-family:var(--serif);font-weight:400;font-size:24px;margin:34px 0 10px;color:var(--ink)">${t}</h2>`;

const PRIVACY = `
<section id="legal-privacy" style="max-width:960px;margin:0 auto;padding:48px 24px 8px;scroll-margin-top:88px">
  ${legalHeader("Privacy Policy", `This template is GDPR-oriented and reflects CFO AI's actual infrastructure. Replace every <strong style="color:var(--ink-soft)">[bracketed]</strong> placeholder with your registered company details and have it reviewed by a qualified lawyer before publishing.`)}
  <div style="margin-top:30px;font-size:14.5px;color:var(--ink-2);line-height:1.7">
    ${h2("1. Who we are")}
    <p>CFO AI ("we", "us", "our") operates the cfo-ai.io platform. The data controller is <strong style="color:var(--ink)">[Company Legal Name]</strong>, registered at <strong style="color:var(--ink)">[Registered Address, City, Country]</strong>, company registration number <strong style="color:var(--ink)">[Reg. No.]</strong>, VAT <strong style="color:var(--ink)">[VAT No.]</strong>. For any privacy question, contact <a href="mailto:privacy@cfo-ai.io">privacy@cfo-ai.io</a>.</p>
    ${h2("2. What data we process")}
    <p>We process the following categories of personal data:</p>
    <ul style="padding-left:20px;color:var(--ink-soft)">
      <li><strong style="color:var(--ink-2)">Account data</strong> — name, email address, company name, password (stored hashed), and subscription status.</li>
      <li><strong style="color:var(--ink-2)">Financial documents you upload</strong> — trial balances, balance sheets, P&amp;L statements and related files, together with the figures extracted from them.</li>
      <li><strong style="color:var(--ink-2)">Usage data</strong> — pages viewed, features used, uploads and AI messages, for security, billing and product improvement.</li>
      <li><strong style="color:var(--ink-2)">Technical data</strong> — IP address, browser type, device information and cookie identifiers.</li>
    </ul>
    ${h2("3. How and why we use it (legal bases)")}
    <ul style="padding-left:20px;color:var(--ink-soft)">
      <li><strong style="color:var(--ink-2)">To provide the service</strong> (Art. 6(1)(b) GDPR — contract): analysing your documents, generating reports and running your account.</li>
      <li><strong style="color:var(--ink-2)">To bill you</strong> (contract / legal obligation): managing subscriptions and issuing invoices.</li>
      <li><strong style="color:var(--ink-2)">To secure and improve the service</strong> (Art. 6(1)(f) — legitimate interests): fraud prevention, debugging and analytics.</li>
      <li><strong style="color:var(--ink-2)">Optional cookies &amp; communications</strong> (Art. 6(1)(a) — consent): analytics and marketing cookies, and product emails you can opt out of at any time.</li>
    </ul>
    <p>We do <strong style="color:var(--ink)">not</strong> sell your personal data, and we do not use your uploaded financial documents to train third-party AI models.</p>
    ${h2("4. Sub-processors")}
    <p>We rely on the following processors, each bound by a data-processing agreement:</p>
    <div style="overflow-x:auto;margin-top:8px">
      <table style="width:100%;border-collapse:collapse;font-size:13.5px">
        <thead><tr style="text-align:left;color:var(--ink-mute)"><th style="padding:8px 10px;border-bottom:1px solid var(--rule)">Processor</th><th style="padding:8px 10px;border-bottom:1px solid var(--rule)">Purpose</th><th style="padding:8px 10px;border-bottom:1px solid var(--rule)">Region</th></tr></thead>
        <tbody style="color:var(--ink-soft)">
          <tr><td style="padding:8px 10px;border-bottom:1px solid var(--rule-soft)">Supabase</td><td style="padding:8px 10px;border-bottom:1px solid var(--rule-soft)">Database, authentication &amp; file storage</td><td style="padding:8px 10px;border-bottom:1px solid var(--rule-soft)">EU (Ireland)</td></tr>
          <tr><td style="padding:8px 10px;border-bottom:1px solid var(--rule-soft)">Anthropic</td><td style="padding:8px 10px;border-bottom:1px solid var(--rule-soft)">AI analysis &amp; narrative generation</td><td style="padding:8px 10px;border-bottom:1px solid var(--rule-soft)">USA (SCCs)</td></tr>
          <tr><td style="padding:8px 10px;border-bottom:1px solid var(--rule-soft)">Stripe</td><td style="padding:8px 10px;border-bottom:1px solid var(--rule-soft)">Payment processing</td><td style="padding:8px 10px;border-bottom:1px solid var(--rule-soft)">EU / USA (SCCs)</td></tr>
          <tr><td style="padding:8px 10px;border-bottom:1px solid var(--rule-soft)">Resend</td><td style="padding:8px 10px;border-bottom:1px solid var(--rule-soft)">Transactional email</td><td style="padding:8px 10px;border-bottom:1px solid var(--rule-soft)">EU / USA (SCCs)</td></tr>
          <tr><td style="padding:8px 10px">Hostinger</td><td style="padding:8px 10px">Application hosting</td><td style="padding:8px 10px">EU</td></tr>
        </tbody>
      </table>
    </div>
    <p style="margin-top:10px">Where data is transferred outside the EEA, we use the European Commission's Standard Contractual Clauses (SCCs) as the transfer mechanism.</p>
    ${h2("5. How long we keep it")}
    <p>Uploaded documents and derived analyses are retained for the history-retention window of your plan (12 to 60 months) and deleted or anonymised thereafter, unless a longer period is required by law (e.g. tax records). You can delete documents at any time from your workspace.</p>
    ${h2("6. Your rights")}
    <p>Under the GDPR you have the right to access, rectify, erase, restrict and port your data, to object to processing, and to withdraw consent at any time. To exercise any right, email <a href="mailto:privacy@cfo-ai.io">privacy@cfo-ai.io</a>. You also have the right to lodge a complaint with your supervisory authority — in Romania, the <strong style="color:var(--ink)">ANSPDCP</strong> (dataprotection.ro).</p>
    ${h2("7. Cookies")}
    <p>We use strictly necessary cookies plus optional analytics and marketing cookies subject to your consent. See our <button data-act="cookies" style="background:none;border:none;padding:0;color:var(--brand);cursor:pointer;font:inherit">Cookie Policy</button>, and change your choices anytime via <button data-act="consent" style="background:none;border:none;padding:0;color:var(--brand);cursor:pointer;font:inherit">Cookie settings</button>.</p>
    ${h2("8. Changes")}
    <p>We may update this policy from time to time. Material changes will be notified by email or an in-app notice. The "last updated" date above always reflects the current version.</p>
  </div>
</section>`;

const COOKIES = `
<section id="legal-cookies" style="max-width:960px;margin:0 auto;padding:48px 24px 8px;scroll-margin-top:88px">
  ${legalHeader("Cookie Policy")}
  <div style="margin-top:30px;font-size:14.5px;color:var(--ink-2);line-height:1.7">
    <p>Cookies and similar technologies (including browser <em>localStorage</em>) are small pieces of data stored on your device. We use them to keep you signed in, remember your preferences, and — only with your consent — to understand usage and measure marketing.</p>
    ${h2("Categories we use")}
    <div style="display:flex;flex-direction:column;gap:14px;margin-top:6px">
      <div style="border:1px solid var(--rule);background:var(--bg-2);border-radius:12px;padding:18px"><div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><strong style="color:var(--ink)">Strictly necessary</strong><span style="font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:var(--brand);border:1px solid rgba(75,191,168,.4);padding:3px 9px;border-radius:999px">Always on</span></div><p style="margin:8px 0 0;font-size:13.5px;color:var(--ink-soft)">Authentication session, security, load balancing and your cookie-consent choice. The site cannot function without these, so they do not require consent.</p></div>
      <div style="border:1px solid var(--rule);background:var(--bg-2);border-radius:12px;padding:18px"><div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><strong style="color:var(--ink)">Analytics</strong><span style="font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:var(--ink-mute);border:1px solid var(--rule-strong);padding:3px 9px;border-radius:999px">Optional</span></div><p style="margin:8px 0 0;font-size:13.5px;color:var(--ink-soft)">Help us understand which features are used so we can improve the product. Set only if you accept analytics cookies.</p></div>
      <div style="border:1px solid var(--rule);background:var(--bg-2);border-radius:12px;padding:18px"><div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><strong style="color:var(--ink)">Marketing</strong><span style="font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:var(--ink-mute);border:1px solid var(--rule-strong);padding:3px 9px;border-radius:999px">Optional</span></div><p style="margin:8px 0 0;font-size:13.5px;color:var(--ink-soft)">Measure the effectiveness of our campaigns and show relevant messaging. Set only if you accept marketing cookies.</p></div>
    </div>
    ${h2("Managing your choices")}
    <p>You gave (or declined) consent when you first visited. You can change your preferences at any time using the button below or via "Cookie settings" in the footer. You can also block or delete cookies in your browser settings.</p>
    <button data-act="consent" class="btn-grad" style="margin-top:8px;display:inline-flex;align-items:center;height:44px;padding:0 22px;border-radius:999px;background:var(--grad);color:var(--on-brand);font-weight:500;font-size:14px;cursor:pointer;font-family:inherit">Open cookie settings</button>
  </div>
</section>`;

const TERMS = `
<section id="legal-terms" style="max-width:960px;margin:0 auto;padding:48px 24px 8px;scroll-margin-top:88px">
  ${legalHeader("Terms of Service", `Replace <strong style="color:var(--ink-soft)">[bracketed]</strong> placeholders with your legal entity and governing-law details, and have these terms reviewed by a lawyer before publishing.`)}
  <div style="margin-top:30px;font-size:14.5px;color:var(--ink-2);line-height:1.7">
    ${h2("1. Agreement")}
    <p>These Terms govern your use of CFO AI, operated by <strong style="color:var(--ink)">[Company Legal Name]</strong>. By creating an account or using the service, you agree to these Terms and to our <button data-act="privacy" style="background:none;border:none;padding:0;color:var(--brand);cursor:pointer;font:inherit">Privacy Policy</button>.</p>
    ${h2("2. The service")}
    <p>CFO AI provides AI-assisted financial analysis, benchmarking and reporting from data you upload and from public-company sources. Features and limits depend on your subscription plan.</p>
    ${h2("3. Accounts")}
    <p>You are responsible for the accuracy of your account information, for keeping your credentials secure, and for all activity under your account. You must be at least 18 and authorised to accept these Terms on behalf of your organisation.</p>
    ${h2("4. Subscriptions &amp; billing")}
    <p>Paid plans are billed in advance on a monthly or annual basis. Trials convert to a paid subscription unless cancelled before they end. Fees are non-refundable except where required by law. Overage documents are charged per-document at the rate shown and confirmed before processing. We may change pricing with reasonable notice.</p>
    ${h2("5. Acceptable use")}
    <p>You may not misuse the service, including by attempting to breach security, reverse-engineering the platform, reselling access without authorisation, or uploading data you have no right to process. You retain ownership of the data you upload and grant us a limited licence to process it solely to provide the service.</p>
    ${h2("6. Not professional advice")}
    <p>CFO AI produces AI-assisted analysis and decision support. It is <strong style="color:var(--ink)">not</strong> financial, investment, legal, tax or accounting advice. Outputs may contain errors or approximations, which we flag where identified. Final decisions remain with you and your management team, and you should consult qualified professionals before acting.</p>
    ${h2("7. Intellectual property")}
    <p>The platform, its software and its branding are owned by <strong style="color:var(--ink)">[Company Legal Name]</strong>. These Terms grant you a limited, non-exclusive, non-transferable right to use the service during your subscription.</p>
    ${h2("8. Disclaimers &amp; liability")}
    <p>The service is provided "as is" to the fullest extent permitted by law. To the maximum extent permitted, our total liability arising out of the service is limited to the fees you paid in the 12 months preceding the claim. Nothing in these Terms excludes liability that cannot be excluded by law.</p>
    ${h2("9. Termination")}
    <p>You may cancel at any time from your account settings. We may suspend or terminate access for breach of these Terms. On termination, your data is handled as described in the Privacy Policy.</p>
    ${h2("10. Governing law")}
    <p>These Terms are governed by the laws of <strong style="color:var(--ink)">[Country/Jurisdiction]</strong>, and disputes are subject to the exclusive jurisdiction of the courts of <strong style="color:var(--ink)">[City, Country]</strong>, without prejudice to your mandatory consumer rights.</p>
    ${h2("11. Contact")}
    <p>Questions about these Terms? Email <a href="mailto:legal@cfo-ai.io">legal@cfo-ai.io</a>.</p>
  </div>
</section>`;

// Contact page — real form POSTing to /api/contact-sales (persists to
// contact_sales_leads + notifies). Rendered as a function so typed values
// survive re-renders: inputs are uncontrolled, but the component mirrors
// them into a ref on input and re-injects them here.
type ContactStatus = "idle" | "sending" | "sent" | "error" | "invalid";
interface ContactValues { name: string; email: string; company: string; message: string }

function contactMain(v: ContactValues, status: ContactStatus, L: LandingStrings) {
  const formBody = status === "sent"
    ? `
    <div style="text-align:center;padding:26px 10px">
      <div style="width:52px;height:52px;border-radius:50%;background:rgba(75,191,168,.14);color:var(--brand);display:inline-flex;align-items:center;justify-content:center;font-size:24px">✓</div>
      <h3 style="font-family:var(--serif);font-weight:400;font-size:24px;margin-top:16px;color:var(--ink)">${L.contact.sentTitle}</h3>
      <p style="margin-top:8px;font-size:14px;color:var(--ink-soft)">${L.contact.sentBody}</p>
    </div>`
    : `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px">
      <input id="cf-name" class="field" placeholder="${L.contact.phName}" value="${esc(v.name)}">
      <input id="cf-email" class="field" type="email" placeholder="${L.contact.phEmail}" value="${esc(v.email)}">
    </div>
    <input id="cf-company" class="field" style="margin-top:14px" placeholder="${L.contact.phCompany}" value="${esc(v.company)}">
    <textarea id="cf-message" class="field" style="margin-top:14px;min-height:130px;resize:vertical" placeholder="${L.contact.phMessage}">${esc(v.message)}</textarea>
    ${status === "invalid" ? `<p style="margin:12px 0 0;font-size:13px;color:var(--alert)">${L.contact.invalid}</p>` : ""}
    ${status === "error" ? `<p style="margin:12px 0 0;font-size:13px;color:var(--alert)">${L.contact.error}</p>` : ""}
    <button data-act="contact:send" class="btn-grad" ${status === "sending" ? "disabled" : ""} style="margin-top:18px;display:inline-flex;align-items:center;gap:8px;height:48px;padding:0 26px;border-radius:999px;background:var(--grad);color:var(--on-brand);font-weight:500;font-size:14.5px;border:none;cursor:pointer;font-family:inherit;${status === "sending" ? "opacity:.6;cursor:default" : ""}">${status === "sending" ? L.contact.sending : L.contact.send}</button>
    <p style="margin:12px 0 0;font-size:11.5px;color:var(--ink-mute)">${L.contact.note}</p>`;

  return `
<main style="max-width:760px;margin:0 auto;padding:64px 24px 40px">
  <div style="text-align:center;margin-bottom:36px">
    ${eyebrow(L.contact.eyebrow)}
    <h1 style="margin-top:16px;font-family:var(--serif);font-weight:400;font-size:clamp(32px,5vw,48px);line-height:1.05;letter-spacing:-.02em">${L.contact.title}</h1>
    <p style="margin-top:14px;font-size:16px;color:var(--ink-soft)">${L.contact.subtitle}</p>
  </div>
  <div style="border:1px solid var(--rule);background:var(--surface);border-radius:18px;padding:26px;margin-bottom:36px">${formBody}
  </div>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px">
    <a href="mailto:sales@cfo-ai.io" class="card-hl" style="border:1px solid var(--rule);background:var(--surface);border-radius:16px;padding:24px;display:block;color:inherit"><div style="font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.14em;color:var(--ink-mute)">${L.contact.sales.kicker}</div><div style="margin-top:8px;font-size:16px;color:var(--brand)">sales@cfo-ai.io</div><p style="margin:8px 0 0;font-size:13px;color:var(--ink-soft)">${L.contact.sales.blurb}</p></a>
    <a href="mailto:support@cfo-ai.io" class="card-hl" style="border:1px solid var(--rule);background:var(--surface);border-radius:16px;padding:24px;display:block;color:inherit"><div style="font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.14em;color:var(--ink-mute)">${L.contact.support.kicker}</div><div style="margin-top:8px;font-size:16px;color:var(--brand)">support@cfo-ai.io</div><p style="margin:8px 0 0;font-size:13px;color:var(--ink-soft)">${L.contact.support.blurb}</p></a>
    <a href="mailto:privacy@cfo-ai.io" class="card-hl" style="border:1px solid var(--rule);background:var(--surface);border-radius:16px;padding:24px;display:block;color:inherit"><div style="font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.14em;color:var(--ink-mute)">${L.contact.privacy.kicker}</div><div style="margin-top:8px;font-size:16px;color:var(--brand)">privacy@cfo-ai.io</div><p style="margin:8px 0 0;font-size:13px;color:var(--ink-soft)">${L.contact.privacy.blurb}</p></a>
    <div style="border:1px solid var(--rule);background:var(--surface);border-radius:16px;padding:24px"><div style="font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.14em;color:var(--ink-mute)">${L.contact.office}</div><div style="margin-top:8px;font-size:14px;color:var(--ink-2)">[Company Legal Name]<br>[Registered Address]<br>[City, Country]</div></div>
  </div>
</main>`;
}

// Legal — ONE page holding all three documents (Privacy / Cookies / Terms)
// as stacked sections, with a jump-nav at the top. The old standalone pages
// were folded in here; legacy acts/hashes still land on the right section.
const LEGAL_DIVIDER = `
  <div style="max-width:820px;margin:32px auto 8px;padding:0 24px"><div style="height:1px;background:var(--rule)"></div></div>`;

const legalMain = (L: LandingStrings) => `
<main style="padding-bottom:40px">
  <div style="max-width:820px;margin:0 auto;padding:64px 24px 0;text-align:center">
    ${eyebrow(L.legal.eyebrow)}
    <h1 style="margin-top:16px;font-family:var(--serif);font-weight:400;font-size:clamp(32px,5vw,48px);line-height:1.05;letter-spacing:-.02em">${L.legal.title}</h1>
    <p style="margin-top:14px;font-size:16px;color:var(--ink-soft)">${L.legal.subtitle}</p>
    <div style="margin-top:24px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
      ${[
        ["privacy", L.legal.privacy],
        ["cookies", L.legal.cookies],
        ["terms", L.legal.terms],
      ].map(([act, label]) => `
      <button data-act="${act}" class="hv-brand" style="display:inline-flex;align-items:center;height:40px;padding:0 18px;border-radius:999px;background:transparent;border:1px solid var(--rule-strong);color:var(--ink);font-weight:500;font-size:13.5px;cursor:pointer;font-family:inherit;transition:border-color .15s,color .15s">${label}</button>`).join("")}
    </div>
    ${L.legal.englishNote ? `<p style="margin-top:16px;font-size:12.5px;color:var(--ink-mute)">${L.legal.englishNote}</p>` : ""}
  </div>
  ${PRIVACY}
  ${LEGAL_DIVIDER}
  ${COOKIES}
  ${LEGAL_DIVIDER}
  ${TERMS}
</main>`;

function footer(year: number, L: LandingStrings, langCode: string) {
  const flink = (act: string, label: string) =>
    `<button data-act="${act}" style="background:none;border:none;padding:0;text-align:left;color:var(--ink-soft);cursor:pointer;font:inherit">${label}</button>`;
  // The ONLY language switcher on the logged-out marketing surface — the
  // header deliberately has none (operator decision, 2026-08-04).
  const langSwitcher = `
      <span style="display:inline-flex;align-items:center;gap:12px">
        <span style="font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.14em">${L.nav.language}</span>
        ${SUPPORTED_LANGUAGES.map((l) => `<button data-act="lang:${l.code}" style="background:none;border:none;padding:0;cursor:pointer;font:inherit;display:inline-flex;align-items:center;gap:5px;color:${l.code === langCode ? "var(--brand)" : "var(--ink-mute)"}">${l.badge} ${l.label}</button>`).join("")}
      </span>`;
  return `
<footer style="border-top:1px solid var(--rule-soft);background:var(--bg-2)">
  <div style="max-width:var(--maxw);margin:0 auto;padding:44px 24px 30px">
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:32px">
      <div style="min-width:200px">
        <div style="display:inline-flex;align-items:center;gap:10px">${LOGO}<span style="font-size:15px;font-weight:600;color:var(--ink)">CFO <span style="color:var(--brand)">AI</span></span></div>
        <p style="margin-top:14px;font-size:13px;color:var(--ink-soft);max-width:260px">${L.footer.blurb}</p>
      </div>
      <div>
        <div style="font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.14em;color:var(--ink-mute);margin-bottom:14px">${L.footer.product}</div>
        <div style="display:flex;flex-direction:column;gap:10px;font-size:13.5px">
          ${flink("scroll:product", L.footer.overview)}
          ${flink("scroll:how", L.footer.how)}
          ${flink("scroll:trust", L.footer.trust)}
          ${flink("scroll:audiences", L.footer.audiences)}
          ${flink("scroll:pricing", L.nav.pricing)}
          ${flink("scroll:faq", L.footer.faq)}
        </div>
      </div>
      <div>
        <div style="font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.14em;color:var(--ink-mute);margin-bottom:14px">${L.footer.legalCol}</div>
        <div style="display:flex;flex-direction:column;gap:10px;font-size:13.5px">
          ${flink("privacy", L.legal.privacy)}
          ${flink("cookies", L.legal.cookies)}
          ${flink("terms", L.legal.terms)}
          ${flink("consent", L.footer.cookieSettings)}
        </div>
      </div>
      <div>
        <div style="font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.14em;color:var(--ink-mute);margin-bottom:14px">${L.footer.contactCol}</div>
        <div style="display:flex;flex-direction:column;gap:10px;font-size:13.5px">
          ${flink("contact", L.footer.contactUs)}
          <a href="mailto:sales@cfo-ai.io" style="color:var(--ink-soft)">sales@cfo-ai.io</a>
          <a href="mailto:support@cfo-ai.io" style="color:var(--ink-soft)">support@cfo-ai.io</a>
        </div>
      </div>
    </div>
    <div style="margin-top:36px;padding-top:22px;border-top:1px solid var(--rule-soft);display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between;align-items:center;font-size:12px;color:var(--ink-mute)">
      <span>${L.footer.rights.replace("{year}", String(year))}</span>
      ${langSwitcher}
      <span>${L.footer.madeIn}</span>
    </div>
  </div>
</footer>`;
}

function consentModal(expanded: boolean, analytics: boolean, marketing: boolean, L: LandingStrings) {
  const on = "var(--brand-d)", off = "var(--rule-strong)";
  const track = (v: boolean) => (v ? on : off);
  const knob = (v: boolean) => (v ? "21px" : "3px");
  const toggleRow = (act: string, title: string, desc: string, v: boolean) => `
      <button data-act="${act}" style="display:flex;justify-content:space-between;align-items:center;gap:12px;border:1px solid var(--rule);background:var(--bg-2);border-radius:12px;padding:14px 16px;cursor:pointer;text-align:left;font:inherit"><div><div style="font-size:13.5px;font-weight:600;color:var(--ink)">${title}</div><div style="font-size:12px;color:var(--ink-mute)">${desc}</div></div><span style="width:42px;height:24px;border-radius:999px;flex-shrink:0;position:relative;transition:background .15s;background:${track(v)}"><span style="position:absolute;top:3px;width:18px;height:18px;border-radius:50%;background:var(--ink);transition:left .15s;left:${knob(v)}"></span></span></button>`;
  return `
<div style="position:fixed;inset:0;z-index:90;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.5);backdrop-filter:blur(2px);padding:0 16px 16px">
  <div style="width:100%;max-width:640px;border:1px solid var(--rule-strong);background:var(--surface);border-radius:18px;padding:24px;box-shadow:0 30px 80px -20px rgba(0,0,0,.8)">
    <div style="display:flex;align-items:center;gap:10px"><span style="width:8px;height:8px;background:var(--brand);display:inline-block"></span><strong style="font-size:16px;color:var(--ink)">${L.consent.title}</strong></div>
    <p style="margin-top:12px;font-size:13.5px;color:var(--ink-soft)">${L.consent.body.replace("{cookiePolicy}", inlineLink("cookies", L.legal.cookies))}</p>
    ${expanded ? `
    <div style="margin-top:16px;display:flex;flex-direction:column;gap:10px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;border:1px solid var(--rule);background:var(--bg-2);border-radius:12px;padding:14px 16px"><div><div style="font-size:13.5px;font-weight:600;color:var(--ink)">${L.consent.necessary}</div><div style="font-size:12px;color:var(--ink-mute)">${L.consent.necessaryDesc}</div></div><span style="font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--brand)">${L.consent.alwaysOn}</span></div>
      ${toggleRow("consent:analytics", L.consent.analytics, L.consent.analyticsDesc, analytics)}
      ${toggleRow("consent:marketing", L.consent.marketing, L.consent.marketingDesc, marketing)}
    </div>` : ""}
    <div style="margin-top:18px;display:flex;flex-wrap:wrap;gap:10px">
      <button data-act="consent:acceptAll" class="btn-grad" style="flex:1;min-width:130px;height:44px;border-radius:999px;background:var(--grad);color:var(--on-brand);font-weight:500;font-size:14px;border:none;cursor:pointer;font-family:inherit">${L.consent.acceptAll}</button>
      <button data-act="consent:rejectAll" style="flex:1;min-width:130px;height:44px;border-radius:999px;background:transparent;border:1px solid var(--rule-strong);color:var(--ink);font-weight:500;font-size:14px;cursor:pointer;font-family:inherit">${L.consent.rejectAll}</button>
      ${expanded
        ? `<button data-act="consent:save" class="hv-brand" style="flex:1;min-width:130px;height:44px;border-radius:999px;background:var(--surface-hi);border:1px solid var(--rule-strong);color:var(--ink);font-weight:500;font-size:14px;cursor:pointer;font-family:inherit;transition:border-color .15s,color .15s">${L.consent.save}</button>`
        : `<button data-act="consent:expand" style="flex:1;min-width:130px;height:44px;border-radius:999px;background:transparent;border:1px solid var(--rule);color:var(--ink-soft);font-weight:500;font-size:14px;cursor:pointer;font-family:inherit">${L.consent.customise}</button>`}
    </div>
  </div>
</div>`;
}

// Sign-out confirmation — mirrors the consent modal's shell.
const signoutModal = (L: LandingStrings) => `
<div style="position:fixed;inset:0;z-index:95;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);backdrop-filter:blur(2px);padding:16px">
  <div style="width:100%;max-width:420px;border:1px solid var(--rule-strong);background:var(--surface);border-radius:18px;padding:24px;box-shadow:0 30px 80px -20px rgba(0,0,0,.8)">
    <div style="display:flex;align-items:center;gap:10px"><span style="width:8px;height:8px;background:var(--alert);display:inline-block"></span><strong style="font-size:16px;color:var(--ink)">${L.signout.title}</strong></div>
    <p style="margin-top:12px;font-size:13.5px;color:var(--ink-soft)">${L.signout.body}</p>
    <div style="margin-top:18px;display:flex;gap:10px;justify-content:flex-end">
      <button data-act="signout:cancel" style="height:42px;padding:0 20px;border-radius:999px;background:transparent;border:1px solid var(--rule-strong);color:var(--ink);font-weight:500;font-size:14px;cursor:pointer;font-family:inherit">${L.signout.cancel}</button>
      <button data-act="signout:confirm" style="height:42px;padding:0 20px;border-radius:999px;background:var(--alert);border:none;color:var(--ink);font-weight:500;font-size:14px;cursor:pointer;font-family:inherit">${L.signout.confirm}</button>
    </div>
  </div>
</div>`;

export default function Landing() {
  const navigate = useNavigate();
  const { isAuthenticated, displayName, initials, user, signOut } = useAuth();
  const { i18n } = useTranslation();
  const [page, setPage] = useState<Page>("home");
  // The account chip's open/closed state is NOT React state — see the
  // comment on authArea in header() for why: it's a classList.toggle on
  // the persistent .cred-pill DOM node so the CSS transitions animate.
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [contactStatus, setContactStatus] = useState<ContactStatus>("idle");
  const [billingCycle, setBillingCycle] = useState<BillingCycle>("monthly");
  // Contact-form values live in a ref (not state) so typing never re-renders
  // the innerHTML — the uncontrolled inputs keep their own values. The ref is
  // re-injected into the markup only when something ELSE forces a re-render.
  const contactRef = useRef<ContactValues>({ name: "", email: "", company: "", message: "" });

  // The hero ticker board needs live JS state, but it lives inside the
  // dangerouslySetInnerHTML string below — so <HeroTicker> is portalled
  // into the #cfo-ticker-board placeholder that string emits, once it
  // exists in the DOM (home page only).
  const rootRef = useRef<HTMLDivElement>(null);
  const [tickerBoardHost, setTickerBoardHost] = useState<HTMLElement | null>(null);

  // Header fade — transparent at the very top of any landing page, fading
  // to the frosted sticky bar as soon as you scroll (on the home page this
  // also reveals the hero's ticker board through it). This is deliberately
  // NOT part of the `html` memo below: including scroll state
  // there would tear down and rebuild the entire innerHTML (header + main +
  // footer) on every scroll tick, which would both kill the CSS transition
  // (a freshly-created header has no "previous" state to animate from) and
  // be a real perf problem. Instead an `at-top` class toggles on the
  // persistent root div — a normal React prop update that doesn't touch
  // dangerouslySetInnerHTML's children — and CSS handles the transition.
  const [isAtTop, setIsAtTop] = useState(true);
  useEffect(() => {
    const onScroll = () => setIsAtTop(window.scrollY < 40);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const account = useMemo<HeaderAccount | null>(() => {
    if (!isAuthenticated) return null;
    const email = user?.email ?? "";
    return {
      name: displayName ?? email.split("@")[0] ?? "Account",
      email,
      initials: initials ?? "?",
    };
  }, [isAuthenticated, displayName, initials, user]);
  const [consentOpen, setConsentOpen] = useState(false);
  const [consentExpanded, setConsentExpanded] = useState(false);
  const [analytics, setAnalytics] = useState(false);
  const [marketing, setMarketing] = useState(false);

  // First-visit consent gate + hash deep-linking (#/pricing etc.).
  useEffect(() => {
    let hasConsent = false;
    try {
      const saved = localStorage.getItem(CONSENT_KEY);
      if (saved) {
        hasConsent = true;
        const p = JSON.parse(saved);
        setAnalytics(!!p.analytics);
        setMarketing(!!p.marketing);
      }
    } catch { /* private mode */ }
    if (!hasConsent) setConsentOpen(true);

    const applyHash = () => {
      const h = (location.hash || "").replace(/^#\/?/, "").trim();
      if ((LEGAL_DOCS as string[]).includes(h)) {
        // Legacy deep links (#/privacy etc.) → the combined legal page.
        setPage("legal");
        return;
      }
      setPage(VALID_PAGES.includes(h as Page) ? (h as Page) : "home");
    };
    applyHash();
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
  }, []);

  const goPage = useCallback((p: Page) => {
    setPage(p);
    try { location.hash = p === "home" ? "" : `#/${p}`; } catch { /* noop */ }
    try { window.scrollTo(0, 0); } catch { /* noop */ }
  }, []);

  const persist = (a: boolean, m: boolean) => {
    try { localStorage.setItem(CONSENT_KEY, JSON.stringify({ analytics: a, marketing: m, ts: Date.now() })); }
    catch { /* private mode */ }
  };

  const scrollTo = (id: string) => {
    setPage("home");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = document.getElementById(id);
        el?.scrollIntoView({ behavior: "smooth", block: "start" });
        // Brief pulsing ring so a footer nav click (Overview/How it works/
        // etc.) is obviously "landing" on the right section, not just a
        // silent scroll.
        if (el) {
          el.classList.add("section-pulse");
          window.setTimeout(() => el.classList.remove("section-pulse"), 1600);
        }
      });
    });
  };

  // Mirror contact-form input into the ref so values survive re-renders.
  const onInput = useCallback((e: ReactFormEvent<HTMLDivElement>) => {
    const t = e.target as HTMLInputElement | HTMLTextAreaElement;
    if (!t.id || !t.id.startsWith("cf-")) return;
    const key = t.id.slice(3) as keyof ContactValues;
    if (key in contactRef.current) contactRef.current[key] = t.value;
  }, []);

  const submitContact = useCallback(async () => {
    const v = contactRef.current;
    if (!v.name.trim() || !v.email.includes("@") || !v.message.trim()) {
      setContactStatus("invalid");
      return;
    }
    setContactStatus("sending");
    const apiUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";
    try {
      const r = await fetch(`${apiUrl}/api/contact-sales`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: v.name.trim(),
          email: v.email.trim(),
          company: v.company.trim() || undefined,
          use_case: v.message.trim(),
        }),
      });
      if (!r.ok) throw new Error(await r.text());
      setContactStatus("sent");
    } catch {
      setContactStatus("error");
    }
  }, []);

  const onClick = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    const actRaw = el?.getAttribute("data-act") || "";
    // Any click that isn't the toggle itself closes an open dropdown.
    if (actRaw !== "account") (e.currentTarget as HTMLElement).querySelector(".cred-pill.is-open")?.classList.remove("is-open");
    if (mobileMenuOpen && actRaw !== "burger") setMobileMenuOpen(false);
    if (!el) return;
    const act = actRaw;
    // Mobile burger menu (small screens only — see .burger-btn media query).
    if (act === "burger") { e.preventDefault(); setMobileMenuOpen((v) => !v); return; }
    // Account dropdown + sign-out confirmation.
    if (act === "account") { e.preventDefault(); el.closest(".cred-pill")?.classList.toggle("is-open"); return; }
    if (act === "account:settings") { e.preventDefault(); navigate("/account/settings"); return; }
    if (act === "account:signout") { e.preventDefault(); setSignOutOpen(true); return; }
    if (act === "signout:cancel") { e.preventDefault(); setSignOutOpen(false); return; }
    if (act === "signout:confirm") { e.preventDefault(); setSignOutOpen(false); void signOut(); return; }
    // Footer language switcher — persists locally and (when signed in) to
    // the profile.
    if (act.startsWith("lang:")) {
      e.preventDefault();
      void pickLanguageWithProfileSync(act.slice(5), user, getSupabase());
      return;
    }
    // Contact form submit.
    if (act === "contact:send") { e.preventDefault(); void submitContact(); return; }
    // Router / internal-page actions all preventDefault so anchor hrefs
    // (kept for right-click "open in new tab" affordance) don't full-navigate.
    if (act === "workspace") { e.preventDefault(); navigate("/workspace"); return; }
    // ?next=/ brings the user back to the landing page after signing in
    // (the header then swaps the auth buttons for the account chip).
    if (act === "signin") { e.preventDefault(); navigate("/login?next=/"); return; }
    if (act === "getstarted") { e.preventDefault(); navigate("/login?next=/&mode=sign_up"); return; }
    if (act === "billing:monthly") { e.preventDefault(); setBillingCycle("monthly"); return; }
    if (act === "billing:yearly") { e.preventDefault(); setBillingCycle("yearly"); return; }
    if (act === "signup:solo") { e.preventDefault(); navigate("/signup?plan=solo"); return; }
    if (act === "signup:business") { e.preventDefault(); navigate("/signup?plan=business"); return; }
    if (act.startsWith("scroll:")) { e.preventDefault(); scrollTo(act.slice(7)); return; }
    // Privacy / Cookies / Terms are sections of the combined legal page.
    if ((LEGAL_DOCS as string[]).includes(act)) {
      e.preventDefault();
      goPage("legal");
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          document.getElementById(`legal-${act}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      });
      return;
    }
    if (VALID_PAGES.includes(act as Page)) { e.preventDefault(); goPage(act as Page); return; }
    // Cookie-consent actions.
    if (act === "consent") { e.preventDefault(); setConsentExpanded(true); setConsentOpen(true); return; }
    if (act === "consent:expand") { e.preventDefault(); setConsentExpanded(true); return; }
    if (act === "consent:analytics") { e.preventDefault(); setAnalytics((v) => !v); return; }
    if (act === "consent:marketing") { e.preventDefault(); setMarketing((v) => !v); return; }
    if (act === "consent:acceptAll") { e.preventDefault(); persist(true, true); setAnalytics(true); setMarketing(true); setConsentOpen(false); setConsentExpanded(false); return; }
    if (act === "consent:rejectAll") { e.preventDefault(); persist(false, false); setAnalytics(false); setMarketing(false); setConsentOpen(false); setConsentExpanded(false); return; }
    if (act === "consent:save") { e.preventDefault(); persist(analytics, marketing); setConsentOpen(false); setConsentExpanded(false); return; }
  }, [navigate, goPage, analytics, marketing, mobileMenuOpen, user, signOut, submitContact]);

  const langCode = (i18n.language || "en").slice(0, 2);
  const L = landingStringsFor(langCode);

  // Header and body are rendered as TWO separate innerHTML subtrees rather
  // than one. Header dropdowns (account, mobile burger) toggle
  // often — if they lived in the same memo as the hero's markup, every
  // toggle would replace the whole subtree, destroying and recreating the
  // #cfo-ticker-board placeholder and forcing <HeroTicker>'s portal to
  // remount (a visible flicker/reset of the whole board). Splitting them
  // means a dropdown toggle only touches the header's own small subtree —
  // the body (and the ticker board inside it) is untouched.
  const headerHtml = useMemo(
    () => header(account, page, L, page === "home", mobileMenuOpen),
    [account, page, L, mobileMenuOpen],
  );

  const bodyHtml = useMemo(() => {
    const year = new Date().getFullYear();
    const main =
      page === "contact" ? contactMain(contactRef.current, contactStatus, L)
      : page === "home" ? homeMain(L, account != null, billingCycle, langCode)
      : page === "pricing" ? pricingMain(L, billingCycle)
      : legalMain(L);
    return main
      + footer(year, L, langCode)
      + (consentOpen ? consentModal(consentExpanded, analytics, marketing, L) : "")
      + (signOutOpen ? signoutModal(L) : "");
  }, [account, page, L, langCode, contactStatus, signOutOpen, consentOpen, consentExpanded, analytics, marketing, billingCycle]);

  // The body innerHTML swap above replaces that subtree wholesale, so the
  // placeholder is a fresh node each time `bodyHtml` changes — re-find it
  // and re-target the portal. (Header-only changes, e.g. opening the
  // language menu, don't touch bodyHtml, so the board keeps running.)
  useEffect(() => {
    setTickerBoardHost(rootRef.current?.querySelector<HTMLElement>("#cfo-ticker-board") ?? null);
  }, [bodyHtml]);

  // (The old "Defensible by design" bar-chart animation effect is gone
  // with the decorative peer bars — the proof strip that replaced them is
  // deliberately static.)

  // "Three steps from spreadsheet to action plan" timeline — the circles
  // themselves stay put (no movement); their border/text color lights up
  // from muted to brand-teal, and the title/body text under them fades in,
  // left to right with a deliberately generous gap between steps (0.45s,
  // set on each element's own transition-delay in the markup above). Same
  // direct-DOM-write pattern as the bar chart above, for the same reason.
  useEffect(() => {
    const container = rootRef.current?.querySelector<HTMLElement>("#how-steps");
    const steps = container ? Array.from(container.querySelectorAll<HTMLElement>(".how-step")) : [];
    if (!steps.length) return;
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        steps.forEach((step) => {
          const circle = step.querySelector<HTMLElement>(".how-step-circle");
          if (circle) {
            circle.style.borderColor = "var(--brand)";
            circle.style.color = "var(--brand)";
          }
          const text = step.querySelector<HTMLElement>(".how-step-text");
          if (text) text.style.opacity = "1";
        });
        io.disconnect();
      });
    }, { threshold: 0.3 });
    io.observe(container as HTMLElement);
    return () => io.disconnect();
  }, [bodyHtml]);

  return (
    <>
      <style>{SITE_CSS}</style>
      <div
        ref={rootRef}
        className={`cfo-site${isAtTop ? " at-top" : ""}`}
        onClick={onClick}
        onInput={onInput}
      >
        {/* display:contents so these wrappers don't box-model themselves —
           <header> needs to be sticky relative to the actual page scroll,
           not to a wrapper div sized exactly to its own height (which gives
           it zero room to visibly "stick" before scrolling off with it). */}
        <div style={{ display: "contents" }} dangerouslySetInnerHTML={{ __html: headerHtml }} />
        <div style={{ display: "contents" }} dangerouslySetInnerHTML={{ __html: bodyHtml }} />
      </div>
      {tickerBoardHost ? <HeroTicker boardHost={tickerBoardHost} /> : null}
    </>
  );
}

/**
 * MarketingHeader — the landing page's tab bar as a standalone component,
 * for pages that live OUTSIDE the landing route (e.g. /account/settings).
 * Same markup and dropdowns; internal-page tabs navigate back to the landing
 * route with the matching hash (Landing's applyHash picks it up on mount).
 */
export function MarketingHeader({
  active = null,
  // When true, the header floats over the page (position:fixed, out of
  // flow) instead of sitting sticky-in-flow — for pages like
  // /account/settings that don't want the header pushing their own layout
  // down. The host page must then add its own top padding to compensate.
  fixed = false,
}: { active?: Page | null; fixed?: boolean }) {
  const navigate = useNavigate();
  const { isAuthenticated, displayName, initials, user, signOut } = useAuth();
  const { i18n } = useTranslation();
  // The account chip's open/closed state is a classList.toggle on the
  // persistent .cred-pill DOM node, not React state — see the comment on
  // authArea in header() for why.
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [signOutOpen, setSignOutOpen] = useState(false);

  const account = useMemo<HeaderAccount | null>(() => {
    if (!isAuthenticated) return null;
    const email = user?.email ?? "";
    return {
      name: displayName ?? email.split("@")[0] ?? "Account",
      email,
      initials: initials ?? "?",
    };
  }, [isAuthenticated, displayName, initials, user]);

  const onClick = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    const act = el?.getAttribute("data-act") || "";
    if (act !== "account") (e.currentTarget as HTMLElement).querySelector(".cred-pill.is-open")?.classList.remove("is-open");
    if (mobileMenuOpen && act !== "burger") setMobileMenuOpen(false);
    if (!el) return;
    e.preventDefault();
    if (act === "burger") { setMobileMenuOpen((v) => !v); return; }
    if (act === "home") { navigate("/"); return; }
    if (VALID_PAGES.includes(act as Page)) { navigate(act === "home" ? "/" : `/#/${act}`); return; }
    if ((LEGAL_DOCS as string[]).includes(act)) { navigate(`/#/${act}`); return; }
    if (act.startsWith("scroll:")) { navigate("/"); return; }
    if (act === "workspace") { navigate("/workspace"); return; }
    if (act === "signin") { navigate("/login?next=/"); return; }
    if (act === "getstarted") { navigate("/login?next=/&mode=sign_up"); return; }
    if (act === "account") { el.closest(".cred-pill")?.classList.toggle("is-open"); return; }
    if (act === "account:settings") { navigate("/account/settings"); return; }
    if (act === "account:signout") { setSignOutOpen(true); return; }
    if (act === "signout:cancel") { setSignOutOpen(false); return; }
    if (act === "signout:confirm") { setSignOutOpen(false); void signOut().then(() => navigate("/")); return; }
  }, [navigate, mobileMenuOpen, signOut]);

  // Same "transparent + taller at the very top, fading to the normal
  // frosted bar on scroll" behavior as the landing page's own header — see
  // the matching effect in Landing() for why this toggles a class instead
  // of feeding into the html string.
  const [isAtTop, setIsAtTop] = useState(true);
  useEffect(() => {
    const onScroll = () => setIsAtTop(window.scrollY < 40);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const langCode = (i18n.language || "en").slice(0, 2);
  const L = landingStringsFor(langCode);
  const html =
    header(account, active, L, fixed, mobileMenuOpen) + (signOutOpen ? signoutModal(L) : "");

  return (
    <>
      <style>{SITE_CSS}</style>
      <div
        className={`cfo-site cfo-site--bare z-50${fixed ? "" : " sticky top-0"}${isAtTop ? " at-top" : ""}`}
        onClick={onClick}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </>
  );
}
