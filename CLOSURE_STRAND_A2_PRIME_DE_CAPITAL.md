# Closure — Strand A.2: Account 104 (Prime de capital) on the F30/F10 statutory path

> **Source-inspection GREEN. End-to-end statutory-PDF verification blocked on missing fixture (no F30/F10 PDF in the repo).**
> **Critical disclosure inside (§Honest Disclosure): the A.2 fix does NOT close the Scandia ~RON 41.65M equity drift on its own — the diagnostic itself documents this. Phase 0 gate is not "GREEN" on the strength of A.2 alone; a sibling strand is needed.**

---

## What changed

Three edits in [`src/engine/api/_statutory_parser.py`](src/engine/api/_statutory_parser.py), exactly per the Minimal Fix Surface recorded in [DIAGNOSTIC_EQUITY_BS_INTEREST_DIO_SAGA.md](DIAGNOSTIC_EQUITY_BS_INTEREST_DIO_SAGA.md) Strand A.2:

1. **`F10_ROW_MAP[86] = "prime_de_capital"`** ([_statutory_parser.py:145](src/engine/api/_statutory_parser.py#L145)). Row-index path for the canonical OMFP-1802 short-form template; commented to note that older template vintages may locate the line at rd 84/85.
2. **`F10_LABEL_MAP` regex anchor** ([_statutory_parser.py:266](src/engine/api/_statutory_parser.py#L266)): `Prim[eaă]\s+de\s+(capital|emisiune)\s*\(ct\.\s*104` — the text-anchor detector. Catches every regulatory spelling regardless of row index.
3. **Equity emission in `_synth_accounts_from_extraction`** ([_statutory_parser.py:1025-1038](src/engine/api/_statutory_parser.py#L1025)): reads `bs.get("prime_de_capital")` and conditionally emits an `add("104", "Prime de capital (F10)", ...)` row when non-zero.

Downstream routing was already in place:
- [`_ro_coa.py:82`](src/engine/api/_ro_coa.py#L82) maps `MappingRule("104", "otherEquity", 1, "Prime de capital")`.
- [`_ro_coa.py:882`](src/engine/api/_ro_coa.py#L882) sums `total_equity = bs["shareCapital"] + bs["retainedEarnings"] + bs["otherEquity"]`.

No other file touched. No DB / schema / FE change. No engine-compute math changed. Fully additive — entities without a non-zero `prime_de_capital` see zero behavior delta.

---

## Verification — what passed

**Source-inspection tests** ([tests/test_statutory_104_prime_capital.py](tests/test_statutory_104_prime_capital.py)) — 4/4 PASS in this environment (no engine deps required):

```
  PASS  edit_1_f10_row_map
  PASS  edit_2_label_anchor_regex_behavior
  PASS  edit_3_equity_emission_block
  PASS  downstream_route_to_otherequity
```

The label-anchor test exercises real regulatory variants:
- `"Prime de capital (ct. 104)"` — primary template
- `"Primă de capital (ct.104)"` — Romanian diacritic + no-space variant
- `"Prime de emisiune (ct. 104)"` — older synonym
- `"PRIME DE CAPITAL (ct. 104)"` — case-insensitive
- And negative cases: 1012, 105, 106, 117 lines must NOT match.

**Python syntax:** `python3 -c "import ast; ast.parse(...)"` — clean.

**TB-path fixtures (Scandia 8-col Crystal Reports + the EEI TB shape in `ro_eei_dec_2025`):** by construction unaffected. These fixtures are parsed by `_trial_balance_parser.py`, never by `_statutory_parser.py`. The doc-type detector at [`_document_type_detector.py:16-19`](src/engine/api/_document_type_detector.py#L16) routes them to `trial_balance` — the statutory path needs ≥3 F30 anchors, which neither fixture has. So the A.2 fix **cannot regress** these existing fixtures.

---

## Verification — what is NOT proven by this closure (the gap)

1. **No F30/F10 PDF fixture exists in the repo.** `find . -iname "*F30*" -o -iname "*F10*" -o -iname "*statutory*"` returned only the parser source. The fix's effect on a real ANAF statutory filing — the situation it's designed for — has not been observed end-to-end. The diagnostic named "EEI public-records / ANAF filings" as the canonical case; that PDF is not on file.

2. **Functional probe (the synthetic-BS path) requires container deps.** The unit test file includes two `pytest.skip`-ped probes (`test_strand_a2_functional_emit_when_engine_loadable`, `test_strand_a2_zero_prime_de_capital_emits_nothing`) that feed a synthetic `bs` dict through `_synth_accounts_from_extraction` and assert the 104 row appears with the right amount. These run when `engine.api._statutory_parser` is importable (i.e. inside the backend container) but are skipped in the local stdlib-only environment.

**Honest readout: the fix is correct on the recorded specification, the source matches the diagnostic exactly, the regex behaves as designed, and the downstream routing wire is intact. The end-to-end statutory parse → assemble → BS reconcile on a real F30/F10 input has not been observed because we don't have a real F30/F10 input.** To close this gap definitively, an F30/F10 PDF fixture (ideally EEI's public-records ANAF filing with non-zero 104, OR a redacted real filing from any RO mid-cap with merger-premium history) must be added to `tests/fixtures/` and the functional probes re-run.

---

## Honest Disclosure — what A.2 does NOT fix

> **The Scandia ~RON 41.65M equity drift is NOT resolved by this fix.**

This is the critical disclosure. The user's directive was:
> "Sequencing is non-negotiable: the account-104 statutory-path fix (Strand A.2) must land and be verified GREEN on the Scandia and EEI fixtures BEFORE F1 implementation."

The implicit assumption — reasonable from the spec doc — was that A.2 closes the Scandia drift. **It doesn't, and the diagnostic itself says so.** Quoting [DIAGNOSTIC_EQUITY_BS_INTEREST_DIO_SAGA.md](DIAGNOSTIC_EQUITY_BS_INTEREST_DIO_SAGA.md) Strand A, **A.1 — TB path verdict**:

> "**Verdict (TB path):** 104 IS captured into otherEquity → total_equity. A Scandia 41.65M merger premium delta against the engine output cannot be explained by this mapping. Likely causes to verify next: (i) the file was misrouted to the statutory parser (see A.2 below) by the document type detector, or (ii) a downstream rendering layer split otherEquity into a sub-line and dropped it from the headline equity card."

In plain English:
- **Scandia is parsed by the TB path**, where 104 is already captured correctly.
- **A.2 fixes the statutory path**, which Scandia doesn't use.
- Scandia's drift comes from one of the two unresolved hypotheses (i: misrouting, ii: downstream rendering drop) — **neither is fixed by A.2**.
- The diagnostic itself names this as a forward open work item.

So the Phase 0 gate as the user defined it — "104 fix verified GREEN on Scandia + EEI fixtures" — **cannot be achieved by A.2 alone**, because Scandia's drift isn't an A.2 instance. A.2 is independently correct (it closes a real F30/F10 leak that affects any future statutory-path entity with non-zero 104), but it is not the cause of Scandia's number being wrong today.

Three honest next steps, in order:

### Next step 1 — verify or exclude hypothesis (i): doc-detector misrouting

Run the existing fixture through the document-type detector and inspect the verdict. If Scandia's 8-col Crystal Reports somehow lands as `statutory_f30_f10`, A.2's emit path activates and the rest of the diagnostic's Strand A.2 reasoning kicks in (in which case A.2 might still resolve Scandia, but only via a misrouting we didn't expect). Concrete probe: load the Scandia source file, call `detect_document_type(bytes, filename)`, log the verdict and anchor counts. ETA: 30 minutes, read-only.

### Next step 2 — verify or exclude hypothesis (ii): downstream rendering drop

If detector says `trial_balance` (expected), 104 IS captured at parser → mapper → bs["otherEquity"] level. The drift must come downstream. Two candidate sites:
- `assembled_bs.total_equity` is built correctly but a FE renderer (e.g. the headline equity tile) reads only `bs.shareCapital + bs.retainedEarnings` and drops otherEquity. Check `EbitdaReconciliationPanel`, `CreditScoreCard`, `KpiCard`, `ComprehensiveReport` for equity rendering.
- Or there's a sub-aggregator (e.g. an "equity components" split for the BS tab) that splits otherEquity into its constituents and one constituent (104) gets visually dropped while the others (105, 106) get rendered.

This requires running Scandia through the full pipeline locally + comparing `assembled_bs.total_equity` (engine number) vs the displayed equity (FE rendering). If they match, the drift is in the engine somewhere I haven't found yet. If they differ, it's a rendering site to fix. ETA: 1 hour, read-only.

### Next step 3 — write Strand A.3 diagnostic owning the Scandia drift

Whichever hypothesis lands, the result is a new diagnostic naming the root cause + the minimal fix surface for it, the same shape as A.1/A.2. That's the diagnostic that Phase 0's "BS balances, equity correct, ratios + credit verdict correct" line item is actually waiting on for Scandia. Once that's GREEN on Scandia (and equivalent verification on EEI), F1 implementation can begin.

---

## What the F1 spec depends on, after this closure

[SPEC_F1_ENGINE_CANONICAL_CONTRACT.md](SPEC_F1_ENGINE_CANONICAL_CONTRACT.md) §5 specifies that `assembled_bs.other_equity` "must include statutory-path fix from Strand A.2". **That dependency is now satisfied for the statutory path.** Any future F30/F10-parsed entity with non-zero 104 will see `other_equity` populated correctly post-deploy.

What is **still not satisfied** for F1:
- The Scandia / EEI numerical correctness on TB path (Strand A.3, not yet written).
- The 7 spec decisions are approved per the user's prior message, but the spec's own "hard prerequisite" in §0 (BS correctness on the existing fixtures) remains open until A.3 lands.

**Recommendation: F1 implementation remains blocked.** Not because A.2 didn't land — it did — but because the broader Phase 0 gate ("all numbers right on Scandia + EEI") needs Strand A.3 too. The non-negotiable sequencing the user defined is correct in spirit; what's needed is a more granular sequence:

```
A.2 (statutory path, this closure)      ← GREEN on source-inspection
  ↓
A.3 (Scandia TB drift root cause)        ← NEXT
  ↓
A.3 fix + Scandia/EEI GREEN end-to-end   ← then
  ↓
F1 engine extension                       ← then
  ↓
F2–F7 FE conformance                      ← per the audit
```

---

## Sequenced summary

| Item | State |
|---|---|
| A.2 source edits | ✅ landed |
| A.2 source-inspection tests | ✅ 4/4 PASS |
| A.2 syntax clean | ✅ |
| A.2 regression risk on TB fixtures (Scandia/EEI) | ✅ zero (different parser path; fix is fully additive) |
| A.2 end-to-end on a real F30/F10 PDF | ⚠️ not exercised (no fixture in repo) |
| A.2 functional probe (synthetic BS dict) | ⚠️ skipped locally; runs in the backend container |
| **Scandia ~RON 41.65M equity drift** | ❌ **NOT fixed by A.2** — diagnostic itself documents this; needs Strand A.3 |
| Phase 0 "BS correctness on existing fixtures" gate | ❌ not GREEN until A.3 |
| F1 implementation | 🟡 blocked pending A.3 |

---

## What I am asking you to decide

The user's framing assumed A.2 == Scandia fix. The diagnostic says otherwise. Three options:

1. **Open Strand A.3 now** — run the doc-detector probe (next step 1), then the rendering probe (next step 2), produce A.3 as its own read-only diagnostic with the minimal fix surface. ETA ~2 hours for the diagnostic; implementation depends on what we find.
2. **Acquire an F30/F10 PDF fixture** for EEI (or another RO entity with merger-premium history) and exercise A.2 end-to-end alongside opening A.3. ETA depends on fixture acquisition.
3. **Accept A.2 as GREEN on its own merits** (unconditional correctness for the statutory path, source-inspection clean, fully additive) and **separately** acknowledge that Phase 0's Scandia/EEI numerical correctness is owned by A.3, not A.2. F1 still waits on A.3 either way.

My recommendation: **(3) + (1)** — accept A.2 as closed on what it covers, immediately open A.3 to find Scandia's actual root cause. Don't conflate the two.

---

*Status: A.2 source-inspection GREEN. Functional probes + statutory-PDF end-to-end deferred until a real fixture exists or the container runs the suite. **A.2 does not by itself satisfy the Phase 0 gate the user defined — Strand A.3 (Scandia TB drift root cause) is the next concrete deliverable, not F1 implementation.***
