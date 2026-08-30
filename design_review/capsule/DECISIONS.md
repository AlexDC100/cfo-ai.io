# THE CAPSULE DELIVERY PACK — AUTONOMOUS DECISIONS

> Zero-owner mode. Every call below was made without asking, and every
> one of them is reversible. They are listed with the alternative that
> was rejected, because a decision without its discarded option is not a
> decision, it is an assertion.

---

## D1 · The demo runs on a REAL trial balance, and it is the one the corpus already replays

**Chosen:** `files/prod_scandia_frozen_31.12.2025.xlsx` — a real SAGA
10-column Romanian export, 382 rows, party data anonymized upstream.

**Rejected:** `demo-meridian`, the fictional five-period manufacturer the
previous wave's evidence was captured on. Also rejected: the other four
real balances in `files/` (carniprod, retail, agras, realestate).

**Why this one.** It is **byte-identical to `corpus/saga_10_col/input.xlsx`**
(sha256 `d9a520ba…`, verified). That gives the demo something no other
choice offers: an independently-committed expected value. When the
Capsule prints `52.764.717,79 RON`, that number can be checked against
`corpus/saga_10_col/expected/gateway_facts.json`'s
`total_assets_cents: 5276471779` — produced months ago, by a different
code path, and byte-compared on every battery run. A demo whose central
claim is "this number is real" should not rest on my own arithmetic.

Secondary reason: it is the one corpus case declaring
`anonymized_upstream: true`, i.e. reviewed as carrying no real party
data. `scripts/check_corpus_policy.py` passes with every artifact of this
pack in the tree (`checked 3595 file(s) … CORPUS POLICY: PASS`).

---

## D2 · A sidecar running the REAL routers, instead of replaying a JSON file

**Chosen:** `design_review/capsule/tools/demo_engine.py` — a live HTTP
server mounting `pipeline.build_router()` and
`_capsule_tools.build_router()`, the same factories `server.create_app`
includes, over an in-memory store seeded by the real pipeline.

**Rejected:** capture the `/api/period` payload once and have Playwright
`route.fulfill` it. That was built first (`make_period_fixture.py` still
writes it, as a cross-check artifact) and then demoted.

**Why.** A fulfilled JSON is a driver literal — the exact shape of
evidence this wave exists to stop producing. With the sidecar, the
browser makes a real HTTP request, FastAPI routes it, the production
handler assembles the response, and the client parses it. That is also
the only reason the tool-layer defect (F1) was found at all: replaying a
recorded payload would have sailed straight past a 422 that only exists
in the live request path.

**The cost, stated:** Supabase is substituted by an in-memory store bound
at the `_supabase` seam, and the JWT gate is bypassed. Neither touches a
number.

---

## D3 · Two sidecars — one faithful, one repaired — rather than one convenient middle

Port 8010 reproduces the shipped `422`. Port 8011 runs `--repair-tool-body`.

**Rejected:** patching the engine so the Tier-1 number could simply be
measured. `_capsule_tools.py` is another lane's file, and more
importantly a patched engine would have quietly deleted the finding.

**Rejected also:** publishing the Tier-1 fact-card latency from the
repaired sidecar as if it were the shipped number.

The two ports let both true things be said in the same report: **as
shipped, the fact card never paints, and here is why**; and **once the
defect is closed, here is what it costs**. The repaired figure is
labelled in its own file (`latency-repaired.json`) and never merged into
the shipped one.

---

## D4 · One page load per question in the coverage run

**Chosen:** a fresh browser context for each of the 72 questions.
~12 minutes of wall clock.

**Rejected:** one page, 72 questions, with sleeps.

**Why.** `capsuleAskGuard` is module state: a 1.5 s minimum gap and a
rolling cap of 6 asks per minute. Question 7 onwards would have been
REFUSED — spending nothing, and scoring as zero-spend coverage. The
percentage would have climbed toward 100% as a direct function of how
fast the driver typed. Structural isolation beats a sleep here, because a
sleep tuned to today's constants silently stops working when someone
changes them. This is canary **C-GUARD**.

---

## D5 · Model seams are ABORTED in the coverage run, and completed in the latency run

The measurement in coverage is *was the request made*, so recording it
and aborting is complete. Letting 72 model calls finish would spend real
credits to learn nothing.

Latency is the opposite: `first_model_text_painted` is meaningless unless
the call completes, so those five samples are **real, billed model
calls** against the deployed `chat-llm` Edge Function. Five per run,
twice — ten in total for this pack. Said plainly rather than buried.

---

## D6 · The Tier-0 latency probe types a WORD, not a character — after the first attempt measured nothing

The first instrument stopped the clock when an element matching `\d`
existed. Three runs reported **0.5 ms, 0.5 ms, 0.5 ms**.

That was not a fast path. Typing `"what are our total assets"` minus its
last character leaves `"…total asset"`, which **already resolves** — the
preview was on screen with a figure in it before the measured keystroke,
so the observer's very first check succeeded and what got timed was one
`requestAnimationFrame` over an unchanged DOM.

Three identical readings of a physical process should have been the tell,
and it is exactly the shape of the incident that frames this wave: a
number that looks like a result, is reproducible, and measures nothing.

**The fix is structural, not a bigger prefix.** `__latStart` now records
the text on screen when the clock starts; a sample only completes on a
CHANGE from that baseline, and a start whose baseline *already matched*
is recorded as `baselineMatched` and **thrown away by the caller** rather
than counted. With the change requirement in place the same phase
measures **34.7 ms p50** — two orders of magnitude off the vacuous
reading.

---

## D6b · Three instruments in this pack measured nothing before they measured something

D6 above is the first. All three were caught the same way — by refusing
to accept a clean census — and all three are recorded because the pattern
matters more than any of them.

| # | What the instrument reported | What was actually true | The tell |
|---|---|---|---|
| 1 | Tier-0 first paint **0.5 ms**, three times | The preview already showed a figure before the measured keystroke; the clock timed one animation frame over an unchanged DOM | Three *identical* readings of a physical process |
| 2 | Two questions "resolved in the preview, then billed on Enter" — a spend-boundary defect | Both previews were **refusals**. The predicate asked "does the preview contain a digit?", and the refusal reads *"The total is on file for **Dec 2025**, but the split behind it is not…"*. `2025` is a digit | Standalone re-runs of both showed no fact card at all |
| 3 | `facts_arrived_at_the_client`: **UNMEASURED, "no tool call was planned"** | The tool call happened and completed in 5 ms. This page issues ~575 resources; `performance.getEntriesByType("resource")` holds 250, so the entry had been **evicted** before the query ran | A phase reporting "never happened" for a request visible in the driver's own network ledger |

The fixes are structural in each case, never a bigger timeout:

1. record the baseline text at `__latStart`; require a **change**; discard
   any sample whose baseline already matched.
2. read `data-refused`, the attribute `CapsuleTier0Preview` sets itself,
   instead of parsing its prose. Ask the surface what it decided.
3. a `PerformanceObserver` with `buffered: true`, so an entry is captured
   when it lands and eviction cannot hide it.

**#2 is the one worth dwelling on.** It would have shipped a *product*
defect that did not exist — "the spend boundary leaks on two questions" —
into a report about spend boundaries. The only reason it did not is that
every anomaly in the census was re-run individually before being written
down. A gate that produces a plausible finding is as dangerous as one
that produces a false pass.

---

## D7 · The failing canaries exit non-zero, and no threshold was moved to prevent it

`node scripts/capsule_demo.mjs demo` exits **1** every run, on the
provenance-jump defect. It will keep doing that until the tab mapping is
fixed. Exit code 2 is reserved for "the capture itself is not evidence"
(the figure did not carry the fixture's digits; no question reached a
seam) — a broken driver and a broken surface must not be reported by the
same signal.

No number in this pack was compared against a bar that was adjusted to
meet it.

---

## D9 · The coverage run was repeated once, and the reason is recorded

The first full 72-question run produced three anomalies. Every one was
re-run individually before being written down, and two of the three were
**my instrument, not the product** (D6b). The corrected driver then ran
all 72 again.

That is a re-run, and re-runs are how numbers get laundered, so the rule
it followed is written down: **the driver changed, the thresholds did
not, and the number moved DOWN.** 24 answered-free became 24, the two
"spend-boundary leaks" became zero *because they never existed*, and the
zero-spend total went from a wrong 33.3% to a right 34.7% — still far
below K3's 51.4%, which is the uncomfortable number this page exists to
publish. If the correction had moved the headline the other way it would
read as motivated; it is recorded either way.

---

## D8 · What was NOT done

* **The three defects were not fixed.** The frontend is read-only for
  this lane and `_capsule_tools.py` belongs to another. Each is reported
  with a reproduction, a root cause, and the shape of the fix.
* **No screen recording.** Playwright writes `.webm`, which does not
  render in a Markdown review. The numbered frame sequence was the
  specified alternative and carries a machine-readable receipt per frame,
  which a video does not.
* **The "before" was not re-measured end-to-end at the parent commit.**
  That needs a checkout or a worktree — a git mutation this lane is not
  permitted to make. Where a before/after depends on the pre-`62fba00`
  code shape, it is labelled as inferred from the diff and from K10's
  jsdom proof, not as measured.
* **No engine or frontend source was edited.** `git status` for this lane
  is `scripts/capsule_demo.mjs` plus `design_review/capsule/**`.
