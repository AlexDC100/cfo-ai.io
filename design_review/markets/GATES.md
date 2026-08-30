# GLOBAL PUBLIC MARKETS — gates PM1–PM7

The market document class is enforced by machines, not by memory. This
file is the index of the seven gates: what each one asserts, how to run
it, **the plant that proves it can fail**, and the honest state of the
tree against it.

State recorded **2026-08-30**, against the wave's end state (spine,
edgar, esef, entity, prices, freshness, universe/seeds, search, and the
frontend market surface all landed).

---

## How to run

| Command | What runs |
|---|---|
| `.venv/bin/python scripts/check_public_market_gates.py` | all seven gates, incl. PM7's corpus replay |
| `.venv/bin/python scripts/check_public_market_gates.py --no-replay -v` | all seven, fast, with every note printed |
| `.venv/bin/python scripts/check_public_market_gates.py --json` | the machine record |
| `.venv/bin/python -m pytest tests/engine/test_public_market_gates.py -q -rs` | the plants (71 tests; `-rs` prints the loud skip) |
| `npx vitest run frontend/lib/__tests__/marketGates.test.ts` | the frontend plants (29 tests) |
| `.venv/bin/python scripts/run_battery.py` | the whole engine battery — `public-market-gates` is a gate in it |

Exit codes are battery-shaped: `0` = nothing FAILED, `1` = at least one
FAIL. **A SKIP never passes as green** — it prints as `SKIP` and is named
in the summary line.

## Where the code lives

| | |
|---|---|
| the checks | `scripts/check_public_market_gates.py` |
| the plants (engine) | `tests/engine/test_public_market_gates.py` |
| the plants (frontend) | `frontend/lib/__tests__/marketGates.test.ts` |
| battery wiring | one line in `scripts/run_battery.py` (`public-market-gates`, `--no-replay`) |

There is **one implementation** of every check. The gate script holds it;
the pytest lane imports the script and drives the same functions. That
is deliberate: on 2026-08-29 the public_ro storefront shipped 244 green
tests and a 19-gate battery while every hub page returned HTTP 500,
because the tests drove a hand-built `FakeStore` that "mirrored" the real
one and the mirror had drifted. **No mirror stores, no re-derived market
tables, no second copy of a rule.** Envelopes here are built from the
committed real SEC bytes through the real adapter; the store is the real
sqlite store on a temp path; the router is the real FastAPI router.

---

## The honest final table

| Gate | State | What it proves today |
|---|---|---|
| **PM1** | **PASS** ⚠ | No model SDK or AI-layer import in the facts path; the freshness package cannot reach a store write API; every served figure carries deterministic-feed provenance. **Caveat below.** |
| **PM2** | **SKIP** (loud) | Nothing server-side computes a cohort statistic, so cross-standard blending is not yet *possible* on the engine. The live grouping law shipped on the **frontend** and is gated there. |
| **PM3** | **PASS** | n = 0/1/2 render exactly, on both sides. One threshold (3) across three surfaces. |
| **PM4** | **PASS** | No price reaches a reader unlabeled — refused at the quote, the envelope and the presenter. |
| **PM5** | **PASS** | Keyless: US/EDGAR fully live, every other market a typed refusal, no blank tab, **zero packets** to the provider. |
| **PM6** | **PASS** | A market added to `markets.yaml` alone reaches the API *and* a UI tab, with zero engine edits; a market-id branch in core trips the N7 guard. |
| **PM7** | **PASS** | `public_ro` untouched; corpus replay 18/18 byte-identical; the home market's company route and its universe seed both refuse; peer-add never widens a cohort. |

`PUBLIC-MARKET GATES: PASS — 6/7 green, 1 skipped (PM2)`

---

## PM1 — no AI-authored numerics in the facts path

**Asserts** three things, at three layers:

1. **Import layer.** No module in `engine/public_market/` outside
   `freshness/` may import `anthropic`, `openai`, `engine.ai`,
   `engine.ai_lane`, or `engine.public_market.freshness`. Reaching a
   model from the facts path is the failure; reaching the AI layer is
   the same failure one indirection later.
2. **Capability layer.** The freshness (AI) package may not import the
   spine's write surface (`store`, `model`, `engine.serving`,
   `engine.api`, …) and may not contain a write-surface token
   (`put_filing`, `upsert_entity`, `normalize_envelope`,
   `stamp_content_hash`, `get_store`, …). A token scan as well as an
   import scan, because `getattr(store, "put_" + kind)` has no import to
   catch.
3. **Runtime layer.** Every figure that carries a number must carry
   provenance whose `source` names a deterministic feed.
   `AI_SOURCE_DENYLIST` matches `claude` / `anthropic` / `gpt-` / `llm` /
   `mock` / `synthetic` / `estimate` / `generated` / `inferred` as
   substrings, so `claude-fable-6` and `provider:mock-eu` are caught
   without a table edit. **An absent or blank source is model-authored by
   default** — fail closed. Run against the reference envelope and, when
   one exists, every envelope in the deployed store (opened read-only via
   `sqlite3 mode=ro`, never through `PublicMarketStore`, whose
   constructor writes — a gate must not migrate the database it audits).

**Plants (all proven, all reverted):**

| Plant | Where | Result |
|---|---|---|
| `import anthropic` | `model.py`, real tree | `FAIL PM1 … model.py:489 imports anthropic` |
| `from engine.public_market.freshness import briefing` | `store.py`, temp copy | trips |
| `from engine.public_market.store import get_store` | `freshness/sentinel.py`, real tree | `FAIL PM1 … imports engine.public_market.store` + `forbidden write-surface token 'get_store'` |
| `_PLANT = 'put_filing'` (dynamic dispatch) | `freshness/peers.py`, temp copy | trips |
| a model-authored `revenue` (`source: claude-fable-5`) | a real pm1 envelope | refused by the gate |
| a figure with **no** provenance | a real pm1 envelope | refused by the gate, by `validate_envelope`, and by `store.put_filing` |

> ### ⚠ PM1 open gap — the spine accepts what the gate refuses
>
> A figure whose provenance names a model is **accepted today** by
> `model.validate_envelope` (returns clean) and persisted by
> `store.put_filing`. Reproduced: a fabricated `revenue` with
> `provenance.source = "claude-fable-5"` stores and serves.
>
> This gate refuses it. The spine does not. The fix belongs to the spine
> lane (`model.py` / `store.py` are not this lane's files): add the
> source denylist to `validate_envelope` so an AI-sourced figure is a pm1
> contract violation, not merely a gate finding.
>
> The gap is asserted **explicitly** in
> `test_pm1_plant_model_authored_revenue_is_refused`, which fails loudly
> the day the hole is closed — with instructions to delete the assertion
> and this section. A silent "we'll remember" is how a gap survives a
> wave.

---

## PM2 — no cross-standard / cross-market percentile blending

**State: SKIP on the engine, PASS on the frontend.** Stated that way on
purpose. A percentile that mixes US GAAP with IFRS is not a comparison;
it is an average of two different questions. Nothing server-side
computes one, so there is nothing here to blend — and the gate reports
`SKIP`, never `PASS`, so nobody reads an empty scan as a proven one.

**What is enforced on the engine today:**

- `scan_cohort_statistics()` — a call to `median` / `percentile` /
  `quantile` / `stdev` / `zscore` inside `engine/public_market/**` from a
  module that never mentions `market_id` / `accounting_standard` is a
  violation. This arms **before** any grouping function exists.
  *Plant:* `statistics.median` added to `esef.py` on the real tree →
  `FAIL PM2 … esef.py:538 computes median() in a module that never
  mentions market_id / accounting_standard`.
- `check_group_partition()` — the contract itself, proven against a
  planted blending grouper (one cohort, two markets, two standards) and
  against a segregating control. Also refuses an **unlabeled** member: a
  row declaring neither axis can be blended into any cohort at all.
- `discover_grouping_fn()` probes six engine seams
  (`benchmarks.group_cohort`, `percentiles.group_cohort`,
  `screener.build_groups`, …). The `skipif` releases the moment one
  appears.

**Where the live contract actually is:** `frontend/lib/benchmarkGroups.ts`
— `assertHomogeneous`, `partitionByKey`, `MIN_N_FOR_PERCENTILES`,
`BenchmarkIntegrityError`. `check_pm2` verifies that module still exports
all four, and FAILS if it stops: PM2 measuring nothing is worse than PM2
red.

**Frontend plants** (the back door, which no functional suite covers —
`benchmarkHonesty.test.ts` owns the law itself):

- a blended sample handed **straight** to `computeBenchmarkStats`,
  skipping `partitionByKey`, must throw — the statistic cannot trust
  that someone partitioned first;
- the refusal is **thrown, never returned** — a returned refusal object
  can be ignored by a caller that only reads `.median`;
- US_GAAP beside IFRS throws on the market-group axis, because the
  standard is *derived* from the group. That nesting is pinned;
- a source scan: no market-surface file may declare its own
  `median`/`percentile`/`quantile`. `quantile` in `benchmarkGroups.ts` is
  module-private precisely so there is one door.

**Quantile allowlist** (each entry with its reason, each verified to
still declare one):

| File | Reason |
|---|---|
| `frontend/lib/benchmarkGroups.ts` | **is** the gate — `computeBenchmarkStats` is the one entry point and its `quantile` is module-private |
| `frontend/components/public-companies/MarketPulseStrip.tsx` | medians a unit-free day-change (%) over rows the page has **already** market-scoped, and prints `n` beside the figure — not a cross-standard fundamentals percentile |

> **Flagged, not fixed:** `MarketPulseStrip`'s headline median has no
> minimum-n of its own; it relies on the caller's scoping and on printing
> `n`. At n=1 it would render a "market median" of one company — labeled
> honestly with `n=1`, which clears the PM3 bar, but it is the one market
> statistic in the build that is not behind `MIN_N_FOR_PERCENTILES`.

---

## PM3 — small-n honesty states render

**Asserts** that n = 0 / 1 / 2 produce an *exact, unsmoothed, visible*
state — never a suppressed tab, never a cohort statistic.

**Engine half** (`check_pm3`), driven through the real store and the real
router at n = 0, 1, 2:

- every market still appears in the list at every holding count;
- `entities_held` is **exact** — never rounded, never widened into
  "coverage";
- no market renders with an empty name or status;
- `deterministic_peers` at n=1 and n=2 returns exactly what exists, with
  a `basis` label, and never pads.

**Frontend half** — the states are covered by `benchmarkHonesty.test.ts`;
what the gate owns is the **threshold**, which must be *one number*:

```
MIN_N_FOR_PERCENTILES  (frontend/lib/benchmarkGroups.ts)   == 3
MIN_COHORT_N           (scripts/check_public_market_gates.py) == 3
HUB_MIN_COMPANIES      (src/engine/public_ro/seo.py)       == 3
```

read out of the source of all three and compared. If one drifts, one
surface starts publishing a distribution the other two refuse to.

**Plants:** a statistic at n=0/1/2 trips `check_small_n_cohort`; a market
that *vanishes* at n=0 trips `check_registry_small_n`; n=1 reported as
`entities_held: 5` trips it; a blank display name trips it; a stats
object claiming `kind: "percentiles"` at n=2 trips the frontend
predicate. Non-vacuity in the other direction is asserted too — the
threshold **releases** at n=3, so the check is not "refuse everything".

---

## PM4 — stale / delayed prices are ALWAYS labeled

**Asserts** that a price may be old but may never be **unlabeled**, at
three layers:

1. **The quote** — `check_price_labeled` requires `as_of` *and*
   `delay_note`, and requires a price past its cadence budget to carry
   `stale: true`.
2. **The envelope** — a `price` block missing `delay_note` fails pm1
   validation, and `store.put_filing` refuses to persist it.
3. **The presenter** — `present_public_market` surfaces `delay_note`
   verbatim; with **no** price it emits an explicit policy line
   (`"No licensed price feed for this market — fundamentals only"`),
   never a blank slot. A blank slot reads as a loading state.

**The briefed plant — an unlabeled 3-day-old price:**

Three days is *inside* the 5-day EOD budget, which is exactly what makes
it the dangerous case. It is not stale, so no staleness flag would fire;
the only thing between the reader and a number that looks live is the
label. Planted, it fails:

```
3-day EOD: price block has no delay_note — an unlabeled quote reads as a
live one, which is the freshness lie this gate exists to stop
```

Reverted by passing the same quote through the real `label_quote`, after
which it passes **and** is correctly *not* flagged stale (the 5-day
budget exists so a Friday close survives a long weekend).

Also planted: an undateable quote (no `as_of`) → the real labeler returns
a typed `Refusal(price_missing_as_of)`; a 6-day-old close carrying a
delay note but `stale: false` → trips (labeled, and still lying).

> No price is served today (keyless — see PM5). Every layer was exercised
> on a constructed quote **so the label rule is proven before a licence
> exists to break it**.

---

## PM5 — keyless resilience

**Asserts**, with `PROVIDER_API_KEY` unset:

- the resolver never reports live — and a blank or whitespace key **is
  not a key**;
- `prices.price_block()` returns `None` for every market: the *designed
  absence*. Never `0.0`, never a mock quote, never a null-ish
  placeholder a renderer would format as a price;
- the **MockProvider's** canned quote (`mock: true`,
  `source: provider:mock`) is kept out by the capability gate even though
  the mock is perfectly happy to answer — PM1 and PM5 meet here;
- **US/EDGAR is fully live**: committed real SEC bytes → real adapter →
  real store → real router → HTTP 200 with per-figure accessions;
- every other market degrades to a **typed** refusal (404/501 with a
  machine `code` and a non-empty `detail`) — never a 500, never an empty
  body, never "no results for AAPL", which would imply a search happened;
- **no blank tab**: every market carries a name, a status from the closed
  vocabulary, a currency, a verbatim licence line and an integer
  `entities_held`. On the frontend, a **dead engine** still yields the
  full labeled list from the bundled mirror, with `holdingsKnown: false`
  so no surface prints a count it never received;
- **and nothing was sent.** `_NoNetwork` traps `socket.connect`,
  `connect_ex`, `create_connection`, `getaddrinfo`,
  `urllib.request.urlopen` and `providers._urlopen` for the whole gate
  body, and the attempt log must be empty.

**Plants:**

- attempt `urlopen` inside the trap → `NetworkAttempted` raised, attempt
  logged, hooks restored on exit. Without this, every "no network was
  attempted" assertion would be worthless;
- set `PROVIDER_API_KEY` and call `price_block` → the trap **does** log
  an egress attempt, which is what makes "keyless sends nothing" a real
  claim rather than a tautology about dead code. The call returns a typed
  `Refusal` (the licensed adapter fails closed at its boundary) and the
  key does not appear in the refusal detail.

> The trap is hooked at `connect` / `getaddrinfo`, **not** at
> `socket.socket.__init__`. The in-process ASGI TestClient builds an
> asyncio event loop whose self-pipe is a local `socketpair`; trapping
> construction flagged that loopback pipe as an outbound call and made
> PM5 red for a reason that had nothing to do with the provider. Egress
> is what matters, so egress is what is trapped.

---

## PM6 — registry-only extension

**Asserts** that a market reaches the surface through `markets.yaml`
**alone**, and that a market-id branch in core trips the N7 guard.

**The extension, then the revert.** A fictional market `zz` (ISO 3166
reserves ZZ for private use; XTS for testing, so it can never collide
with a real market) is appended to a temp copy of `markets.yaml`,
`PUBLIC_MARKET_MARKETS_PATH` points at it, and:

- it appears in `ordered_markets()` — in the **A→Z tail**, never claiming
  a marquee slot;
- `GET /api/public/markets` renders its tab with a name, a status, a
  licence line, a currency, a group and `entities_held: 0`;
- `GET /api/public/markets/company/zz/ANY` → **501
  `MARKET_AWAITING_PROVIDER`** with a non-empty detail;
- **the engine tree digest is byte-identical before and after** (sha256
  over every `.py` / `.yaml` / `.json` under the package, path-sorted) —
  which is what "zero engine edits" actually means;
- the env var is restored, the cache reset, and `market_ids()` is
  byte-identical to the starting tuple.

**Registry-only extension is not registry-only licence:** a `zz` row that
claims `status: live` without naming a feed is refused at load
(`RegistryError`). Otherwise "live" becomes decoration one yaml edit at
a time.

**Frontend half — this is the other half of the promise.** If the app
rendered its own hardcoded list, the new market would still have no tab.
Proven: an API payload containing `zz` (a market **not** in
`BUNDLED_MARKETS`) reaches the ordered tab list through
`fetchMarketRegistry`, in the `rest` group, with Romania still leading;
and the API wins over the bundle when they disagree, so the bundle is a
fallback and not a build-time pin of the market list.

**The N7 plant — a market-id branch in core.** Run on the real tree:

```
FAIL PM6 …
  ! model.py:490 compares market_id/market against a string literal —
    branch on is_live / is_fundamentals_only / is_home instead
  ! model.py:490 quotes market id 'us'
```

reverted, file byte-identical, gate green again. The automated version in
the pytest lane plants into a **temp copy** of the real package rather
than in place: an in-place plant interrupted by Ctrl-C or a killed CI job
leaves a corrupted engine file on disk, and the bytes scanned are
identical either way. The real-tree run above was performed once, by
hand, with sha256 verified before and after.

**Prose never trips the guard** — docstrings and bare string statements
are exempt, asserted with a planted docstring mentioning a market. A
guard that fires on documentation gets switched off.

**Market-literal allowlist** (keyed by *(file, module-level constant)*,
not by file, so a future `market_id == "us"` cannot slip in beside a
legitimate lookup table; each verified to still exist):
`prices.MARKET_REGISTRY`, `providers._SLOT_MARKETS`, `esef.COVERAGE_GAPS`,
`entity._NFKD_RESISTANT`. Wholesale exemption: `registry.py` only.

---

## PM7 — BVB / public_ro untouched

**Asserts:**

- **corpus replay 18/18 byte-identical**, and the case count is pinned:
  a drop is a silently deleted golden, a rise is an unreviewed one;
- no module in `engine/public_market/` imports `engine.public_ro`, and
  none reads `PUBLIC_RO_DB_PATH` / `PUBLIC_RO_SITEMAP_DIR` /
  `PUBLIC_RO_PAGES_DIR` / `PUBLIC_RO_TAKEDOWN_DB`;
- the home market's company route refuses with **404
  `HOME_MARKET_SERVED_ELSEWHERE`**, naming the pipeline that does serve
  it — while the market still **leads the list**, in its own group.
  Refusing the company route is not the same as hiding the market;
- the marquee order is exactly **US, DE, UK, FR, IT, ES, CN, AE**, after
  Romania;
- **peer-add never widens a cohort** — engine side, an added company from
  another sector or size band leaves the peer set unchanged; frontend
  side, adding a global name to a BVB cohort creates a **second** cohort
  rather than widening the first, and an unrecognised venue gets its own
  cohort rather than being folded into a known one.

**Plants:**

| Plant | Result |
|---|---|
| `from engine.public_ro.store import PublicRoStore` in `store.py` (real tree) | `FAIL PM7 … store.py:671 imports engine.public_ro.store` |
| `os.environ.get('PUBLIC_RO_DB_PATH')` in `router.py` (temp copy) | trips |
| **a home-market seed carrying one member** | `SeedError` — refused, store left empty |

That last one matters more than it looks. The shipped `seeds/ro.json` is
empty, and an empty file proves nothing on its own — it is a convention,
and a convention is one commit from being wrong. The plant puts a real
Romanian issuer (TLV, with its LEI) into a home-market seed in memory and
requires `universe.load_into_store` to refuse it structurally, via
`Market.is_home`. One company answered by two document classes is two
sources of truth and, eventually, two different numbers.

---

## Cross-lane needs

1. **PM1 (spine lane).** `model.validate_envelope` / `store.put_filing`
   must refuse a figure whose `provenance.source` names a model, a mock
   or an estimate. Reproduced above; the gate refuses it, the spine does
   not. `test_pm1_plant_model_authored_revenue_is_refused` fails loudly
   when this is fixed, with deletion instructions.
2. **PM2 (frontend lane, low priority).** `MarketPulseStrip`'s headline
   median has no minimum-n of its own. Allowlisted with a written reason;
   consider routing it through `MIN_N_FOR_PERCENTILES` so the one
   remaining ungated market statistic joins the rest.
3. **PM2 (whoever moves a percentile server-side).** The engine-side
   contract is written and proven; add your module to
   `GROUPING_FN_SEAMS` and the `skipif` releases itself. Cohort members
   must carry `market_id` *and* `accounting_standard` — an unlabeled row
   is itself a violation.
4. **PM4 (prices lane).** `prices.MARKET_REGISTRY` still keys cadence by
   ISO-3166 code rather than by registry market id. Allowlisted under N7
   with that reason; `price_block(..., registry=...)` already accepts an
   injected table, so the switch is a call-site change, not a signature
   change.

5. **⚠ NEW — the edgar lane's tests poison the real deployment store.**
   Found while re-running the wave's end state.

   `tests/engine/test_public_market_edgar.py::test_adapter_discovers_real_spine_store`
   and `::test_adapter_resolve_journals_success` call
   `spine_store.get_store()` — the **process-default** store at
   `data/public_market.db` — with no `PUBLIC_MARKET_DB_PATH` override
   (`tmp_path` is used only for the journal). The envelope they persist
   carries a clock-derived `provenance.fetched_at`, so its content hash
   is different on every run. The store then does exactly the right
   thing: same accession, different bytes → queued for review and
   **refused** (`REASON_CONTENT_CHANGED`). The adapter reports
   `cache_fail` instead of `ingest_ok`, and `meta.cached` is `False`.

   **These two tests therefore pass exactly once per machine and are red
   on every run after — and each run leaves junk in the deployed
   database's review queue.** Deterministic reproduction:

   ```
   D=$(mktemp -d)
   PUBLIC_MARKET_DB_PATH=$D/pm.db pytest tests/engine/test_public_market_edgar.py -q
   #  -> 30 passed
   PUBLIC_MARKET_DB_PATH=$D/pm.db pytest tests/engine/test_public_market_edgar.py -q
   #  -> 2 failed, 28 passed
   ```

   Not a defect in the store — the refusal is the store's correctness.
   The fix belongs to the edgar lane: point those two tests at a temp DB
   (`monkeypatch.setenv("PUBLIC_MARKET_DB_PATH", str(tmp_path / "pm.db"))`
   plus `spine_store.reset_store()`), or pin `fetched_at` the way the
   rest of that file already pins `FETCHED_AT`.

   Every gate in this lane is held to the opposite standard, asserted by
   `test_gate_script_never_touches_the_deployed_database`: the deployed
   store's sha256 must be byte-identical before and after every gate
   runs, and PM1 reads it through `sqlite3 mode=ro` precisely so its
   `_ensure_schema()` write cannot fire.

---

## Known pre-existing failures (not these gates)

Full engine suite at the wave's end state: **8 failed, 2550 passed, 15
skipped, 1 xfailed**.

| Failure | Owner |
|---|---|
| `tests/engine/public/test_adapter.py` ×2 | pre-existing SHARADAR market-cap scaling defect; deselected in `run_battery.py` and named in the wave brief |
| `tests/engine/test_corpus_policy.py` ×2 | pre-existing: a `site_location_short` weekday collision in `frontend/components/cfo/Sidebar.tsx`, plus 4 stale allowlist entries — flagged by the spine lane. (Naming the offending three-letter token in this file would itself trip the gate, so it is described rather than quoted.) |
| `tests/engine/test_engine_book.py::test_regeneration_is_byte_identical` | `docs/engine_book/` has no `public_market` content at all; regenerate once as a wave-closing step — flagged by the spine lane |
| `tests/engine/test_import_boundary.py::test_boundary_script_exits_zero_on_tree` | 2 `F-DIFFERENCE` hits in `components/instrument/shell/TrustChip.tsx` (a shared-banned file) — flagged by the spine lane |
| `tests/engine/test_public_market_edgar.py` ×2 | **cross-lane need #5 above** — self-poisoning against the real store, reproduced deterministically |

Also named in the wave brief and unchanged by this lane: `vitest`
`currencyToggle` / `chatScope` / `commandCenterMenu`; `pytest`
`tests/test_api.py`, `test_statutory_104`.

Nothing in this list is caused by this lane. Removing this lane's four
files leaves all eight in place.
