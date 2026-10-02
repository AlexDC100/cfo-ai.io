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
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { pickLanguageWithProfileSync, SUPPORTED_LANGUAGES } from "@/i18n";
import { LEGAL_ENTITY, legalDocPath, socialLinks } from "@/lib/legalConfig";
import { openCookieSettings } from "@/components/cfo/CookieBanner";
import { MARQUEE } from "@/lib/markets";
import { landingStringsFor, type LandingStrings } from "./landingStrings";

type Page = "home" | "pricing" | "contact" | "legal";
const VALID_PAGES: Page[] = ["home", "pricing", "contact", "legal"];

// The three legal documents live as SECTIONS of the single legal page.
// Legacy acts/hashes (privacy/cookies/terms) resolve to legal + a scroll.
type LegalDoc = "privacy" | "cookies" | "terms";
const LEGAL_DOCS: LegalDoc[] = ["privacy", "cookies", "terms"];

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
  .cfo-site #cfo-hero-video{opacity:.28 !important}
}
.cfo-site.at-top .site-header-row{height:96px}
/* Reduced motion: the hero video is never started (see the effect in
   <Landing>) — the poster frame stands in. */
@media (prefers-reduced-motion:reduce){
  .cfo-site .btn-grad:hover{transform:none}
}
@keyframes cfo-sectionPulse{0%,100%{box-shadow:inset 0 0 0 0 rgba(75,191,168,0)}50%{box-shadow:inset 0 0 0 3px rgba(75,191,168,.35)}}
.cfo-site .section-pulse{animation:cfo-sectionPulse .8s ease-in-out 2}
/* ── How it works timeline ─────────────────────────────────────────── */
.cfo-site{--warn:#F2B84B} /* design-lint-allow-hex scoped marketing palette */
.cfo-site .hw{list-style:none;margin:44px 0 0;padding:0;display:flex;flex-direction:column}
.cfo-site .hw-step{display:grid;grid-template-columns:64px minmax(0,1fr);gap:18px}
.cfo-site .hw-rail{position:relative;display:flex;flex-direction:column;align-items:center}
.cfo-site .hw-circle{position:relative;z-index:1;width:52px;height:52px;flex-shrink:0;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--bg);border:2px solid var(--rule-strong);color:var(--ink-mute);font-size:21px;font-weight:700;transition:border-color .5s ease,color .5s ease,box-shadow .6s ease}
.cfo-site .hw-line{position:relative;flex:1;width:2px;background:var(--rule);margin:6px 0 -6px;min-height:20px}
.cfo-site .hw-step.is-last .hw-line{display:none}
.cfo-site .hw-line-fill{position:absolute;inset:0;background:linear-gradient(var(--brand),var(--brand-d));transform:scaleY(0);transform-origin:top;transition:transform .7s ease .35s;box-shadow:0 0 8px rgba(75,191,168,.6)}
.cfo-site .hw-dot{position:absolute;left:50%;top:55%;width:10px;height:10px;margin-left:-5px;border-radius:50%;background:var(--rule-strong);transition:background .3s ease .8s,box-shadow .3s ease .8s}
.cfo-site .hw-panel{margin-bottom:18px;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.05fr);gap:22px;align-items:center;border:1px solid var(--rule);background:linear-gradient(135deg,rgba(75,191,168,.05),rgba(16,22,20,.6) 45%);border-radius:18px;padding:22px 22px 22px 26px;opacity:0;transform:translateY(18px);transition:opacity .6s ease,transform .6s ease,border-color .6s ease}
.cfo-site .hw-title{font-size:clamp(19px,2vw,23px);font-weight:700;letter-spacing:.01em;text-transform:uppercase;color:var(--ink);line-height:1.15}
.cfo-site .hw-body{margin:10px 0 16px;font-size:14.5px;color:var(--ink-soft);max-width:420px}
.cfo-site .hw-tag{display:inline-flex;align-items:center;gap:10px;padding:6px 16px 6px 6px;border:1.5px solid var(--brand);border-radius:999px;font-size:13px;font-weight:500;color:var(--ink);box-shadow:0 0 18px -6px rgba(75,191,168,.6)}
.cfo-site .hw-tag-icon{width:26px;height:26px;border-radius:50%;background:var(--brand);color:var(--on-brand);display:inline-flex;align-items:center;justify-content:center}
.cfo-site .hw-drop-icon{color:var(--brand);margin-top:12px}
.cfo-site .hw-drop-icon svg{width:24px;height:24px}
.cfo-site .hw-mock{width:100%;max-width:560px;justify-self:end;border:1px solid var(--rule);background:var(--bg-deep);border-radius:14px;padding:14px 16px;min-height:150px}
.cfo-site .hw-mock-title{font-size:12.5px;font-weight:600;color:var(--ink);margin-bottom:10px}
.cfo-site .hw-drop{border:1.5px dashed var(--rule-strong);border-radius:10px;padding:16px;text-align:center;display:flex;flex-direction:column;align-items:center}
.cfo-site .hw-row{display:grid;grid-template-columns:minmax(0,1fr) auto 52px;gap:16px;align-items:center;font-size:11.5px;color:var(--ink-soft);padding:7px 10px;background:var(--surface);border-radius:7px;margin-top:5px}
.cfo-site .hw-tick{width:15px;height:15px;border-radius:50%;background:var(--brand);color:var(--on-brand);display:inline-flex;align-items:center;justify-content:center}
.cfo-site .hw-tick svg{width:10px;height:10px}
.cfo-site .hw-tab{font-size:11px;padding:6px 12px;border-radius:7px;background:var(--surface);color:var(--ink-soft)}
.cfo-site .hw-tab.is-on{background:var(--brand-deep);color:var(--ink)}
.cfo-site .hw-bars{flex:1;height:86px;display:flex;align-items:flex-end;gap:4px;border-bottom:1px solid var(--rule)}
.cfo-site .hw-bar{flex:1;border-radius:3px 3px 0 0;background:linear-gradient(var(--brand-l),var(--brand-deep));transform:scaleY(0);transform-origin:bottom;transition:transform .5s cubic-bezier(.2,.8,.2,1);transition-delay:calc(.35s + var(--k) * .05s)}
.cfo-site .hw-badge{border:1px solid var(--rule);background:var(--surface);border-radius:10px;padding:8px 12px;flex-shrink:0}
.cfo-site .hw-bubble{font-size:12px;line-height:1.45;border-radius:10px;padding:9px 12px}
.cfo-site .hw-bubble-q{background:var(--brand-deep);color:var(--ink)}
.cfo-site .hw-bubble-a{flex:1;border:1px solid var(--rule);background:var(--surface);color:var(--ink-2)}
.cfo-site .hw-avatar{width:28px;height:28px;flex-shrink:0;border-radius:8px;border:1px solid var(--rule-strong);display:inline-flex;align-items:center;justify-content:center;color:var(--brand)}
.cfo-site .hw-avatar-ai svg{width:16px;height:16px}
.cfo-site .hw-src{font-size:11px;padding:3px 10px;border-radius:999px;background:var(--surface-hi);color:var(--ink-soft)}
.cfo-site .hw-export{display:flex;flex-direction:column;align-items:center;text-align:center;border:1px solid var(--rule);background:var(--surface);border-radius:10px;padding:14px 6px}
.cfo-site .hw-export-kind{font-family:var(--mono);font-size:10px;font-weight:700;letter-spacing:.06em;border:1.5px solid;border-radius:5px;padding:5px 6px}
.cfo-site .hw-pop{opacity:0;transform:translateY(6px);transition:opacity .4s ease,transform .4s ease;transition-delay:calc(.3s + var(--k) * .12s)}
.cfo-site .hw-step.is-in .hw-circle{border-color:var(--brand);color:var(--brand);box-shadow:0 0 0 5px rgba(75,191,168,.12),0 0 22px rgba(75,191,168,.55)}
.cfo-site .hw-step.is-in .hw-panel{opacity:1;transform:none}
.cfo-site .hw-step.is-in .hw-line-fill{transform:scaleY(1)}
.cfo-site .hw-step.is-in .hw-dot{background:var(--brand);box-shadow:0 0 10px rgba(75,191,168,.8)}
.cfo-site .hw-step.is-in .hw-bar{transform:scaleY(1)}
.cfo-site .hw-step.is-in .hw-pop{opacity:1;transform:none}
.cfo-site .hw-flow{margin:14px 0 0 82px;display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid var(--rule);border-radius:16px;padding:18px 22px;background:var(--bg-2)}
.cfo-site .hw-flow-item{display:flex;align-items:center;gap:12px;font-size:13.5px;font-weight:600;color:var(--ink);opacity:0;transform:translateY(6px);transition:opacity .45s ease,transform .45s ease;transition-delay:calc(var(--k) * .25s)}
.cfo-site .hw-flow-text{display:flex;flex-direction:column;line-height:1.2}
.cfo-site .hw-flow-top{font-size:16px;font-weight:600;color:var(--ink)}
.cfo-site .hw-flow-sub{margin-top:3px;font-size:12.5px;font-weight:400;color:var(--ink);opacity:.55}
.cfo-site .hw-flow-icon{width:40px;height:40px;flex-shrink:0;border-radius:10px;display:inline-flex;align-items:center;justify-content:center;color:var(--brand)}
.cfo-site .hw-flow-icon.is-brand{border:1.5px solid var(--brand);box-shadow:0 0 16px -4px rgba(75,191,168,.7)}
.cfo-site .hw-flow-icon svg{width:22px;height:22px}
.cfo-site .hw-cycle{position:relative;width:30px;height:36px;display:inline-block}
.cfo-site .hw-flow-icon .hw-cycle svg{width:30px;height:36px}
.cfo-site .hw-cycle-item{position:absolute;inset:0;opacity:0;animation:cfo-fileCycle 4.5s ease-in-out infinite;animation-delay:calc(var(--j) * 1.5s)}
.cfo-site .hw-cycle-kind{position:absolute;left:50%;bottom:6px;transform:translateX(-50%);font-family:var(--mono);font-size:7.5px;font-weight:700;letter-spacing:.04em}
@keyframes cfo-fileCycle{0%{opacity:0;transform:translateY(4px)}8%{opacity:1;transform:none}30%{opacity:1;transform:none}38%{opacity:0;transform:translateY(-4px)}100%{opacity:0}}
@media (prefers-reduced-motion:reduce){
  .cfo-site .hw-cycle-item{animation:none}
  .cfo-site .hw-cycle-item:first-child{opacity:1}
}
.cfo-site .hw-flow-arrow{color:var(--brand);display:inline-flex;opacity:0;transition:opacity .4s ease;transition-delay:calc(var(--k) * .25s - .1s)}
.cfo-site .hw-flow.is-in .hw-flow-item{opacity:1;transform:none}
.cfo-site .hw-flow.is-in .hw-flow-arrow{opacity:1}
@media (max-width:900px){
  .cfo-site .hw-panel{grid-template-columns:1fr;padding:18px}
  .cfo-site .hw-flow{flex-direction:column;align-items:flex-start;margin-left:0}
  .cfo-site .hw-flow-arrow{transform:rotate(90deg);margin-left:9px}
}
@media (max-width:560px){
  .cfo-site .hw-step{grid-template-columns:40px minmax(0,1fr);gap:12px}
  .cfo-site .hw-circle{width:38px;height:38px;font-size:16px}
  .cfo-site .hw-row{grid-template-columns:minmax(0,1fr) auto 36px;gap:8px;font-size:11px}
  .cfo-site .hw-tab{white-space:nowrap;padding:5px 8px;font-size:10.5px}
  .cfo-site .hw-mock{padding:12px}
}
@media (prefers-reduced-motion:reduce){
  .cfo-site .hw-panel,.cfo-site .hw-pop,.cfo-site .hw-bar,.cfo-site .hw-line-fill,.cfo-site .hw-flow-item,.cfo-site .hw-flow-arrow{transition:none !important}
}
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
  // flow) so the hero video can show through it at the top. Every other
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

// ── Hero background video ─────────────────────────────────────────────
// The hero's ticker board used to be a live React grid (synthetic prices
// ticking every 200ms, digit-scramble, 22s CSS drift) portalled into the
// innerHTML hero. It is now a pre-rendered 22s loop —
// public/landing/hero-board.mp4 + hero-board-poster.jpg — rendered frame by
// frame from that component on a virtual clock (so no dropped frames), with
// a 1s crossfade at the seam so the loop is invisible. Same look, none of
// the per-tick React/DOM work. The live implementation (HeroTicker) is in
// git history if the video ever needs re-rendering.
const HERO_VIDEO_SRC = "/landing/hero-board.mp4";
const HERO_VIDEO_POSTER = "/landing/hero-board-poster.jpg";

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

// ── "How it works" — six-step timeline ──────────────────────────────
// Left rail of numbered, glowing circles joined by a line; each step is a
// panel with copy on the left and a small illustrative mock on the right
// (decorative numbers, like the hero dashboard). Steps start hidden and
// are revealed ONE AT A TIME by the effect in <Landing> (adds .is-in);
// each mock's inner pieces then stagger in off that class via CSS.
const HW_ICON = {
  upload: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>`,
  check: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`,
  gear: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>`,
  chart: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>`,
  chat: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.8 7L4 20l1.1-4.6A8 8 0 1 1 21 12z"/></svg>`,
  download: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 20h16"/></svg>`,
  up: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 19L19 5M9 5h10v10"/></svg>`,
  warn: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5L1.5 21h21L12 2.5zm-1 7h2v6h-2v-6zm0 7.5h2v2h-2v-2z"/></svg>`,
  file: `<svg width="34" height="40" viewBox="0 0 22 26" fill="none" aria-hidden="true"><path d="M2 3a2 2 0 0 1 2-2h10l6 6v16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V3z" fill="var(--surface-hi)" stroke="var(--rule-strong)"/><path d="M14 1v6h6" stroke="var(--rule-strong)"/></svg>`,
  arrow: `<svg width="22" height="12" viewBox="0 0 22 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 6h19M15 1l5 5-5 5"/></svg>`,
};

const howMock = (L: LandingStrings, i: number): string => {
  const m = L.how.mock;
  const card = (title: string, inner: string) =>
    `<div class="hw-mock">${title ? `<div class="hw-mock-title">${title}</div>` : ""}${inner}</div>`;
  switch (i) {
    case 0: {
      const chips = [["XLSX", "#2E9E63"], ["CSV", "var(--ink-soft)"], ["PDF", "var(--alert)"]] // design-lint-allow-hex file-type tint
        .map(([k, c], j) => `<span class="hw-pop" style="--k:${j};display:inline-flex;flex-direction:column;align-items:center;gap:4px"><span style="position:relative;display:inline-flex">${HW_ICON.file}<span style="position:absolute;left:50%;bottom:7px;transform:translateX(-50%);font-family:var(--mono);font-size:8.5px;font-weight:700;letter-spacing:.04em;color:${c}">${k}</span></span></span>`).join("");
      return card("", `<div class="hw-drop"><div style="display:flex;gap:14px;justify-content:center">${chips}</div><div class="hw-pop hw-drop-icon" style="--k:3">${HW_ICON.upload}</div><div class="hw-pop" style="--k:4;font-size:12px;color:var(--ink-soft);margin-top:4px">${m.drop}</div><div class="hw-pop" style="--k:4;font-size:11.5px;color:var(--brand);text-decoration:underline">${m.browse}</div></div>`);
    }
    case 1: {
      const codes = ["701", "607", "628", "4111"];
      return card(m.mapping, m.mapRows.map((r, j) =>
        `<div class="hw-row hw-pop" style="--k:${j}"><span>${r}</span><span style="display:inline-flex;align-items:center;gap:6px;color:var(--brand)"><span class="hw-tick">${HW_ICON.check}</span>${m.mapped}</span><span style="font-family:var(--mono);color:var(--ink-mute);text-align:right">${codes[j]}</span></div>`).join(""));
    }
    case 2: {
      const bars = [18, 26, 22, 34, 30, 42, 38, 50, 46, 58, 66, 80];
      const tabs = m.tabs.map((t, j) => `<span class="hw-tab${j === 0 ? " is-on" : ""}">${t}</span>`).join("");
      const chart = `<div class="hw-bars">${bars.map((h, j) => `<span class="hw-bar" style="--k:${j};height:${h}%"></span>`).join("")}</div>`;
      const badge = `<div class="hw-badge hw-pop" style="--k:12"><div style="font-size:10.5px;color:var(--ink-soft)">${m.revenue}</div><div style="font-size:17px;font-weight:600;color:var(--ink);font-variant-numeric:tabular-nums">12.4M</div><div style="font-size:12px;color:var(--brand);font-weight:600">+18%</div></div>`;
      return card(m.statements, `<div style="display:flex;gap:6px;margin-bottom:12px">${tabs}</div><div style="display:flex;gap:12px;align-items:flex-end">${chart}${badge}</div>`);
    }
    case 3: {
      const icons = [[HW_ICON.up, "var(--brand)"], [HW_ICON.up, "var(--brand)"], [HW_ICON.check, "var(--brand)"], [HW_ICON.warn, "var(--warn)"]];
      return card(m.insights, m.insightRows.map((r, j) =>
        `<div class="hw-pop" style="--k:${j};display:flex;align-items:center;gap:10px;padding:6px 2px;font-size:12.5px;color:var(--ink-2)"><span style="color:${icons[j][1]};display:inline-flex">${icons[j][0]}</span>${r}</div>`).join(""));
    }
    case 4:
      return card("", `<div class="hw-pop" style="--k:0;display:flex;justify-content:flex-end;gap:8px;align-items:center"><div class="hw-bubble hw-bubble-q">${m.question}</div><span class="hw-avatar">${HW_ICON.chat}</span></div>
        <div class="hw-pop" style="--k:3;display:flex;gap:8px;align-items:flex-start;margin-top:10px"><span class="hw-avatar hw-avatar-ai">${LOGO}</span><div class="hw-bubble hw-bubble-a">${m.answer}<div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px"><span class="hw-src">${m.sources}</span><span style="color:var(--ink-mute);display:inline-flex">${HW_ICON.download}</span></div></div></div>`);
    default: {
      const tint = ["var(--warn)", "#2E9E63", "var(--brand)"]; // design-lint-allow-hex file-type tint
      return card("", `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">${m.exports.map((e, j) =>
        `<div class="hw-export hw-pop" style="--k:${j}"><span class="hw-export-kind" style="color:${tint[j]};border-color:${tint[j]}">${e.kind}</span><span style="font-size:12px;color:var(--ink-2);margin-top:8px">${e.label}</span></div>`).join("")}</div>`);
    }
  }
};

const howSection = (L: LandingStrings) => {
  const tagIcons = [HW_ICON.upload, HW_ICON.check, HW_ICON.gear, HW_ICON.chart, HW_ICON.chat, HW_ICON.download];
  // First flow icon cycles XLSX → CSV → PDF forever, each fading in over
  // the last (pure CSS — see .hw-cycle).
  const kinds = [["XLSX", "#2E9E63"], ["CSV", "var(--ink-soft)"], ["PDF", "var(--alert)"]]; // design-lint-allow-hex file-type tint
  const fileCycle = `<span class="hw-cycle">${kinds.map(([k, c], j) =>
    `<span class="hw-cycle-item" style="--j:${j}">${HW_ICON.file}<span class="hw-cycle-kind" style="color:${c}">${k}</span></span>`).join("")}</span>`;
  const flowIcons = [fileCycle, LOGO, HW_ICON.chart, HW_ICON.check];
  return `
  <section id="how" style="max-width:var(--maxw);margin:0 auto;padding:70px 24px;scroll-margin-top:88px">
    ${eyebrow(L.how.eyebrow)}
    <h2 style="margin-top:16px;font-family:var(--serif);font-weight:400;font-size:clamp(30px,4.5vw,46px);line-height:1.06;letter-spacing:-.02em;max-width:760px">${L.how.t1}<span class="grad-text">${L.how.thl}</span></h2>
    <p style="margin-top:14px;font-size:15px;color:var(--ink-soft);max-width:640px">${L.how.sub}</p>
    <ol id="how-steps" class="hw">
      ${L.how.steps.map((step, i) => `
      <li class="hw-step${i === L.how.steps.length - 1 ? " is-last" : ""}">
        <div class="hw-rail" aria-hidden="true"><span class="hw-circle">${i + 1}</span><span class="hw-line"><span class="hw-line-fill"></span><span class="hw-dot"></span></span></div>
        <div class="hw-panel">
          <div class="hw-copy">
            <h3 class="hw-title">${step.title}</h3>
            <p class="hw-body">${step.body}</p>
            <span class="hw-tag"><span class="hw-tag-icon">${tagIcons[i]}</span>${step.tag}</span>
          </div>
          ${howMock(L, i)}
        </div>
      </li>`).join("")}
    </ol>
    <div id="how-flow" class="hw-flow">
      ${L.how.flow.map((f, i) => `${i ? `<span class="hw-flow-arrow" style="--k:${i}">${HW_ICON.arrow}</span>` : ""}<div class="hw-flow-item" style="--k:${i}"><span class="hw-flow-icon${i === 1 ? " is-brand" : ""}">${flowIcons[i]}</span><span class="hw-flow-text"><span class="hw-flow-top">${f.top}</span>${f.sub ? `<span class="hw-flow-sub">${f.sub}</span>` : ""}</span></div>`).join("")}
    </div>
  </section>`;
};

const homeMain = (L: LandingStrings, signedIn: boolean, billingCycle: BillingCycle = "monthly", langCode = "en") => `
<main>
  <section style="position:relative;overflow:hidden;background:var(--bg-deep);min-height:100vh">
    <!-- Video layer at .4 — with the readability overlays above
         it, the board behind the headline zone stays well below the AA
         contrast floor for the F5F5F5 display text. -->
    <video id="cfo-hero-video" aria-hidden="true" tabindex="-1" muted loop playsinline preload="auto" disablepictureinpicture poster="${HERO_VIDEO_POSTER}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center top;z-index:0;opacity:.4;filter:brightness(1.15) saturate(1.1);pointer-events:none"><source src="${HERO_VIDEO_SRC}" type="video/mp4"></video>
    <div aria-hidden="true" style="position:absolute;inset:0;z-index:1;pointer-events:none;background:radial-gradient(ellipse 55% 50% at 50% 42%,rgba(7,12,10,.82) 0%,rgba(7,12,10,.55) 55%,rgba(7,12,10,.12) 100%)"></div>
    <div aria-hidden="true" style="position:absolute;inset:0;z-index:1;pointer-events:none;background:linear-gradient(to bottom,rgba(7,12,10,.7),transparent 16%,transparent 78%,var(--bg-deep))"></div>
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
          <div style="color:var(--brand);display:flex;align-items:center;justify-content:center;font-size:40px;line-height:1;flex-shrink:0">${["▤", "◎", "✦"][i]}</div>
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

  ${howSection(L)}

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

// THE LEGAL TEXT USED TO LIVE HERE, AND IT NO LONGER DOES.
//
// Until 2026-09-06 this file carried its own hand-written HTML copies of the
// Privacy Policy, the Cookie Policy and the Terms — roughly 150 lines of
// prose with `[Company Legal Name]` / `[Registered Address, City, Country]`
// placeholders still in them, published live at `/#/legal`. That was a
// SECOND version of three documents with legal force, drifting silently from
// `lib/legalTerms.ts`, which was itself a third.
//
// All of it is deleted. The owner's reviewed text (content/legal/*.md) is
// rendered once, at /privacy, /terms and /cookies, and the marketing legal
// page below is now an index that links to those URLs. One document, one
// address, one rendering.

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
    <div style="border:1px solid var(--rule);background:var(--surface);border-radius:16px;padding:24px"><div style="font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.14em;color:var(--ink-mute)">${L.contact.office}</div><div style="margin-top:8px;font-size:14px;color:var(--ink-2)">${esc(LEGAL_ENTITY.denumire ?? "")}<br>${esc(LEGAL_ENTITY.sediu ?? "")}<br>CUI ${esc(LEGAL_ENTITY.cui ?? "")} · ${esc(LEGAL_ENTITY.regCom ?? "")}</div></div>
  </div>
</main>`;
}

// Legal — ONE page holding all three documents (Privacy / Cookies / Terms)
// as stacked sections, with a jump-nav at the top. The old standalone pages
// were folded in here; legacy acts/hashes still land on the right section.
const legalMain = (L: LandingStrings) => `
<main style="padding-bottom:64px">
  <div style="max-width:820px;margin:0 auto;padding:64px 24px 0;text-align:center">
    ${eyebrow(L.legal.eyebrow)}
    <h1 style="margin-top:16px;font-family:var(--serif);font-weight:400;font-size:clamp(32px,5vw,48px);line-height:1.05;letter-spacing:-.02em">${L.legal.title}</h1>
    <p style="margin-top:14px;font-size:16px;color:var(--ink-soft)">${L.legal.subtitle}</p>
  </div>
  <div style="max-width:820px;margin:36px auto 0;padding:0 24px;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px">
    ${[
      ["privacy", L.legal.privacy],
      ["cookies", L.legal.cookies],
      ["terms", L.legal.terms],
    ].map(([act, label]) => `
    <button data-act="${act}" class="card-hl" style="border:1px solid var(--rule);background:var(--surface);border-radius:16px;padding:24px;display:block;text-align:left;color:inherit;cursor:pointer;font:inherit;width:100%">
      <div style="font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.14em;color:var(--ink-mute)">Document</div>
      <div style="margin-top:8px;font-size:17px;color:var(--ink)">${label}</div>
      <div style="margin-top:8px;font-size:12.5px;color:var(--brand)">cfo-ai.io/${act}</div>
    </button>`).join("")}
  </div>
  <div style="max-width:820px;margin:28px auto 0;padding:0 24px;font-size:12.5px;color:var(--ink-mute);line-height:1.7">
    ${esc(LEGAL_ENTITY.denumire ?? "")} · CUI ${esc(LEGAL_ENTITY.cui ?? "")} · ${esc(LEGAL_ENTITY.regCom ?? "")}<br>
    ${esc(LEGAL_ENTITY.sediu ?? "")}
  </div>
</main>`;

/**
 * The company-identification block, on the marketing site.
 *
 * A Romanian company has to state its name, registration number and
 * registered office on its published communications (Law 26/1990 art. 29).
 * Until now this footer named no legal entity at all — only "CFO AI", which
 * is a product name, not an operator. The values come from
 * `lib/legalConfig`'s LEGAL_ENTITY, i.e. from content/legal/entity.json, the
 * same file the app footer and the prerendered legal pages read; the block is
 * rendered here as an HTML string only because this whole page is.
 */
function legalIdentityBlock(langCode: string) {
  const e = LEGAL_ENTITY;
  const identity = [e.denumire, e.cui ? `CUI ${e.cui}` : null, e.regCom]
    .filter(Boolean)
    .map((x) => esc(String(x)))
    .join(" \u00b7 ");
  return `
    <div style="margin-top:14px;font-size:11.5px;line-height:1.7;color:var(--ink-mute)">
      <div style="font-family:var(--mono)">${identity}</div>
      <div>${esc(e.sediu ?? "")}</div>
    </div>${socialRow(langCode)}`;
}

/**
 * The social row, BENEATH the identity block and never inside it: the block
 * above is a legal declaration a Romanian company must make, and this is a
 * marketing affordance. Mixing them would put a brand link inside a
 * statutory statement.
 *
 * Same data as the app footer's <SocialLinks>, through the same
 * `socialLinks()` accessor, so the two surfaces cannot show different
 * handles. Rendered as an HTML string only because this whole page is.
 *
 * A handle that is null, empty or half-typed RENDERS NOTHING — not a dead
 * link, not a greyed glyph. `instagram` is null today because the brief
 * that requested this carried "[INSTAGRAM URL — fill in]", and shipping a
 * guess is precisely the class of bug that put "[Company Legal Name]" into
 * this footer on 2026-09-08.
 */
function socialRow(langCode: string) {
  const links = socialLinks();
  if (links.length === 0) return "";
  const ro = langCode.toLowerCase().startsWith("ro");
  const label = (key: string) =>
    key === "x"
      ? (ro ? "Parachain Group pe X" : "Parachain Group on X")
      : (ro ? "Parachain Group pe Instagram" : "Parachain Group on Instagram");
  const glyph = (key: string) =>
    key === "x"
      ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`
      : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1.1" fill="currentColor" stroke="none"/></svg>`;
  // 44px tap target on mobile; the glyph stays 20px and the padding carries
  // the rest, so the icon does not grow on a phone.
  const item = ({ key, href }: { key: string; href: string }) =>
    `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(label(key))}" data-social="${esc(key)}" style="display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;color:var(--ink-mute);text-decoration:none" onmouseover="this.style.color='var(--brand)'" onmouseout="this.style.color='var(--ink-mute)'">${glyph(key)}</a>`;
  return `
    <div data-social-row style="margin-top:6px;display:flex;gap:2px;justify-content:center" class="cfo-social-row">
      ${links.map(item).join("")}
    </div>
    <style>@media (min-width:640px){.cfo-social-row{justify-content:flex-end !important}}</style>`;
}

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
      <span>${esc(
        L.footer.rights
          .replace("{year}", String(year))
          // The entity is declared ONCE, in content/legal/entity.json via
          // `legalConfig`. This line used to carry the literal string
          // "[Company Legal Name]" and shipped to production that way,
          // directly above the footer block that renders the real entity
          // from LEGAL_ENTITY — the exact duplication legalConfig exists
          // to prevent, surviving in the one spot the refactor missed.
          // A Romanian entity name ends in "S.R.L." — a full stop of its
          // own — and the sentence that follows adds another, so the
          // first deploy of this line read "PARACHAIN CAPITAL S.R.L..".
          // Trim the entity's terminal stop and let the sentence supply it.
          .replace("{company}", (LEGAL_ENTITY.denumire ?? "").replace(/\.\s*$/, "")),
      )}</span>
      ${langSwitcher}
      <span>${L.footer.madeIn}</span>
    </div>
    ${legalIdentityBlock(langCode)}
  </div>
</footer>`;
}

// THE COOKIE MODAL USED TO LIVE HERE. It was deleted on 2026-09-06 and
// replaced by <CookieBanner /> (components/cfo/CookieBanner), mounted once in
// App.tsx so EVERY route gets it — this one only ever covered the marketing
// home page, so anyone landing straight on /pricing, /login or a shared
// /dashboard link was never asked at all. It also offered a "Marketing"
// toggle, a category the published Cookie Policy does not describe.
// The footer's "Cookie settings" link now opens the shared banner.

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

  const rootRef = useRef<HTMLDivElement>(null);

  // Header fade — transparent at the very top of any landing page, fading
  // to the frosted sticky bar as soon as you scroll (on the home page this
  // also reveals the hero's background video through it). This is deliberately
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
  // Cookie consent is no longer this page's business — <CookieBanner /> in
  // App.tsx owns the prompt and lib/cookieConsent owns the `cfoai_consent`
  // key it always wrote to. What remains here is hash deep-linking.
  useEffect(() => {
    const applyHash = () => {
      const h = (location.hash || "").replace(/^#\/?/, "").trim();
      if ((LEGAL_DOCS as string[]).includes(h)) {
        // Legacy deep links (#/privacy etc.) now REDIRECT to the real URL.
        // Anyone holding one of these — an old email, a bookmark, a link in
        // someone's compliance folder — lands on the published document
        // rather than on a page section that no longer exists.
        navigate(legalDocPath(h as LegalDoc), { replace: true });
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
    // Privacy / Cookies / Terms each have a REAL URL now (/privacy, /terms,
    // /cookies — prerendered at build time, see vite.config.ts). They used to
    // be anchors inside this page's own copy of the documents; that copy is
    // gone. react-router navigation, not a full load, so the marketing site
    // stays a single-page app.
    if ((LEGAL_DOCS as string[]).includes(act)) {
      e.preventDefault();
      navigate(legalDocPath(act as LegalDoc));
      return;
    }
    if (VALID_PAGES.includes(act as Page)) { e.preventDefault(); goPage(act as Page); return; }
    // Cookie-consent actions.
    if (act === "consent") { e.preventDefault(); openCookieSettings(); return; }
  }, [navigate, goPage, mobileMenuOpen, user, signOut, submitContact]);

  const langCode = (i18n.language || "en").slice(0, 2);
  const L = landingStringsFor(langCode);

  // Header and body are rendered as TWO separate innerHTML subtrees rather
  // than one. Header dropdowns (account, mobile burger) toggle
  // often — if they lived in the same memo as the hero's markup, every
  // toggle would replace the whole subtree, recreating the hero video and
  // restarting it from frame 0 (a visible reset). Splitting them means a
  // dropdown toggle only touches the header's own small subtree — the body
  // (and the hero video inside it) is untouched.
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
      + (signOutOpen ? signoutModal(L) : "");
  }, [account, page, L, langCode, contactStatus, signOutOpen, billingCycle]);

  // Hero video: started from here rather than an `autoplay` attribute so
  // prefers-reduced-motion can keep it on its poster frame. The body
  // innerHTML swap replaces the <video> each time `bodyHtml` changes, so
  // re-find it then. play() rejects when the browser refuses autoplay
  // (e.g. Low Power Mode on iOS) — the poster stays, which is fine.
  useEffect(() => {
    const video = rootRef.current?.querySelector<HTMLVideoElement>("#cfo-hero-video");
    if (!video) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    video.muted = true; // the attribute alone doesn't set the property on innerHTML-parsed media
    video.play().catch(() => {});
  }, [bodyHtml]);

  // (The old "Defensible by design" bar-chart animation effect is gone
  // with the decorative peer bars — the proof strip that replaced them is
  // deliberately static.)

  // "How it works" timeline — steps reveal strictly in order, one every
  // STEP_GAP_MS, as far down as the reader has scrolled: a step that
  // enters view first releases any earlier step still hidden, so jumping
  // straight to step 5 still plays 1→5 rather than popping 5 alone. Each
  // step's inner mock staggers in off its own .is-in via CSS. The flow
  // strip under the timeline plays once the last step is in. Same
  // direct-DOM-write pattern as the rest of this file — the body is an
  // innerHTML swap, so React state wouldn't survive it anyway.
  useEffect(() => {
    const root = rootRef.current;
    const steps = root ? Array.from(root.querySelectorAll<HTMLElement>("#how-steps .hw-step")) : [];
    const flow = root?.querySelector<HTMLElement>("#how-flow");
    if (!steps.length) return;
    const reveal = (el: HTMLElement) => el.classList.add("is-in");
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      steps.forEach(reveal);
      if (flow) reveal(flow);
      return;
    }
    const STEP_GAP_MS = 550;
    let target = -1; // highest step index that has entered view
    let shown = -1; // highest step index revealed so far
    let timer: number | undefined;
    let lastAt = -Infinity; // when the previous step was revealed
    const pump = () => {
      timer = undefined;
      if (shown >= target) return;
      const wait = lastAt + STEP_GAP_MS - performance.now();
      if (wait > 0) {
        timer = window.setTimeout(pump, wait);
        return;
      }
      shown += 1;
      lastAt = performance.now();
      reveal(steps[shown]);
      if (shown === steps.length - 1 && flow) {
        window.setTimeout(() => reveal(flow), STEP_GAP_MS);
      }
      if (shown < target) timer = window.setTimeout(pump, STEP_GAP_MS);
    };
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        target = Math.max(target, steps.indexOf(entry.target as HTMLElement));
        io.unobserve(entry.target);
      });
      if (timer === undefined) pump();
    }, { threshold: 0.35, rootMargin: "0px 0px -8% 0px" });
    steps.forEach((step) => io.observe(step));
    return () => {
      io.disconnect();
      if (timer !== undefined) window.clearTimeout(timer);
    };
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
    if ((LEGAL_DOCS as string[]).includes(act)) { navigate(legalDocPath(act as LegalDoc)); return; }
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
