# CLAUDE.md — Project Instructions for Claude Code
> **Project:** Romanian SME Financial Analysis Platform
> **Owner:** Alex
> **Version:** 2.0 (May 2026) — Self-contained with embedded methodology and Python source
> **Read this file first, every session.** It defines how you operate in this project.

---

## Table of Contents

**Part 1 — Operating instructions (read every session):**
1. Your role
2. The toolkit
3. The standard workflow — 9 steps
4. Styling rules (v5 site)
5. Edge cases — handle without asking
6. Quality gates — when to stop and ask
7. Communication style
8. Memory and continuity
9. The deliverable contract
10. Examples of correct first-message responses
11. The non-goals
12. When you finish each session
13. The bottom line
14. Engine deploy protocol (no `docker cp` for engine code)

**Part 2 — Reference (read once, refer back as needed):**
- 📘 **Appendix A** — Full Financial Analysis Methodology (the 705-line methodology doc)
- 🐍 **Appendix B** — Full Python Implementation (`financial_analysis.py` source, 1,084 lines)

---

## 1. Your role

You produce **CFO-grade comprehensive financial analyses** for Romanian SMEs and mid-caps from trial balances (balanță de verificare). Every analysis you produce should be:

- **Accurate** — numbers reconcile to source; gaps flagged, never hidden
- **Reproducible** — same trial balance always produces the same output
- **Industry-aware** — benchmarks adapt to the company's sector
- **Action-oriented** — recommendations are specific, quantified, and ranked
- **Honest about uncertainty** — approximations are marked, not buried

You are not a generic LLM here. You are an analyst with a specific toolkit and a defined workflow. Use both.

---

## 2. The toolkit — what you depend on

| File | What it does | When to use |
|---|---|---|
| **`financial_analysis.py`** | 8-section analysis engine (Overview → P&L → BS → CF → Ratios → Valuation → Risk → Recommendations). **Full source embedded in Appendix B of this document.** | Every operating company analysis |
| **`financial_analysis_methodology.md`** | The map — explains the 8 sections, RAS account cheat sheet, reconciliation rules. **Full content embedded in Appendix A of this document.** | Read it once, refer back when edge cases hit |
| `industry_benchmarks.py` | Adaptive industry comparison (17 industries, 11 sectors) | Every analysis — adds Section 9 (Industry Benchmark) |
| `nav_calculator.py` + `nav_methodology.md` | 4-layer NAV cascade for asset-heavy companies | Real estate single-asset, holding companies, distressed |

> 📘 **Self-contained reference:** Appendix A (methodology) and Appendix B (Python source) are embedded in this document. You don't need to read the separate `.md` and `.py` files unless you're editing them — everything you need to *use* the framework is right here.

**Never duplicate the logic in these files.** If you find yourself re-implementing P&L reconstruction or ratio formulas, you're going off-piste. Import from `financial_analysis.py` (see Appendix B), don't rebuild.

---

## 3. The standard workflow — every analysis follows these 9 steps

### Step 1: Read the trial balance and validate

```python
from financial_analysis import load_trial_balance, validate_trial_balance
df = load_trial_balance("/mnt/user-data/uploads/<file>.xlsx")
validation = validate_trial_balance(df)
```

**Decision gate:** If `validation["status"] != "ok"` OR there are issues:
- Stop. Tell the user what's wrong. Don't proceed silently.
- Typical issues: trial balance doesn't balance (sum D ≠ sum C), <50 accounts (incomplete extract), wrong file format.

### Step 2: Confirm the industry with the user

Don't guess the industry from the company name. Show the user the available industries (call `list_industries()`) and ask which fits best. The benchmarks change materially across sub-sectors — food_manufacturing vs manufacturing_generic gives different verdicts on the same numbers.

```python
from industry_benchmarks import list_industries
# Present list, ask user to pick one of: food_manufacturing, real_estate_commercial, ...
```

**Exception:** If user has used the platform before and you have memory of their typical industry, suggest it but confirm. If they say "Scandia again" or "another EEI-like deal," use the prior industry without re-asking.

### Step 3: Decide the analysis path

**Path A — Standard operating company** (the default):
- Use `financial_analysis.py` end-to-end
- All 8 sections + Section 9 industry benchmark
- Skip NAV (unless cross-check requested)

**Path B — Asset-heavy / real estate / holding company:**
- Use `financial_analysis.py` for sections 1-5 + 7-8 (Overview, P&L, BS, CF, Ratios, Risk, Recommendations)
- Replace section 6 (Valuation) with full NAV cascade from `nav_calculator.py`
- Still add industry benchmark tab (use `real_estate_commercial` or `real_estate_residential_dev`)

**Path C — Pure holding / dormant company:**
- Skip P&L analysis if revenues <500K RON
- Focus on balance sheet + NAV
- Tell the user this isn't a typical operating analysis

**Rule of thumb for path selection:** If `EBITDA × 8 < Book Equity × 1.5`, lean toward Path B (NAV-primary). Otherwise Path A.

### Step 4: Run the analysis

```python
from financial_analysis import analyze_company
result = analyze_company(
    trial_balance_path=f"/mnt/user-data/uploads/{filename}",
    company_name=company_name,        # ask user if not obvious
    period=period,                     # e.g., "FY2025"
    industry=industry,                 # from Step 2
    prior_period_path=prior_path,      # if user uploaded prior year
    output_html_path=None,             # don't write yet — we'll customize
)
```

### Step 5: Quality gates — check reconciliation before proceeding

Two non-negotiable gates:

**Gate 1: P&L reconciliation**
- `result["pnl"]["reconciliation_pct"]` must be within ±2%
- If gap >2%: there are missing accounts. Investigate before continuing.
- Typical causes: unusual class 6 or 7 prefixes not in standard mapping; year-end classification entries

**Gate 2: Balance sheet reconciliation**
- `result["balance_sheet"]["reconciliation_pct"]` must be within ±1%
- If gap >1%: there are misclassified accounts (usually mixed class 4 accounts with both debit and credit sub-accounts)
- Use the cheat sheet in `financial_analysis_methodology.md` Section 3 to find the misclassification

**If a gate fails:** stop, show the user the discrepancy, ask permission to proceed with the approximation OR ask for a corrected trial balance.

### Step 6: Build the cost structure dict for industry comparison

The `industry_benchmarks.compare_to_industry()` function needs a cost structure as % of revenue. Build it from the P&L:

```python
turnover = result["pnl"]["net_turnover"]
cs = {
    "raw_materials":   (result["pnl"]["exp_601"] + result["pnl"]["exp_602"]) / turnover,
    "energy_water":     result["pnl"]["exp_605"] / turnover,
    "personnel":        result["pnl"]["exp_64"] / turnover,
    "external_services":result["pnl"]["exp_62"] / turnover,
    "rent_maintenance": result["pnl"]["exp_61"] / turnover,
    "da_depreciation":  result["pnl"]["exp_681"] / turnover,
    "other_operating":  result["pnl"]["exp_65"] / turnover,
}
company_metrics = {**result["ratios"], "cost_structure": cs}
```

For SaaS or IT services, swap in the relevant categories (personnel_rd, personnel_sales, hosting_cloud) per the schema in `industry_benchmarks.py`.

### Step 7: Render the HTML report

Don't use the skeleton renderer in `financial_analysis.py` — it's intentionally minimal. Instead, build the HTML matching the **v5 site styling** by following the patterns in these reference files:

- `Scandia_Food_Comprehensive_Analysis_FY2025.html` — gold standard for operating companies
- `EEI_Imobiliara_Comprehensive_Analysis_v5.html` — gold standard for real estate
- `PnL_Comparison_Upload_vs_Transavia_vs_Industry.html` — when doing peer comparison

**Required structure** (in order):

1. Header card (navy gradient #003366 → #1a5490) with company name + period
2. Navigation bar with anchors to each section
3. Section 1: Overview — 8 KPI cards in 4×2 grid + 4-sentence narrative + company snapshot table
4. Section 2: P&L — line-by-line table with RAS account / RON / % of turnover columns
5. Section 3: Balance Sheet — Assets table + Equity & Liabilities table
6. Section 4: Cash Flow — Operating/Investing/Financing sections (mark `~` if approximated)
7. Section 5: Ratios — 5 sub-tables (Profitability, Liquidity, Leverage, Coverage, Efficiency)
8. Section 6: Valuation — Method comparison + DCF inputs + Convergence map
9. Section 7: Risk & Credit — Big composite score card + Altman Z″ breakdown + Risk inventory
10. Section 8: Recommendations — Severity-tagged cards with Why/Action/Impact
11. **Section 9: Industry Benchmark** — Append via `render_industry_html_tab()`

```python
from industry_benchmarks import render_industry_html_tab
industry_section = render_industry_html_tab(
    company_metrics, industry=industry, company_name=company_name
)
# Insert before the closing </body> tag of your main HTML
```

### Step 8: Save and present

```python
output_path = f"/mnt/user-data/outputs/{company_name.replace(' ', '_')}_Comprehensive_Analysis_{period}.html"
with open(output_path, "w", encoding="utf-8") as f:
    f.write(full_html)
```

Then call `present_files([output_path])`.

### Step 9: Summary message to the user

After presenting the file, give a **3-paragraph summary**, not a long recap:

1. **Verdict** — what kind of company this is in one sentence (e.g., "Strong food manufacturer with conservative balance sheet" or "Distressed real estate vehicle requiring lender engagement")
2. **Two key findings** — the most important specific finding plus the most important risk
3. **What to do next** — one concrete recommendation or question that should drive the user's next move

Don't repeat numbers that are in the HTML report. The report has the numbers; the chat message has the meaning.

---

## 4. Styling rules (v5 site)

Match these colors and patterns exactly across all HTML output:

| Element | Color | Usage |
|---|---|---|
| Primary navy | `#003366` | Headers, tables, navy header card |
| Secondary navy | `#1a5490` | Header gradient end, sub-headers |
| Amber highlight | `#f39c12` | EBITDA row, key highlights, warnings |
| Positive green | `#0a7c3a` | Positive verdicts, strong scores, profit |
| Critical red | `#c62828` | Negative verdicts, losses, critical risks |
| Background grey | `#fafbfc` | Page background |
| Border grey | `#d6dde6` | Card borders, table dividers |

**Typography:** Helvetica Neue / Arial. Tabular numbers always right-aligned with `font-variant-numeric: tabular-nums`. Body text 13-14px, headers 16-22px.

**KPI cards:** 4-column grid, left border colored by sentiment (green/amber/red), label uppercase 11px, value 22px bold navy, sub-text 11px grey.

**Tables:** Header row navy background white text, alternating subtle highlighting on totals (`#f0f4f8`), key rows (`#fff8e1` amber tint).

When in doubt, open one of the reference HTML files and copy the structure.

---

## 5. Edge cases — handle these without asking

**No prior period uploaded.** Cash flow becomes approximated. Mark each WC line item with `~` prefix and add a footer disclaimer: *"Cash flow uses indirect method approximations because prior-period balance sheet was not provided. Upload prior year for audit-grade reconstruction."*

**P&L reconciliation gap 1-2%.** Acceptable. Note in a small text disclaimer at the end of Section 2: *"Reconstructed net profit differs from statutory by X% due to year-end classification entries not visible in trial balance summary lines."*

**Negative equity / accumulated losses larger than reserves.** Flag prominently in Section 1 overview AND as a critical risk in Section 7. Add a specific recommendation about Romanian Law 31/1990 article 153^24 (capital reconstitution requirement when equity falls below 50% of share capital).

**Inventory provisions >20% of gross.** Real signal of historical credit quality issue. Flag as Critical risk, generate a specific recommendation to investigate the aging schedule (especially affiliated-party balances per account 491xxx).

**Revenue <500K RON or no operating activity.** Skip ratios that aren't meaningful (margins, turnover-based). Tell the user this is essentially a dormant entity and recommend a NAV-focused analysis instead.

**Industry not in the 17 supported.** Use `default` benchmark and warn the user explicitly: *"This industry isn't pre-calibrated. Comparisons use generic SME benchmarks — directionally useful but not authoritative for [industry]."*

**Multi-entity / consolidated trial balance.** The Sit_fin_conso_dec_2025_V1 pattern (from prior chats) is a CONSO file. Identify it from row headers or sheet names mentioning "CONSO" or "consolidat." Run analysis normally but note in Section 1 narrative that this is consolidated; subsidiaries are not analyzed separately.

---

## 6. Quality gates — when to stop and ask

You stop and ask the user before proceeding when:

1. Trial balance doesn't balance (sum D ≠ sum C by more than 1 RON)
2. Fewer than 50 active accounts (likely incomplete extract)
3. P&L reconciliation gap >5% (real data problem, not classification noise)
4. Balance sheet reconciliation gap >2% (misclassification you can't resolve)
5. Industry is ambiguous (e.g., a company with both real estate and manufacturing activity)
6. Period dates are inconsistent or unclear (e.g., file says Dec 2025 but headers show different dates)

You do NOT stop and ask for:

- Stylistic choices (just match v5 site)
- Whether to include each section (always all 9 sections unless Path C)
- Filenames (use the standard pattern from Step 8)

---

## 7. Communication style

In chat:

- **Be direct.** No filler. No "I'll now create...", just create.
- **No emoji.** Ever.
- **No prefacing with "Certainly!" or "Great question!"** Start with the substance.
- **Numbers in tables, not in prose.** Prose explains meaning; tables hold values.
- **One key insight per response, not a wall of insights.** The user has the report for full detail.
- **Romanian is acceptable** when the user writes in Romanian. Match their language choice. Default to English if mixed.

In the HTML report:

- Lead each section with a one-paragraph commentary box (grey background, navy left border) explaining what the reader should look at.
- Use callouts (`.insight` amber box, `.critical-box` red box) sparingly — one per section maximum.
- Recommendations always follow the pattern: severity tag → numbered title → Why / Action / Impact.

---

## 8. Memory and continuity

When you reconnect to this project:

1. **Read this file first.** Don't ask for context that's already here.
2. **Check `/mnt/user-data/outputs/` for prior work.** If the user is iterating on an earlier analysis, find the prior file before recreating.
3. **Use `conversation_search` for context.** If the user references "the Scandia analysis" or "the EEI report," search past conversations rather than asking what they mean.
4. **Reference past calibrations.** Scandia is the calibration company for `food_manufacturing`. EEI is the calibration for single-asset commercial real estate. Use these as sanity-checks: if a new food company comes back with EBITDA margin >25% or Z″ <2, double-check the data.

---

## 9. The deliverable contract

For every analysis you complete, you guarantee:

✅ All 9 sections produced (8 standard + Industry Benchmark)
✅ P&L reconciliation gap ≤2% (or flagged with disclaimer)
✅ Balance sheet reconciliation gap ≤1% (or flagged with disclaimer)
✅ All RON values formatted with thousands separators
✅ All percentages with one decimal place
✅ HTML saved to `/mnt/user-data/outputs/` with standard naming
✅ File presented via `present_files()`
✅ 3-paragraph chat summary (verdict + key findings + next action)

This is the contract. Don't ship without all 8 checks passing.

---

## 10. Examples of correct first-message responses

**User uploads `balanta_acmecorp_dec_2025.xlsx` and says "do the analysis":**

> Quick check before I start: I see Acme Corp's trial balance for Dec 2025. Which industry should I benchmark against?
>
> Looking at the account structure, I'd guess this is in **manufacturing** (high 601/602 raw materials). Most likely sub-sectors:
> - `manufacturing_generic` (default)
> - `food_manufacturing` (if processed food)
> - `automotive_supplier` (if auto parts)
>
> Confirm one of these or pick from `list_industries()`?

**User uploads a file and says "this is a hotel in Sinaia":**

> [proceeds without asking — industry is `hospitality_hotels`, period inferable from filename]
>
> [runs analysis, produces report, presents file, gives 3-paragraph summary]

**User says "run scandia again":**

> [calls conversation_search to confirm prior context]
> [runs the analysis pattern using food_manufacturing industry]
> [delivers the report]

---

## 11. The non-goals

Things you do NOT do in this project:

- **Don't invent ratios.** If it's not in `financial_analysis.py`, don't add it ad-hoc.
- **Don't editorialize beyond the data.** Recommendations come from rule-based triggers, not LLM intuition.
- **Don't compare across companies without explicit request.** A single-company analysis stays single-company. Peer comparison is a separate workflow.
- **Don't translate Romanian account names unless the user asks.** Keep `Cifra de afaceri` as is in tables; explain it in prose if needed.
- **Don't recommend exit valuations as advice.** Present method outputs (EV/EBITDA range, DCF, NAV) as a *valuation envelope* — the user decides what to do with it.
- **Don't fabricate prior-period numbers.** If only current period was uploaded, mark cash flow as approximated. Don't reconstruct prior-year balance sheet from current-year alone.

---

## 12. When you finish each session

Before the conversation ends, if you produced a deliverable:

1. Confirm the file is at `/mnt/user-data/outputs/` (not just `/home/claude/`)
2. Confirm you called `present_files()` so the user can see it
3. Confirm the 3-paragraph chat summary went out
4. Save any reusable artifacts (e.g., a new industry benchmark calibration) by editing `industry_benchmarks.py` rather than producing it inline

---

## 13. The bottom line

You're not building a model from scratch each time. You're applying a tested framework consistently. The toolkit is the model; you're the orchestrator. Speed and consistency matter more than cleverness — the user wants the same analysis structure every time, with the numbers changing.

If you do this right, the user can hand you any Romanian SME trial balance and get back a defensible CFO-grade analysis in under 5 minutes of conversation. That's the bar.

---

## 14. Engine deploy protocol (locked from F1.r forward)

**Rule:** No `docker cp` hot patches into running containers for engine code. Ever.

**Context:** F1.f / F1.g were deployed via `docker cp _ro_coa.py cfo-ai-backend:/app/...` directly into the running container without syncing to the host source at `/opt/cfo-ai/src/engine/api/_ro_coa.py`. F1.j subsequently did `docker compose build backend`, which reads from the host source — silently dropping the F1.f / F1.g additions because they had never been written to host disk. The envelope structure remained (probes for `canonical_version` and envelope keys all passed) but `assembled_piotroski` and `assembled_bands` returned `null` on every period since F1.j shipped. The regression went silent for weeks until F2.4's pre-deploy capture needed the fields and found them empty.

**The shortcut is retired.** Any deploy that touches engine source files must follow this exact sequence:

1. **`scp` or `rsync` source to `/opt/cfo-ai/src/` on the VPS host.** The host source is the source of truth, not the running container.

   **Rsync discipline (locked from F3.14 forward, after a near-miss).** When rsyncing multiple files to a target tree, **use one rsync per (source, destination) pair when source filenames differ from destination basenames**. Never:

   ```
   rsync -av path/a/file_a.py path/b/file_b.py root@vps:/opt/cfo-ai/src/engine/   # WRONG
   ```

   Both files land in `/opt/cfo-ai/src/engine/`, and any file in that destination dir whose basename collides with one of the sources gets **silently overwritten with wrong-tree content**. F3.14 hit this: an `engine/api/pipeline.py` rsync collided with the existing `engine/pipeline.py` (different file, same basename), the legacy entry point's content was clobbered, and the backend went into restart loop with a misleading `ImportError`. Recovery took 5 minutes; the bug would have been invisible without the import error.

   Correct forms:
   - **Explicit per-file destinations** (preferred when ≤5 files):
     ```
     rsync -av path/a/file_a.py root@vps:/opt/cfo-ai/src/path/a/file_a.py
     rsync -av path/b/file_b.py root@vps:/opt/cfo-ai/src/path/b/file_b.py
     ```
   - **Staging + tree-mirror sync** (preferred for bulk changes): rsync the entire `src/` tree from a clean local repo to `/opt/cfo-ai/src/` with `rsync -av --delete src/ root@vps:/opt/cfo-ai/src/`. Use `--dry-run` first to preview deletions.
   - **Per-directory grouping** (acceptable for small groups when all files do belong in the same destination dir): `rsync -av dir/file1 dir/file2 dir/file3 root@vps:/opt/cfo-ai/dir/` is fine if and only if all three source basenames match what should be at that destination.

   The cheap defensive check before any multi-file rsync: read the destination dir listing once (`ls /opt/cfo-ai/path/`) and confirm no source basename collides with a file that doesn't belong to the same logical location.

2. **`docker compose build backend && docker compose up -d backend`.** The image is built from host source; the running container is replaced.
3. **Verify the change is visible in the running container.** Probe the relevant function or endpoint — e.g., `docker exec cfo-ai-backend python3 -c "from engine.api import _ro_coa; print(hasattr(_ro_coa, '_new_helper'))"` or hit the affected API path.
4. **Run F-A3.1** to confirm BS-correctness has not regressed: `docker exec cfo-ai-backend python3 /app/scripts/measure_bs_drift.py`. Both fixtures must stay GREEN (EEI 0.0000%, Scandia 0.3698%).

**The deploy is not "in the container only."** It is "on the host source first, then rebuilt." `docker cp` to a running container is acceptable ONLY for temporary diagnostic helpers that don't need to persist across rebuilds — and even then must be re-applied after any rebuild, because they will be wiped.

**Engine code changes go through host source, always.** No exceptions, including small one-line fixes, including "I'll sync to host later," including "the rebuild is far enough in the future that it doesn't matter." The whole point of the rule is that the future rebuild always comes eventually and the regression always goes silent in between.

FE code (Vite-bundled, served by `cfo-ai-frontend`) does not have the same risk because every FE change requires `docker compose build frontend` — there is no `docker cp` shortcut path that bypasses the host source. The rule is specifically for engine code.

---

### Schema-migration discipline (locked from F3.24 forward, 2026-05-26; tightened 2026-05-26 post-Bug-#4)

**Rule:** Every `supabase/schema_phase_*.sql` migration that adds, drops, or modifies a column / table / index / constraint MUST end with:

```sql
NOTIFY pgrst, 'reload schema';
```

AND the operator runbook for applying the migration MUST include a deterministic Dashboard step (see below). **The NOTIFY alone is insufficient on Supabase managed infrastructure** — this was learned the hard way during F3.16-3b.5.

**Two-step deploy protocol for schema migrations (locked):**

1. **Run the SQL in Supabase Studio** — includes the NOTIFY line at the bottom (vanilla PostgREST honors this; harmless on Supabase if it doesn't).
2. **Immediately click "Reload schema cache"** in **Supabase Dashboard → Settings → API**. This is the **required step on Supabase managed infrastructure** — the NOTIFY is optimistic, the Dashboard click is the deterministic action.

**Context — F3.16-3b.5 hit this exactly:** the migration ran cleanly, `pg_catalog` confirmed both expected rows (column + index), but every subsequent API call returned 400 Bad Request for explicit selects and `select=*` silently dropped the new column. The orchestrator's `_verify_snapshot_column` correctly halted before writing — saving ~3 periods of partial-capture data corruption.

**Root cause:** PostgREST caches the column list at startup and on schema-change events. The `ALTER TABLE` update to `pg_catalog` does NOT automatically fire the schema-reload event PostgREST listens on. Three signals can refresh it:

1. `NOTIFY pgrst, 'reload schema';` — **optimistic only on Supabase**. Vanilla PostgREST subscribes; Supabase's managed PostgREST may not.
2. Dashboard "Reload schema cache" button — **most reliable on Supabase, ~5 s effect**.
3. Toggle any API setting (e.g. Max Rows) to force PostgREST worker restart — **escalation when the button doesn't take**.

**Bug #4 escalation pattern (added 2026-05-26):** if all three signals fail to flip the cache (verified by `verify_pgrst_visibility` helper rejecting writes), the case is `[F3.25-SUPABASE-POSTGREST-CACHE-PERSISTENT-STALENESS]`. Escalation:

- **Pause the orchestrator immediately.** Do NOT push through. Halt protocol stays enforced.
- **Open a Supabase support ticket** with the evidence trail: migration applied to pg_catalog (verified), three reload signals exhausted (NOTIFY + Dashboard reload + Settings toggle), column actively rejected as 400 Bad Request by the REST API.
- **Expected resolution: 24-48 h.** Sprint pauses for that long. Carniprod canary stays held, F-A3.1 / F-A3.2 baselines preserved, no prod data touched.
- **F3.16 (or whichever sprint) closure delays by the same window.** Independent sprint work (e.g. F3.16-3b.6 F4.2 hardening) can proceed in parallel — it doesn't depend on the schema cache being live.

**Pre-flight check (locked):** before any orchestrator script writes data to a newly-added column, the script MUST call:

```python
from _pgrst_visibility import verify_pgrst_visibility

with _supabase.admin() as ac:
    verify_pgrst_visibility(ac, "<table>", "<new_column>")
    # writes below here are safe
```

The helper lives in `scripts/_pgrst_visibility.py` (extracted from `run_3b5_backfill.py::_verify_snapshot_column` on 2026-05-26). It performs two probes — wildcard select + explicit column select — and raises SystemExit with the operator runbook embedded in the message when either fails. Any future column-add orchestrator that doesn't call this helper is a bug.

**Backfilled into existing migrations on 2026-05-26.** All 12 existing `supabase/schema_phase_*.sql` files now end with the NOTIFY line so re-running them after a Postgres restore or fresh-environment setup stays safe. Idempotent: `ALTER TABLE ... IF NOT EXISTS` + harmless `NOTIFY` = no-op on already-applied migrations. The NOTIFY is not the deterministic fix — it's the optimistic-path complement to the Dashboard click that IS the deterministic fix.

---

## 15. Frontend work log — Ask CFO AI chat surface (2026-07-21)

> Frontend-only UI work (Vite bundle, no engine/backend impact). Recorded here
> per the owner's request to track what changed since the last CLAUDE.md update
> (§14 protocols were the prior tail, dated 2026-05-26). The engine deploy
> protocol (§14) does **not** apply to any of this — every change ships through
> `docker compose build frontend`; there is no `docker cp` shortcut for FE code.

**Scope:** redesign of the `/chat` "Ask CFO AI" surface and the app chrome
around it. All files under `frontend/`:

- **`pages/cfo/Chat.tsx` + `components/cfo/chat/CFOChatShell.tsx`** — full-bleed
  chat layout. Removed the "Ask CFO AI / Ask about your company, documents,
  strategy, or finance." page header. The conversation now uses the full width
  and full height and extends up **under** the translucent top header (the chat
  wrapper cancels AppShell's `pt-16` and runs a full `100dvh`; the sidebar and
  message list carry matching top insets so their content clears the header).
- **`components/cfo/chat/CFOComposer.tsx`** — the composer floats as a
  transparent overlay pinned to the bottom (input field `bg-transparent` with a
  `bg → transparent` fade behind it); the conversation scrolls underneath it.
  Send button recolored from `bg-ink` to the brand accent (`bg-brand`).
- **`components/cfo/chat/CFOMessageList.tsx`** — `topInset` / `bottomInset` props
  pad the first/last message clear of the overlaid header/composer. App-themed
  thin scrollbar (`.chat-scroll`, defined in `index.css`) that hugs the screen's
  right edge; the `/chat` route opts out of AppShell's `max-w-[1760px]` clamp so
  the scrollbar reaches the absolute right edge. The bottom fade overlay stops
  short of the scrollbar gutter (`right-[10px]`) so the scrollbar stays visible.
- **Context grounding** ("Grounded in … / No workspace loaded — open-domain
  mode") moved into a pill directly above the composer.
- **`components/cfo/chat/CFOMessageBubble.tsx` + `CFOTypingIndicator.tsx`** —
  removed the Sparkles badge before the "CFO AI" eyebrow label.
- **`components/cfo/chat/CFOHistorySidebar.tsx`** — background removed; the "⋯"
  dropdown (rename/delete) replaced by a single hover **delete** button; "New
  chat" is now an **icon-only** brand-accent button beside the search field; the
  "Older" bucket label was dropped.
- **`components/cfo/chat/useChatStore.ts`** — `deriveTitle()` now generates
  concise, Claude-Code-style conversation titles from the first message (strips
  leading filler like "can you…"/"what is…", capitalizes, trims trailing
  punctuation, caps on a word boundary at 48 chars).
- **`components/cfo/TopHeader.tsx`** — navbar restyled toward the landing-page
  aesthetic: translucent glass (`surface/0.55` + `backdrop-blur-xl`),
  mono/uppercase workspace tagline, "Ask CFO AI" pill uses the teal
  `bg-gradient-cfo` with glow, "Sign in" mono-uppercased. Removed a duplicate
  "CFO AI" wordmark (the `<Logo>` component already renders one).
- **`components/cfo/Sidebar.tsx`** — removed the "CFO AI" mark + label from the
  workspace-identity header of the main left nav rail.

**Note on CLAUDE.md files:** the repo has two — this root `CLAUDE.md` (the
financial-analysis operating manual) and `files/CLAUDE.md` (a *separate* doc:
"SKU Decision Engine — Scandia Trading Division"). They are **not** duplicates,
so they were not merged. This work log lives in the root file only.

---

# 📘 Appendix A — Full Financial Analysis Methodology

> *The complete methodology document is embedded below for self-contained reference.*
> *This is the source of truth for the framework. The Python implementation in Appendix B mirrors this exactly.*

A reusable framework for producing CFO-grade financial analyses from Romanian trial balances (RAS) — 8 sections, end-to-end. Calibrated on the Scandia Food FY2025 case.

This document is the **map**. Read it first, then apply the framework by:
1. Following the eight-section structure (Section 4 below)
2. Using the RAS account-mapping cheat sheet (Section 3)
3. Running the Python implementation (`financial_analysis.py`) for the heavy compute
4. Filling the HTML template (`report_template.html`) with the computed values

---

## 1. When to use this framework

This is the right framework for:

- **Romanian SME / mid-cap financial analysis** — anywhere you have a trial balance (balanță de verificare) and need a comprehensive read
- **Investment due diligence** — buy-side or sell-side analysis of operating companies
- **Annual review / board reports** — structured presentation of a fiscal year
- **Credit underwriting** — bank or non-bank lender risk assessment
- **Family-office portfolio reviews** — recurring analysis across multiple group entities

Not the right framework for:

- Real estate single-asset vehicles (use the NAV framework — `nav_methodology.md`)
- Pre-revenue startups (no operating history to ratio-analyze)
- Banks, insurance, regulated financial institutions (different account structure)
- Pure holding companies with no operations (NAV-only)

Rule of thumb: if the entity has ≥ 12 months of operating P&L activity (class 6/7 accounts populated) and a meaningful balance sheet (>500K RON total assets), use this framework.

---

## 2. The eight sections — what each one delivers

Every analysis produces these eight sections, in this order. Each builds on the prior.

| § | Section | Purpose | Input | Output |
|---|---|---|---|---|
| 1 | **Overview** | Executive summary, KPI dashboard, company snapshot | Raw trial balance | 8 headline KPIs + narrative |
| 2 | **P&L** | Statutory P&L reconstruction from class 6/7 movements | Class 6 (D) + Class 7 (C) sums | Full income statement |
| 3 | **Balance Sheet** | Assets / Equity-Liabilities from closing balances | Classes 1–5 closing balances | Full balance sheet |
| 4 | **Cash Flow** | Indirect method from P&L + BS changes | P&L + period-end balances | CFO/CFI/CFF reconciliation |
| 5 | **Ratios** | 25+ ratios across 5 dimensions | P&L + BS | Profitability/liquidity/leverage/coverage/efficiency |
| 6 | **Valuation** | Multi-method valuation envelope | EBITDA + balance sheet | EV/EBITDA + DCF + NAV cascade |
| 7 | **Risk & Credit** | Composite credit score, Altman Z″, risk inventory | All prior sections | 0–100 composite score + risk list |
| 8 | **Recommendations** | Prioritized action items | All prior sections | 5–8 ranked recommendations |

The flow is sequential: P&L feeds ratios feeds valuation feeds credit feeds recommendations. Don't skip steps.

---

## 3. Romanian RAS account-mapping cheat sheet

This is the universal mapping. Every Romanian trial balance follows this structure.

### Class 1 — Capital, reserves, long-term debt (Credit balance)
| Prefix | Meaning | Where it goes |
|---|---|---|
| 101 / 1012 | Share capital (paid-in) | Equity |
| 104 | Share premium / merger premium | Equity |
| 105 | Revaluation reserve | Equity |
| 106 / 1061 / 1068 | Legal & other reserves | Equity |
| 117 / 1171 / 1174 | Retained earnings (1171 credit, 1174 debit) | Equity (net) |
| 121 | Profit & loss account (closing C = net profit) | Equity |
| 129 | Profit distribution | Equity (offset) |
| 15x | Provisions (litigation, decommissioning) | LT liabilities |
| 162 | LT bank loans | LT debt |
| 167 | Leasing obligations | LT debt |
| 168 | Accrued LT interest | LT debt |

### Class 2 — Fixed assets (Debit balance)
| Prefix | Meaning | Where it goes |
|---|---|---|
| 205 / 208 | Intangibles (licenses, software, etc.) | Intangibles gross |
| 211 | Land & site improvements | PP&E gross |
| 212 | Buildings | PP&E gross |
| 213 (2131/2132/2133) | Equipment (technological, measurement, transport) | PP&E gross |
| 214 | Furniture & office | PP&E gross |
| 215 | Investment property | PP&E (separate) |
| 23x | Construction in progress (CIP) | Non-current |
| 261 | Shares in affiliates | Financial fixed |
| 263 | Other equity interests | Financial fixed |
| 265 / 267 | Other LT investments / receivables | Financial fixed |
| 28x | Accumulated depreciation/amortization (Credit) | Contra-asset |

### Class 3 — Inventory (Debit balance)
| Prefix | Meaning | Where it goes |
|---|---|---|
| 301 / 302 / 303 | Raw materials, consumables, small inventory | Inventory |
| 32x | Inventory in transit | Inventory |
| 331 / 341 | WIP, semi-finished | Inventory |
| 345 | Finished products | Inventory |
| 348 / 378 | Price differentials (D or C) | Inventory adjustment |
| 351 / 357 | Inventory at third parties | Inventory |
| 371 | Merchandise (for resale) | Inventory |
| 381 | Packaging | Inventory |
| 39x | Inventory provisions (Credit) | Contra-asset |

### Class 4 — Receivables / Payables (Mixed)
| Prefix | Meaning | Where it goes |
|---|---|---|
| 401 | Trade payables (domestic) | ST liability |
| 403 | Notes payable | ST liability |
| 404 / 405 | Fixed asset payables | ST liability |
| 408 | Invoices not received | ST liability |
| 409 | Supplier advances (Debit) | Receivable |
| 411 | Trade receivables (D) | Receivable |
| 413 | Notes receivable (D) | Receivable |
| 418 | Customer accruals | Receivable or liability (C = liability) |
| 419 | Customer advances | ST liability |
| 42x (421/423/425/427/428) | Personnel-related (mostly C) | ST liability |
| 43x | Social security (mixed; usually C) | ST liability |
| 44x | State / tax (mixed) | ST liab if C, receivable if D |
| 45x (451/452/455) | Affiliated parties (mixed) | Group rec/pay |
| 457 | Dividends payable | ST liability |
| 46x | Other debtors/creditors | Receivable or liability |
| 471 | Prepaid expenses (D) | Receivable |
| 472 | Deferred revenue (C) | ST liability |
| 475 | Investment subsidies (C) | LT liability |
| 478 | Grants (C) | LT liability |
| 49x | Receivables provisions (C) | Contra-asset |

### Class 5 — Cash & equivalents (Debit balance)
| Prefix | Meaning | Where it goes |
|---|---|---|
| 5121 | Bank accounts in RON | Cash |
| 5124 | Bank accounts in FX | Cash |
| 519 | ST bank loans (Credit) | ST debt |
| 531 | Petty cash | Cash |
| 541 / 542 | Other cash | Cash |
| 581 | Internal transfers (should net to ~0) | Cash |

### Class 6 — Expenses (Debit movements)
| Prefix | Meaning |
|---|---|
| 601 | Raw materials |
| 602 | Auxiliary materials / consumables |
| 603 | Inventory items (small tools) |
| 604 | Non-storable materials |
| 605 | Utilities (electricity, gas, water) |
| 607 | Cost of merchandise sold |
| 608 | Packaging |
| 61x | Maintenance, rent, insurance |
| 62x | External services (logistics, marketing, consulting) |
| 63x | Other taxes & levies |
| 64x | Personnel (641 salaries, 645 social) |
| 65x | Other operating expenses |
| 665 | FX losses |
| 666 | Interest expense |
| 667 | Discounts paid |
| 668 | Other financial expenses |
| 681 | Depreciation & amortization |
| 69x | Income tax |

### Class 7 — Revenue (Credit movements)
| Prefix | Meaning |
|---|---|
| 701 | Sale of finished products |
| 702 | Sale of semi-finished |
| 703 | Sale of residues |
| 704 | Sale of services |
| 705 | Studies/research |
| 706 | Rent / royalties |
| 707 | Sale of merchandise |
| 708 | Activity revenue / discounts received from suppliers |
| 709 | **Commercial reductions to customers (contra-revenue)** |
| 711 / 712 | Production variation (nets D vs C) |
| 72x | Capitalized own work |
| 758 | Other operating revenue |
| 761 | Income from affiliates / dividends |
| 765 | FX gains |
| 766 | Interest income |
| 768 | Other financial income |
| 781 | Operating provision reversals |

### Critical reconciliation points

1. **Trial balance must balance**: Sum of all `sume_totale_D` must equal Sum of all `sume_totale_C`. If not, the data feed is broken — stop and re-extract.
2. **Net profit anchor**: The closing C balance of account 121 IS the statutory net profit. Reconstruct from class 6/7 and check within ±2%; if larger gap, find the missing accounts.
3. **709 is contra-revenue**: Class 70 sum already nets 709. Don't subtract it twice.
4. **711 nets to ~0**: Production variation movements offset between debit (production consumed) and credit (production stored). Net is the change in WIP/finished inventory.
5. **Class 44 is mixed**: VAT receivable (442x debit) is an asset; income tax payable (441 credit) is a liability. Don't sum them as one.

---

## 4. The eight sections — detailed methodology

### Section 1: Overview

**Purpose:** A 30-second read of the company. KPI dashboard + narrative.

**The 8 headline KPIs** (computed in Section 2/3/5 below):
1. Net Turnover (cifra de afaceri)
2. EBITDA + margin %
3. Net Profit + margin %
4. Total Assets
5. Equity Ratio (E/A)
6. Net Debt / EBITDA
7. ROE
8. Altman Z″ Score

**Narrative structure (3-4 sentences):**
- Company snapshot (industry, scale, ownership type from share capital line)
- Profitability verdict (compare margins to industry — use Section 5 benchmarks)
- Capital structure verdict (equity ratio + leverage)
- Key forward concern or strength

**Output format:** 4-column KPI grid (8 KPIs total in 2 rows) + 4-sentence narrative + company snapshot table (legal form, share capital, total accounts, business activity).

---

### Section 2: P&L Reconstruction

**Purpose:** Build the full income statement from class 6 (Debit movements) and class 7 (Credit movements).

**Algorithm:**

```
1. Net Turnover = Σ(class 70 Credit movements)
   Components for display:
   - 701 sales of finished products
   - 707 sales of merchandise
   - 704 + 706 services & rent
   - 708 activity revenue
   - 709 commercial reductions (contra, already netted in class 70 sum)

2. Other operating revenue:
   - 758 other operating
   - 781 provision reversals
   - 711 - 711_D production variation (net)
   - 72x capitalized work

3. Total operating revenue = Net Turnover + Other operating revenue

4. Operating expenses (sum class 60-65, 68):
   Break out: 601 raw mat, 602 consumables, 605 utilities, 607 COGS,
              608 packaging, 61 maint/rent, 62 services, 63 taxes,
              64 personnel, 65 other operating, 681 D&A

5. EBIT (Operating result) = Operating revenue - Operating expense
6. EBITDA = EBIT + D&A (681)

7. Financial result:
   Revenue: 761 affiliates, 765 FX gain, 766 interest, 768 other
   Expense: 665 FX loss, 666 interest, 667 discounts, 668 other
   Net financial = sum revenue - sum expense

8. PBT = EBIT + Net financial
9. Income tax = sum class 69 Debit
10. Net profit (reconstructed) = PBT - Tax

11. RECONCILIATION CHECK:
    Reconstructed net profit must match closing C of account 121 ±2%.
    If gap > 2%, search for missing accounts in class 6/7.
```

**Output format:** Line-by-line P&L table with: line item / RAS account / RON value / % of turnover. Highlight EBITDA, EBIT, Net Profit rows. Include reconciliation note showing reconstructed vs statutory net profit.

---

### Section 3: Balance Sheet

**Purpose:** Build the closing balance sheet from classes 1-5 closing balances.

**Algorithm:**

```
NON-CURRENT ASSETS:
  Intangibles gross = Σ(205, 208 closing D)
  Intangibles amort = Σ(280 closing C)
  Intangibles net = gross - amort

  PP&E gross = Σ(211, 212, 213, 214 closing D)
  PP&E amort = Σ(281 closing C)
  PP&E net = gross - amort

  CIP = Σ(23x closing D) - Σ(29x closing C)

  Financial fixed = Σ(26x closing D net of provisions)

CURRENT ASSETS:
  Inventory:
    Gross = Σ(3xx closing D) - Σ(3xx closing C, mostly 39 provisions)
    Note: 348/378 price diffs can be either sign

  Receivables:
    Gross trade = Σ(411 closing D)
    Other = Σ(409, 413, 425, 44 debit, 46 debit, 471 closing D)
    Provisions = Σ(49 closing C)
    Net receivables = gross - provisions

  Cash:
    = Σ(512, 531, 541, 542 closing D - C)

EQUITY:
  Share capital = Σ(101 closing C)
  Share premium = Σ(104 closing C)
  Revaluation = Σ(105 closing C)
  Reserves = Σ(106 closing C)
  Retained = Σ(117 closing C - D)
  Current profit = Σ(121 closing C - D)
  TOTAL EQUITY = sum above

LIABILITIES:
  LT:
    Bank loans = Σ(162 closing C - D)
    Leasing = Σ(167 closing C - D)
    Provisions = Σ(15 closing C)
    Subsidies = Σ(475 closing C - D)
  ST:
    Bank ST = Σ(519 closing C)
    Trade pay = Σ(401, 403, 404, 405, 408 closing C - D)
    Personnel = Σ(421, 423, 427, 428 closing C - D)
    Social = Σ(43 closing C - D, positive only)
    Tax = Σ(44 closing C - D, positive only)
    Dividends = Σ(457 closing C)
    Other = Σ(46 closing C - D, positive only)
    Customer advances = Σ(419 closing C)
    Deferred revenue = Σ(472 closing C)
    Affiliated = Σ(451, 452, 455 closing C - D, positive only)

RECONCILIATION:
  Total Assets must equal Total Equity + Liabilities ±0.5%
  If gap > 0.5%, find missing/misclassified accounts
```

**Output format:** Two tables (Assets / Equity & Liabilities). Each line: item / RAS prefix / RON / % of total. Highlight subtotals (non-current, current, total assets, total equity, total liabilities). Include reconciliation footer.

---

### Section 4: Cash Flow Statement

**Purpose:** Reconstruct cash flow via indirect method.

**Required input:** Both opening (Dec prior year) AND closing trial balances. If only closing available, mark working capital changes as `~approximated` with ±15% uncertainty band.

**Algorithm:**

```
OPERATING:
  Start: Net profit (from 121)
  + D&A (681)
  + Provision movements (net 781 reversal - 65x charges)
  ± FX revaluation non-cash (if 665/765 are non-cash)
  = Cash from operations before WC

  Working capital changes (negative = use of cash):
  Δ Inventory = -(closing_inventory - opening_inventory)
  Δ Receivables = -(closing_receivables - opening_receivables)
  Δ Trade payables = +(closing_AP - opening_AP)
  Δ Tax/social payables = +(closing - opening)
  Δ Other working capital = +/- as relevant

  CFO = sum above

INVESTING:
  - Capex on PP&E = -(Δ PP&E gross - D&A)
  - CIP additions = -(Δ 231)
  - Affiliate increases = -(Δ 261 + 263)
  + Dividends from affiliates = +761 (cash basis = P&L value)
  + Interest received = +766 (typically cash)
  + Asset disposal proceeds (if any)
  = CFI

FINANCING:
  Δ LT debt = +new draws - repayments
  Δ ST bank = +(519 closing - opening)
  - Interest paid = -666 (cash basis = P&L value)
  - Dividends paid = (P&L 121 distribution + Δ 457 movement)
  + Capital increases (if any)
  = CFF

Net change in cash = CFO + CFI + CFF
Verify: opening cash + net change = closing cash
```

**Output format:** Three-section table (Operating / Investing / Financing). Each line item with value. Mark approximated lines with `~` prefix. Reconciliation footer with cash bridge.

---

### Section 5: Financial Ratios

**Purpose:** 25+ ratios across 5 dimensions, each with industry benchmark and verdict.

**The five dimensions:**

#### Profitability (6 ratios)
| Ratio | Formula | Benchmark by industry |
|---|---|---|
| EBITDA margin | EBITDA / Turnover | Food mfg: 8-13%, Real estate: 50%+ |
| EBIT margin | EBIT / Turnover | Food mfg: 5-10% |
| Net margin | Net profit / Turnover | Food mfg: 3-7% |
| Gross margin | (Turnover - Materials) / Turnover | Industry-dependent |
| ROE | Net profit / Avg equity | 12-20% general |
| ROA | Net profit / Avg assets | 5-10% general |
| ROIC | NOPAT / (Equity + Debt) | 10-15% strong |

#### Liquidity (4 ratios)
| Ratio | Formula | Benchmark |
|---|---|---|
| Current ratio | CA / CL | >1.5× ideal |
| Quick ratio | (CA - Inventory) / CL | >1.0× ideal |
| Cash ratio | Cash / CL | >0.20× comfortable |
| Working capital | CA - CL | Positive |

#### Leverage / Solvency (5 ratios)
| Ratio | Formula | Benchmark |
|---|---|---|
| Equity ratio | Equity / Assets | >30% |
| Debt / Equity | Total debt / Equity | <1.0× |
| LT debt / Equity | LT debt / Equity | <0.6× |
| Net Debt / EBITDA | (Debt - Cash) / EBITDA | <3.0× |
| Debt / Assets | Total debt / Assets | <40% |

#### Coverage (3 ratios)
| Ratio | Formula | Benchmark |
|---|---|---|
| Interest coverage | EBIT / Interest expense | >3.0× safe |
| EBITDA / Interest | EBITDA / Interest | >4.0× safe |
| DSCR | EBITDA / (Interest + ST debt principal) | >1.25× |

#### Efficiency (6 ratios)
| Ratio | Formula | Benchmark |
|---|---|---|
| Asset turnover | Turnover / Avg assets | 1.0-1.5× |
| Inventory turnover | COGS / Avg inventory | 5-10× |
| DIO | Inventory / COGS × 365 | 40-70 days |
| DSO | Receivables / Turnover × 365 | 30-60 days |
| DPO | Payables / COGS × 365 | 40-70 days |
| CCC | DIO + DSO - DPO | <60 days |

**Output format:** Five tables (one per dimension). Each row: Ratio / Value / Benchmark / Verdict (color-coded). Verdict is one of: green ("Strong"), amber ("Adequate" / "Watch"), red ("Weak").

---

### Section 6: Valuation

**Purpose:** Multi-method envelope.

**Method selection logic:**

```
if industry in {real_estate, holding_company}:
    primary = "cap_rate" or "NAV"
elif industry in {food_mfg, consumer_goods, services}:
    primary = "EV/EBITDA"
elif industry in {tech, high_growth}:
    primary = "DCF" or "revenue_multiple"

Always include:
  - EV/EBITDA at 6x, 8x, 10x (conservative / mid / premium)
  - DCF with Gordon terminal (5-year explicit + perpetual)
  - NAV (4-layer cascade — use nav_calculator.py for asset-heavy)
  - Book equity (floor)
```

#### EV/EBITDA method
```
For each multiple in [6x (conservative), 8x (mid), 10x (premium)]:
    EV = EBITDA × multiple
    Equity value = EV - Net debt
```

#### DCF method
```
WACC build-up (Romania):
  Rf = 6.5-7.5% (RO 10Y govt)
  ERP = 7-8% (Damodaran emerging markets)
  Beta = industry-typical (food 0.7-0.9, real estate 0.6-0.8, tech 1.2)
  Cost of equity = Rf + Beta × ERP
  Cost of debt = 5.5-7.5% after-tax for RO SME
  WACC = Equity weight × Ke + Debt weight × Kd × (1 - 0.16)

DCF compute:
  FCF base = Net profit + D&A - Maintenance capex
  (If maint capex ≈ D&A, then FCF = Net profit)

  5-year explicit forecast:
    FCF_t = FCF_base × (1 + g)^t, with g typically 3-7%

  Terminal value:
    TV = FCF_5 × (1 + g_terminal) / (WACC - g_terminal)
    g_terminal = 2-3% (inflation + GDP)

  EV = Σ(FCF_t / (1+WACC)^t for t=1..5) + TV / (1+WACC)^5
  Equity = EV - Net debt
```

#### NAV
For asset-heavy businesses, run the full NAV cascade from `nav_methodology.md`:
- Layer 1: Statutory book NAV
- Layer 2: Going-concern adjusted NAV
- Layer 3: EPRA NNNAV (with deferred tax)
- Layer 4: Liquidation NAV

**Output format:**
- 6.1 Method comparison table (3 EV/EBITDA scenarios + DCF + NAV + Book) with central recommendation highlighted
- 6.2 DCF inputs table (Rf, ERP, beta, WACC, g, etc.) for transparency
- 6.3 Convergence map showing all methods side-by-side

**Central estimate logic:** Pick the average of the top 2-3 closest values; this is your defensible negotiating anchor.

---

### Section 7: Risk & Credit Rating

**Purpose:** Single composite score 0-100 mapped to letter rating + risk inventory.

#### Altman Z″ Score (emerging markets variant)
```
X1 = (CA - CL) / Total Assets
X2 = Retained Earnings / Total Assets
X3 = EBIT / Total Assets
X4 = Book Equity / Total Liabilities

Z" = 6.56 × X1 + 3.26 × X2 + 6.72 × X3 + 1.05 × X4

Interpretation:
  Z" > 2.60       → SAFE zone (low bankruptcy risk)
  1.10 ≤ Z" ≤ 2.60 → GREY zone (caution)
  Z" < 1.10       → DISTRESS zone (high risk)
```

#### Piotroski F-Score (0-9)
Score 1 point per condition met (anti-distress checks):
1. Net income > 0
2. Operating cash flow > 0
3. ROA improving vs prior year
4. OCF > Net income (quality of earnings)
5. Lower leverage vs prior year
6. Higher current ratio vs prior year
7. No new share issuance (constant shares)
8. Higher gross margin vs prior year
9. Higher asset turnover vs prior year

Score ≥7: Strong. 4-6: Average. ≤3: Weak.

#### Composite credit score (0-100, weighted)
```
Composite =
    30% × Altman Z" score (mapped to 0-100)
    20% × Profitability score (ROE + Net margin avg)
    15% × Leverage score (lower D/E = higher)
    10% × Interest coverage score
    10% × DSCR score
    10% × Liquidity score (current + quick + cash avg)
     5% × Equity ratio score

Letter grade mapping:
  90-100  → AAA / AA (investment grade premium)
  80-89   → A (investment grade strong)
  70-79   → BBB / BB+ (investment grade)
  60-69   → BB (speculative grade strong)
  50-59   → B (speculative grade)
  40-49   → CCC (speculative grade weak)
  <40     → CC / C / D (distress / default)
```

#### Risk inventory
Free-form list of 5-8 specific risks identified during analysis. Categories to consider:
- Customer concentration (look at receivables breakdown)
- Supplier concentration (look at payables breakdown)
- FX exposure (5124 cash + 765/665 movements)
- Raw material price exposure (% materials of turnover)
- Affiliate dependency (% income from 761)
- Provision quality (49x and 39x provisions vs gross)
- Working capital tightness (cash ratio)
- Asset maturity (accumulated dep ÷ gross PP&E)
- Refinancing risk (LT debt maturity wall)
- Regulatory / litigation (15 provisions)

**Output format:**
- 7.1 Composite score card (large visual with grade)
- 7.2 Component breakdown table
- 7.3 Altman Z″ detail (component breakdown)
- 7.4 Piotroski F-Score detail
- 7.5 Risk inventory (numbered list with severity tags)

---

### Section 8: Recommendations

**Purpose:** 5-8 prioritized, specific, actionable items.

**Selection rules:**
- Each recommendation must address a specific finding from Sections 5-7
- Each must have measurable impact (RON or pp metric improvement)
- Each must be feasible (no "double EBITDA" generic items)
- Distribute across severity: 1-2 Critical / 2-3 High / 2-4 Medium

**Standard categories to consider:**

| Source finding | Typical recommendation |
|---|---|
| Cash ratio <0.10 | Build liquidity buffer to 5% of ST liab |
| Receivables provision >15% | Investigate aging schedule, write off old |
| KA concentration >50% receivables | Pricing pass-through with key customers |
| Net Debt/EBITDA <2× | Capacity to lever for capex / acquisitions |
| Accumulated dep >55% gross PP&E | Capex modernization plan needed |
| Raw materials >30% turnover | Hedging program forward 6-12 months |
| Affiliate income >15% net profit | Affiliate portfolio review / divestment |
| Multiple loan facilities | Covenant dashboard + lender relationship management |
| FX cash >10% of cash | FX hedging policy |
| Goodwill / intangibles material | Impairment test scheduled |

**Output format per recommendation:**
```
[Severity tag: Critical / High / Medium]
[Numbered title — specific action]
- Why: 1-2 sentences linking to the finding
- Action: 2-3 sentences with concrete steps
- Impact: Quantified outcome (RON, pp, ratio change)
```

End with a bottom-line summary paragraph: "Bottom line: ..." — what kind of company is this and what's the 12-18 month path.

---

## 5. The HTML report template

After computing all sections, fill an HTML template with:
- Navy header card (gradient #003366 → #1a5490) with company name + reporting period
- Nav bar linking to all 8 sections (#overview, #pnl, etc.)
- 8 section blocks following the order above
- Color coding: green #0a7c3a for positive, red #c62828 for critical, amber #f39c12 for warnings, navy #003366 for headers
- Tabular numbers right-aligned with `font-variant-numeric: tabular-nums`
- Methodology disclaimer in footer if cash flow approximations are used

Use the same CSS/styling as the existing v5 site (navy/amber theme).

---

## 6. Output structure (Claude Code workflow)

When invoked on a new trial balance, Claude Code should:

```
1. Read trial balance file (xlsx, csv, or pdf-extracted text)
2. Validate format:
   - Identify the 10 columns (cont, nume, sold_init_D/C, rulaj_D/C, sume_tot_D/C, sold_fin_D/C)
   - Verify trial balance balances (sum D = sum C)
   - Count accounts; expect 500-1500 for typical SME
3. Run financial_analysis.py:
   - Extracts all metrics following Section 3 mappings
   - Reconciles net profit to account 121 closing
   - Reconciles balance sheet to total D
4. Generate HTML report:
   - 8 sections per Section 4 methodology
   - Fill the template
   - Save to /mnt/user-data/outputs/<Company>_Comprehensive_Analysis_<Year>.html
5. Present file to user with a summary message:
   - 3-line executive summary (verdict, key strength, key risk)
   - File link
```

---

## 7. Common errors and how to handle

| Error | Symptom | Fix |
|---|---|---|
| Trial balance doesn't balance | Sum D ≠ Sum C | Re-extract source; ask user for clean version |
| Net profit reconstructed >5% off from 121 | Missing class 6 or 7 accounts | Search for unusual prefixes; check 6x and 7x completeness |
| Balance sheet >1% off | Misclassified mixed accounts (class 4) | Net debit/credit per account, not by class total |
| Negative inventory | Inventory provisions >gross | Check 39x columns; flag as data issue |
| Negative cash | 519 ST debt netted into class 5 incorrectly | Separate 512/531 (cash) from 519 (debt) |
| Affiliates 261 = 0 but 761 income present | Investment classification issue | May be in 263 or 265 instead |
| Class 44 net negative | Mixed VAT receivable + tax payable | Split: 442x asset, 441 liability |
| Foreign company / IFRS data | Different account structure | This framework is RAS-specific; flag for manual work |

---

## 8. Calibration: the Scandia Food example

The framework was calibrated on Scandia Food SRL FY2025. Reference values:

| Metric | Value |
|---|---|
| Trial balance total | 460,963,810 RON (balanced ✓) |
| Accounts active | 809 |
| Net turnover | 413,727,560 |
| EBITDA | 54,443,834 (13.2% margin) |
| Net profit (121 closing) | 36,787,353 |
| Reconstructed net profit | 36,267,964 (gap 1.4%, acceptable) |
| Total assets | 293,050,085 (reconciled within 0.5%) |
| Total equity | 150,151,551 (51.2% equity ratio) |
| Altman Z″ | 3.09 (safe zone) |
| Composite credit | 82/100 → A− |
| Recommendation count | 7 (1 Critical + 3 High + 3 Medium) |
| Valuation range | 380-500M RON (EV/EBITDA 6-10×) |

Use these to sanity-check any new company's outputs. If a similar-size food manufacturer comes back with Z″ <2 or composite <65, double-check the data; it's an outlier.

---

## 9. References

- Python implementation: `financial_analysis.py`
- HTML template: `report_template.html` (or use existing v5 site styling)
- NAV deep-dive: `nav_methodology.md` + `nav_calculator.py`
- Scandia worked example: `Scandia_Food_Comprehensive_Analysis_FY2025.html`
- EEI worked example: `EEI_Imobiliara_Comprehensive_Analysis_v5.html` (single-asset RE case)
- Transavia benchmark reference: `Transavia_PnL_Benchmark_2024.html`
- Comparison example: `PnL_Comparison_Upload_vs_Transavia_vs_Industry.html`

---

# 🐍 Appendix B — Full Python Implementation (`financial_analysis.py`)

> *The complete working implementation of the 8-section framework.*
> *This is what `analyze_company()` executes. Embedded here so Claude Code has the entire codebase in one file.*

```python
"""
Comprehensive Financial Analysis — Romanian SME / Mid-cap from RAS Trial Balance
================================================================================

Implements the 8-section framework described in financial_analysis_methodology.md:
  1. Overview / KPIs
  2. P&L reconstruction
  3. Balance Sheet
  4. Cash Flow (indirect)
  5. Ratios (25+)
  6. Valuation (EV/EBITDA + DCF + NAV + Book)
  7. Risk & Credit (Altman Z", Piotroski, composite)
  8. Recommendations

USAGE:
    from financial_analysis import analyze_company

    result = analyze_company(
        trial_balance_path="balanta.xlsx",
        company_name="Scandia Food SRL",
        period="FY2025",
        industry="food_mfg",            # see INDUSTRY_BENCHMARKS below
        prior_period_path=None,         # optional; enables full cash flow
        output_html_path="report.html", # optional; writes HTML if set
    )

    # `result` is a dict containing all 8 sections' computed values.

The Scandia Food case is included as the calibration example at the bottom.
"""

from dataclasses import dataclass, field
from typing import Optional, List, Dict, Tuple
import pandas as pd


# ──────────────────────────────────────────────────────────────────────
# INDUSTRY BENCHMARKS (RO market, 2024-25)
# ──────────────────────────────────────────────────────────────────────

INDUSTRY_BENCHMARKS = {
    "food_mfg": {
        "ebitda_margin": (0.08, 0.13),
        "net_margin": (0.03, 0.07),
        "roe": (0.12, 0.20),
        "current_ratio": (1.2, 1.8),
        "quick_ratio": (0.7, 1.0),
        "net_debt_ebitda": (1.0, 3.0),
        "interest_coverage": (3.0, 8.0),
        "dio": (40, 70),
        "dso": (30, 60),
        "ev_ebitda_range": (6.0, 10.0),
        "default_wacc": 0.10,
    },
    "real_estate": {
        "ebitda_margin": (0.50, 0.80),
        "net_margin": (0.20, 0.50),
        "roe": (0.05, 0.12),
        "current_ratio": (0.8, 1.5),
        "quick_ratio": (0.5, 1.0),
        "net_debt_ebitda": (3.0, 8.0),
        "interest_coverage": (1.5, 4.0),
        "dio": (0, 5),
        "dso": (15, 45),
        "ev_ebitda_range": (8.0, 14.0),
        "default_wacc": 0.085,
    },
    "consumer_goods": {
        "ebitda_margin": (0.10, 0.18),
        "net_margin": (0.05, 0.10),
        "roe": (0.15, 0.25),
        "current_ratio": (1.5, 2.5),
        "quick_ratio": (0.8, 1.2),
        "net_debt_ebitda": (1.0, 2.5),
        "interest_coverage": (4.0, 10.0),
        "dio": (50, 90),
        "dso": (30, 60),
        "ev_ebitda_range": (7.0, 12.0),
        "default_wacc": 0.10,
    },
    "services": {
        "ebitda_margin": (0.12, 0.22),
        "net_margin": (0.06, 0.12),
        "roe": (0.15, 0.30),
        "current_ratio": (1.2, 2.0),
        "quick_ratio": (1.0, 1.6),
        "net_debt_ebitda": (0.5, 2.0),
        "interest_coverage": (5.0, 15.0),
        "dio": (0, 15),
        "dso": (30, 75),
        "ev_ebitda_range": (8.0, 14.0),
        "default_wacc": 0.105,
    },
    "default": {
        "ebitda_margin": (0.08, 0.15),
        "net_margin": (0.03, 0.08),
        "roe": (0.10, 0.20),
        "current_ratio": (1.2, 2.0),
        "quick_ratio": (0.7, 1.2),
        "net_debt_ebitda": (1.0, 3.0),
        "interest_coverage": (3.0, 8.0),
        "dio": (30, 70),
        "dso": (30, 60),
        "ev_ebitda_range": (6.0, 10.0),
        "default_wacc": 0.10,
    },
}


# ──────────────────────────────────────────────────────────────────────
# DATA LOADING
# ──────────────────────────────────────────────────────────────────────

def load_trial_balance(path: str) -> pd.DataFrame:
    """
    Load a Romanian RAS trial balance from xlsx/csv.
    Expected 10 columns (Romanian SAGA / WinMentor / Saga format):
      cont, nume, sold_init_D, sold_init_C, rulaj_D, rulaj_C,
      sume_tot_D, sume_tot_C, sold_fin_D, sold_fin_C
    """
    if path.endswith(".xlsx"):
        df = pd.read_excel(path, sheet_name=0, header=None, skiprows=1)
    else:
        df = pd.read_csv(path, header=None, skiprows=1)

    df.columns = [
        "cont", "nume",
        "sold_init_D", "sold_init_C",
        "rulaj_D", "rulaj_C",
        "sume_tot_D", "sume_tot_C",
        "sold_fin_D", "sold_fin_C",
    ]
    df = df[df["cont"].notna()].copy()
    df["cont"] = df["cont"].astype(str)
    for c in df.columns[2:]:
        df[c] = pd.to_numeric(df[c], errors="coerce").fillna(0)
    df["class"] = df["cont"].str[0]
    return df


def validate_trial_balance(df: pd.DataFrame) -> Dict:
    """Run basic sanity checks. Returns dict with status + any warnings."""
    issues = []
    sum_D = df["sume_tot_D"].sum()
    sum_C = df["sume_tot_C"].sum()
    if abs(sum_D - sum_C) > 1.0:
        issues.append(f"Trial balance not balanced: D={sum_D:,.2f}, C={sum_C:,.2f}")
    close_D = df["sold_fin_D"].sum()
    close_C = df["sold_fin_C"].sum()
    if abs(close_D - close_C) > 1.0:
        issues.append(f"Closing balances not balanced: D={close_D:,.2f}, C={close_C:,.2f}")
    if len(df) < 50:
        issues.append(f"Only {len(df)} accounts — may be incomplete")
    return {"status": "ok" if not issues else "warning",
            "issues": issues,
            "total_assets_estimate": close_D,
            "account_count": len(df)}


# Helper: sum balance for a list of account prefixes
def _sum_prefix(df: pd.DataFrame, prefixes, col: str) -> float:
    """Sum a column for accounts starting with any of the given prefixes."""
    if isinstance(prefixes, str):
        prefixes = [prefixes]
    mask = pd.Series([False] * len(df), index=df.index)
    for p in prefixes:
        mask |= df["cont"].str.startswith(p)
    return df.loc[mask, col].sum()


def _net_balance(df: pd.DataFrame, prefixes, side="D") -> float:
    """Closing balance net (D - C) or (C - D) for accounts."""
    if isinstance(prefixes, str):
        prefixes = [prefixes]
    d = _sum_prefix(df, prefixes, "sold_fin_D")
    c = _sum_prefix(df, prefixes, "sold_fin_C")
    return (d - c) if side == "D" else (c - d)


# ──────────────────────────────────────────────────────────────────────
# SECTION 2: P&L RECONSTRUCTION
# ──────────────────────────────────────────────────────────────────────

def build_pnl(df: pd.DataFrame) -> Dict:
    """Reconstruct P&L from class 6 (D movements) and class 7 (C movements)."""

    # Net Turnover (class 70 already nets 709 contra-revenue)
    net_turnover = _sum_prefix(df, "70", "sume_tot_C")

    # Revenue components for display
    sales_701 = _sum_prefix(df, "701", "sume_tot_C")
    sales_707 = _sum_prefix(df, "707", "sume_tot_C")
    sales_704_706 = _sum_prefix(df, ["704", "706"], "sume_tot_C")
    sales_708 = _sum_prefix(df, "708", "sume_tot_C")
    reductions_709 = _sum_prefix(df, "709", "sume_tot_C")

    # Production variation (711) — nets D vs C
    prod_var_net = (_sum_prefix(df, "711", "sume_tot_C")
                    - _sum_prefix(df, "711", "sume_tot_D"))

    # Other operating revenue
    capitalized_72 = _sum_prefix(df, "72", "sume_tot_C")
    other_op_758 = _sum_prefix(df, "758", "sume_tot_C")
    provision_rev_781 = _sum_prefix(df, "781", "sume_tot_C")

    total_op_revenue = (net_turnover + prod_var_net + capitalized_72
                        + other_op_758 + provision_rev_781)

    # Operating expenses
    exp_601 = _sum_prefix(df, "601", "sume_tot_D")
    exp_602 = _sum_prefix(df, "602", "sume_tot_D")
    exp_603 = _sum_prefix(df, "603", "sume_tot_D")
    exp_605 = _sum_prefix(df, "605", "sume_tot_D")
    exp_607 = _sum_prefix(df, "607", "sume_tot_D")
    exp_608 = _sum_prefix(df, "608", "sume_tot_D")
    exp_60_other = (_sum_prefix(df, "60", "sume_tot_D")
                    - (exp_601 + exp_602 + exp_603 + exp_605 + exp_607 + exp_608))
    exp_61 = _sum_prefix(df, "61", "sume_tot_D")
    exp_62 = _sum_prefix(df, "62", "sume_tot_D")
    exp_63 = _sum_prefix(df, "63", "sume_tot_D")
    exp_64 = _sum_prefix(df, "64", "sume_tot_D")
    exp_65 = _sum_prefix(df, "65", "sume_tot_D")
    exp_681 = _sum_prefix(df, "681", "sume_tot_D")
    exp_68_other = _sum_prefix(df, "68", "sume_tot_D") - exp_681

    total_op_expense = (exp_601 + exp_602 + exp_603 + exp_605 + exp_607 + exp_608
                        + exp_60_other + exp_61 + exp_62 + exp_63 + exp_64
                        + exp_65 + exp_681 + exp_68_other)

    ebit = total_op_revenue - total_op_expense
    ebitda = ebit + exp_681 + exp_68_other

    # Financial result
    rev_761 = _sum_prefix(df, "761", "sume_tot_C")
    rev_765 = _sum_prefix(df, "765", "sume_tot_C")
    rev_766 = _sum_prefix(df, "766", "sume_tot_C")
    rev_768 = _sum_prefix(df, "768", "sume_tot_C")
    fin_revenue = rev_761 + rev_765 + rev_766 + rev_768

    exp_665 = _sum_prefix(df, "665", "sume_tot_D")
    exp_666 = _sum_prefix(df, "666", "sume_tot_D")
    exp_667 = _sum_prefix(df, "667", "sume_tot_D")
    exp_668 = _sum_prefix(df, "668", "sume_tot_D")
    fin_expense = exp_665 + exp_666 + exp_667 + exp_668

    pbt = ebit + (fin_revenue - fin_expense)
    income_tax = _sum_prefix(df, "69", "sume_tot_D")
    net_profit_reconstructed = pbt - income_tax

    # Anchor: account 121 closing C balance is statutory net profit
    net_profit_statutory = (_sum_prefix(df, "121", "sold_fin_C")
                            - _sum_prefix(df, "121", "sold_fin_D"))

    reconciliation_gap = net_profit_reconstructed - net_profit_statutory
    reconciliation_pct = (reconciliation_gap / abs(net_profit_statutory) * 100
                          if net_profit_statutory else 0)

    return {
        "sales_701": sales_701, "sales_707": sales_707,
        "sales_704_706": sales_704_706, "sales_708": sales_708,
        "reductions_709": reductions_709,
        "net_turnover": net_turnover,
        "prod_var_net": prod_var_net,
        "capitalized_72": capitalized_72,
        "other_op_758": other_op_758,
        "provision_rev_781": provision_rev_781,
        "total_op_revenue": total_op_revenue,
        "exp_601": exp_601, "exp_602": exp_602, "exp_603": exp_603,
        "exp_605": exp_605, "exp_607": exp_607, "exp_608": exp_608,
        "exp_60_other": exp_60_other,
        "exp_61": exp_61, "exp_62": exp_62, "exp_63": exp_63,
        "exp_64": exp_64, "exp_65": exp_65, "exp_681": exp_681,
        "exp_68_other": exp_68_other,
        "total_op_expense": total_op_expense,
        "ebit": ebit, "ebitda": ebitda,
        "fin_revenue": fin_revenue, "fin_expense": fin_expense,
        "rev_761": rev_761, "rev_765": rev_765, "rev_766": rev_766, "rev_768": rev_768,
        "exp_665": exp_665, "exp_666": exp_666, "exp_667": exp_667, "exp_668": exp_668,
        "pbt": pbt, "income_tax": income_tax,
        "net_profit_reconstructed": net_profit_reconstructed,
        "net_profit_statutory": net_profit_statutory,
        "reconciliation_gap": reconciliation_gap,
        "reconciliation_pct": reconciliation_pct,
    }


# ──────────────────────────────────────────────────────────────────────
# SECTION 3: BALANCE SHEET
# ──────────────────────────────────────────────────────────────────────

def build_balance_sheet(df: pd.DataFrame) -> Dict:
    """Build balance sheet from classes 1-5 closing balances."""

    # NON-CURRENT ASSETS
    intangibles_gross = _sum_prefix(df, ["205", "208"], "sold_fin_D")
    intangibles_amort = _sum_prefix(df, "280", "sold_fin_C")
    intangibles_net = intangibles_gross - intangibles_amort

    ppe_gross = _sum_prefix(df, ["211", "212", "213", "214"], "sold_fin_D")
    ppe_amort = _sum_prefix(df, "281", "sold_fin_C")
    ppe_net = ppe_gross - ppe_amort

    investment_property = _net_balance(df, "215", "D")
    cip = _net_balance(df, "23", "D") - _sum_prefix(df, "29", "sold_fin_C")

    affiliates = _net_balance(df, "261", "D")
    interests = _net_balance(df, "263", "D")
    other_lt_inv = _net_balance(df, ["265", "267"], "D")
    financial_fixed = affiliates + interests + other_lt_inv

    total_noncurrent = (intangibles_net + ppe_net + investment_property
                        + cip + financial_fixed)

    # CURRENT ASSETS
    inventory_gross = _sum_prefix(df, "3", "sold_fin_D")
    inventory_provisions = _sum_prefix(df, "39", "sold_fin_C")
    # Class 3 also has some credit balances for price differentials etc
    inventory_other_credits = (_sum_prefix(df, "3", "sold_fin_C")
                               - inventory_provisions)
    total_inventory = inventory_gross - inventory_provisions - inventory_other_credits

    # Receivables — class 4 GROSS debit balances (don't net against credit side;
    # class 43 and 44 have separate sub-accounts where debit = asset and
    # credit = liability — netting would understate both receivables and payables)
    trade_rec = _sum_prefix(df, "411", "sold_fin_D")  # gross trade receivables
    notes_rec = _sum_prefix(df, "413", "sold_fin_D")
    supplier_adv = _sum_prefix(df, "409", "sold_fin_D")
    state_rec = _sum_prefix(df, "44", "sold_fin_D")     # VAT recoverable, advance tax
    other_debtors = _sum_prefix(df, "46", "sold_fin_D")
    prepaid = _sum_prefix(df, "471", "sold_fin_D")
    personnel_rec = _sum_prefix(df, ["425", "4282"], "sold_fin_D")
    social_rec = _sum_prefix(df, "43", "sold_fin_D")     # social security receivable
    affiliated_rec = _sum_prefix(df, ["451", "452", "455"], "sold_fin_D")
    rec_provisions = _sum_prefix(df, "49", "sold_fin_C")
    total_receivables = (trade_rec + notes_rec + supplier_adv + state_rec
                         + other_debtors + prepaid + personnel_rec + social_rec
                         + affiliated_rec - rec_provisions)

    # Cash
    cash_lei = _net_balance(df, "5121", "D")
    cash_fx = _net_balance(df, "5124", "D")
    cash_other = _net_balance(df, ["5125", "5128"], "D")
    petty_cash = _sum_prefix(df, "531", "sold_fin_D")
    transit = _net_balance(df, "581", "D")
    cash_other_5xx = _net_balance(df, ["541", "542"], "D")
    total_cash = cash_lei + cash_fx + cash_other + petty_cash + transit + cash_other_5xx

    total_current = total_inventory + total_receivables + total_cash
    total_assets = total_noncurrent + total_current

    # EQUITY
    share_capital = _sum_prefix(df, "101", "sold_fin_C")
    share_premium = _sum_prefix(df, "104", "sold_fin_C")
    revaluation = _sum_prefix(df, "105", "sold_fin_C")
    reserves_legal = _sum_prefix(df, "1061", "sold_fin_C")
    reserves_other = _sum_prefix(df, "1068", "sold_fin_C")
    retained = _net_balance(df, "117", "C")
    current_profit = _net_balance(df, "121", "C")
    total_equity = (share_capital + share_premium + revaluation + reserves_legal
                    + reserves_other + retained + current_profit)

    # LIABILITIES
    provisions = _net_balance(df, "15", "C")
    lt_bank = _net_balance(df, "162", "C")
    leasing = _net_balance(df, "167", "C")
    lt_interest = _net_balance(df, "168", "C")
    subsidies = _net_balance(df, "475", "C")
    grants = _net_balance(df, "478", "C")
    total_lt_liab = provisions + lt_bank + leasing + lt_interest + subsidies + grants
    total_lt_debt = lt_bank + leasing + lt_interest

    st_bank = _net_balance(df, "519", "C")
    trade_pay = _sum_prefix(df, "401", "sold_fin_C")
    notes_pay = _sum_prefix(df, "403", "sold_fin_C")
    fa_pay = _sum_prefix(df, ["404", "405"], "sold_fin_C")
    invoices_not_recd = _sum_prefix(df, "408", "sold_fin_C")
    customer_accruals = _sum_prefix(df, "418", "sold_fin_C")
    customer_advances = _sum_prefix(df, "419", "sold_fin_C")
    personnel = _sum_prefix(df, ["421", "423", "427", "428"], "sold_fin_C")
    social_pay = _sum_prefix(df, "43", "sold_fin_C")  # gross social security payable
    tax_pay = _sum_prefix(df, "44", "sold_fin_C")     # gross taxes payable
    dividends_pay = _sum_prefix(df, "457", "sold_fin_C")
    other_creditors = _sum_prefix(df, "462", "sold_fin_C")
    affiliated_pay = _sum_prefix(df, ["451", "452", "455"], "sold_fin_C")
    deferred_rev = _sum_prefix(df, "472", "sold_fin_C")

    total_st_liab = (st_bank + trade_pay + notes_pay + fa_pay + invoices_not_recd
                     + customer_accruals + customer_advances + personnel
                     + social_pay + tax_pay + dividends_pay + other_creditors
                     + affiliated_pay + deferred_rev)

    total_liab = total_lt_liab + total_st_liab
    total_debt = total_lt_debt + st_bank
    net_debt = total_debt - total_cash

    reconciliation_gap = (total_equity + total_liab) - total_assets
    reconciliation_pct = (reconciliation_gap / total_assets * 100
                          if total_assets else 0)

    return {
        # Non-current
        "intangibles_gross": intangibles_gross,
        "intangibles_amort": intangibles_amort,
        "intangibles_net": intangibles_net,
        "ppe_gross": ppe_gross, "ppe_amort": ppe_amort, "ppe_net": ppe_net,
        "investment_property": investment_property,
        "cip": cip,
        "affiliates": affiliates, "interests": interests,
        "other_lt_inv": other_lt_inv, "financial_fixed": financial_fixed,
        "total_noncurrent": total_noncurrent,
        # Current
        "total_inventory": total_inventory,
        "trade_rec": trade_rec, "rec_provisions": rec_provisions,
        "total_receivables": total_receivables,
        "cash_lei": cash_lei, "cash_fx": cash_fx, "total_cash": total_cash,
        "total_current": total_current,
        "total_assets": total_assets,
        # Equity
        "share_capital": share_capital, "share_premium": share_premium,
        "revaluation": revaluation,
        "reserves_legal": reserves_legal, "reserves_other": reserves_other,
        "retained": retained, "current_profit": current_profit,
        "total_equity": total_equity,
        # Liabilities
        "provisions": provisions, "lt_bank": lt_bank, "leasing": leasing,
        "subsidies": subsidies, "total_lt_liab": total_lt_liab,
        "total_lt_debt": total_lt_debt,
        "st_bank": st_bank, "trade_pay": trade_pay,
        "personnel": personnel, "social_pay": social_pay, "tax_pay": tax_pay,
        "dividends_pay": dividends_pay,
        "total_st_liab": total_st_liab, "total_liab": total_liab,
        "total_debt": total_debt, "net_debt": net_debt,
        # Reconciliation
        "reconciliation_gap": reconciliation_gap,
        "reconciliation_pct": reconciliation_pct,
    }


# ──────────────────────────────────────────────────────────────────────
# SECTION 4: CASH FLOW (INDIRECT METHOD)
# ──────────────────────────────────────────────────────────────────────

def build_cash_flow(pnl: Dict, bs: Dict,
                    prior_bs: Optional[Dict] = None) -> Dict:
    """
    Indirect-method cash flow. If prior_bs is None, working capital changes
    are flagged as approximated and marked with ~ symbol in output.
    """
    is_approximated = prior_bs is None

    # Operating
    net_profit = pnl["net_profit_statutory"]
    da = pnl["exp_681"]
    provision_movement = pnl["provision_rev_781"] - pnl["exp_65"] * 0.2  # rough
    cf_before_wc = net_profit + da + provision_movement

    if prior_bs:
        delta_inventory = -(bs["total_inventory"] - prior_bs["total_inventory"])
        delta_receivables = -(bs["total_receivables"] - prior_bs["total_receivables"])
        delta_trade_pay = bs["trade_pay"] - prior_bs["trade_pay"]
        delta_tax_pay = bs["tax_pay"] - prior_bs["tax_pay"]
    else:
        # Approximate at ±15%
        delta_inventory = -bs["total_inventory"] * 0.05
        delta_receivables = -bs["total_receivables"] * 0.05
        delta_trade_pay = bs["trade_pay"] * 0.05
        delta_tax_pay = bs["tax_pay"] * 0.02

    wc_changes = delta_inventory + delta_receivables + delta_trade_pay + delta_tax_pay
    cfo = cf_before_wc + wc_changes

    # Investing
    if prior_bs:
        capex = -((bs["ppe_gross"] - prior_bs["ppe_gross"]))
        cip_change = -(bs["cip"] - prior_bs["cip"])
        affiliate_change = -(bs["affiliates"] - prior_bs["affiliates"])
    else:
        capex = -bs["ppe_gross"] * 0.05  # approximation
        cip_change = -bs["cip"] * 0.5
        affiliate_change = -bs["affiliates"] * 0.02

    dividends_received = pnl["rev_761"]
    interest_received = pnl["rev_766"]
    cfi = capex + cip_change + affiliate_change + dividends_received + interest_received

    # Financing
    if prior_bs:
        delta_lt_debt = bs["total_lt_debt"] - prior_bs["total_lt_debt"]
        delta_st_bank = bs["st_bank"] - prior_bs["st_bank"]
    else:
        delta_lt_debt = -bs["total_lt_debt"] * 0.10  # assume some repayment
        delta_st_bank = bs["st_bank"] * 0.10

    interest_paid = -pnl["exp_666"]
    # Dividends paid = prior current profit moved to 117/distributed via 129
    dividends_paid = -net_profit * 0.5  # rough; depends on policy
    cff = delta_lt_debt + delta_st_bank + interest_paid + dividends_paid

    net_change_cash = cfo + cfi + cff

    return {
        "net_profit": net_profit, "da": da, "provision_movement": provision_movement,
        "cf_before_wc": cf_before_wc,
        "delta_inventory": delta_inventory, "delta_receivables": delta_receivables,
        "delta_trade_pay": delta_trade_pay, "delta_tax_pay": delta_tax_pay,
        "wc_changes": wc_changes, "cfo": cfo,
        "capex": capex, "cip_change": cip_change, "affiliate_change": affiliate_change,
        "dividends_received": dividends_received, "interest_received": interest_received,
        "cfi": cfi,
        "delta_lt_debt": delta_lt_debt, "delta_st_bank": delta_st_bank,
        "interest_paid": interest_paid, "dividends_paid": dividends_paid,
        "cff": cff,
        "net_change_cash": net_change_cash,
        "is_approximated": is_approximated,
    }


# ──────────────────────────────────────────────────────────────────────
# SECTION 5: FINANCIAL RATIOS
# ──────────────────────────────────────────────────────────────────────

def build_ratios(pnl: Dict, bs: Dict, prior_bs: Optional[Dict] = None) -> Dict:
    """Compute 25+ ratios across 5 dimensions."""

    turnover = pnl["net_turnover"]
    ebitda = pnl["ebitda"]
    ebit = pnl["ebit"]
    net_profit = pnl["net_profit_statutory"]
    total_assets = bs["total_assets"]
    total_equity = bs["total_equity"]
    total_debt = bs["total_debt"]
    net_debt = bs["net_debt"]
    interest_exp = pnl["exp_666"]

    avg_assets = (total_assets + prior_bs["total_assets"]) / 2 if prior_bs else total_assets
    avg_equity = (total_equity + prior_bs["total_equity"]) / 2 if prior_bs else total_equity
    avg_inventory = ((bs["total_inventory"] + prior_bs["total_inventory"]) / 2
                     if prior_bs else bs["total_inventory"])

    # Two different COGS proxies — purposes differ:
    # `gross_margin_proxy_cogs` (narrow: 601+602+607) — for the GROSS MARGIN ratio,
    #   answers "what % of revenue is left after direct materials/merchandise costs?"
    # `total_cogs_for_turnover` (broad: full operating expense) — for INVENTORY TURNOVER,
    #   DIO and DPO ratios; in a manufacturer, inventory absorbs all production costs
    #   (materials + labor + utilities + overhead via 711 movements), not just raw materials.
    #   Industry convention for DIO uses total operating expense as the denominator.
    gross_margin_proxy_cogs = pnl["exp_601"] + pnl["exp_602"] + pnl["exp_607"]
    total_cogs_for_turnover = pnl["total_op_expense"]

    def _safe_div(a, b):
        return a / b if b not in (0, None) else 0

    return {
        # Profitability
        "ebitda_margin": _safe_div(ebitda, turnover),
        "ebit_margin": _safe_div(ebit, turnover),
        "net_margin": _safe_div(net_profit, turnover),
        "gross_margin_proxy": _safe_div(turnover - gross_margin_proxy_cogs, turnover),
        "roe": _safe_div(net_profit, avg_equity),
        "roa": _safe_div(net_profit, avg_assets),
        "roic": _safe_div(ebit * 0.84, total_equity + total_debt),
        # Liquidity
        "current_ratio": _safe_div(bs["total_current"], bs["total_st_liab"]),
        "quick_ratio": _safe_div(bs["total_current"] - bs["total_inventory"],
                                 bs["total_st_liab"]),
        "cash_ratio": _safe_div(bs["total_cash"], bs["total_st_liab"]),
        "working_capital": bs["total_current"] - bs["total_st_liab"],
        # Leverage
        "equity_ratio": _safe_div(total_equity, total_assets),
        "debt_to_equity": _safe_div(total_debt, total_equity),
        "lt_debt_to_equity": _safe_div(bs["total_lt_debt"], total_equity),
        "net_debt_ebitda": _safe_div(net_debt, ebitda) if ebitda else 0,
        "debt_to_assets": _safe_div(total_debt, total_assets),
        # Coverage
        "interest_coverage": _safe_div(ebit, interest_exp) if interest_exp else 999,
        "ebitda_to_interest": _safe_div(ebitda, interest_exp) if interest_exp else 999,
        "dscr": _safe_div(ebitda, interest_exp + bs["total_lt_debt"] / 8) if interest_exp else 999,
        # Efficiency (using TOTAL operating expense as COGS proxy — correct for manufacturers)
        "asset_turnover": _safe_div(turnover, avg_assets),
        "inventory_turnover": _safe_div(total_cogs_for_turnover, avg_inventory),
        "dio": _safe_div(avg_inventory, total_cogs_for_turnover) * 365 if total_cogs_for_turnover else 0,
        "dso": _safe_div(bs["total_receivables"], turnover) * 365 if turnover else 0,
        "dpo": _safe_div(bs["trade_pay"], total_cogs_for_turnover) * 365 if total_cogs_for_turnover else 0,
        # Cash conversion cycle
        "ccc": (_safe_div(avg_inventory, total_cogs_for_turnover) * 365
                + _safe_div(bs["total_receivables"], turnover) * 365
                - _safe_div(bs["trade_pay"], total_cogs_for_turnover) * 365),
    }


# ──────────────────────────────────────────────────────────────────────
# SECTION 6: VALUATION
# ──────────────────────────────────────────────────────────────────────

def build_valuation(pnl: Dict, bs: Dict, ratios: Dict, industry: str = "default") -> Dict:
    """Multi-method valuation envelope."""
    ebitda = pnl["ebitda"]
    net_profit = pnl["net_profit_statutory"]
    net_debt = bs["net_debt"]
    total_equity = bs["total_equity"]
    bench = INDUSTRY_BENCHMARKS.get(industry, INDUSTRY_BENCHMARKS["default"])

    ev_low, ev_high = bench["ev_ebitda_range"]
    ev_mid = (ev_low + ev_high) / 2
    wacc = bench["default_wacc"]
    g_terminal = 0.03

    # EV/EBITDA at three points
    valuations_ev = []
    for mult, label in [(ev_low, "Conservative"), (ev_mid, "Mid"), (ev_high, "Premium")]:
        ev = ebitda * mult
        equity = ev - net_debt
        valuations_ev.append({"label": label, "multiple": mult, "ev": ev, "equity": equity})

    # DCF with Gordon terminal — 5-year explicit
    fcf_base = net_profit  # assumes maint capex ≈ D&A
    g_explicit = 0.05  # default growth
    dcf_explicit = sum(fcf_base * ((1 + g_explicit) ** t) / ((1 + wacc) ** t)
                       for t in range(1, 6))
    fcf_year5 = fcf_base * ((1 + g_explicit) ** 5)
    terminal_value = fcf_year5 * (1 + g_terminal) / (wacc - g_terminal)
    dcf_terminal_pv = terminal_value / ((1 + wacc) ** 5)
    dcf_ev = dcf_explicit + dcf_terminal_pv
    dcf_equity = dcf_ev - net_debt

    # NAV simple version (full cascade is in nav_calculator.py)
    # Adjusted NAV: book + 20% uplift on PP&E + 25% uplift on affiliates, less DT
    ppe_uplift = bs["ppe_net"] * 0.20
    affiliate_uplift = bs["affiliates"] * 0.25
    deferred_tax = (ppe_uplift + affiliate_uplift) * 0.16
    nnnav = total_equity + ppe_uplift + affiliate_uplift - deferred_tax

    return {
        "industry": industry,
        "ev_multiples": valuations_ev,
        "wacc": wacc, "g_terminal": g_terminal, "g_explicit": g_explicit,
        "fcf_base": fcf_base,
        "dcf_explicit_pv": dcf_explicit, "terminal_value": terminal_value,
        "dcf_terminal_pv": dcf_terminal_pv, "dcf_ev": dcf_ev, "dcf_equity": dcf_equity,
        "nnnav": nnnav, "book_equity": total_equity,
        "ppe_uplift": ppe_uplift, "affiliate_uplift": affiliate_uplift,
        "deferred_tax": deferred_tax,
    }


# ──────────────────────────────────────────────────────────────────────
# SECTION 7: RISK & CREDIT
# ──────────────────────────────────────────────────────────────────────

def build_credit_score(pnl: Dict, bs: Dict, ratios: Dict) -> Dict:
    """Altman Z" + composite credit score."""

    total_assets = bs["total_assets"]
    if not total_assets:
        return {"altman_z_double_prime": 0, "composite": 0, "grade": "N/A"}

    # Altman Z" — emerging markets variant
    X1 = (bs["total_current"] - bs["total_st_liab"]) / total_assets
    X2 = bs["retained"] / total_assets
    X3 = pnl["ebit"] / total_assets
    X4 = bs["total_equity"] / max(bs["total_liab"], 1)
    z_double_prime = 6.56 * X1 + 3.26 * X2 + 6.72 * X3 + 1.05 * X4

    # Map Z" to 0-100 score
    if z_double_prime >= 2.60:
        altman_score = min(100, 70 + (z_double_prime - 2.60) * 15)
    elif z_double_prime >= 1.10:
        altman_score = 40 + (z_double_prime - 1.10) * 20
    else:
        altman_score = max(0, z_double_prime * 36)

    # Profitability score
    roe = ratios["roe"]
    net_margin = ratios["net_margin"]
    prof_score = min(100, max(0, (roe * 100 * 0.5 + net_margin * 100 * 5) / 1.5))

    # Leverage score (lower = better)
    nde = ratios["net_debt_ebitda"]
    if nde <= 0:
        lev_score = 100
    elif nde <= 1.5:
        lev_score = 90
    elif nde <= 3.0:
        lev_score = 70
    elif nde <= 5.0:
        lev_score = 50
    else:
        lev_score = max(0, 50 - (nde - 5) * 10)

    # Interest coverage score
    ic = ratios["interest_coverage"]
    if ic >= 8:
        ic_score = 95
    elif ic >= 4:
        ic_score = 80
    elif ic >= 2:
        ic_score = 60
    elif ic >= 1:
        ic_score = 40
    else:
        ic_score = max(0, ic * 30)

    # DSCR score
    dscr = ratios["dscr"]
    if dscr >= 2:
        dscr_score = 90
    elif dscr >= 1.25:
        dscr_score = 70
    else:
        dscr_score = max(0, dscr * 50)

    # Liquidity score
    liq_score = (min(100, ratios["current_ratio"] * 50)
                 + min(100, ratios["quick_ratio"] * 80)
                 + min(100, ratios["cash_ratio"] * 250)) / 3

    # Equity ratio score
    eq_score = min(100, ratios["equity_ratio"] * 200)

    composite = (0.30 * altman_score + 0.20 * prof_score + 0.15 * lev_score
                 + 0.10 * ic_score + 0.10 * dscr_score
                 + 0.10 * liq_score + 0.05 * eq_score)

    # Letter grade
    if composite >= 90: grade = "AAA / AA"
    elif composite >= 80: grade = "A"
    elif composite >= 70: grade = "BBB"
    elif composite >= 60: grade = "BB"
    elif composite >= 50: grade = "B"
    elif composite >= 40: grade = "CCC"
    else: grade = "CC / C / D"

    return {
        "altman_z_double_prime": z_double_prime,
        "altman_components": {"X1": X1, "X2": X2, "X3": X3, "X4": X4},
        "altman_score": altman_score, "prof_score": prof_score,
        "lev_score": lev_score, "ic_score": ic_score, "dscr_score": dscr_score,
        "liq_score": liq_score, "eq_score": eq_score,
        "composite": composite, "grade": grade,
    }


def build_risk_inventory(pnl: Dict, bs: Dict, ratios: Dict) -> List[Dict]:
    """Identify 5-8 specific risks based on findings."""
    risks = []

    # Receivables provision quality
    if bs["trade_rec"] > 0:
        prov_pct = bs["rec_provisions"] / bs["trade_rec"]
        if prov_pct > 0.15:
            risks.append({
                "severity": "high",
                "title": "Receivables provision elevated",
                "detail": f"Provisions are {prov_pct*100:.0f}% of trade receivables — historical credit issues",
            })

    # Cash ratio
    if ratios["cash_ratio"] < 0.10:
        risks.append({
            "severity": "high",
            "title": "Tight cash liquidity",
            "detail": f"Cash ratio {ratios['cash_ratio']:.2f}× — heavy dependence on revolvers",
        })

    # Raw materials concentration
    materials_pct = (pnl["exp_601"] + pnl["exp_602"]) / pnl["net_turnover"]
    if materials_pct > 0.30:
        risks.append({
            "severity": "medium",
            "title": "Raw material price exposure",
            "detail": f"Materials are {materials_pct*100:.0f}% of turnover — unhedged commodity risk",
        })

    # Affiliate dependency
    if pnl["net_profit_statutory"] > 0:
        affiliate_dep = pnl["rev_761"] / pnl["net_profit_statutory"]
        if affiliate_dep > 0.15:
            risks.append({
                "severity": "medium",
                "title": "Affiliate income dependency",
                "detail": f"Affiliate dividends are {affiliate_dep*100:.0f}% of net profit",
            })

    # Asset maturity
    if bs["ppe_gross"] > 0:
        dep_pct = bs["ppe_amort"] / bs["ppe_gross"]
        if dep_pct > 0.55:
            risks.append({
                "severity": "medium",
                "title": "Mature asset base",
                "detail": f"Accumulated depreciation = {dep_pct*100:.0f}% of gross PP&E — capex pressure ahead",
            })

    # Leverage
    if ratios["net_debt_ebitda"] > 4:
        risks.append({
            "severity": "high",
            "title": "Elevated leverage",
            "detail": f"Net Debt/EBITDA = {ratios['net_debt_ebitda']:.1f}× — covenant pressure likely",
        })

    return risks


# ──────────────────────────────────────────────────────────────────────
# SECTION 8: RECOMMENDATIONS
# ──────────────────────────────────────────────────────────────────────

def build_recommendations(pnl: Dict, bs: Dict, ratios: Dict,
                          credit: Dict, risks: List[Dict]) -> List[Dict]:
    """Generate prioritized recommendations from findings."""
    recs = []

    if ratios["cash_ratio"] < 0.10:
        target = bs["total_st_liab"] * 0.05
        gap = target - bs["total_cash"]
        recs.append({
            "severity": "high",
            "title": "Build minimum liquidity buffer to 5% of ST liabilities",
            "why": f"Cash ratio of {ratios['cash_ratio']:.2f}× is the weakest financial metric; vulnerable to a 15-day disruption.",
            "action": f"Target {target/1e6:.1f}M RON minimum cash. Fund by reducing dividend distribution or converting ST revolver to committed term facility.",
            "impact": f"Cash ratio doubles, liquidity risk eliminated. Cost: ~{gap/1e6:.1f}M RON one-time.",
        })

    if bs["trade_rec"] > 0 and bs["rec_provisions"] / bs["trade_rec"] > 0.15:
        prov_pct = bs["rec_provisions"] / bs["trade_rec"]
        recs.append({
            "severity": "high",
            "title": "Investigate receivables provisions",
            "why": f"Provisions at {prov_pct*100:.0f}% of gross trade receivables is unusual.",
            "action": "Pull aging schedule by counterparty. Write off uncollectible affiliated balances; establish credit terms with key customers.",
            "impact": "Cleaner balance sheet; potentially 2-4M additional hit if reserves need increase.",
        })

    materials_pct = (pnl["exp_601"] + pnl["exp_602"]) / pnl["net_turnover"]
    if materials_pct > 0.30:
        recs.append({
            "severity": "medium",
            "title": "Hedge raw material exposure forward 6-12 months",
            "why": f"Materials at {materials_pct*100:.0f}% of turnover; 10% price spike = ~{(pnl['exp_601']+pnl['exp_602'])*0.10/1e6:.0f}M margin compression.",
            "action": "Forward purchasing contracts on 50-70% of next 6-month volume. Fixed-price energy contracts where viable.",
            "impact": "Margin stability; reduces earnings volatility, improves predictability for credit.",
        })

    if bs["ppe_gross"] > 0 and bs["ppe_amort"] / bs["ppe_gross"] > 0.55:
        recs.append({
            "severity": "medium",
            "title": "5-year capex plan for equipment modernization",
            "why": f"Accumulated depreciation {bs['ppe_amort']/bs['ppe_gross']*100:.0f}% of gross PP&E; equipment approaching end of life.",
            "action": f"Target {(pnl['exp_681']*1.5)/1e6:.0f}-{(pnl['exp_681']*2)/1e6:.0f}M RON/year capex for next 3 years. Use EU grants where eligible.",
            "impact": f"Debt capacity exists — could lever to 2.5× Net Debt/EBITDA for ~{(pnl['ebitda']*2.5 - bs['net_debt'])/1e6:.0f}M additional capacity.",
        })

    if ratios["net_debt_ebitda"] < 1.5 and pnl["ebit"] > 0:
        recs.append({
            "severity": "medium",
            "title": "Capacity to lever for growth or shareholder returns",
            "why": f"Net Debt/EBITDA of {ratios['net_debt_ebitda']:.1f}× is exceptionally low for industry.",
            "action": "Consider strategic acquisitions or accelerated dividend program. Maintain ≤2.5× as guardrail.",
            "impact": f"Could deploy {(pnl['ebitda']*2.5 - bs['net_debt'])/1e6:.0f}M additional capital while staying investment-grade.",
        })

    if pnl["net_profit_statutory"] > 0 and pnl["rev_761"] / pnl["net_profit_statutory"] > 0.15:
        affiliate_dep = pnl["rev_761"] / pnl["net_profit_statutory"]
        recs.append({
            "severity": "medium",
            "title": "Affiliate portfolio review",
            "why": f"Affiliate dividends {affiliate_dep*100:.0f}% of net profit; concentration risk.",
            "action": "Entity-by-entity review. Liquidate dormants. Establish minimum yield threshold (e.g., 8%); divest underperformers within 24 months.",
            "impact": "Cleaner group structure; potential 2-5M one-time gain from divestments.",
        })

    return recs


# ──────────────────────────────────────────────────────────────────────
# MAIN ENTRY POINT
# ──────────────────────────────────────────────────────────────────────

def analyze_company(trial_balance_path: str,
                    company_name: str,
                    period: str,
                    industry: str = "default",
                    prior_period_path: Optional[str] = None,
                    output_html_path: Optional[str] = None) -> Dict:
    """
    End-to-end analysis. Returns a dict with all 8 sections' computed values.
    If output_html_path is set, also writes the HTML report.
    """
    df = load_trial_balance(trial_balance_path)
    validation = validate_trial_balance(df)

    pnl = build_pnl(df)
    bs = build_balance_sheet(df)

    prior_bs = None
    if prior_period_path:
        prior_df = load_trial_balance(prior_period_path)
        prior_bs = build_balance_sheet(prior_df)

    cf = build_cash_flow(pnl, bs, prior_bs)
    ratios = build_ratios(pnl, bs, prior_bs)
    valuation = build_valuation(pnl, bs, ratios, industry)
    credit = build_credit_score(pnl, bs, ratios)
    risks = build_risk_inventory(pnl, bs, ratios)
    recommendations = build_recommendations(pnl, bs, ratios, credit, risks)

    result = {
        "company_name": company_name,
        "period": period,
        "industry": industry,
        "validation": validation,
        "pnl": pnl,
        "balance_sheet": bs,
        "cash_flow": cf,
        "ratios": ratios,
        "valuation": valuation,
        "credit": credit,
        "risks": risks,
        "recommendations": recommendations,
    }

    if output_html_path:
        html = render_html_report(result)
        with open(output_html_path, "w", encoding="utf-8") as f:
            f.write(html)

    return result


# ──────────────────────────────────────────────────────────────────────
# HTML RENDERING (templates the report)
# ──────────────────────────────────────────────────────────────────────

def render_html_report(result: Dict) -> str:
    """
    Produce the full 8-section HTML report.
    Uses the v5 site styling (navy header, amber highlights, green positive).

    For brevity, this is a template skeleton — fill the {placeholders} with
    values from result. Use the Scandia FY2025 HTML as the canonical reference.
    """
    name = result["company_name"]
    period = result["period"]
    pnl = result["pnl"]
    bs = result["balance_sheet"]
    ratios = result["ratios"]
    credit = result["credit"]

    # Minimal skeleton — extend each section using the patterns from the
    # Scandia / EEI worked examples.
    html = f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>{name} — Comprehensive Analysis {period}</title>
<style>
  body {{ font-family: Helvetica, Arial, sans-serif; max-width: 1180px;
         margin: 0 auto; padding: 30px; color: #1a1a1a; background: #fafbfc; }}
  h1, h2 {{ color: #003366; }}
  h2 {{ border-bottom: 2px solid #d6dde6; padding-bottom: 8px; margin-top: 36px; }}
  table {{ width: 100%; border-collapse: collapse; background: white; font-size: 13px; }}
  th {{ background: #003366; color: white; padding: 8px; text-align: left; }}
  td {{ padding: 8px; border-bottom: 1px solid #e0e6ed; }}
  td.num {{ text-align: right; font-variant-numeric: tabular-nums; }}
  .header-card {{ background: linear-gradient(135deg, #003366, #1a5490);
                  color: white; padding: 22px 28px; border-radius: 4px; }}
  .kpi-grid {{ display: grid; grid-template-columns: repeat(4, 1fr);
               gap: 12px; margin: 16px 0; }}
  .kpi {{ background: white; border: 1px solid #d6dde6; padding: 14px;
          border-left: 4px solid #0a7c3a; border-radius: 4px; }}
  .kpi .label {{ font-size: 11px; color: #666; text-transform: uppercase; }}
  .kpi .value {{ font-size: 22px; font-weight: 700; color: #003366; }}
</style></head><body>

<div class="header-card">
  <h1 style="color:white; border:none; padding:0;">
    {name} — Comprehensive Financial Analysis
  </h1>
  <div>{period} · Source: trial balance (RAS)</div>
</div>

<h2>1. Overview</h2>
<div class="kpi-grid">
  <div class="kpi"><div class="label">Net Turnover</div>
    <div class="value">{pnl['net_turnover']/1e6:.1f}M</div></div>
  <div class="kpi"><div class="label">EBITDA</div>
    <div class="value">{pnl['ebitda']/1e6:.1f}M</div></div>
  <div class="kpi"><div class="label">Net Profit</div>
    <div class="value">{pnl['net_profit_statutory']/1e6:.1f}M</div></div>
  <div class="kpi"><div class="label">Total Assets</div>
    <div class="value">{bs['total_assets']/1e6:.1f}M</div></div>
  <div class="kpi"><div class="label">Equity Ratio</div>
    <div class="value">{ratios['equity_ratio']*100:.1f}%</div></div>
  <div class="kpi"><div class="label">Net Debt/EBITDA</div>
    <div class="value">{ratios['net_debt_ebitda']:.2f}×</div></div>
  <div class="kpi"><div class="label">ROE</div>
    <div class="value">{ratios['roe']*100:.1f}%</div></div>
  <div class="kpi"><div class="label">Altman Z″</div>
    <div class="value">{credit['altman_z_double_prime']:.2f}</div></div>
</div>

<h2>2. P&L</h2>
<table><tr><th>Line</th><th>RON</th><th>% of turnover</th></tr>
<tr><td>Net turnover</td><td class="num">{pnl['net_turnover']:,.0f}</td><td class="num">100.0%</td></tr>
<tr><td>Raw materials (601)</td><td class="num">{pnl['exp_601']:,.0f}</td><td class="num">{pnl['exp_601']/pnl['net_turnover']*100:.1f}%</td></tr>
<tr><td>Auxiliary mat (602)</td><td class="num">{pnl['exp_602']:,.0f}</td><td class="num">{pnl['exp_602']/pnl['net_turnover']*100:.1f}%</td></tr>
<tr><td>Utilities (605)</td><td class="num">{pnl['exp_605']:,.0f}</td><td class="num">{pnl['exp_605']/pnl['net_turnover']*100:.1f}%</td></tr>
<tr><td>Personnel (64)</td><td class="num">{pnl['exp_64']:,.0f}</td><td class="num">{pnl['exp_64']/pnl['net_turnover']*100:.1f}%</td></tr>
<tr><td>D&A (681)</td><td class="num">{pnl['exp_681']:,.0f}</td><td class="num">{pnl['exp_681']/pnl['net_turnover']*100:.1f}%</td></tr>
<tr><td><b>EBITDA</b></td><td class="num"><b>{pnl['ebitda']:,.0f}</b></td><td class="num"><b>{pnl['ebitda']/pnl['net_turnover']*100:.1f}%</b></td></tr>
<tr><td><b>EBIT</b></td><td class="num"><b>{pnl['ebit']:,.0f}</b></td><td class="num"><b>{pnl['ebit']/pnl['net_turnover']*100:.1f}%</b></td></tr>
<tr><td><b>NET PROFIT</b></td><td class="num"><b>{pnl['net_profit_statutory']:,.0f}</b></td><td class="num"><b>{pnl['net_profit_statutory']/pnl['net_turnover']*100:.1f}%</b></td></tr>
</table>

<h2>3. Balance Sheet</h2>
<table><tr><th>Item</th><th>RON</th></tr>
<tr><td>Total non-current assets</td><td class="num">{bs['total_noncurrent']:,.0f}</td></tr>
<tr><td>Total current assets</td><td class="num">{bs['total_current']:,.0f}</td></tr>
<tr><td><b>Total assets</b></td><td class="num"><b>{bs['total_assets']:,.0f}</b></td></tr>
<tr><td>Total equity</td><td class="num">{bs['total_equity']:,.0f}</td></tr>
<tr><td>Total liabilities</td><td class="num">{bs['total_liab']:,.0f}</td></tr>
</table>

<h2>7. Credit rating</h2>
<p style="font-size:32px; font-weight:700;">{credit['composite']:.0f} / 100 → {credit['grade']}</p>
<p>Altman Z″ = {credit['altman_z_double_prime']:.2f}</p>

<p style="text-align:center; color:#888; margin-top:40px; font-size:11px;">
NOTE: This is a skeleton render. Extend each section with the full level of detail
shown in the Scandia FY2025 worked example.
</p>
</body></html>"""
    return html


# ──────────────────────────────────────────────────────────────────────
# EXAMPLE — Scandia Food calibration
# ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys

    # Default run: Scandia Food FY2025 if file is in cwd or supplied via argv
    if len(sys.argv) > 1:
        path = sys.argv[1]
        company = sys.argv[2] if len(sys.argv) > 2 else "Test Company"
    else:
        path = "scandia_trial_balance_2025.xlsx"
        company = "Scandia Food SRL"

    result = analyze_company(
        trial_balance_path=path,
        company_name=company,
        period="FY2025",
        industry="food_mfg",
        output_html_path=f"{company.replace(' ','_')}_analysis.html",
    )

    # Print headline summary
    print(f"\n{'='*70}")
    print(f"ANALYSIS RESULT — {result['company_name']} {result['period']}")
    print(f"{'='*70}")
    print(f"Validation: {result['validation']['status']}")
    if result['validation']['issues']:
        for i in result['validation']['issues']:
            print(f"  ! {i}")
    print(f"\nKey metrics:")
    print(f"  Net turnover:    {result['pnl']['net_turnover']:>16,.0f} RON")
    print(f"  EBITDA:          {result['pnl']['ebitda']:>16,.0f} RON  "
          f"({result['ratios']['ebitda_margin']*100:.1f}%)")
    print(f"  Net profit:      {result['pnl']['net_profit_statutory']:>16,.0f} RON  "
          f"({result['ratios']['net_margin']*100:.1f}%)")
    print(f"  Total assets:    {result['balance_sheet']['total_assets']:>16,.0f} RON")
    print(f"  Equity:          {result['balance_sheet']['total_equity']:>16,.0f} RON  "
          f"({result['ratios']['equity_ratio']*100:.1f}%)")
    print(f"  Net Debt/EBITDA: {result['ratios']['net_debt_ebitda']:>16.2f}x")
    print(f"  Altman Z″:       {result['credit']['altman_z_double_prime']:>16.2f}")
    print(f"  Composite credit:{result['credit']['composite']:>16.0f} / 100 → "
          f"{result['credit']['grade']}")
    print(f"\nRisks identified: {len(result['risks'])}")
    for r in result['risks']:
        print(f"  [{r['severity'].upper():<6}] {r['title']}")
    print(f"\nRecommendations: {len(result['recommendations'])}")
    for r in result['recommendations']:
        print(f"  [{r['severity'].upper():<6}] {r['title']}")
```

---

*End of CLAUDE.md. Read once per session. Internalize. Then proceed.*
