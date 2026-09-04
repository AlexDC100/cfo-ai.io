# The account-121 anchor reached the persist path and no other

**Status:** fixed, gated. **Measured:** 2026-09-04, offline, golden corpus.
**Owner surface:** `src/engine/api/pipeline.py`.

---

## 1. The rule

CLAUDE.md Appendix A §3 and Appendix B Step 11:

> The closing balance of account 121 (PROFIT SI PIERDERE) **IS** the statutory
> net profit. The class-6/7 reconstruction is the **validation check**, not the
> authoritative number.

`chart_of_accounts.assemble_statements()` implements it (~1069-1112): it builds
`net_income_statutory = net_income_operational + capitalized`, then overrides
that with account 121 when the two diverge by more than 5% of
`max(|121|, 100_000)`.

It can only do so when a caller hands it `account_121_anchor_override`.
`accounts_to_assemble_shape()` routes 121 to `ignore_control` and drops the row
before assembly, so the assembler cannot see 121 by itself.

## 2. The defect

Four call sites in `pipeline.py` assemble. One threaded the anchor.

| line (pre-fix) | site | anchor before | serves |
|---|---|---|---|
| 1501 | `stage_map` — the persist path | **threaded** | `calculated_metrics`, the persisted envelope |
| 4775 | `_rebuild_assembled_for_briefing` — the seam | missing | Capsule statements context, Radar, firm attention lane, briefing regenerate |
| 6822 | `GET /api/period/{period_id}` — a DIRECT call, not via the seam | missing | Statements page P&L, Valuation tab, cash-flow statement, NAV cascade |
| 7796 | `POST /api/period/{period_id}/review/reanalyze` | missing | the Review-Mode confidence verdict |

Every rebuild path therefore served a raw class-6/7 reconstruction under the
name `net_income_statutory`, on books whose account 121 says something else.

### Measured, through the seam itself

Real deterministic lane → real `stage_map` → real `stage_persist` → the seam.
Account 121 read from the persisted envelope's
`canonical_bs.invariants.p121_cross_check.p121`.

| book | account 121 | rebuild served | factor |
|---|---|---|---|
| `saga_10_col_realestate` | −801,604.14 | −30,391,418.38 | 37.9× |
| `saga_10_col_carniprod` | 1,435,533.59 | 5,843,449.04 | 4.1× |
| `saga_10_col_agras` | 7,533,676.02 | 14,106,102.03 | 1.9× |
| `pdf_positional` | 650,887.06 | 615,350.00 | 0.95× |
| `saga_10_col_retail` | 3,205,212.62 | 1,161,957.98 | 0.36× |
| `saga_10_col` | 402,869.16 | 171,665.97 | 0.43× |
| `saga_compact_6_col` | 0.00 | 500.00 | within band |

### It was never one field

`net_income_statutory` feeds `free_cash_flow_proxy`, and — via
`chart_of_accounts.py:1324-1328` — `assembled_bs.retainedEarnings`,
`assembled_bs.current_year_pnl` and `assembled_bs.total_equity`.
Field-level diff, rebuild vs the write path, across the 7 books:

```
TOTAL PL field disagreements: 12 -> 0
TOTAL BS field disagreements: 18 -> 0
```

Worst single case — `saga_10_col_realestate`, the NAV cascade's book-equity
floor (`frontend/lib/buildNavCascade.ts:313`):

```
BS total_equity        written 40,284,134.73   served 10,694,320.49   (3.8x understated)
BS bs_balance_delta    written          0.05   served 29,589,814.29
PL free_cash_flow_proxy written  -739,384.70   served -30,329,198.94
```

### A second live symptom: fabricated balance-sheet drift

`POST /review/reanalyze` returns only a confidence report, but the inflated
`total_equity` reaches it through the balance-sheet residual. Reanalysing with
**no overrides** — which re-buckets nothing and must reproduce the write path —
measured through the real route:

| | anchored | unanchored |
|---|---|---|
| `reconciliation_residual_pct` (agras) | 0.1187 | **16.8541** |
| `reconciliation_status` | green | **red** |
| `review_mode_required` | False | **True** |

The missing anchor told users their balance sheet did not balance when it did.

## 3. Which source is authoritative

Two candidates carry account 121 on the envelope. They are not interchangeable.

**`canonical_bs.invariants.p121_cross_check.p121` — authoritative.** It is
literally the value `pack.compute_statutory_net_profit_anchor(tb_rows)`
returned at write time, carried through
`chart_of_accounts.py:1714 → canonical_adapter.py:1556` and rounded to the
cent. Nothing downstream mutates it.

**`rows[id=current_year_profit].amount` — NOT the anchor.** Under
`result_basis == "sf_closing_column"` it is `p121_cents + pl_net_cents`
(`canonical_adapter.py:1258-1263`), so the P&L net leaks in. Measured on
`saga_compact_6_col`: the row reads **500.00** against an account 121 of
**0.00**. It also flips its id to `current_year_loss` on a negative result
(so `saga_10_col_realestate` has no `current_year_profit` row at all) and is
omitted entirely when the result is zero. It is a presentation row.

**`invariants.p121_cross_check.cls7_minus_cls6` is not a usable
reconstruction** and nothing should be built on it. It is
`net_income_operational + capitalized_own_work + inventory_variation_memo` —
the class-7-minus-class-6 identity *including* the 711 production-variation
memo. On `saga_10_col_agras` it reads **206,197,948.36** against an account 121
of 7,533,676.02, because 711 movements are summed gross. It exists for the D6
diagnosis only and never auto-corrects anything.

**A persisted 121 line item — dormant, kept anyway.** Measured: `stage_persist`
writes **0** rows with a 121 code across all 7 books, because
`accounts_to_assemble_shape()` drops the `ignore_control` bucket. The fallback
stays because a non-deterministic extraction lane may emit one, and if the
mapping ever stops dropping 121 the line item must win over a silent
reconstruction. `test_a_persisted_121_line_item_would_anchor_the_seam` asserts
both the dormancy and the behaviour.

## 4. The fix

One helper, called at every rebuild site, that fuses the three acts that were
previously separable:

```python
_assemble_with_statutory_anchor(assembler, accounts, *, period_row, line_items, **kw)
    anchor, source = _statutory_anchor_for(period_row, line_items)   # resolve
    kwargs         = _anchor_kwargs(assembler, anchor)               # thread
    assembled      = assembler(accounts, **kw, **kwargs)
    _annotate_net_income_anchor(assembled, anchor, source,           # label
                                applied=_anchor_reached_the_assembler(...))
```

The defect was not a wrong number; it was that resolving the anchor, passing
it, and telling the reader what happened were three separable acts, so a seam
could do one and skip the others and still look finished.

`_anchor_kwargs` probes the assembler's signature before passing. This is
load-bearing, not defensive noise: `review/reanalyze` assembles through
`get_pack(confirmed_country_code)`, and `hu_hungary/pack.py:127` has no such
parameter — an RO period (whose envelope *does* carry a p121) reanalysed under
a confirmed country of HU would raise `TypeError` and 500 the route.

`_anchor_reached_the_assembler` reads whether the anchor landed off the
assembler's **own output** (`assembled_canonical_v1.canonical_bs.invariants
.p121_cross_check.p121`), never off the caller's intent. Trusting
`bool(anchor_kwargs)` would mean trusting that the kwargs dict we built was
also passed — precisely the class of mistake being removed. A site that
resolves an anchor and drops it on the way must be labelled `absent`, not
`within_tolerance`.

### Fields emitted on every path, persist and rebuild alike

On `statements.assembled_pl`:

| field | meaning |
|---|---|
| `net_income_statutory` | unchanged, never nulled |
| `net_income_reconstructed` | the class-6/7 build-up = `net_income_operational + capitalized_own_work_memo` — the assembler's own pre-override expression (`chart_of_accounts.py:1069`), so it costs no second assembly |
| `net_income_statutory_anchor` | account 121, or null |
| `net_income_anchor_source` | `envelope_p121_cross_check` \| `line_items_121` \| `parsed_tb_rows` \| null |
| `net_income_anchor_status` | `anchored` \| `within_tolerance` \| `absent` |

`net_income_statutory` is deliberately **kept, never nulled**. The frontend
reads it through `?? 0` fallbacks (`frontend/lib/canonicalMetrics.ts:39`,
`:223`, `:320`; `buildCashFlowStatement.ts:80`; `buildNavCascade.ts:313`), so a
null would render as a fabricated zero. A labelled number the reader can check
beats a blank they cannot.

Status is **observed, not re-derived**: `anchored` means the served figure
equals the anchor to the cent, which is true exactly when the assembler's
5%-of-`max(|121|, 100k)` override fired. The threshold is not duplicated here,
so this helper cannot drift away from the rule it reports on.

`within_tolerance` is a real state, not a rounding artefact:
`saga_compact_6_col` has account 121 = 0.00 and a reconstruction of 500.00, and
`max(|0|, 100_000) × 5% = 5,000`, so the assembler deliberately keeps 500.00.
The payload carries the anchor alongside it so the gap stays visible.

## 5. The other kwargs the persist path passes — measured, not assumed

`stage_map` passes six kwargs the rebuild sites did not. Only one reaches a
served **number**. Measured by rebuilding each book three ways (bare / anchor
only / all six) and byte-diffing the served `statements` after
`_apply_envelope_truth_to_statements`:

| kwarg | reaches the served payload? | why |
|---|---|---|
| `account_121_anchor_override` | **yes — a number** | this defect |
| `source_data_quality` | yes, as telemetry only | surfaces `raw_imbalance_abs/_pct/warn` on the envelope; no statement figure |
| `source_anchor` | no | superseded |
| `extraction_meta` | no | superseded |
| `source_account_census` | no | superseded |
| `extra_unmapped` | no | superseded |

"Superseded" is exact: `_apply_envelope_truth_to_statements` replaces
`statements.assembled_canonical_v1.canonical_bs` with the **persisted** object
(and pops it entirely when there is no envelope), so the canonical_bs-shaping
kwargs cannot influence what is served from a rebuild.

`source_data_quality` was deliberately **not** threaded: it is computed from
the raw `sf_d`/`sf_c` rows, which the persisted `statement_line_items` no
longer carry, so it is not recoverable at a rebuild seam — and it is already on
the persisted envelope. Faking it would be worse than its absence.

## 6. Known residual — the Radar surface

`_radar.LIGHT_PERIOD_COLUMNS` (`_radar.py:64`) selects
`assembled_canonical_v1->>schema_version` but never the envelope object, so
`load_statements()` hands the seam a row with no anchor on it. Measured per
consumer:

| consumer | row shape | status |
|---|---|---|
| `GET /api/period` | full row | `anchored` |
| `_capsule_tools.py:1685` | full row | `anchored` |
| `_firm_attention.py:360` | full row | `anchored` |
| `_radar.py:217` `load_statements` | LIGHT, no envelope | **`absent`** |

This is now honest rather than silent — Radar's figure is labelled a
reconstruction — but it is still a reconstruction.

**Handover (a one-line change in a file this lane does not own).** Add one
scalar column to `LIGHT_PERIOD_COLUMNS`; no JSONB column is loaded:

```diff
--- a/src/engine/api/_radar.py
+++ b/src/engine/api/_radar.py
@@ LIGHT_PERIOD_COLUMNS = (
     "id,org_id,period_start,period_end,currency,source_document_id,updated_at,"
     "caen_code,"
+    "p121:assembled_canonical_v1->canonical_bs->invariants->p121_cross_check->>p121,"
     "snapshot_hash:assembled_canonical_v1->provenance->>content_hash,"
     "has_envelope:assembled_canonical_v1->>schema_version"
 )
```

`_statutory_anchor_for` already accepts a flat `p121` column under that exact
alias (PostgREST returns `->>` extractions as text; the resolver coerces), and
`test_a_light_projection_can_opt_back_in_with_one_scalar_column` pins the
behaviour on all 7 books, so the projection is the only thing that changes.
Adding the column changes Radar's cache key semantics, which is why it is
handed over rather than applied here.

## 7. The gate

`tests/engine/test_rebuild_net_income_anchor.py` — 84 tests, 0 skipped.

Cross-path by construction: it drives the REAL production write seam
(`stage_map` → `stage_persist`) and the REAL served routes against the SAME
book and demands they agree. No fake assembler, no mirror store. The only
double is a Supabase stand-in, and it is **projection-faithful** — it honours
`columns=`, which is what lets the Radar case be tested as the genuinely
unanchored path rather than being handed an envelope the real query never
selects. `test_the_double_actually_honours_column_projection` asserts the
double's own fidelity.

Structural invariant (`test_every_rebuild_call_site_threads_the_anchor`): an
AST scan requires every `.assemble_statements(` in `pipeline.py` to pass
`account_121_anchor_override` explicitly, and requires ≥3 calls through
`_assemble_with_statutory_anchor`. A fourth rebuild seam added later without
either goes red before it can serve a number.

Coverage floors are asserted, not assumed: ≥5 books carrying a p121 (7 today),
and ≥5 books whose reconstruction genuinely diverges (6 today) — otherwise the
gate would pass even with the anchor unthreaded.

### Plants

Both were applied, observed red, and reverted. See the `net-income-anchor`
section of `docs/engine_book/gates.md` for the recorded output.

1. **Bare call** — `_rebuild_assembled_for_briefing` calls
   `_coa_mod.assemble_statements` directly again. `36 failed, 48 passed`.
2. **Resolved but not applied** — the helper keeps resolving and labelling but
   drops `**anchor_kwargs` on the way to the assembler. `47 failed, 37 passed`.
   This is the plant that justifies `_anchor_reached_the_assembler`: with
   `applied` inferred from the caller's intent instead of read off the
   assembler's output, this plant produced a serene `within_tolerance` label
   on a figure sitting 6.5M away from account 121.

## 8. Verification

```
tests/engine/test_rebuild_net_income_anchor.py     84 passed
scripts/corpus_replay.py                           PASS — 18 case(s)
scripts/measure_bs_drift.py                        GREEN — F-A3.1 met on all fixtures
scripts/verify_determinism.py                      PASS — byte-identical across 5 runs
pytest tests/engine -k "period or briefing or capsule or assemble or pipeline"
                                                   430 passed
scripts/check_import_boundary.py                   boundary holds
pytest tests/engine                                4099 passed, 3 pre-existing failures
```

The 3 full-suite failures (`public/test_adapter.py` ×2,
`test_engine_book.py::test_regeneration_is_byte_identical`) reproduce
identically on HEAD with this change removed; they belong to other lanes.

---

## 9. Handover — battery registration

`scripts/run_battery.py` and `docs/engine_book/gates.md` are not this lane's to
edit. Both must land **together**: `tests/engine/test_gate_canaries.py` fails a
gate registered without a plant-log section carrying PLANT / RED / REVERT.

### Gate line — insert after the `cron-auth` gate

```python
        Gate("net-income-anchor",
             [PY, "-m", "pytest",
              "tests/engine/test_rebuild_net_income_anchor.py", "-q"],
             work_junit=True, floor=60, units="tests",
             canaries=("test_every_rebuild_call_site_threads_the_anchor",
                       "test_persist_and_rebuild_agree_field_for_field",
                       "test_get_period_route_serves_the_anchored_figure")),
```

**Floor 60, measured not negotiated.** 84 tests today: 11 parametrized
functions × 7 corpus books carrying a p121, plus 7 unparametrized. The gate's
own `test_corpus_anchor_coverage_floor` refuses to run on fewer than 5 books,
and 5 books gives 5×11 + 7 = 62. 60 is that true minimum rounded down. Adding a
corpus book needs no edit; losing three goes red, which is the point.

### `docs/engine_book/gates.md` section — insert after `## cron-auth`

````markdown
## net-income-anchor

Account 121 anchors `net_income_statutory` on EVERY path, not just persist.
CLAUDE.md Appendix A §3 / Step 11: the closing balance of account 121 IS the
statutory net profit; the class-6/7 reconstruction is only the validation
check. `assemble_statements()` implements that rule but can only see the anchor
through its `account_121_anchor_override` kwarg, because
`accounts_to_assemble_shape()` routes 121 to `ignore_control` and drops the row
before assembly. Found 2026-09-04: of the four `assemble_statements()` call
sites in `pipeline.py`, only the persist path (`stage_map`) threaded it. The
three REBUILD-FROM-LINE-ITEMS sites — the briefing seam (Capsule statements
context, Radar, the firm attention lane), `GET /api/period/{id}` (Statements
P&L, Valuation tab, cash-flow statement, NAV cascade) and
`POST /review/reanalyze` — served a raw reconstruction under the statutory
name. `saga_10_col_realestate` served −30,391,418.38 against an account 121 of
−801,604.14, and its `assembled_bs.total_equity` — the NAV cascade's
book-equity floor — read 10,694,320.49 against a written 40,284,134.73.
Each path was internally consistent, which is why no single-path test saw it:
the only thing that falsifies this defect is comparing two paths.

| | |
|---|---|
| command | `python -m pytest tests/engine/test_rebuild_net_income_anchor.py -q` |
| work count | junit-xml, floor **60** tests (84 today: 11 parametrized × 7 corpus books with a p121, plus 7 unparametrized; the gate's own coverage floor refuses fewer than 5 books, which yields 62) |
| canary | `test_every_rebuild_call_site_threads_the_anchor`, `test_persist_and_rebuild_agree_field_for_field`, `test_get_period_route_serves_the_anchored_figure` |

Subject is the REAL production write seam (`stage_map` → `stage_persist`) and
the REAL FastAPI routes over the golden corpus — no fake assembler, no mirror
store. The one double is a Supabase stand-in that HONOURS `columns=`, so the
Radar surface is tested as the genuinely unanchored projection it is instead of
being handed an envelope the real query never selects;
`test_the_double_actually_honours_column_projection` asserts that fidelity.

**GREEN** — exit `0`:

```
84 passed
```

**PLANT A** — `src/engine/api/pipeline.py`: `_rebuild_assembled_for_briefing`
calls `_coa_mod.assemble_statements(...)` directly again instead of
`_assemble_with_statutory_anchor(...)` (the exact shape that shipped).

**RED** — exit `1`, `36 failed, 48 passed`:

```
[saga_10_col_realestate] seam/full-row: net_income_anchor_status is None — the account-121 anchor did not reach the assembler (it was never resolved). Account 121 = -801,604.14; the class-6/7 reconstruction being served under the statutory name = -30,391,418.38 (gap -29,589,814.24).
pipeline.py calls assemble_statements() DIRECTLY, without the account-121 anchor, at line(s) [5110]. Either pass `account_121_anchor_override=` (the persist path does) or route the call through `_assemble_with_statutory_anchor(...)`. Threading it at one seam and forgetting the next IS the defect this gate exists for.
```

**PLANT B** — the subtler half. Keep the helper, but drop `**anchor_kwargs` on
the way to the assembler: the anchor is still resolved and still labelled, and
only the value fails to arrive.

**RED** — exit `1`, `47 failed, 37 passed`:

```
[saga_10_col_agras] seam/full-row: net_income_anchor_status is 'absent' — the account-121 anchor did not reach the assembler (it was resolved as 7,533,676.02 but not passed to assemble_statements()). Account 121 = 7,533,676.02; the class-6/7 reconstruction being served under the statutory name = 14,106,102.03 (gap 6,572,426.01).
[saga_10_col_realestate] assembled_bs.current_year_pnl: served -30,391,418.38 vs written -801,604.14 (account 121 = -801,604.14)
```

Plant B is why `applied` is read off the assembler's own emitted
`p121_cross_check.p121` rather than off the kwargs dict the caller built: with
`applied` inferred from intent, this plant produced a serene
`within_tolerance` label on a figure 6.5M away from account 121.

**REVERT** — exit `0`: `84 passed`; no `# PLANT` marker left. Verdict: proven
RED, twice, on two different failure shapes.
````
