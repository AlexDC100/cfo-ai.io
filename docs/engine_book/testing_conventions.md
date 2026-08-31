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
