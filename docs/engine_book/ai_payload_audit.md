# AI Payload-Minimization Audit — what each role sends to the model

**Date:** 2026-08-23 (Wave 2, Part E — trust boundary)
**Method:** every prompt builder in `src/engine/` was READ at source level
(every `messages.create` call site enumerated by grep, then each builder's
payload construction traced to its inputs). This is an audit REPORT —
Part E's contract is to document and flag, not to refactor prompts.
**Scope:** the six registry roles (`src/engine/ai/models.yaml`) audited in
depth; every remaining (non-registry) call site inventoried with its
payload characterized.

The question asked of each surface: *does this role receive only the
rows/windows its job needs?*

Verdicts: **MINIMAL** (payload ≈ job's minimum), **JUSTIFIED-FULL** (whole
document sent, and the job genuinely requires whole-document reading),
**FLAG** (more than the job needs — a concrete minimization opportunity,
listed in §4).

---

## 1. Registry roles (models.yaml) — deep audit

### 1.1 `format_detect` — AI-lane stage 1
`src/engine/ai_lane/format_detect.py::run_format_detect`

| Sends | Withheld / capped |
|---|---|
| jurisdiction string, filename, full document text render (TSV for xlsx / pypdf text for PDF / raw decode) | text hard-capped at `MAX_DOC_CHARS = 200_000` chars (`config.py:84`), `[truncated]` marker appended |

Job: detect columns, header row, **totals-row index**, currency, scale,
separators, language. The totals row usually sits at the document *end*,
so a head-only window would break `totals_row_index`; full text is
defensible. **FLAG (low)** — a head+tail window (first ~50 rows + last
~20 rows) would almost always suffice for layout detection and would cut
the largest recurring prompt in the lane by ~90% on big TBs; the full
per-row body is only genuinely needed by stage 2. Also carries the
upload **filename**, which frequently embeds the company name — see §4.3.

### 1.2 `extract` — AI-lane stage 2
`src/engine/ai_lane/extract.py::run_extract`

| Sends | Withheld / capped |
|---|---|
| jurisdiction, filename, stage-1 layout note (columns/separators/scale), full document text | same 200k char cap |

Job: emit **every** account row. By definition whole-document.
**JUSTIFIED-FULL.**

### 1.3 `classify` — AI-lane stage 3
`src/engine/ai_lane/classify.py::run_classify`

| Sends | Withheld |
|---|---|
| per account: `code`, `label`, `debit=`, `credit=`, `balance=` (closing figures, verbatim); system prompt carries the pack vocabulary + chart guidance + confirmed mappings | document text NOT re-sent (rows only — good); filename/jurisdiction prose not repeated |

Job: map (code, name) → canonical line_id. The **closing amounts are
more than the mapping needs**: side disambiguation (e.g. HU 479, contra
rows) needs at most the *sign*, never the magnitude. **FLAG (low)** —
sending `sign` (or debit/credit presence flags) instead of full figures
would remove every account balance from this prompt with no information
the task uses lost. Counterweight kept honest: magnitudes may help the
model calibrate `confidence` on ambiguous small-balance technical
accounts, and the same figures already went to the provider in stage 2 —
so the *incremental* exposure is zero. Report, not refactor.

### 1.4 `reconcile_proposal` — auto-reconcile AI step
`src/engine/api/_reconcile.py::_ai_propose` (file read-only for Part E)

| Sends | Withheld |
|---|---|
| `difference`, `status`, `totals`, rows as `{id, section, amount, account_codes}`, `unmapped` (full entries), `diagnosis` (deterministic findings) | row **labels** withheld; no document text; no filename; no provenance |

Job: name the single account/row most likely at fault for a nonzero
BS difference. It must see every row's amount and the unmapped list —
that IS the search space. Labels already stripped. **MINIMAL.** The
deterministic validator recomputes everything; the model's output is a
proposal object only.

### 1.5 `ai_validator` — advisory pass (two jobs)
`src/engine/ai/advisory.py`

**Job 1 — extraction verification** (`_job1_extraction_verification`):

| Sends | Withheld / capped |
|---|---|
| provenance coordinates (`extraction` block subset, `original_filename`, `content_hash`), atom refs `{id, section, label, account_codes, leaf_ids}`, source text | **the engine's own readings are deliberately WITHHELD** (anti-echo: the model cannot agree by copying); source text capped `_MAX_SOURCE_CHARS = 200_000` |

Runs only when `extraction.method == "llm"` AND the caller supplied the
source text. An independent re-read requires the source document.
**JUSTIFIED-FULL**, with the withholding of engine readings a
minimization pattern worth copying elsewhere.

**Job 2 — statement sanity review** (`_job2_sanity_review`):

| Sends | Withheld / capped |
|---|---|
| `status`, gateway facts as integer minor units (12 named accessors, via the facts-gateway PUBLIC API only), rows compacted to `{id, section, amount}`, deterministic `diagnosis`, `unmapped_count` (a COUNT), pack statement-map line ids, prior-period facts when available | row labels withheld; unmapped **contents** withheld (count only); rows capped `_MAX_ROWS_IN_PAYLOAD = 300`; no document text; no filename |

**MINIMAL** — the tightest payload in the system; the reference standard
for future roles.

### 1.6 `narrative` — briefing writer
`src/engine/api/pipeline.py` (`stage_narrate`, call at ~:2926) +
`src/engine/briefing/generator.py::_build_user_facts`

| Sends | Withheld |
|---|---|
| derived aggregates only: metrics, valuation summary (EV/EBITDA, DCF equity), served BS grand totals, decision lists (anchor_alerts / eliminate / warning / scale), run/data dates, output-schema instructions | raw TB rows, account codes/labels, document text — none sent |

Job: 3-sentence briefing + recommendations grounded in named metrics.
**MINIMAL.** The prompt itself states alerts are NOT LLM-generated
(deterministic rule registry stays the only alert source).

---

## 2. Non-registry call sites — inventory sweep

| Call site | Payload sent | Verdict |
|---|---|---|
| `api/_detect.py::_detect_via_opus` (~:395) | OCR excerpt capped **3,000 chars** + heuristic candidate list + allowed coa_keys; cached by `ocr_hash` so repeats never re-send | **MINIMAL** — exemplary |
| `api/pipeline.py` broad extract (~:1186) | whole document (image base64 or text capped **250k chars**) + type-detection instructions | JUSTIFIED-FULL (extraction) |
| `api/financial_statements.py` (~:231) | the **entire PDF as base64** document block (forensic scanned-doc extraction) | JUSTIFIED-FULL, but see §4.2 — largest single payload in the system, no page windowing attempted |
| `api/ai_analyzer.py` (~:157) | `_run_compact(run)` engine output + top SKU-removal candidates (derived, compact) | MINIMAL |
| `api/_ai_council.py::_build_evidence` (~:238) | aggregates only: account COUNT, per-class counts, BS/PL totals, reconciliation deltas/percentages | MINIMAL |
| `api/ai_orchestrator/adapters/claude_adapter.py` | transport adapter — payload owned by its orchestrator caller, no data of its own | n/a |
| `frontends/llm_extractor.py` | **no model call** — replays the lane's recorded strict-JSON through the lane coercion with an echo client | n/a |
| `briefing/client.py` | transport for the `narrative` payload above (system prompt cache-marked) | n/a |
| `public/intelligence/ai_market_read.py` (~:181) | ticker, sector, deterministic risk/opportunity scores, exposure profile, signals — **public-company data** | MINIMAL (and public by nature) |
| `public/intelligence/filings_extractor.py` (~:438) | 10-K Item 1A "Risk Factors" text — **public filing** | JUSTIFIED-FULL (public by nature) |
| `ai_lane/jurisdiction_resolver.py` | **zero LLM calls** — fully deterministic ladder | n/a |

---

## 3. Cross-cutting observations (good patterns worth locking)

1. **Prompts are not persisted; responses are.** The lane's audit trail
   (`ai_lane/_client.py::call_strict_json`) records
   `{stage, role, model, prompt_version, at, raw_response}` per attempt —
   the full prompt (with its 200k of document text) is NOT written to
   `ai_audit`. Prompt content stays reconstructible from
   (pack, prompt_version, document), so at-rest exposure ≈ the model's
   output only. The advisory pass carries its audit inside the
   `ai_review` layer with the same shape. This is the at-rest surface
   the `engine.security` encryption seam (E1) will wrap.
2. **Role quarantine holds.** `ai_validator` has its own client factory;
   the reconcile stage never consults it (advisory.py V6). No prompt
   builder imports another role's payload builder.
3. **Deterministic outputs are never delegated.** Totals, statuses,
   alerts, reconciliation acceptance all remain engine-computed; every
   prompt states it and every consumer enforces it (whitelist
   projection, exact-zero validator, id-only escalation ledger).
4. **Caps everywhere.** 200k (lane, advisory source), 250k (broad
   extract), 3k (detect fallback), 300 rows (advisory job 2),
   max_tokens per role from the registry.

---

## 4. Findings — over-sharing flagged (report only; no prompt edits this wave)

### 4.1 `classify` sends full closing balances where sign would do — LOW
Stage 3's per-account lines carry full debit/credit/balance magnitudes;
the mapping task consumes code + label + side. Incremental provider
exposure is nil (stage 2 already sent the figures), so this is a
*minimization opportunity*, not a leak: swap magnitudes for
`side=D|C|0`. Requires a prompt_version bump + AI-cache invalidation +
HU corpus golden refreeze — schedule with the next deliberate
`models.yaml` refreeze event, not as a drive-by.

### 4.2 `financial_statements.py` ships the whole PDF binary — LOW/MEDIUM
The forensic scanned-doc path base64-sends the entire uploaded PDF.
Extraction legitimately needs the document, but scanned uploads often
contain more than the trial balance (signatures, headers with CUI/CIF,
cover letters). No page-relevance windowing is attempted before the
send. Opportunity: a cheap first pass (or pypdf text probe) selecting
statement-bearing pages would bound what leaves the box. Needs product
judgment on scanned-quality tradeoffs — flagged for the owner.

### 4.3 Filenames ride in prompts — LOW
`format_detect` and `extract` embed the upload filename; advisory job 1
embeds `original_filename` in provenance coordinates. Uploaded filenames
routinely carry the company name (`balanta_<company>_dec2025.xlsx`).
None of the three tasks needs the filename to do its job (layout,
row extraction, re-reading). Opportunity: send extension only, or drop
the field. Same refreeze coupling as 4.1 (prompt_version + goldens).

### 4.4 No finding: everything else
Reconcile proposal, advisory job 2, narrative, detect fallback, council,
analyzer, market read, filings — each already receives only its job's
window (or public data). No further over-sharing found at any call site.

---

*Audit trail: every claim above is line-anchored to the source read on
2026-08-23; re-verify by grepping `messages.create` under `src/engine/`
(12 call sites) and diffing this document against the builders it names.
Re-verified 2026-08-24: the same 12 call sites; one additional TEXTUAL
grep match appeared in `src/engine/dst/faults.py` — prose inside a
fault-scenario `detail` string ("a single blocking messages.create()"),
not a call, and the DST harness injects faults through the lane's
existing `client_factory` seam rather than talking to any provider.*
