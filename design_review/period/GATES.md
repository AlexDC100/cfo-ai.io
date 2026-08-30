# Period-assignment integrity — gates W1..W6

**Lane:** GATES (W1–W6). **Date:** 2026-08-30.
**Battery gate name:** `period-integrity`
(`scripts/run_battery.py`, one line, immediately after `corpus-replay`).

```
.venv/bin/python -m pytest tests/engine/test_period_integrity_gates.py -q
npx vitest run frontend/lib/__tests__/periodGates.test.ts
```

---

## The defect these gates exist for

`documents.period_end_hint` is a **confirmation channel**: it means *a human
confirmed that THIS document belongs to THIS month*. The engine's
`stage_persist` ranks it **above** its own detection precisely because of that
meaning — and its own comment says so.

The frontend filled that channel with the **drop target's** date
(`uploadDocument(file, { periodEndHint: p.period_end })`) — a number read off a
period row, never off the document. So the engine dutifully discarded its own
correct detection.

The production audit (`scripts/audit_period_assignment.py`, read-only, run
2026-08-30 against the live DB) found **every mismatched row carrying
`hint == stored`**. That equality is the proof: no human ever confirmed
anything.

* `Carniprod Trial Balance 2025.xlsx` — stored `2017-12`, filename says
  `2025-12`, `hint=2017-12-31`.
* Month `2025-12` holding two source files from two different companies.
* `agras_tb_2025.xlsx` ×2 stored `2050-12` — legacy rows minted before the
  `_sane_period_end` clamp. Surfaced, never rewritten.
* 5 files with **no filename date signal at all** — reported separately, never
  counted as a disagreement (ABSENT ≠ ZERO applies to the audit too).

`period_end` is the period's **identity**: it keys `financial_periods`, the
snapshot, the header label, YoY alignment and benchmark fiscal matching. A
wrong `period_end` is not a label bug.

---

## The gates

Every gate ships with a **plant** — a test that deliberately breaks the thing
and asserts the gate goes red. The plants live *inside* the suite, so the proof
runs forever instead of being a one-off experiment someone has to trust.

| # | Law | Where | Plant | State |
|---|---|---|---|---|
| **W1** | The period is NEVER inherited from UI state | `test_period_integrity_gates.py` (engine + FE source law), `periodGates.test.ts` (the wire) | `test_w1_scanner_catches_the_exact_production_plant`; live plants run below | GREEN — was RED on the real defect until the UI lane landed |
| **W2** | Ranked, hint-free detection; ABSENT forces an explicit choice | `test_period_integrity_gates.py` | `test_w2_plant_absent_is_not_reported_as_a_detection` | GREEN |
| **W3** | Mismatch + entity surfacing fire on the exact live cases | `test_period_integrity_gates.py` | `test_w3_plant_agreeing_hint_is_not_a_mismatch` | GREEN |
| **W4** | A move recomputes BOTH periods; no orphaned snapshot served | `test_period_integrity_gates.py` (contract) + `test_period_move.py` (depth, move lane) | `test_w4_plant_self_identification_is_not_vacuous`; live defaulted-target plant below | GREEN (contract) — was RED until the move lane landed |
| **W5** | The audit reports and changes nothing | `test_period_integrity_gates.py` | `test_w5_plant_mutation_trap_actually_traps` + live source plant below | GREEN |
| **W6** | Existing correct periods untouched | `test_period_integrity_gates.py` + the existing `corpus-replay` battery gate | `test_w6_plant_parity_table_is_not_vacuous` | GREEN |

---

### W1 — the period is never inherited from UI state

Three enforcement points, because the value can enter from three directions.

**1. The frontend source law** (`test_w1_no_upload_call_site_passes_a_period_row_date_as_the_hint`).
No `uploadDocument(...)` call site may pass a **period-ROW** date into
`periodEndHint`. The scanner:

* reads only text inside an `uploadDocument( … )` argument list, so type
  declarations (`periodEndHint?: string | null`) are naturally out of scope;
* **strips comments first** — the sibling lanes document this defect by
  *quoting* it, and a scanner that read comments would report the documentation
  of the bug as the bug;
* rejects `.period_end` reached through any accessor (`p.period_end`,
  `attachPeriod!.period_end`), and follows up to **3 local `const`/`let` hops**
  so renaming the value to `periodEnd` launders nothing;
* **allows** a value arriving as a function *parameter* — it came from the
  caller, and in the confirmed flow that caller is the period-confirm dialog.

A second door is closed alongside it: the `period_end_hint` column may only be
written by `lib/supabase.ts`'s `uploadDocument`
(`test_w1_only_the_upload_helper_writes_the_period_end_hint_column`), so a
direct `.insert({ period_end_hint })` can't route around the scanner.

**2. The engine's structure.** `detect_period` takes exactly `extracted` and
`filename`, keyword-only, no `**kwargs`; `resolve_period_end_for_persist(doc,
parsed)` reads only the document and its parse, and its source contains no
`active_period` / `open_period` / `current_period` / `_supabase`.

**3. The wire** (`periodGates.test.ts`). The row that actually reaches
`documents.insert()`: no confirmation ⇒ **no `period_end_hint` key at all**
(ABSENT ≠ ZERO); explicit `null` ⇒ likewise; a confirmed date still travels
(the fix is semantic, not a removal); and a key-set assertion catches any
future period-derived column sneaking onto the insert. The unmigrated-column
degrade is pinned too — if a failed hint insert cost the user their upload, the
pressure would be to keep filling the channel with *something that always
works*.

**Plant, run live 2026-08-30** — `periodGates.test.ts`'s "writes NOTHING"
case was temporarily changed to pass `periodEndHint: "2017-12-31"`:

```
FAIL  W1 — the confirmation channel at the wire >
      writes NOTHING when no human confirmed a month (ABSENT != ZERO)
      Tests  1 failed | 5 passed (6)
```
Reverted; 6/6 pass. The shipped scanner plant
(`test_w1_scanner_catches_the_exact_production_plant`) keeps this proof
executable: it feeds the scanner the literal pre-fix source of both
`PeriodsSection.tsx` call sites and asserts they are rejected, feeds it the two
lawful shapes and asserts they are accepted, and feeds it the plant *inside a
comment* and asserts it is ignored.

**This gate was RED on the real defect, twice, before it went green.** The UI
lane (Parts C–E) was mid-flight while this lane ran, so the scanner caught the
production code in both of its states and named the exact call sites:

```
# first run — both original call sites
frontend/components/cfo/workspace/PeriodsSection.tsx
    periodEndHint: p.period_end   (resolves through: p.period_end)
frontend/components/cfo/workspace/PeriodsSection.tsx
    periodEndHint: periodEnd
      (resolves through: attachMode ? attachPeriod!.period_end ?? lastDayIso(month) : …)
```

That is the live discrimination proof — a synthetic plant could not have shown
more. W1 went green when the UI lane routed both paths through the confirm
step: dropping a file on a row now opens the confirm step with the row as
**context** only, and the single surviving call site sends
`periodEndHint: result.periodEnd` — the month the human confirmed against the
document's own detection.

Two false positives were found and fixed while the gate ran against real code,
both worth keeping in mind because a noisy gate gets disabled:

* the sibling lanes **document** this defect by quoting it in comments — the
  scanner now strips comments first;
* `periodFiling.ts` declares `period_end_hint: string | null` in an interface —
  a shape declaration is not a write, and a gate that confused the two would
  push callers into being vaguer about the shape they handle.

---

### W2 — ranked, hint-free detection; absence forces a choice

* **filename-only** resolves: `Carniprod Trial Balance 2025.xlsx` →
  `2025-12-31`, `signal_used="filename"`, confidence `0.60`.
* **content-only** resolves: the real Romanian preamble
  (`BALANTA DE VERIFICARE la data de 31.12.2025`, committed at
  `tests/engine/fixtures/period_detect/carniprod_tb_header.txt`) → `2025-12-31`,
  `signal_used="closing_balance"`, with the literal snippet as evidence.
* **ranking** when all three disagree: `in_document` (2024-06-30) beats
  `closing_balance` (2025-12-31) beats `filename` (2017-12-31), and all three
  stay visible in `candidates` so Parts D/E can render the *disagreement*
  rather than only the winner.
* **undetectable** ⇒ `proposed_period_end=None`, `signal_used="none"`,
  confidence `0.0`, no evidence, no candidates. At the persist seam the same
  document is filed under today but labelled **`fallback_today`** with
  confidence 0 — `fallback_today` is deliberately *not* in `SIGNALS`, so it can
  never be mistaken for a detection, and `mismatch` is `False` because a
  document with no evidence of its own cannot disagree with anything.
* **today is never proposed by any tier** — the engine helper returns today
  when it finds nothing, so today is indistinguishable from absence.

**Plant, run live:** ranking inverted (filename wins) → ranking gate RED;
`none` remapped to today → both absence gates RED.

---

### W3 — mismatch and entity surfacing, on the exact live cases

Pinned to `tests/engine/fixtures/period_detect/production_cases.json` (the real
audit rows) plus production-shaped rows fed to the audit script itself.

* **Carniprod-in-2017.** `hint=2017-12-31`, filename says 2025. The hint still
  wins — rank 1 is correct, the channel is not the bug — but the record written
  into the envelope carries `mismatch: true`, `hint: 2017-12-31`,
  `detected.proposed_period_end: 2025-12-31`, `detected.signal_used: filename`.
  Both sides are legible **without recomputation**, which is what the mismatch
  chip reads.
* **The agreeing hint is not a mismatch** (the plant). Same document, hint moved
  onto the detected month ⇒ `mismatch: false`. A gate that flagged this too
  would be flagging everything.
* **Two companies in 2025-12.** The engine does not *block* a second entity in a
  month — standing law is that wrong rows are **surfaced** for a human, never
  silently rewritten. The surfacing guard is the audit, driven here over
  production-shaped rows: it names the month and both files, and only that month.
* **The legacy 2050 rows** are refused, not propagated: the service proposes
  nothing for them, and the out-of-range hint is dropped by the engine's own
  `_sane_period_end` rather than minting a corrupt period.
* **ABSENT ≠ ZERO in the audit itself**: `balanta verificare.xlsx` appears under
  *NO FILENAME DATE SIGNAL*, never in the disagreement list.

---

### W4 — a move recomputes both periods; no orphaned snapshot served

Split by what can be proven where.

* **Landed and green here:** the snapshot **self-identifies the period it was
  filed under** — every persisted envelope's
  `period_detection.resolved_period_end` equals the `period_end` the period row
  was written with (`test_w4_snapshot_self_identifies_the_period_it_was_filed_under`,
  over every pinned production case). That equality is precisely what makes an
  orphan *detectable*: a snapshot naming a month its period no longer has is an
  artifact of a move that did not recompute. The stamp's two ends —
  `stage_persist` writing it, `GET /api/org/periods-with-documents` surfacing it
  verbatim — are pinned as wiring.
* **Contract gates:** the move seam exists, exposes an **orphan predicate** (the
  invariant has to be a callable, or it is a wish), and takes the target month
  as an **explicit argument with no default** — W1's law applied to the
  correction path, so a move can't quietly file a document under today or under
  whatever period is open.
* **Depth is the move lane's**, in `tests/engine/test_period_move.py`
  (plan/execute, both periods recomputed, the emptied period deleted, nothing
  orphaned). This suite deliberately does **not** duplicate it; it only refuses
  to let that proof disappear silently
  (`test_w4_move_behaviour_is_proven_by_a_dedicated_suite`).

These four gates were written **RED**, failing with the spec above as their
message, and went green when the move lane landed `src/engine/api/_period_move.py`
during this lane's run (`plan_move`, `move_document_to_period`,
`find_orphaned_snapshots`). The failure text is kept as the message so the gate
still reads as a spec if the seam is ever removed.

Discovery matches **functions only**, deliberately: a dataclass named `MovePlan`
is a shape, not a seam, and letting one satisfy discovery would make these gates
pass on a module that performs no move.

**Plant, run live 2026-08-30** — `move_document_to_period` given a defaulted
target month:

```
CAUGHT  W4 explicit target month :: engine.api._period_move.move_document_to_period
        takes target_period_end='2026-08-30' — a defaulted target month is a door
        for the clock or the open period to decide where a document is filed.
```

---

### W5 — the audit reports and changes nothing

`scripts/audit_period_assignment.py` was already written and run; this lane
**reads** it and never rewrites it.

* **Static:** for every `with _supabase.admin() as <name>:` binding, no
  `<name>.insert|update|upsert|delete|delete_object|rpc(` appears — and the
  scan asserts a binding was actually found, so it can't pass vacuously. The
  scan is scoped to the client bindings on purpose: an unscoped `\.insert\(`
  regex flagged `sys.path.insert(...)` on the first run.
* **Runtime:** the script is loaded and executed against a client that **raises
  on every mutating method**. It runs to completion, reads exactly
  `documents` and `financial_periods`, and prints
  *"Read-only: nothing was modified."*
* **No second detector:** the audit must import the engine's own
  `_detect_period_end_from_filename`; a private reimplementation would drift and
  start reporting phantom disagreements.

**Plant, run live 2026-08-30** — a write injected into the audit's own flow
(in memory, no file touched):

```
static scan caught:  ['c.update(']
runtime trap caught: W5 VIOLATED — the audit called 'update'. It reports;
                     it never rewrites.
```

---

### W6 — existing correct periods untouched

* **Helper parity:** every filename the engine's own
  `_detect_period_end_from_filename` already resolved resolves *identically*
  through the new service. The detection service may only **add** answers where
  the helper had none — never change one it had. The parity table is asserted
  non-empty, so a table that resolved nothing could not pass.
* **The agreeing hint changes nothing:** the healthy case resolves to the same
  month, `mismatch: false`, `signal_used: user_confirmed`, confidence 1.0.
* **Month-tag drift:** the detection service's lexical normalizer rewrites text
  into the helper's own month vocabulary. If the helper's table ever changes,
  the rewrite would emit text the helper cannot read and filenames would
  silently regress to today — pinned.
* **Byte-identical goldens** are the existing **`corpus-replay`** battery gate
  (18/18), deliberately *not* re-run here: duplicating it doubles the battery's
  slowest step and gives the same truth two places to be asserted from.
  Verified this lane: `CORPUS REPLAY: PASS — 18 case(s)`.

**Plant, run live:** the service made to drift one month off the helper →
parity gate RED with the offending filename named.

---

## Deliberate non-goals

* **No fake stores.** W3/W5 drive the *real* audit script; the only double is a
  Supabase client that can read and raises on every write — a trap, not a
  mirror. (`data/fake-store` lesson: a mirror store hid two total outages
  behind 244 green tests.)
* **No silent green.** Where a law is not yet satisfiable, the gate FAILS with
  the spec as its message. `xfail` would have made the battery green while the
  product was broken, which is the exact failure mode this project keeps
  re-learning.
* **No rewriting of data or of other lanes' files.** The audit script,
  `PeriodsSection.tsx`, `_period_detect.py`, `_period_move.py` and
  `test_period_move.py` are read, never edited.

## Cross-lane notes

1. **Nothing outstanding for the UI lane.** W1's two violations were fixed by
   that lane during this run; the gate now guards their work rather than
   accusing it.
2. **The audit under-reports relative to the new service.** It calls the raw
   engine helper, which cannot read `agras_tb_2025.xlsx` (`_` suppresses the
   helper's `\b` anchor), so those rows land under *NO FILENAME DATE SIGNAL*
   instead of being reported as the 2050-vs-2025 disagreements they are. The
   fix is one import — `_period_detect.detect_period` instead of
   `_detect_period_end_from_filename` — but `scripts/audit_period_assignment.py`
   is out of this lane's ownership, so it is reported, not changed. The gate
   pins today's behaviour honestly (`test_w3_audit_never_counts_a_missing_signal_as_a_disagreement`)
   and will need one line updated when the audit is upgraded.
3. **`frontend/components/cfo/Sidebar.tsx` trips `corpus-policy`** — it
   imports a lucide icon whose three-letter name collides with a client
   site-location short name, so the gate is red tree-wide for everyone.
   Pre-existing; needs an allowlist entry from that file's owner. (Also
   reported by the detection lane.) Note the literal token is deliberately
   not written out here — spelling it in this file would trip the same gate,
   which is exactly what happened on the first draft.

---

## Verification — final state (2026-08-30, this lane's close)

| Check | Result |
|---|---|
| `pytest tests/engine/test_period_integrity_gates.py` | **37 passed** |
| `vitest run frontend/lib/__tests__/periodGates.test.ts` | **6 passed** |
| `pytest tests/engine` (full) | 2690 passed, 15 skipped, 1 xfailed, **8 failed — none mine** |
| `scripts/corpus_replay.py` | **PASS — 18/18** (W6 byte-identical) |
| `npx tsc --noEmit` | clean |
| `node scripts/check_design_lint.mjs` | PASS (0 hex, 0 shadow, 0 serif) |
| `scripts/check_corpus_policy.py` | FAIL ×1 — `Sidebar.tsx`, not this lane (see note 3) |
| `scripts/run_battery.py --list` | `period-integrity` registered after `corpus-replay` |

The 8 engine failures, each checked individually against this lane's diff:

* `public/test_adapter.py` ×2 — pre-existing (the SHARADAR market-cap scaling
  defect the battery already deselects).
* `test_corpus_policy.py` ×2 — `Sidebar.tsx`, note 3.
* `test_import_boundary.py` — `components/instrument/shell/TrustChip.tsx:155-156`
  (a banned file; another lane).
* `test_public_market_edgar.py` ×2 — the `src/engine/public_market/*` lane.
* `test_engine_book.py` — book drift from the new engine modules
  (`_period_detect.py`, `_period_move.py`, the public-market modules). **This
  lane added no `src/engine` file**, so the drift is not its own; whoever lands
  last regenerates the book once.

Frontend: `vitest run` (full) fails in `accountMenu`, `currencyToggle`,
`chatScope`, `commandCenterMenu`, `noteCurrencyUnity` — all pre-existing or
other lanes' surfaces, all failing standalone with this lane's files removed
from the run, and the failing set varies between runs.

## Files this lane owns

| File | |
|---|---|
| `tests/engine/test_period_integrity_gates.py` | new — W1..W6, 37 tests, plants included |
| `frontend/lib/__tests__/periodGates.test.ts` | new — W1 at the wire, 6 tests |
| `design_review/period/GATES.md` | new — this document |
| `scripts/run_battery.py` | one commented gate line: `period-integrity` |

Nothing else was touched. No deploy, no git mutation.
