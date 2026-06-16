# CFO AI — F4 Cross-Country Benchmark Layer
## Kickoff prompt for Claude Code (built on F3 country-pack foundation)

> **Send this prompt only after F3 architectural close (F3.1 + F3.2 + F3.3 + F3.4 + F3.5 + F3.6) is acknowledged.** The cross-country benchmark layer depends on the country-pack registry, the `calibration_fixtures` table (F3.5), the per-upload confidence engine (F3.3), and Review Mode (F3.4). Sending mid-F3 abandons F3.

---

## Context for Claude Code

You are continuing development of CFO AI. F1 (engine canonical-contract extensions), F2 (FE canonical-conformance), and F3 (country-pack architecture + calibration store) are now closed. The engine is country-pack-pluralisable, every pack must satisfy the `CanonicalFinancialModel` typed contract (F3.2), upload-time detection routes the right pack (F3.3), Review Mode handles low-confidence inputs (F3.4), and a calibration learning database accepts manual corrections + admin approval (F3.5 + F3.6).

This kickoff opens **F4 — Cross-Country Benchmark Layer**: turning the existing per-company analysis into a cross-country relative-benchmark surface. The benchmark layer answers questions like:
- "How does this Romanian food manufacturer's EBITDA margin compare to other RO food manufacturers, AND to food manufacturers in calibrated peer countries?"
- "Across deeply-calibrated packs, what's the inter-country dispersion of working-capital cycles in commercial real estate?"
- "Given the available calibrated fixtures, what's the most relatable peer comparison we can honestly offer this upload?"

This is structural product work that builds **on top of** the country-pack foundation — it does not replace, alter, or weaken the per-country single-pack analysis that exists today. Romanian analysis output stays byte-identical to F3-close on every existing surface.

---

## CRITICAL CONSTRAINTS — READ BEFORE PROPOSING ANYTHING

1. **Romania never breaks.** F-A3.1 GREEN + F3.1-PARITY byte-identical on EEI + Scandia at every step. Same protocol as F1/F2/F3.

2. **Benchmarks are computed from real fixtures only.** A country's median/percentile/dispersion data point must come from `calibration_fixtures` rows of `is_locked=true` status in that country. Synthetic, AI-generated, scraped-from-public-statements-without-permission, or extrapolated benchmarks are forbidden. The F3 kickoff's "no calibration without real fixtures" rule extends to benchmarks.

3. **No "supports N countries" claims, ever.** Benchmark surfaces show per-country fixture count + calibration tier verbatim. A FE benchmark widget that says "compared against companies across 16 countries" without 16 calibrated packs is a misrepresentation. Allowed labels: "compared against {N} {country_name} fixtures (tier: {tier})" — never aggregated counts that hide per-country thinness.

4. **LLM never computes benchmark values.** Claude Opus 4.7 is used for: narrative framing, explaining cross-country adjustments, generating per-quartile commentary. Claude is NOT used for: percentile arithmetic, median calculations, currency conversion, FX adjustments, or any number that appears as a benchmark value. All numerics deterministic.

5. **No cross-country comparison without honest currency + accounting adjustments.** A Romanian RAS food-manufacturer EBITDA margin is NOT comparable to a German HGB food-manufacturer EBITDA margin without explicit reconciliation of: (a) currency (RON vs EUR), (b) accounting basis (RAS statutory net income vs HGB), (c) tax structure (16% RO corporate vs ~30% DE). Cross-country tiles surface these adjustments explicitly; raw "13.2% vs 8.4%" comparisons that don't disclose the adjustments are rejected at review.

6. **Per-chunk protocol applies.** ONE chunk per deploy, F-A3.1 GREEN gate, fixture-rendering parity, before/after capture, STOP for visual-on-prod authorization. **Parity-gate non-triviality check is mandatory** (locked discipline point from F3.1): every new gate must be verified-to-fail-on-deliberate-bug before being trusted.

7. **Calibration tier gates benchmark inclusion.** A country pack at:
   - `deeply_calibrated` (≥10 fixtures): full benchmark participation (median, P25/P75, count, dispersion).
   - `partially_calibrated` (≥3 fixtures): median + count only; no quartile boundaries (sample too small for honest quartiles).
   - `experimental` (≥1 fixture): listed as "calibrated, sample size 1-2"; no statistical claims.
   - `benchmark_only` or `unsupported`: NOT included in cross-country comparison.

---

## Workstream Sequence

This workstream is named **F4 — Cross-Country Benchmark Layer**. It comprises the following chunks, ordered:

### F4.1 — Benchmark data model + fixture metric extraction

Define the typed shape of a cross-country benchmark. Extract per-fixture metrics from `calibration_fixtures` rows (using the post-assembly canonical envelope) and store them in a new `benchmark_metrics` table keyed by `(fixture_id, metric_name, industry_key)`.

**Scope**: Pure data layer. No FE. No new endpoints surfaced to users.

**Acceptance**:
- `BenchmarkMetric` typed shape exists with: `country_code`, `coa_key`, `industry_key`, `fixture_id`, `metric_name`, `value`, `currency`, `period_label`, `engine_version`.
- For Romania's 2 calibrated fixtures (EEI + Scandia): the 17 canonical-mapped ratios from F2.2 (`ebitda_margin`, `current_ratio`, `dso`, `dio`, etc.) are extracted and persisted to `benchmark_metrics`. Verify EEI ebitda_margin matches the live API value to the cent.
- F-A3.1 + F3.1-PARITY + F3.2-CANONICAL + F3.3-DETECTION all GREEN.
- New F4-PARITY gate: extracting metrics twice from the same fixture produces byte-identical `benchmark_metrics` rows (non-triviality test: scale one fixture's revenue by 1.01 → gate fails red → revert → gate passes green).

**Out of scope**: cross-country aggregation (F4.2), FE surface (F4.3+), currency/basis adjustments (F4.4).

---

### F4.2 — Per-country aggregation + tier gating

Compute per-country distribution statistics (count, median, P25, P75, std dev) from `benchmark_metrics`. Persist to `benchmark_aggregates` table keyed by `(country_code, industry_key, metric_name)`. Apply the calibration-tier gate from constraint #7: tier dictates which statistics are surfaced.

**Scope**: Aggregation layer + tier policy.

**Acceptance**:
- For Romania `food_manufacturing` (1 fixture: Scandia): tier is `experimental`-equivalent at this stage (sample size 1), so the aggregate row carries `count=1`, no quartile boundaries.
- For Romania `real_estate_commercial` (1 fixture: EEI): same — count=1, no quartiles.
- Verify the median equals the single fixture's value (sanity).
- F-A3.1 GREEN.

**Out of scope**: cross-country meta-aggregation (F4.4), FE rendering (F4.3).

---

### F4.3 — Per-upload benchmark surface

Add an endpoint that, given a period_id, returns: (a) the upload's own metric values, (b) the calibrated peer comparison set (same country + same industry, OR same industry across countries if user opts in), (c) per-metric position (percentile within peer set), (d) the honest disclosure block per the calibration tier policy.

**Scope**: API + FE rendering on the existing Ratios tab.

**Acceptance**:
- For a Scandia upload (food_manufacturing): the response includes peer comparison set with `peer_count: 1` (Scandia itself in the calibrated set — exclude self-comparison) → empty peer set → response surfaces "Insufficient peer fixtures for benchmark; need ≥3 for partially calibrated tier." No median rendered.
- For a synthetic 11-fixture peer set (operator-side: add 10 more Romanian food_manufacturing fixtures): the response includes median + P25/P75 + the upload's position.
- FE: Ratios tab renders the peer-comparison column WHEN data exists; otherwise renders the tier-gated disclosure.
- F-A3.1 GREEN.

**Out of scope**: cross-country currency adjustments (F4.4).

---

### F4.4 — Currency + accounting-basis adjustments

For cross-country benchmark comparison, define the explicit adjustment layer:
- **Currency**: convert all values to a base currency (EUR by default; operator-configurable). Use a fixed historical FX rate per fiscal year (NOT current spot — distorts comparisons).
- **Accounting basis**: surface the basis difference explicitly. RO statutory NI != DE HGB NI != FR PCG net result. The benchmark response carries `basis_adjustment_notes` explaining the comparison's caveats.
- **Tax**: where corporate tax rates differ materially across countries (RO 16% vs DE 30%), surface the pre-tax metric alongside the post-tax one.

**Scope**: Adjustment table + per-metric metadata indicating which adjustments apply.

**Acceptance**:
- For a Romanian food_manufacturing EBITDA margin: the adjustment notes correctly say "no currency adjustment needed for EBITDA margin (ratio); accounting-basis adjustments may apply for German/French peers under HGB/PCG."
- For a Romanian-vs-German net income comparison: the notes correctly say "Currency: converted RON → EUR at 2025-12-31 fixed rate. Accounting basis: RO RAS statutory net (ct.121 closing) vs DE HGB net result; not directly comparable."
- F-A3.1 GREEN.

**Out of scope**: FX rate sourcing / management (separate operator workstream); IFRS reconciliation (separate workstream).

---

### F4.5 — Cross-country meta-aggregation

Across all `deeply_calibrated` and `partially_calibrated` packs, compute industry-level meta-aggregates (e.g., "global food manufacturing EBITDA margin distribution across RO + BG + HU"). Surface only when ≥2 countries are at `partially_calibrated` or higher for the relevant industry.

**Scope**: Meta-aggregation layer + FE surface.

**Acceptance**:
- With only Romania calibrated (current state): NO meta-aggregation surfaces. The FE shows "Cross-country comparison requires ≥2 calibrated country packs; currently 1."
- Once Bulgaria (F3.7) reaches `partially_calibrated` (≥3 BG fixtures): meta-aggregation surfaces RO + BG for matching industries.
- F-A3.1 GREEN.

**Out of scope**: Bulgaria pack itself (F3.7); third-country packs.

---

### F4.6 — Benchmark briefing layer

Extend the LLM CFO Briefing (F2.8) to cite benchmark values when available. Same discipline as F2.8: every number cited must come verbatim from the engine-emitted `benchmark_aggregates` or per-upload `benchmark_position` data. Never compute, never approximate.

**Scope**: Briefing prompt extension + briefing-regenerate path.

**Acceptance**:
- For a Scandia briefing post-F4.6: when no peer benchmark is available (RO food_manufacturing sample size 1), the briefing says "Cross-country peer comparison: not yet available; CFO AI calibration tier for Romanian food_manufacturing is experimental at this sample size."
- For a synthetic 11-fixture peer set: briefing cites "Scandia EBITDA margin of 13.2% sits at the 64th percentile of 11 calibrated Romanian food-manufacturing fixtures."
- Briefing never claims a position when underlying data isn't there.
- F-A3.1 GREEN.

**Out of scope**: New briefing endpoints (the existing /briefing/regenerate accepts the benchmark data via the assembled envelope).

---

## File and Module Structure

Proposed (Claude Code reviews + refines before implementing):

```
src/engine/
  core/
    benchmark_model.py            # F4.1 — typed shapes + extractor interface
    benchmark_aggregator.py       # F4.2 — per-country stats + tier gates
    benchmark_position.py         # F4.3 — per-upload position computation
    benchmark_adjustments.py      # F4.4 — currency + basis adjustment helpers
    benchmark_meta.py             # F4.5 — cross-country meta-aggregation
  api/
    pipeline.py                   # endpoints: /api/period/{id}/benchmarks,
                                  # /api/admin/benchmarks/recompute

supabase/
  schema_phase_f4_benchmarks.sql  # benchmark_metrics, benchmark_aggregates,
                                  # benchmark_position_cache

scandi-desk-main/src/
  lib/
    benchmarkData.ts              # FE typed shapes mirroring BE
  components/cfo/
    BenchmarkComparison.tsx       # Ratios-tab peer-comparison column
    CrossCountryBadge.tsx         # F4.5 calibration disclosure
  pages/cfo/admin/
    BenchmarkCoverage.tsx         # F3.6 admin dashboard extension

scripts/
  check_benchmark_extraction.py   # F4-PARITY gate
  check_benchmark_aggregation.py  # F4.2-AGGREGATION gate
```

---

## Process — F4.1 (the first chunk to execute)

When you receive authorization to begin F4.1, the protocol is:

1. **Pre-deploy capture (read-only).** Enumerate every existing place in the engine that computes a per-company benchmark-style metric. Confirm none of them mutate state. Identify the 17 canonical-mapped ratios already in `assembled_metrics.ratios` so F4.1 extraction is a thin pluck — no recomputation.

2. **Propose the benchmark data model.** Based on the inventory:
   - Exact `BenchmarkMetric` typed shape.
   - Schema for `benchmark_metrics` table.
   - The extractor's signature: `extract_benchmark_metrics(fixture_id, assembled_envelope, industry_key) -> List[BenchmarkMetric]`.
   - Migration plan: how the table gets seeded from existing `calibration_fixtures` rows.
   - Risk assessment: any place the extraction might depend on country-pack-specific code (it shouldn't — extraction is pure plucking from canonical envelope).

3. **Wait for authorization.** Do not edit code until the architecture proposal is approved. Same gate as F3.1.

4. **Execute F4.1 in sub-chunks.** Likely subdivision:
   - F4.1a — `BenchmarkMetric` typed shape + extractor signature (no code paths yet).
   - F4.1b — `benchmark_metrics` table schema migration file written.
   - F4.1c — Extractor implementation + per-Romanian-fixture extraction probe (verify values match live API).
   - F4.1d — F4-PARITY gate written + non-triviality verified.
   - F4.1e — All sub-chunks closed, F-A3.1 + F4-PARITY GREEN.

5. **Per-chunk protocol same as F1/F2/F3.** ONE sub-chunk per deploy, gate verification, STOP for visual-on-prod confirmation between chunks.

6. **F4.1 closes when**: 17 canonical-mapped ratios extracted to `benchmark_metrics` for both Romanian fixtures, values match live API to the cent, F-A3.1 GREEN, F4-PARITY gate confirmed-non-trivial.

---

## What Success Looks Like at Workstream Close (F4 done)

- `benchmark_metrics` populated with every calibrated fixture's metrics.
- `benchmark_aggregates` computes per-country distributions with tier-gated surfacing.
- Per-upload Ratios tab shows peer-comparison columns when calibrated peers exist.
- Currency + accounting-basis adjustments are explicit on every cross-country tile.
- Meta-aggregation across countries surfaces ONLY when ≥2 packs are at partially_calibrated or higher.
- Briefing layer cites benchmark values verbatim from engine output.
- F-A3.1 GREEN on Romanian fixtures throughout.
- No UI copy overclaims coverage; the per-country fixture count is always visible.

---

## What Is Explicitly Out of Scope

- LLM-based benchmark computation (forbidden; deterministic only).
- Aggregation across non-calibrated countries (forbidden; tier gate enforced).
- "Compared against companies in N countries" copy that hides per-country count.
- Currency conversion via floating spot rates (must be fixed historical for fiscal year).
- Fictitious or "industry standard" benchmark values without `calibration_fixtures` provenance.
- Bulgaria / Hungary / Poland country packs themselves (those are F3.7+).
- Operator-side fixture acquisition (engineering depends on it; can't proceed without).

---

## Honesty Commitment

F4 alone is probably 6-10 weeks of engineering, assuming Romania's fixture base remains at 2 (Scandia + EEI) — most of the work is structural plumbing that pays off when more fixtures + more countries arrive. Without fixture growth, F4 ships the architecture but its surfaces remain limited.

The total path from F4.1 kickoff to a credibly cross-country benchmark product is **bounded by fixture acquisition**, not engineering. Operator work (sourcing real trial balances from real companies in real countries, with real consent) is the gating constraint. Engineering can build the architecture in 6-10 weeks; meaningful benchmarks require 10+ fixtures per (country, industry) pair, which is operator-side multi-month work.

Same rhythm as F3. Same gates. Same discipline. New scope.

---

## When to Use This Prompt

Only after F3 architectural close is acknowledged. Send it as the F4 kickoff message at that point.

When the time comes, the first message to Claude Code will be:

> "Begin F4.1 with read-only pre-deploy capture. Enumerate every existing engine path that computes a per-company benchmark-style metric. Do not edit code until I approve the architecture proposal."

Same rhythm as F3.1 and F3.2 kickoffs.
