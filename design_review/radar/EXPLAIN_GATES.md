# Radar — AI EXPLANATION, IN ITS LANE — gates R5 / R6 / R7, hardened (B1 / B2 / B4 / B7 / A1)

**Lane:** Radar explain (engine half) — explain hardening + numerals.
ENGINE ONLY; the Radar surface is a later wave.
**Dates:** 2026-09-04 (first build), 2026-09-05 (this hardening wave, after
two adversarial critics).
**Owns:** `src/engine/radar/explain.py`, `src/engine/ai/finding_sharpen.py`
(the F9 guard itself — the Capsule's sharpening shares it and benefits),
`tests/engine/test_radar_explain.py`, `tests/engine/test_finding_sharpen.py`,
`tests/engine/fixtures/radar/explain/` (its own capture script + five
fixtures), this page, ONE role block in `src/engine/ai/models.yaml`
(`radar_explain` — handed verbatim below, not edited).
**Imports, never edits:** `engine.ai.numerals` (the currency law is BUILT ON
its `_CURRENCY_TOKEN_RE`), `engine.ai.breaker`, `engine.ai.registry`,
`engine.api._finding` (the ONE advisory seam), `engine.api._ratio_units`
(the placeholder resolver — the guard's regex is pinned to its pattern),
`engine.api.findings.s_engine`, `engine.api._finding_rank`.
**Does not own, does not edit:** `src/engine/api/_radar.py`,
`src/engine/radar/serve.py`, `cap.py`, `server.py`, `pipeline.py`,
`scripts/run_battery.py`, `docs/engine_book/gates.md`, `models.yaml` —
the verbatim handoffs are at the bottom of this page.

```
PYTHONPATH=<scratch> .venv/bin/python -m pytest tests/engine/test_radar_explain.py \
    tests/engine/test_finding_sharpen.py tests/engine/test_findings_gates.py -q -p netblock
.venv/bin/python tests/engine/fixtures/radar/explain/capture.py --check
RADAR_EXPLAIN_LIVE=1 RADAR_EXPLAIN_LIVE_JOURNAL=<dir> .venv/bin/python -m pytest \
    tests/engine/test_radar_explain.py -q -s -k live
```

---

## What the critics proved, and what this wave did about it

| # | Refuted claim (with the critic's harness) | Fix | Gate that reds on the defect |
|---|---|---|---|
| **B1** | TEN classes of model-authored quantity shipped `status=fresh` through the real `explain_one → sharpen_finding` path on the real agras 461 finding (`plant_harness.py`): number words EN+RO; currency words in any case on either side of a placeholder; `\|abs` sign flip; `\|d4` precision; `{{money:x\|Bare}}` shipped as literal braces; an allowed code as a quantity (`461%`, `past 461 days`, `de 461 ori`, `since 455`); Unicode numerals ², ½, ⑦, ⁴⁷, Roman `XII`. | ONE numeral law, `finding_sharpen.numeral_violations`, both languages, both paths (§ The numeral law) | `test_s3_the_numeral_law_refuses_every_class_by_name` (61 plants, each refused BY CLASS), `test_r5_the_served_guard_names_every_class_in_its_reason`, `test_r5_a_sign_flip_through_abs_is_refused_on_both_paths`, `test_s3_the_placeholder_regex_is_the_resolvers` |
| **B2** | The cache path skipped every check: a record with `review: []`, `specificity: null`, hedge prose and `source: "deterministic-looking"` was served as `cached`, source passed through verbatim. The lane's own census asserted only `served_numeral_violations == ()`. | `_from_cache` re-runs, on read: the numeral law; the finding contract through the seam (`narrative_contract_problems`); the self-review at TODAY's floor (`review_problems`); `source` re-derived, never passed through. A failing record is a MISS with its kind; the critical path serves the marker, the after-rows path redrafts. | `test_b2_the_cache_path_runs_every_fresh_check_on_read_for_every_subject` (17 checks × 21 subjects = 357, TC-6), `test_b2_a_record_is_refused_at_todays_floor…`, `test_b2_the_source_is_never_passed_through` |
| **B4** | The explain fixtures were captured on the ASSEMBLE path; the served seam differs (`facts_cited` on 4 of 21 subjects, canary total_assets 39,272,501.03 vs 39,319,114.09) — a fingerprint measured here could never hit a cache record against a served row. | `explain/capture.py` now reaches the served seam THROUGH THE SERVE LANE'S capture module (loaded by path — one implementation), records `_meta.seam`, and REFUSES to write a fixture whose served net income is not the envelope's account 121. | `test_b4_every_explain_fixture_was_captured_on_the_served_seam`, `test_b4_served_net_income_is_account_121_on_every_fixture`, `test_b4_facts_cited_per_subject_equal_the_serve_lanes_rows` (21/21 subjects agree with the serve fixtures' `single_period.payloads` and `radar.surfaced` rows) |
| **B7** | `test_s8_the_guarded_seam_demotes_the_f9_plant` was order-dependent (red in the full run, green alone): it read `F.apply_advisory_narrative` for the "unguarded" half, which another module's import had already replaced with the twin. | The test reads the raw seam through the new `finding_sharpen.unguarded_seam()` and installs the guard EXPLICITLY (restored in `finally`). | Was 1 failed in every full run at baseline; `224 passed, 2 skipped` now, in any order (`-p random` not needed — no import side effect is read). |
| **A1** (explain side) | The two lanes never met; `serve.attach_explanations` was a shape-incompatible second seam. | `Explanation.to_payload()` IS the seam. The contract is published in the module docstring and pinned: `EXPLANATION_PAYLOAD_KEYS`, `PROSE_PAYLOAD_KEYS`, `STEP_PAYLOAD_KEYS`, `REVIEW_ROW_KEYS`, `ABSENT_KINDS`, `REFUSED_CACHE_KINDS`. The serve lane has since wired `attach(rows, attach_cached(subjects), subjects)` then `explain_in_background(subjects)` in `_radar.py` and retired `attach_explanations` (measured: `attack_ai_seams` 1b now prints "NO LONGER EXISTS"). | `test_the_payload_contract_is_stable` |
| anchor | Radar was the one surface still serving the class-6/7 reconstruction as net income (`_radar.py:64` never selected the envelope). | Serve lane's line (`p121:` alias, now in `_radar.py:116`). THIS lane's side: the explain cache keys on the finding's numeric fingerprint, so a finding whose net income moved from the reconstruction to account 121 is `stale_cache` → redrafted, never served; the fixtures refuse an unanchored seam (plant P7). | `test_b4_served_net_income_is_account_121_on_every_fixture`; capture `--check` exit 2 with the plant |

---

## The numeral law — one function, both languages, both paths

`finding_sharpen.numeral_violations(text, allowed_codes, money_facts,
allowed_words)`. Every message STARTS with its class
(`FS.VIOLATION_CLASSES`), so a refusal names what it refused and a gate
asserts on the class, not the wording. Run at parse on the raw draft
(`sharpen_finding`, `_apply_ro`), and again on the SERVED text — fresh
and cached alike — through `assert_no_new_numerals` (the F9 guard) after
`_ratio_units.templatize` has lifted every engine figure back into its
placeholder (`explain.served_numeral_violations`).

| class | refuses | measured allowance |
|---|---|---|
| `numeral` | any ASCII figure that is neither a resolved placeholder nor a whitelisted ledger code — `47%`, `2024`, `4111`, `7,692,203` | the codes `allowed_ledger_codes` derives from the finding (unchanged) |
| `number word` | cardinals, tens, scale words, ordinals, fractions, multiples, EN + RO on diacritic-stripped text: `trei`, `treizeci`, `două milioane`, `forty-seven`, `a third`, `half`, `doubled`, `tripled`, `de zece ori` | `allowed_number_words(finding)`: the number words the ENGINE's own why-here and steps wrote, plus their Romanian peers — as single words ("the ten largest") and as `word unit` bigrams ("twelve months", "two quarters", "one month"). MEASURED on the corpus: the engine writes `one` (most findings), `first`, `second`, `two`, `six`, `ten`, `twelve`, `quarter(s)`, `zero`. A whitelisted word beside a DIFFERENT unit ("twelve years", "one year") is refused; the unit word of an allowed bigram is judged as part of it (live run 1 refused the engine's own "the next two quarters of input volume" as a fraction — fixed, pinned). CONTEXTUAL tokens (`one`, `first`, `second`, `quarter`, `unu/una`, `noua`, `opt`, `mie`, `primul`…) are refused only beside a unit, a comparator, or as a fraction ("a quarter of"). Escapes: `third party`, `double-check`. |
| `currency label` | a currency word or symbol, ANY case, within four glue characters of a placeholder or a figure, on EITHER side: `euro`, `EURO`, `€`, `lei`, `Lei`, `ron`, `"in EUR:"`, `"EUR-"`, `"(lei)"`. Built on `engine.ai.numerals._CURRENCY_TOKEN_RE` (ISO codes, symbols, `lei`, case-insensitive) + `euro/euros/euri/leu/dolar(i)/dollar(s)` | a currency word AWAY from any figure ("reporting in RON", the account name "Conturi la bănci în lei") is prose and stays |
| `unicode numeral` | any Unicode category N character outside 0-9: ², ½, ⑦, ⁴⁷, ٤٧, ４７, Ⅻ | none |
| `roman numeral` | a whole upper-case token that is a VALID Roman numeral carrying I, V or X: `XII`, `IV`, `XL`, `MIX` | `CCC`, `MD`, `CD`, `IMM` are not (an earlier single-regex version matched the empty string in front of `IMM`; replaced by candidate + full-match validation) |
| `ledger code as quantity` | a whitelisted code followed by `%`, `×`, `x`, `times`, `-fold`, `ori`, `days`, `zile`, `years`, `ani`, `luni`, `k/m/bn` (optionally via `de`/`of`), or preceded by `since`, `past`, `grown`, `than`, `about`, `only`, `de`, `peste`, `sub`, `crescut`… | location prepositions (`under 461`, `spread over 461 and 452`, `de pe 461`, `contului 461 de la`) are how a sentence names an account and are NOT comparators |
| `placeholder option` | `{{money:x\|abs}}`, `\|neg`, `\|d4`, `\|bare`, `\|suffix`, `\|k`, any unknown option | `PLACEHOLDER_OPTIONS_ALLOWED` is what the deterministic prose itself uses — MEASURED on 76 findings over 19 statement sets (`test_s3_the_option_whitelist_is_measured_on_the_deterministic_prose`): `{{money:FACT}}` and nothing else, so the whitelist is EMPTY |
| `unresolved placeholder` | `{{money:x\|Bare}}`, `{{money:x\|BARE}}`, `{{money:x\|bare }}`, `{{ money }}`, a stray brace — anything the resolver leaves as literal braces | the guard's `_PLACEHOLDER_RX` is now BYTE-IDENTICAL to `_ratio_units._PLACEHOLDER_RX` (pinned) — the loose regex it replaced stripped `\|Bare` as a placeholder while the resolver skipped it |
| `uncited placeholder` | `{{money:revenue}}` on a finding that does not cite revenue | — |
| `bare number before a placeholder` | the 461 collision — `461 {{money:x}}` | — |

`NUMERAL_LAW_VERSION = "numeral_law_v2"` is the fourth part of the explain
cache's composite prompt version; `DRAFT_PROMPT_VERSION` is `v2` (the
drafting prompt now names number words, Roman numerals, options and
currency words in any case); `CACHE_VERSION` is `2`. Every record cleared
by the older law is a miss.

**Reason texts name the class and carry no brace.** `_numeral_reason`
(drafting lane) and `explain._numeral_refusal_reason` (served) list the
classes first; a refused placeholder is described, not quoted — the
served-shape scrubber treats a brace as a payload (the first run of the
plant harness showed every `\|abs` refusal collapsing to the generic
sentence).

---

## The cache path runs the fresh checks, on read

`explain._from_cache` → `CacheRead(explanation | kind, reason, problems)`:

| step | check | on failure |
|---|---|---|
| 1 | `v == CACHE_VERSION`, `prompt_version`, numeric fingerprint of the finding | plain miss / `stale_cache` |
| 2 | the numeral law on every rationale and step, EN and RO | `numeral_refused` (classes in the reason) |
| 3 | the finding contract through the ONE seam — `finding_sharpen.narrative_contract_problems`: EN re-applied with `_raw_apply` and judged by `verdict()` (anchor, banned hedges, imperative lexicon, account code in the prose); RO through `_ro_gate` + the language-free half of `validate()` | `contract_refused` |
| 4 | `finding_sharpen.review_problems`: an accepted score row per served language at or above **today's** floor (`AI_SHARPEN_SPECIFICITY_FLOOR`), a numeric specificity on the prose | `review_missing` |
| 5 | `source` must claim `advisory`; the served `Prose.source` is re-derived as `"advisory"` only after 1-4 passed — never the record's field | `review_missing` |

A refused record: `attach_cached` (critical path) serves the honest
marker with that kind and a sentence; `explain_one` (after rows) treats it
as a MISS and redrafts — one regeneration inside the drafting lane, then
the deterministic template — and the redraft replaces the record. The
fresh path re-asserts step 4 on the shape about to be cached too, so a
lane bug cannot cache an unreviewed draft.

---

## The contract the route wires (A1, explain side)

```
subjects = subjects_from_ranked(report, profile, org, period, snapshot)
rows     = attach(rows, attach_cached(subjects), subjects)   # before the rows go out
explain_in_background(subjects)                              # after
```

`row["explanation"]` = `Explanation.to_payload()`, keys exactly
`EXPLANATION_PAYLOAD_KEYS` = {finding_id, key, status, kind, reason,
prompt_version, row_fingerprint, en, ro, ro_absent_reason, review};
`en`/`ro` = `PROSE_PAYLOAD_KEYS` = {language, rationale, steps, source,
specificity, attempts} or `None`; each step = `STEP_PAYLOAD_KEYS`; each
review row ⊆ `REVIEW_ROW_KEYS`; `status ∈ {cached, fresh, absent}`; an
absent explanation's `kind ∈ ABSENT_KINDS` (`not_yet_explained`,
`breaker_open`, `advisory_unavailable`, `numeral_refused`,
`contract_refused`, `review_missing`, `stale_cache`, `lane_error`,
`registry_error`). Nothing on it is ranking vocabulary; the only numbers
are `specificity` and `attempts`. Pinned by
`test_the_payload_contract_is_stable`. Measured after the serve lane
wired it: `_radar.py` imports `engine.radar.explain`, installs
`_finding_advisory` at mount (B6, coordinator decision) and calls
`explain_in_background`; `serve.attach_explanations` is gone.

---

## Fixtures — real SERVED output (TC-1, B4)

`tests/engine/fixtures/radar/explain/<case>.json`, captured by
`capture.py` in the same directory, which loads the SERVE LANE'S
`tests/engine/fixtures/radar/capture.py` by path and calls its
`run_engine` + `served_statements`: parse → assemble → `stage_persist`
(corpus_replay's fake admin) → `_rebuild_assembled_for_briefing` over the
persisted line items WITH the envelope on the row → detect → project.
Each file carries `_meta` (`seam: served`, `served_total_assets`,
`assemble_path_total_assets`, `served_net_income`, `envelope_p121`,
`net_income_anchor_source`) and, per surfaced subject, the finding id,
numeric fingerprint, row fingerprint, money facts AND `facts_cited`.

Measured on capture (2026-09-05, after the anchor commit `06ee60f`):

| case | surfaced | served total_assets | assemble-path | net income = account 121 |
|---|---|---|---|---|
| saga_10_col | 6 | 52,764,717.79 | same | 402,869.16 |
| saga_10_col_agras | 4 | **39,319,114.09** | 39,272,501.03 | 7,533,676.02 |
| saga_10_col_carniprod | 3 | 125,886,192.51 | same | 1,435,533.59 |
| saga_10_col_realestate | 4 | 83,417,653.88 | same | −801,604.14 |
| saga_10_col_retail | 4 | 70,089,631.84 | same | 3,205,212.62 |

The capture REFUSES (exit 2) when the served net income is not the
envelope's account 121 to the cent — plant P7 below shows the message.
The serve lane's own fixtures were recaptured during this wave; the
cross-check `test_b4_facts_cited_per_subject_equal_the_serve_lanes_rows`
agrees on all 21 subjects (retail `affiliate_income_dependency` cites
`net_income = 3,205,212.62` = account 121 = `gateway.net_result()`; the
critic's 469 % / 170 % contradiction is gone on this seam). Its failure
message says which lane's fixture is stale, measured by that fixture's own
envelope.

---

## STATUS, AS MEASURED — 2026-09-05

```
tests/engine/test_radar_explain.py + test_finding_sharpen.py + test_findings_gates.py
                                            226 passed, 2 skipped (the two env-gated live tests), 0 failed, -p netblock
                                            (baseline before this wave: 1 failed — test_s8, order-dependent)
tests/engine/test_radar_explain.py          48 collected: 47 passed + 1 env-gated skip
tests/engine/test_finding_sharpen.py        141 collected: 140 passed + 1 env-gated skip
tests/engine/test_radar_gates.py + test_radar_route.py (the serve lane's)   84 passed with this wave;
                                            4 route tests FAIL with this lane's finding_sharpen.py stashed to HEAD
tests/engine/fixtures/radar/explain/capture.py --check   OK ×5, served seam, net income = account 121 on every case
tests/engine/fixtures/radar/capture.py --check           PASS — 6 case(s)  (the serve lane's, recaptured by them this wave)
scripts/corpus_replay.py                    CORPUS REPLAY: PASS — 18 case(s)
scripts/check_import_boundary.py            boundary holds (engine=OK, frontend=OK, private-fields=OK), 1687 files
scripts/check_metric_declared.py            PASS — every metric a surface can request is declared
node scripts/check_no_plants.mjs            PASS — 897 product source files; PLANT_MANIFEST.json plants == []
```

Critic harnesses re-run against the fix (scratchpad, unchanged except
`attack_ai_seams` tolerating the retired `serve.attach_explanations`):

```
plant_harness.py   A1-A3, A6-A9, B6-B7, C1-C8, D1-D8, E1-E3, E5, F1-F7, G1b: REFUSED, class named in the reason
                   B1-B5, C9-C10, E4, G2 (Romanian-only plants): EN served, RO ABSENT (stated), refusal journalled
                   with its class — Romanian is additive, its failure mode is honest absence, not a regeneration
                   A4/A5 ("461-{{money}}", "461: {{money}}"): served — the label binds to the right figure
                   (the token regex needs " RON" adjacency to mis-bind); not a defect the critic listed
attack_ai_seams    hostile severity/rank/suppress: rows byte-identical, 0 ranking keys, 'planted_by_model' absent;
                   model dead: rows 4/4 in 0.0004 s, 0 raw payload signatures; model 30 s slow: rows served
                   in 0.0004 s while the thread sleeps; _radar.py references the explain lane: True
provenance_trace   B3 residuals unchanged and NOT this lane's (cash / total_cash / net_debt / ebitda_statutory /
                   affiliate_income resolve through no FactsGateway accessor); net_income on retail now
                   resolves: gateway.statement_line('current_year_profit') == 3,205,212.62
attack_r1_prod_projection   DIFFS=0 on every book with the PROJECTING fake (the serve lane's p121 alias landed)
attack_cap_dismiss          serve lane's (A3/A4) — output pasted in the handover, not this lane's
```

---

## The plants — TC-2, in an isolated copy

Every plant below was applied in an rsync'd copy of the tree
(`<scratch>/sandbox`, `.venv` symlinked, `tests/conftest.py` puts the
copy's `src` first — verified `engine.ai.finding_sharpen.__file__` and
`engine.radar.explain.__file__` resolve inside the copy), registered in
THAT copy's `design_review/PLANT_MANIFEST.json` while live, observed RED
through the gate's own message, reverted from the live tree's file,
observed GREEN. The live tree was never modified; its manifest stayed
empty and `check_no_plants.mjs` passes. Driver:
`<scratch>/lane-explain/run_plants.py` + `run_plants2.py`; transcripts in
`plants.log` / `plants2.log`. (The first pass of P1 and P5 went red for
the WRONG reason — the driver glued the next source line into the plant's
marker comment, an IndentationError — and was discarded; the transcripts
below are the re-run.)

**GREEN** — the clean copy: `185 passed, 2 skipped` (explain + sharpen).

### PLANT P1 — the number-word law disabled

```diff
--- src/engine/ai/finding_sharpen.py (numeral_violations, step 6)
     names = [t[0] for t in tokens]
+    tokens = []  # PLANT P1 — number words not refused
```

**RED** — exit 1, `17 failed, 168 passed, 2 skipped`:

```
E   AssertionError: ('ro-de-trei-ori', 'soldul este de trei ori mai mare decât anul trecut.')
E   assert ()
E   AssertionError: (' It has grown forty-seven percent since last year.', '', 'Explanation served from cache; …')
E   assert '' == 'numeral_refused'
E   AssertionError: ('saga_10_col', 'leverage_debt_to_ebitda|162,167,519', 'number word')
E   assert 'cached' == 'absent'
FAILED test_finding_sharpen.py::test_s3_the_numeral_law_refuses_every_class_by_name[ro-de-trei-ori]
FAILED …[ro-treizeci-de-zile] …[ro-doua-milioane] …[en-forty-seven-percent] …[en-doubled] …[en-a-third]
FAILED …[en-half] …[en-tripled] …[en-twelve-years] …[en-one-year] …[en-a-quarter-of] …[ro-de-zece-ori]
FAILED test_finding_sharpen.py::test_s3_number_words_the_engine_itself_wrote_are_allowed_and_only_those
FAILED test_finding_sharpen.py::test_s3_a_romanian_number_word_is_refused_and_named
FAILED test_radar_explain.py::test_r5_the_served_guard_names_every_class_in_its_reason
FAILED test_radar_explain.py::test_r5_a_romanian_number_word_never_reaches_the_served_shape
FAILED test_radar_explain.py::test_b2_the_cache_path_runs_every_fresh_check_on_read_for_every_subject
```

**REVERT** — exit 0: `185 passed, 2 skipped`.

### PLANT P2 — the cache path skips the self-review re-check

```diff
--- src/engine/radar/explain.py (_from_cache, step 4)
-    review_issues = served_review_problems(en, ro, review)
+    review_issues = ()  # PLANT P2 — cache read skips the review re-check
```

**RED** — exit 1, `2 failed, 45 passed, 1 skipped`:

```
E   AssertionError: ('saga_10_col', 'leverage_debt_to_ebitda|162,167,519', 'review empty')
E   assert 'cached' == 'absent'
E   AssertionError: assert '' == 'review_missing'
FAILED test_radar_explain.py::test_b2_the_cache_path_runs_every_fresh_check_on_read_for_every_subject
FAILED test_radar_explain.py::test_b2_a_record_is_refused_at_todays_floor_not_the_one_it_was_written_under
```

A record with `review: []` was served as `cached` — the critic's B2
plant, reproduced by the gate. **REVERT** — exit 0: `47 passed, 1 skipped`.

### PLANT P3 — the guard's placeholder regex looser than the resolver's

```diff
--- src/engine/ai/finding_sharpen.py
-_PLACEHOLDER_RX = re.compile(
-    r"\{\{money:(?P<name>[A-Za-z0-9_]+)(?P<opts>(?:\|[a-z0-9]+)*)\}\}")
+_PLACEHOLDER_RX = re.compile(r"\{\{money:(?P<name>[A-Za-z0-9_]+)(?P<opts>(?:\|[^}]*)?)\}\}")  # PLANT P3
```

**RED** — exit 1, `4 failed, 134 passed, 1 skipped`:

```
E   AssertionError: ('unresolved-Bare', ('placeholder option',), ("placeholder option: {{money:intercompany_loans|Bare}} — …
E   assert 'unresolved placeholder' in ('placeholder option',)
E   AssertionError: assert '\\{\\{money:...^}]*)?)\\}\\}' == '\\{\\{money:...-9]+)*)\\}\\}'
FAILED …test_s3_the_numeral_law_refuses_every_class_by_name[unresolved-Bare] …[unresolved-BARE] …[unresolved-trailing-space]
FAILED test_finding_sharpen.py::test_s3_the_placeholder_regex_is_the_resolvers
```

With the loose regex `{{money:x|Bare}}` is classed as an OPTION of a
placeholder the guard would then strip — the resolver never resolves it,
so on the served path it is literal braces. **REVERT** — exit 0:
`138 passed, 1 skipped`.

### PLANT P4 — currency labels judged upper-case only, across whitespace only

```diff
--- src/engine/ai/finding_sharpen.py
-_CURRENCY_TOKEN_RX = re.compile(r"(?:%s)|(?:(?<![A-Za-z])(?:euro|…)(?![A-Za-z]))" % numerals._CURRENCY_TOKEN_RE.pattern, re.IGNORECASE)
+_CURRENCY_TOKEN_RX = re.compile(r"(?<![A-Za-z])(?:RON|LEI|EUR|USD|GBP|HUF)(?![A-Za-z])")  # PLANT P4
-_GLUE_CHARS = " \t\n\r-–—:;,./()[]'\"«»"
+_GLUE_CHARS = " "  # PLANT P4b
```

**RED** — exit 1, `12 failed, 173 passed, 2 skipped`:

```
E   AssertionError: ('cur-lei-after', 'the balance of {{money:intercompany_loans}} lei is group money.')
E   assert ()
E   AssertionError: (' The balance of RON 13,012,977 euro is group money.', '', 'Explanation served from cache; …')
E   assert '' == 'numeral_refused'
FAILED …[cur-lei-after] …[cur-euro-after] …[cur-EURO-after] …[cur-symbol-after] …[cur-lei-before]
FAILED …[cur-EUR-dash-before] …[cur-in-EUR-colon] …[cur-Lei-cased] …[cur-ron-lower] …[cur-ro-lei] …[cur-ro-euro]
FAILED test_radar_explain.py::test_r5_the_served_guard_names_every_class_in_its_reason
```

"RON 13,012,977 euro" served from cache — the critic's C2, on the cache
path. **REVERT** — exit 0: `185 passed, 2 skipped`.

### PLANT P5 — the cache path skips the finding-contract re-check

```diff
--- src/engine/radar/explain.py (_from_cache, step 3)
-    en_problems, ro_problems = served_contract_problems(subject.finding, en, ro)
+    en_problems, ro_problems = (), ()  # PLANT P5 — cache read skips the contract re-check
```

**RED** — exit 1, `1 failed, 46 passed, 1 skipped`:

```
E   AssertionError: ('saga_10_col', 'leverage_debt_to_ebitda|162,167,519', 'hedge')
E   assert 'cached' == 'absent'
FAILED test_radar_explain.py::test_b2_the_cache_path_runs_every_fresh_check_on_read_for_every_subject
```

"The board should keep an eye on it" served as `cached`. **REVERT** —
exit 0: `47 passed, 1 skipped`.

### PLANT P6 — the explain fixtures captured on the assemble path (the B4 defect restored)

```diff
--- tests/engine/fixtures/radar/explain/capture.py (served_statements)
-    statements = serve_capture.served_statements(
-        case_id, envelope, line_items, currency, period_end)
+    statements = assembled_statements  # PLANT P6 — capture on the assemble path
```

then the capture re-run in the copy (exit 0 — it WROTE `saga_10_col_agras.json`
with total_assets 39,272,501.03, the assemble-path figure).

**RED** — exit 1, `3 failed, 2 passed` (`-k "b4 or tc1"`):

```
E   AssertionError: the canary stopped separating the two seams
E   assert (39272501.03 != 39272501.03 or 'saga_10_col_agras' != 'saga_10_col_agras')
E   AssertionError: ('saga_10_col', None)
E   assert None == 'envelope_p121_cross_check'
E   AssertionError: saga_10_col / liquidity_cash_tight|5121,5124,531: facts_cited differ between the explain fixture and the
    serve fixture's single_period payload. The serve fixture's served net income equals the envelope's account 121 … so the
    explain capture is off the served seam
E   assert {'cash': 1255...': 28988864.4} == {'cash': 1255...: 28988636.56}
FAILED test_radar_explain.py::test_b4_every_explain_fixture_was_captured_on_the_served_seam
FAILED test_radar_explain.py::test_b4_served_net_income_is_account_121_on_every_fixture
FAILED test_radar_explain.py::test_b4_facts_cited_per_subject_equal_the_serve_lanes_rows
```

Note the third message: it names WHICH lane's fixture is off the seam,
measured by the serve fixture's own envelope. **REVERT** (capture + the
five fixtures) — exit 0: `5 passed`.

### PLANT P7 — the served seam drops the account-121 anchor (sandbox `pipeline.py`, the NET_INCOME_ANCHOR "resolved but not applied" plant)

```diff
--- src/engine/api/pipeline.py (_assemble_with_statutory_anchor)
-    assembled = assembler(accounts, **assemble_kwargs, **anchor_kwargs)
+    assembled = assembler(accounts, **assemble_kwargs)  # PLANT P7 — anchor resolved but not applied
```

The capture REFUSES — `--check` exit 2:

```
REFUSED saga_10_col: the served seam handed back net_income_statutory=171665.97 (anchor source
'envelope_p121_cross_check') while the envelope's account 121 is 402869.16. The net-income anchor is
not threaded on this seam; refusing to write a fixture that would pin the reconstruction as expected.
```

**RED** — exit 1, `1 failed, 4 passed`: `FAILED
test_radar_explain.py::test_tc1_the_capture_script_agrees_with_the_committed_fixtures`
(the chain raises `UnanchoredSeam` instead of producing a fixture).
**REVERT** — exit 0, `--check` OK ×5, `5 passed`.

Verdict for B1, B2, B4 and the anchor rule: **PROVEN RED**, seven plants,
seven reverts. (B7's evidence is the baseline itself: `test_s8` failed in
every full run before this wave and passes in every full run after it.)

---

## The live path — credits are live, measured not targeted

`RADAR_EXPLAIN_LIVE=1 RADAR_EXPLAIN_LIVE_JOURNAL=<scratch>/lane-explain/live-journal*`
over the SAME seven real findings as the first build (`saga_10_col_carniprod`: 3,
`saga_10_col_agras`: 4), production factories, the realestate profile as
the reviewer's decoy, scratch breaker / cache dirs, every `SUPABASE*`
variable stripped from the environment. The journal is kept (the env var
is honoured), so every attempt-1 refusal is recoverable with its
`rejected_draft`.

### Run 1 — the law as first written (`1 passed in 345.43s`)

Refusal kinds measured, by finding:

| period | finding | outcome |
|---|---|---|
| carniprod | equity_quality_revaluation_reserves\|105 | `advisory_unavailable` — `model_error`: the `finding_specificity` reviewer did not return usable JSON (not a numeral refusal; a strict-JSON failure on the reviewer role) |
| carniprod | fx_exposure\|5124,765,665 | attempt 1 REFUSED — `number word: 'two' counts a unit the engine never wrote ('weeks')` (a made-up horizon); attempt 2 accepted, EN 0.70, RO 0.80 |
| carniprod | input_cost_exposure\|601,602,607 | attempts 1 and 2 REFUSED — `'three' counts a unit the engine never wrote ('quarters')`, `'three'` (the top three suppliers), AND `'quarters' … (a fraction)` on the ENGINE'S OWN step "Hedge the next two quarters of input volume" — a FALSE POSITIVE (see below) → deterministic template |
| agras | liquidity_cash_tight\|5121,5124,531 | attempt 1 REFUSED — `'fifth'` ×2 ("over a fifth of assets"); attempt 2 REFUSED — `numeral '411'` (uncited code) + `'quarter' … (a fraction)` ("roughly a quarter of assets") → deterministic template |
| agras | concentration_related_party\|461,451,452,455 | accepted, EN 0.65, RO 0.60 (attempt 1) |
| agras | fx_exposure\|5124,765,665 | accepted, EN 0.70, RO 0.70 |
| agras | input_cost_exposure\|601,602,607 | attempt 1 REFUSED — `'quarters' … (a fraction)` on the engine's own step; attempt 2 REFUSED — `'trimestre' … (a fraction)` (the model reached for the Romanian peer of the same phrase) → deterministic template — the SAME false positive |

Specificity distribution (6 reviewed drafts): min 0.60, max 0.80, floor
0.60, 0 below floor; `concentration_related_party` n=2 mean 0.625,
`fx_exposure` n=4 mean 0.725.

**What run 1 taught, and the fix.** The unit word of an allowed bigram
("two quarters") was judged again on its own and, followed by "of",
refused as a fraction — so a rewrite echoing the engine's own step burned
its regeneration on two of seven findings. `numeral_violations` now marks
the unit token of an allowed bigram as consumed
(`test_s3_number_words_the_engine_itself_wrote_are_allowed_and_only_those`
pins "Hedge the next two quarters of input volume behind 601." and its
Romanian peer as allowed, "three quarters" and "a quarter of" as refused).
The other refusals were correct: "two weeks", "top three", "a fifth",
"411", "a quarter of assets" are quantities the engine never computed.

### Run 2 — after the bigram fix (`1 passed in 425.16s`)

```
STATUSES: ['fresh', 'fresh', 'fresh', 'fresh', 'fresh', 'fresh', 'absent']
```

| period | finding | EN | attempts | RO |
|---|---|---|---|---|
| carniprod | equity_quality_revaluation_reserves\|105 | 0.65 | **2** — attempt 1 REFUSED `number word: 'half'` ("more than half of it"), `'fourteen' counts a unit the engine never wrote ('points')` | absent — the RO reviewer call returned no usable JSON (`model_error`), stated |
| carniprod | fx_exposure\|5124,765,665 | 0.70 | 1 | absent — RO reviewer `model_error`, stated |
| carniprod | input_cost_exposure\|601,602,607 | 0.60 (at the floor) | 1 | 0.70 — the run-1 false positive is gone |
| agras | liquidity_cash_tight\|5121,5124,531 | 0.70 | 1 | 0.70 |
| agras | concentration_related_party\|461,451,452,455 | 0.70 | 1 | absent — RO REFUSED `ledger code as quantity: 451 … preceded by 'de'` on "din contul 461, **alături de** 451, 452 și 455" — a FALSE POSITIVE ("alături de" = alongside); see run 3 |
| agras | fx_exposure\|5124,765,665 | 0.60 | 1 | 0.60 |
| agras | input_cost_exposure\|601,602,607 | — | attempt 1 scored **0.50**, regenerated; attempt 2 REFUSED `'three' … (followed by 'times')` ("roughly three times a year"), `'quarter' … (a fraction)` ("about a quarter of assets"), `'three'` → `advisory_unavailable`, deterministic template | — |

Specificity distribution (10 reviewed drafts, 7 EN + 3 RO): min 0.50,
p10 0.60, median 0.65, mean 0.645, max 0.70, floor 0.60, 1 below floor
(regenerated). Refusal kinds measured: `number word` ×5 (half, fourteen
points, three times, a quarter of, three — every one a quantity the
engine never computed), `ledger code as quantity` ×1 (the RO false
positive), reviewer `model_error` ×2 (Romanian halves only), specificity
below floor ×1.

**What run 2 taught, and the fix.** Bare Romanian "de" was on the
comparator list (the critic's "de 461 ori"); it refused "alături de
451". A Romanian count written with "de" carries its unit AFTER the
token ("de 461 ori", "de 461 de zile", "de trei ori") and the unit check
already refuses those — so "de" alone is not a comparator any more,
pinned by the `ro-alaturi-de-451` and `ro-fata-de-461` allowances and the
`code-ro-ori` / `code-ro-zile` / `ro-de-trei-ori` refusals.

### Run 3 — the final law (`1 passed in 415.39s`)

```
STATUSES: ['fresh', 'fresh', 'fresh', 'fresh', 'fresh', 'fresh', 'fresh']
```

| period | finding | EN | attempts | RO |
|---|---|---|---|---|
| carniprod | equity_quality_revaluation_reserves\|105 | 0.75 | **2** — attempt 1 REFUSED `numeral: '84.9'`, `numeral: '71.1'` (the model computed equity ratios itself), `number word: 'three' counts a unit the engine never wrote ('quarters')` | 0.75 |
| carniprod | fx_exposure\|5124,765,665 | 0.60 (at the floor) | **2** — attempt 1 REFUSED `numeral: '1.4'` ×2 (an invented multiple) | 0.75 |
| carniprod | input_cost_exposure\|601,602,607 | 0.70 | **2** — attempt 1 REFUSED `number word: 'half'` | 0.75 |
| agras | liquidity_cash_tight\|5121,5124,531 | 0.75 | 1 | 0.70 |
| agras | concentration_related_party\|461,451,452,455 | 0.70 | 1 | 0.70 — "alături de 451" now allowed |
| agras | fx_exposure\|5124,765,665 | 0.70 | 1 | 0.70 |
| agras | input_cost_exposure\|601,602,607 | 0.60 (at the floor) | 1 | 0.75 |

Specificity distribution (14 reviewed drafts, 7 EN + 7 RO, every one
accepted): min 0.60, median 0.70, mean 0.707, max 0.75, floor 0.60, 0
below floor. Refusal kinds measured: `numeral` ×4 (84.9, 71.1, 1.4, 1.4
— ratios and a multiple the model computed itself, exactly the C1
class), `number word` ×2 (three quarters, half); three of seven findings
used their one regeneration and cleared on the second draft; no
`contract_refused`, no reviewer error, no false positive. Every served
rationale and step passed `served_numeral_violations` (asserted in the
test); every `reason` is a sentence; every attempt-1 refusal is in
`<scratch>/lane-explain/live-journal-run3/finding_sharpen.jsonl` with its
`rejected_draft`.

Reading the three runs honestly: 7/7, 6/7, 7/7 explained; 0, 3 and 0
false positives; the distribution sits in a 0.60–0.80 band across all
three with nothing rejected by the reviewer for being generic except one
0.50 in run 2. Fourteen accepted out of fourteen is a statement about
THIS run's seven findings, not a target.

---

## Handoffs for the coordinator — VERBATIM, this lane does not edit these files

### 1. `scripts/run_battery.py` — one Gate, immediately BEFORE `Gate("determinism", ...)`

Floor and canaries UPDATED from the first build's hand-off (measured 47
tests + 1 env-gated skip → floor 40; the canaries now include the B2
census, the class-naming served guard and the B4 cross-check).

```python
        # R5-R7 + B1/B2/B4 — RADAR, AI EXPLANATION IN ITS LANE (engine.radar.explain).
        # R5: no model QUANTITY in a SERVED explanation — ONE numeral law
        # (finding_sharpen.numeral_violations: ASCII figures, number words
        # EN+RO, currency labels in any case on either side of a figure,
        # Unicode and Roman numerals, a ledger code used as a quantity,
        # placeholder options, unresolved placeholders), run at draft and
        # again on the served text, cache included, each refusal naming
        # its class. B2: the cache path re-runs the fresh checks on read
        # (numeral law, finding contract through the seam, self-review at
        # today's floor, source re-derived) — a failing record is a miss
        # with its kind, redrafted, never served. B4: the fixtures are the
        # SERVED seam's output and agree subject-by-subject with the serve
        # lane's; net income is account 121 or the capture refuses. R6:
        # model dead -> rows complete, `explanation: absent`, zero raw
        # payload; the critical path is cache-only. R7: read-only
        # projection, prose-only output, every other engine.radar module
        # model-free. Named separately from `pytest` because a model that
        # quietly reaches into ranking fails silently. Plant log:
        # design_review/radar/EXPLAIN_GATES.md (P1-P7) and gates.md below.
        Gate("radar-explain-gates",
             [PY, "-m", "pytest", "tests/engine/test_radar_explain.py", "-q"],
             work_junit=True, floor=40, units="tests",
             canaries=("test_r5_plant_a_poisoned_cache_record_the_served_guard_refuses_it",
                       "test_r5_the_served_guard_names_every_class_in_its_reason",
                       "test_b2_the_cache_path_runs_every_fresh_check_on_read_for_every_subject",
                       "test_b4_facts_cited_per_subject_equal_the_serve_lanes_rows",
                       "test_r6_model_dead_rows_complete_explanation_absent_zero_raw_payload",
                       "test_r7_plant_a_model_that_returns_a_changed_severity_the_row_is_unchanged")),
```

### 2. `docs/engine_book/gates.md` — one section, insert after `## cron-auth`

````markdown
## radar-explain-gates

Radar's AI explanation lane (`engine.radar.explain`) attaches prose to
rows that were ranked, capped and dismissed before it existed, and no
quantity a model wrote reaches a reader. Two adversarial critics
(2026-09-04) showed ten classes of model-authored quantity shipping
`status=fresh` on the real agras 461 finding — number words in both
languages, `euro` beside a placeholder, `|abs` flipping a sign,
`{{money:x|Bare}}` shipped as literal braces, `461%` — and a cache path
that served a record with `review: []`, `specificity: null` and hedge
prose as `cached`. This gate is the suite that reds on each of those.

| | |
|---|---|
| command | `python -m pytest tests/engine/test_radar_explain.py -q` |
| work count | junit-xml, floor **40** tests (measured 47 + 1 env-gated live skip) |
| canary | `test_r5_plant_a_poisoned_cache_record_the_served_guard_refuses_it`, `test_r5_the_served_guard_names_every_class_in_its_reason`, `test_b2_the_cache_path_runs_every_fresh_check_on_read_for_every_subject`, `test_b4_facts_cited_per_subject_equal_the_serve_lanes_rows`, `test_r6_model_dead_rows_complete_explanation_absent_zero_raw_payload`, `test_r7_plant_a_model_that_returns_a_changed_severity_the_row_is_unchanged` |

Subjects are the five explain fixtures — real corpus books through the
SERVED seam (the serve lane's capture module, loaded by path) — with
every model call stubbed; the live path is env-gated and CI never runs
it. The numeral law is ONE function, `finding_sharpen.numeral_violations`,
run at draft and again on the served text, so the same gate covers the
Capsule's sharpening.

**GREEN** — exit `0`: `47 passed, 1 skipped`.

**PLANT** (one of seven; the full log with diffs is in
`design_review/radar/EXPLAIN_GATES.md`) — `src/engine/radar/explain.py`,
`_from_cache` step 4: `review_issues = ()` — the cache path skips the
self-review re-check.

**RED** — exit `1`, `2 failed, 45 passed, 1 skipped`, through the gate's
own message:

```
E   AssertionError: ('saga_10_col', 'leverage_debt_to_ebitda|162,167,519', 'review empty')
E   assert 'cached' == 'absent'
FAILED tests/engine/test_radar_explain.py::test_b2_the_cache_path_runs_every_fresh_check_on_read_for_every_subject
FAILED tests/engine/test_radar_explain.py::test_b2_a_record_is_refused_at_todays_floor_not_the_one_it_was_written_under
```

A second plant on the law itself — the number-word scan emptied in
`finding_sharpen.numeral_violations` — is `17 failed` across this suite
and `test_finding_sharpen.py` (`ro-de-trei-ori`, `en-forty-seven-percent`,
`en-a-third`, the census, the Romanian served-shape test); a third, the
placeholder regex loosened to the shape the resolver does not resolve,
reds `test_s3_the_placeholder_regex_is_the_resolvers` and the three
`unresolved-*` plants.

**REVERT** — exit `0`: `47 passed, 1 skipped`; no `# PLANT` marker left,
`PLANT_MANIFEST.json` plants `[]`. Verdict: proven RED.
````

### 3. `src/engine/ai/models.yaml` — the `radar_explain` block, comment only (no key changes; `prompt_version` stays `radar_explain_v1` — the composite key moved through `finding_sharpen_draft_v2` + `numeral_law_v2` + `CACHE_VERSION 2`)

Replace the comment lines from `# Numerals in` through `# cached explanation.` with:

```yaml
    # A model QUANTITY never reaches a reader: ONE numeral law
    # (engine.ai.finding_sharpen.numeral_violations — ASCII figures,
    # number words EN+RO, currency labels in any case beside a figure,
    # Unicode and Roman numerals, a ledger code used as a quantity,
    # placeholder options, unresolved placeholders) is run at draft,
    # regenerated once, then the deterministic template ships — and run
    # AGAIN on the SERVED text. A cache record is re-checked on every
    # read against the same law, the finding contract and the
    # specificity floor; a failing record is a miss, redrafted. The
    # cache key is (org, period, snapshot hash, finding id, composite
    # prompt version = this row's prompt_version | the drafting prompt |
    # the reviewing prompt | the numeral law version); bump any of them
    # to invalidate every cached explanation.
```

### 4. `src/engine/api/server.py` — unchanged from the serve lane's hand-off (the router is still not mounted: `server.py mounts the radar router: False`, measured by `attack_ai_seams`).

### 5. Not this lane's, seen while measuring

- `engine.ai.numerals.guard` (the firm-brief lane's ENFORCE-mode law) still
  refuses ASCII digits and currency tokens only — number words, Unicode
  numerals and Roman numerals pass it. The classes live in
  `finding_sharpen` now; lifting `_is_unicode_numeral`, `_roman_numerals`
  and the number-word tables into `numerals` would give the brief the same
  law. Handed as an observation, not applied.
- B3 (provenance): `cash`, `total_cash`, `net_debt`, `ebitda_statutory`,
  `affiliate_income` on served rows still resolve through no
  `FactsGateway` accessor (`provenance_trace.py`, unchanged); row
  `provenance.snapshot_id` is the source document id, the gateway's is the
  content hash. Shared files (`serving/facts.py`, `findings/*`).
- `scripts/run_battery.py` (2026-09-05, this tree): **37/40 green, 1
  VACUOUS (`public-sitemaps`), 2 red — `engine-book`
  (`test_regeneration_is_byte_identical`, the coordinator's pending
  regeneration of `architecture.md` for the `engine.radar` package) and
  `pytest` (8 failures: `public/intelligence/test_signal_ordering_sweep`,
  `test_public_egress` — the public wave's; `test_engine_book`; and five
  in `test_radar_gates.py` / `test_radar_route.py` that were the serve
  lane's IN-FLIGHT edits at the moment the battery ran — re-run
  afterwards, those two files are `84 passed`, and four of the route
  tests FAIL with this lane's `finding_sharpen.py` stashed back to HEAD,
  i.e. the route gate now depends on this wave's cache-read kinds). Every
  gate of this lane inside `pytest` was green in that run.
  `firm-tenancy-fc1` no longer appears in the battery (the Cockpit merge
  removed it).
