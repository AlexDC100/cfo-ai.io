# Mutation testing on the kernel (C1)

Mutation testing asks the question the line-coverage number dodges: *if
this exact line computed something subtly wrong, would any test notice?*
Every mutant is a deliberate single-site bug injected into a kernel
function; a mutant that survives the suite is a bug the battery would
ship. C1 runs mutmut over the frozen numeric kernel, triages EVERY
surviving mutant (killing test or documented equivalence — no third
category), and pins the measured score as a gate.

## Tool: mutmut 3.3.1 (pinned `>=3.3,<3.4` in the `dev` extra)

* Verified on the project interpreter (py3.9.6, `.venv`). 3.3.1 is the
  newest release, not a compatibility downgrade.
* mutmut 3 never touches the real source tree: it emits a `mutants/`
  copy in which every mutated function carries all of its mutants plus a
  trampoline that dispatches on `MUTANT_UNDER_TEST`. One stats pass maps
  tests→functions; each mutant then runs only its covering tests with
  `-x`, forked from a warm parent. (This is why it beats mutmut 2 here:
  no in-place mutation of `src/engine` ever happens, which the
  non-destructive contract cares about, and per-mutant cost is the
  covering tests only.)
* Runner: **`scripts/run_mutation_kernel.py`** — the only supported way
  to run this. It provisions a gitignored workdir
  (`data/mutation/work/`), generates the mutmut config, drives mutmut
  in-process, scores the `.meta` results per module, writes
  `data/mutation/report-latest.json`, and enforces the pinned floors
  with `--check`. Direct `mutmut run` at the repo root is deliberately
  unconfigured (a bare run would try to mutate all of `src/` and fail
  loudly on the missing config; don't).

### Why the runner drives mutmut in-process (not `python -m mutmut`)

1. The generated trampolines do `from mutmut.__main__ import
   record_trampoline_hit`. Under `python -m mutmut` the module is
   registered only as `__main__`, so the trampoline's import RE-EXECUTES
   `mutmut/__main__.py`, whose module level calls
   `set_start_method('fork')` — `RuntimeError: context has already been
   set`. Importing `mutmut.__main__` as a real module first (the console
   script does the same) fixes it.
2. The dataclass patch below has to be applied before mutant
   generation, in the same process.

### The dataclass patch (why `Money` gets mutated at all)

Stock mutmut 3 skips EVERY decorated `FunctionDef`/`ClassDef`
(`file_mutation.py::MutationVisitor._skip_node_and_children`, comment:
decorator side effects / `@property` trampoline breakage). Consequence
measured on this repo: `engine.ir.money` produced **46** mutants — all
in the four module-level helpers — and **zero** for the entire
`@dataclass(frozen=True) class Money` body, i.e. none for the algebra,
ordering, `__post_init__` validation, or `to_decimal_str` string math.
That would have made the money score a fiction.

`run_mutation_kernel.py::_patch_mutmut_dataclass_classes()` narrows the
skip: a ClassDef whose decorators are ALL `dataclass` / `dataclass(...)`
/ `dataclasses.dataclass(...)` is descended into, so its *undecorated*
methods are mutated (money.py: 46 → 246 mutants). This is safe for
dataclasses specifically because:

* mutmut's per-method machinery already supports class methods (mangled
  `xǁClassǁname`); only the visitor skip blocked it;
* the injected `..__mutmut_mutants` dicts are `ClassVar`-annotated, so
  `@dataclass` does not read them as fields (string annotations under
  `from __future__ import annotations` included — `dataclasses` handles
  textual `ClassVar`);
* `frozen=True` is untouched: trampolines assign attributes on function
  objects, never on instances.

Validated by generation probe (parse + import + smoke of the trampolined
`Money`: construction, algebra, ordering, serialization) and by the
suite passing against the trampolined-but-unmutated tree in every run's
clean phase, plus mutmut's forced-fail canary.

**Upstream-limitation gap (documented, not hidden):** decorated
FUNCTIONS remain unmutated everywhere — for the kernel that means:

| file | unmutated (decorated) defs |
|---|---|
| `engine/ir/money.py` | `from_minor`, `zero`, `from_decimal_str`, `from_dict` (`@classmethod`) |
| `engine/passes/classify.py` | `ClassificationLayer.by_atom_id` (method un-decorated → mutated); `classified_count`/`unclassified_count` (`@property`) |
| `engine/journal/journal.py` | `Journal._read_jsonl`, `Journal._parse_ts` (`@staticmethod`) |

The `@classmethod` constructors are the real hole (the parse path
`from_decimal_str` above all). Compensation: they are exercised
directly by `tests/engine/test_ir_types.py` (grammar accept/reject,
exactness, no-rounding law) and `tests/engine/test_properties.py`
(round-trip laws), and the module-level helpers they delegate to
(`scale_for_currency`, `_check_*`) ARE mutated. Follow-up on the
nightly list: upstream a classmethod-aware trampoline to mutmut rather
than deepening the private-API patch.

Module-level constants (e.g. `CURRENCY_SCALES`) are outside mutmut's
model entirely (it mutates function bodies only); the table is locked
by explicit tests instead.

## Run mechanics (what the runner builds)

```
data/mutation/work/
  pyproject.toml      # GENERATED [tool.mutmut] + EMPTY [tool.pytest.ini_options]
  sitecustomize.py    # GENERATED (see below)
  src -> <repo>/src   # plus tests, files, scripts, packs, corpus,
  ...                 # methodology, docs, config.yaml symlinks
  mutants/            # mutmut's output tree — tests run HERE
```

* `paths_to_mutate = ["src/engine"]` with `do_not_mutate` = every
  engine `.py` EXCEPT the six kernel files, enumerated exactly and
  regenerated per run (new engine modules can never drift into scope).
* The empty `[tool.pytest.ini_options]` is load-bearing: without it,
  pytest's ini discovery inside `mutants/` walks up to the repo
  `pyproject.toml`, inherits its `addopts = "-v --tb=short"`, and dies
  with usage-error exit 4 (rootdir/ini conflict).
* `also_copy` brings `tests/`, `files/`, `scripts/`, `packs/`,
  `corpus/`, `methodology/`, `docs/`, `config.yaml` into `mutants/` —
  the suites resolve `REPO` from their own `__file__`, so inside the
  tree every repo-relative read (golden corpus, pack root, envelope
  schema, `files/` fixtures) hits the COPY. The sacred `corpus/` and
  `packs/` are never opened for write by anything in the run; even
  `test_properties.py`'s failure-quarantine writes land in
  `mutants/corpus/quarantine/`, not the real corpus.
* `sitecustomize.py` (exported via `PYTHONPATH`): tests that spawn
  fresh interpreters (`TestCrossProcessDeterminism`) inherit
  `MUTANT_UNDER_TEST`. In a fresh process the `stats` phase would crash
  (`mutmut.config` is None there) and could not contribute test→mutant
  mapping anyway, so `stats` is neutralized to `''`; **named mutants
  are kept** so a subprocess-based determinism test can genuinely kill
  a mutant (cross-process hash-stability killed several `__post_init__`
  normalization mutants exactly this way).
* Tests given to mutmut (`TESTS_DIR` in the runner): the 12
  kernel-relevant engine suites + `test_mutation_regressions.py` (the
  killing tests added by triage). The stats pass runs them all once
  (~40 s); each mutant then runs only its covering tests. New tests
  added between runs are picked up by mutmut's incremental stats
  ("Found N new tests, rerunning stats collection") — no fresh tree
  needed for a triage iteration.
* **Result-reset semantics (measured on 3.3.1, upstream TODO):** every
  `mutmut run` REGENERATES the mutants for all non-ignored files and
  resets their recorded exit codes to None — per-function hash
  preservation is explicitly unimplemented upstream
  (`write_all_mutants_to_file`: "function hashes are currently not
  used"). Consequence: a scoped `--modules X` run wipes every OTHER
  module's recorded results, so **scoped runs are triage iteration
  only; the quotable gate verdict always comes from one invocation
  that executes the full default-gate filter set.** The gate cannot
  false-pass on a stale tree: `--report-only --check` on a scoped
  tree scores the unexecuted modules as `not checked` and exits 2
  (INCOMPLETE) — verified live during the C1 close-out.

## Scoring + gate semantics

* caught = `killed` + `timeout` (a hang IS detection).
* missed = `survived` + `no tests` + `suspicious` (a kernel mutant no
  test even reaches is a coverage hole, so it counts against the score).
* `skipped` excluded; ANY in-scope `not checked` → the run is
  INCOMPLETE and `--check` exits 2 — the gate never passes on partials.
* Documented equivalent mutants are excluded from the denominator via
  `EQUIVALENT_MUTANTS` in the runner; every id there has a row in the
  triage log below. Mutant ids are positional (`<fn>__mutmut_<n>`):
  any sanctioned edit to a kernel function renumbers that function's
  mutants → re-triage that function and refresh its ids here.

## Scope + measured scores (final `--fresh` full-kernel run, 2026-08-24, HEAD 6660ba0 + C1 tree)

<!-- SCORES:BEGIN — filled by the C1 wave's measured run -->
mutmut 3.3.1 · py3.9.6 · 14-core Apple Silicon · **GATE: PASS, exit
0** · ≈16 min wall for the whole invocation (mutant generation ~36 s;
the stats pass over the 13 suites dominates the fixed cost; in-scope
mutant execution ran at 8.77 mutants/s). 5,387 mutants are generated
across the six kernel files each run; the 1,729 in the default-gate
scope all execute (out-of-scope mutants stay `not checked` and are
invisible to scoring; `canonical_bs_v2`'s 1,093 run only in their
dedicated job).

| module | scope | mutants | equivalents | caught | score | pinned floor |
|---|---|---|---|---|---|---|
| `money` | whole file | 246 | 0 | 246 | **100.00%** | 100% |
| `reconcile` | validator + trigger + placement | 583 | 16 | 567 | **100.00%** | 100% |
| `classify` | whole file | 182 | 1 | 181 | **100.00%** | 100% |
| `journal_events` | whole file | 116 | 4 | 112 | **100.00%** | 100% |
| `journal` | hash-chain scope | 602 | 7 | 595 | **100.00%** | 100% |
| **default gate overall** | | **1,729** | **28** | **1,701** | **100.00%** | **100%** |
| `canonical_bs_v2` | build_canonical_bs_v2 region | 1,093 | — | — | measured-and-deferred | 85% provisional, dedicated nightly job |

Raw pre-triage kill rates — what the battery alone caught before C1:
money 71.95%, reconcile 66.72%, classify 73.08%, journal_events
47.41%, journal (chain scope) 57.5%. The gap between those numbers
and 100% is the C1 deliverable: **105 killing tests** in
`tests/engine/test_mutation_regressions.py` (each naming the mutant
ids it kills) plus **28 documented equivalents** (each with a
justification row below, mirrored in the runner's
`EQUIVALENT_MUTANTS`). Floors are pinned at the measured 100% —
kill-vs-survive is deterministic for these suites (derandomized
hypothesis profile, tmp-path isolation, timeouts count as caught), so
any future survivor is a real coverage regression and must force a
triage, never ride below a slack floor.
<!-- SCORES:END -->

## Nightly / PR profiles

* **Nightly (full kernel):**
  `.venv/bin/python scripts/run_mutation_kernel.py --fresh --check`
* **PR (touched kernel files only):**
  `.venv/bin/python scripts/run_mutation_kernel.py --files <changed files, comma-separated> --check`
  — exits 0 immediately when no kernel file is in the diff, so it is
  safe to run unconditionally.

## Nightly gap-closure backlog (in priority order)

0. **Finish `canonical_bs_v2`** (see its section above): run
   `.venv/bin/python scripts/run_mutation_kernel.py --modules canonical_bs_v2 --check --workdir data/mutation/canonical`
   in a dedicated job (budget 120 min locally / dedicated nightly job
   on CI), triage the survivors, pin its floor, and only then consider
   flipping `default_gate` back on (likely keeping it nightly-only —
   the timeout economics don't change). The separate `--workdir` is
   REQUIRED, not cosmetic: mutmut's result-reset semantics (above)
   mean a scoped run in the default workdir would wipe the nightly
   full-kernel run's recorded results.
1. **journal.py non-chain surfaces**: extend `KERNEL_MODULES["journal"]`
   filters to the DLQ (`record_failure`, `resolve_dlq_for`,
   `dlq_entries`, `dlq_depth`), as-of reconstruction (`asof`,
   `resolve_chain`, `_chain_file_hash_of`, `snapshots`, `_parse_ts`,
   `last_snapshot_event`, `last_served_normalized_hash`) and GC
   (`referenced_digests`, `gc_orphans`) — ~430 additional mutants,
   whole-file raw kill rate on the first run was 57%, so expect a
   triage of similar shape to the chain scope.
2. **`engine.journal.store` (SnapshotStore)** — the content-addressed
   object store backs the chain's snapshot guarantee but is not yet in
   scope; small file, add whole.
3. **Upstream a classmethod-aware trampoline to mutmut** so the
   `@classmethod` constructors (money's `from_decimal_str` above all)
   stop being a permanent limitation — or extend the runner's patch
   with a classmethod template if upstream stalls.
4. **`canonical_adapter` beyond the v2 region** (`assemble_canonical`,
   `compute_round_trip_check`, `_sign_aware_canonical`,
   `_side_flip_canonical`, `_route_line_item`) once the v2 region holds
   its floor for a few nights.

## Triage log — surviving mutants

Rule: every survivor gets exactly one of
(a) a **killing test** in `tests/engine/test_mutation_regressions.py`
(test name references the mutant id), or
(b) an **equivalent-mutant** row here (id, mutation, why no observable
behavior can differ) mirrored into `EQUIVALENT_MUTANTS`.
There is no third category.

<!-- TRIAGE:BEGIN -->

### `engine.ir.money` — 246 mutants, raw 71.95% (177/246), post-triage **100%**

69 survivors on the first full run, all four function families below.
All 69 were killed by 21 new tests in
`tests/engine/test_mutation_regressions.py`; **no equivalent mutants
were claimed** — every survivor turned out to encode an observable
behavior difference worth pinning.

| family | survivors | what survived | killing tests |
|---|---|---|---|
| Ordering boundary swaps | `__lt__/__le__/__gt__/__ge__ __mutmut_1` (4) | strict↔inclusive operator swaps at EQUAL amounts — the entire battery (property suite included) never ordered two equal Moneys. The one genuinely alarming find of this module: `a >= b` could have silently become `a > b`. | `TestMoneyOrderingBoundary` |
| Typed-error message integrity | `_check_currency` 2,4,5,7,12,14,15 · `_check_int` 3,5,6,8 · `_check_scale` 3,6,7,12,14 · `_require_same_unit` 2,4,5,7,11,13 · op-name args in `__add__/__sub__/__lt__/__le__/__gt__/__ge__` 3,6,7 each · `__post_init__` 19,22,23 (18+18) | `MoneyParseError(None)`, `XX…XX` wraps, case flips, `type(None)` substitutions, and the `what`/`op` argument mutants — all only visible in exception TEXT. The messages name the operation, the offending type, and the law; that is the debugging surface. | `TestMoneyErrorMessageContract` (full-string equality on every rejection path) |
| A-### assert message precision | `_require_same_unit` 21,24,26,27,28,29 (A-001) · `__neg__` 4,7 (A-002) · `to_decimal_str` 11,13,14 (A-003) · `__add__` 20,22,23 (A-004) · `__sub__` 20,22,23 (A-005) | witness tests match the id SUBSTRING (`match="A-004"`), which XX-wraps/case-flips still satisfy. The catalog says the id is the identity — so the id + exact message head is now pinned. | `TestMoneyAssertMessagePrecision` |
| Domain boundary + construction hygiene | `to_decimal_str` 9 (A-003 domain `<=` → `<` at scale 9) · `__post_init__` 16,17,30,31 (`object.__setattr__` to a wrong attribute name) | scale-9 Money (a real ISO case — one code away from KWD-class exponents) would have been REFUSED by the tightened assert; the setattr-name mutants leave a stray attribute in `vars()` and skip the normalize-write. | `TestMoneyRenderBoundaryAndShape` (scale-9 render + round-trip; `vars(m)` == exactly the three fields) |

Unmutated in this module (decorated defs — see the limitation table
above): `from_minor`, `zero`, `from_decimal_str`, `from_dict`.

### `engine.journal.events` — 116 mutants, raw 47.41% (55/116), post-triage **100% of scoreable** (112 killed + 4 equivalent)

The worst raw score in the kernel, and the most instructive: the
hash-chain's canonical serialization was almost entirely unpinned.

* **Systemic finding — self-consistent serialization drift.** Every
  mutant of `canonical_bytes`'s json.dumps arguments (sort_keys off,
  ensure_ascii on, separators changed) survived, because `make_event`
  and `verify_event` SHARE the function: the chain hashes and verifies
  consistently while the byte format silently forks from every
  already-written journal on disk. Killed by
  `TestCanonicalBytesContract` — exact canonical bytes plus a PINNED
  GOLDEN SHA-256 (`_GOLDEN`). If that constant ever changes
  intentionally, existing chains break: bump `EVENT_SCHEMA_VERSION`
  and migrate, never just update the constant.
* **The `default=str` lossy fallback had zero coverage** (16 of the 27
  `canonical_bytes` survivors): mutants could drop `sort_keys`, drop
  `default=str` (making the fallback CRASH instead of flagging lossy),
  or flip the `lossy` return to False — the flag `record_snapshot`
  relies on to refuse unfaithful checkpoints. Killed by the
  lossy-fallback exact-bytes/flag tests. `encode(None)` (mutant 17)
  was the subtle one: TypeError from `.encode` is swallowed by the
  strict path's `except (TypeError, ValueError)` and silently
  reclassifies a perfectly strict payload as lossy.
* **`strip_volatile` membership INVERSION survived** (`k in
  VOLATILE_KEYS` → `k not in`): dedup tests compare two normalizations
  of the same mutant, so inversion is self-consistent. Killed by
  pinning the absolute normalized output (`TestStripVolatile`).
* Event shape + error texts (`make_event` key set, unknown-type
  message, `verify_event`'s three error strings naming run/seq/hash):
  killed by `TestJournalEventShape` full-string equality.
* **Equivalent (4):** `canonical_bytes` 15 & 33 ("utf-8"→"UTF-8" —
  codec lookup is case-insensitive, identical bytes both paths); 4 &
  20 (`ensure_ascii=False`→`None` — json.dumps only truth-tests the
  flag, so None ≡ False on both paths).

### `engine.api._reconcile` (validator + trigger + placement scope) — 583 mutants, raw 66.72% (389/583), post-triage **100% of scoreable** (567 caught + 16 equivalent)

194 survivors on the first run (167 triaged in the first pass; the last
27 — the whole trigger surface `_gate_ok` + `compute_reconcile_offer`
plus two `validate_proposal` renders — in the second). Families and
their kills (all in `test_mutation_regressions.py`):

* **The validator's dual-close AND-mutant** (`totals != 0 OR partition
  != 0` → AND, `validate_proposal` 97) — accepts a proposal when only
  ONE of the two independent closes holds. THE core defense of the
  auto-reconcile stage. Killed by two asymmetric fixtures: rows close
  while totals don't, and totals close while rows don't
  (`TestValidateProposalPrecision`).
* **Partition-sign inversion** (`_recompute_partition_difference_cents`
  20, `in _ASSET_SECTIONS` → `not in`) — survived because every
  previously-tested case closes to exactly 0, and 0 is sign-invariant.
  Killed by pinning the SIGNED partition value in the NONZERO_CLOSE
  detail ("partition 0.01 RON" vs the inversion's "-0.01").
* **Gate-denominator key mutants** (`_gate_checks` 63–70,
  `validate_proposal` 31–38): assets vs E+L keys feeding
  `max(|assets|, |E+L|)`. Only distinguishable when `|diff| × 1000`
  lands strictly between the two sides — killed by fixtures placing
  the 0.1% boundary exactly there, on each side.
* **Trigger semantics** (`_gate_checks` 29 OR→AND, 31, 32–40
  BALANCED-status detection): a BALANCED statement with residual drift
  must still refuse to reconcile; a 1-cent drift must remain
  reconcilable. Direct trigger tests.
* **`_apply_adjustment` structure**: full-dict equality on four
  scenarios (BS positive with the section-append path, BS negative, PL
  with result row, PL WITHOUT result row — that fallback had zero
  coverage and hid the `next(gen, None)` default-drop mutant 112 and
  the whole "equity"-literal family 139–150). Plus the 1-cent branch
  boundary, and the NON-closing apply (difference 1.5) that finally
  exposes the `difference` cents→RON scaling mutants 235/237 — zero
  was scaling-invariant in every closing test.
* **Rejection payloads are the served 409 bodies**: every rejection
  path is now pinned by full-payload equality (code + exact detail
  text incl. formatted RON values, which kills the `/100.0` → `/101.0`
  rendering family).
* `_cents` exception fallback (`return 0` → `1`) — killed directly
  with unparseable inputs.
* **The trigger's offer function had NOTHING asserting its output**
  (`compute_reconcile_offer`, 21 survivors — every mutant of every
  line that executes after the `needs_review` guard). Covering tests
  executed it via the serving path but never distinguished its answer.
  The survivors included: the `needs_review` DEFAULT flipped to True
  (every legacy no-kwarg call site would offer on any sub-threshold
  drift the auto stage never judged), the entire status lookup
  neutered (a BALANCED/RECONCILED statement would offer), both
  vocabulary literals, the terminal-status early return flipped, and
  all eight totals-key mutants feeding the gate's max() denominator.
  Killed by `TestComputeReconcileOffer` — default-kwarg silence,
  terminal-status silence, and the two one-sided denominator fixtures
  (diff exactly 0.1% of the LARGER side only, so zeroing either key
  collapses `max()` to the smaller side and refuses).
* **`_gate_ok` guard flips** (4 survivors): `or`→`and` lets a ZERO
  difference through the guard, where `0 * 1000 <= denom` answers True
  — the gate would trigger on an already-closed statement; the guard's
  `return False`→`True` is its blunt twin. Killed by
  `TestGateOkBoundary` (zero-diff, zero-denominator, and the exact
  0.1% boundary on each side of the max()).
* **The `%.2f` rounding trap** (`validate_proposal` 122/124): the
  NONZERO_CLOSE cents→RON renders (`/100.0`→`/101.0`) survived the
  full-payload equality tests because every prior fixture closed by
  exactly 1 cent — and `"%.2f" % (1/101)` still renders `0.01` (0 is
  scaling-invariant, the same trap already documented for
  `_apply_adjustment` 235/237). Killed by a full-RON fixture on BOTH
  halves (totals `1.00` vs mutant `0.99`, partition `-1.00` vs
  `-0.99`) in `test_nonzero_close_render_magnitude_exact`.
* **Equivalent (16):** the `or "" → or "XXXX"` sentinel family (8 ids
  — fallback feeds only ==/`in` probes against vocabularies containing
  neither, never stored; `compute_reconcile_offer` 10 joined the
  original 7); `validate_proposal` 44/45 (the three gate clauses share
  ONE raise site — shifting which clause fires at denom∈{0,1} raises
  the identical exception); `_gate_ok` 9/10 (the boolean twin of the
  same argument: denom = max(abs, abs) is never negative, and no
  nonzero diff satisfies `|diff|*1000 <= denom` for denom∈{0,1} — the
  guard and the ratio agree on every input, verified by exhaustive
  sweep over the boundary band); 73/77 (the validator discards the
  trial and both placements move the same amount onto the E+L side, so
  trial placement cannot change accept/reject); `_apply_adjustment`
  158 (`>0`→`>=0`: amount 0 unreachable at every call site);
  `_placement_for` 17 (`>0`→`>=0` inside a ternary guarded by
  `!= 0`). Full list with ids in `EQUIVALENT_MUTANTS`.

### `engine.journal.journal` (hash-chain scope) — 602 mutants, raw 57.5% (346/602), post-triage **100% of scoreable** (595 caught + 7 equivalent)

Scope note: the C1 boundary for this file is the HASH CHAIN — append/
write path, run registration + cross-run linkage, chain read/verify,
snapshot commit + duplicate-delivery identity, serve-seam observation.
The DLQ management surface, as-of reconstruction (`asof`,
`resolve_chain`, `snapshots`) and GC (`gc_orphans`,
`referenced_digests`) are deliberate non-scope this wave (still
battery-tested by test_journal/test_crash_safety) — first item on the
nightly gap-closure backlog below.

256 in-scope survivors on the first run, killed across two passes:

* **The chain's audit report was almost entirely unpinned**
  (`verify_chain`, 59 survivors): every error string, the
  one-defect-must-not-stop-the-scan rule (`continue`→`break` survived),
  the seq-expectation recovery after a gap, the corrupt-line reset
  (`prev_hash = None` vs `""` — only the exact "expected None" text
  distinguishes them), snapshot-object missing/corrupt detection
  (`or`→`and` on the digest/store probe), and SNAPSHOT_PERSISTED type
  detection. Killed by `TestVerifyChainReporting` — real on-disk
  torture chains asserting the EXACT full error list.
* **The K3 duplicate-delivery contract returned unpinned dicts**
  (`record_snapshot`, 109 survivors): both short-circuit branches'
  result dicts, the dedup condition's `and`→`or` weakenings (a distinct
  analysis with the same key halves must NOT be swallowed as a
  duplicate), the SNAPSHOT_PERSISTED payload + period index line + key
  halves (`extract_snapshot_key` — 18 survivors of its own), snap-id
  shape, SimulatedCrash messages, the duplicate log line, the
  non-fatal-aid handlers (index write / DLQ resolution failures must
  not fail the commit — forced via monkeypatched raises), and DLQ
  resolution keyed by BOTH document_id and file_hash (two dead letters
  each matchable by only one key).
* **Registration + linkage** (`begin_run`/`_ensure_registered`/`flush`):
  exact index entries, RUN_STARTED payload, prev_run_id chaining,
  tail-seeded prev_event_hash, resume-runs-are-provisional, buffered→
  flush-in-order-exactly-once, and the flush guard weakening that let a
  short-circuited run REGISTER itself in the document index.
* **Storage addressing**: `runs/`/`index/` path literals are pinned by
  STRING comparison — macOS APFS is case-insensitive, so the
  `"runs"→"RUNS"` mutants pass every filesystem probe locally while
  breaking on the case-sensitive production filesystem. (The two
  survivors that taught us this are the reason the test asserts the
  path string, not `is_file()`.) Plus: `sanitize_key` bounds, and the
  append path recreating a wiped journal tree (`parents=True` is
  crash-resilience, killed by wiping the root mid-run).
* **Equivalent (7):** `flush`/`record_snapshot` `_buffer = None`
  post-short-circuit (unreachable reads — 2), `observe_serving`
  dropping `period_id=None` (≡ default), `_append_line` fcntl guard
  flips (cross-process concurrency guard, not deterministically
  unit-killable — 2), and two mutmut generation artifacts whose emitted
  bodies are byte-identical to the original (verified by raw diff).

### `engine.passes.classify` — 182 mutants, raw 73.08% (133/182), post-triage **100% of scoreable** (181 caught + 1 equivalent)

> **Correction (2026-08-24, C1 close-out).** An interim mid-session
> run had recorded classify at 100% with zero survivors, and an
> earlier revision of this page said so. The first end-to-end
> `--fresh` run on the FINISHED runner configuration did not reproduce
> 49 of those kills — the interim meta was an artifact of the evolving
> mid-session workdir (the stats/tests configuration changed between
> passes and that tree is gone), not evidence of coverage. The gate
> design absorbed it as intended: the fresh run surfaced all 49 and
> `--check` failed until they were triaged. Procedural rule locked by
> this incident: **only `--fresh` full-run numbers are quotable; an
> interim scoped tree is never a score.**

49 survivors on the honest run, all triaged (48 killed by 18 new tests
in `test_mutation_regressions.py`, 1 equivalent). What the shadow
oracle taught us by NOT catching these:

* **The shadow comparator pins line ASSIGNMENT, and assignment only
  reads the SIGN of the net side computation** — so sign-preserving
  arithmetic corruption sails through it:
  - `_minor_at` 13: rescale exponent `scale − money.scale` →
    `scale + money.scale`. At equal scales every value is multiplied
    by 10^(2·scale) — grossly wrong minor units, identical sign,
    identical assignments. Killed by exact-value tests
    (`TestClassifyRescaleExact`).
  - `_net_signed_minor` 9: `total +=` → `total =` (only the last pair
    survives the sum) — sign-invariant on every corpus case. Killed by
    a two-pair exact sum.
  - `_minor_at` 2 / `_net_signed_minor` 4: absent-slot/empty `return 0`
    → `1` (a phantom minor unit). Killed by exact zero assertions.
  - `effective_closing_side` 1 (`or`→`and`: a ONE-SIDED closing pair —
    the normal RAS shape — falls through to the opening+period
    identity) and 9 (`net > 0` → `net > 1`: a one-minor-unit balance
    loses its side). Killed by `TestClassifySideBoundary`.
* **Every error/assert text was unpinned** (the A-02x witnesses match
  the id SUBSTRING, the same gap money's A-00x family had): the two
  `ClassifyError` input-guard messages (incl. the `%`→`/` mutant that
  turns them into TypeError), and the A-020/A-021/A-022/A-023/A-024/
  A-025/A-026 texts. Killed by `TestClassifyErrorMessageContract` +
  `TestClassifyAssertMessagePrecision` (full-string equality; the
  A-025/A-026 texts are reached with the witnesses' TOCTOU evil-doc
  technique, message pinned with concrete counts).
* **The emitted layer's flag fields had no value-level test**: the
  UNCLASSIFIED branch's `side_flipped`/`closing_side` corrupted to
  None/True/dropped, and the rule branch's `flipped = False` → None.
  The shadow compares assignments, not entry fields. Killed by
  full-equality entry pinning in `TestClassifyEntryShape` — an
  unmatched 9999 atom, the no-flip-rule 8035 case, and the 4111
  credit-side flip both firing and NOT firing.
* **A-024's domain clauses** (`0.0 <=` → `1.0 <=` / `<=` → `<`): no
  test ever CONSTRUCTED a valid boundary confidence; killed by legal
  0.0/0.5/1.0 constructions.
* **Equivalent (1):** `x_classify` 35 — the UNCLASSIFIED-branch
  constructor drops its `side_flipped=False` keyword, and False IS the
  dataclass default: the constructed entry is field-for-field
  identical for every input. A redundant-kwarg generation artifact.

### `engine.country_packs.ro_romania.canonical_adapter` (build_canonical_bs_v2 region) — MEASURED AND DEFERRED to a dedicated nightly job

1,093 in-scope mutants (1,009 inside `build_canonical_bs_v2` itself +
the region helpers `_cents`, `_section_for_leaf`, `_matched_ras_prefix`,
`_excluded_reason`; `_load_run_bs_diagnosis` is import plumbing and
excluded). The measurement run (2026-08-23) processed 107 mutants in
~8 minutes on 14 cores — **43 killed, 64 timeouts, 0 survivors** —
projecting **75–90 minutes locally** and several hours on 2-core CI
runners. The cost driver is structural: the region is one long
cents-accumulation loop, so a large fraction of its mutants become
non-terminating or pathologically slow, and each such mutant burns
~30× its covering tests' CPU before mutmut's SIGXCPU kill converts it
to `timeout` (which counts as caught — the detections are real, just
expensive).

Decision per the C1 budget rule ("measure first, drop if > ~30 min"):
`canonical_bs_v2` carries `default_gate: False` in the runner — the
default full-kernel gate and the PR profile skip it; running it
requires an explicit `--modules canonical_bs_v2`. **This is the
nightly's first dedicated task**: a separate job with its own
120-minute budget (see backlog below). The early signal is good — zero
survivors in the first 107 — but a 10% sample is not a score, so no
number is claimed and no floor is pinned until the full run completes.

<!-- TRIAGE:END -->
