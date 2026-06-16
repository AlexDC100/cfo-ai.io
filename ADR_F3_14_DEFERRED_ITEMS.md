# ADR — F3.14: Three deferred items closed as designed-correctly

> **Status:** Accepted, 2026-05-23
> **Context:** Three open items from the F3.13 calibration sprint were
> investigated and closed without engine source changes. This ADR
> records the investigation, the design rationale, and the conditions
> under which each decision should be revisited. The goal: prevent
> a future debugging session from re-litigating these questions.

---

## ADR-1 — EEI PDF (and other Claude-path uploads) carry no F3.11 source-quality telemetry, BY DESIGN

**What was investigated.** Operator noted that the F3.11 amber WARN
banner (which surfaces raw closing-side imbalance from a trial balance's
`sf_d` vs `sf_c`) was absent on EEI's two periods. The EEI PDFs go
through the financial-statements parser (`financial_statements.parse_document`,
which calls Claude) rather than the deterministic PDF trial-balance
parser (`pdf_ingester.parse_pdf_trial_balance`). The Claude-extracted
accounts arrive as `{code, name, amount}` only — the raw `sf_d`/`sf_c`
fields don't exist on this path because Claude is normalizing as it
extracts.

**Why it's correct.** F3.11 telemetry is RAS-trial-balance specific: it
compares the file's literal closing-debit and closing-credit column
sums to detect source-data quality issues BEFORE engine routing. For
Claude-extracted files, there is no "raw debit vs raw credit" concept —
the LLM produced the amounts. The semantically-equivalent integrity
check for those files is the engine BS reconciliation
(`assembled_bs.bs_balance_delta / total_assets`), which IS computed
and surfaced via the existing "BS does not balance" recommendation
when drift exceeds 0.5%. So integrity coverage is complete; the F3.11
banner is just one of two equivalent signals, not the only one. EEI
specifically reconciles cleanly (0.00% drift), so neither the F3.11
banner nor the BS-reconciliation rec is needed.

**What would change the answer.** If we ever modify the Claude prompt
to extract `closing_debit`/`closing_credit` columns explicitly (currently
it only extracts `amount`), then `compute_source_imbalance` would be
applicable to Claude-path files too and the banner could light up.
Until that prompt change happens, leave this alone. The B1 work bundled
with this ADR adds a tooltip on Claude-path analyses pointing users
to the BS-reconciliation rec, so the absence is no longer mysterious.

---

## ADR-2 — RealEstate land (account 211) belongs in the PPE bucket, not segregated, per RAS

**What was investigated.** Operator's calibration toolkit's RealEstate
HTML report shows `Imobilizări corporale (net)` = 1.45M and lists
`Terenuri` separately at 10.9M. The engine routes 211 (terenuri) to
the `ppe` bucket, producing `ppe_net ≈ 6.6M` (211 land + 212 buildings
+ 213 equipment + 214 furniture, less 281 amortization). Operator
flagged this as a possible methodological gap.

**Why it's correct.** OMFP 1802 (Romanian accounting standard) classifies
land as a tangible fixed asset (`imobilizare corporală`). The standard
Romanian balance sheet groups land WITH buildings and equipment under
"Imobilizări corporale" — the toolkit's separation into a stand-alone
"Terenuri" row is a presentation/readability choice for developer-focused
reports, not an accounting truth. The engine's routing matches the
statutory grouping AND matches every other Romanian company analysis
in our 8-fixture regression registry (Scandia Food, Frozen, Carniprod,
Agras all route 211 into ppe with no operator complaints — RealEstate
is the first developer-heavy entity where the land share is
proportionally large enough that the toolkit's display choice felt
notable).

**What would change the answer.** Bring on a second developer/real-estate
fixture (a holding company with multiple land plots, for example), AND
operator-requested a display rule that shows "Land" as a stand-alone
row inside the PPE section, AND that rule shows up in actual decision
reports as a recurring read. The B2 work bundled with this ADR
delivers that display split: PPE total stays 6.6M (no downstream
breakage), but the BS table renders "Land" and "Buildings, plant &
equipment" as sub-rows inside the PPE block. If a stronger industry-
specific need emerges (e.g., developers want NAV computed against land
at market value, separately from depreciable PPE at book), the right
move is an industry-aware bucket inside the canonical schema, not a
generic engine flip.

---

## ADR-3 — Trading_analysis (and similar non-TB workbooks) are not auto-detected as SKU files; routing relies on upload-time scope tagging

**What was investigated.** Operator's `Trading_analysis_YTDMar'26.xlsx`
was uploaded with `scope="financial"` and routed through the
trial-balance pipeline (extract → map → persist → compute), which
produced all-zero metrics because the file is an SKU/sales-trading
worksheet without a balance-sheet structure. The period appears on
the dashboard listings but renders empty.

**Why it's correct.** The current upload classifier uses the
`scope` field set at upload time (Products page → `scope="sku"`,
Dashboard → `scope="financial"`). Adding a content-based detector
that reads inside the XLSX to recognize SKU schemas vs trial-balance
schemas before pipeline routing is a substantive engineering project
(needs robust pattern detection across SAGA / WinMENTOR / generic
Excel + the operator's own non-standard formats). Without that
investment, the right fallback is to TRUST the upload route the
operator chose — and if it produced no useful financial output,
hide the period and prompt re-upload through the correct flow.
The Item 2 work bundled with this ADR makes the dashboard skip
all-zero financial periods (with an operator note) so the dead row
no longer pollutes the period picker.

**What would change the answer.** Either (1) the operator starts
uploading SKU files through the Dashboard flow regularly (frequency
above ~1 per month would justify content-based detection), OR
(2) we extend the file-type detector with cheap heuristics
(e.g., absence of class-1 accounts, presence of "category"/"brand"/
"channel" column headers) to auto-suggest re-routing at upload time
before the heavy pipeline kicks in. Until either trigger fires, the
upload-time scope tag is the source of truth and the FE just needs
to handle the "wrong scope, empty output" case gracefully.

---

## Discipline note

These three items were closed without engine source changes. The B1
FE tooltip (delivered) makes ADR-1 visible to operators viewing
Claude-extracted analyses. ADR-2 turns out to already be served by
the existing `buildBsStatement.ts` Land row (lines 252-258) — the
toolkit-vs-engine "PPE delta" was a bucket-aggregate naming issue,
not a display gap; no FE work was needed. ADR-3 (Trading_analysis
dead-period hide) is **deferred** because the period-listing endpoint
doesn't surface per-period "has_data" state — a clean fix needs a
small backend addition to return `has_meaningful_data` on each period
in `/list_documents`, which the FE picker would then filter on. That
was out of scope for the F3.14 bundle; tracked as F3.15 follow-up.

The dual-EBITDA work (3b) in the same PR is a genuine engine addition.
The `EbitdaReconciliationPanel` already implements the Reported → Core
bridge with itemized 758/781 deductions (matches operator's spec verbatim
even though the labels are "Reported / Core" rather than the suggested
"Operating / Adjusted"). The engine addition is to persist
`adjusted_ebitda` as a discrete metric (alongside the existing
on-the-fly canonicalMetrics computation) so downstream consumers
(briefing prompts, exports, API integrations) have a stable named
field. Both the discrete metric and the existing bridge component
agree on the value to the cent.

— Romania pack, F3.14, 2026-05-23
