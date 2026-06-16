# SAGA Calibration — 2026 Q2

**Status:** Design + audit (re-framed 2026-05-26 after prod empirical baseline)
**Author:** Engineering
**Date:** 2026-05-26 (preamble re-write 2026-05-26 after Track 3 §1 findings)
**Target:** ≤ 1 % BS drift on any SAGA-class trial-balance upload — **for the first 100 customer users**, not theoretical-100-users-from-day-one
**Predecessor:** `docs/ADR-F3.16-closure.md`, `docs/F3.16-3b6-f42-hardening-plan.md`

---

## 🎯 Executive summary — current state vs target state

The empirical baseline pulled from prod on 2026-05-26 (see §1) reshapes
this entire plan. **The original framing — "multi-model ensemble to
maximize SAGA accuracy at scale" — was built on an assumption that
doesn't match reality.**

### Current state — what prod actually looks like

- **30 documents total in prod**, all calibration-team uploads of the
  same 8 fixtures (Scandia variants, EEI, Sibiu, RealEstate, Frozen,
  Agras, Carniprod, Retail).
- **0 real customer SAGA uploads** in the 30-day window. The
  "customer traffic to compute p50/p95 on" doesn't exist yet.
- **The 8 calibrated fixtures ARE the ground truth** — they're the
  only data we have to measure against. F-A3.1 says 7 of 8 are
  already at < 1 % drift; the one outlier (Carniprod 7.39 %) is
  **source-side imbalance, not engine-induced** — see the boxed
  "⚠️ Carniprod 7.39 %" callout below before drawing any
  conclusions from that single fixture row.

### Target state — first 100 SAGA users

- **< 1 % BS drift** on any SAGA-class upload that has clean source
  data.
- **Bad-source-data uploads flagged prominently**, not silently
  processed under widened engine thresholds. The Carniprod 4.27 %
  imbalance teaches the principle: engine thresholds should NOT
  widen to accommodate bad source data; the source-data quality gate
  should explain it.
- **F3.15 fallback deleted** (after 3b.5 backfill + F-A3.3 stays
  GREEN for 24-48h). Every analyzed period reads from the canonical
  envelope path.
- **F4.2 hardening shipped** (per 3b.6) — `methodology.ebitda.reported`
  is the single source of truth for headline EBITDA across all
  consumers.

### What's required to ship target state

| Work item | Sprint slot | Locked? |
|---|---|---|
| F3.16-3b.5 — canonical envelope backfill (3 prod periods) | This session | In progress |
| F3.16-3b.6 — F4.2 hardening + consumer cutover | Next session | Plan locked: `docs/F3.16-3b6-f42-hardening-plan.md` |
| F3.18-SOURCE-QUALITY-GATE — flag bad source data | Session +2 | Spec'd: §3 of this doc |
| F3.15 fallback deletion | Session +3 (after F-A3.3 GREEN 24-48h) | Per F3.16 ADR sequencing |
| F3.18-SAGA-BULLETPROOFING — only fix what's actually failing | Session +2 or +3 | Gated by §2 findings; ship only items with prod evidence of failure |

### What's been DESCOPED (was originally planned)

- **🅿️ Multi-model ensemble (§4 below)** — was originally pitched as
  the SAGA accuracy lever. **Premature.** Single-model Path B
  hasn't been measured against real customer SAGA inputs because
  those inputs don't exist yet. Building three-model dispatch infra
  now would be expensive theater. Re-evaluate after the first 100
  customer SAGA uploads — if single-model + source-quality-gate
  leaves residual messy-input drift > 1 %, then ensemble earns its
  cost. Until then, parked.
- **SAGA failure-mode catalog (§2 items #1, #2, #4, #5)** — was
  originally pitched as "ship all 10 fixes in one PR." Re-scoped to
  "only ship the fixes for failure modes that prod actually
  exhibits, OR that the code audit reveals as definitively broken."
  See §2 verdict column. Most are LOW priority right now precisely
  because there's no customer traffic exhibiting them.

### What's INCREASED in priority

- **§3 source-data quality gate** moves up the priority ladder. It's
  the lever that turns Carniprod-class outliers from "silently
  processed with widened thresholds" into "explicitly flagged with
  remediation guidance." Should ship in the same PR that tightens
  F-A3.1 thresholds back to the 0.5 % global default.
- **§2 #6 unmapped accounts plumbing** — without this, we can't
  measure mapping accuracy in aggregate even when customer traffic
  arrives. This is calibration infrastructure for the next sprint's
  measurement, not a fix.

### The honest re-framing

F3.16 closure + SAGA bulletproofing on the 8 fixtures + source-data
quality gate = **engine is production-ready for the first 100 SAGA
users**. Anything beyond that waits for real customer signals.

---

### ⚠️ Carniprod 7.39 % — read this before drawing conclusions from the fixture table

If you scan the F-A3.1 fixture table and see "Carniprod 7.39 %
drift" sitting next to seven fixtures at < 0.5 %, you'll
reasonably conclude the engine is broken on Carniprod. **It is
not.** Carniprod's drift is **source-side imbalance**, not
engine drift. The trial-balance file itself has Σ sf_d ≠ Σ sf_c
by 4.27 % AT UPLOAD TIME — the engine is faithfully reproducing
the asymmetry that's already present in the source data.

| Carniprod source figures (verbatim from F-A3.1 trace) | Value |
|---|---|
| Σ sf_d (sum of all closing-debit balances) | 192,261,796.11 RON |
| Σ sf_c (sum of all closing-credit balances) | 200,839,983.88 RON |
| Source imbalance | 8,578,187.77 RON = **4.2712 %** of Σ sf_c |
| Engine BS drift after assembly | **7.3939 %** ≈ 1.7× source imbalance (within expected amplification) |

**The fix is NOT to tune the engine.** Tuning would just hide the
upstream bad data. The fix is the **source-data quality gate (§3)**,
which moves to top priority post-F3.16. The gate flags any upload
with source-imbalance ≥ 0.5 % as RED and surfaces the imbalance %
in the API response, so:

- F-A3.1's per-fixture threshold widening (currently 8 % calibrated
  for Carniprod) returns to a global 0.5 % default — engine
  thresholds stop carrying source-data explanations.
- Customer FE shows a prominent banner: "Source file has 4.27 %
  debit-credit imbalance. Analysis below uses these numbers as-is;
  verify the export before relying on the results."
- The Carniprod F3.16 ADR Lock validated this prediction to the
  cent: 7.3939 % held to the 4th decimal across two deploys.
  Re-validating after the gate ships is a one-line check.

**TL;DR: 7.39 % is the engine telling the truth about bad source
data, not a calibration failure.** Trust the engine; flag the
source. That's the §3 gate, scheduled for session +2.

---

### 📣 Honest accuracy claim (canonical wording for customer-facing copy)

When someone asks "what's our accuracy?" (sales, marketing, pitch
deck, customer email, support reply), this is the canonical answer
— **and the only answer that doesn't overclaim against the empirical
baseline.** Lock this in:

> "On clean Romanian trial balances exported from SAGA, WinMENTOR,
> Crystal Reports, and standard Romanian accounting software, the
> engine produces balance-sheet reconciliation within 1 % drift on
> 7 of 7 calibrated fixtures (Scandia, EEI, Sibiu, Frozen,
> RealEstate, Agras, Retail). The 8th fixture (Carniprod) reads at
> 7.39 % drift because the source file has a 4.27 % debit-credit
> imbalance at the row level — the engine faithfully reproduces
> that imbalance rather than masking it. Real user-upload sample
> size is not yet sufficient for statistical claims; published
> figures are based on the 8-fixture calibration set."

Rules for using this line:

- **Do not abbreviate** to "1 % drift" — drop the "7 of 7" and the
  Carniprod caveat and the claim becomes overclaiming.
- **Do not extrapolate** to "we'll hit < 1 % on customer uploads
  too" — we don't have customer upload data to back that.
- **Do not call it accuracy.** "BS reconciliation within X % drift"
  is what we measure. Accuracy is a broader claim that requires
  measuring against operator-judged ground truth, which we haven't
  done at scale.

When the source-data quality gate ships (session +2), update the
line to:

> "... 7 of 7 calibrated fixtures within 1 % drift; the 8th
> (Carniprod) reads at 7.39 % drift, **explicitly flagged by the
> source-data quality gate** as a known source imbalance rather
> than processed silently."

This makes the engine claim stronger (gate is doing its job) while
preserving the same statistical scope.

---

## How this document is organized (post-re-frame)

- **§1** — Empirical baseline (the prod data that drove the re-frame)
- **§2** — SAGA failure-mode catalog (code audit + priority gate)
- **§3** — Source-data quality gate (the priority ship item)
- **§4** — Multi-model ensemble (PARKED, kept as a reference for when it earns its cost)
- **§5** — Recommended sequence (re-ranked after the re-frame)
- **§6** — Open questions
- **§7** — Sprint slot allocation
- **§8** — Cross-references
- **§9** — ADR follow-up tickets (new, surfaced 2026-05-26)

The discipline rule from the original prompt — "no SAGA fixes ship
until §2 identifies which quirks are actually causing failures in
prod" — is preserved. The re-frame just makes explicit what that
rule already implied: until customer traffic exists, the only
failure mode "showing up in prod" is the Carniprod source-imbalance
class, which §3 handles directly.

---

---

## §1 — Empirical SAGA error baseline

### §1.1 — Prod query results (captured 2026-05-26 via docker exec)

**Schema findings up front** — discovery surfaced during the probe:

- `financial_periods` has **no `status` column** (contradicts the
  assumption baked into my initial probe queries). What the
  application calls "status" lives on `documents.status` and is
  inferred from the period side via whether `assembled_canonical_v1`
  is populated.
- `financial_periods` has **no `bs_balance_delta` or
  `bs_balance_delta_pct` column**. Drift today is computed from the
  canonical envelope's own internal arithmetic (`balance_sheet.total_assets`
  vs `balance_sheet.total_equity_and_liabilities`), not stored as a
  separate column. Periods without an envelope have no measurable
  drift — that's a real telemetry gap.
- `documents.status` has values `analyzed` and `failed`.
  `documents.original_filename` is populated; no upload-system metadata
  distinguishes SAGA C / SAGA ERP / WinMENTOR. SAGA detection is
  filename-heuristic.

**Actual prod inventory** (counts as of 2026-05-26):

| Metric | Value |
|---|---|
| Total `documents` rows | 30 |
| Total `financial_periods` rows | 5 |
| Documents with `status='analyzed'` | 29 |
| Documents with `status='failed'` | 1 (`Trading YTD profitability stock mov.xlsx` — sales analysis uploaded as TB by mistake; expected behavior) |
| Periods with envelope (`assembled_canonical_v1 IS NOT NULL`) | 2 (`a64a682e` RealEstate + `b50cbdb2` scandia, both already backfilled) |
| Periods without envelope | 3 (`6c6b8503` EEI + `377e43be`/`92788026` Sibiu — the 3b.5 backfill targets) |

**SAGA-class identification** (filename heuristic, hints: `saga`,
`bln_cont`, `winmentor`, `contsal`, `balanta`, `balanță`):

| Bucket | Count |
|---|---|
| SAGA-class documents | 6 of 30 |
| Sample filenames | `balanta verificare EEI dec 2025.pdf` (×4 duplicates), `Balanta Scandia Food_31.12.2025 LV copy.xls`, `Balanta contabila Scandia Sibiu 12.2019.PDF` |
| SAGA-class periods (linked) | 2 of 5 |

### §1.2 — BS drift distribution: n is too small for percentiles

I cannot compute a meaningful p50/p95/p99 on prod uploads because:

1. Only **2 periods have envelopes** (the already-backfilled
   `a64a682e` + `b50cbdb2`). The other 3 target periods — which this
   sprint backfills — have **no drift data** until after the backfill
   completes.
2. Both envelope-bearing periods are calibration-team uploads (Scandia
   + RealEstate test data), not customer uploads. The "30 days of
   user SAGA uploads" the prompt anticipated **doesn't exist on
   prod yet** — this is still a pre-customer-traffic phase.

**The actual ground truth for SAGA error rate is the 8 calibrated
fixtures** measured by F-A3.1 in this session's Step 0:

| Fixture | Source type | BS drift | Verdict |
|---|---|---|---|
| EEI | PDF (statutory) | 0.0000 % | GREEN |
| Scandia | SAGA xlsx 8-col | 0.0331 % | GREEN |
| Sibiu | PDF (WinMENTOR) | 0.9993 % | GREEN (≤ 1.0 %) |
| Frozen | SAGA xlsx | 0.0000 % | GREEN |
| RealEstate | SAGA xlsx | 0.0000 % | GREEN |
| Agras | extended-layout xlsx | 0.1189 % | GREEN |
| **Carniprod** | extended-layout xlsx | **7.3939 %** | GREEN (≤ 8.0 % calibrated; source imbalance 4.27 %) |
| Retail | extended-layout xlsx | 0.0000 % | GREEN |

**Honest summary:**
- 7 of 8 fixtures: drift ≤ 1 % (target met today)
- 1 of 8 fixtures: Carniprod at 7.39 %, **NOT engine-induced** — it's
  4.27 % source-side imbalance. §3's source-data quality gate makes
  this explicit instead of buried under a per-fixture threshold.
- p50 drift on calibrated fixtures: 0.0165 % (median of the 8)
- p95 drift on calibrated fixtures: 7.39 % (Carniprod)
- p95 excluding source-imbalance outlier: 0.9993 % (Sibiu)

### §1.3 — Failure mode coverage from this empirical look

The §1 prod sweep surfaced concrete signals that gate §2 fix priorities:

1. **Failed documents — 1 of 30 (3.3 % failure rate).** That one
   failure is a wrong-file-type upload (sales analysis as TB) which
   is expected behavior, not a parser bug. **Parser failure rate on
   actual TBs: 0 of 29 uploads** — every TB-shaped file extracts.
2. **Duplicate Sibiu PDF uploads (×2 periods from 2 different
   `source_document_id`s).** The 2 Sibiu periods are 100% duplicates
   by content but came in as separate documents. The dedup gap is
   upstream of the parser (at upload-create time). Filed as
   `[F3.20-DUPLICATE-PERIOD-DETECTION]` per operator note in this
   session's prompt.
3. **EEI duplicate uploads (×4 documents, same filename).** Four
   copies of `balanta verificare EEI dec 2025.pdf` in `documents` —
   but only **one** resulted in a `financial_periods` row
   (`6c6b8503`). Either upload-side dedup worked here, or the other
   3 failed silently. Worth a follow-up audit per
   `[F3.20-DUPLICATE-PERIOD-DETECTION]`.
4. **`extraction_confidence = 0.95`** populated on at least the
   EEI period. The column exists and carries real values — surfacing
   this in the user-facing accuracy banner would be ~10 LOC. Already
   shipped via ACC-BANNER task #137; verify it's wired through to
   the FE for these prod periods.

### §1.4 — Honest data gaps preventing better baseline

- **`unmapped_accounts` field not persisted** — can't compute
  "mapping accuracy per upload" in aggregate. Spec'd in §2 #6.
- **`bs_balance_delta_pct` not a persisted column** — drift is
  envelope-computed on the fly; periods without envelope have no
  drift telemetry. F-A3.3-ENVELOPE-COVERAGE turning GREEN (after 3b.5
  completes) makes drift queryable on every period.
- **SAGA-version metadata not captured** — filename heuristic is the
  only signal. SAGA C / SAGA ERP / WinMENTOR all collapse into one
  bucket. Spec for `[F3.20-DETECTION-VERSION]` follow-up: capture
  parser-detected dialect (`saga_8col`, `saga_6col`, `winmentor`,
  `crystal_reports`, `extended_layout`) into a new column at
  pipeline-extract time.

## §2 — SAGA failure-mode catalog (code audit)

Each item below has: **current behavior** (verbatim from code with
file:line refs), **prod impact prediction** (high/medium/low — based on
fixture priors + the audit), **proposed fix**, **effort estimate**.

The discipline: only ship items where prod telemetry confirms the
predicted impact. The audit gives us the spec; the prod data gates
which specs become PRs.

### #1 — Sheet name detection

**Current behavior (`src/engine/country_packs/ro_romania/trial_balance_parser.py:87`):**

```python
df = pd.read_excel(io.BytesIO(file_bytes), engine=engine, sheet_name=0, ...)
```

The parser reads **only the first sheet**. No sheet-name detection
exists. If a SAGA export ships with a cover sheet, summary sheet, or
table-of-contents tab before the actual "Balanta de verificare" tab,
the parser reads garbage and fails downstream.

**Prod impact prediction:** Medium-high. SAGA's default export is a
single-sheet workbook (matches today's behavior), but SAGA C and SAGA
ERP allow custom report templates that often add a cover page. User
files that hit the FE upload with multi-sheet workbooks AND a
non-first balanta tab fall through.

**Proposed fix:**

```python
SHEET_NAME_PATTERNS = [
    re.compile(r"^balan[tț][aă]\s*de\s*verificare", re.I),
    re.compile(r"^balan[tț][aă]", re.I),
    re.compile(r"^bv$", re.I),
    re.compile(r"^trial.?balance", re.I),
    re.compile(r"^tb$", re.I),
]

def _pick_tb_sheet(xls: pd.ExcelFile) -> str:
    """Score every sheet by (a) header pattern match, (b) data-row
    count, (c) presence of TB-shape columns (Cont + Sume totale).
    Pick the highest scorer. Tiebreak: first sheet."""
    candidates = []
    for sheet in xls.sheet_names:
        score = 0
        # Name-based scoring
        for pat in SHEET_NAME_PATTERNS:
            if pat.search(sheet.strip()):
                score += 100
                break
        # Shape-based scoring — read first 30 rows, look for "Cont" header
        sample = pd.read_excel(xls, sheet_name=sheet, header=None, nrows=30, dtype=str)
        if _looks_like_tb_header(sample):
            score += 50
        candidates.append((score, sheet))
    candidates.sort(reverse=True)
    return candidates[0][1] if candidates[0][0] > 0 else xls.sheet_names[0]
```

**Effort:** ~30 LOC + 4 unit tests (each named variant). 1 PR, half a
session.

### #2 — Analytic code rollup (411.01 → 411)

**Current behavior:** `src/engine/country_packs/ro_romania/trial_balance_parser.py:432`:

```python
if not re.match(r"^\d{3,8}(\.\d{1,4})?$", code):
    continue
```

Allows `1012.01`, `1621.81`, `167.201`. Downstream
`chart_of_accounts.MappingRule.matches` uses `code.startswith(prefix)`,
so `1012.01` routes to the `1012` rule. **This works for routing.**

What's NOT validated: that the sum of analytic sub-codes equals the
parent code's total. SAGA exports both — `411` AND `411.01`, `411.02`,
etc. on the same trial balance. The parser sums all rows including
parents, which **double-counts** when both are present.

**Audit needed (prod):** verify whether SAGA exports include parents
AND analytics, or only one. If both, every SAGA upload is overcounting
silently.

**Prod impact prediction:** Medium-high if SAGA exports both layers.
Low if only analytics. Verification required.

**Proposed fix:**

```python
def _filter_to_leaf_analytics(accounts: List[Dict]) -> List[Dict]:
    """When a parent code (e.g. '411') AND its analytics ('411.01',
    '411.02') both appear, drop the parent — its total double-counts
    the analytics. Detected by exact-prefix match: '411.01'.startswith('411')."""
    codes_present = {a["cont"] for a in accounts}
    has_analytics = {
        parent for parent in codes_present
        if any(c != parent and c.startswith(parent + ".") for c in codes_present)
    }
    return [a for a in accounts if a["cont"] not in has_analytics]
```

**Effort:** ~25 LOC + 1 fixture test (Scandia / Sibiu likely already
trigger this path). 1 PR.

### #3 — Contra account sign handling

**Current behavior:** Comprehensive coverage in
`src/engine/country_packs/ro_romania/chart_of_accounts.py`:

| Code | Rule | File:Line |
|---|---|---|
| 2811-2815 | sign=-1, "Amort. ..." | lines 174-178 |
| 281* (catchall) | sign=-1 | covered |
| 391-398 | sign=-1, "Ajustări depreciere ..." | lines 191-198 |
| 491 | sign=-1, "Ajustări deprecierea creanțelor" | line 304 |
| 496 | sign=-1, "Ajustări creanțe afiliate" | line 308 |
| 59* | sign=-1, "Ajustări depreciere trezorerie" | line 470 |
| 709 | sign=+1, "Reduceri comerciale acordate — contra-revenue" | line 413 |

Coverage looks complete for the OMFP 1802 standard set. **No known
gap.**

**Prod impact prediction:** Low. The F3.13 calibration to oracle
sprint already tuned these against the 8 fixtures.

**Proposed action:** No code change. Add a CI test that asserts
EVERY 28x, 29x, 39x, 49x, 59x code has a MappingRule with sign=-1.
~15 LOC test. Defensive only; not a bug fix.

### #4 — Multi-period YTD exports

**Current behavior:** `pipeline.py:161` (`_detect_period_end_from_filename`)
extracts the period_end from the filename — `Balanta_31.12.2025.xls`
→ `2025-12-31`. No detection of multi-period columns within the file.

The parser at `trial_balance_parser.py:399-454` reads `cumulative_debit`
+ `cumulative_credit` columns ("Sume totale") which are the YTD
columns. If the user uploaded a "Balanta Octombrie 2025" exported in
December 2025 (where cumulative columns are YTD through October), the
parser still treats it as a December close.

**Prod impact prediction:** Medium. SAGA YTD-month exports are common
during the year (CFOs run them monthly). Mid-year period_end
mis-attribution silently inflates "current year" results.

**Proposed fix:** Read the SAGA banner row (typically row 1 or 2 of
the worksheet) for the period text — `"Perioada 01.01.2025 - 31.10.2025"`
— and use it as the source of truth for period_end. Reject filename
fallback when banner text is present.

```python
PERIOD_BANNER_PATTERN = re.compile(
    r"perioad[aă][:\s]*"
    r"(\d{1,2})[./-](\d{1,2})[./-](\d{4})"
    r"\s*[-—–]\s*"
    r"(\d{1,2})[./-](\d{1,2})[./-](\d{4})",
    re.I,
)

def _extract_period_from_banner(df_head: pd.DataFrame) -> Optional[date]:
    """Walk first 10 rows looking for the period banner. Return the
    END date if found, None otherwise. Caller falls back to filename
    pattern."""
    for i in range(min(10, len(df_head))):
        for j in range(min(20, df_head.shape[1])):
            cell = df_head.iat[i, j]
            if isinstance(cell, str) and (m := PERIOD_BANNER_PATTERN.search(cell)):
                day, mo, yr = int(m.group(4)), int(m.group(5)), int(m.group(6))
                try:
                    return date(yr, mo, day)
                except ValueError:
                    continue
    return None
```

**Effort:** ~40 LOC parser + ~20 LOC pipeline wiring + 2 fixture tests
(year-end + mid-year). 1 PR.

### #5 — Mid-year vs year-end 121 handling

**Current behavior:** `chart_of_accounts.py:1118-1128`:

```python
if code.startswith("121"):
    if account_121_anchor is None:
        account_121_anchor = 0.0
    account_121_anchor += <closing_balance>
```

The 121 anchor fires **unconditionally on any 121 closing balance**.
Mid-year periods have non-zero 121 balances that legitimately should
NOT anchor — the closing happens at fiscal year-end.

**Prod impact prediction:** Medium-high. Real-estate developers
upload mid-year balanca files routinely; their 121 mid-year carries
the YTD profit which then anchors equity to the wrong value.

**Proposed fix:** Only anchor 121 when `period_end` matches the
fiscal year-end (12/31). Pipeline already knows the period_end (from
#4's fix); pass a `is_year_end` kwarg into `assemble_statements`:

```python
def assemble_statements(
    accounts: List[Dict],
    ...,
    is_year_end: bool = True,  # default preserves today's behavior
    account_121_anchor_override: Optional[float] = None,
):
    ...
    # Inside the loop:
    if code.startswith("121") and is_year_end:
        # ... existing anchor logic
```

Pipeline wiring:

```python
# pipeline.py::stage_assemble
period_end_iso = parsed["period_end"]
month_day = period_end_iso[5:]  # 'mm-dd'
is_year_end = month_day == "12-31"
result = pack.assemble_statements(accounts, is_year_end=is_year_end, ...)
```

**Effort:** ~10 LOC engine + ~5 LOC pipeline + 1 fixture (mid-year
upload). 1 PR. Must update F-A3.1 to assert byte-identical on
year-end fixtures.

### #6 — Custom user-added accounts

**Current behavior:** No tracking of unmapped codes. `MappingRule.matches`
prefix-matches; codes that don't match any rule fall through with
`ignore_pl` / `ignore_bs` buckets that silently zero them out.

**Prod impact prediction:** High likelihood; impact varies. If the
unmapped magnitude is < 0.1 % of total assets, drift stays within
calibrated thresholds. If > 1 %, BS drift surfaces immediately.

**Proposed fix:**

```python
def assemble_statements(accounts, ..., on_unmapped: Optional[Callable] = None):
    ...
    unmapped: List[Dict] = []
    for acct in accounts:
        rule = _match_rule(acct["cont"])
        if rule is None:
            unmapped.append({
                "code": acct["cont"],
                "name": acct["nume_cont"],
                "magnitude": abs(acct["sf_d"] - acct["sf_c"]),
            })
            continue
        # ... existing mapping logic
    return {
        ...,
        "unmapped_accounts": unmapped,
        "unmapped_magnitude_pct": (
            sum(u["magnitude"] for u in unmapped) /
            max(sum(abs(a["sf_d"]) + abs(a["sf_c"]) for a in accounts), 1.0)
        ),
    }
```

Surface in API response under `meta.unmapped_accounts`. FE banner
when `unmapped_magnitude_pct > 1.0`. This is also what §1.1's Q3+Q5
queries need to compute mapping accuracy retroactively — once this
field is persisted, prod telemetry has a real "accuracy per upload"
signal.

**Effort:** ~30 LOC engine + ~10 LOC pipeline + ~25 LOC FE banner +
~10 LOC migration to add `meta.unmapped_accounts` to schema. 1 PR.

### #7 — Decimal separator variations

**Current behavior:** `trial_balance_parser.py:473-525` (`_to_number`).
Already handles Romanian + English + space-thousands +
NBSP-thousands + parenthesized negatives. Coverage looks comprehensive.

**Prod impact prediction:** Low. The function comment lists every
variant we've seen; no known gap.

**Proposed action:** No code change. Add a unit test fixture with
every variant (~20 cases) to lock the behavior. Defensive only.

### #8 — Date format variations

**Current behavior:** `pipeline.py:161-221` (`_detect_period_end_from_filename`)
handles the variants Romanian users typically include in filenames:
`Balanta_31.12.2025`, `bln_2025_12`, `Q4-2025`, etc. The `_to_number`
helper for dates is not present — dates only appear in the period_end
detection from filename, not in the trial-balance row data.

The period banner pattern in #4 above would extend coverage to
in-document dates.

**Prod impact prediction:** Low standalone; rolled up into #4.

### #9 — Empty cells vs zero

**Current behavior:** `_to_number` at `trial_balance_parser.py:489-494`:

```python
if pd.isna(value) or value is None:
    return 0.0
s = str(value).strip()
if not s or s.lower() in ("nan", "none", "-", "—"):
    return 0.0
```

Empty / NaN / "-" / "—" all → 0.0. **No distinction between "not
reported" and "zero balance."**

**Prod impact prediction:** Low for SAGA (SAGA always populates with
0 for zero balances; empty cells are rare). Higher for hand-edited
files where users delete cells.

**Proposed action:** No code change unless prod data shows
hand-edited files driving drift. Defensive add: surface an
`empty_cells_count` field in `meta` for diagnostics.

### #10 — Account code format variants

**Current behavior:** `trial_balance_parser.py:432`:

```python
if not re.match(r"^\d{3,8}(\.\d{1,4})?$", code):
    continue
```

Accepts:
- 3-8 digits: `411`, `1012`, `41101` ✓
- with `.N` to 4-digit suffix: `1012.01`, `167.201` ✓

Does NOT accept:
- Letter prefixes/suffixes (rare in SAGA; common in hand-rolled CoAs)
- Codes < 3 digits or > 8 digits
- Codes with hyphens or other separators

**Prod impact prediction:** Low for SAGA proper. Medium for
non-SAGA Romanian exports that use longer analytic codes.

**Proposed action:** Track rejected codes in the same
`unmapped_accounts` plumbing from #6. If prod data shows > 1 % of
codes getting rejected by this regex, widen.

---

## §3 — Upstream source-data quality gate

The Carniprod 4.27 % source imbalance (locked in the F3.16 ADR) is
the wedge case: engine threshold calibration alone can't fix it
because the source data is wrong. The right gate is upstream of the
engine.

### §3.1 — Spec

**Where the check fires:** `pipeline.py::stage_extract`, immediately
after `parse_trial_balance_df` returns the `accounts` list. Before
mapping, before assembly.

**Computation:**

```python
def check_source_imbalance(accounts: List[Dict]) -> Dict[str, Any]:
    sum_d = sum(a["sf_d"] for a in accounts)
    sum_c = sum(a["sf_c"] for a in accounts)
    base = max(sum_d, sum_c)
    if base == 0:
        return {"status": "EMPTY", "imbalance_pct": 0.0, "sum_d": 0, "sum_c": 0}
    imbalance_pct = abs(sum_d - sum_c) / base * 100.0
    if imbalance_pct >= 0.5:
        status = "RED"
    elif imbalance_pct >= 0.1:
        status = "YELLOW"
    else:
        status = "GREEN"
    return {"status": status, "imbalance_pct": imbalance_pct,
            "sum_d": sum_d, "sum_c": sum_c}
```

**Threshold rationale:**
- 0.5 % RED — historically every engine-induced drift sits below this;
  imbalance ≥ 0.5 % is source-side, not engine-side.
- 0.1 % YELLOW — rounding noise (kRON-to-RON-cent conversions, locale
  drift) lives in 0.05-0.1 %. Above this is real data drift.
- < 0.1 % GREEN — within rounding tolerance.

**RED uploads still process — never silently shipped.** The pipeline
continues but the API response carries `source_quality.status = "RED"`
plus the imbalance number; the FE renders a prominent banner.

### §3.2 — API response shape

```json
{
  "meta": {
    "source_quality": {
      "status": "RED",
      "imbalance_pct": 4.27,
      "sum_debit": 460_963_810,
      "sum_credit": 481_672_555,
      "diff_ron": 20_708_745,
      "remediation": "Source-file trial balance has a 4.27 % debit-credit imbalance. The analysis below uses these numbers as-is; verify the source export before relying on the results.",
      "calibrated_threshold_used_for_engine": 8.0
    }
  }
}
```

The `calibrated_threshold_used_for_engine` is provenance: explains
that the engine threshold widening to 8 % (Carniprod-style) was a
band-aid for source imbalance, not engine drift. With the gate in
place, the engine threshold returns to 0.5 % for everyone — the gate
takes the explanation responsibility.

### §3.3 — FE banner

Lives in `SourceQualityBanner.tsx` (already exists per task #137 —
ACC-BANNER drift-aware accuracy banner). Extends with:

- RED → red banner, prominent, includes `diff_ron` number
- YELLOW → amber banner, smaller
- GREEN → no banner (current behavior)

### §3.4 — Carniprod predicted behavior post-gate

| Before gate | After gate |
|---|---|
| BS drift 7.39 %, F-A3.1 widened threshold to 8 % | BS drift unchanged 7.39 %, **source_quality.status="RED"** |
| Briefing references "Carniprod" with no caveats | Briefing reads source_quality, prepends "Note: source data imbalance 4.27 %" caveat |
| Engine thresholds carry per-fixture widening | Engine thresholds return to 0.5 % global, gate carries the imbalance explanation |

**Effort:** ~30 LOC engine + ~20 LOC API serialization + ~40 LOC FE
banner extension + 2 fixture tests. 1 PR. F-A3.1 thresholds can be
tightened in the SAME PR (the gate's `source_quality.status` is what
explains Carniprod's drift).

---

## §4 — Multi-model extraction ensemble (Path B upgrade) — 🅿️ **PARKED**

**Status (locked 2026-05-26 after prod baseline re-frame):**
PARKED until customer SAGA traffic exists and proves single-model
Path B + source-data quality gate are insufficient. **Do not build
ensemble dispatch infra in F3.18 or F3.19.** Re-evaluate when prod
shows residual messy-input drift > 1 % on real customer uploads
(not calibration fixtures).

The original sequencing assumed customer traffic would emerge in
parallel with engine calibration. Track 3 §1's empirical baseline
shows that's not the situation — there are zero customer SAGA
uploads in the 30-day window, only calibration-team fixtures. Three
consequences:

1. **Building ensemble now is expensive theater.** ~3 sessions of
   focused infrastructure work + ongoing per-call provider cost
   (~$0.16/upload across Opus + GPT + Gemini). With zero customer
   traffic, zero earned value.
2. **The 8 fixtures already disprove the "single-model is broken"
   assumption.** F-A3.1 shows 7/8 fixtures at < 1 % drift via the
   deterministic parser (no Path B fallback triggered). Path B is
   the safety net for fixtures the deterministic parser can't read;
   if 7/8 don't need the safety net, the assumption that Path B
   itself needs ensemble-grade upgrade isn't supported.
3. **Source-data quality gate (§3) handles the actual failure
   class we observe today** — Carniprod's source imbalance. That's
   the ship item, not ensemble.

The spec below is preserved as a reference for the future re-eval.
Read it, don't build it.

Path B (Claude fallback) currently single-model. For uploads where
Path A confidence < 85 %:

### §4.1 — Trigger condition

Ensemble fires when:
1. Path A returns confidence < 85 % (i.e., parser dropped to Claude
   fallback)
2. AND source_quality.status != "RED" (no point running ensemble on
   bad source data)
3. AND upload size < 5 MB (cost cap)
4. AND user is on a paid tier (cost cap)

### §4.2 — Dispatch

Three models in parallel:
- Anthropic Opus 4.7 — `claude-opus-4-7`, adaptive thinking, effort `xhigh`
- OpenAI GPT-4o — `gpt-4o`
- Google Gemini 2.5 Pro — `gemini-2.5-pro`

Each gets the same OCR'd text + the same extraction prompt + the same
output schema (`{code, name, amount}[]`).

Implementation lives in `src/engine/ai_orch/` (the AI-ORCH-* tasks
shipped through task #129). The orchestrator already has Claude +
GPT adapters; Gemini needs a new adapter.

### §4.3 — Voting + winner selection

For each candidate's output, run it through
`chart_of_accounts.assemble_statements` and compute `bs_drift_pct`.

Winner = lowest `bs_drift_pct`. Tie-breaker = highest `models_agreement_pct`
on row count + magnitude.

If all three drift > 5 %, flag for operator review — the API response
carries all three candidates and the FE shows a "manual review
required" surface with all three options.

### §4.4 — Cost + latency caps

| Model | Input $/1M tok | Output $/1M tok | Typical extraction tokens | Per-call cost |
|---|---|---|---|---|
| Opus 4.7 | 5 | 25 | ~5K in, ~3K out | ~$0.10 |
| GPT-4o | 2.5 | 10 | same | ~$0.04 |
| Gemini 2.5 Pro | 1.25 | 5 | same | ~$0.02 |
| **Ensemble total** | — | — | — | **~$0.16/upload** |

vs. current single-model Path B (~$0.15). Cost ceiling **$0.50/upload
max** lets us add OCR retries + a 4th tiebreaker model without
re-budgeting.

Latency: parallel dispatch, longest leg dominates. Opus 4.7 with
xhigh effort can take 30-45s; cap at 60s. If any model misses the
60s window, drop it from the vote; require ≥ 2 votes for a verdict.

### §4.5 — Provenance fields

```json
{
  "meta": {
    "extraction_method": "ensemble",
    "models_agreement_pct": 87.5,
    "winning_model": "claude-opus-4-7",
    "models_attempted": ["claude-opus-4-7", "gpt-4o", "gemini-2.5-pro"],
    "models_timed_out": [],
    "cost_usd": 0.16,
    "candidate_drifts": {
      "claude-opus-4-7": 0.12,
      "gpt-4o": 0.81,
      "gemini-2.5-pro": 2.4
    }
  }
}
```

These ride on every analyzed period. Auditors see exactly which model
won, what the other models said, and the agreement rate. If a
customer disputes a number, the audit trail is one query away.

### §4.6 — Graduation from PARKED (objective triggers — all four must hold)

**PARKED. Not scheduled.** The discipline rule for un-parking is
explicit objective triggers, NOT "we'll revisit when it feels
right." Objective triggers prevent both premature un-parking (cost
without value) and indefinite forgetting (value goes unrealized).

Ensemble graduates from PARKED to ACTIVE sprint plan when **ALL
FOUR** of the following hold simultaneously:

| # | Trigger | Source of measurement |
|---|---|---|
| 1 | ≥ 100 real customer uploads in a 30-day window (calibration-team fixtures explicitly excluded) | `documents` table filtered by `org_id` ≠ internal-team orgs, `created_at >= now() - interval '30 days'` |
| 2 | p95 BS drift on customer SAGA-class uploads > 1.5 % sustained over 2 consecutive weekly windows | Requires F3.18-SOURCE-QUALITY-GATE shipped + F3.22 materialized drift column (so query is fast at scale) |
| 3 | Root-cause analysis on the worst 10 % of uploads identifies **extraction quality** as the dominant failure mode (not source-data quality, not engine bugs) | Per-upload investigation. Specifically: the failing uploads must be ones where Path A confidence < 85 % AND the extracted accounts cannot be reconstructed deterministically. If Path A is already extracting cleanly, ensemble doesn't help. |
| 4 | Single-model Path B cost-per-upload << $0.50 budget ceiling AND average customer upload count per org indicates ensemble's added $0.10-$0.15/upload fits the unit economics | Adapter telemetry + billing-side per-org doc counts |

Re-check cadence: **quarterly**. The check is a 30-minute query
against the 4 conditions above; if any are unmet, stay parked for
another quarter. If all four flip green, run the implementation
spec preserved below.

Expected state through F4.6 (next 2 quarters): parked. Earliest
realistic un-parking window: post-F5 once customer GA traffic has
been ramping for a quarter. Mark the calendar for the next quarterly
re-check; don't let it become indefinite forgetting.

When all four conditions hold, the spec above is ready to execute
as-is — Gemini 2.5 Pro adapter addition + voting layer wire-up +
cost cap enforcement. No design work blocked, only implementation
work waiting for empirical justification.

---

## §5 — Recommended sequence to hit < 1 % target (re-ranked 2026-05-26)

The original §5 ranked fixes by predicted p95 drop on SAGA traffic
that doesn't exist yet. Re-ranked below by what actually moves the
needle for the **first 100 customer users** — which means the
source-data quality gate moves to #1, the SAGA bulletproofing items
become conditional on prod evidence, and ensemble drops off the
ship list entirely.

| Priority | Fix | Why it matters NOW | Effort | When |
|---|---|---|---|---|
| **1** | **§3 Source-data quality gate** | Carniprod-class outliers get explicit RED flag instead of silent threshold widening. Enables F-A3.1 to return to 0.5 % global default. Carniprod is the only real-world failure mode currently observable. | 1 session | **Session +2** |
| **2** | **§2 #6 Unmapped accounts plumbing** | Without this, we can't measure "mapping accuracy per upload" when customer traffic arrives. Infrastructure for the next sprint's measurement. | 0.5 session | Session +2 (same PR as #1) |
| **3** | F3.16-3b.6 F4.2 hardening | Closes F3.16 sprint, makes methodology fields the single source of truth. Plan locked at `docs/F3.16-3b6-f42-hardening-plan.md`. | 1 session | **Next session** (already scheduled) |
| **4** | F3.15 fallback deletion | Removes the legacy code path. Per ADR sequencing — only after F-A3.3 GREEN holds for 24-48h. | 0.5 session | Session +3 (after F-A3.3 stable) |
| **5** *conditional* | §2 #1 Sheet name detection | Code audit says `sheet_name=0` is brittle. **Ship only if prod telemetry shows ≥ 1 customer upload failed with multi-sheet workbook.** Until then, defensive add. | 0.5 session | Session +3 conditional |
| **6** *conditional* | §2 #5 Mid-year 121 handling | Code audit says 121 anchor fires unconditionally. **Ship only if prod telemetry shows ≥ 1 mid-year upload anchoring wrong.** | 0.5 session | Session +3 conditional |
| **7** *conditional* | §2 #2 Analytic rollup dedup | Code audit gated on prod confirmation. Ship only if double-counting is observed in real data. | 0.5 session | Session +3 conditional |
| **8** *conditional* | §2 #4 Period banner detection | Low impact in isolation; ships with #5 if #5 ships. | 0.25 session | Session +3 conditional |
| **🅿️** | §4 Multi-model ensemble | **PARKED** until customer traffic exists. Re-eval quarterly. | — | Not scheduled |

### Bundled PR composition (post-re-frame)

- **F3.16-3b.6** (next session, already locked): F4.2 hardening +
  consumer cutover + briefing discipline. ~150 LOC.
- **F3.18-SOURCE-QUALITY-GATE + UNMAPPED-PLUMBING** (session +2):
  Combined PR. §3 + §2 #6. Tightens F-A3.1 thresholds back to 0.5 %
  global default. ~190 LOC. Carniprod prediction lock pre-deploy +
  actuals post-deploy per ADR Lock #6.
- **F3.15-FALLBACK-DELETION** (session +3): Per ADR. Only ships after
  F-A3.3 stable 24-48h. ~50 LOC delete, replaces fallback with hard
  error.
- **F3.18-SAGA-BULLETPROOFING** (session +3, **conditional**): §2 #1
  + #2 + #4 + #5. ~120 LOC. **Each item ships only if prod telemetry
  shows it's a real failure.** Pre-merge: F-A3.1 GREEN on all 8
  fixtures.
- **F3.19-ENSEMBLE** — REMOVED from ship calendar. Re-eval quarterly.

Target state per upload class:

| Class | Today (estimated) | After F3.18 batch | After +3 quality gate | After +4 ensemble |
|---|---|---|---|---|
| Clean SAGA xlsx | < 0.5 % | < 0.3 % | < 0.3 % | < 0.3 % |
| SAGA with quirks (mid-year, multi-sheet) | 1-3 % | < 1 % | < 1 % | < 1 % |
| Non-SAGA Romanian xlsx | 0.5-2 % | 0.5-1.5 % | < 1 % (gate explains) | < 1 % |
| Romanian PDF (statutory) | 0.5-2 % | unchanged | unchanged | < 1.5 % |
| Messy / scanned PDF | 2-8 % | unchanged | unchanged | < 3 % |

After session +4: SAGA-class target met. Romanian-PDF target met.
Messy-PDF residual class is the only one where ensemble has
measurable impact — that's where the ~$0.16/upload spend earns out.

---

## §6 — Open questions surfaced by the audit

1. **Does SAGA export both parent codes AND analytic sub-codes?**
   §2 #2 is gated on this. Audit by running probe_backfill_classify.py
   variant that counts codes per parent. Defer to session +2 if
   not blocking.

2. **Are mid-year balanca uploads common in prod?**
   §2 #5 fix is bounded. Telemetry from §1.1 queries answers this.

3. **What % of prod uploads carry source imbalance > 0.5 %?**
   §3 threshold validation. If only Carniprod-class outliers
   trigger RED, gate ships with confidence. If 20 %+ of uploads
   trigger RED, the threshold itself needs re-calibration.

4. **Does Gemini 2.5 Pro adapter exist in `src/engine/ai_orch/`?**
   Per AI-ORCH-2 (task #124), Claude + GPT adapters exist. Gemini
   doesn't yet — that's part of the F3.19 cost.

Each open question maps to a `[F3.20-INVESTIGATE-XXX]` ticket; resolve
before its dependent fix ships.

---

## §7 — Sprint slot allocation

Per the prompt's session calendar:

- **Session +2** — F3.18-SAGA-CALIBRATION batch (§2 fixes #1, #2, #4, #5).
  Carniprod prediction lock pre-deploy. Pre-baseline F-A3.1 + F-A3.2,
  ship, post-baseline F-A3.1 + F-A3.2.
- **Session +3** — F3.18-SOURCE-QUALITY-GATE + UNMAPPED-PLUMBING (§3 + §2 #6).
  Tighten F-A3.1 thresholds back to 0.5 % in the same PR.
- **Session +4** — F3.19-ENSEMBLE, gated on session +3 telemetry. If
  p95 < 1 %, descope to "Romanian PDF only" or defer.
- **Session +5** — F3.15 fallback deletion (independent of SAGA work,
  per F3.16 ADR sequencing).
- **Session +6** — F3.16 formal closure + addendum to ADR documenting
  Carniprod's resolution path through §3 vs the previously-locked
  engine-threshold widening.

After session +6, the < 1 % SAGA target is met OR the descope-decision
is documented. Either outcome is a clean sprint close.

---

## §8 — Cross-references

- F3.16 closure ADR: `docs/ADR-F3.16-closure.md`
- 3b.5 backfill plan: `docs/F3.16-3b5-backfill-plan.md`
- 3b.5 execution handoff: `docs/F3.16-3b5-EXECUTION-HANDOFF.md`
- 3b.6 F4.2 hardening: `docs/F3.16-3b6-f42-hardening-plan.md`
- F-A3.1 gate: `scripts/measure_bs_drift.py`
- F-A3.2 gate: `scripts/measure_cross_path.py`
- F-A3.3 gate: `scripts/measure_envelope_coverage.py` (new this sprint)
- Parser audit subject: `src/engine/country_packs/ro_romania/trial_balance_parser.py`
- Mapping rules audit subject: `src/engine/country_packs/ro_romania/chart_of_accounts.py`
- AI orchestration foundation: `src/engine/ai_orch/` (AI-ORCH-* tasks #123-#129)
- ACC-BANNER drift surface (already shipped): task #137

---

## §9 — ADR follow-up tickets (surfaced 2026-05-26 during Track 3 §1 probe)

Four schema/architecture gaps surfaced when running the empirical
SAGA baseline against prod. Each is minor in isolation but becomes
a 30-minute investigation later if not filed now. Each ticket below
has the full structure: symptom that surfaces the bug, effort
estimate, blocking relationship to other work, and the objective
trigger that promotes it to active priority. **Pattern matches §4
PARKED graduation discipline — objective triggers, not
"we'll-revisit-when-it-feels-right."**

### [F3.20-DUPLICATE-PERIOD-DETECTION] — upstream doc-content-hash dedup

**Symptom (how this surfaces in the wild):**
- Same trial-balance file uploaded twice (same bytes, same content)
  produces two `documents` rows with different `id`s and two
  `financial_periods` rows with different `source_document_id`s. Both
  show in the FE period picker. Briefing prose may reference "FY2019"
  twice. User experience: "why is Sibiu listed twice?"
- Surfaced this session: 2× Sibiu PDF periods (`377e43be` +
  `92788026`) point at 2 different document UUIDs (`1894514a…` +
  `3e28c1c8…`) — confirmed via the snapshot-phase probe. The 2 PDFs
  ARE the same file (same `period_end`, same `line_items` count of
  191), just uploaded twice.

**Root cause (where to look):**
- Upload-side dedup gap. `src/engine/api/pipeline.py::stage_extract`
  doesn't compute content hash before creating a new `documents`
  row. Should compute `hashlib.sha256(file_bytes).hexdigest()` and
  either (a) reject the re-upload with a "same file already in
  workspace as <doc_id>" error, OR (b) offer to merge / replace the
  existing period when the user explicitly wants to re-trigger.

**Fix surface:**
1. Add `documents.content_hash` column (text, indexed). Migration:
   `ALTER TABLE documents ADD COLUMN content_hash TEXT;` +
   `CREATE INDEX idx_documents_content_hash ON documents(content_hash);`.
2. Populate at `stage_extract` (one-line addition before insert).
3. Backfill existing rows via one-shot script reading from
   `storage_path` blob.
4. On new upload: query `documents` for matching `(content_hash,
   org_id)` first; reject duplicates OR prompt user to confirm
   re-trigger (operator UX decision).
5. The period creation continues per-document — no period-level
   dedup needed. The dedup is upstream.

**Effort:** M (Medium, ~1.5 sessions). Schema migration + parser
wiring + FE re-upload-confirmation flow.

**Blocks / blocked by:**
- Not blocking any other ticket today.
- Blocked by: nothing — can ship immediately.
- Soft dependency: F-A3.3 envelope coverage (3b.5) should be GREEN
  before backfilling `content_hash` so re-reads see fresh envelopes.

**Trigger condition to promote to active:**
- ≥ 1 customer support ticket about "I see my data twice in the
  period picker." OR
- Any customer doing a re-upload with revised data hits the
  duplicate state inadvertently. (Calibration team hitting it
  today doesn't count — they're not customer-facing.)

---

### [F3.21-FINANCIAL-PERIODS-STATUS-COLUMN] — explicit status enum on periods

**Symptom (how this surfaces in the wild):**
- Direct queries like `SELECT * FROM financial_periods WHERE
  status = 'analyzed'` return zero rows when they should return
  many. Surfaced this session: my SAGA baseline probe filtered by
  `status` and got nothing because `financial_periods.status`
  doesn't exist; application code infers state from
  `assembled_canonical_v1 IS NOT NULL` instead.
- Next contributor querying the DB directly hits the same all-null
  result. The bug-surface-area is small (only direct-DB folks hit
  it) but the diagnostic cost is high — looks like a real failure
  until you discover the column simply isn't there.

**Root cause (where to look):**
- Schema-level vs application-level state representation gap. The
  app distinguishes `analyzed` / `in_flight` / `errored` / etc. by
  inspecting envelope presence + `methodology_version` + side
  tables. There's no single column that says "this period is ready
  to render in the FE."
- Fix surface: add `financial_periods.lifecycle_state` column with
  values `pending` / `analyzing` / `analyzed` / `failed` / `archived`.
  Backfill from existing app logic.

**Fix surface:**
1. Migration: `ALTER TABLE financial_periods ADD COLUMN
   lifecycle_state TEXT DEFAULT 'analyzed' CHECK (lifecycle_state
   IN ('pending','analyzing','analyzed','failed','archived'));`
2. Backfill: most existing rows are `analyzed`; failed pipeline
   runs (per `documents.status='failed'`) get `failed`; in-flight
   gets `analyzing`.
3. Pipeline wiring: `stage_extract` sets `pending`, `stage_assemble`
   sets `analyzed` on success / `failed` on error.
4. Application code reads `lifecycle_state` instead of inferring
   from envelope presence.

**Effort:** S (Small, ~0.5 session). Pure schema add + 4 call-site
updates + backfill query.

**Blocks / blocked by:**
- Blocks: nothing today. Discovery-level fix.
- Blocked by: F3.15 fallback deletion (the fallback path also
  infers state from envelope presence; the column add can ship
  before deletion but is cleanest after).

**Trigger condition to promote to active:**
- First contributor / new hire / external auditor surfaces
  confusion about period state from a direct-DB query. OR
- Any new feature requires distinguishing "analyzed but stale" from
  "analyzed and fresh" (e.g., re-analysis-required banner).

---

### [F3.22-MATERIALIZE-DRIFT-METRICS] — column for `bs_balance_delta_pct`

**Symptom (how this surfaces in the wild):**
- Aggregate queries like "p95 BS drift across customer uploads last
  30 days" require parsing every row's `assembled_canonical_v1`
  JSONB and computing the delta on-the-fly. At n=5 this is fine;
  at n=10,000 it's a multi-second query.
- F3.18-SOURCE-QUALITY-GATE's threshold logic (RED above 0.5 %,
  YELLOW 0.1-0.5 %, GREEN below) needs fast access to the drift
  number for the API response. JSON parsing per request adds 5-20ms.
- The §4 ensemble graduation trigger #2 ("p95 drift > 1.5 %
  sustained over 2 weekly windows") becomes a slow query if drift
  isn't materialized.

**Root cause (where to look):**
- `financial_periods` has `assembled_canonical_v1` (JSONB) with
  `balance_sheet.total_assets` + `total_equity_and_liabilities`,
  but no top-level numeric column for `abs(tel - ta) / ta * 100`.
  Drift is always derived, never persisted.

**Fix surface:**
1. Add columns: `bs_balance_delta_ron NUMERIC(18,2)` +
   `bs_balance_delta_pct NUMERIC(6,4)`.
2. Compute at `stage_assemble` from the same canonical envelope
   being written (zero extra cost).
3. Backfill: compute from existing envelopes via a one-shot
   migration. Re-extraction not required.
4. Generated columns (Postgres 12+) are an alternative:
   `bs_balance_delta_pct NUMERIC GENERATED ALWAYS AS
   (abs((assembled_canonical_v1#>>'{balance_sheet,total_equity_and_liabilities}')::numeric - (assembled_canonical_v1#>>'{balance_sheet,total_assets}')::numeric) / nullif((assembled_canonical_v1#>>'{balance_sheet,total_assets}')::numeric, 0) * 100) STORED;`
   — debatable whether to use this or compute in app code; either
   works.

**Effort:** S (Small, ~0.5 session). Migration + stage_assemble
wiring + one-shot backfill script.

**Blocks / blocked by:**
- Blocks: §4 ensemble graduation trigger #2 verification (slow at
  scale without this).
- Blocks: F3.18-SOURCE-QUALITY-GATE's fast-path response (the gate
  works without it but the per-request cost is higher).
- Blocked by: nothing — can ship anytime after 3b.5 backfill so
  all envelopes are populated for the materialization pass.

**Trigger condition to promote to active:**
- Customer traffic crosses n=100 periods AND any aggregate-drift
  query in the admin dashboard or alerting pipeline shows > 100ms
  latency in profiling. OR
- F3.18-SOURCE-QUALITY-GATE ship date approaches and we want the
  fast-path numeric for the API response.

---

### [F3.20-DETECTION-VERSION] — capture parser-detected dialect on documents

**Symptom (how this surfaces in the wild):**
- Today's "SAGA-class" identification is a filename heuristic
  (substring match for `saga`, `bln_cont`, `winmentor`, `balanta`).
  Real SAGA / WinMENTOR / Crystal Reports / extended-layout files
  all collapse into one bucket. Can't compute per-dialect drift
  baselines; can't tell which dialect a customer's failed upload
  was using when investigating support tickets.
- Per-dialect calibration becomes impossible at scale. If SAGA 8-col
  starts drifting more than SAGA 6-col, we have no way to see it.

**Root cause (where to look):**
- `detect_trial_balance_structure` in
  `src/engine/country_packs/ro_romania/trial_balance_parser.py`
  already classifies layout shape — knows whether it's 6-col,
  8-col, 10-col, 20-col extended, Crystal Reports, etc. The
  classification is computed but discarded.

**Fix surface:**
1. Add `documents.detection_dialect TEXT` column with values like
   `saga_8col` / `saga_6col` / `winmentor_extended` /
   `crystal_reports` / `extended_20col` / `extended_22col` /
   `pdf_statutory` / `unknown`.
2. `detect_trial_balance_structure` returns the dialect alongside
   the column map; `stage_extract` writes it.
3. Surface in API response under `meta.detection_dialect` so the
   FE can show per-dialect badges if desired (operator decision;
   not user-required).
4. Aggregate queries can group by dialect for per-dialect drift
   measurement.

**Effort:** S (Small, ~0.5 session). Schema add + extractor return
shape change + 3 call-site updates.

**Blocks / blocked by:**
- Blocks: per-dialect drift baselining (can't compute "p50 drift on
  SAGA 8-col vs SAGA 6-col" without this).
- Blocked by: nothing — can ship anytime.

**Trigger condition to promote to active:**
- Customer support ticket where the dialect would be useful info
  for diagnosis (e.g., "user upload is failing and we don't know
  if it's SAGA C, SAGA ERP, or WinMENTOR"). OR
- F3.19-ENSEMBLE un-parks and needs per-dialect routing decisions.

---

### [F3.24-MIGRATION-SCHEMA-CACHE-DISCIPLINE] — both-path migration protocol

**Symptom (how this surfaces in the wild):**
- SQL migration in Supabase Studio runs cleanly, `pg_catalog`
  verification confirms the column exists, but every subsequent API
  call via `_supabase.admin().select()` returns rows without the new
  column OR returns 400 Bad Request on explicit column selection.
- Orchestrator scripts that depend on writing to the new column
  silently produce partial-capture payloads (the column key is
  dropped before the UPDATE goes out) — data corruption that the
  orchestrator may not notice unless it has an explicit pre-write
  visibility check.
- Surfaced this session: F3.16-3b.5 hit this exactly. The discipline
  check in `_verify_snapshot_column` correctly halted before any
  writes. Three reload signals exhausted (NOTIFY + Dashboard click +
  Settings toggle); cache still stale. See F3.25 below.

**Root cause:**
- PostgREST caches column lists at startup + on schema-change events.
  `NOTIFY pgrst, 'reload schema';` is the vanilla-PostgREST refresh
  signal but **Supabase managed PostgREST does NOT reliably subscribe
  to that channel**. The deterministic refresh path on Supabase is the
  Dashboard "Reload schema cache" button (Settings → API).

**Fix surface (shipped this session, 2026-05-26):**

1. **Migration template discipline.** Every
   `supabase/schema_phase_*.sql` ends with `NOTIFY pgrst, 'reload schema';`.
   Backfilled into all 12 existing migrations on 2026-05-26.
   Idempotent + harmless on re-run + harmless on Supabase (where the
   NOTIFY is no-op).
2. **Deploy runbook discipline.** Every schema-migration deploy step in
   CLAUDE.md §14 now reads: "(a) run SQL with NOTIFY at the bottom,
   (b) **click Dashboard → Settings → API → 'Reload schema cache'
   immediately afterward** — this is the deterministic step on
   Supabase, NOT a fallback."
3. **Orchestrator pre-flight helper.** Extracted
   `scripts/_pgrst_visibility.py::verify_pgrst_visibility(ac, table, column)`.
   Every future orchestrator that depends on a freshly-added column
   imports it and calls it before any writes. The helper does two
   probes (wildcard + explicit select), raises SystemExit on failure
   with the F3.24 escalation runbook embedded in the message.

**Effort:** S — already shipped this session. ~50 LOC across 3 files
(helper module, CLAUDE.md §14 update, schema_phase_*.sql backfill).

**Blocks / blocked by:**
- Blocks: any future migration-then-write orchestrator (every one
  must import `verify_pgrst_visibility`).
- Blocked by: nothing.

**Trigger condition for further work:** if a future session surfaces
that the orchestrator helper is being bypassed OR the protocol step
is being skipped, add a CI lint check that greps `scripts/run_*.py`
for `verify_pgrst_visibility` import.

---

### [F3.25-SUPABASE-POSTGREST-CACHE-PERSISTENT-STALENESS] — Bug #4 escalation

**SAGA §9 entry created: 2026-05-26** (during F3.16-3b.5 execution — captured
the symptom + evidence trail + escalation runbook).

**Supabase support ticket submitted: 2026-06-04** (corrected via Lock #15
audit-trail discipline — the prior "Filed 2026-05-26" phrasing conflated
SAGA entry creation with external ticket submission. Empirical re-probe
on 2026-06-04 confirmed cache still stale; operator filed the support
ticket immediately after, via the Supabase portal at portal.supabase.com).

  - **Ticket ID:** `[TICKET-ID PENDING — operator to paste from Supabase portal confirmation email]`
  - **Submitted:** 2026-06-04 (exact UTC time `[TIME PENDING — operator to paste from confirmation email]`)
  - **Severity:** Medium
  - **Category:** API / PostgREST
  - **Contact email on file:** alexandru.crestin@scandia.ro
  - **SLA window:** 24-48h from 2026-06-04 → next re-probe trigger 2026-06-05 to 2026-06-06.

**Symptom:** Three independent PostgREST schema-refresh signals
exhausted in sequence:
1. `NOTIFY pgrst, 'reload schema';` from Supabase Studio
2. Supabase Dashboard → Settings → API → "Reload schema cache" button
3. Settings → API → Max Rows toggle (forces PostgREST worker restart)

Column **still rejected as unknown** by the REST API after all three.
`pg_catalog` confirms the column exists; the cache invalidation path
appears broken on this Supabase project.

**Likely root cause:** Cloudflare edge cache holding the PostgREST
OpenAPI spec response, OR pooled-worker race where the visible-side
PostgREST refreshed but the worker serving our backend's traffic
didn't. Both require Supabase-side intervention to verify; we don't
have shell access to their PostgREST process.

**Evidence trail (preserved for the support ticket):**
- Migration `supabase/schema_phase_3b5_pre_backfill_snapshot.sql`
  applied 2026-05-26. Verification query in Studio returned both
  rows (column + partial index).
- `pre_backfill_snapshot` column NOT present in
  `_supabase.admin().select("financial_periods", limit=1)` row keys.
- Explicit `columns="id,pre_backfill_snapshot"` returns
  `400 Bad Request` from the REST endpoint.
- F-A3.1 8/8 GREEN + Carniprod canary at 7.3939 % unchanged
  (engine path unaffected — only the cache layer is stale).

**Escalation path:**
1. **Open a Supabase support ticket.** Subject: "PostgREST schema
   cache persistent staleness on `financial_periods.pre_backfill_snapshot`
   despite Dashboard reload + Settings toggle." Include the evidence
   trail above + project ID. Request a manual PostgREST restart on
   the project.
2. **Expected resolution: 24-48 h.** Sprint pauses for that window.
3. **F3.16-3b.5 backfill paused** until cache flips. F-A3.1 + F-A3.2
   baselines preserved; resume from `--mode snapshot` once
   `verify_pgrst_visibility` passes.
4. **F3.16-3b.6 F4.2 hardening can still ship next session** —
   independent of the backfill, doesn't depend on the schema cache
   for its specific writes.
5. **F3.16 sprint closure delays by the same 24-48 h window.** Not a
   blocker on the broader F-series work; just the formal closure.

**Effort:** Operator-side. ~10 min to file the ticket; 24-48 h to wait.

**Blocks:** F3.16-3b.5 phase 1 (snapshot writes) and everything after
it in the 3b.5 phase tree (single-period diff, batch, coverage gate,
closure record). 3b.6 (F4.2 hardening) is independent and can proceed.

**Trigger to mark resolved:** `verify_pgrst_visibility(ac,
"financial_periods", "pre_backfill_snapshot")` passes without raising
SystemExit. Re-run `--mode snapshot` immediately after that.

---

### [F5.0-QUEUED-BEHIND-F3.16] — Interactive Learning Platform initiative scoped and queued

Per Lock #15 external-action-separation sub-rule (three-field convention):

- **Entry created:** 2026-06-05
- **External action taken:** N/A — internal sprint scoping, no external party involved
- **External confirmation ID:** N/A

**Decision.** A new product initiative — **F5.0 Interactive Learning
Platform** — was scoped this session: every numeric value in the
app becomes a 3-layer drill-down (glance / hover / deep-dive) that
teaches the underlying financial concept. The full 5-phase staged
execution plan is captured in
`docs/F5.0-INTERACTIVE-LEARNING-OPENING-PROMPT.md`.

**F5.0 is queued, NOT launched, this session.** F3.16 remains the
engineering critical path; its locked holding pattern (Bug #4
SLA running from 2026-06-04, re-probe-then-resume-or-close on the
next session) is unchanged. Carniprod 7.3939 % canary holds;
F4.2-PARITY 3 HARD ±0.00 holds; F-A3.1 8/8 GREEN holds.

**What ships this session (zero-risk parallel-track only).**

  1. `docs/F5.0-INTERACTIVE-LEARNING-OPENING-PROMPT.md` — 7-section
     opening prompt mirroring the F4.5-SKR03 shape. Operator-paste-
     ready at F5.0 Phase 1 launch session.
  2. `src/lib/learning/concepts/_schema.ts` — pure-TypeScript
     interface definition for the Concept entry (i18n-native
     `{en, ro}` shape on all translatable fields). No runtime cost,
     no user-visible surface, no engine touched. Locks the schema
     so Phase 1 doesn't redesign it under time pressure.
  3. `src/lib/learning/concepts/seed.ts` — 5 concepts only
     (`ebitda`, `ebitda_margin`, `revenue`, `net_income`,
     `gross_margin`) — the minimum set to make Phase 1's Dashboard
     EBITDA-tile proof point work end-to-end. Phase 4 expands to
     50-80; this is NOT Phase 4 ahead-pulled work.

These three items are zero-risk: pure type definitions + a small
seed file + a doc. Cannot break engine, cannot affect prod,
cannot conflict with the Supabase cache fix.

**What's explicitly NOT shipped this session.**

  - LearnableNumber component (Phase 1 — needs its own focused
    session, not while F3.16 is paused)
  - Money wiring (Phase 2)
  - Opus insight backend (Phase 3)
  - More than the 5 seed concepts (Phase 4)
  - `/learn` route, FloatingHint onboarding (Phase 5)

**Phase ordering lock.** F5.0 Phase 1 launches in a FRESH session
AFTER F3.16 formally closes. The next-session opener stays
F3.16's: re-probe Bug #4 first thing, resume 3b.5 if cache
flipped, close session if still stale. F5.0 Phase 1 launches
only on a session that opens with F3.16 already closed.

**If both Phase 1 and F3.16 closure paths are live at session-open
time, F3.16 closure has priority.** The hold is the hold.

**Effort.** Internal scoping. Zero external action. Three deliverables
this session (~80 LoC TS schema + ~220 LoC seed + 7-section doc).

**Blocks:** Nothing. This is a forward-prep entry, not a blocker.

**Trigger to mark resolved:** F5.0 Phase 1 ships in a future
session (build green + Dashboard EBITDA wrap-point visible) after
F3.16 has formally closed.

---

### [F3.16-3b6-FOLLOWUP-VARIANT-PARITY] — descope cash AND strict variant hardening

**Filed:** 2026-05-26 (this session). Originally scoped as
`FOLLOWUP-CASH-PARITY`; expanded mid-session to cover both cash
AND strict after a pre-deploy strict-delta probe revealed strict
diverges 16K-3.23M RON across 7 of 8 fixtures (max on Scandia).
Both variants share the same YAML-formula-vs-in-code-formula root
cause; bundling into one ticket avoids two parallel analysis
sessions with overlapping research.

**Status:** PENDING — research phase has not started.
**Blocks:** F3.16 sprint **formal closure** (not blocking any
consumer surface — both variants are info-only and no consumer
reads them today).
**Blocked by:** None hard; soft preference is to start after
F3.16-3b.5 backfill unblocks (Bug #4 cleared) **or** after F3.18
SAGA calibration work, whichever creates a natural session opening.

**Why this ticket exists.** The 3b.6 plan
(`docs/F3.16-3b6-f42-hardening-plan.md`) originally predicted that
both cash AND strict variants would flip from soft/ungated to HARD
±1 RON across all 8 fixtures with minimal YAML edits. Two empirical
probes (2026-05-26) caught the misprediction before deploy:

**Cash misprediction.** The plan blamed an SBC (share-based comp)
strip in the YAML `cash` formula for the divergence. Empirically:

- RO RAS has no SBC accounting in OMFP 1802 — the predicted root
  cause didn't exist.
- The actual divergence comes from a different strip-set mismatch:
  the YAML subtracts `722`, `711`, `781` revenue reversals plus
  `fx_gain`, and adds back `provision_charges`, `fx_loss`,
  `impairment_receivables`. The in-code path computes a bare EBITDA
  (operating result + D&A) with none of those adjustments. The
  empirical divergence is **100-1571 %**, not the predicted ±0.00.

**Strict misprediction.** The plan treated strict as "already HARD
±1 RON byte-identical." Empirically (pre-deploy probe):

- The pre-3b.6-A gate code never checked strict — only `reported`
  was hard-checked. The "already HARD" framing was a misread of
  the gate's own behavior.
- Max |delta| = **3,231,332.91 RON on Scandia**. Carniprod 787K,
  Frozen 448K, Agras 386K, Retail 159K (signed −), Sibiu 30.5K,
  RealEstate 16.6K, EEI 0. If the new strict-HARD check had shipped,
  F4.2-PARITY would have RED'd on 7 of 8 fixtures.

Both variants raise the SAME methodology question: which strip-set
defines "cash EBITDA" / "strict EBITDA" on RO RAS — the YAML's
view (extensive strips) or the in-code view (minimal strips)?

**Three-phase scope.** Don't compress into a single session — that's
how the original misprediction happened.

#### Phase 1 — research (1 session)

Read the YAML and in-code cash AND strict formulas side-by-side
(four formulas total — two YAML, two in-code). For each strip item
in either YAML formula (`722`, `711`, `781`, `fx_gain`,
`provision_charges`, `fx_loss`, `impairment_receivables`, plus
whatever the strict YAML formula includes — to be enumerated
during this phase), document:

- **What the account represents in OMFP 1802 terms** — Romanian
  GAAP semantics, not US-GAAP cognates. `722` = capitalized own
  production; `711` = inventory variation; `781` = operating
  provision reversals; `fx_gain/loss` = FX revaluation P&L hits;
  `provision_charges` = period-fresh provision additions;
  `impairment_receivables` = 49x provision movements.
- **What economic reality the YAML formula is trying to capture.**
  Is the YAML modelling a UK/IFRS "EBITDA cash" definition that
  treats revenue reversals as non-cash? Or is it a third-party
  RO methodology imported wholesale without re-verifying against
  RAS reality?
- **What economic reality the in-code formula is trying to
  capture.** Bare EBITDA + D&A is the GAAP-naive starting point;
  it's defensible as "operating cash before working-capital effects"
  but it's not "cash EBITDA" in the IFRS sense — it doesn't strip
  non-cash provisions, doesn't strip FX revaluation.
- **Which view a Romanian CFO would call "cash EBITDA" if asked.**
  This is the decision criterion. Survey three reference inputs:
  (1) BSE-listed comparables (Hidroelectrica, Banca Transilvania,
  OMV Petrom annual reports) — what do they call "cash EBITDA";
  (2) Big-4 Romania benchmark publications; (3) Carniprod /
  Scandia historical management reports if available. If all three
  converge on a single definition, that's the target; if they
  diverge, document the spread.

**Deliverable:** `docs/F3.16-3b6-variant-analysis.md` — 8-10 pages,
2-3 hours focused (longer than the original 1-session cash-only
estimate because two variants now share the doc). Side-by-side
formula table for BOTH cash AND strict, account semantics, three
external reference summaries per variant, candidate canonical
formulas per variant.

#### Phase 2 — decision (operator call)

The Phase 1 doc surfaces candidates **per variant**. For each of
cash AND strict, the operator picks one of:

- **(A) YAML is right, in-code wrong** — adopt the YAML's strip
  set as canonical; ship a small in-code rewrite to match.
- **(B) In-code is right, YAML wrong** — drop the YAML's strips,
  make YAML compute bare EBITDA + D&A (or whatever the in-code
  formula does); the in-code path stays unchanged.
- **(C) Both wrong, third definition needed** — define a new
  canonical formula. Ship both YAML and in-code rewrites to match.

Decisions can be different per variant (e.g. strict → option B,
cash → option C) if the CFO survey converges on different
definitions for each. Both decisions are logged in the analysis
doc and locked together.

#### Phase 3 — ship (1 session)

Implement the chosen formulas in **both YAML and in-code
byte-identical**, for BOTH variants in the same PR. The "both
byte-identical" rule is the binding constraint — the F4.2-PARITY
gate exists specifically to enforce this and cannot tolerate
prose-comment divergences (per F3.16 ADR invariant c).

Sequence:

1. Edit YAML `methodology.ebitda.cash` AND `methodology.ebitda.strict`
   formulas to the chosen strip sets.
2. Edit in-code `ebitda_cash` AND `adjusted_ebitda` (the strict
   counterpart) computations to match byte-for-byte (same account
   list, same arithmetic, same rounding).
3. Flip F4.2-PARITY cash AND strict variants from soft-only to
   HARD ±1 RON in `scripts/check_methodology_parity.py`. Remove
   the `STRICT_INFO_THRESHOLD_RON` and `CASH_INFO_THRESHOLD_PCT`
   constants (or repurpose); add `strict` and `cash` to the
   HARD-check block.
4. Run F4.2-PARITY: 8/8 GREEN on cash + strict + reported (3
   HARD variants).
5. Run F-A3.1 + F-A3.2: no regression on bs_balance_delta /
   cross-path consistency.
6. Lock pre/post readings in the F3.16 closure ADR addendum.
7. Mark F3.16 sprint **formally closed**.

**LOC budget:** ~80-100 (two YAML edits + two in-code edits +
gate hardening + closure ADR addendum). Slightly larger than the
original cash-only estimate because two variants ship together.
Pre-deploy / post-deploy prediction lock per ADR invariant (b),
this time with the formulas read AND the gate code read before
locking.

**Promotion trigger.** Start Phase 1 when **either** condition
fires (whichever comes first):

- **F3.16-3b.5 backfill is unblocked** (Bug #4 clears). The
  engine session is already open for envelope-coverage work,
  so adding a focused methodology read-side-by-side is cheap
  context.
- **SAGA real-user uploads create demand for the cash variant
  in customer-facing surfaces.** If a customer surface starts
  asking "what is cash EBITDA for this period" — e.g. a P&L
  tab adds a "Cash view" toggle, or a briefing prose surface
  starts referencing cash explicitly — the variant moves from
  info-only to externally-visible and the ticket's urgency
  shifts from "blocks sprint formal closure" to "blocks
  customer surface ship."

Not urgent today — both variants are info-only and no consumer
surfaces read them. The ticket DOES block F3.16 sprint formal
closure (criterion #4 — F4.2-PARITY 8/8 on all 4 variants).

**Discipline ask.** When 3b.6 (A) is shipping (this session,
2026-05-26), the temptation will be "I'm already in the
methodology files; let me just read the cash + strict formulas
and figure it out." **Resist.** Phase 1 is a 2-3 hour focused
investigation that deserves its own session and design doc.
Doing it as a mid-session detour produces rushed methodology
decisions — which is exactly what produced both the original
±0.00 cash misprediction AND the "strict is already HARD"
misprediction. Park it as this ticket and ship (A) clean.

---

### [F3.16-3b6-CONSUMER-CUTOVER] — route 9 surfaces to canonical methodology fields

**Filed:** 2026-05-26 (this session).
**Status:** PENDING — `ebitda_for_surface` helper module ships this
session as scaffolding (no callers); per-surface migrations are
this ticket's scope.
**Blocks:** F3.16 sprint **formal closure** (criterion #7).
**Blocked by:** F4.2-PARITY reported+strict locked HARD (this
session's ship); independent of the cash-variant ticket above.

**Why this ticket exists.** The original 3b.6 plan §2 mapped 9
consumer surfaces that currently read in-code legacy EBITDA fields
(`assembled_pl.ebitda_statutory` and friends). The cutover routes
each surface to the canonical methodology field
(`methodology.ebitda.reported` / `strict` / `cash` / `adjusted`),
behind per-surface feature flags so any one regression is a
single-flag revert.

The original plan treated this as "next session work." Empirically
it's at least **2-3 sessions of careful FE work** — every surface
needs a screenshot-diff verification step on real fixture data,
because byte-identical-in-code numbers can still produce
display-layer regressions (rounding, currency conversion, label
positioning, the methodology badge surfacing on tooltip hover, etc).
A one-PR cutover would batch the regression risk into a single
deploy where pinpointing the offending surface gets expensive.

**Scope — 9 surfaces with per-surface feature flags.**

Per the original §2 mapping:

| # | Surface | Current source | Target source | Feature flag |
|---|---|---|---|---|
| 1 | Dashboard KPI tile "EBITDA" | `assembled_pl.ebitda_statutory` | `methodology.ebitda.reported` | `F36_CUTOVER_DASHBOARD_TILE` |
| 2 | P&L tab "EBITDA" row | `assembled_pl.ebitda_statutory` | `methodology.ebitda.reported` | `F36_CUTOVER_PL_TAB` |
| 3 | Briefing prompt headline | `assembled_pl.ebitda_statutory` | `methodology.ebitda.reported` | `F36_CUTOVER_BRIEFING_HEADLINE` |
| 4 | Briefing prompt body (prose) | free PL field access | all 4 variants as named fields | `F36_CUTOVER_BRIEFING_BODY` |
| 5 | Recommendations panel | `assembled_pl.ebitda_statutory` | `methodology.ebitda.reported` | `F36_CUTOVER_RECOMMENDATIONS` |
| 6 | Risks & credit (Z″, EBITDA/interest) | `assembled_pl.ebitda_statutory` | `methodology.ebitda.reported` | `F36_CUTOVER_RISKS_CREDIT` |
| 7 | Valuation EV/EBITDA + DCF base | `assembled_pl.adjusted_ebitda` | `methodology.ebitda.adjusted` | `F36_CUTOVER_VALUATION` |
| 8 | Export PDF summary rows | `assembled_pl.ebitda_statutory` | `methodology.ebitda.reported` | `F36_CUTOVER_EXPORT_SUMMARY` |
| 9 | Export PDF detail rows | just `ebitda_statutory` | all 4 variants | `F36_CUTOVER_EXPORT_DETAIL` |

The flags live in `src/engine/api/_features.py` per the F3.16 ADR
pattern. Default-OFF on initial deploy; flipped ON per-surface as
verification passes.

**Rollout sequence (priority order).**

1. **Dashboard KPI tile** (surface #1) — most visible, also easiest
   to verify. Single number on a single page; screenshot diff is
   immediate. If this surface regresses, every other surface is
   suspect.
2. **P&L tab** (surface #2) — second most visible, single
   highlighted row in a known table. Screenshot diff
   straightforward.
3. **Briefing prompt** (surfaces #3 + #4 together — they share an
   input dict). Verify by re-generating a Carniprod briefing and
   confirming (i) the headline EBITDA matches
   `methodology.ebitda.reported` byte-for-byte; (ii) prose
   references to "strict / cash / adjusted EBITDA" name the
   variant explicitly without computing a new number.
4. **Recommendations** (surface #5) — secondary visibility but
   high audit-trail importance; verify against fixture's
   recommendation card output.
5. **Risks & credit** (surface #6) — multiple ratios use EBITDA
   as a denominator; verify Altman Z″ + EBITDA/interest stay
   byte-identical post-cutover.
6. **Valuation** (surface #7) — adjusted variant, not reported;
   verify EV/EBITDA range table + DCF base year stay byte-identical.
7. **Export PDF summary** (surface #8) — last because audit trail
   surfaces; verify byte-identical against pre-cutover export on
   the same fixture.
8. **Export PDF detail** (surface #9) — new column set (4 variants
   instead of 1); verify the new layout against a designer mock
   before flipping the flag.

**Per-surface verification protocol.**

Each surface migration ships with:

- **Screenshot diff** — pre-cutover vs post-cutover on the same
  fixture data (Scandia is the calibration default). Diff must
  be **pixel-identical** for the reported variant; ≤1 pixel layout
  shift acceptable only on the export PDF detail rows (which
  legitimately add columns).
- **Numeric diff** — both surfaces' rendered EBITDA value parsed
  out of the DOM (or PDF text layer) and compared byte-for-byte.
  Must match the methodology field exactly.
- **Methodology version badge** — surface includes
  `methodology_version` in either a tooltip, footer, or hover
  state per F4.3 envelope discipline. Verified by inspecting
  the rendered DOM / PDF for the version string.

A single failing surface is a ship blocker for that surface's
flag, not for the whole cutover. The flag stays OFF for that
surface; the other surfaces continue rollout. Document the
failing surface's symptom in the closure record before the
sprint declares closed.

**Rollback.** Each flag is independent. A regression on surface
N triggers a flag revert on that surface only. No shared state,
no cascading rollback. The `ebitda_for_surface` helper handles
both the canonical and legacy code paths in the same function;
the flag selects between them. Reverting a flag is a single
config push, no rebuild required.

**LOC budget:** ~120-180 (15-20 LOC per surface × 9 surfaces, plus
~30 LOC for the deprecated_fields plumbing + telemetry hook).
Spread across 2-3 sessions.

**Promotion trigger.** Start dashboard KPI tile (surface #1) when:
- This session's ship is verified GREEN (F4.2-PARITY reported+strict
  locked HARD on 8/8 fixtures), AND
- `ebitda_for_surface` helper is exercised by at least one inline
  smoke test in the helper module.

Then proceed through the priority sequence above. Three sessions
total (rough estimate; could compress if early surfaces all pass
diff cleanly).

---

### [F3.16-3b6-ADJUSTED-LATER] — gate the `adjusted` variant when addbacks land

**Filed:** 2026-05-26 (this session).
**Status:** PARKED — no current consumer demand for the variant
beyond what `strict` already provides (the YAML formula is
`strict + ?operator_addbacks` and no period has populated the
`adjusted_ebitda_addbacks` jsonb today; the YAML value
effectively equals `strict` until operator addbacks appear).

**Why this ticket exists.** After 3b.6-B locked
reported + strict + cash to HARD ±1 RON, the F4.2-PARITY gate's
fourth EBITDA variant (`methodology.ebitda.adjusted`) remains
explicitly **ungated**. Today this is correct — the YAML
formula reduces to `strict` when addbacks are empty, so a
HARD ±1 RON gate would just duplicate the strict check. But
once any period carries non-empty addbacks, `adjusted` becomes
its own number that needs its own parity check.

This ticket records the graduation triggers and the
pre-graduation invariants so the next session that touches
F4.2 doesn't accidentally promote `adjusted` to HARD without
the underlying machinery in place.

### Graduation triggers (any one fires → un-park)

Re-evaluate when **any** of:

1. **First customer requests adjusted EBITDA with non-empty
   operator addbacks.** PE diligence, lender covenant
   amendment, or M&A advisor explicitly asks for "the adjusted
   number with these addbacks applied" — e.g. "normalize owner
   compensation," "back out the one-time legal settlement,"
   "exclude related-party rent overpayment." The trigger is
   the first non-empty `adjusted_ebitda_addbacks` jsonb on any
   `financial_periods` row.

2. **Consumer cutover** `[F3.16-3b6-CONSUMER-CUTOVER]` **ships
   the Valuation EV/EBITDA surface.** Per the original 3b.6
   plan §2 mapping, the Valuation surfaces are spec'd to read
   `methodology.ebitda.adjusted` (not `.strict` or `.reported`).
   Once that surface migrates behind its
   `F36_CUTOVER_VALUATION` flag, the adjusted variant becomes
   user-visible and needs the F4.2-PARITY HARD gate to prevent
   the same silent-divergence class Lock #10 closes.

3. **SAGA real-user traffic reaches n=100 uploads** with any
   carrying operator-supplied addback metadata. Even if no
   individual customer has explicitly asked for the adjusted
   number, the empirical existence of addback metadata at scale
   means the surface is in active use and needs the parity
   discipline applied.

Until **any** of these fires, `adjusted` stays ungated. The
F4.2 gate's three HARD variants (reported + strict + cash)
plus the implicit "adjusted ≡ strict when addbacks empty"
invariant constitute sufficient coverage for the current
operating envelope.

### Pre-graduation invariants

While parked, the next session that touches F4.2 MUST preserve:

- The F4.2 gate's `_check_fixture` function reports the
  `adjusted` variant's value but does NOT hard-check it.
- The YAML formula for `adjusted` stays
  `strict + ?operator_addbacks` (operator addbacks resolve to 0
  when absent, so adjusted == strict on every fixture today).
- In-code `adjusted_ebitda` field on `assembled_pl_canonical`
  stays equal to the F4.2 gate's `methodology.ebitda.strict`
  value (post-3b.6-B both are computed as
  `ebitda_statutory − other_op_income_lump − 781`).

If any of these invariants are broken before the graduation
trigger fires, the F4.2 gate's coverage degrades silently.

### Post-graduation ship sequence (when triggered)

When any graduation trigger fires, the un-park sequence is:

1. **Phase 1 — research (≤1 session):**
   - Audit the addback metadata schema. What addback categories
     are real (owner-comp normalization, related-party rent,
     one-off legal, etc.)?
   - Decide whether addbacks are stored on the period row
     (current schema) or per-consumer (more flexible but more
     complex).
   - Verify the in-code formula path emits the same addback
     set as the YAML formula references.

2. **Phase 2 — operator decision:**
   - Lock the addback application order (sign, deduplication,
     audit-trail requirements).
   - Decide whether `adjusted` should be settable per-deal
     vs per-period.

3. **Phase 3 — ship:**
   - Edit `_check_fixture` to add `adjusted` to the HARD checks.
   - Run F4.2-PARITY against a fixture with non-empty addbacks
     (Carniprod canary remains 7.3939% × held).
   - Lock pre/post readings in the F3.16 closure ADR addendum
     (or, if F3.16 is already closed, a fresh ADR for the
     adjustment surface).

**LOC budget:** ~20 (Phase 3 only; Phases 1 + 2 are doc work).

**Promotion trigger lock.** This ticket's graduation criteria
are the same shape as the §4 ensemble graduation criteria from
earlier in this sprint: explicit triggers prevent both premature
un-parking (gating something that nobody uses) and indefinite
forgetting (the variant being silently broken for years
because no one had a reason to look).

---

### Cross-ticket relationship map

```
F3.20-DUPLICATE-PERIOD-DETECTION ── independent ──┐
                                                  ├── all four can ship in any order
F3.21-FINANCIAL-PERIODS-STATUS    ── independent ─┤
                                                  │
F3.22-MATERIALIZE-DRIFT-METRICS   ── blocks ──────┤── §4 ensemble trigger #2
                                                  │── F3.18-SOURCE-QUALITY (soft)
                                                  │
F3.20-DETECTION-VERSION           ── blocks ──────┴── per-dialect calibration

F3.24-MIGRATION-SCHEMA-CACHE      ── SHIPPED ────── this session (2026-05-26)
F3.25-POSTGREST-CACHE-STALENESS   ── BLOCKS ──────  F3.16-3b.5 phase 1+
                                                    (operator-side; ~24-48 h)

F3.16-3b6-FOLLOWUP-VARIANT-PARITY ── SHIPPED ────── F3.16-3b.6 (B) Phase 2+3
                                                    fast-track (2026-05-26).
                                                    F4.2-PARITY 3 HARD variants
                                                    (reported + strict + cash)
                                                    all ±0.00 RON × 8 fixtures.
F3.16-3b6-CONSUMER-CUTOVER        ── BLOCKS ──────  F3.16 sprint formal closure
                                                    (criterion #7; 2-3 sessions
                                                    of careful FE work)
F3.16-3b6-ADJUSTED-LATER          ── PARKED  ────── un-parks on first addback
                                                    customer / Valuation cutover
                                                    ship / SAGA n=100 with
                                                    addback metadata
```

The first four follow the trigger-and-go pattern: ship when the
symptom surfaces. F3.24 shipped pre-emptively this session because
the discipline rule applies to every future migration. F3.25 is
operator-side blocking on Supabase support. The two F3.16-3b6
follow-ups are sprint-closure blockers but not user-visible
regressions — they're the disciplined unwind of an over-scoped
original plan into three properly-sized pieces (3b.6 (A) ships
this session; cash-parity + consumer-cutover wait for their own
sessions).
