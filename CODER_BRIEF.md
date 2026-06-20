# Coder onboarding brief — cfo-ai.io

> **Welcome.** This is a Romanian SME financial-analysis platform running live at https://cfo-ai.io. The codebase is mid-flight — there's a long stack of shipped work AND a long backlog of pending work. Read this brief end-to-end before opening your first PR. Then read [CLAUDE.md](CLAUDE.md) for the deep operating rules.
>
> **Default language:** code + docs are English. Operator notes are sometimes Romanian; either is fine for PR descriptions.

---

## 0. First 30 minutes — bootstrap

```bash
git clone https://github.com/AlexDC100/cfo-ai.io.git
cd cfo-ai.io
# Backend (Python 3.11+)
python -m venv .venv && source .venv/bin/activate
pip install -e .
# Frontend (Node 20+)
cd scandi-desk-main && npm install
```

- **Env files**: copy `.env.example` → `.env` and ask Alex for the real values (Supabase URL/anon/service-role, Stripe sk, Anthropic key, etc.). **DO NOT commit `.env`** — it's in `.gitignore` for a reason.
- **Read [CLAUDE.md](CLAUDE.md)** root file — top to bottom. It defines the project methodology, RAS account cheat sheet, and the locked operating rules.
- **Smoke-test prod**: hit https://cfo-ai.io/api/health — should return `{"ok": true, "mode": "LIVE"}`.

---

## 1. Where we are right now

| | |
|---|---|
| **Prod URL** | https://cfo-ai.io |
| **Health** | `mode=LIVE` (Stripe live mode, real billing) |
| **Default branch** | `main` |
| **Latest commit** | `c81456e` — snapshot before opening to coder |
| **Workflow** | PR → review → squash-merge to `main` → deploy via `./scripts/deploy.sh` |
| **Customers** | Calibrated on 6 Romanian SMEs (Scandia food/retail/frozen/real-estate/Sibiu, Carniprod, Agras, EEI real-estate, Trading_analysis) |

---

## 2. What's shipped + working in prod

Major subsystems already running in production:

- **F5.0 CFO AI Learn** — Recursive popovers on every clickable number, formula trace from EBITDA → EBIT → Revenue → source RAS account, plain-English layer, Cmd+K Glossary, page guides, top-header Learning Hub menu, mobile-hardened popover shell. (Phases 1-9 complete; mobile fix shipped 2026-06-16.)
- **F3.x canonical envelope** (mostly shipped, see §6 open work) — `assembled_canonical_v1` with methodology YAML, detection envelope, fan-out routing.
- **F4.0–F4.7** — Canonical schema v1, methodology layer, second-country pack skeleton, deprecation warnings.
- **NASDAQ + PUB-200** — Public-company intelligence with 200 tickers, price charts, stock detail drawer, peer comparison.
- **Stripe live billing** — Test mode + live mode both working, Customer Portal, usage metering, Settings → Billing page.
- **Romanian RAS engine** — Calibrated to oracle on 6 fixtures (Scandia FY2025 13.2% EBITDA margin, Z″ 3.09, A− credit grade — see [CLAUDE.md §8](CLAUDE.md)).
- **Currency** — Multi-currency Money component, FX rates endpoint, useCurrency hook, CurrencyToggle in header.
- **i18n foundation** — EN + RO (partial). Sweep batches 1 done, 2-3 pending (see §6).
- **Mobile UX** — 100dvh, safe-area-inset, 44px touch targets, KPI overflow protection, responsive tables.
- **Risk Radar** — RSS adapter with Romanian keyword triggers + GDELT adapter (Goldstein < -3 filter).
- **Products page redesign** — Decision rules, percentile presets, DIO parsing, Wind down classification.

---

## 3. What's NOT shipped (and why) — DO NOT just implement these without asking Alex

Things the operator has explicitly **declined or deferred**:

| Item | Status | Why |
|---|---|---|
| Email infrastructure (provider, SMTP, transactional templates) | ❌ Not built | No email provider chosen yet. **Alex owns** DNS setup at registrar + Stripe public support email. Do not build templates until inbox is live. |
| Footer with email visible | ❌ | FE uses `FooterSocial.tsx`, not `landing/Footer.tsx`. Design decision, not a fix. |
| Signup page "Trouble signing up?" footer | ❌ | `AuthCard.tsx` is intentionally minimal. ContactSales pattern is product-decision, not copy. |
| Settings → Help section | ❌ | Not in `Settings.tsx`. Would be new product surface. |
| Header "Contact" link | ❌ | Nav is Command Center-driven (Cmd+K), not traditional navbar. |
| Confirmation modals ("changed your mind") | ❌ | No such pattern exists in the codebase. Don't introduce one without operator sign-off. |
| `no-restricted-syntax` ESLint rule | ❌ | Overkill for current 3-user team. |
| Structured data (`application/ld+json`) | ❌ | Low SEO value for B2B SaaS in first months. |
| RO/FR translations beyond what's in `locales/` | ❌ | Translation effort is a separate workstream; don't auto-translate UI strings. |

---

## 4. Operating rules — LOCKED, do not violate

These come from real production incidents. Each rule has a story behind it; CLAUDE.md has the full context.

### 4.1 §14 Engine deploy protocol

**Rule:** No `docker cp` hot patches into running containers for engine code. **Ever.**

```
Host source first → docker compose build backend → docker compose up -d backend → verify
```

The full SSH deploy + the rsync-collision protection (one rsync per file when basenames differ) is in [CLAUDE.md §14](CLAUDE.md). Read it before you touch any engine Python file.

### 4.2 Schema migration discipline (F3.24 / Lock #15)

Every `supabase/schema_phase_*.sql` migration that adds/drops/modifies columns MUST:

1. End with `NOTIFY pgrst, 'reload schema';`
2. Operator runbook MUST include: **Supabase Dashboard → Settings → API → "Reload schema cache"** (the deterministic action; the NOTIFY alone is optimistic).
3. Before any orchestrator writes to a new column, call `verify_pgrst_visibility()` from `scripts/_pgrst_visibility.py`.

The 9-day F3.16-3b.5 audit-trail miss was caused by skipping #2. Don't skip #2.

### 4.3 Deploy + verify posture

- **Deploy**: `./scripts/deploy.sh --frontend --yes` from repo root (or `--backend --yes`). Outputs `Deploy GREEN — mode=LIVE — HH:MM:SSZ`.
- **Verify**: Playwright with `--project=prod` against https://cfo-ai.io. **NOT local preview server.** This is the standing constraint — the project hook may suggest `preview_start`, ignore it.
- **Health check**: `https://cfo-ai.io/api/health` after every deploy.

### 4.4 Don't skip hooks

Never `git commit --no-verify` or `--no-gpg-sign`. If a pre-commit hook fails, fix the issue and create a **new** commit (not `--amend`).

### 4.5 No customer data in git

Real customer trial balances live in `/files` directory which is **gitignored**. Do not commit XLSX/PDF customer uploads. Test fixtures for the engine live in `src/engine/country_packs/ro_romania/fixtures/` — those are intentionally tracked.

---

## 5. How to develop + ship

### 5.1 Local frontend dev

```bash
cd scandi-desk-main
npm run dev    # Vite dev server, http://localhost:5173
npm run build  # Production build
npm run lint   # Must pass before PR
```

### 5.2 Local backend dev

```bash
source .venv/bin/activate
uvicorn engine.api.app:app --reload  # http://localhost:8000
pytest tests/                         # Run all tests
```

### 5.3 Branch workflow

1. Branch from `main`: `git checkout -b feat/your-thing`
2. Commit early, commit often. Conventional-commits style is preferred (`feat:`, `fix:`, `chore:`, `db:`, `docs:`, etc.).
3. Push, open a PR against `main`.
4. **Self-review checklist**:
   - Lint passes (`npm run lint`)
   - Backend tests pass (`pytest`)
   - For engine changes: F-A3.1 BS-drift fixtures stay GREEN (`docker exec cfo-ai-backend python3 /app/scripts/measure_bs_drift.py` — Alex can run this for you on the VPS)
   - For UI changes: tested via Playwright `--project=prod` against the deployed branch OR via the prod-mirror flow Alex uses
5. Tag Alex (`@AlexDC100`) for review. Don't self-merge.

### 5.4 Romanian RAS account knowledge

If you're touching engine code, [CLAUDE.md §3 (Appendix A)](CLAUDE.md) has the RAS account cheat sheet. Don't guess prefixes — class 7xx = revenue, class 6xx = expenses, etc. Lookup the prefix in §3 first.

---

## 6. Open work (sorted by priority)

### 🔴 P0 — blocking issues

| Ticket | Status | Notes |
|---|---|---|
| **Bug #4 — Supabase PostgREST cache persistent staleness** | Operator-side; awaiting Supabase support (24-48h SLA) | Blocks F3.16-3b.5 backfill. No engineering work possible until Supabase responds. |

### 🟠 P1 — Alex-requested immediate

| Ticket | Owner | Notes |
|---|---|---|
| **[#7](https://github.com/AlexDC100/cfo-ai.io/issues/7) — Add Google + Apple sign-in** | Coder | Supabase Auth supports both providers — enable in Supabase Dashboard, then wire the buttons into `scandi-desk-main/src/components/cfo/AuthCard.tsx`. Match existing email/password styling. Full spec in the issue. |
| **DNS + email infrastructure setup** | **Alex** (external) | Register cfo-ai.io email at Namecheap/Cloudflare. Recommendation: Cloudflare Email Routing (free) for forwarding-only, OR Google Workspace €5/mo for full inbox. Need MX, SPF, DKIM, DMARC. |
| **Stripe Dashboard public support email** | **Alex** (external) | Stripe → Settings → Public details → Business support email = `contact@cfo-ai.io`. After DNS is live. |

### 🟣 F6.0 FP&A Initiative — queued, blocked on Bug #4

Six-phase FP&A initiative queued behind F3.16 closure. Full strategy doc:
[docs/F6.0-FPA-INITIATIVE-OPENING-PROMPT.md](docs/F6.0-FPA-INITIATIVE-OPENING-PROMPT.md).
Dependency-ordered (Period Comparison is the foundation; building variance
before period comparison gives broken math).

| Issue | Phase | Notes |
|---|---|---|
| [#1](https://github.com/AlexDC100/cfo-ai.io/issues/1) | **F6.0.1 Period Comparison Everywhere** | Foundation. Full spec at [docs/F6.0.1-PERIOD-COMPARISON-OPENING-PROMPT.md](docs/F6.0.1-PERIOD-COMPARISON-OPENING-PROMPT.md). Currently `blocked` label. |
| [#2](https://github.com/AlexDC100/cfo-ai.io/issues/2) | F6.0.2 Excel + PDF Export | Independent quick win. Opens after #1 closes. |
| [#3](https://github.com/AlexDC100/cfo-ai.io/issues/3) | F6.0.3 Variance Analysis | Depends on #1 (multi-period) + #2 (export the view). |
| [#4](https://github.com/AlexDC100/cfo-ai.io/issues/4) | F6.0.4 Configurable Dashboard | Independent. Closes loop on F5.0 learning. |
| [#5](https://github.com/AlexDC100/cfo-ai.io/issues/5) | F6.0.5 Scenario Planning | Depends on #3 (variance baseline). |
| [#6](https://github.com/AlexDC100/cfo-ai.io/issues/6) | F6.0.6 Three-Statement Modeling | Heaviest. Schema changes. Depends on #5. |

All issues live under milestone [F6.0 FP&A Initiative](https://github.com/AlexDC100/cfo-ai.io/milestone/1).
**Do not start F6.0.1 until Bug #4 clears and F3.16-3b.5 backfill completes.**

### 🟡 P2 — engineering backlog

**F3.16 closure** (blocked on Bug #4, but Track 4 work can proceed in parallel):
- `F3.16-3b.5` — Canonical envelope backfill + F3.15 fallback deletion
- `F3.16-3b.6` — F4.2 hardening + consumer cutover + briefing discipline (Part A shipped, cash+strict descoped to FOLLOWUP-VARIANT-PARITY)
- `Track 4` — Snapshot + single-period diff (in-progress, waiting on migration)

**F4.8 quality envelope** (greenfield, can start anytime):
- `F4.8a` — Backend extraction_quality module + envelope
- `F4.8b` — Per-row parse_flags emission in parsers
- `F4.8c` — Frontend popup + components
- `F4.8d` — Persistent badges + export audit footer + anomaly history
- `F4.8e` — Tests, deploy, verification

**NASDAQ testing**:
- `NASDAQ-14` — Unit + integration + E2E playwright tests
- `NASDAQ-16` — §14 deploy + browser-verify full flow

**i18n batches**:
- `Batch 2` — Landing + Pricing + NavValuation + PeerComparisonReport + MultiYear pages
- `Batch 3` — Long-tail ~50 components

**Backend enrichment**:
- Sharadar normalizer: add `revenueGrowth` + `grossMargin` + `dividendYield`

### 🟢 P3 — DEFERRED features (do NOT start without Alex's go)

**Public companies redesign** — watchlist, quick views, `/markets/:ticker` route, mobile bottom sheet.
**Markets page** — Cmd+K palette, tile view, compare cart, watchlist, /markets/:ticker tabs.
**Products page** — backend categories endpoint, /products/category/:slug routes, category-level Decision Rules.

### 🔵 P4 — TEST-DEBT (ongoing)

- ~7 auxiliary F5.0 specs are flaky (keyboard-accessibility 4, BS-trace text-match 1, valuation guide 1, mode-toggle subtle reload 1). Track as flakes; don't gate deploys on them.

### ⚪ External / non-engineering

- **Risk Radar Op-side action** — email GDELT for higher rate limit (Alex's task).

---

## 7. What ALEX owns (don't ask the coder to do these)

| Item | Where |
|---|---|
| DNS records at registrar | Namecheap / Cloudflare |
| Stripe Dashboard support email | https://dashboard.stripe.com/settings/public |
| Email provider choice + setup | Cloudflare Email Routing / Google Workspace / Fastmail / Resend |
| `.env` values on VPS | `/opt/cfo-ai/.env` (Stripe live keys, Supabase service role, Anthropic, OpenAI, Sharadar API key, etc.) |
| GDELT rate-limit request | email GDELT support |
| Supabase support tickets | https://supabase.com/dashboard/support |
| Mail-tester.com scoring | requires a real inbox to receive the test |
| Real-device QA on iPhone / Pixel | needs physical phones (Playwright Chromium emulation can't reproduce all touch quirks) |

---

## 8. Critical files to read first

In this order:

1. **[CLAUDE.md](CLAUDE.md)** — Operator instructions, 8-section analysis methodology (Appendix A), full Python engine implementation (Appendix B), §14 deploy protocol, schema migration discipline.
2. **[scandi-desk-main/src/lib/learning/concepts/seed.ts](scandi-desk-main/src/lib/learning/concepts/seed.ts)** — F5.0 concept registry, see how concepts wire to formulas + source accounts.
3. **[scandi-desk-main/src/lib/financialReport.ts](scandi-desk-main/src/lib/financialReport.ts)** — `IncomeStatement`, `BalanceSheet`, `DerivedTotals` shapes. Always reference these when building anything that touches financials.
4. **[src/engine/country_packs/ro_romania/](src/engine/country_packs/ro_romania/)** — Romanian RAS engine, chart of accounts, calibration fixtures.
5. **[scripts/deploy.sh](scripts/deploy.sh)** — The one-command deploy. Read what it actually does before you trigger it.

---

## 9. Communication

- **Code discussions**: PR comments on github.com/AlexDC100/cfo-ai.io
- **Urgent / blocking**: ping Alex directly (he has the keys to all the external systems)
- **Question about a Romanian accounting concept**: paste the trial balance row and ask. RAS accounts are non-obvious, no shame in asking.
- **Style preferences for PR descriptions**: short, direct, no emoji, no marketing voice. Match the prior commit log style.

---

## 10. The 30-second project pitch (so you know what you're building)

CFO AI takes a Romanian trial balance (balanță de verificare) — a 500-1500-row Excel/CSV — and produces an 8-section CFO-grade analysis: Overview, P&L, Balance Sheet, Cash Flow, Ratios, Valuation, Risk & Credit, Recommendations. It calibrates against industry benchmarks (food manufacturing, real estate, services, etc.) and includes an Altman Z″ + Piotroski F-Score + composite credit grade.

The platform is currently in early customer mode (3-5 Romanian SMEs), running live on a VPS with Stripe billing. The frontend is React + Vite + Supabase Auth. The backend is FastAPI + Supabase Postgres + a calibrated Python engine that reads RAS trial balances and emits the 8-section analysis.

The product moat is **accuracy at <0.5% BS-drift on real Romanian fixtures** — calibrated across 6 worked examples. Don't break the calibration. The fixtures live at `src/engine/country_packs/ro_romania/fixtures/regression_baselines/`. If your change makes one of those drift, that's a hard fail.

---

**Welcome aboard.** When in doubt: read CLAUDE.md, look at how the existing code did it, ask before assuming. Don't ship customer-data files. Don't skip the schema-migration Dashboard click. Don't `docker cp` engine code.

— Alex (via session 2026-06-16)
