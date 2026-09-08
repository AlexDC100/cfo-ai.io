# LAUNCH AUDIT — cfo-ai.io

**Verdict: NO-SHIP.**

Not because the journey was found broken. Because **the journey could not be
tested at all**, and a product handed to accounting firms today cannot rest on
an untested core. Steps 2–12 of Part 1, all of Part 2's upload behaviours, and
the cross-tenant proof in Part 4 every require an authenticated session. I have
no QA credentials, and I am not permitted to create an account or type a
password to obtain them. Your own verdict rule — "SHIP only if Part 1 steps 1–8
all PASS" — cannot be satisfied by evidence I am able to produce.

That is a two-minute unblock on your side, described in **§ How to unblock**.

Audited: 2026-09-08, production `https://cfo-ai.io`, real browser, desktop 1440
and mobile 375. Repo `HEAD 11e8e13`.

---

## What I fixed today (P0, found → red test → fixed → deployed → re-verified)

| # | Defect | Evidence it was live | State |
|---|---|---|---|
| P0-1 | **The band rail contradicted the badge above it.** On the realestate book the ratio card printed `Debt / EBITDA −0.64× · Band withheld` while the rail drew that ratio's marker inside the **strong** zone, under a caption asserting each track shows "the bands its verdict was decided by". carniprod drew a track for a ratio with no verdict at all. | 11 failing assertions in `chartsAgreeWithCards.test.ts` / `reportCharts.test.ts` on a tree whose product code was live. `zonesForRatio` had been written to fix this and the builder still called `zonesForKey(served, …)`. | **FIXED** `917b68f`, deployed. 95 gate assertions green. |
| P0-2 | **The production footer shipped an unreplaced placeholder**, both languages: `© 2026 CFO AI · [Company Legal Name]. All rights reserved.` — rendered ~40 px above the block printing the real entity. | Read off the live DOM before the fix. | **FIXED** `7452228`, deployed, re-read live. |
| P0-3 | The fix then printed `PARACHAIN CAPITAL S.R.L..` — the entity name carries its own terminal stop. | Read off the live DOM after deploying P0-2. | **FIXED** `11e8e13`. ⚠ **not yet deployed** — see Held back. |

Deploy performed per §14: tree-mirror rsync to host source (dry-run first, no
deletions), `docker compose build` one image at a time, import verified **inside
the running container**, F-A3.1 re-run, drift re-checked.

```
_attach_insights_block present: True      engine.insights importable: True
F-A3.1  Scandia/Sibiu/Frozen/RealEstate/Agras/Carniprod/Retail  →  Overall: GREEN
check_deploy_drift.py   407 files compared  →  IN SYNC
check_deployed_routes.py  20 mutating routes refused cleanly, 0 answered 5xx
```

**Production was running drifted code when this audit began** — `pipeline.py`
and `canonical_adapter.py` both differed from the committed tree, meaning the
insights wire was *not* live. It is now.

---

## PART 1 — THE JOURNEY

| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | Landing loads; pricing; signup reachable | **PASS** | 200; zero console errors; `/login` renders email+password, Google, "Create account" |
| 2 | Signup magic link **and** Google; email in a real inbox <60 s | **PENDING-OWNER** | Requires creating an account and reading a mailbox. Both outside what I may do. |
| 3 | Onboarding: role, workspace, industry, RO+EN | **PENDING-OWNER** | Behind auth. |
| 4 | Upload a real SAGA trial balance end to end | **PENDING-OWNER** | Behind auth. **This is the stop-the-line item.** |
| 5 | Dashboard: statements, ratios, trust chip, health, briefing; net income = account 121; P&L foots; no concept twice | **PENDING-OWNER (live)** / **PASS (fixture)** | Not verifiable on production. Verified against real engine output in-repo: 2,591 assertions, incl. the account-121 anchor, P&L footing, and one-name-one-formula across export/card/chart/drawer. |
| 6 | Findings specific, quantified, correct sector, no boilerplate | **PENDING-OWNER (live)** / **PASS (fixture)** | Eight detectors fire on the Agras book with accounts and balances named. |
| 7 | Capsule: fact tiles, provenance hover, account resolve, grounded answer, Tier-0 spends nothing | **PENDING-OWNER** | Behind auth. |
| 8 | Export xlsx + pdf open and match the screen | **PENDING-OWNER (live)** / **PARTIAL (fixture)** | Format-parity asserted in-repo. **PDF and PPTX are not implemented** — see Known gaps. |
| 9 | Second period → comparatives | **PENDING-OWNER** | Behind auth. No committed book carries a prior period, so the *degraded* path is the one gated. |
| 10 | Settings: language, currency, account deletion | **PENDING-OWNER** | Behind auth. |
| 11 | Billing: checkout reachable, subscription reflected, cancel | **PENDING-OWNER** | Behind auth. **Stripe is in LIVE mode** — `/api/health` → `"stripe":{"livemode":true}`. |
| 12 | Sign out / back in, data intact | **PENDING-OWNER** | Behind auth. |

**Steps 1–8 required for SHIP: 1 PASS, 7 unverifiable.**

---

## PART 2 — WHAT A FIRM WILL DO TO IT

| Item | Result | Evidence |
|---|---|---|
| Second company, second workspace, no bleed | **PENDING-OWNER** | Needs two sessions. |
| Imbalanced file → honest IMBALANCED, no fake zero | **PASS (fixture)** | `corpus_replay.py` case `imbalance_03pct` PASS; F-A3.1 reports Sibiu `MATERIAL_IMBALANCE` rather than balancing it. |
| Scanned PDF → AI-read badge or honest failure | **PASS (fixture)** | corpus `llm_fallback_scanned_pdf` PASS. |
| Non-Romanian file → honest state | **PASS (fixture)** | corpus `hu_ai_lane` PASS. |
| Photo / empty xlsx / 60 MB → clean error, never 500 | **PARTIAL** | **Body cap verified live**: 18 MB POST → `413` in **0.19 s**, clean JSON, no traceback. Cap is 36 MiB for documents vs your largest real trial balance at **202 KB** (~180× headroom). Photo/empty-xlsx paths are behind auth. |
| Every nav item WORKING or PendingState; Inventory + Invoices hidden | **PASS (registry)** | `/api/features/status` live: `inventory: hidden`, `invoices: hidden` labelled **"Receivables & Payables"**, `decisions/alerts/firm_cockpit/anomaly_radar: hidden`, `scenarios/benchmarks/public_companies: active`. |
| Hidden feature URL typed directly → gated at the route | **PARTIAL** | `/inventory` anonymous → `302 /login?next=%2Finventory`. The *feature* gate (hidden → PendingState) is proven by unit test, not live. |

---

## PART 3 — WHAT EMBARRASSES YOU

| Item | Result | Evidence |
|---|---|---|
| Zero console errors on every route | **PASS (public)** | `/`, `/?lang=ro`, `/privacy`, `/login`, `/inventory` — zero error-level messages. Authed routes unverified. |
| No English in RO UI, no untranslated keys, no lorem | **PASS (public)** | `?lang=ro` → `html lang="ro"`, zero English leaks from probe set, zero raw `a.b.c` keys. |
| `/privacy` `/terms` `/cookies` = 200 with real text | **PASS** | `200 / 14,748 B`, `200 / 13,939 B`, `200 / 9,824 B`; zero hits for `draft|[insert|[TBD|lorem`. |
| Footer identity, no bracket, no draft | **PASS (after P0-2/P0-3)** | Live: `PARACHAIN CAPITAL S.R.L. · CUI 45298544 · J2021021081405 / Intrarea Bitolia nr. 32, Sector 1, București, România`. Bracket gone. |
| Mobile 390: no horizontal scroll, no overlap | **PASS (public)** | `scrollWidth 375 == innerWidth 375`, `horizontalOverflow: false`. Upload on a phone is behind auth. |
| Dashboard/report render without a visible stall | **PENDING-OWNER** | Behind auth. |

---

## PART 4 — SAFETY

### Anonymous route table (live, this morning)

| Route | Code | Leak? |
|---|---|---|
| `/health` | 200 | No — `{"status":"ok","version":"0.1.0"}` |
| `/api/health` | 200 | No personal data. Discloses `mode:LIVE`, Stripe `livemode`, DB latency. **Cached** — 0.127 s / 0.124 s / 0.123 s on repeat, so it does not re-call providers per request. |
| `/api/features/status` | 200 | No — registry metadata only |
| `/api/public/markets` | 200 | No — public registry |
| `/api/cfo/chat/prompts` | 200 | No — static prompt list |
| `/api/sessions` | **401** | Closed (was leaking; fixed earlier) |
| `/api/plan/state` | **401** | Closed |
| `/api/industry/profiles` | **401** | Closed |
| `/api/billing/usage-status`, `/api/founding-member/count` | 404 | Removed |
| 20 mutating routes (pipeline/period/documents/sales-datasets/sku) | 401/400/422 | **None 5xx** |

**No anonymous route returns personal data, spends money, or calls a provider
per-request.**

| Item | Result | Evidence |
|---|---|---|
| Cross-tenant closed | **UNKNOWN** | Requires two authenticated accounts. FC1 write walls exist in code and the tenancy suite passes in-repo, but **I have not proven it on production** and I will not claim it. |
| Rate limits + body caps | **PASS (body cap)** / **UNKNOWN (rate limit)** | 413 verified live. The public storefront limiter is code-verified; I did not exercise it against production to avoid tripping the shield. |
| Backups configured + restore tested | **PENDING-OWNER** | **No backup cron or systemd timer on the VPS.** Only a filings-cache refresh (`*/15`) and `drift_check.sh` (`17 3 * * *`). Postgres is Supabase-managed so DB backups are likely theirs — **unconfirmed, and no restore has been tested**. |
| Error tracking live | **FAIL** | `SENTRY_DSN` **UNSET** on the host. No error tracking. |
| Uptime alerting reaching you | **PENDING-OWNER** | No monitor found on the host; an external one cannot be seen from here. |
| Anthropic caps + breaker with real values | **PASS (caps)** / **PENDING-OWNER (spend)** | Live from the container: `narrative 300 calls / 3.0M tok`, `extract 200 / 5.0M`, `classify 200 / 5.0M`, `finding_specificity 300 / 1.5M`, `firm_brief 100 / 0.5M` per day, across 12 roles. **Current spend requires the Anthropic console — I cannot read it.** |
| main CI: red jobs, why, since when | **FAIL** | `tier1-validation`: **100 runs, 100 failures, zero successes, since 2026-08-13.** Cause: `ModuleNotFoundError: No module named 'yaml'` — the workflow never installs engine dependencies. `Deploy frontend to GitHub Pages` and `nightly-deep` also failing. **There is no working CI safety net.** |

---

## BLOCKERS, in the order you should care

1. **The core journey is unverified.** Steps 2–8. Nothing else in this document
   matters until someone drives it. *To close:* see § How to unblock — two
   minutes of your time, then I re-run Part 1 and Part 2 in full.
2. **`USAGE_LIMITS_ENABLED=false`.** Plan caps are **not enforced** in
   production. Every signed-up firm has unlimited documents and unlimited chat
   against your Anthropic key. The per-role breaker is the only ceiling, and it
   is global, not per-customer — one firm can exhaust the day's budget for
   everyone. *To close:* decide deliberately whether to launch metered or
   unmetered; if metered, set it true and exercise the cap-reject path once
   (never tested live, per CLAUDE.md §16).
3. **No error tracking.** `SENTRY_DSN` unset. When a firm hits a 500 you will
   learn about it from the firm. *To close:* set the DSN, redeploy, force one
   error, confirm it arrives.
4. **Backups unconfirmed, restore never tested.** *To close:* confirm Supabase
   PITR is on and its retention window; confirm what covers uploaded documents
   in storage; restore one period into a scratch project and open it.
5. **Cross-tenant not proven on production.** Code and tests say closed; nobody
   has demonstrated it against the live database. *To close:* second QA account,
   attempt read and write of workspace A's period from workspace B.
6. **CI has never been green.** No automated net under any of this. *To close:*
   install engine deps in the workflow (`pip install -r requirements.txt`), then
   fix whatever the determinism gate reports once it can actually run.
7. **No uptime alerting.**

---

## Known gaps (recorded, not fixed — per your P1 rule)

- **PDF and PPTX exports do not exist.** HTML and XLSX do. PDF is the browser's
  print of the same DOM (A4 rules are in place); a programmatic PDF and a PPTX
  both need a dependency that is not in `package.json`. Part 1 step 8 says "xlsx
  and pdf" — **only xlsx is a real file today.**
- **Comparatives are unexercised on real data.** No committed book has a prior
  period, so only the degraded "no comparatives" path is gated.
- **`landingStrings.consent.body` is dead copy** carrying an unsubstituted
  `{cookiePolicy}` token; the live banner reads i18n's `cookieConsent.body`
  instead. Harmless, but it is an unrendered string with a placeholder in it.
- **The insights fixture is built on the wrong seam** —
  `capture_insights.py` builds from the write-path book while production serves
  the envelope-true one, which drift 0.44–35.47% apart. Frontend gates currently
  assert over numbers production does not emit. (Punchlist P1.)
- `docs/engine_book/architecture.md` is stale by one line.
- 10 known tsc errors (baseline, unchanged).

---

## How to unblock the half I could not test

I cannot create an account or type a password — those are hard limits, not
preferences. What I need is either:

- **a QA account's credentials shared with me** (email + password for an account
  that holds only test data), **or**
- **you drive the five-minute script below yourself** and tell me what you see.

Either closes items 2–12 immediately.

---

## Five-minute smoke script — run this before you send the first email

Not a substitute for the audit above. This is the minimum that proves the
product works today.

1. **Open `cfo-ai.io` in a private window.** *Correct:* page paints, cookie
   banner appears, footer reads `PARACHAIN CAPITAL S.R.L. · CUI 45298544` with
   **no square brackets** and no doubled full stop.
2. **Click Pricing, then Get started.** *Correct:* signup form, no console error.
3. **Sign up with your real email.** *Correct:* the mail arrives in **under a
   minute, in the inbox, not spam**. If it lands in spam, stop — that alone
   loses firms.
4. **Name the workspace, pick the industry.** *Correct:* it asks; it does not
   guess silently.
5. **Upload `corpus/saga_10_col_agras/input.xlsx`.** *Correct:* period detected
   as Dec 2025, the five steps advance, analysis completes without a 500.
6. **On the dashboard, check three numbers against the file:** net income equals
   **account 121's closing balance**; the P&L's subtotals add up; and the same
   concept never shows two different values anywhere on the page.
7. **Open the report.** *Correct:* page one names what is critical, the findings
   section lists the related-party exposure with its account codes, and every
   band prints its own cutoffs — no verdict word without numbers behind it.
8. **Export XLSX and open it.** *Correct:* the figures match the screen. (There
   is no PDF export yet — do not promise one.)
9. **Sign out, sign back in.** *Correct:* the workspace and the period are still
   there.
10. **Type `cfo-ai.io/inventory` directly.** *Correct:* you land somewhere that
    explains itself — never a broken screen.

If any of 5, 6, 7 or 8 misbehaves, do not send the emails.
