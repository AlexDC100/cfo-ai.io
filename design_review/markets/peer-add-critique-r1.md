# Peer-add across markets — critique r1

**Lane:** the last open piece of the GLOBAL PUBLIC MARKETS wave — DOD2's second
half ("Add as peer" on a non-RO company card) and DOD5 (that peer lands in its
own market/standard cohort in Benchmark, never inside the Romanian one).

**Screenshots:** `design_review/markets/peer-add-r1/` — regenerate with
`node design_review/markets/peer-add-r1/capture.mjs` (EN) and
`capture_ro.mjs` (RO). Both drive the real local stack; nothing is stubbed, and
every Apple figure on screen came out of the engine's spine store, which read it
out of SEC bytes.

| # | File | What it shows |
|---|---|---|
| 1 | `01-us-tab.png` | US tab, no peers yet |
| 2 | `02-aapl-card-add-as-peer.png` | AAPL resolved; the card carries **Add as peer** + "Carries 2 comparable ratios" |
| 3 | `03-added-check-chip.png` | Added → check chip, "See it in Benchmark", the cohort law stated inline, toast |
| 4 | `04-benchmark-us-cohort-n1.png` | Benchmark with ONE peer: population `US · USD · US_GAAP`, n=1 |
| 5 | `05-two-cohorts-ro-and-us.png` | Same group, RO peers added: two cohort chips, `BVB · RON · RAS/IFRS n=2` and `US · USD · US_GAAP n=1` |
| 6 | `06-us-cohort-selected.png` | The US cohort selected — "Only comparable: AAPL", no median |
| 7 | `07-peer-tray-market-chip.png` | Peer tray: `AAPL US` labelled with its market; `TLV`, `SNP` are not |
| 8 | `08-ro-added-card.png` | RO copy on the card |
| 9 | `09-ro-benchmark-cohorts.png` | RO copy in the panel |

---

## What was actually broken

The peer store existed, the grouping law existed, and the US card existed. The
seam between them did not, and it failed in three separate places at once:

1. **The card had no control at all.** DOD2's second half was simply missing.
2. **`buildBenchGroups` resolved peers only against the loaded universe**, which
   is BVB-only. A US ticker would have been stored and then **silently dropped**
   — added, persisted, never rendered. That is the worst of the three: it looks
   like a working feature until you go looking for the company.
3. **`benchmarkKeyOf` keyed the cohort off `exchange`.** A pm1 envelope names no
   exchange (the US registry lists NYSE *and* NASDAQ; the filing names neither),
   so a peer built from one would have keyed to `unknown` — a real US_GAAP filer
   in an "Unclassified" population.

None of these is "the median blended", which is what PM7 guards. The realistic
failure was quieter: the peer disappears, or it shows up mislabelled.

---

## Decisions worth arguing with

### The peer carries `market_id`, not an exchange

`BenchmarkSubject` gained `marketId`, and `benchmarkKeyOf` now prefers it over
the exchange map. The alternative was to write `exchanges[0]` into the peer — a
one-line change that would have invented "NYSE" for Apple. That guess then
*decides a cohort*, so it is not cosmetic. Market id is a fact the document
carried; exchange would have been a fabrication with a plausible face.

The fallback order is deliberate: an unrecognised `market_id` returns `null` and
lets the exchange path try, rather than collapsing to `unknown` — the two are
different failures and only one of them is the venue's.

### "Your peers" is a new group, not a widened old one

Three options were on the table for where an added US peer goes:

- **into "Peers BVB"** — that is literally the blend PM7 forbids;
- **into "Global"** — the demo watchlist, whose own AAPL row carries
  *illustrative* figures. A real SEC-sourced Apple sitting beside (or being
  shadowed by) an invented Apple is a worse bug than dropping it;
- **into its own group** — chosen.

A group is a *taxonomy*; a population is `market × currency × standard`. "Your
peers" spans markets on purpose, and `partitionByKey` splits it into cohorts —
that split is the feature, visible as the two chips in screenshot 5.

`defaultBenchGroupKey` now opens on "Your peers" **only when it holds a
non-Romanian peer**. A peer with nowhere visible to land reads exactly like a
peer that was dropped; a purely Romanian peer set does not hijack the default,
because "Peers BVB" already shows it.

### Two metrics were added, and no more

The panel compares ratios; a pm1 envelope states figures. Apple's document gives
revenue, net income, total assets, equity, total debt — and by design **no
EBITDA and no cash**. So of the six existing metrics, the US peer could honestly
carry **zero**, and `BenchmarkTile` returns `null` on an empty statistic, which
would have rendered the peer's cohort as a completely blank panel.

Two metrics were added because a real filing on either side of the line can
produce them from what it actually states: **net margin** (net income ÷ revenue)
and **debt / equity** (total debt ÷ equity). `peerMetricsFromEnvelope` computes a
ratio only when both figures are present, in the same currency, for the same
fiscal period end, with a non-zero denominator — four guards, each with a plant
in the test file.

What was *refused*: EBITDA margin from operating income plus a guessed D&A,
net-debt/EBITDA with cash treated as zero, any growth rate from a single year.
Those stay absent, the tiles stay unrendered, and the card says so in words
("Carries 2 comparable ratios").

Cost of the addition: the demo watchlist rows have neither metric, so the two new
tiles do not render for the "Global" group. That is the correct behaviour (a tile
exists where data exists), but it does mean the shipped demo group now shows six
tiles while a peer group can show eight.

### Small-n honesty came for free, and was verified rather than assumed

n=1 renders `single_comparable` — "Only comparable: AAPL", the value once, the
member listed, and **no median, no P25, no P75**. This is `computeBenchmarkStats`
doing its existing job; the lane's contribution was making sure the US cohort
reaches it as a real sample instead of an empty one. Asserted at the value level
in `peerAddCohort.test.tsx` (`stats` has no `median`/`p25`/`p75` property) and
visible in screenshot 6.

---

## Honest gaps

**1. The page footer now under-claims.** `pci.footer.demo` reads "every figure on
this page is illustrative" — a true statement about the BVB grid in demo mode,
and now a false one about the Apple figures in the panel below it. It errs
*conservatively* (a real fact reads as illustrative, not the reverse), so it is a
loss of trust rather than a fabrication. Fixing it means the footer has to speak
per-source, which lives in `pages/cfo/PublicCompanyIntelligence.tsx` — outside
this lane's files. **Flagged for the page owner**, not patched.

**2. Romanian peer-add has no clean path in this environment.** The two RO
peer-add entry points are `PeerSuggestRail` (needs a loaded workspace period) and
`/dashboard/public/:ticker` (needs a Nasdaq key). With no key, that page's
`info` is null and `PublicCompanyHeader` falls back to `currency: "USD"` and
`exchange: null` — so a TLV added there stores as an unclassified, USD peer.
It degrades *safely* (unknown venue → its own cohort, never the home one, which
is the PM7 rule working), but it is wrong, and it is a pre-existing defect in a
file outside this lane. Screenshots 5/6/9 therefore seed the two Romanian peers
through the store's own shape; the capture script says so at the call site.

**3. The "Peer" chip label is English in Romanian.** Deliberate — the existing RO
bundle already uses "Peer" (`pci.rail.inPeers`), so matching it beat inventing a
second word for the same thing.

**4. Peer identity changed shape.** `addPeer` now dedupes on `(market, ticker)`
rather than ticker alone, so two registries may each list "ABC". `isPeer` /
`removePeer` keep their old ticker-only behaviour when no market is passed, so
every pre-existing caller is untouched. Legacy stored entries are normalised on
read (`BVB→ro`, `NYSE/NASDAQ→us`) and anything else keeps `marketId` absent
rather than acquiring a guessed one.

**5. A latent labelling bug was found and fixed on the way.** The sector-subgroup
label was `parent.key === "bvb" ? "BVB" : "Global"` — correct while exactly two
parent groups existed, and wrong the moment a third appeared: a "Your peers"
sector chip would have read "Global · Financials". Replaced with a lookup and
pinned by a test.

**6. `BenchmarkReport.tsx` was not touched.** It reads the engine's CAEN industry
benchmark and has never consumed the peer store (grep: zero references). The
surface that consumes peers is `BenchmarkingPanel`, which is what was wired.

---

## Gates

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | PASS |
| `marketGates.test.ts` + `benchmarkHonesty.test.ts` | 63/63 PASS |
| `peerAddCohort.test.tsx` (new) | 23/23 PASS |
| full `vitest` | 649 passed, 18 failed — **the same 18 as before this lane** (accountMenu / currencyToggle / chatScope / commandCenter / attachConfirm), none in touched files |
| `node scripts/check_design_lint.mjs` | PASS (0 hex, 0 shadow, 0 serif) |
| `python3 scripts/check_public_market_gates.py` | PASS — 6/7 green, PM2 skipped as before |
| `.venv/bin/python scripts/corpus_replay.py` | PASS — 18/18 |

**Non-vacuity check.** Removing the `marketId` preference from `benchmarkKeyOf`
(the one-line mutation the lane exists to make) fails 4 of the new tests,
including both DOD5 assertions and the DOD4 small-n one. The gate is wired to
something.
