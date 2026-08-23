# Assertion catalog (A-###) — the assertion-dense kernel (C3)

Tiger-style, ALWAYS-ON pre/postconditions inside the engine's exact-value
kernel. Every `assert` on the value path carries an `A-###` id in its
message, is catalogued here, and has a **witness test** in
`tests/engine/test_assertion_witnesses.py` that actually makes it fire
(via internal construction — corrupted frozen instances, impure "evil"
subclasses, monkeypatched routing tables — because the guarded states are
unreachable through public inputs; A-034 is the one public-input witness).

Ground rules:

* Assertions **never change behavior** for valid data — the golden corpus
  replay and the determinism gate prove each addition is byte-neutral.
  If an assert ever fires on real data, that is a REAL BUG being reported
  at the boundary where it happened: investigate, never delete the assert
  silently.
* Typed raises (`MoneyParseError`, `LedgerDocError`, …) remain the
  PUBLIC-input validation surface; the A-### asserts guard the states
  those raises cannot see (post-construction corruption, impure
  attribute reads, mapping-table drift, float leakage mid-computation).
* Line anchors below are exact as of this catalog's commit; re-anchor
  with `grep -n "A-0" <module>` after edits (each id is unique in its
  message, so grep is the stable lookup — the id, not the line, is the
  identity).
* Scope note: the reconcile validator's assertions
  (`engine.api._reconcile`) are **deferred to the next wave** — that
  module is owned by REG this wave; ids A-04x are reserved for it.

## `src/engine/ir/money.py`

| id | anchor | guarded invariant | witness test |
|----|--------|-------------------|--------------|
| A-001 | `money.py:329` (`_require_same_unit`) | Binary-op chokepoint (add/sub/lt/le/gt/ge): both operands still hold exact `int` minor units — no float/bool ever reaches Money algebra, even via post-construction corruption. | `TestMoneyWitnesses::test_a001_binary_op_integrality` |
| A-002 | `money.py:364` (`__neg__`) | Negation precondition: `amount_minor` is an exact int (neg bypasses `_require_same_unit`). | `TestMoneyWitnesses::test_a002_neg_integrality` |
| A-003 | `money.py:292` (`to_decimal_str`) | Rendering precondition: int minor units AND scale within `0.._MAX_SCALE` — a corrupted value must fail loud, never emit a wrong-magnitude decimal string. | `TestMoneyWitnesses::test_a003_to_decimal_str_domain` |
| A-004 | `money.py:346` (`__add__`) | Closure postcondition: the sum's `(currency, scale)` equals the operands' — Money algebra is closed over ONE unit (catches constructor-normalization drift). | `TestMoneyWitnesses::test_a004_add_unit_closure` |
| A-005 | `money.py:356` (`__sub__`) | Same closure postcondition for subtraction. | `TestMoneyWitnesses::test_a005_sub_unit_closure` |

## `src/engine/ir/ledgerdoc.py`

| id | anchor | guarded invariant | witness test |
|----|--------|-------------------|--------------|
| A-010 | `ledgerdoc.py:322` (`AccountAtom.__post_init__`) | ABSENT-vs-ZERO with integrality: every amount slot is `None` (ABSENT) or a Money whose minor units are still an exact int — a corrupted Money must not be frozen into an atom. | `TestLedgerDocWitnesses::test_a010_atom_slot_integrality` |
| A-011 | `ledgerdoc.py:352` (`DocumentTotals.__post_init__`) | Same slot invariant for the file's own totals row. | `TestLedgerDocWitnesses::test_a011_totals_slot_integrality` |
| A-012 | `ledgerdoc.py:411` (`DocHeader.__post_init__`) | Deep-immutability postcondition: `source_meta` is a `MappingProxyType` after the freeze — a plain dict would let callers alias-mutate the "immutable" doc. | `TestLedgerDocWitnesses::test_a012_source_meta_deep_frozen` |
| A-013 | `ledgerdoc.py:466` (`LedgerDoc.__post_init__`) | Atom-uniqueness census: after validation, exactly one registered id per atom — catches TOCTOU on impure `atom_id` reads that slip past the duplicate raise. | `TestLedgerDocWitnesses::test_a013_atom_census_toctou` |

## `src/engine/passes/classify.py`

| id | anchor | guarded invariant | witness test |
|----|--------|-------------------|--------------|
| A-020 | `classify.py:92` (`_minor_at`) | Rescale monotonicity: target scale ≥ the Money's own scale — a coarser target would make `10**(negative)` a float and poison the exact side computation. | `TestClassifyWitnesses::test_a020_minor_at_scale_monotonicity` |
| A-021 | `classify.py:114` (`_net_signed_minor`) | Net-balance integrality postcondition: the Σ(debit−credit) total is an exact int. | `TestClassifyWitnesses::test_a021_net_signed_minor_integrality` |
| A-022 | `classify.py:171` (`AtomClassification.__post_init__`) | UNCLASSIFIED-marker coherence: `line_id is None` ⇔ `method == 'unclassified'` — never guessed, never dropped, never a rule assignment without a line. | `TestClassifyWitnesses::test_a022_unclassified_marker_coherence` |
| A-023 | `classify.py:167` (`AtomClassification.__post_init__`) | Method vocabulary: only `'rule'` / `'unclassified'` exist in the shadow-phase layer. | `TestClassifyWitnesses::test_a023_method_vocabulary` |
| A-024 | `classify.py:177` (`AtomClassification.__post_init__`) | Confidence domain: a number in `[0, 1]`. | `TestClassifyWitnesses::test_a024_confidence_domain` |
| A-025 | `classify.py:266` (`classify`) | Totality postcondition: exactly one entry per atom — every atom classified-or-unclassified, none dropped, none invented. | `TestClassifyWitnesses::test_a025_classify_totality` |
| A-026 | `classify.py:271` (`classify`) | Order alignment postcondition: entries align 1:1 with `doc.atoms` in document order (with A-025: a bijection). | `TestClassifyWitnesses::test_a026_classify_order_alignment` |

## `src/engine/country_packs/ro_romania/canonical_adapter.py` (the canonical builder)

| id | anchor | guarded invariant | witness test |
|----|--------|-------------------|--------------|
| A-030 | `canonical_adapter.py:936` + `:949` (`_section_for_leaf`, both mapping paths) | Section-mapping closure: every mapped section id is one of `_BS_V2_SECTION_ORDER` — table drift fails at the mapping, not as a KeyError (or silent misplacement) deep in the cents accumulation. | `TestCanonicalBuilderWitnesses::test_a030_section_mapping_closure` |
| A-031 | `canonical_adapter.py:1399` (`build_canonical_bs_v2`, before totals) | Side-partition sanity: asset/equity section sets are disjoint subsets of the fixed order (liabilities = complement) — an overlap would double-count a whole section into two sides. | `TestCanonicalBuilderWitnesses::test_a031_side_partition_disjoint` |
| A-032 | `canonical_adapter.py:1363` (`build_canonical_bs_v2`, after row sort) | Result-row law: the current-year result appears as EXACTLY one row iff `result_cents != 0`, carrying exactly `result_cents` — no double-count of the result in equity. | `TestCanonicalBuilderWitnesses::test_a032_result_row_uniqueness` |
| A-033 | `canonical_adapter.py:611` (`assemble_canonical` leaf loop) | Always-positive canonical magnitudes (F3.15 decision 3b): direction lives in `sign_meaning`, never in a negative magnitude. | `TestCanonicalBuilderWitnesses::test_a033_magnitude_non_negative` |
| A-034 | `canonical_adapter.py:1376` (`build_canonical_bs_v2`, after rows) | Serialization conservation at the row boundary: every row's float `amount` round-trips to the exact integer cents it was built from — cents conservation survives the ONE place floats appear. | `TestCanonicalBuilderWitnesses::test_a034_row_serialization_conservation` (public input: raw `closing_result` cents beyond exact float range) |
| A-035 | `canonical_adapter.py:1469` (`build_canonical_bs_v2` invariants; pre-existing assert, id added) | Partition totality, asset side: Σ asset-section row cents == `totals.assets` cents — every cent placed exactly once, rows/sections/totals from the SAME sums. | `TestCanonicalBuilderWitnesses::test_a035_asset_rows_vs_totals` |
| A-036 | `canonical_adapter.py:1472` (same block; pre-existing assert, id added) | Partition totality, E+L side: Σ non-asset row cents == equity+liabilities cents. | `TestCanonicalBuilderWitnesses::test_a036_el_rows_vs_totals` |

## Assert density per module

Always-on `assert` statements per non-blank source line (typed raises
excluded — they are the separate public-validation surface):

| module | asserts | non-blank LOC | density (per 100 LOC) |
|--------|---------|---------------|------------------------|
| `src/engine/ir/money.py` | 5 | 329 | 1.5 |
| `src/engine/ir/ledgerdoc.py` | 4 | 418 | 1.0 |
| `src/engine/passes/classify.py` | 7 | 235 | 3.0 |
| `src/engine/country_packs/ro_romania/canonical_adapter.py` | 8 | 1505 | 0.5 |
| **kernel total** | **24** | **2487** | **1.0** |

(24 assert statements carry 22 distinct ids: A-030 guards both mapping
paths of `_section_for_leaf`; A-010/A-011 are sibling slot invariants
with one statement each.)

Recompute after edits:

```sh
for f in src/engine/ir/money.py src/engine/ir/ledgerdoc.py \
         src/engine/passes/classify.py \
         src/engine/country_packs/ro_romania/canonical_adapter.py; do
  printf "%s asserts=%s loc=%s\n" "$f" \
    "$(grep -c '^\s*assert ' "$f")" "$(grep -cv '^\s*$' "$f")"
done
```
