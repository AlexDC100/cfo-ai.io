# Testing conventions

Hand-maintained. These are the rules that earned their place by
catching something real; each one names the incident that produced it.

---

## TC-1 — Fixtures come from real engine output, not hand-built objects

**Rule.** A test fixture representing engine output MUST be captured from
an actual engine run. Constructing the object by hand — writing a
`Finding(...)`, a `canonical_bs` dict, or a `facts_cited` map literal in
the test file — is not permitted for anything that the engine itself
produces.

**Why.** A hand-built fixture encodes the author's *belief* about the
shape of engine output. The test then verifies the code against that
belief rather than against reality, and the two drift silently: the
fixture keeps passing precisely because it was built to.

**The incident.** During the findings rebuild (2026-08), three defects
surfaced the moment a single fixture switched from hand-built to real
engine output. None of them were visible before the switch, and all three
were live in production behaviour. A hand-built fixture had never carried
the fields that made them observable.

**How to comply.**

- Run the real engine over a real snapshot and capture what it returns.
- Commit the captured bytes. Real source bytes beat a synthetic
  reconstruction — the `data.gov.ro` spec labels lesson (`ACTIVE
  CIRCULANTE - TOTAL, din care:` without diacritics) is the same rule in
  a different subsystem: every hand-written fixture used the idealized
  label, so the spine refused every real file.
- If capturing is genuinely impossible, say so in a comment at the
  fixture, and name what the hand-built version cannot prove.

**Related.** Do not build a mirror/fake store to test a subsystem —
`FakeStore` doubles hid two total outages behind 244 green tests and a
19-gate battery. `scripts/check_public_e2e.py` exists to make that class
impossible; it fakes nothing.

---

## TC-2 — A gate must be proven to fail

**Rule.** Every gate ships with a plant that trips it, reverted, and
documented. A gate that has never been observed RED is an untested
assertion about an assertion.

**Why.** Both failure directions are real and both have happened here.

- **False red:** the header census already contained
  `[role="radiogroup"]` in its selector list; a later fix appended it a
  second time, double-counting the dial and reporting six controls in a
  five-control header. A gate reporting a violation that does not exist
  teaches the next person to silence it.
- **False green:** an assertion whose selector points at a removed
  element passes for the wrong reason. `scripts/check_stale_gates.mjs`
  found 33 of these across the Playwright suite.

**How to comply.** Plant → observe RED → revert → observe GREEN, and
record the plant diff in the feature's `GATES.md`.

---

## TC-3 — A census that finds nothing is a broken gate, not a passing one

**Rule.** Any gate that works by discovering call sites carries a
**canary**: a name it must find, or it fails loudly as
`DISCOVERY BROKEN` rather than reporting a clean census.

**The incident.** The first draft of `scripts/check_metric_declared.py`
scanned keyword arguments only. The findings package names its metrics
positionally (`bag.money("trade_rec", …)`), so the census reported "0
metrics" for a package containing dozens — and printed a pass. A second
draft of `scripts/check_stale_gates.mjs` matched `data-testid=`
attributes only and reported twenty live sidebar ids as stale, because
they are defined in a nav-item config array as `testId: "…"`. Both
censuses were noise wearing a gate's clothing.

**How to comply.** Assert a known-present name before trusting the count,
and reset any `/g` regex's `lastIndex` per file.

---

## TC-4 — Test isolation from real data stores

**Rule.** A test must never write into a real data store checked into or
mounted by the repo.

**The incident.** An EDGAR adapter test wrote into the repo's real
`data/public_market.db`. The store's same-accession guard correctly
refused, which is the only reason it was noticed. Per-test isolation was
added.

---

## TC-5 — `follow_redirects=False` when the URL itself is under test

**Rule.** `TestClient` defaults to `follow_redirects=True`, which reads
the redirect *target's* status.

**The incident.** This silently disabled the PS6 gate's entire "a sitemap
must not list a 301" check — the gate passed by inspecting the wrong
response.

---

## TC-6 — A gate asserts a recorded expectation per component

**Rule.** A gate must assert that **each component of its work produced
the quantity it is supposed to produce** — per surface, per half, per
lane, per directory. It is not enough to assert a canary, a global
total, or the absence of violations.

**Why.** Three adversarial refuters were pointed at a battery whose 30
gates had just been certified as carrying a canary, a work-count floor
and a proven RED. They broke four of them, and the two mechanisms that
failed are the two everyone reaches for first:

> **A canary names a file. A floor names a number. Both can survive the
> failure they exist to catch** — the canary if the plant happens to keep
> that one file, the floor if it is a sum and only one addend collapses.

**The incidents.**

- `metric-declared` audited seven surfaces. A refuter deleted five of
  them; the census still reported **41 names**, because `total_names` is
  a set UNION and the dropped surfaces contributed nothing unique. *No
  global floor value could have caught it.* Both canaries lived in the
  two surviving surfaces.
- `import-boundary` — the gate guarding the facts-gateway single-read
  path, and the one CI invokes directly — printed
  `boundary holds (engine=OK, frontend=OK)` with a real violation
  planted in an unwalked file. The frontend half had collapsed 517 → 1
  while the **total** stayed far above the global floor of 200, because
  the engine half alone cleared it. Both named canaries survived.

**How to comply.**

- Declare a floor **per component**, not one for the sum:
  `SURFACE_FLOORS`, `HALF_FLOORS`. Assert them *after* the discovery
  loop, against the totals (see TC-3 — a check inside the loop cannot
  fire for a component the loop never visited).
- Put the assertion **in the gate script**, not only in the runner's
  work-count layer, whenever any CI job invokes the script directly.
  Anything not asserted inside is not asserted at all there.
- Prefer "did each part produce its expected quantity" over "did we find
  violations". The two gates that survived every attack —
  `narrative-units` and `stale-gates` — both compare against a recorded
  expectation (a producer count; a baseline). That is the property.

---

## TC-7 — Confirm which component actually renders before claiming a fix

**Rule.** A fix to a rendered surface must name the component that
**actually renders in the state being fixed**, and its gate must assert
that binding.

**The incident.** The Capsule redesign removed the right-aligned category
label from `CapsuleJumpList`. The complaint stayed live in the shipped
screenshots, because `CapsuleJumpList` renders **zero rows** in that
state — `CommandPalette.renderRow` is what renders, and it kept
`{item.hint}`. The fix was correct code applied to the wrong surface.

Its gate could not see the miss either: `G4`'s predicate measured the
**element-box** gutter between the label and the row, which is pinned at
the `gap-3` value (12px) by `flex-1` regardless of text length. Measured
over the gate's own queries: element-box gutter fired 0/17, reader-
visible glyph gutter fired 17/17.

**How to comply.** Before claiming a row-level fix, assert which
component produced the rendered node — by test id, by DOM ownership, or
by a render census over the actual state. And measure what the reader
sees (glyph extents), not what the layout engine reports (box extents),
when the complaint is visual.

**Related.** This is the same shape as a gate that measures the wrong
thing (TC-2's false green): the code changed, the gate agreed, and the
defect was untouched.

---

## TC-8 — Verify that what is staged IS the change

**Rule.** Before committing, confirm the staged set is the change —
neither more nor less. Not "add everything", not "add only what I
typed".

**Two incidents, one session, opposite directions.**

- **Too broad.** `git add -A` ran while a gates lane had its plant live
  in the tree. Commit `36d34ef` shipped
  `if (false && answerLocally(...))` to `main` — every Tier-0 question to
  the paid model seam — inside the commit certifying the gate that
  catches exactly that. The lane reverted the *working tree* afterwards,
  so by the time anyone looked the tree was clean and only the commit
  carried it.
- **Too narrow.** Explicit paths staged `capsule-craft.spec.ts`,
  `check_capsule_craft.mjs`, `check_vitest.mjs` and a baseline, while
  `CapsulePaletteRow.tsx`, `capsuleGeometry.ts` and
  `CapsuleTooltipGuard.tsx` sat untracked. Commit `80890a8` shipped **the
  gates that certify a design without the design**. A `git stash` at that
  point would have left gates asserting a surface not in the repository.

Gates certifying an unstaged subject is a false green with a new delivery
mechanism — the assertion is in the repo, the thing asserted is not.

**Mechanical, not remembered.** `.githooks/pre-commit` runs two checks on
the STAGED BLOBS (not the working tree — that is what lied in the first
incident):

- `scripts/check_no_plants.mjs --staged` **blocks** a staged plant.
- `scripts/check_staged_is_change.mjs` **warns** when gate/spec files are
  staged while subject files are untracked or unstaged. It warns rather
  than blocks because untracked scratch files are normal, and a hook that
  cries wolf gets bypassed — which costs more than it saves.

**A note on the warning's own first draft**, because it is instructive:
it filtered orphans to those sharing a top-level area with the staged
gates, and therefore reported **zero subjects on the exact incident it
was written for** — gates live in `e2e/` and `scripts/` while subjects
live in `frontend/`. Gates and their subjects almost never share a
directory; that is precisely what makes this hazard invisible by eye. The
filter reproduced the blindness inside the warning, and printed a warning
naming zero files besides. Removed.

---

## TC-9 — An instrument that scores well by examining nothing

**Rule.** For every gate, ask: *would a "clean" result be
distinguishable from "there was no subject"?* If not, the gate is not
measuring — it is reporting the absence of work as the absence of
problems.

**Three instruments in one session had this exact shape.**

| Instrument | How it scored well | What it hid |
|---|---|---|
| `tsc` | solution-style root config, `"files": []`, so `npx tsc --noEmit` checked **zero files** and exited 0 in 0.2s | 102 real type errors across 32 files |
| G1 ink density | `Range` reported **natural** layout boxes, so truncated and scrolled-out text counted in full — **overflow bought ink** | a card reading 15.77% where the reader saw 3.77% |
| axe | nothing asserted the route rendered; with JS blocked, `/dashboard` painted **2 elements**, axe inspected **9 nodes**, found 0 serious/critical, and the assertion **passed** | accessibility never verified on any route; 3.2:1 contrast on 58 nodes |

The common shape: **the gate's "clean" output is byte-identical to its
"no subject" output.** A green result therefore carries no information,
and nobody reads a green gate's runtime.

**The antibody is a recorded expectation of WORK, not of cleanliness.**
Every gate must emit what it examined and fail when that count is zero
or below a floor it declares — asserted *after* any discovery loop
(TC-3), per component rather than per sum (TC-6).

**`evidence_complete` is the surface-level version of this rule**, and
it is subject to the rule itself. `read_battery_record` reports
`all_green` (are there failures?) separately from `evidence_complete`
(did every gate actually examine something?). Given this pattern,
`evidence_complete` is the more important of the two.

**Proven able to fail, both halves, 2026-08-31:**

- Reverting the `tsc` gate to the historical `npx tsc --noEmit`
  reproduced the incident exactly — exit 0 in 0.2s — and the battery
  caught it **twice independently**: `WORK-COUNT MISSING — a gate that
  cannot say what it examined is the tsc failure wearing a green hat`,
  and `DISCOVERY BROKEN — canary absent`. Both ops signals went red:
  `all_green False`, `evidence_complete False`.
- Pointing the axe shell canary at a non-existent element produced:
  *"the app-shell canary did not render, so 'no serious/critical
  violations' would mean 'nothing was examined', not 'the surface is
  clean'."*

**One plant that did NOT prove what it looked like it proved**, recorded
because the distinction is the whole convention: blocking the app's JS
to force a blank page *did* turn the axe spec red — but via the
violations assertion, because the logged-out page rendered real
violations rather than nothing. That reds the spec, not the guard. The
targeted canary plant above is what proves the guard. A plant that
produces a red for the wrong reason is not evidence.

## TC-10 — No cutoff or threshold is ever written as prose

**Rule.** A threshold, band ladder, zone cutoff, benchmark or materiality
floor renders from the SAME data the verdict was computed with. Prose that
restates a number is a second copy of the number, and a copy drifts.

**The shape, found 2026-09-04.** The frontend deleted a hardcoded replica
of the engine's credit band ladder (`compositeToGrade()`), and the ladder
survived as *sentences*: the model label and the caveat both spelled
`AAA ≥ 90 … CC < 25` as string literals. Under an engine re-band the
document then said the letter was **B**, the ladder was **B ≥ 20**, and two
lines later **B ≥ 40** — all within one section, on screen and in both
deliverables. It got *worse* when the model sentence was made mandatory
beside every letter, because the frozen copy then printed in more places
than the replica ever had. The same shape lives in every ratio row
(`bands`, then a `benchmark` string restating them, then a `commentary`
closure with a third inline copy), in the Altman methodology note seven
lines from the declaration that said it was fixed, and in the learning
popovers' definitions in both languages.

**The antibody.** One spelling function per kind of cutoff (`spellLadder`,
`spellWeights`), fed the bands the verdict actually used, on the same
result object. A gate that plants a re-band and then reads every
`GRADE ≥ N` / `> X safe` claim out of the PRODUCED bytes — DOM, HTML
document, workbook — and requires each to be in the ladder the letter was
banded with. Grep for the defect with: a numeric threshold inside a string
literal in `frontend/`, both languages' translation files included.

## TC-11 — State what a gate fails on AFTER the defect is repaired

**Rule.** For every gate, write down what it reds on once the bug it guards
is gone. If the honest answer is "the fix", the gate is protecting the bug.

**Three green gates in one session were asserting the defect as their law.**

| Gate | What it asserted | What it actually protected |
|---|---|---|
| `test_xff_preferred_over_socket_peer` | two requests differing only in the **leftmost** forwarded hop get separate buckets | the header-rotation bypass of the public rate limiter, restated as an invariant |
| `financialCompletenessLaw` (first form) | `if (c.credit !== undefined)` … | the silent switch to a parallel scoring model it was written to prevent |
| `servedFactsAbsentTotals` (first form) | `Number.isFinite(v)` over every ratio | every substituted zero — finiteness is not honesty |

A fourth, same family: `test_firm_tenancy` *pinned* a live Capsule
defect ("assert the bug is STILL present") as documentation. A pinned
defect is a live finding to triage now, not a record.

**Why it matters.** A red gate reads as "your change broke something". When
the gate encodes the bug, the next engineer reverts the fix to get back to
green — and the defect is now defended by the test suite. `PYTEST_DESELECTS`
is the same trap at battery scale: two honest tests were switched off for
months over a "known adapter defect" that turned out to be a wrong fixture,
and the next wave to touch it drew the wrong conclusion in the silence.

**The antibody.** Each plant-log section in `gates.md` names the plant
that reds it (TC-2) — add the inverse: the one-line statement of the
correct behaviour the gate would ALSO red on, if that behaviour were
wrong. Assert the CLAIM (is this figure real? is this row unchanged?),
never a shape property of it (finite, non-null, present). Prefer an xfail
with a reason to a deselect; prefer a fix to either.

## TC-12 — A lookup must report its coverage; a shortfall refuses or routes elsewhere

**An exact-match table cannot say "I did not recognise this account". It
just returns less.** That sentence is the whole convention, and it is the
general form of a defect this repo has now shipped twice.

**Measured, 2026-09-09, live on production.** `buildPlStatement.ts` chose
between two P&L builders by guessing the book's shape from the LENGTH of
its account codes, then summed operating expenses with `sumByExact`
against a fixed table of nineteen codes. A CONDENSED EXTERNAL balanță —
4-digit synthetic codes, an entirely normal Romanian disclosure level —
took the line-item branch, and of its seventy class-6 accounts exactly
three were in that table. The served statement read:

```
Spare parts (6024)              55.31
Energy (6051)            4,833,129.56
Other social contrib (6458) 870,424.00
Total operating expenses  5,703,608.87
```

for a book carrying 409,697,663.25, with revenue rendering as nothing.
The parser, the pipeline and the database were all correct: 247 rows
parsed, 220 line items stored, 70 class-6 accounts summing to the right
figure. The statement dropped 67 of them and said nothing, because a
`.get()` that misses is indistinguishable from a `.get()` that returns
zero once you add it to a running total.

**THE RULE.** Every lookup that maps source data to output must be able to
answer "how much of the input did I account for?", and a shortfall must
REFUSE or ROUTE ELSEWHERE — never silently return a subset.

In practice that means one of:

* **Route on coverage.** `plUsesLineItems` builds the per-account view
  only when the code table reaches 98% of the operating expense the
  engine assembled; below that the aggregates serve, because they are the
  engine's own totals. The condensed book scores 0.014.
* **Refuse with a named reason.** The Radar detectors already do this
  right and are the counter-example worth copying: a subject prefix that
  matches nothing returns `(), "no period in the spine carries an account
  under %s, so there is nothing to read across time"` — a reason, not a
  shorter list.
* **Report the remainder.** `assemble_statements` carries every account
  it could not map into an "Unclassified" row so the identity survives
  and the gap is visible, rather than dropping it to keep the sheet tidy.

**THE SWEEP, and what it found.** Three more sites of the same shape:

| site | state |
|---|---|
| `buildPlStatement.ts` `OPEX_CODES` | the live defect above — FIXED, coverage-routed, gated |
| `chart_of_accounts.py:892` `else: continue` | a bucket in neither field map is dropped with no counter. LATENT: measured complete across all 20 books, but nothing asserts it stays so |
| `_benchmarks.py:763` `if not b: continue` | a metric with no benchmark vanishes from the comparison; the reader is never told which metrics were omitted |
| `radar/detectors/fam_series.py:85` | the counter-example — refuses with a reason |

**The tell.** Any `for x in wanted: total += table.get(x, 0)` or
`if key not in map: continue` sitting between source data and a number a
person reads. The loop is correct; the silence is the defect.

## TC-13 — A check must name its own scope in its output

`check_deploy_drift.py` printed **"IN SYNC — the deployed containers match
the committed tree"** while eight stale scripts ran in production. It
compared `src/` and nothing else, and its verdict said so nowhere. One of
those scripts then failed the moment it was called: `reprocess_documents.py`
invoked `signed_url()` without the `org_id` that had just become required,
and the dry run skipped all sixteen periods.

The banner was not a lie about what it checked. It was a true answer to a
question narrower than the one it appeared to answer, and nothing in the
output revealed the difference.

**THE RULE.** Every gate prints WHAT IT EXAMINED, not only its verdict —
the directories, the file counts, the objects probed, the things it could
not see. The same reasoning that makes `PASS(VACUOUS)` a third state:
"it passed" and "it had nothing to look at" must never read the same, and
neither must "it passed" and "it looked at a sixth of the subject".

Two worked examples now in the tree:

* `check_deploy_drift.py` derives its scope from the Dockerfile's own
  `COPY` set — never a hand-written list, so a new `COPY` is covered the
  moment it is added — and prints every directory with its tracked count
  and its in-image count before the verdict. Widening it took the
  comparison from 443 files in one directory to 741 across six, and found
  `packs/ro/detectors.yaml` stale in the running image: Radar had been
  running a different detector pack than git, invisibly.
* `check_migrations_applied.py` prints 41 files, 84 tables, 58 columns —
  and 437 index/policy/constraint/function declarations that PostgREST
  **cannot** see, counted and named as unverifiable rather than folded
  into the pass. A gate that pretends to have checked what it cannot see
  is worse than one that says so.

  **Correction (2026-09-15).** The deploy one-liner that wrapped this probe
  was itself vacuous: `scripts/check_migrations_applied.sh` piped the
  declarations into `python3 -`, which executes stdin as the program, so
  the JSON ran as a do-nothing expression — no output, exit 0, for any
  database. The scope-printing probe never ran through it, and two
  operator reports disagreed about whether a migration was applied. A
  wrapper is part of the gate: TC-3 applies to it too — "printed nothing"
  is a failure, never a pass (`tests/engine/test_migrations_probe_invocation.py`).

## TC-14 — A specification too large to verify in one pass is built in batches against measured reality, with deviations logged as-built

The one-engine contract for Forecast and Scenarios (2026-09-14) folded 95
review amendments into a single 215 KB document. Three rounds of
check-then-repair did not converge: independent checkers reported
2 / 6 / 2 unresolved items, 15 / 9 / 12 internal contradictions and
7 / 4 / 3 batch breakages, and each round's contradictions were mostly
NEW — found in sections the previous checker had passed. The document was
not converging; it was oscillating, because no single reader could hold
it whole, so every pass verified a different subset and every repair
could introduce the next contradiction.

**THE RULE.** When a specification cannot be verified by one reader in
one pass, stop refining it as a whole. Freeze the part the first batch
needs, build that batch against the real code, and measure: the tests,
the served bytes and the blast radius are the verification the document
could not give. Every place where the build had to differ from the text
is appended to an AS-BUILT log (what the contract said, what was built,
the evidence, which later batch it affects), and the as-built log wins
over the contract for what it records. Each following batch reads the log
before it starts. Known unresolved findings are handed to the batch they
touch, not re-litigated globally.

What it rules out: a fourth convergence round on a document of that size;
a batch that silently "interprets" a contradiction without logging it;
and the belief that a longer contract is a safer one — past the size one
reader can check, more text is more unverified surface.

Worked example: batches B0–B6 of the one-engine wave run against the
frozen contract with an append-only as-built log seeded with the last
checker's findings, each routed to the batch it touches; the log is
committed beside the wave's code when the wave lands.
