# GOLDEN CORPUS — end-to-end replay fixtures for the BS engine

Every case freezes the FULL offline pipeline (parse → assemble →
auto-reconcile → persist → serve → FactsGateway) for one input file.
The replay runner byte-compares each stage artifact against
`expected/`; any diff is a regression (or an intentional engine change
that must be re-frozen with a note).

## Layout

```
corpus/<case_id>/
  input.<ext>            the frozen input (exactly one input.* per case)
  meta.yaml              case metadata (schema below)
  mock_model_response*.json   scripted model output (mocked lanes only)
  expected/
    extraction.json      extraction block + source anchor + extracted rows
    classification.json  classification-stage output (per-lane shape)
    statuses.json        persisted+served status, receipt, presentation
    served_envelope.json the FULL served canonical_bs (verbatim payload)
    gateway_facts.json   FactsGateway equity/total_assets/net_result (cents)
```

`_tools/` holds the input builder (`make_corpus_inputs.py`) and is not a
case. `quarantine/` is NOT a case either — it belongs to the hypothesis
property suite (`tests/engine/test_properties.py`), which writes its
failure artifacts there; the replay runner ignores every directory
without a `meta.yaml`.

Input files are FROZEN once created — XLSX zip containers embed save
timestamps, so a rebuild is never byte-identical and would orphan the
goldens (`--force-inputs` rebuilds deliberately; refreeze after).

## meta.yaml schema

| key | meaning |
|---|---|
| `case_id` | must equal the directory name |
| `jurisdiction` | `RO` / `HU` |
| `expected_parser` | dispatch lane: `saga_10_col`, `saga_compact_6_col`, `generic_4_col`, `csv`, `pdf_positional`, `ro_llm_fallback`, `hu_ai_lane`. For the XLSX lanes the replay also asserts the parser's detected `extraction.source_format` equals this value (`csv` dispatches through `parse_trial_balance_csv`; its detected format is asserted inside `expected/extraction.json`). |
| `period` / `period_end` | human label / ISO date passed as the upload flow's `period_end_hint` |
| `anonymized` | `true` ⇒ the input was produced by `scripts/anonymize_tb.py` and the replay runs its `--verify` invariants on every run |
| `expect_ai_never_consulted` | `true` ⇒ the replay FAILS if the reconcile AI-proposal path (or any model client) is ever invoked for this case |
| `source_notes` | provenance + anything a future maintainer must know |

## Running

```
.venv/bin/python scripts/corpus_replay.py                # full corpus
.venv/bin/python scripts/corpus_replay.py --case csv     # one case
UPDATE_GOLDEN=1 .venv/bin/python scripts/corpus_replay.py  # refreeze
pytest tests/engine/test_corpus_replay.py                # battery form
```

Exit non-zero on any diff, with a per-field report (JSON path, expected,
actual). Refreeze ONLY when the numeric change is intentional, and say
why in the commit message.

## Guarantees

- **No live API calls, ever.** `sys.modules["anthropic"]` is nulled for
  every case run; the reconcile `_ai_propose` seam is a recording
  raiser; mocked lanes inject scripted clients through the engine's own
  injectable-client seams (`client_factory`, the `anthropic` module
  import). The Anthropic credit state can never affect this gate.
- **Volatile keys only.** The normalizer replaces exactly these
  timestamp keys with a placeholder before compare: `written_at`,
  `applied_at`, `attempted_at`, `archived_at`, `undone_at`,
  `suppressed_at`, `at` (ai_audit stages), `updated_at`. Everything
  else is byte-compared under `json.dumps(sort_keys=True)`.
- **Anonymization is verified, not assumed.** Cases with
  `anonymized: true` re-prove on every run that scrambling preserves
  account codes, every per-row numeric field, every column-pair sum
  and the totals-row anchor (see `scripts/anonymize_tb.py --verify`).

## Known-gap goldens (frozen honestly, flagged loudly)

- `llm_fallback_scanned_pdf` freezes a REAL contract gap: the RO PDF
  LLM fallback (`financial_statements.parse_document`) returns no
  `extraction` stamp, so the envelope reads `method: deterministic`
  and can claim `BALANCED` — both violate CANONICAL_BS_V2 ("llm ⇒
  never BALANCED"). When the engine fix lands, this golden flips and
  must be refrozen with a note.
- Synthetic-input cases (`saga_compact_6_col`, `generic_4_col`, `csv`,
  the adversarial set, the scanned PDF) are marked "synthetic until a
  real anonymized export is contributed" — the spec prefers real files.
