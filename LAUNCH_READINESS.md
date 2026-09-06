# Launch readiness — the cut scope

**Verdict: NO-SHIP, on one blocker.** Everything else in the cut scope is
either working and verified live, or waiting on you with the work already
built. Six blockers stood in the previous verdict; five are closed and
deployed. The sixth is a wrong number on the report surface, and it is wrong
on your own QA upload.

Scope is the owner's cut: marketing and auth, workspace and file attach,
dashboard, findings, export, Capsule, settings, billing. Everything else
ships hidden and is out of this verdict.

---

## The blocker

**A generated report states net income twice, and the ratios read the wrong
one.** Measured on the four committed real-output fixtures and confirmed on
the QA book you uploaded this morning:

| book | account 121 (filed) | served reconstruction | factor |
|---|---|---|---|
| agras | 7,533,676.02 | 14,106,102.03 | 1.9× |
| carniprod | 1,435,533.59 | 5,843,449.04 | 4.1× |
| retail | 3,205,212.62 | 1,161,957.98 | 0.36× |
| **realestate (your QA upload)** | **−801,604.14** | **−30,391,418.38** | **38×** |

Both figures are served in the same payload — `net_income_statutory` carries
the anchored account-121 value, `net_income_operational` carries the class-6/7
reconstruction — and the report renders one in the executive summary and the
other in the P&L build-up. Net margin, ROE and ROA read the reconstruction.
The build-up also does not foot: on agras, EBIT − interest − tax is
13,715,664.54 against a stated 14,106,102.03, a gap of 390,437.49.

A fix is in flight with two gates the owner specified: one concept, one value
per rendered report; and the P&L foots. It is not deployed, so the verdict
stands at NO-SHIP until it is.

---

## Closed and deployed today

Every line below was probed on `https://cfo-ai.io` after deploy.

| was | now |
|---|---|
| `GET /api/sessions` returned a real visitor's name, IP, device and visit history to anyone | `401`; operator bearer still reads it |
| the same route recorded the caller-written forwarded hop, so the address it published could be forged | records the hop our own proxy observed, through the one helper three sibling modules already use |
| `/api/public/health` printed a live API-key prefix and the remaining quota anonymously | `{"key_configured":true}`; detail behind the operator bearer |
| `POST /api/analyze` spent one paid Anthropic completion per anonymous hit, outside every breaker | `404` behind an off-by-default flag |
| the whole public-markets API answered anonymously while the feature ships hidden | `404`, routers unmounted, stable JSON body |
| `/api/health` made a live Stripe balance call and a Supabase round trip per anonymous hit (3.56 s) | memoised 60 s; measured 2.09 s |
| a dead exchange-rate provider cost one 8 s outbound call per anonymous hit | memoised 300 s |
| 18.5 MB into `POST /api/skus` returned 42,009,599 bytes in 3.46 s, anonymous, no body limit anywhere | `413`, 229 bytes, 0.32 s |
| no security headers at all | six live, HSTS included, CSP in Report-Only |
| every hidden feature reachable by URL — the sidebar filter was the only gate | routes fail closed through `FeatureRoute`; `/public-companies` renders "NOT IN THIS RELEASE" |
| `/privacy`, `/terms`, `/cookies` were 404, and the only legal page told visitors to replace bracketed placeholders and consult a lawyer | three real routes rendering an honest placeholder that names what is outstanding |
| the pricing page sold Ask CFO AI on all three plans and Benchmark on Pro, both hidden | marked "available after launch" with a clock, not a tick; ambiguous claims removed |
| the page sold PDF export (browser print only) and listed invoices and public filings as accepted | corrected to HTML and Excel, and to what the pipeline actually accepts |
| `create_app()` wrapped two mounts in `except Exception: logger.exception(...)` with **no module-level `logger`** | the guard cannot raise out of itself |

The last one deserves its own line: on the one day a mount actually failed,
that handler would have raised `NameError` out of itself and the API would
not have booted. A rescue path that has never been executed is a claim.

---

## Waiting on you

1. **Legal text.** The three routes are live and render a placeholder that
   names every missing item: denumire, CUI/CIF, nr. reg. com., sediu social,
   the two contact addresses, and a lawyer's review. No drafted text was
   invented. Send the text and it renders.
2. **QA sign-in for the browser hop.** Two periods and two analysed documents
   landed under the `Q&A` workspace this morning, and I measured account 121
   on that book server-side — which is how I confirmed the blocker above. What
   is still unmeasured is the *browser* hop: export-matches-screen, and the
   headline figure as the customer sees it. Both are **PENDING-OWNER**, not
   blocking this verdict.
3. **Backups, DMARC, error tracking, uptime, the Anthropic spend ceiling, and
   the Stripe live webhook check** remain as listed in the owner list. None is
   in the repository; all are console work.
4. **One operator deploy step:** the Caddy body limit in
   `deploy/REQUEST_BODY_LIMITS.md`. Until it lands, over-size bytes still
   cross the VPS network stack before the app's 413. That file fronts the
   whole VPS — validate before reload.

---

## Known and not fixed

- `/api/cfo/*` has no rate limiter: 30 concurrent under-cap anonymous requests
  cost 12.37 s of wall time. A body cap cannot fix it; N admitted requests
  cost N times the CPU. Ticketed, deliberately not built today.
- CSP is Report-Only. Enforcing an untested policy on a Vite SPA is its own
  outage risk; the report-only header collects violations first.
- The public storefront at `/companii` stays live and indexed while Public
  Companies is hidden in-app. Withdrawing 600k indexed URLs is a destructive
  SEO action and is yours to call.
