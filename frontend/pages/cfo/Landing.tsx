// CFO AI marketing website.
//
// Ported from the "CFO AI Website" design canvas: a dark, self-contained
// marketing site (home / pricing / privacy / cookies / terms / contact) plus
// a GDPR cookie-consent modal. The design's palette already matches our
// teal (#5CD3C5) / greyscale / red system.
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

import { type MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

type Page = "home" | "pricing" | "privacy" | "cookies" | "terms" | "contact";
const VALID_PAGES: Page[] = ["home", "pricing", "privacy", "cookies", "terms", "contact"];

const CONSENT_KEY = "cfoai_consent";

// ── Scoped design system + hover rules ────────────────────────────────────
const SITE_CSS = `
.cfo-site{
  --bg:#0A0A0A; --bg-2:#0F0F0F; --surface:#141414; --surface-hi:#1C1C1C;
  --ink:#F5F5F5; --ink-2:#DBDBDB; --ink-soft:#ABABAB; --ink-mute:#8C8C8C;
  --rule:#292929; --rule-soft:#1A1A1A; --rule-strong:#3D3D3D;
  --brand:#5CD3C5; --brand-d:#2AA89B; --brand-l:#8FE3D9; --brand-deep:#1B7268;
  --alert:#FF6B6B;
  --serif:"Instrument Serif",Georgia,serif;
  --sans:"Inter Variable","Inter",system-ui,sans-serif;
  --mono:"JetBrains Mono",ui-monospace,monospace;
  --grad:linear-gradient(135deg,#1B7268 0%,#22897E 25%,#2AA89B 55%,#45C6B8 80%,#5CD3C5 100%);
  --grad-text:linear-gradient(120deg,#2AA89B 0%,#5CD3C5 55%,#8FE3D9 100%);
  --maxw:1200px;
  min-height:100vh;background:var(--bg);color:var(--ink);
  font-family:var(--sans);font-size:16px;line-height:1.55;
  -webkit-font-smoothing:antialiased;font-feature-settings:"tnum" 1;
}
.cfo-site *{box-sizing:border-box}
.cfo-site a{color:var(--brand);text-decoration:none;transition:color .15s ease;cursor:pointer}
.cfo-site a:hover{color:var(--brand-l)}
.cfo-site p{margin:0 0 1em}
.cfo-site h1,.cfo-site h2,.cfo-site h3,.cfo-site h4{margin:0}
.cfo-site ::selection{background:rgba(92,211,197,.28);color:#fff}
.cfo-site summary::-webkit-details-marker{display:none}
.cfo-site summary::marker{content:""}
.cfo-site .grad-text{background:var(--grad-text);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent}
.cfo-site .btn-grad{transition:filter .15s ease,transform .15s ease}
.cfo-site .btn-grad:hover{filter:brightness(1.08);transform:translateY(-1px)}
.cfo-site .btn-ghost2{transition:border-color .15s ease,background .15s ease}
.cfo-site .btn-ghost2:hover{border-color:var(--ink-mute);background:var(--surface-hi)}
.cfo-site .hv-brand:hover{border-color:var(--brand);color:var(--brand)}
.cfo-site .card-hl{transition:border-color .15s ease}
.cfo-site .card-hl:hover{border-color:rgba(92,211,197,.4)}
.cfo-site nav button:hover,.cfo-site nav a:hover{color:var(--ink)}
.cfo-site footer a:hover,.cfo-site footer button:hover{color:var(--ink)}
.cfo-site .navbtn{background:none;border:none;cursor:pointer;font-family:var(--mono);font-size:11.5px;text-transform:uppercase;letter-spacing:.14em;color:var(--ink-soft)}
@keyframes cfo-floatglow{0%,100%{opacity:.5;transform:translateY(0)}50%{opacity:.8;transform:translateY(-12px)}}
`;

const LOGO = `<svg width="26" height="26" viewBox="0 0 64 64" aria-hidden="true"><path d="M 30 4 L 4 20 L 4 44 L 30 60 L 30 50 L 14 41 L 14 23 L 30 14 Z" fill="#5CD3C5"></path><path d="M 38 14 L 60 60 L 48 60 L 38 38 Z" fill="#F4F6F8"></path><rect x="34" y="34" width="14" height="3" fill="#F4F6F8"></rect></svg>`;

function eyebrow(label: string) {
  return `<div style="display:inline-flex;align-items:center;gap:12px;font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.18em;color:var(--ink-soft);font-weight:500"><span style="width:7px;height:7px;background:var(--brand);display:inline-block"></span>${label}</div>`;
}

const HEADER = `
<header style="position:sticky;top:0;z-index:50;backdrop-filter:blur(18px);background:rgba(10,10,10,.72);border-bottom:1px solid var(--rule-soft)">
  <div style="max-width:var(--maxw);margin:0 auto;padding:0 24px;height:66px;display:flex;align-items:center;gap:24px;flex-wrap:wrap">
    <button data-act="home" style="display:inline-flex;align-items:center;gap:11px;background:none;border:none;cursor:pointer;padding:0">
      ${LOGO}
      <span style="display:inline-flex;flex-direction:column;line-height:1"><span style="font-size:15px;font-weight:600;letter-spacing:-.01em;color:var(--ink)">CFO <span style="color:var(--brand)">AI</span></span></span>
      <span style="font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.18em;color:var(--ink-mute);padding-left:12px;border-left:1px solid var(--rule);height:22px;display:inline-flex;align-items:center">Financial Intelligence</span>
    </button>
    <nav style="display:flex;align-items:center;gap:26px;margin-left:8px;flex-wrap:wrap">
      <button class="navbtn" data-act="scroll:product">Product</button>
      <button class="navbtn" data-act="pricing">Pricing</button>
      <button class="navbtn" data-act="scroll:faq">FAQ</button>
      <button class="navbtn" data-act="contact">Contact</button>
      <button class="navbtn" data-act="app" style="color:var(--brand)">App</button>
    </nav>
    <div style="flex:1"></div>
    <button class="navbtn" data-act="signin">Sign in</button>
    <a href="/signup" data-act="signup" class="btn-grad" style="display:inline-flex;align-items:center;gap:7px;height:38px;padding:0 18px;border-radius:999px;background:var(--grad);color:#fff;font-size:13px;font-weight:500;box-shadow:0 4px 16px -6px rgba(92,211,197,.5)">Get started — free →</a>
  </div>
</header>`;

const HOME = `
<main>
  <section style="position:relative;overflow:hidden">
    <div aria-hidden="true" style="position:absolute;top:-160px;left:-120px;width:620px;height:620px;border-radius:50%;background:rgba(92,211,197,.11);filter:blur(120px);pointer-events:none"></div>
    <div aria-hidden="true" style="position:absolute;top:-120px;right:-80px;width:500px;height:500px;border-radius:50%;background:rgba(43,168,155,.10);filter:blur(120px);pointer-events:none;animation:cfo-floatglow 9s ease-in-out infinite"></div>
    <div style="position:relative;max-width:1000px;margin:0 auto;padding:72px 24px 76px;display:flex;flex-direction:column;align-items:center;text-align:center">
      ${eyebrow("CFO AI · Built for private businesses")}
      <h1 style="margin-top:26px;font-family:var(--serif);font-weight:400;font-size:clamp(40px,6.4vw,66px);line-height:1.04;letter-spacing:-.025em;max-width:920px;color:var(--ink)">Turn a trial balance into a <span class="grad-text">CFO-grade analysis</span> in 90 seconds.</h1>
      <p style="margin-top:22px;font-size:clamp(16px,2vw,18px);line-height:1.6;color:var(--ink-soft);max-width:660px">Upload your books. CFO AI reconstructs your P&amp;L, balance sheet, cash flow, 100+ ratios, valuation and credit score — then benchmarks you against public companies your size, in your sector. Named comparisons, not vague industry averages.</p>
      <div style="margin-top:34px;display:flex;flex-wrap:wrap;gap:14px;justify-content:center">
        <a href="/signup" data-act="signup" class="btn-grad" style="display:inline-flex;align-items:center;gap:8px;height:52px;padding:0 28px;border-radius:999px;background:var(--grad);color:#fff;font-weight:500;font-size:15px;box-shadow:0 10px 30px -10px rgba(92,211,197,.55)">Start free — no credit card →</a>
        <button data-act="pricing" class="btn-ghost2" style="display:inline-flex;align-items:center;height:52px;padding:0 24px;border-radius:999px;background:transparent;border:1px solid var(--rule-strong);color:var(--ink);font-weight:500;font-size:15px;cursor:pointer;font-family:inherit">See pricing</button>
      </div>
      <ul style="margin:26px 0 0;padding:0;list-style:none;display:flex;flex-wrap:wrap;gap:8px 22px;justify-content:center;font-size:12.5px;color:var(--ink-soft)">
        <li style="display:inline-flex;align-items:center;gap:7px"><span style="color:var(--brand)">✓</span> 30-day trial</li>
        <li style="display:inline-flex;align-items:center;gap:7px"><span style="color:var(--brand)">✓</span> RAS / EU filings supported</li>
        <li style="display:inline-flex;align-items:center;gap:7px"><span style="color:var(--brand)">✓</span> Cancel anytime</li>
      </ul>
      <div style="margin-top:52px;width:100%;max-width:900px;border-radius:20px;border:1px solid var(--rule);background:var(--surface);overflow:hidden;box-shadow:0 50px 120px -40px rgba(0,0,0,.8);text-align:left">
        <div style="display:flex;align-items:center;gap:8px;padding:12px 18px;border-bottom:1px solid var(--rule-soft);background:var(--bg-2)">
          <span style="width:10px;height:10px;border-radius:50%;background:#2E2E2E"></span><span style="width:10px;height:10px;border-radius:50%;background:#2E2E2E"></span><span style="width:10px;height:10px;border-radius:50%;background:#2E2E2E"></span>
          <span style="margin-left:12px;font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.14em;color:var(--ink-mute)">cfo-ai · today's briefing · 06:14</span>
        </div>
        <div style="padding:24px;display:grid;grid-template-columns:2fr 1fr;gap:20px">
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px">
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
      <p style="margin-top:22px;font-size:11.5px;color:var(--ink-mute);max-width:520px">Illustrative dashboard. AI-assisted analysis — final decisions remain with your management team.</p>
    </div>
  </section>

  <section style="border-top:1px solid var(--rule-soft);border-bottom:1px solid var(--rule-soft);background:var(--bg-2)">
    <div style="max-width:var(--maxw);margin:0 auto;padding:26px 24px;display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:22px;text-align:center">
      <div><div style="font-family:var(--serif);font-size:30px" class="grad-text">≤1%</div><div style="font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.14em;color:var(--ink-soft);margin-top:4px">Balance-sheet drift</div></div>
      <div><div style="font-family:var(--serif);font-size:30px" class="grad-text">100+</div><div style="font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.14em;color:var(--ink-soft);margin-top:4px">Financial ratios</div></div>
      <div><div style="font-family:var(--serif);font-size:30px" class="grad-text">16,000+</div><div style="font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.14em;color:var(--ink-soft);margin-top:4px">Public-company peers</div></div>
      <div><div style="font-family:var(--serif);font-size:30px" class="grad-text">90s</div><div style="font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.14em;color:var(--ink-soft);margin-top:4px">Upload to report</div></div>
    </div>
  </section>

  <section id="product" style="max-width:var(--maxw);margin:0 auto;padding:80px 24px 20px;scroll-margin-top:88px">
    <div style="text-align:center;max-width:680px;margin:0 auto 42px">
      ${eyebrow("Four flagship modules")}
      <h2 style="margin-top:16px;font-family:var(--serif);font-weight:400;font-size:clamp(30px,4.5vw,46px);line-height:1.06;letter-spacing:-.02em">One platform. <span class="grad-text">Your books, or any public company.</span></h2>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px">
      ${[
        ["▤", "Trial balance → board-ready report", "Financial Statement Intelligence", "Ministry-of-Finance filings, accountant exports, annual reports — from any European country. Auto-detected, normalized, ratioed, valued and explained."],
        ["◎", "Nasdaq tickers → analysis", "Public Company Intelligence", "Search 16,000+ US-listed companies on official SEC EDGAR data. Same dashboard, ratios, valuation and CFO chat as your private books — add any as a benchmark peer."],
        ["▦", "ERP exports → cash forecast", "Invoice Intelligence", "Customer &amp; supplier concentration, margin by client, VAT reconciliation and payment timing — surfaced as dedicated tabs inside your statements."],
        ["✦", "Ask questions → grounded answers", "Ask CFO AI", "A financial copilot grounded in your numbers. Ask why margin moved, what a ratio means, or what to do next — with the reasoning and source lines shown."],
      ].map(([icon, kicker, title, body]) => `
      <div class="card-hl" style="border:1px solid var(--rule);background:var(--surface);border-radius:18px;padding:26px;display:flex;flex-direction:column">
        <div style="width:44px;height:44px;border-radius:12px;background:rgba(92,211,197,.12);color:var(--brand);display:flex;align-items:center;justify-content:center;font-size:20px">${icon}</div>
        <div style="font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.14em;color:var(--ink-mute);margin-top:18px">${kicker}</div>
        <h3 style="font-family:var(--serif);font-weight:400;font-size:21px;margin-top:6px">${title}</h3>
        <p style="margin-top:8px;font-size:13.5px;color:var(--ink-soft);flex:1">${body}</p>
      </div>`).join("")}
    </div>
  </section>

  <section style="max-width:var(--maxw);margin:0 auto;padding:70px 24px">
    ${eyebrow("How it works")}
    <h2 style="margin-top:16px;font-family:var(--serif);font-weight:400;font-size:clamp(30px,4.5vw,46px);line-height:1.06;letter-spacing:-.02em;max-width:680px">Three steps from spreadsheet to <span class="grad-text">action plan.</span></h2>
    <div style="margin-top:38px;display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:18px">
      ${[
        ["01", "Upload your books", "Trial balance, bilanț, P&amp;L or balance sheet — Excel, CSV, or PDF. Columns and RAS accounts are mapped automatically."],
        ["02", "CFO AI computes the economics", "P&amp;L, balance sheet, cash flow, 100+ ratios, EBITDA variants, Altman Z, valuation and credit score — reconciled to your source to ≤1% drift."],
        ["03", "You act with context", "Ranked, quantified recommendations plus named public-company peers — export to HTML, an 8-sheet Excel model, or a board summary."],
      ].map(([n, title, body]) => `
      <div style="border:1px solid var(--rule);background:var(--bg-2);border-radius:18px;padding:28px"><div style="font-family:var(--serif);font-size:30px" class="grad-text">${n}</div><h3 style="font-family:var(--serif);font-weight:400;font-size:21px;margin-top:16px">${title}</h3><p style="margin-top:8px;font-size:13.5px;color:var(--ink-soft)">${body}</p></div>`).join("")}
    </div>
  </section>

  <section style="border-top:1px solid var(--rule-soft);background:var(--bg-2)">
    <div style="max-width:var(--maxw);margin:0 auto;padding:74px 24px;display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:44px;align-items:center">
      <div>
        ${eyebrow("Defensible by design")}
        <h2 style="margin-top:16px;font-family:var(--serif);font-weight:400;font-size:clamp(28px,4vw,42px);line-height:1.08;letter-spacing:-.02em">Numbers a lender, auditor or investor can trust.</h2>
        <p style="margin-top:16px;font-size:15px;color:var(--ink-soft)">The RAS-compliant engine reconciles all eight calibration fixtures to ≤1% balance-sheet drift — five of eight to exactly 0.00% — and reproduces filed-P&amp;L EBITDA across three named variants (reported, strict, cash). When a source file has an imbalance, CFO AI surfaces it explicitly rather than smoothing it over.</p>
        <ul style="margin:20px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:12px">
          <li style="display:flex;gap:12px;align-items:flex-start"><span style="color:var(--brand);margin-top:2px">✓</span><div><strong style="color:var(--ink)">Reproducible.</strong> <span style="color:var(--ink-soft)">The same trial balance always produces the same output.</span></div></li>
          <li style="display:flex;gap:12px;align-items:flex-start"><span style="color:var(--brand);margin-top:2px">✓</span><div><strong style="color:var(--ink)">Traceable.</strong> <span style="color:var(--ink-soft)">Every number links back to the source line it came from.</span></div></li>
          <li style="display:flex;gap:12px;align-items:flex-start"><span style="color:var(--brand);margin-top:2px">✓</span><div><strong style="color:var(--ink)">Honest about uncertainty.</strong> <span style="color:var(--ink-soft)">Approximations are marked, never buried.</span></div></li>
        </ul>
      </div>
      <div style="border:1px solid var(--rule);background:var(--surface);border-radius:18px;padding:26px">
        <div style="font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.14em;color:var(--ink-mute);margin-bottom:16px">Peer benchmark · EBITDA margin</div>
        <div style="display:flex;flex-direction:column;gap:12px">
          <div style="display:flex;align-items:center;gap:12px"><span style="width:78px;font-family:var(--mono);font-size:12px;color:var(--brand);font-weight:600">Your Co.</span><div style="flex:1;height:24px;border-radius:6px;background:var(--bg-2);overflow:hidden"><div style="width:64%;height:100%;background:var(--brand)"></div></div><span style="font-size:12px;color:var(--ink-2);width:44px;text-align:right">11.4%</span></div>
          <div style="display:flex;align-items:center;gap:12px"><span style="width:78px;font-family:var(--mono);font-size:12px;color:var(--ink-soft)">Peer A</span><div style="flex:1;height:24px;border-radius:6px;background:var(--bg-2);overflow:hidden"><div style="width:52%;height:100%;background:var(--rule-strong)"></div></div><span style="font-size:12px;color:var(--ink-soft);width:44px;text-align:right">9.2%</span></div>
          <div style="display:flex;align-items:center;gap:12px"><span style="width:78px;font-family:var(--mono);font-size:12px;color:var(--ink-soft)">Peer B</span><div style="flex:1;height:24px;border-radius:6px;background:var(--bg-2);overflow:hidden"><div style="width:81%;height:100%;background:var(--rule-strong)"></div></div><span style="font-size:12px;color:var(--ink-soft);width:44px;text-align:right">14.3%</span></div>
          <div style="display:flex;align-items:center;gap:12px"><span style="width:78px;font-family:var(--mono);font-size:12px;color:var(--ink-soft)">Peer C</span><div style="flex:1;height:24px;border-radius:6px;background:var(--bg-2);overflow:hidden"><div style="width:47%;height:100%;background:var(--rule-strong)"></div></div><span style="font-size:12px;color:var(--ink-soft);width:44px;text-align:right">8.3%</span></div>
        </div>
        <p style="margin:18px 0 0;font-size:12px;color:var(--ink-mute);border-top:1px solid var(--rule-soft);padding-top:14px">You sit in the top quartile of your matched peer set on operating profitability.</p>
      </div>
    </div>
  </section>

  <section style="max-width:var(--maxw);margin:0 auto;padding:74px 24px">
    ${eyebrow("Who it's for")}
    <h2 style="margin-top:16px;font-family:var(--serif);font-weight:400;font-size:clamp(30px,4.5vw,46px);line-height:1.06;letter-spacing:-.02em;max-width:680px">Built for whoever reads the <span class="grad-text">numbers.</span></h2>
    <div style="margin-top:36px;display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px">
      ${[
        ["Founders &amp; owners", "Understand your own financials the way an analyst would — and see exactly where you stand against real peers."],
        ["Finance teams", "Turn a month-end trial balance into board-ready statements, ratios and a credit score without rebuilding a model."],
        ["Investors &amp; analysts", "Run due diligence on private targets and public comparables through the same engine, side by side."],
        ["Advisors &amp; accountants", "Deliver CFO-grade analyses across a portfolio of client companies — consistently, in minutes each."],
        ["Lenders", "Screen credit with Altman Z″, coverage ratios and covenant-ready strict EBITDA — with the source reconciliation shown."],
        ["Family offices", "Review multiple group entities and holdings on one consistent framework, including NAV for asset-heavy vehicles."],
      ].map(([title, body]) => `
      <div style="border:1px solid var(--rule);background:var(--bg-2);border-radius:16px;padding:24px"><div style="font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:var(--brand)">${title}</div><p style="margin-top:10px;font-size:14px;color:var(--ink-2)">${body}</p></div>`).join("")}
    </div>
  </section>

  <section id="faq" style="border-top:1px solid var(--rule-soft);background:var(--bg-2);scroll-margin-top:88px">
    <div style="max-width:820px;margin:0 auto;padding:74px 24px">
      <div style="text-align:center;margin-bottom:36px">
        ${eyebrow("Questions")}
        <h2 style="margin-top:16px;font-family:var(--serif);font-weight:400;font-size:clamp(28px,4vw,42px);line-height:1.06;letter-spacing:-.02em">Frequently asked</h2>
      </div>
      <div style="display:flex;flex-direction:column;gap:12px">
        ${[
          ["What file formats can I upload?", "Trial balances (balanță de verificare), balance sheets, P&amp;L statements and annual reports as Excel, CSV or PDF. Exports from SAGA, WinMENTOR and standard Romanian and European accounting software are supported, with accounts mapped automatically."],
          ["How accurate is the analysis?", "On clean trial balances, the engine reconciles balance-sheet totals to within 1% drift across its eight calibration fixtures — five of eight to exactly 0.00%. It computes three named EBITDA variants that match byte-for-byte between the methodology layer and the code. It is a decision-support tool, not a substitute for professional judgement."],
          ["Is my financial data secure?", `Your data is stored on EU-region infrastructure with row-level security so only your account can access it. We never sell your data. See our <button data-act="privacy" style="background:none;border:none;padding:0;color:var(--brand);cursor:pointer;font:inherit">Privacy Policy</button> for the full detail on sub-processors and your rights under the GDPR.`],
          ["Do you offer a free trial?", "Yes — every plan starts with a 30-day trial. Founding members pay just €1 for their first month. You can cancel any time before renewal."],
          ["Which countries and accounting standards are supported?", "The engine is calibrated for Romanian RAS (OMFP 1802) today, with a country-agnostic canonical schema designed to extend to other European charts of accounts. Public-company analysis covers 16,000+ US-listed companies via official SEC EDGAR data."],
          ["Is this financial or investment advice?", `No. CFO AI produces AI-assisted analysis and decision support. It is not financial, investment, legal, tax or accounting advice, and final decisions remain with you and your management team. See our <button data-act="terms" style="background:none;border:none;padding:0;color:var(--brand);cursor:pointer;font:inherit">Terms of Service</button>.`],
        ].map(([q, a]) => `
        <details style="border:1px solid var(--rule);background:var(--surface);border-radius:14px;padding:18px 20px"><summary style="cursor:pointer;font-weight:600;font-size:15px;color:var(--ink);list-style:none">${q}</summary><p style="margin:12px 0 0;font-size:14px;color:var(--ink-soft)">${a}</p></details>`).join("")}
      </div>
    </div>
  </section>

  <section style="position:relative;overflow:hidden;border-top:1px solid var(--rule-soft)">
    <div aria-hidden="true" style="position:absolute;inset:0;background:radial-gradient(ellipse at center,rgba(92,211,197,.10),transparent 62%);pointer-events:none"></div>
    <div style="position:relative;max-width:820px;margin:0 auto;padding:88px 24px;text-align:center">
      <h2 style="font-family:var(--serif);font-weight:400;font-size:clamp(34px,5.5vw,58px);line-height:1.03;letter-spacing:-.03em">See your business the way a <span class="grad-text">CFO would.</span></h2>
      <p style="margin-top:18px;font-size:16px;color:var(--ink-soft);max-width:520px;margin-left:auto;margin-right:auto">Upload your first trial balance and get a full analysis in under five minutes. No credit card required.</p>
      <div style="margin-top:32px;display:flex;flex-wrap:wrap;gap:14px;justify-content:center">
        <a href="/signup" data-act="signup" class="btn-grad" style="display:inline-flex;align-items:center;gap:8px;height:52px;padding:0 28px;border-radius:999px;background:var(--grad);color:#fff;font-weight:500;font-size:15px;box-shadow:0 10px 30px -10px rgba(92,211,197,.55)">Get started — free →</a>
        <a href="/login" data-act="signin" class="btn-ghost2" style="display:inline-flex;align-items:center;height:52px;padding:0 24px;border-radius:999px;background:transparent;border:1px solid var(--rule-strong);color:var(--ink);font-weight:500;font-size:15px">Sign in</a>
      </div>
    </div>
  </section>
</main>`;

const PRICING = `
<main style="max-width:var(--maxw);margin:0 auto;padding:64px 24px 40px">
  <div style="text-align:center;max-width:680px;margin:0 auto 44px">
    ${eyebrow("Pricing")}
    <h1 style="margin-top:16px;font-family:var(--serif);font-weight:400;font-size:clamp(34px,5vw,52px);line-height:1.05;letter-spacing:-.025em">Simple plans that <span class="grad-text">scale with you.</span></h1>
    <p style="margin-top:16px;font-size:16px;color:var(--ink-soft)">Every plan starts with a 30-day trial. Founding members pay €1 for their first month. Cancel anytime.</p>
  </div>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:18px;align-items:stretch;max-width:1040px;margin:0 auto">
    <div style="border:1px solid var(--rule);background:var(--surface);border-radius:20px;padding:30px;display:flex;flex-direction:column">
      <div style="font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.16em;color:var(--ink-soft)">Solo</div>
      <div style="margin-top:14px;display:flex;align-items:baseline;gap:6px"><span style="font-family:var(--serif);font-size:52px;line-height:1;color:var(--ink)">€19.99</span><span style="font-size:14px;color:var(--ink-soft)">/mo</span></div>
      <div style="font-size:12.5px;color:var(--ink-mute);margin-top:6px">or €199 / year — save €41</div>
      <p style="margin-top:14px;font-size:13.5px;color:var(--ink-soft)">Individual investors, freelance analysts and founders doing personal due diligence.</p>
      <a href="/signup?plan=solo" data-act="signup:solo" class="hv-brand" style="margin-top:22px;display:inline-flex;align-items:center;justify-content:center;height:46px;border-radius:999px;background:transparent;border:1px solid var(--rule-strong);color:var(--ink);font-weight:500;font-size:14px;transition:border-color .15s,color .15s">Start Solo trial</a>
      <ul style="margin:24px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:11px;font-size:13.5px;color:var(--ink-2)">
        ${["1 company · 10 uploads / month", "P&amp;L, balance sheet &amp; cash flow", "Essential ratios &amp; EBITDA", "Altman Z bankruptcy screen", "30 Ask CFO AI messages / month", "12-month history · email support"].map(x => `<li style="display:flex;gap:10px"><span style="color:var(--brand)">✓</span> ${x}</li>`).join("")}
      </ul>
    </div>
    <div style="border:1.5px solid var(--brand);background:var(--surface);border-radius:20px;padding:30px;display:flex;flex-direction:column;position:relative;box-shadow:0 24px 60px -30px rgba(92,211,197,.5)">
      <span style="position:absolute;top:-11px;left:30px;font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.14em;font-weight:600;color:#04110F;background:var(--brand);padding:4px 12px;border-radius:999px">Most popular</span>
      <div style="font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.16em;color:var(--brand)">Business</div>
      <div style="margin-top:14px;display:flex;align-items:baseline;gap:6px"><span style="font-family:var(--serif);font-size:52px;line-height:1;color:var(--ink)">€59</span><span style="font-size:14px;color:var(--ink-soft)">/mo</span></div>
      <div style="font-size:12.5px;color:var(--ink-mute);margin-top:6px">or €590 / year — save €118</div>
      <p style="margin-top:14px;font-size:13.5px;color:var(--ink-soft)">SMB owners, internal finance teams, real-estate holdings and family-group portfolios.</p>
      <a href="/signup?plan=business" data-act="signup:business" class="btn-grad" style="margin-top:22px;display:inline-flex;align-items:center;justify-content:center;height:46px;border-radius:999px;background:var(--grad);color:#fff;font-weight:500;font-size:14px">Start Business trial</a>
      <ul style="margin:24px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:11px;font-size:13.5px;color:var(--ink-2)">
        <li style="display:flex;gap:10px"><span style="color:var(--brand)">✓</span> 5 companies · 2 users · 25 uploads / month</li>
        <li style="display:flex;gap:10px"><span style="color:var(--brand)">✓</span> <strong>Everything in Solo, plus:</strong></li>
        ${["Full 100+ ratio suite", "Altman Z + Piotroski F-score", "Valuation suite &amp; NAV cascade", "Industry benchmarks &amp; peer comparison", "Recommendations engine &amp; monthly reports", "100 AI messages/mo · share links · live chat"].map(x => `<li style="display:flex;gap:10px"><span style="color:var(--brand)">✓</span> ${x}</li>`).join("")}
      </ul>
    </div>
    <div style="border:1px solid var(--rule);background:var(--surface);border-radius:20px;padding:30px;display:flex;flex-direction:column">
      <div style="font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.16em;color:var(--ink-soft)">Professional</div>
      <div style="margin-top:14px;display:flex;align-items:baseline;gap:6px"><span style="font-family:var(--serif);font-size:44px;line-height:1;color:var(--ink)">Custom</span></div>
      <div style="font-size:12.5px;color:var(--ink-mute);margin-top:6px">Contact sales — priced per contract</div>
      <p style="margin-top:14px;font-size:13.5px;color:var(--ink-soft)">Advisory firms, accountants, multi-entity holdings and M&amp;A boutiques managing 5+ companies.</p>
      <button data-act="contact" class="hv-brand" style="margin-top:22px;display:inline-flex;align-items:center;justify-content:center;height:46px;border-radius:999px;background:transparent;border:1px solid var(--rule-strong);color:var(--ink);font-weight:500;font-size:14px;cursor:pointer;font-family:inherit;transition:border-color .15s,color .15s">Contact sales</button>
      <ul style="margin:24px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:11px;font-size:13.5px;color:var(--ink-2)">
        <li style="display:flex;gap:10px"><span style="color:var(--brand)">✓</span> Up to 25 companies · 10 users</li>
        <li style="display:flex;gap:10px"><span style="color:var(--brand)">✓</span> <strong>Everything in Business, plus:</strong></li>
        ${["Multi-entity consolidated view", "API access", "Dedicated onboarding", "Priority phone support · 4h SLA"].map(x => `<li style="display:flex;gap:10px"><span style="color:var(--brand)">✓</span> ${x}</li>`).join("")}
      </ul>
    </div>
  </div>
  <p style="text-align:center;margin-top:28px;font-size:12.5px;color:var(--ink-mute)">All prices exclude VAT where applicable. Overage documents are billed per-document and always confirmed before processing.</p>
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
<main style="max-width:820px;margin:0 auto;padding:56px 24px 40px">
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
</main>`;

const COOKIES = `
<main style="max-width:820px;margin:0 auto;padding:56px 24px 40px">
  ${legalHeader("Cookie Policy")}
  <div style="margin-top:30px;font-size:14.5px;color:var(--ink-2);line-height:1.7">
    <p>Cookies and similar technologies (including browser <em>localStorage</em>) are small pieces of data stored on your device. We use them to keep you signed in, remember your preferences, and — only with your consent — to understand usage and measure marketing.</p>
    ${h2("Categories we use")}
    <div style="display:flex;flex-direction:column;gap:14px;margin-top:6px">
      <div style="border:1px solid var(--rule);background:var(--bg-2);border-radius:12px;padding:18px"><div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><strong style="color:var(--ink)">Strictly necessary</strong><span style="font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:var(--brand);border:1px solid rgba(92,211,197,.4);padding:3px 9px;border-radius:999px">Always on</span></div><p style="margin:8px 0 0;font-size:13.5px;color:var(--ink-soft)">Authentication session, security, load balancing and your cookie-consent choice. The site cannot function without these, so they do not require consent.</p></div>
      <div style="border:1px solid var(--rule);background:var(--bg-2);border-radius:12px;padding:18px"><div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><strong style="color:var(--ink)">Analytics</strong><span style="font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:var(--ink-mute);border:1px solid var(--rule-strong);padding:3px 9px;border-radius:999px">Optional</span></div><p style="margin:8px 0 0;font-size:13.5px;color:var(--ink-soft)">Help us understand which features are used so we can improve the product. Set only if you accept analytics cookies.</p></div>
      <div style="border:1px solid var(--rule);background:var(--bg-2);border-radius:12px;padding:18px"><div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><strong style="color:var(--ink)">Marketing</strong><span style="font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:var(--ink-mute);border:1px solid var(--rule-strong);padding:3px 9px;border-radius:999px">Optional</span></div><p style="margin:8px 0 0;font-size:13.5px;color:var(--ink-soft)">Measure the effectiveness of our campaigns and show relevant messaging. Set only if you accept marketing cookies.</p></div>
    </div>
    ${h2("Managing your choices")}
    <p>You gave (or declined) consent when you first visited. You can change your preferences at any time using the button below or via "Cookie settings" in the footer. You can also block or delete cookies in your browser settings.</p>
    <button data-act="consent" class="btn-grad" style="margin-top:8px;display:inline-flex;align-items:center;height:44px;padding:0 22px;border-radius:999px;background:var(--grad);color:#fff;font-weight:500;font-size:14px;cursor:pointer;font-family:inherit">Open cookie settings</button>
  </div>
</main>`;

const TERMS = `
<main style="max-width:820px;margin:0 auto;padding:56px 24px 40px">
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
</main>`;

const CONTACT = `
<main style="max-width:760px;margin:0 auto;padding:64px 24px 40px">
  <div style="text-align:center;margin-bottom:40px">
    ${eyebrow("Contact")}
    <h1 style="margin-top:16px;font-family:var(--serif);font-weight:400;font-size:clamp(32px,5vw,48px);line-height:1.05;letter-spacing:-.02em">Talk to us.</h1>
    <p style="margin-top:14px;font-size:16px;color:var(--ink-soft)">Whether you're evaluating CFO AI for a portfolio of companies or just have a question — we'd like to hear from you.</p>
  </div>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px">
    <a href="mailto:sales@cfo-ai.io" class="card-hl" style="border:1px solid var(--rule);background:var(--surface);border-radius:16px;padding:24px;display:block;color:inherit"><div style="font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.14em;color:var(--ink-mute)">Sales &amp; Professional plan</div><div style="margin-top:8px;font-size:16px;color:var(--brand)">sales@cfo-ai.io</div><p style="margin:8px 0 0;font-size:13px;color:var(--ink-soft)">Custom limits, multi-entity and API access.</p></a>
    <a href="mailto:support@cfo-ai.io" class="card-hl" style="border:1px solid var(--rule);background:var(--surface);border-radius:16px;padding:24px;display:block;color:inherit"><div style="font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.14em;color:var(--ink-mute)">Support</div><div style="margin-top:8px;font-size:16px;color:var(--brand)">support@cfo-ai.io</div><p style="margin:8px 0 0;font-size:13px;color:var(--ink-soft)">Help with your account, uploads or analyses.</p></a>
    <a href="mailto:privacy@cfo-ai.io" class="card-hl" style="border:1px solid var(--rule);background:var(--surface);border-radius:16px;padding:24px;display:block;color:inherit"><div style="font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.14em;color:var(--ink-mute)">Privacy &amp; data</div><div style="margin-top:8px;font-size:16px;color:var(--brand)">privacy@cfo-ai.io</div><p style="margin:8px 0 0;font-size:13px;color:var(--ink-soft)">Exercise your GDPR rights or ask about data.</p></a>
    <div style="border:1px solid var(--rule);background:var(--surface);border-radius:16px;padding:24px"><div style="font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.14em;color:var(--ink-mute)">Registered office</div><div style="margin-top:8px;font-size:14px;color:var(--ink-2)">[Company Legal Name]<br>[Registered Address]<br>[City, Country]</div></div>
  </div>
  <div style="margin-top:32px;text-align:center"><a href="/signup" data-act="signup" class="btn-grad" style="display:inline-flex;align-items:center;gap:8px;height:50px;padding:0 26px;border-radius:999px;background:var(--grad);color:#fff;font-weight:500;font-size:15px">Or just start free →</a></div>
</main>`;

function footer(year: number) {
  return `
<footer style="border-top:1px solid var(--rule-soft);background:var(--bg-2)">
  <div style="max-width:var(--maxw);margin:0 auto;padding:44px 24px 30px">
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:32px">
      <div style="min-width:200px">
        <div style="display:inline-flex;align-items:center;gap:10px">${LOGO}<span style="font-size:15px;font-weight:600;color:var(--ink)">CFO <span style="color:var(--brand)">AI</span></span></div>
        <p style="margin-top:14px;font-size:13px;color:var(--ink-soft);max-width:260px">CFO-grade financial analysis and benchmarking for private businesses.</p>
      </div>
      <div>
        <div style="font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.14em;color:var(--ink-mute);margin-bottom:14px">Product</div>
        <div style="display:flex;flex-direction:column;gap:10px;font-size:13.5px">
          <button data-act="home" style="background:none;border:none;padding:0;text-align:left;color:var(--ink-soft);cursor:pointer;font:inherit">Overview</button>
          <button data-act="pricing" style="background:none;border:none;padding:0;text-align:left;color:var(--ink-soft);cursor:pointer;font:inherit">Pricing</button>
          <button data-act="app" style="background:none;border:none;padding:0;text-align:left;color:var(--ink-soft);cursor:pointer;font:inherit">Open the app</button>
          <a href="/signup" data-act="signup" style="color:var(--ink-soft)">Get started</a>
        </div>
      </div>
      <div>
        <div style="font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.14em;color:var(--ink-mute);margin-bottom:14px">Legal</div>
        <div style="display:flex;flex-direction:column;gap:10px;font-size:13.5px">
          <button data-act="privacy" style="background:none;border:none;padding:0;text-align:left;color:var(--ink-soft);cursor:pointer;font:inherit">Privacy Policy</button>
          <button data-act="cookies" style="background:none;border:none;padding:0;text-align:left;color:var(--ink-soft);cursor:pointer;font:inherit">Cookie Policy</button>
          <button data-act="terms" style="background:none;border:none;padding:0;text-align:left;color:var(--ink-soft);cursor:pointer;font:inherit">Terms of Service</button>
          <button data-act="consent" style="background:none;border:none;padding:0;text-align:left;color:var(--ink-soft);cursor:pointer;font:inherit">Cookie settings</button>
        </div>
      </div>
      <div>
        <div style="font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.14em;color:var(--ink-mute);margin-bottom:14px">Contact</div>
        <div style="display:flex;flex-direction:column;gap:10px;font-size:13.5px">
          <button data-act="contact" style="background:none;border:none;padding:0;text-align:left;color:var(--ink-soft);cursor:pointer;font:inherit">Contact us</button>
          <a href="mailto:sales@cfo-ai.io" style="color:var(--ink-soft)">sales@cfo-ai.io</a>
          <a href="mailto:support@cfo-ai.io" style="color:var(--ink-soft)">support@cfo-ai.io</a>
        </div>
      </div>
    </div>
    <div style="margin-top:36px;padding-top:22px;border-top:1px solid var(--rule-soft);display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between;align-items:center;font-size:12px;color:var(--ink-mute)">
      <span>© ${year} CFO AI · [Company Legal Name]. All rights reserved.</span>
      <span>Made in the EU · GDPR-compliant</span>
    </div>
  </div>
</footer>`;
}

function consentModal(expanded: boolean, analytics: boolean, marketing: boolean) {
  const on = "#2AA89B", off = "#3D3D3D";
  const track = (v: boolean) => (v ? on : off);
  const knob = (v: boolean) => (v ? "21px" : "3px");
  const toggleRow = (act: string, title: string, desc: string, v: boolean) => `
      <button data-act="${act}" style="display:flex;justify-content:space-between;align-items:center;gap:12px;border:1px solid var(--rule);background:var(--bg-2);border-radius:12px;padding:14px 16px;cursor:pointer;text-align:left;font:inherit"><div><div style="font-size:13.5px;font-weight:600;color:var(--ink)">${title}</div><div style="font-size:12px;color:var(--ink-mute)">${desc}</div></div><span style="width:42px;height:24px;border-radius:999px;flex-shrink:0;position:relative;transition:background .15s;background:${track(v)}"><span style="position:absolute;top:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:left .15s;left:${knob(v)}"></span></span></button>`;
  return `
<div style="position:fixed;inset:0;z-index:90;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.5);backdrop-filter:blur(2px);padding:0 16px 16px">
  <div style="width:100%;max-width:640px;border:1px solid var(--rule-strong);background:var(--surface);border-radius:18px;padding:24px;box-shadow:0 30px 80px -20px rgba(0,0,0,.8)">
    <div style="display:flex;align-items:center;gap:10px"><span style="width:8px;height:8px;background:var(--brand);display:inline-block"></span><strong style="font-size:16px;color:var(--ink)">We value your privacy</strong></div>
    <p style="margin-top:12px;font-size:13.5px;color:var(--ink-soft)">We use strictly necessary cookies to run CFO AI, and — only with your consent — optional analytics and marketing cookies. You can accept all, reject optional ones, or choose. Read our <button data-act="cookies" style="background:none;border:none;padding:0;color:var(--brand);cursor:pointer;font:inherit">Cookie Policy</button>.</p>
    ${expanded ? `
    <div style="margin-top:16px;display:flex;flex-direction:column;gap:10px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;border:1px solid var(--rule);background:var(--bg-2);border-radius:12px;padding:14px 16px"><div><div style="font-size:13.5px;font-weight:600;color:var(--ink)">Strictly necessary</div><div style="font-size:12px;color:var(--ink-mute)">Required for sign-in, security and saving your choice.</div></div><span style="font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--brand)">Always on</span></div>
      ${toggleRow("consent:analytics", "Analytics", "Helps us improve the product.", analytics)}
      ${toggleRow("consent:marketing", "Marketing", "Measures campaigns and relevance.", marketing)}
    </div>` : ""}
    <div style="margin-top:18px;display:flex;flex-wrap:wrap;gap:10px">
      <button data-act="consent:acceptAll" class="btn-grad" style="flex:1;min-width:130px;height:44px;border-radius:999px;background:var(--grad);color:#fff;font-weight:500;font-size:14px;border:none;cursor:pointer;font-family:inherit">Accept all</button>
      <button data-act="consent:rejectAll" style="flex:1;min-width:130px;height:44px;border-radius:999px;background:transparent;border:1px solid var(--rule-strong);color:var(--ink);font-weight:500;font-size:14px;cursor:pointer;font-family:inherit">Reject optional</button>
      ${expanded
        ? `<button data-act="consent:save" class="hv-brand" style="flex:1;min-width:130px;height:44px;border-radius:999px;background:var(--surface-hi);border:1px solid var(--rule-strong);color:var(--ink);font-weight:500;font-size:14px;cursor:pointer;font-family:inherit;transition:border-color .15s,color .15s">Save choices</button>`
        : `<button data-act="consent:expand" style="flex:1;min-width:130px;height:44px;border-radius:999px;background:transparent;border:1px solid var(--rule);color:var(--ink-soft);font-weight:500;font-size:14px;cursor:pointer;font-family:inherit">Customise</button>`}
    </div>
  </div>
</div>`;
}

const MAINS: Record<Page, string> = {
  home: HOME, pricing: PRICING, privacy: PRIVACY, cookies: COOKIES, terms: TERMS, contact: CONTACT,
};

export default function Landing() {
  const navigate = useNavigate();
  const [page, setPage] = useState<Page>("home");
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
      const h = (location.hash || "").replace(/^#\/?/, "").trim() as Page;
      setPage(VALID_PAGES.includes(h) ? h : "home");
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
        document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  };

  const onClick = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!el) return;
    const act = el.getAttribute("data-act") || "";
    // Router / internal-page actions all preventDefault so anchor hrefs
    // (kept for right-click "open in new tab" affordance) don't full-navigate.
    if (act === "app") { e.preventDefault(); navigate("/dashboard"); return; }
    if (act === "signin") { e.preventDefault(); navigate("/login"); return; }
    if (act === "signup") { e.preventDefault(); navigate("/signup"); return; }
    if (act === "signup:solo") { e.preventDefault(); navigate("/signup?plan=solo"); return; }
    if (act === "signup:business") { e.preventDefault(); navigate("/signup?plan=business"); return; }
    if (act.startsWith("scroll:")) { e.preventDefault(); scrollTo(act.slice(7)); return; }
    if (VALID_PAGES.includes(act as Page)) { e.preventDefault(); goPage(act as Page); return; }
    // Cookie-consent actions.
    if (act === "consent") { e.preventDefault(); setConsentExpanded(true); setConsentOpen(true); return; }
    if (act === "consent:expand") { e.preventDefault(); setConsentExpanded(true); return; }
    if (act === "consent:analytics") { e.preventDefault(); setAnalytics((v) => !v); return; }
    if (act === "consent:marketing") { e.preventDefault(); setMarketing((v) => !v); return; }
    if (act === "consent:acceptAll") { e.preventDefault(); persist(true, true); setAnalytics(true); setMarketing(true); setConsentOpen(false); setConsentExpanded(false); return; }
    if (act === "consent:rejectAll") { e.preventDefault(); persist(false, false); setAnalytics(false); setMarketing(false); setConsentOpen(false); setConsentExpanded(false); return; }
    if (act === "consent:save") { e.preventDefault(); persist(analytics, marketing); setConsentOpen(false); setConsentExpanded(false); return; }
  }, [navigate, goPage, analytics, marketing]);

  const html = useMemo(() => {
    const year = new Date().getFullYear();
    return HEADER + MAINS[page] + footer(year) + (consentOpen ? consentModal(consentExpanded, analytics, marketing) : "");
  }, [page, consentOpen, consentExpanded, analytics, marketing]);

  return (
    <>
      <style>{SITE_CSS}</style>
      <div
        className="cfo-site"
        onClick={onClick}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </>
  );
}
