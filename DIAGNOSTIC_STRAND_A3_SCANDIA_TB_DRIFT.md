# Diagnostic — Strand A.3: Scandia TB-path Equity Drift Root Cause

> **Read-only diagnostic. NO code changes were made.** Same shape as Strands A.1 + A.2.
> Closes the verification hole identified in [CLOSURE_STRAND_A2_PRIME_DE_CAPITAL.md](CLOSURE_STRAND_A2_PRIME_DE_CAPITAL.md) — namely: A.2 fixed the F30/F10 statutory path, but Scandia is TB-path and its drift was unexplained by A.2 alone.
> Scoped per the user's directive: probe hypothesis (i) — detector misrouting; probe hypothesis (ii) — FE rendering drops `otherEquity`. Then state which it is + minimal fix surface.

---

## Headline conclusion

**Neither (i) nor (ii) as originally framed.** The Scandia drift documented in the spec doc (RON 47,193,087) is **pre-foundation-fix**. Two of the foundation commits that landed in `7cab09e` already closed the bulk of it:

- **H2 (account 168 routing)** alone closed **75-86% of the equity gap** per [CLOSURE_H2_ACCT_168_INTEREST.md](CLOSURE_H2_ACCT_168_INTEREST.md) header.
- **C2 (SAGA 6-col BS parser collapse)** restructured the entire BS for any 6-col Layout B Scandia upload per [CLOSURE_C2_SAGA_6COL_BS.md](CLOSURE_C2_SAGA_6COL_BS.md).

The 41.65M "merger premium delta" hypothesis in Strand A.1 was a **possible explanation** the diagnostic listed; the actual gap was not measured against the post-H2/post-C2 engine. **The honest current state is: we don't know how much Scandia drift remains, because it hasn't been measured against the current engine.** Phase 0's BS-correctness gate is therefore not in fact "do the A.3 fix" — it's **"measure the current drift."**

---

## Probe (i) — Document-type detector misrouting

**Verdict: mechanically excluded by source-inspection. No code path can route Scandia's 8-col Crystal Reports to the statutory parser.**

Trace: [`_document_type_detector.py:200-292`](src/engine/api/_document_type_detector.py#L200).

Decision logic:
```python
is_statutory = (
    f30_hits >= 3
    or (f30_hits >= 2 and f10_hits >= 2)
    or (f30_hits >= 2 and statutory_sheet)
)
is_trial_balance = tb_hits >= 2

if is_trial_balance:
    return "trial_balance", ...
if is_statutory:
    return "statutory_f30_f10", ...
return "trial_balance", ...   # default on ambiguity
```

Three independent reasons Scandia cannot land on `statutory_f30_f10`:

1. **Trial-balance wins on tie.** Even if F30 anchors fire, the `is_trial_balance` branch returns first. A Crystal Reports 8-col balanță has at minimum `"Sold inițial"`, `"Rulaj debit"`, `"Sold final"` in its header → 3+ TB anchors. TB always wins.
2. **Crystal Reports has no F30 anchors.** The F30 anchor list (`CONTUL DE PROFIT ȘI PIERDERE`, `Cifra de afaceri net`, `Producția vândută`, etc.) are statutory-form labels. A trial-balance export has account codes + names like "ct 411 Clienți", not regulatory line titles. `f30_hits = 0` is expected.
3. **The default on ambiguity is `trial_balance`** ([_document_type_detector.py:288-292](src/engine/api/_document_type_detector.py#L288)). Even in the impossible "no anchors anywhere" case, statutory routing requires positive evidence.

**Hypothesis (i) is ruled out by code structure, not just by likelihood.** No further investigation needed; this branch closes here.

---

## Probe (ii) — FE rendering layer drops `otherEquity`

**Verdict: the FE rendering surfaces I traced all correctly include 104 in their equity sum. The "rendering drops otherEquity" hypothesis is not supported by the rendering paths.**

### II.a — `buildBsStatement.ts` (the BS tab on every period)

[buildBsStatement.ts:391-426](scandi-desk-main/src/lib/buildBsStatement.ts#L391) explicitly emits:

```typescript
const premium104 = both("104");
// ...
const equityLines: BSLine[] = [
  { accountCode: "1012", label: "Share capital", ... },
  { accountCode: "104",  label: "Share premium / merger premium", opening: premium104.opening, closing: premium104.closing, style: "item" },
  { accountCode: "105",  label: "Revaluation reserves", ... },
  { accountCode: "1061", label: "Legal reserves", ... },
  { accountCode: "1068", label: "Other reserves", ... },
  { accountCode: "117",  label: "Retained earnings", ... },
  { accountCode: "121",  label: "Current year net profit", ... },
];
const totalEquityClosing = equityLines.reduce((s, l) => s + (l.closing ?? 0), 0);
```

The comment at line 391-396 specifically calls out: *"Pre-fix this section was missing 104 (share premium / merger premium) and 1068 (other reserves), and 117 was only picking up 1171 — leaving 1174 (debit-side retained-earnings adjustments) out. On Scandia those three lines combined add ~50M to total equity, closing most of the previously-reported balance-sheet drift."*

**That is, the BS tab's equity rendering already includes 104 — a previous fix at this exact path attempted to close the drift.** The comment claims it closed "most of" the drift.

### II.b — `ComprehensiveReport.tsx` BsTable

[ComprehensiveReport.tsx:594-599](scandi-desk-main/src/pages/cfo/ComprehensiveReport.tsx#L594):

```typescript
["Share capital", bs.share_capital],
["Reserves & retained earnings",
  (bs.revaluation_reserves ?? 0)        // 105
  + (bs.retained_earnings ?? 0)         // 117 family
  + (bs.other_equity_non_revaluation ?? 0)],  // 104 + 106 + 1061 + 1068
["Current-year P&L", bs.current_year_pnl ?? 0],
```

The engine's canonical view at [`_ro_coa.py:740-745`](src/engine/api/_ro_coa.py#L740) defines:
```python
"revaluation_reserves":           sub_agg["equity_revaluation"],          # 105 only
"retained_earnings":              sub_agg["retained_earnings"],            # 117 family only
"other_equity_non_revaluation":   bs["otherEquity"] - sub_agg["equity_revaluation"]  # = (104+105+106) - 105 = 104+106
```

Algebra check: 1012 + 105 + 117 + (104 + 106) + 121 = full equity. The sum is correct.

### II.c — `deriveTotals` legacy recompute (Tier-1 surface in the audit)

[financialReport.ts:163](scandi-desk-main/src/lib/financialReport.ts#L163):
```typescript
const totalEquity = bs.shareCapital + bs.retainedEarnings + bs.otherEquity;
```

`bs.otherEquity` here is the legacy aggregated field. To trace its value:
- Engine [`_ro_coa.py:451-452`](src/engine/api/_ro_coa.py#L451): both `"otherEquity": "otherEquity"` and `"equity_revaluation": "otherEquity"` roll up to top-level `bs["otherEquity"]`.
- So engine-side `bs["otherEquity"]` = 104 + 105 + 106 + 1061 + 1068 + …  (every account that mapped to either the `otherEquity` or `equity_revaluation` sub-bucket).
- The FE Statements builder reads this directly. `s.balanceSheet.otherEquity` carries the same value.

**`deriveTotals` therefore also sums 104 correctly.** The Audit's Tier-1 concern is real (parallel arithmetic) but does not in this specific case drop a component.

### II.d — `CreditScoreCard.tsx`, `KpiCard.tsx`, `EbitdaReconciliationPanel.tsx`

- `CreditScoreCard.tsx` reads `metrics.altman_x4` and `metrics.credit_subscore_equity` from `calculated_metrics` — engine-emitted. The X4 sub-score uses engine-side `total_equity`, which includes the `otherEquity` bucket. **No FE recompute of equity here.**
- `KpiCard.tsx` and `EbitdaReconciliationPanel.tsx` were searched for `equity`/`shareCapital`/`otherEquity` references — neither rendered an equity component. They render EBITDA, multiples, and bridge math.

### II.e — Hypothesis (ii) verdict

**No rendering surface I audited drops `otherEquity` or its components.** All three equity-rendering paths (BS tab, ComprehensiveReport, deriveTotals legacy) include 104. The "headline equity card" mentioned hypothetically in Strand A.1 — a single tile that might drop otherEquity — does not exist in the FE surfaces I traced.

**This is not the same FE-recompute pattern catalogued in the audit.** The audit identified parallel arithmetic that *could* diverge from canonical. Here, the parallel arithmetic produces the *same* total. The pattern is present, but its specific instance for equity does not produce a drift.

---

## What I actually found — the third hypothesis

**The 47.19M drift number in the roadmap document is pre-foundation-fix.** Multiple closures that landed afterward already addressed the largest contributors:

| Closure | What it fixed | Magnitude on Scandia |
|---|---|---|
| **H2** ([CLOSURE_H2_ACCT_168_INTEREST.md](CLOSURE_H2_ACCT_168_INTEREST.md)) | Account 168 was misrouted to P&L `interestExpense`, double-counting ~RON 1.67M of interest. Net income and equity closed **75–86% of the pre-fix gap**. | RON ~1.4M direct + cascade through retainedEarnings → total_equity |
| **C2** ([CLOSURE_C2_SAGA_6COL_BS.md](CLOSURE_C2_SAGA_6COL_BS.md)) | SAGA 6-col layout had no `final_*` columns → BS collapsed to near-empty. Now synthesizes from `(si + r)`. Crystal Reports 8-col (Scandia) unchanged. | Layout-dependent — irrelevant if Scandia uploads as 8-col; large impact if uploaded as 6-col |
| **A.2** ([CLOSURE_STRAND_A2_PRIME_DE_CAPITAL.md](CLOSURE_STRAND_A2_PRIME_DE_CAPITAL.md)) | 104 on statutory F30/F10 path — does not move Scandia, but closes the gap for any future statutory-path entity | 0 on Scandia (TB path) |

**The diagnostic was written alongside these closures** (same `3236f4a` docs commit). Its drift quantification was the pre-fix snapshot used to motivate the closures, **not** a measurement against the post-fix engine.

A previous fix at [buildBsStatement.ts:391-396](scandi-desk-main/src/lib/buildBsStatement.ts#L391) — the inline comment — also explicitly claims it "[closes] most of the previously-reported balance-sheet drift" by adding 104, 1068, and the 117 family root to the equity sum. That fix is independent of H2/C2 and lives on the FE side.

So between H2, C2 (for 6-col uploads), the buildBsStatement equity fix, and the canonical-metrics work, **substantial drift has already been closed.** What remains is unknown, because no one has measured Scandia's drift against the current engine.

---

## What the actual minimal fix surface is

**Phase 0's BS-correctness gate is currently a measurement problem, not a fix problem.** Until Scandia's post-foundation drift is measured end-to-end, naming "the fix" is premature.

### F-A3.1 — Measure Scandia and EEI drift against the current engine

Acquire the Scandia FY2025 fixture (the 8-col Crystal Reports) and the EEI Dec 2025 fixture (already in `e2e/fixtures/ground-truth/ro_eei_dec_2025/expected_extraction.json` for the TB shape). Run each through:
- `_trial_balance_parser.parse_trial_balance_df` → assemble shape
- `_ro_coa.assemble_statements` → produces `assembled_bs_canonical`
- Print: `total_assets`, `total_liabilities`, `total_equity`, `bs_balance_delta`
- Compare against the source TB's `sum_debit == sum_credit == 0` ledger reconciliation

Acceptance: `bs_balance_delta` within ±0.5% of total_assets for both fixtures. If GREEN: Phase 0 BS-correctness gate is closed; F1 can begin. If RED: the residual gap has a measured magnitude and we can target it.

### F-A3.2 — Conditional on F-A3.1 RED: targeted fix

Only after F-A3.1 returns a real residual number do we know what to fix. The possibilities:
- **Mapper miss on a non-104 account** (e.g. a 5-digit equity sub-account not covered by the prefix rules). Inspect mapping rules for any equity-class account in the actual Scandia TB that doesn't have a `MappingRule` covering its prefix.
- **Sign-flip on a debit-balance equity account** (e.g. 1174 on a contra-balance). [_trial_balance_parser.py:625](src/engine/api/_trial_balance_parser.py#L625) side-flips 1687 already; check if other equity sub-accounts need the same treatment.
- **Aggregation of a non-equity bucket that should be equity** (e.g. an account that maps to `provisions` or `otherCurrentLiab` but is actually equity).
- **A genuinely unidentified bug** — possible, but unlikely given how many eyes have been on this code path.

### F-A3.3 — The audit's "FE recompute pattern" stays open as a separate concern

The Audit ([AUDIT_FE_CANONICAL_CONFORMANCE.md](AUDIT_FE_CANONICAL_CONFORMANCE.md)) catalogued 9 Tier-1 FE recompute sites. **The Scandia drift does not collapse into that pattern** — the recompute sites I audited for equity produce the correct total. The Audit's F2–F7 sequence remains valid for the broader correctness goal (single source of truth, no FE arithmetic), but it does not subsume Strand A.3.

---

## Honest answer to the question asked

> *"Is the drift in the detector (i), the FE rendering (ii), or unexplained engine — and the minimal fix surface for whichever it is. If it is (ii), state explicitly whether it is the same FE-recompute pattern the canonical-conformance audit catalogued, because then it folds into F2–F7."*

**Neither (i) nor (ii) as catalogued.** The drift the user is asking about appears to be substantially closed already by the foundation commits in `7cab09e`. The Audit's FE-recompute pattern exists and is worth fixing on its own merits, but it is not the cause of the historical Scandia 47.19M drift number.

The minimal fix surface for Phase 0's BS-correctness gate is therefore:

1. **F-A3.1 — Measure the current Scandia + EEI drift** against the post-foundation engine. This is mechanical, ~1 hour, requires the actual source files (Scandia 8-col TB + EEI Dec 2025 TB).
2. **If F-A3.1 RED**: open F-A3.2 with a targeted fix against the measured residual.
3. **If F-A3.1 GREEN**: Phase 0 BS-correctness is closed. F1 implementation against [SPEC_F1_ENGINE_CANONICAL_CONTRACT.md](SPEC_F1_ENGINE_CANONICAL_CONTRACT.md) can begin.

---

## What this diagnostic does NOT do

- Does not run Scandia or EEI through the live engine. The probe requires the actual source files (Crystal Reports `.xls`, EEI Dec 2025 TB) and the engine running with its full dependency tree — not available in the local Python environment used for this audit.
- Does not fabricate a residual number. Specifically: I did not estimate "what's left after H2 + C2 + buildBsStatement fix." Estimating residuals from closure header percentages and adding them up would be inventing a number with a confident face — the same failure mode the project is trying to eliminate.
- Does not retire the Audit's F2–F7 fix sequence. The FE-recompute pattern is real architecture debt independent of this specific drift.

---

## Sequenced summary

| Item | State |
|---|---|
| Hypothesis (i): detector misrouting | ❌ ruled out by source-inspection of [`_document_type_detector.py:200-292`](src/engine/api/_document_type_detector.py#L200) |
| Hypothesis (ii): FE rendering drops otherEquity | ❌ not supported by the equity-rendering surfaces I traced (buildBsStatement, ComprehensiveReport, deriveTotals all include 104) |
| Drift quantification (47.19M Scandia) | ⚠️ pre-foundation-fix; not current |
| H2 closed ~75–86% of equity gap | ✅ per closure header |
| C2 closed BS collapse for SAGA 6-col uploads | ✅ per closure header |
| buildBsStatement equity fix (per its comment) "closes most of the previously-reported drift" | ✅ per code comment |
| A.2 closes the F30/F10 statutory path | ✅ (this commit, source-inspection GREEN) |
| Current residual drift on Scandia | ❓ **unmeasured** — F-A3.1 owns this |
| F1 implementation | 🟡 blocked pending F-A3.1 measurement |

---

*Status: A.3 read-only diagnostic complete. The Scandia drift the roadmap describes is substantially closed by the foundation commits; what remains is unmeasured. The minimal fix surface for Phase 0 BS-correctness is F-A3.1 (measure), not F-A3.2 (fix). F1 implementation should not start until F-A3.1 produces a current measurement and either passes the BS-balance tolerance or names a targeted residual.*
