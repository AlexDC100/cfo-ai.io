# Radar — THE SERVED ROUTE, THE CAP AND PROVENANCE — gates R1 / R2 / R3 / R4 / B3 (+ incremental)

**Lane:** Radar serve integrity + provenance (engine half). ENGINE ONLY; the
Radar surface is a later wave.
**Date:** 2026-09-05 (fix wave over the 2026-09-04 build, after two
adversarial critics).
**Owns:** `src/engine/api/_radar.py` (the route), `src/engine/radar/cap.py`
(the surfaced cap), `src/engine/radar/serve.py` (the one source),
`supabase/schema_phase_radar.sql` (dismissals), `tests/engine/test_radar_gates.py`,
`tests/engine/test_radar_determinism.py`, `tests/engine/test_radar_route.py`,
`tests/engine/radar_fakes.py` (the projection-faithful double),
`tests/engine/fixtures/radar/{capture.py, *.json}`, this page.
**Imports, never edits:** `engine.api.findings.s_engine` / `m_engine` /
`m_series`, `engine.api._finding`, `engine.api._finding_rank`,
`engine.api._company_profile`, `engine.serving` (`FactsGateway`, `Fact`,
`MissingFactError` — the ONE reader of served figures), `engine.radar.explain`
(the explain lane — wired here, never edited), `engine.api._finding_advisory`
(the F9 guard — installed at mount, never edited), `engine.api._org`,
`engine.api.pipeline._rebuild_assembled_for_briefing`, `engine.api._supabase`.
**Touched outside the lane, by the coordinator's instruction:** three
docstrings in `tests/engine/test_rebuild_net_income_anchor.py` that pinned
"the Radar surface serves `absent` today" (no assertion changed; the seam
tests hold as written).
**Not touched:** `server.py`, `scripts/run_battery.py`,
`docs/engine_book/gates.md`, `profiles.yaml`, `models.yaml`,
`_finding_rank.py`, `_capsule_tools.py`, `serving/facts.py`, `pipeline.py`,
`_ratio_units.py`, `frontend/**`, `e2e/**`, `test_findings_gates.py`,
`test_finding_sharpen.py`, `finding_sharpen.py` (the numerals lane is
mid-edit on the last three) — every change those need is handed VERBATIM
at the bottom of this page.

```
.venv/bin/python -m pytest tests/engine/test_radar_gates.py tests/engine/test_radar_determinism.py tests/engine/test_radar_route.py -q -p netblock
.venv/bin/python tests/engine/fixtures/radar/capture.py --check
```

---

## The unit: one payload, every findings surface (`radar2`)

```
GET /api/radar/{period_id}  ->
{
  version: "radar2", source: "radar",                     <- the marker (TC-7)
  period_id, period_label, currency,
  snapshot_id,                                            <- the envelope's CONTENT HASH — the id the FactsGateway
                                                             stamps on every fact (joinable); was the upload id
  source_document_id,                                     <- the upload, under its own name
  snapshot_key, available, gap,
  profile {profile_id, composite_id, profile_label, fingerprint},
  surfaced[], info[], demoted[],                          <- RankedFinding.to_payload() + id, source, lane, period_id,
                                                             materiality_amount_fact, materiality_amount_verified,
                                                             group_severity, group_critical, facts_provenance,
                                                             explanation (route-attached, explain lane's shape)
  checks[],                                               <- the engine's all_checks() FIRST (R1 prefix), then refusals
                                                             (materiality / provenance conflict), the multi lane's,
                                                             the cap's demotions
  cap, cap_policy {cap, source, surfaced, held_back, critical_count,
                   critical_below_floor, exceeded_by_critical, statement},
  counts {…, refused_materiality, refused_provenance},
  materiality_policy, materiality {basis, method, excluded_totals, refused},
  provenance {snapshot_id, source_document_id, gateway {available, tier, snapshot_id}, rule,
              facts {verified, withheld, unverified_or_withheld_facts, conflicts_on_served_rows,
                     rows_refused_for_conflict}},
  statement, silence,
  dismissals {in_force[], applied, retained_critical},
  needs_history, history, lanes,
  explanations {source, critical_path: "cache-only", attached, cached, fresh, absent, pending,
                drafting_in_background, enabled},            <- the route's own
  cache {key, hits, misses}, notices[]                    <- the route's own; excluded from the byte compare
}
```

`row.facts_provenance`:

```
{ snapshot_id, gateway_tier,
  cited:    { fact: {value, accessor, line_id, snapshot_id} },   <- what Radar itself cites: the gateway served the same cents
  withheld: { fact: {status, reason} },                          <- no accessor resolves it: NOT cited, no value, the reason
  conflicts: [ {fact, cited, served, accessor, reason} ],        <- always [] on a served single-period row: a conflict REFUSES the row
  derived: [ percent / ratio / count facts ],
  verified_count, withheld_count, conflict_count }
```

**The invariant, stated as the payload states it (`provenance.rule`):** every
money figure a single-period row cites is checked against the FactsGateway
accessor that serves it; Radar cites the verified ones, withholds the ones
no accessor resolves (the reason is on the row), and refuses a row whose
figure contradicts the gateway. The engine's own row — `facts_cited`, the
figures, the prose — stays byte-identical to the Capsule's (R1); Radar's
citation is the strict side.

**Critical is a property of the GROUP.** `group_severity` is the most
severe DETECTOR severity among the primary and its `merged_from`
contributors; the cap exempts groups, dismissal retains groups, and the
statement says what is true: "every finding graded Critical at or above the
materiality floor surfaces (N)" and, when it applies, "M Critical(s) below
the materiality floor are listed under info or All checks with the reason,
not surfaced". The phrase "every Critical surfaces, always" is gone.

**Dismissals are anchored on a PERIOD.** `radar_dismissals` gained
`from_period_end date`; the route stores `period_id` + `from_period_end`,
and at every serve resolves the reach's starting ordinal on the spine AS
IT IS NOW (`_radar.anchor_ordinal`: by id, else by period end — the
position the period would occupy). `from_period_ordinal` is stored as
information only and never read to apply a dismissal.

---

## STATUS, AS MEASURED — 2026-09-05

```
tests/engine/test_radar_gates.py          58 passed
tests/engine/test_radar_determinism.py    17 passed
tests/engine/test_radar_route.py          26 passed
tests/engine/test_radar_explain.py        47 passed, 1 skipped   (the explain lane's; the env-gated live test)
tests/engine/test_findings_gates.py + test_finding_sharpen.py — see "F5" below
verify line (radar*, findings_gates, finding_sharpen, -p netblock):  1 failed, 324 passed, 2 skipped
tests/engine/fixtures/radar/capture.py --check          RADAR FIXTURES: PASS — 6 case(s)   (pipeline.py: no diff vs HEAD when captured)
tests/engine/fixtures/radar/explain/capture.py --check  OK on all 5 (the explain lane recaptured on the served seam: "net income = account 121")
scripts/corpus_replay.py                  CORPUS REPLAY: PASS — 18 case(s)
scripts/check_import_boundary.py          boundary holds (engine=OK, frontend=OK, private-fields=OK), 1687 files
scripts/check_metric_declared.py          PASS — 59 names / 8 surfaces
```

The one red on the verify line is
`test_findings_gates.py::test_f5_plant_a_money_numeral_the_template_cannot_bind_is_refused`,
and it is ORDER-DEPENDENT in exactly the way S8 (B7) was — measured:

```
pytest test_findings_gates.py                                     39 passed
pytest test_radar_determinism.py test_findings_gates.py            56 passed      (no router mount)
pytest test_radar_route.py test_findings_gates.py                   1 failed, 64 passed
```

F5 reads `F.apply_advisory_narrative` as if it were the raw seam and expects
the RENDERER to raise `OrphanCurrencyLabelError`; once any suite in the
process has mounted the Radar router (B6 installs the F9 guard at mount) the
attribute is the guarded twin, which refuses the bare `RON 9,999,999` earlier
and returns a demoted finding whose `render()` raises nothing. The numerals
lane already made S8 order-independent through `FS.unguarded_seam()`; F5
needs the same one line (hand-off §9 below). **This will go red in the
battery's `pytest` gate the moment the `server.py` mount lands**, because
`tests/engine/test_capsule_tools_route.py` builds the real app — and
therefore mounts Radar — before `test_findings_gates.py` runs.

Full battery (`scripts/run_battery.py`, 2026-09-05, this host, `.env`
keys stripped): `BATTERY: FAIL — 37/40 gates green, 1 VACUOUS
(public-sitemaps)`. The two reds, neither a Radar test:

- `pytest` — `2 failed, 5361 passed, 17 skipped, 1 xfailed`:
  `tests/engine/public/intelligence/test_signal_ordering_sweep.py::test_the_signal_fan_out_is_bounded_and_a_repeat_costs_zero`
  (the intelligence lane's untracked test) and
  `test_engine_book.py::test_regeneration_is_byte_identical` (below).
  F5 is GREEN in this gate today because `create_app()` does not mount
  Radar yet — see the F5 note above for what changes when it does.
- `engine-book` — `architecture.md: DRIFT (committed page != regeneration)`;
  the coordinator's pending `python scripts/generate_engine_book.py`,
  unchanged from the 2026-09-04 page.

`firm-tenancy-fc1` is no longer in the battery (its Gate line was removed
on 2026-09-04 with the other firm-* lines until the Cockpit tests land),
so its pinned Capsule test does not appear here.

---

## What the critics proved, and what is true now

Every item below was measured by a critic with a scratchpad harness; the
same harness, unmodified where it still runs, was re-run against the fix.
Outputs are pasted from `scratchpad/rerun/*.out`.

### A1 — the two lanes never met (route side) — FIXED

The route now wires the explain lane per its published contract, and
`serve.attach_explanations` (a second seam whose mock shape the product
could not emit — it REFUSED the real `Explanation.to_payload()`) is
deleted; `explain.attach` is the one writer of `row["explanation"]`.

```
_radar.serve_for:  payload, served = cache.get_or_build_with(key, compose)
                   payload = attach_explanations(payload, served, org_id, wiring)
                              subjects = X.subjects_from_ranked(served.surfaced, served.profile, …, served.gateway)
                              X.attach(payload["surfaced"], X.attach_cached(subjects, store), subjects)   <- BEFORE the return, cache-only
                              _draft_in_background(pending)  -> X.explain_in_background(...)              <- AFTER, deduplicated in flight
```

`attack_ai_seams_rerun.py` (the critic's harness; step 1b adapted because
the seam it probed no longer exists):

```
1. hostile model statuses: [('liquidity_cash_tight', 'fresh', ''), ('concentration_related_party', 'fresh', ''), ('input_cost_exposure', 'fresh', ''), ('fx_exposure', 'fresh', '')]
1. shape identical: True
1. stripped rows byte-identical to AI-off rows: True
1. ranking vocabulary keys inside served explanation: []
1. 'planted_by_model' anywhere in served rows: False
1b. serve.attach_explanations exists: False | serve.ExplanationRefused exists: False (B5: the second seam is deleted; explain.attach is the one writer)
2. dead model statuses: [('absent', 'advisory_unavailable')] 0.011s
2. critical path (attach_cached+attach) with model dead: 0.0005s, rows=4/4
2. raw payload signatures in served rows: []
3. explain_in_background returned in 0.0001s; rows served in 0.0006s while the model sleeps 30s; thread alive=True; statuses=['absent']
4. _radar.py references explain lane: True | imports engine.radar.explain: True | calls X.attach_cached + X.attach + X.explain_in_background: True
4. serve.py defines attach_explanations: False
4. server.py mounts the radar router: False        <- the mount line is a hand-off (§1 below), as before
```

And THROUGH THE ROUTE this time (`test_radar_route.py`): rows return with
the model dead (production factories, SDK absent — every row
`explanation.status == absent`, zero raw-payload tokens), with the model
asleep (a stub that blocks until released; the GET returns in well under
the 5 s deadline, a second open neither waits nor drafts again), and
hostile (severity / rank / suppression / a planted finding in the reply —
the served rows strip back byte-identical to the AI-off rows, no ranking
vocabulary inside `explanation`, `planted_by_model` nowhere). The
`radar-determinism` R4 "AI on" gate now uses the REAL lane
(`explain_rows` over a stub model, `explain.attach`), not a mock shape.

### A2 — R1 refuted for production — FIXED, and the double that hid it replaced

`firm_fakes.FakeAdmin.select` ignores `columns=`; `_supabase.select` sends
it as PostgREST `select=`. The route listed periods LIGHT, handed the LIGHT
row to `_rebuild_assembled_for_briefing`, and the seam — reading
`period["assembled_canonical_v1"]` for the persisted reconciliation and the
account-121 anchor — found nothing.

Now: `heavy_input` loads the envelope, `full_row()` puts it back on the row
under the column name, the seam reads exactly what the Capsule's context
builder hands it; and the light listing carries the `p121` alias
(NET_INCOME_ANCHOR.md §6) so the anchor is on the light row too. Every
Radar suite runs over `tests/engine/radar_fakes.ProjectingAdmin`, which
honours `columns=` as PostgREST does (plain columns, `alias:col`,
`->`/`->>` JSON paths rendered as text) and RAISES on a column the row does
not carry, the way PostgREST answers 400.

`attack_r1_prod_projection.py` (the critic's harness, unmodified):

```
saga_10_col_agras        fake=full-row   capsule_rows=4 radar_rows=4 basis=facts_gateway 39319114.09  DIFFS=0
saga_10_col_agras        fake=PROJECTING capsule_rows=4 radar_rows=4 basis=facts_gateway 39319114.09  DIFFS=0
saga_10_col_carniprod    fake=PROJECTING capsule_rows=3 radar_rows=3 basis=facts_gateway 125886192.51 DIFFS=0
saga_10_col_retail       fake=PROJECTING capsule_rows=4 radar_rows=4 basis=facts_gateway 70089631.84  DIFFS=0
saga_10_col_realestate   fake=PROJECTING capsule_rows=4 radar_rows=4 basis=facts_gateway 83417653.88  DIFFS=0
saga_10_col              fake=PROJECTING capsule_rows=6 radar_rows=6 basis=facts_gateway 52764717.79  DIFFS=0
```

(Before: agras 4/4 rows differed plus an extra `data_quality_bs_imbalance`
Critical at rank 1; realestate `total_equity` 10,694,320 vs 40,284,135.)
The gate is now `test_r1_route_and_capsule_agree_through_their_own_loaders`
— one app, both routers, one projection-faithful client, all six
captures, byte for byte on every key the Capsule carries, and the route's
rows equal to the capture's. It reds naming the first differing row (plant
A2 below).

**Found on the way, by the double:** `financial_periods` has NO
`caen_code` column — phase 7 (`schema_phase7_benchmarks.sql`) put CAEN on
`organizations`. The first light projection named `caen_code`, which
PostgREST would have answered 400 on every production listing; the
Capsule's `row.get("caen_code")` is a dead read for the same reason. The
column is gone from the projection and
`test_the_light_projection_names_only_columns_the_table_carries` reads
every `financial_periods` column across `supabase/*.sql` (create block +
every `alter table … add column`) and asserts the projection names nothing
else. There is no `period_label` column either (A5): the period end IS the
label on both surfaces.

**The account-121 anchor (the line the anchor wave held back).** Measured
through the route over the projecting double, `saga_10_col_retail`:

```
account 121 (p121)                 3,205,212.62
gateway.net_result()               3,205,212.62
Radar facts_cited.net_income       3,205,212.62   net_income_anchor_status = anchored
(before this wave: 1,161,957.98, status absent — the class-6/7 reconstruction under the statutory name)
```

`test_the_route_serves_account_121_as_statutory_net_income_like_every_other_surface`
asserts it; the three docstrings in `test_rebuild_net_income_anchor.py`
that pinned the old state are corrected (no assertion there changed — the
seam tests hold for any caller that still hands the seam a bare row).
**Cache key:** deliberately unchanged in shape — the key's `snapshot` is
the envelope's content hash, a digest over the whole persisted envelope
including `p121`, so an envelope rewritten with a different anchor is
already a different key; `RADAR_VERSION` moved to `radar2` (the payload
shape grew and `snapshot_id` changed meaning), which invalidates every
entry across the deploy.

### A3 — "every Critical surfaces" refuted under merge — FIXED

`cap.is_critical(ranked, severity_by_rule)` reads the group; serve hands
the cap the detector severity of every rule id a `merged_from` can name
(both lanes). `attack_cap_dismiss_rerun.py` §B (the critic's construction —
`fx_exposure` re-graded Critical on `liquidity_cash_tight`'s subject —
with two lines added beside the originals to call what serve now calls):

```
cap=1 with one true Critical above: surfaced=[('critical', 'liquidity_cash_tight#c')] | HELD=[('high', 'liquidity_cash_tight', "merged_from=['fx_exposure']", 'held below the Radar cap of 1 surfaced finding(s)'), …]       <- the ranker + apply_cap WITHOUT member severities (the defect)
FIX  cap=1 with member severities (what serve passes): critical_count=2 exceeded=True surfaced=[('critical', 'liquidity_cash_tight#c', 'group=critical'), ('high', 'liquidity_cash_tight', 'group=critical')] | HELD=[('medium', 'concentration_related_party', []), ('medium', 'input_cost_exposure', [])]
```

Through `serve_period` (the engine's result edited in place —
`test_r2_through_serve_a_buried_critical_group_surfaces_and_is_labelled`):
the HIGH primary with the buried Critical surfaces under a cap of 1,
`group_severity == "critical"`, `critical_count == 1`. The statement:

```
retail (2 true Criticals, cap 7):  "4 finding(s) surfaced under a cap of 7; every finding graded Critical at or above the materiality floor surfaces (2), exempt from the cap."
retail, cap 1:                     "…; 2 group(s) graded Critical at or above the materiality floor exceed the cap on their own, so every one of them is shown and nothing below Critical is; 2 held below the cap …"
retail, floors nothing clears:     "No finding cleared the materiality floor for this period. 29 check(s) ran; …; 2 Critical(s) below the materiality floor are listed under info or All checks with the reason, not surfaced."
```

### A4 — suppression moved between periods — FIXED (both halves)

`attack_cap_dismiss.py` §C, the critic's exact sequence, UNMODIFIED:

```
dismissed liquidity_cash_tight from_period_ordinal=1 periods=1
   p-a-2025 applied=1 surfaced has victim=False
   p-a-2024 applied=0 (should be 0: the dismissal was scoped to 2025 only)
after a 2023 period is added: p-a-2025 applied=1 victim surfaced=False | p-a-2024 applied=0 victim surfaced=True | p-a-2023 applied=0
   stored row still says period_id=p-a-2025 from_period_ordinal=1
```

(Before: `p-a-2025 applied=0 victim surfaced=True | p-a-2024 applied=1
victim surfaced=False`.) The route re-anchors the reach at ordinal 2 on the
new spine; a deleted anchor period anchors by its period end; a legacy row
with neither is NOT applied and named in `notices`
(`test_a4_a_deleted_anchor_period_still_anchors_by_its_period_end_and_a_legacy_row_is_not_applied`).

The second half — dismissing the non-Critical primary of a group with a
buried Critical took the Critical to the checks with
`dismissed_but_retained=False` — is `serve.retain_dismissed_critical_groups`
(the ranker's report post-processed: the group comes back surfaced,
flagged retained, its demotion check row withdrawn), because
`_finding_rank.rank_findings` reads only the primary and is not this
lane's to edit (the diff is handed, §7). The harness, with one line added:

```
after dismissing the HIGH primary: surfaced=[('medium', 'concentration_related_party'), ('medium', 'input_cost_exposure')] | demoted=[('high', 'liquidity_cash_tight', ['fx_exposure'], 'dismissed: facility renewed', 'retained=False')]
FIX  after serve.retain_dismissed_critical_groups: surfaced=[…, ('high', 'liquidity_cash_tight', ['fx_exposure'], 'retained=True')] | demoted=[] | checks=2->1
FIX  Critical fx_exposure anywhere in surfaced after the dismissal: True
```

### B3 — provenance — every cited figure through an accessor, or withheld, or the row refused

`serve.verify_facts` runs every money figure of every row through
`FACT_ACCESSORS` — a REGISTRY of fact name -> gateway accessor, every entry
measured to the cent on every corpus book. The census on the six captures:

```
carniprod   verified=6 withheld=1 conflicts=0  withheld=['total_cash']
agras       verified=7 withheld=2 conflicts=0  withheld=['cash', 'total_cash']
retail      verified=5 withheld=5 conflicts=0  withheld=['affiliate_income', 'bank_debt_total', 'cash', 'net_debt']
realestate  verified=7 withheld=2 conflicts=0  withheld=['cash', 'total_cash']
saga_10_col verified=9 withheld=5 conflicts=0  withheld=['bank_debt_total', 'cash', 'net_debt', 'total_cash']
imbalance   verified=2 withheld=0 conflicts=0
```

The withheld set is EXACTLY the critic's five accessor-less facts and the
gate `test_b3_the_withheld_facts_are_exactly_the_ones_without_an_accessor`
pins it — a name leaving the set means an accessor landed and must be
mapped in the same commit. Nothing is re-derived here from statement rows
("cite nothing until they land"); the accessor diffs are handed in §6.
`materiality_amount_verified` says on each row whether the amount it was
ranked on is a verified figure (`liquidity_cash_tight` is ranked on
`cur_liab` — verified; `fx_exposure` on `total_cash` — withheld; the
ranking rule itself is unchanged, and labelled).

**The retail contradiction, investigated.** `assembled_pl.net_income_statutory`
= 1,161,957.98 on the rebuild path WAS the class-6/7 reconstruction under
the statutory name (the labelling defect the anchor wave, commit 06ee60f,
fixed in `pipeline.py`); account 121 = 3,205,212.62 = `gateway.net_result()`.
Through the served seam with the envelope on the row, all five corpus
books: `light` row -> `absent` (the reconstruction), `p121` alias ->
`anchored` = account 121, full row -> `anchored` = account 121 — and
`gateway.net_result()` equals account 121 on every one. Radar cites
`FactsGateway.net_result()` (`test_b3_net_income_is_the_gateways_net_result_which_is_account_121`).

**A figure that contradicts the gateway refuses the row.** Statements of
one book under the envelope of another
(`test_b3_plant_a_figure_that_contradicts_the_gateway_refuses_the_row_with_the_reason`):
every accessor-backed figure conflicts; those rows are check rows —
`fired but not served: provenance conflict — the row cites total_assets =
39319114.09 but FactsGateway.total_assets() serves 125886192.51 …` —
`counts.refused_provenance` counts them, the surfaced list is silent rather
than wrong, and the statement says "N fired but not served (a cited figure
contradicts the served envelope)". Plant A2's red shows this working
against the real defect: with the light row handed to the seam, realestate
and saga_10_col lose `liquidity_cash_tight` to a refusal instead of serving
it with the wrong `cur_liab`.

**Snapshot ids.** `payload.snapshot_id` and every `facts_provenance.cited.*.snapshot_id`
are the envelope's content hash — the id `Fact.provenance.snapshot_id`
carries — so a row's figure joins to its gateway fact. `source_document_id`
is beside it under its own name. The engine row's own
`evidence.provenance.snapshot_id` stays the upload id because that is what
the Capsule's context builder hands the detectors and R1 holds the two
byte-identical; the diff that moves BOTH to the content hash is handed (§8).

`provenance_trace.py` (the critic's harness, unmodified; its own NAMED map
lacks `ebitda_statutory`, which the registry maps to `ebitda()` and the
rows verify):

```
[OK ] revaluation_reserves = 3152071.46   gateway.statement_line('revaluation_reserves')
[OK ] total_equity         = 7756589.15   gateway.equity() = 775658915
[OK ] fx_cash              = 1205819.75   gateway.statement_line('cash_fx')
[NO GATEWAY PATH] total_cash = 1255039.17  statements.assembled_bs.cash (assembled statements — detector read)      <- withheld on the row
```

### B5 — deleted; B6 — installed at mount and gated

`build_router` imports `engine.api._finding_advisory` (the F9 guard
install) — the mount is the act, not a module import side effect
(`test_b6_the_mount_is_where_the_guard_is_imported`), and
`test_b6_mounting_the_router_installs_the_f9_guard_on_the_served_path`
proves it in a FRESH interpreter that imports the route module, mounts it,
and nothing else: the guard is absent before the mount, present after, and
the F9 plant ("grown 47%") is demoted through `_finding.apply_advisory_narrative`.

### B7 — S8 order dependence

Owned by the numerals lane, whose in-flight `test_finding_sharpen.py`
already reads the raw seam through `FS.unguarded_seam()` (measured: the S8
test is green on the verify line). Not touched here. F5 is the same class
and is handed (§9).

### B1 / B2 / B4 — the numerals lane's

`plant_harness.py` re-run on the current tree for the record (their file,
their fix): refused — A1–A3, A6–A9, B6, B7, C1–C8, D1–D8, E1–E3, E5, F1–F7,
G1b; still served — A4, A5, B1–B5 (RO dotted thousands, decimal-comma
millions, number words), C9, C10 (RO `lei`/`euro`), E4, G1–G3. B4 (the
explain fixtures captured on the assemble path) is closed: their
`capture.py --check` now prints `net income = account 121` on all five.

---

## Fixtures — real engine output (TC-1), recaptured LAST

`tests/engine/fixtures/radar/capture.py` runs, per corpus case:
`parse -> assemble -> stage_persist` (the `corpus_replay` composition) ->
`_rebuild_assembled_for_briefing` over the persisted line items WITH the
envelope on the row (the served seam) -> `s_engine.run_single_period` ->
`serve_period`. The captures were taken after `git diff
src/engine/api/pipeline.py` showed the seam unchanged against HEAD
(commit 06ee60f, the anchor wave, already landed), and `--check` passes.
`_meta.net_income_anchor` on every capture records what the seam labelled:

```
carniprod  anchored 121=1435533.59   agras anchored 121=7533676.02   retail anchored 121=3205212.62
realestate anchored 121=-801604.14   saga_10_col anchored 121=402869.16   imbalance_03pct absent (synthetic, no p121)
```

`snapshot_id` in every capture is the envelope's content hash;
`source_document_id` is `doc-<case>`; the detectors were handed the
document id (the Capsule's convention).

---

## The plants (TC-2) — plant -> RED -> restore -> GREEN

Applied in an rsync SANDBOX of the tree (`scratchpad/radar_sandbox`,
`src` + `tests` + `packs` + `corpus` + `supabase` + `scripts`; the live tree
untouched, `PLANT_MANIFEST.json` untouched, no marker left anywhere) by
`scratchpad/rerun/radar_plants.py`: apply, run the gate, restore the file
byte-for-byte (sha256-checked), run the gate again. Transcript:
`scratchpad/rerun/radar_plants.json`. Nine plants, nine reds through the
gate's own message, nine greens.

**PLANT A2** — `_radar.full_row` hands the rebuild seam the light row without its envelope.

```
E   AssertionError: R1 ONE-SOURCE VIOLATED (loaders) — saga_10_col_agras/liquidity_cash_tight differs between the Capsule's loader and the route's on ['profile_fingerprint']; facts_cited capsule={'cash': 1168047.04, 'cur_liab': 13…
E   AssertionError: R1 ONE-SOURCE VIOLATED (loaders) — saga_10_col_realestate: list_findings serves liquidity_cash_tight and the route has no row for it
E   AssertionError: R1 ONE-SOURCE VIOLATED (loaders) — saga_10_col: list_findings serves liquidity_cash_tight and the route has no row for it
FAILED tests/engine/test_radar_gates.py::test_r1_route_and_capsule_agree_through_their_own_loaders[saga_10_col_agras]
================== 3 failed, 3 passed, 52 deselected in 1.67s ==================
E   AssertionError: the rebuild did not apply the persisted reconciliation: total_assets 39272501.03 vs the gateway's 39319114.09
FAILED tests/engine/test_radar_route.py::test_a2_the_envelope_is_on_the_row_the_rebuild_seam_reads
```
REVERT: `6 passed, 52 deselected` / `2 passed, 24 deselected`.

**PLANT P121** — the `p121` alias dropped from `LIGHT_PERIOD_COLUMNS`.

```
E   KeyError: 'p121'
E   AssertionError: the account-121 anchor is not on the light projection
FAILED tests/engine/test_radar_route.py::test_the_light_input_carries_the_content_hash_and_the_document_under_their_own_names
FAILED tests/engine/test_radar_route.py::test_the_light_projection_names_only_columns_the_table_carries
======================= 2 failed, 24 deselected in 0.45s =======================
```
REVERT: `2 passed`.

**PLANT A3** — `cap.is_critical` reads the primary's severity only.

```
E   AssertionError: assert False   (CAP.is_critical(<the HIGH primary with merged_from=('fx_exposure',)>, severity_by_rule))
FAILED tests/engine/test_radar_gates.py::test_r2_a_critical_buried_under_a_non_critical_primary_is_never_held
FAILED tests/engine/test_radar_gates.py::test_r2_through_serve_a_buried_critical_group_surfaces_and_is_labelled
======================= 2 failed, 56 deselected in 0.54s =======================
```
REVERT: `2 passed`.

**PLANT A4a** — `serve.retain_dismissed_critical_groups` returns the ranker's report unchanged.

```
E   AssertionError: R3 DISMISSAL VIOLATED — the group carrying the buried Critical fx_exposure left the surfaced list on a dismissal of its primary
FAILED tests/engine/test_radar_gates.py::test_r3_dismissing_the_non_critical_primary_of_a_critical_group_retains_it
FAILED tests/engine/test_radar_gates.py::test_r3_through_serve_a_dismissed_critical_group_is_retained
================== 2 failed, 1 passed, 55 deselected in 0.60s ==================
```
REVERT: `3 passed`.

**PLANT A4b** — `_radar.anchor_ordinal` returns the STORED `from_period_ordinal`.

```
E   AssertionError: A4 VIOLATED — adding an earlier period moved the dismissal off the period it was made on (p-a-2025 now shows liquidity_cash_tight again)
FAILED tests/engine/test_radar_route.py::test_a4_a_dismissal_is_anchored_on_its_period_not_on_a_spine_position
======================= 1 failed, 25 deselected in 1.34s =======================
```
REVERT: `1 passed`.

**PLANT B3** — `serve.verify_facts` reports a mismatching figure as verified (`if True:`).

```
E   AssertionError: PROVENANCE VIOLATED — a row citing a figure the gateway contradicts was served
FAILED tests/engine/test_radar_gates.py::test_b3_plant_a_figure_that_contradicts_the_gateway_refuses_the_row_with_the_reason
======================= 1 failed, 57 deselected in 0.54s =======================
```
REVERT: `1 passed`.

**PLANT B5** — `serve_for` returns without `attach_explanations`.

```
E   KeyError: 'explanation'   (x3)
E   assert False  (+ where False = <threading.Event>.wait(30) — nothing was drafted after the rows)
FAILED tests/engine/test_radar_route.py::test_the_route_attaches_cached_explanations_before_the_rows_return_and_drafts_after
FAILED tests/engine/test_radar_route.py::test_the_rows_return_with_the_model_dead_through_the_route
FAILED tests/engine/test_radar_route.py::test_the_rows_return_while_the_model_sleeps_through_the_route
FAILED tests/engine/test_radar_route.py::test_a_hostile_model_moves_nothing_through_the_route
====================== 4 failed, 22 deselected in 31.35s =======================
```
REVERT: `4 passed, 22 deselected in 1.42s`.

**PLANT B6** — the `_finding_advisory` import dropped from `build_router`.

```
E   AssertionError: B6 VIOLATED — mounting the Radar router did not install the F9 guard on _finding.apply_advisory_narrative
E   AssertionError: build_router does not import engine.api._finding_advisory
FAILED tests/engine/test_radar_route.py::test_b6_mounting_the_router_installs_the_f9_guard_on_the_served_path
FAILED tests/engine/test_radar_route.py::test_b6_the_mount_is_where_the_guard_is_imported
======================= 2 failed, 24 deselected in 1.38s =======================
```
REVERT: `2 passed`.

**PLANT INC** — `RadarCache.get_or_build_with` never hits (`found = None`).

```
E   AssertionError: INCREMENTAL VIOLATED — the engine ran 2 times
E   AssertionError: INCREMENTAL VIOLATED — an unchanged open reloaded line items
FAILED tests/engine/test_radar_gates.py::test_incremental_the_same_request_twice_runs_the_engine_once
FAILED tests/engine/test_radar_route.py::test_get_twice_loads_line_items_once_and_hits_the_cache
================== 2 failed, 1 passed, 81 deselected in 1.02s ==================
```
REVERT: `3 passed`.

The R1 (rounded facts), R2a/R2b (cap) and R3 (hidden Critical) and R4
(clock) plants of the 2026-09-04 page still red the same tests; not re-run
here beyond the suites passing.

---

## KNOWN LIMITS — stated, not hidden

- **Five detector facts have no gateway accessor** (`cash`, `total_cash`,
  `net_debt`, `bank_debt_total`, `affiliate_income`). They are WITHHELD from
  Radar's citation with the reason on the row; the engine row (which the
  Capsule serves identically) still carries the detector's reading in
  `facts_cited` and the prose. `affiliate_income` (a class-76 residue:
  `financial_income − interest_income − fx_gain`) has NO home on the
  persisted envelope at all — no accessor can serve it until the
  methodology view carries it at persist time.
- **Two definitions of net debt.** The solvency detector's `net_debt` is
  `total_debt − cash` (cash = `cash_operating + cash_fx`);
  `methodology.totals.net_debt` also nets `short_term_investments`.
  Measured: agras 2,472,155.29 vs 1,565,628.87; retail 26,720,998.01 vs
  25,495,998.01; saga_10_col 31,731,439.58 vs 31,578,484.58; equal on
  carniprod and realestate (no ST investments). An accessor named
  `net_debt` must say which one it serves (§6).
- **The multi lane's provenance is `unverified`, never `conflict`.** Its
  facts are series values that may belong to a prior period; a mismatch
  with the target's gateway is recorded and withheld, and the row is not
  refused. No corpus book produces a multi-lane row today (the history
  fixture repeats one book, so no series moves).
- **The materiality amount may be a withheld figure** (`fx_exposure` is
  ranked on `total_cash`). The ranking rule is the ranker's and unchanged;
  `materiality_amount_verified` labels it. Demoting a Critical because its
  amount lacks an accessor would hide a Critical to satisfy a citation
  rule — refused as the worse defect.
- **Open-ended dismissals (`periods` null) apply to every period**, earlier
  ones included — `_finding_rank.Dismissal.covers` ignores the ordinal when
  the span is null. Not changed; noted.
- **Multi-period persistence is 1; the two lanes do not merge across each
  other; the history fixture is synthetic** — unchanged from the
  2026-09-04 page.
- **Reads fail OPEN without `radar_dismissals`** (a notice, no dismissal
  applied); writes fail LOUD. Apply `supabase/schema_phase_radar.sql` (it
  now adds `from_period_end`, idempotently) before the surface ships
  dismiss.

---

## HANDOFFS — verbatim, for the coordinator (this lane edited none of these files)

### 1. `src/engine/api/server.py` — the mount (unchanged from 2026-09-04; restated)

```python
from ._radar import build_router as create_radar_router
```

```python
    # RADAR — one source for every findings surface: GET /api/radar/
    # {period_id} (ranked, materiality-gated, capped, provenance-verified,
    # dismissals applied, cached explanations attached), POST .../dismiss
    # (with a reason, anchored on the period, audited). See _radar.py
    # (gates: tests/engine/test_radar_gates.py, test_radar_determinism.py,
    # test_radar_route.py). Mounting installs the F9 numeral guard
    # (engine.api._finding_advisory) on the advisory seam. Requires
    # schema_phase_radar.sql for dismissals: reads fail open (a notice)
    # without it, writes fail loud.
    app.include_router(create_radar_router())
```

**Consequence to land in the same commit:** hand-off §9 (F5) — with the
router mounted by `create_app()`, `tests/engine/test_capsule_tools_route.py`
installs the guard before `test_findings_gates.py` runs in the battery's
`pytest` gate.

### 2. `scripts/run_battery.py` — four gate lines (after `cron-auth`)

```python
        # RADAR — the served route, the cap and provenance (engine half).
        # R1: the route's rows and the Capsule's list_findings rows are
        # byte-identical THROUGH THEIR OWN LOADERS over a client that
        # honours the PostgREST projection; R2: N+1 non-Criticals -> N
        # surface with the demotion recorded, N+1 Criticals -> ALL
        # surface, a Critical buried as a merged contributor is never
        # held; R3: a dismissed Critical — or a dismissed primary whose
        # group carries one — stays surfaced, flagged, reason shown; B3:
        # every cited money figure is gateway-verified or withheld with
        # the reason, a contradicting figure refuses the row. Every one
        # fails SILENTLY. Floor 45 = the measured 58, rounded down.
        Gate("radar-gates",
             [PY, "-m", "pytest", "tests/engine/test_radar_gates.py", "-q"],
             work_junit=True, floor=45, units="tests",
             canaries=("test_r1_route_and_capsule_agree_through_their_own_loaders",
                       "test_r2_a_critical_buried_under_a_non_critical_primary_is_never_held",
                       "test_r3_dismissing_the_non_critical_primary_of_a_critical_group_retains_it",
                       "test_b3_plant_a_figure_that_contradicts_the_gateway_refuses_the_row_with_the_reason")),
        # R4: ten runs, a credential present or absent, the AI SDK
        # blocked at import, history and dismissals in any order —
        # byte-identical and equal to the committed capture; the REAL
        # explain lane attaches prose only and strips back to the same
        # bytes. Floor 12 = the measured 17, rounded down.
        Gate("radar-determinism",
             [PY, "-m", "pytest", "tests/engine/test_radar_determinism.py", "-q"],
             work_junit=True, floor=12, units="tests",
             canaries=("test_r4_ten_runs_are_byte_identical_and_match_the_committed_golden",
                       "test_r4_the_real_explain_lane_attaches_prose_only_and_strips_back_to_the_same_bytes")),
        # The route over a PROJECTION-FAITHFUL client: the envelope is on
        # the row the rebuild seam reads (Radar serves account 121 like
        # every other surface), a dismissal is anchored on its period
        # (an earlier upload moves nothing), the rows return with the
        # model dead / asleep / hostile, mounting installs the F9 guard.
        # Floor 20 = the measured 26, rounded down.
        Gate("radar-route",
             [PY, "-m", "pytest", "tests/engine/test_radar_route.py", "-q"],
             work_junit=True, floor=20, units="tests",
             canaries=("test_the_route_serves_account_121_as_statutory_net_income_like_every_other_surface",
                       "test_a4_a_dismissal_is_anchored_on_its_period_not_on_a_spine_position",
                       "test_the_rows_return_while_the_model_sleeps_through_the_route",
                       "test_b6_mounting_the_router_installs_the_f9_guard_on_the_served_path")),
        # R5-R7 — the explain lane's own gate (design_review/radar/
        # EXPLAIN_GATES.md); floor updated to the measured 47 (48
        # collected, 1 env-gated skip), rounded down.
        Gate("radar-explain-gates",
             [PY, "-m", "pytest", "tests/engine/test_radar_explain.py", "-q"],
             work_junit=True, floor=35, units="tests",
             canaries=("test_r5_plant_a_poisoned_cache_record_the_served_guard_refuses_it",
                       "test_r6_model_dead_rows_complete_explanation_absent_zero_raw_payload",
                       "test_r7_plant_a_model_that_returns_a_changed_severity_the_row_is_unchanged")),
```

### 3. `docs/engine_book/gates.md` — three sections (verbatim, at the bottom of this page)

### 4. `src/engine/country_packs/ro_romania/profiles.yaml` — the cap as data (unchanged; restated)

```yaml
# ═════════════════════════════════════════════════════════════════════════
# RADAR — the surfaced cap (engine.radar.cap). DATA, not code: the
#    ceiling on findings surfaced per period. Applied BELOW Critical, where
#    Critical is a property of the GROUP (a merged contributor counts) —
#    every such group surfaces regardless, and if they alone exceed the cap
#    the payload says so. Absent -> the ranker's default
#    (engine.api._finding_rank.DEFAULT_CAP = 7) and the policy says which.
# ═════════════════════════════════════════════════════════════════════════
radar:
  surfaced_cap: 7
```

### 5. `src/engine/ai/models.yaml` — nothing to change (the explain lane's `radar_explain` row is used as is).

### 6. `src/engine/serving/facts.py` — the accessors the withheld facts need

Every figure below was measured to the cent against the served
`canonical_bs` of all five corpus books (`scratchpad` measurement,
2026-09-05). Cents only, no float arithmetic; provenance carries the
row ids the figure is composed of.

```diff
--- a/src/engine/serving/facts.py
+++ b/src/engine/serving/facts.py
@@ class FactsGateway(object):
     def ebitda(self) -> Fact:
         ...
 
+    def cash(self) -> Fact:
+        """Cash and bank balances as SERVED — the `cash_operating` and
+        `cash_fx` rows (adjusted amounts). Short-term investments are NOT
+        cash here: measured, `assembled_bs.cash` = cash_operating +
+        cash_fx on every corpus book (agras 1,168,047.04; with
+        short_term_investments it would be 2,074,573.46). Detector facts
+        `cash` and `total_cash`. A book with neither row REFUSES."""
+        cents = 0
+        present = []  # type: List[str]
+        for line_id in ("cash_operating", "cash_fx"):
+            try:
+                cents += self.statement_line(line_id).amount_minor
+                present.append(line_id)
+            except MissingFactError:
+                continue
+        if not present:
+            raise MissingFactError("served statement has no cash row")
+        return self._fact(cents, line_id="+".join(present))
+
+    def total_debt(self) -> Fact:
+        """Drawn debt (methodology ``totals.total_debt``) — measured equal
+        to lt_debt_bank + st_debt_bank + lt_debt_other on every corpus
+        book. Detector fact `bank_debt_total` (the solvency detector's
+        name for it; it includes lt_debt_other)."""
+        base = self._methodology_cents("totals.total_debt")
+        if base is None:
+            raise MissingFactError("envelope carries no methodology totals.total_debt")
+        return self._fact(base, line_id="totals.total_debt")
+
+    def net_debt(self) -> Fact:
+        """total_debt() − cash(): the solvency detector's `net_debt`.
+        NOT `methodology.totals.net_debt`, which also nets
+        short_term_investments and differs on three of five corpus books
+        (agras 2,472,155.29 vs 1,565,628.87). Two definitions cannot share
+        one name; if the methodology's is wanted, serve it as
+        `net_debt_after_investments()`."""
+        debt = self.total_debt()
+        cash = self.cash()
+        return self._fact(debt.amount_minor - cash.amount_minor,
+                          line_id="totals.total_debt-cash")
```

When these land: add `"cash": ("cash", ())`, `"total_cash": ("cash", ())`,
`"bank_debt_total": ("total_debt", ())`, `"net_debt": ("net_debt", ())` to
`engine.radar.serve.FACT_ACCESSORS`, remove the four names from
`WITHHELD_TODAY` in `test_radar_gates.py`, recapture the fixtures, and
`check_metric_declared.py` will see three new serving names (all three
are already-declared money facts).

`affiliate_income` cannot be an accessor: the envelope carries no class-76
split. It needs a methodology view field written at persist time
(`methodology.totals.participation_income` = `financial_income −
interest_income − fx_gain`, or the three lines), which is `chart_of_accounts`
/ `canonical_adapter` territory — flagged, not diffed.

### 7. `src/engine/api/_finding_rank.py` — Critical as a property of the GROUP (the ranker's side of A3 / A4)

Radar post-processes the report (`serve.retain_dismissed_critical_groups`)
until this lands; with it, the post-processing becomes a no-op and can be
deleted.

```diff
--- a/src/engine/api/_finding_rank.py
+++ b/src/engine/api/_finding_rank.py
@@ def rank_findings(
-    primaries = []  # type: List[Tuple[RankInput, Tuple[str, ...], Tuple[str, ...]]]
+    primaries = []  # type: List[Tuple[RankInput, Tuple[str, ...], Tuple[str, ...], bool]]
     for root in sorted(groups):
         members = sorted(groups[root], key=lambda i: _order_key(i))
         primary = members[0]
         others = members[1:]
+        # Critical is a property of the GROUP: the primary is picked by
+        # score, so a Critical with the smaller share is a contributor,
+        # and reading only the primary buried it under the cap and under
+        # a dismissal (design_review/radar/SERVE_GATES.md, A3 / A4).
+        group_critical = any(m.finding.severity == "critical" for m in members)
@@
-        primaries.append((primary, merged_from, contributor_rules))
+        primaries.append((primary, merged_from, contributor_rules, group_critical))
@@
-    for primary, merged_from, contributor_rules in ordered:
+    for primary, merged_from, contributor_rules, group_critical in ordered:
         dismissal = index.match(primary.finding.rule_id,
                                 primary.scope_key or primary.root_cause,
                                 primary.period_ordinal)
-        is_critical = primary.finding.severity == "critical"
+        is_critical = group_critical
```

(and `ordered = sorted(primaries, key=lambda t: _order_key(t[0]))` is
unchanged.)

### 8. `src/engine/api/_capsule_tools.py` — the content hash as the detectors' snapshot id (both surfaces, one commit)

```diff
--- a/src/engine/api/_capsule_tools.py
+++ b/src/engine/api/_capsule_tools.py
@@ def build_router():
-                    snapshot_id=str(row.get("source_document_id") or "") or None,
+                    # The envelope's content hash — the id the FactsGateway
+                    # stamps on every fact, so a row's evidence.provenance
+                    # joins to its gateway fact. The upload id stays on the
+                    # row under its own name.
+                    snapshot_id=(str(((envelope or {}).get("provenance") or {})
+                                     .get("content_hash") or "")
+                                 or str(row.get("source_document_id") or "") or None),
```

In the same commit, `engine.radar.serve.PeriodInput.engine_snapshot_id`
returns `self.snapshot_id or self.source_document_id` (the order flipped)
and `tests/engine/test_radar_gates.py::capsule_list_findings` passes
`snapshot_id=content_hash(fx)`; the fixtures are recaptured; R1 stays
byte-identical because both sides move together.

### 9. `tests/engine/test_findings_gates.py` — F5 reads the raw seam (the numerals lane's file)

```diff
--- a/tests/engine/test_findings_gates.py
+++ b/tests/engine/test_findings_gates.py
@@ def test_f5_plant_a_money_numeral_the_template_cannot_bind_is_refused(results):
     finding = a_finding(results)
-    planted = F.apply_advisory_narrative(
+    # The RAW renderer seam (`_finding`'s own function): once the Radar
+    # router has been mounted anywhere in the process the attribute is the
+    # guarded twin, which refuses the bare figure before the renderer sees
+    # it — the same order dependence S8 had.
+    planted = FS.unguarded_seam()(
         finding,
         rationale="For a mid-size inventory-heavy operator the exposure is "
                   "RON 9,999,999 at the balance-sheet date.")
```

(with `from engine.ai import finding_sharpen as FS` if the module does not
already import it.)

### 10. `supabase/schema_phase_radar.sql` — this lane's; apply per its runbook (after `schema_phase_multi_workspace.sql`; NOTIFY + Dashboard reload; verify `from_period_end` is visible to PostgREST).

---

## gates.md sections (verbatim)

## radar-gates

R1 + R2 + R3 + provenance (+ cap-as-data, materiality refusal, the marker,
the incremental cache, no model in the serving path). The failures are all
silent: a second findings source drifting from the Capsule's — by a
rounding, or by a whole envelope the route never put on the row it
rebuilt from; a Critical held under the cap because the ranker filed it as
a merged contributor of a lesser row; a dismissal that deletes; a figure
that contradicts the served envelope and is printed anyway. Subjects are
REAL ENGINE OUTPUT (TC-1): the committed captures under
`tests/engine/fixtures/radar` — the real pipeline's envelope + line items
for the corpus books, the statements rebuilt through the served seam with
account 121 anchored, the real detector engine over them, the real serving
layer's own payload. The loader-level R1 runs both real routers over a
PROJECTION-FAITHFUL client (`tests/engine/radar_fakes.ProjectingAdmin`),
which honours `columns=` as PostgREST does — the previous double returned
whole rows and hid that the route rebuilt off a row with no envelope
(design_review/radar/SERVE_GATES.md, A2).

| | |
|---|---|
| command | `python -m pytest tests/engine/test_radar_gates.py -q` |
| work count | junit-xml, floor **45** tests (measured: 58, rounded down) |
| canary | `test_r1_route_and_capsule_agree_through_their_own_loaders`, `test_r2_a_critical_buried_under_a_non_critical_primary_is_never_held`, `test_r3_dismissing_the_non_critical_primary_of_a_critical_group_retains_it`, `test_b3_plant_a_figure_that_contradicts_the_gateway_refuses_the_row_with_the_reason` |

Every plant was applied in an rsync sandbox of the tree by a runner that
restored the file byte-for-byte (sha256) before the green run; the live
tree and `design_review/PLANT_MANIFEST.json` were never touched. Full
transcripts: `design_review/radar/SERVE_GATES.md`.

**PLANT A2** — `_radar.full_row` hands the rebuild seam the light row without its envelope.

**RED** — exit `1`:

```
E   AssertionError: R1 ONE-SOURCE VIOLATED (loaders) — saga_10_col_agras/liquidity_cash_tight differs between the Capsule's loader and the route's on ['profile_fingerprint']; facts_cited capsule={'cash': 1168047.04, …
E   AssertionError: R1 ONE-SOURCE VIOLATED (loaders) — saga_10_col_realestate: list_findings serves liquidity_cash_tight and the route has no row for it
FAILED tests/engine/test_radar_gates.py::test_r1_route_and_capsule_agree_through_their_own_loaders[saga_10_col_agras]
================== 3 failed, 3 passed, 52 deselected in 1.67s ==================
```

**PLANT A3** — `cap.is_critical` reads the primary's severity only.

**RED** — exit `1`:

```
FAILED tests/engine/test_radar_gates.py::test_r2_a_critical_buried_under_a_non_critical_primary_is_never_held
FAILED tests/engine/test_radar_gates.py::test_r2_through_serve_a_buried_critical_group_surfaces_and_is_labelled
======================= 2 failed, 56 deselected in 0.54s =======================
```

**PLANT A4a** — `serve.retain_dismissed_critical_groups` returns the ranker's report unchanged.

**RED** — exit `1`:

```
E   AssertionError: R3 DISMISSAL VIOLATED — the group carrying the buried Critical fx_exposure left the surfaced list on a dismissal of its primary
FAILED tests/engine/test_radar_gates.py::test_r3_dismissing_the_non_critical_primary_of_a_critical_group_retains_it
================== 2 failed, 1 passed, 55 deselected in 0.60s ==================
```

**PLANT B3** — `serve.verify_facts` reports a mismatching figure as verified.

**RED** — exit `1`:

```
E   AssertionError: PROVENANCE VIOLATED — a row citing a figure the gateway contradicts was served
FAILED tests/engine/test_radar_gates.py::test_b3_plant_a_figure_that_contradicts_the_gateway_refuses_the_row_with_the_reason
======================= 1 failed, 57 deselected in 0.54s =======================
```

**PLANT INC** — the cache never hits (`found = None` in `RadarCache.get_or_build_with`).

**RED** — exit `1`:

```
E   AssertionError: INCREMENTAL VIOLATED — the engine ran 2 times
FAILED tests/engine/test_radar_gates.py::test_incremental_the_same_request_twice_runs_the_engine_once
```

**REVERT** — every plant restored, exit `0`:

```
============================== 58 passed in 3.05s ==============================
```

Verdict: **PROVEN RED** (five plants here plus the 2026-09-04 R1 / R2a /
R2b / R3 plants, each red for its own reason; the tests not about the
plant stayed green under every plant).

---

## radar-determinism

R4 — same snapshot, same bytes: ten runs, a credential present or absent,
the AI SDK blocked at import, history and dismissals handed over in any
order, and equal to the committed capture. The REAL explain lane
(`engine.radar.explain` over a stub model, through `explain.attach` — the
one writer of `row["explanation"]`) adds prose and nothing else, and the
explained payload strips back to the deterministic bytes. A surface that
moves between two opens with nothing changed teaches the reader to
distrust it; one that moves because a model was reachable teaches them the
model decides.

| | |
|---|---|
| command | `python -m pytest tests/engine/test_radar_determinism.py -q` |
| work count | junit-xml, floor **12** tests (measured: 17, rounded down) |
| canary | `test_r4_ten_runs_are_byte_identical_and_match_the_committed_golden`, `test_r4_the_real_explain_lane_attaches_prose_only_and_strips_back_to_the_same_bytes` |

**PLANT R4** — a clock in the payload (`serve.compose`: `"served_at": datetime.now().isoformat()`), the 2026-09-04 plant.

**RED** — exit `1`:

```
E   AssertionError: R4 DETERMINISM VIOLATED — 10 distinct payloads in 10 runs
FAILED tests/engine/test_radar_determinism.py::test_r4_ten_runs_are_byte_identical_and_match_the_committed_golden[saga_10_col_carniprod]
```

**REVERT** — exit `0`:

```
============================== 17 passed in 2.05s ==============================
```

Verdict: **PROVEN RED**

---

## radar-route

The route over a PROJECTION-FAITHFUL PostgREST double: the envelope is on
the row the rebuild seam reads, so Radar serves account 121 as statutory
net income like every other surface (`saga_10_col_retail`: 3,205,212.62,
never the reconstruction 1,161,957.98); the light projection names only
columns `financial_periods` carries (no `period_label`, no `caen_code` —
naming one is a PostgREST 400); a dismissal is anchored on its period, so
an earlier upload moves nothing; the rows return with the model dead,
asleep and hostile; mounting the router installs the F9 numeral guard on
the served path; an unchanged open loads line items zero times.

| | |
|---|---|
| command | `python -m pytest tests/engine/test_radar_route.py -q` |
| work count | junit-xml, floor **20** tests (measured: 26, rounded down) |
| canary | `test_the_route_serves_account_121_as_statutory_net_income_like_every_other_surface`, `test_a4_a_dismissal_is_anchored_on_its_period_not_on_a_spine_position`, `test_the_rows_return_while_the_model_sleeps_through_the_route`, `test_b6_mounting_the_router_installs_the_f9_guard_on_the_served_path` |

**PLANT P121** — the `p121` alias dropped from `LIGHT_PERIOD_COLUMNS`.

**RED** — exit `1`:

```
E   AssertionError: the account-121 anchor is not on the light projection
FAILED tests/engine/test_radar_route.py::test_the_light_projection_names_only_columns_the_table_carries
======================= 2 failed, 24 deselected in 0.45s =======================
```

**PLANT A4b** — `_radar.anchor_ordinal` returns the STORED spine position.

**RED** — exit `1`:

```
E   AssertionError: A4 VIOLATED — adding an earlier period moved the dismissal off the period it was made on (p-a-2025 now shows liquidity_cash_tight again)
FAILED tests/engine/test_radar_route.py::test_a4_a_dismissal_is_anchored_on_its_period_not_on_a_spine_position
```

**PLANT B5** — `serve_for` returns without attaching the explain lane.

**RED** — exit `1`:

```
E   KeyError: 'explanation'
FAILED tests/engine/test_radar_route.py::test_the_route_attaches_cached_explanations_before_the_rows_return_and_drafts_after
FAILED tests/engine/test_radar_route.py::test_the_rows_return_while_the_model_sleeps_through_the_route
====================== 4 failed, 22 deselected in 31.35s =======================
```

**PLANT B6** — the `_finding_advisory` import dropped from `build_router`.

**RED** — exit `1`:

```
E   AssertionError: B6 VIOLATED — mounting the Radar router did not install the F9 guard on _finding.apply_advisory_narrative
FAILED tests/engine/test_radar_route.py::test_b6_mounting_the_router_installs_the_f9_guard_on_the_served_path
======================= 2 failed, 24 deselected in 1.38s =======================
```

**REVERT** — every plant restored, exit `0`:

```
============================== 26 passed in 5.99s ==============================
```

Verdict: **PROVEN RED**
