# Adding a jurisdiction

**Audience:** an engineer who has never opened this repo before.

**The claim this document exists to keep true:**

> Adding a minimal new jurisdiction is **authoring a pack** (+ optionally
> a front-end). It requires **zero** changes to `src/engine`.

That is not a convention. It is enforced by a test — `N7`,
`tests/engine/test_new_jurisdiction.py` — which admits a fictional
jurisdiction from a pack alone, drives it through the whole production
pipeline, and then fails if the change-set touched `src/engine` or if the
engine names the jurisdiction anywhere. Every new jurisdiction must pass
the same gate. See [§10](#10-n7--the-acceptance-gate).

Read [§1](#1-what-a-pack-is) and [§2](#2-the-ten-minute-version) first;
everything after that is reference you can come back to.

---

## Table of contents

1. [What a pack is](#1-what-a-pack-is)
2. [The ten-minute version](#2-the-ten-minute-version)
3. [Pack anatomy, file by file](#3-pack-anatomy-file-by-file)
   - [3.1 `pack.yaml`](#31-packyaml--identity-and-the-effective-window)
   - [3.2 `classification.yaml`](#32-classificationyaml--the-rules)
   - [3.3 `statement_map.yaml`](#33-statement_mapyaml--the-line-vocabulary)
   - [3.4 `checks.yaml`](#34-checksyaml--binding-engine-checks)
   - [3.5 `reconcile.yaml`](#35-reconcileyaml--auto-reconcile-policy)
   - [3.6 `confirmed_mappings.yaml`](#36-confirmed_mappingsyaml--optional-overlay)
4. [Rule kinds, precedence and the shadowing traps](#4-rule-kinds-precedence-and-the-shadowing-traps)
5. [Effective dating](#5-effective-dating)
6. [`pack_lint`](#6-pack_lint)
7. [Authoring routes: direct vs the frozen generator](#7-authoring-routes-direct-vs-the-frozen-generator)
8. [Deterministic lane vs AI lane, and prompt-from-pack](#8-deterministic-lane-vs-ai-lane-and-prompt-from-pack)
9. [Pinning, snapshot keying and the golden corpus](#9-pinning-snapshot-keying-and-the-golden-corpus)
10. [N7 — the acceptance gate](#10-n7--the-acceptance-gate)
11. [Checklist](#11-checklist)
12. [Known sharp edges](#12-known-sharp-edges)

---

## 1. What a pack is

A **jurisdiction data pack** is a directory of YAML. No code. It answers
four questions about one country's accounting rules for one span of time:

| Question | File |
|---|---|
| Who am I and when do I apply? | `pack.yaml` |
| Which statement line does account code *X* belong to? | `classification.yaml` |
| What lines exist, and how do they nest? | `statement_map.yaml` |
| Which engine checks run, with what parameters? | `checks.yaml` |
| What may the auto-reconciler do, and what does it call the adjustment? | `reconcile.yaml` |

Packs live under `packs/` and are found by **discovery**: anything under
`packs/` holding a `pack.yaml` is a pack. That directory tree *is* the
registry of jurisdictions. There is no list of jurisdictions in engine
code, and adding one to engine code is the specific mistake N7 exists to
catch.

Today the tree holds:

```
packs/
  ro/omfp1802-v1/          Romania — OMFP 1802/2014 (deterministic lane)
  hu/actc2000-v1/          Hungary — Act C of 2000 (AI lane)
  intl/ifrs-captions-v1/   the GENERIC pack — IFRS captions, no code rules
  test/zz-minimal-v1/      ZZ — a FICTIONAL jurisdiction; the N7 payload
                           and the worked example this document uses
```

A pack becomes a `CompiledPack` at load time: validated, deep-frozen,
indexed (exact lookup O(1), longest-prefix walk, ranges scanned in
declaration order) and **content-addressed** by `pack_hash` — a sha256
over the pack's normalised content. Formatting, comments and directory
path do not affect the hash; any semantic edit does. That hash is what
pins stored data to the exact rules that produced it ([§9](#9-pinning-snapshot-keying-and-the-golden-corpus)).

**What a pack is NOT:** it is not a plugin. It cannot supply code, cannot
name engine functions that do not exist, and cannot change the shape of
the output. Its only escape hatch is `checks.yaml`'s `impl:` field, which
may reference an id already registered in
`engine.packs.schema.CHECK_IMPLS` and nothing else.

---

## 2. The ten-minute version

Prerequisites: a Python venv with the project installed (`.venv/bin/python`
resolves `import engine`), run from the repo root.

**Step 1 — copy the worked example.** ZZ is the smallest complete pack in
the tree and exercises every rule kind:

```bash
mkdir -p packs/qq
cp -r packs/test/zz-minimal-v1 packs/qq/example-v1
rm packs/qq/example-v1/README.md
```

**Step 2 — set the identity.** Edit `packs/qq/example-v1/pack.yaml` and
change three fields plus the provenance prose:

```yaml
jurisdiction: QQ          # ISO 3166-1 alpha-2, upper case
pack_id: example          # stable lineage id; NEVER changes between versions
version: v1               # changes per version; the directory should match
```

Also replace `legal_sources` (at least one citation — the instrument your
rules come from) and `changelog` (at least one entry: version, ISO date,
notes). Both are required and both are non-empty lists.

**Step 3 — write the rules.** `classification.yaml` and
`statement_map.yaml` are the real work; [§3](#3-pack-anatomy-file-by-file)
walks them line by line. `checks.yaml` and `reconcile.yaml` can normally
stay as copied — they carry jurisdiction-neutral engine constants.

**Step 4 — lint until clean.** Zero findings, warnings included:

```bash
.venv/bin/python scripts/pack_lint.py packs/qq/example-v1
.venv/bin/python scripts/pack_lint.py --root packs      # cross-pack tiling too
```

**Step 5 — confirm discovery admits it.** No engine edit should be needed
for this to print your pack:

```bash
.venv/bin/python -c "
from engine.packs.runtime import active_pack
p = active_pack('QQ')
print(p.identity.pack_id, p.identity.version, p.pack_hash[:12], len(p.rules), 'rules')
"
```

`NoPackFoundError` here means discovery did not see the directory —
check that `pack.yaml` exists and that `jurisdiction:` is what you passed.

**Step 6 — check the resolver can reach it.** A jurisdiction nobody can
select is not admitted:

```bash
.venv/bin/python -c "
from engine.ai_lane import jurisdiction_resolver as jr
print(jr.selectable_jurisdictions())
print(jr.resolve({}, b'', 'QQ'))
"
```

**Step 7 — run the gate.** Copy `tests/engine/test_new_jurisdiction.py`'s
scenario for your jurisdiction, or at minimum keep N7 green:

```bash
.venv/bin/python -m pytest tests/engine/test_new_jurisdiction.py -q
```

**Step 8 — throw it away** if this was a scaffolding exercise:

```bash
rm -rf packs/qq
```

> Do not leave a half-finished pack under `packs/`. Discovery loads
> **every** pack at engine boot, and a pack that fails validation raises
> rather than being skipped — a broken pack takes the engine down, on
> purpose. `packs/` is production data.

---

## 3. Pack anatomy, file by file

All five files are **required**. The worked example throughout is
`packs/test/zz-minimal-v1/` (jurisdiction ZZ — fictional; see its
`README.md`).

### 3.1 `pack.yaml` — identity and the effective window

```yaml
schema_version: pack1
jurisdiction: ZZ
pack_id: zz-minimal
version: v1
effective_from: 2001-01-01
effective_to: null
legal_sources:
  - citation: "Zzedonia Accounting Act No. 1 of 2001, Annex 2 — FICTIONAL..."
changelog:
  - version: v1
    date: "2026-08-20"
    notes: "Initial ZZ pack — the N7 acceptance-gate jurisdiction..."
```

| field | rules |
|---|---|
| `schema_version` | must be exactly `pack1`. A foreign value is refused rather than parsed leniently — bump the loader instead. |
| `jurisdiction` | the code every caller uses. Matching is case-insensitive but write it upper case. |
| `pack_id` | the **lineage** id. All versions of the same body of rules share it; effective-window tiling ([§5](#5-effective-dating)) is analysed per `(jurisdiction, pack_id)`. |
| `version` | free-form (`v1`, `v2`, …). Keep the directory name in step with it. |
| `effective_from` / `effective_to` | ISO dates bounding the **half-open** window `[from, to)`. `effective_to: null` = open-ended. `to` must be strictly after `from`. |
| `legal_sources` | non-empty list. Either a bare citation string or `{citation, url}`. This is what makes a rule defensible to an auditor — cite the actual instrument. |
| `changelog` | non-empty list of `{version, date, notes}`. Say *what changed and why*; the notes are the only narrative a future maintainer gets. |

Any other key is an `unknown-field` error. Nothing here is optional.

### 3.2 `classification.yaml` — the rules

```yaml
rules:
  - rule_id: "zz.100"          # unique within the pack; stable across versions
    exact: "100"               # exactly ONE of exact | prefix | range
    line_id: share_capital     # must be a LEAF in statement_map.yaml
    description: "Registered capital (Act No. 1/2001 Annex 2, account 100)"

  - rule_id: "zz.28x"
    prefix: "28"
    line_id: accumulated_depreciation_ppe
    contra: true               # this line SUBTRACTS from its section

  - rule_id: "zz.51x"
    prefix: "51"
    line_id: cash_operating
    side_flip:                 # balance-side-conditional re-route
      side: credit
      line_id: st_debt_bank

  - rule_id: "zz.expenses"
    range: { from: "60", to: "64" }
    line_id: other_operating_expenses
```

Per-rule fields: `rule_id`, `line_id`, exactly one of
`exact`/`prefix`/`range`, and optionally `contra`, `side_flip`,
`description`. Anything else is `unknown-field`.

**`contra: true`** marks a line whose value subtracts from its section —
accumulated depreciation, allowances, discounts. On a closing-balance
lane the account's balance already sits on the side opposite its
section's natural side, so it arrives negative and the arithmetic works
out whether or not you set the flag; the flag is what carries the
semantics to consumers and to lanes that see an unsigned **magnitude**
instead of a debit/credit pair. **Set it.** A contra rule never
side-flips: its negative value *is* the intended subtraction.

**`side_flip: {side, line_id}`** handles bifunctional accounts. When the
account's *effective closing side* equals `side`, the amount belongs on
`line_id` instead of the rule's own target. The canonical case: a bank
account (`cash_operating`, an asset) whose closing balance is on the
**credit** side is an overdraft — real short-term debt, not negative
cash. `side` is `debit` or `credit`; `line_id` must also be a leaf.

> **Effective closing side** is computed in exact integer minor units by
> `engine.passes.classify.effective_closing_side`: the closing pair when
> the document has one, otherwise `(opening + period) debit − credit` over
> whichever slots are present. Exactly zero ⇒ side `None` ⇒ no flip
> (a zero balance carries no value and no signal).

**`description`** renders verbatim into the LLM prompt for AI-lane
jurisdictions ([§8](#8-deterministic-lane-vs-ai-lane-and-prompt-from-pack)),
so write it as a sentence a reader — human or model — can act on.

**Optional `prompt_guidance` section** (same file, alongside `rules`) —
only for jurisdictions classified by the AI lane:

```yaml
prompt_guidance:
  header: "<prose the prompt opens with — REQUIRED when the section exists>"
  class_map:                       # optional; non-empty when present
    - digit: "1"
      name: "<native name of the account class>"
      guidance: "<what lives there and where it routes>"
  footer: "<optional closing prose>"
```

`digit` must be a digit string and unique across entries. Absent keys stay
absent (they are not defaulted), because the section feeds `pack_hash`
and therefore the prompt version.

### 3.3 `statement_map.yaml` — the line vocabulary

```yaml
statements:
  balance_sheet:
    - id: non_current_assets            # top-level = a canonical SECTION id
      label: "Non-current assets"
      children:
        - id: ppe_buildings             # leaf = a classification target
          label: "Buildings"
        - id: accumulated_depreciation_ppe
          label: "Accumulated depreciation (PPE)"
    ...
    - id: excluded                      # NOT a section — see below
      label: "Excluded from statements — control / technical / memo accounts"
      children:
        - id: excluded_control
          label: "control/technical/memo account, keep OUT of the statement"
  profit_loss:
    - id: pl_revenue
      label: "Revenue"
      children:
        - id: revenue_products
          label: "Revenue — finished products"
```

Both `balance_sheet` and `profit_loss` are required lists. Node ids must
be unique across the **whole** map (`duplicate-line-id`). Leaves (nodes
with no children) are the only legal classification targets; pointing a
rule at a parent is `non-leaf-target`, and pointing it at an id that does
not exist is `dangling-line-id`.

**Two constraints the pack schema does not enforce but the engine needs:**

1. **Top-level balance-sheet ids must be canonical section ids.** The
   vocabulary, in presentation order:
   `non_current_assets`, `current_assets`, `prepaid_expenses`, `equity`,
   `provisions`, `non_current_liabilities`, `current_liabilities`,
   `deferred_income`. The first three are **asset-natural** (debit
   positive); every other section is credit-positive. A pack never
   declares that — leaf side is engine placement logic, not jurisdiction
   data.

2. **Leaf ids must be canonical bucket names.** The canonical builder
   places a leaf by looking it up in `engine.canonical.schema_v1`; invent
   your own leaf name and the builder silently drops it from the
   statement. List the available names with:

   ```bash
   .venv/bin/python -c "
   from engine.canonical import BS_BUCKETS, PL_BUCKETS
   for b in BS_BUCKETS: print('BS', b.canonical_name, b.bucket_type, b.parent_aggregate)
   for b in PL_BUCKETS: print('PL', b.canonical_name, b.bucket_type, b.parent_aggregate)
   "
   ```

   `packs/hu/actc2000-v1/statement_map.yaml` carries the *full* canonical
   vocabulary and is the best copy-paste source. ZZ's map is deliberately
   minimal (only the leaves it routes to) to keep the example readable;
   for a real jurisdiction prefer the full vocabulary so that adding a
   rule later does not also need a statement-map edit.

**The `excluded` branch** is a top-level node that is *not* a section.
Accounts routed into it (control accounts, closing/opening technical
accounts, off-balance memo accounts) leave both the statement and the
balance judgment. They must **self-balance in the source**, or the
source's own debit/credit totals stop agreeing with the statement's.

**Two equity leaves are special:** `current_year_profit` and
`current_year_loss`. The profit-and-loss result nets into one of them, so
declare both — you cannot know the sign in advance.

### 3.4 `checks.yaml` — binding engine checks

```yaml
checks:
  - check_id: D3_CONTRA_MISPLACED
    impl: builtin.bs_diagnosis
    params:
      contra_prefixes: ["28"]
      asset_section_ids: ["non_current_assets", "current_assets", "prepaid_expenses"]
  - check_id: D9_UNMAPPED_INCLUDED        # builder-emitted: no impl
    params: { emit_regardless_of_status: true }
  - check_id: reconciliation_identities
    impl: builtin.reconciliation_identities
    params: { ron_tolerance: 1.0, pct_tolerance: 0.00001 }
```

Fields: `check_id`, optional `enabled` (default true), optional `impl`,
optional `params` (any JSON-shaped mapping).

**The registry gate.** `impl` may only name an id present in
`engine.packs.schema.CHECK_IMPLS` at load time; anything else is
`unknown-check-impl` and the pack refuses to load. Registered today:

```
builtin.bs_diagnosis                 the canonical_bs v2 D0-D8 diagnosis pass
builtin.reconciliation_identities    debits=credits, A=L+E, P&L rollups
```

**The declarative vocabulary.** `D0_ANCHOR_DIVERGENCE` … `D9_UNMAPPED_INCLUDED`
(see `docs/CANONICAL_BS_V2_CONTRACT.md`) may be configured with **no**
`impl`. Any other `check_id` **must** carry one, or it is
`unknown-check-id`. That is the whole extension story: a pack configures
and parameterises engine checks; it never introduces behavior.

Most `params` values are jurisdiction-neutral engine constants — copy them
from an existing pack unless you have a documented reason to differ. The
ones that genuinely are yours are the code families: `contra_prefixes`
(D3) and `bifunctional_prefixes` (D4) should name **your** chart's
contra and side-flipping families.

### 3.5 `reconcile.yaml` — auto-reconcile policy

```yaml
threshold: 0.001
placement_rules:
  - cause: class_67_target_delta_positive
    placement: pl_other_income
  - cause: class_67_target_delta_negative
    placement: pl_other_expense
  - cause: default
    placement: bs
adjustment_labels:
  en: "Reconciliation difference"
```

- `threshold` — a number in `(0, 1]`. The automatic stage may only act
  while `|difference| / max(assets, equity+liabilities) <= threshold`.
  The contract value is `0.001` (0.1%). Above it, nothing is adjusted and
  the period is served honestly with its diagnosis.
- `placement_rules` — `cause -> placement`, where `placement` is one of
  `bs`, `pl_other_income`, `pl_other_expense`. A `default` cause is
  **required** (`missing-default-placement`); causes must be unique.
- `adjustment_labels` — non-empty `{language: label}`. Lookup falls back
  to the first language by sorted key, so a single entry is valid.

### 3.6 `confirmed_mappings.yaml` — optional overlay

Not generated, not version-controlled by a generator, absent by default.
It memoises **human-confirmed** account-code → line mappings and is
compiled into the **highest-precedence** exact rules (`rule_id`
`confirmed.<code>`, appended after the base rules so they win). It is
covered by `pack_hash` like everything else: adding one confirmation
re-versions the pack content, and for AI-lane jurisdictions that
invalidates the classify cache ([§8](#8-deterministic-lane-vs-ai-lane-and-prompt-from-pack)).

---

## 4. Rule kinds, precedence and the shadowing traps

### The three kinds

| kind | matches when | example |
|---|---|---|
| `exact` | `code == exact` | `exact: "100"` matches only `100` |
| `prefix` | `code.startswith(prefix)` | `prefix: "28"` matches `28`, `281`, `2813`, `28104` |
| `range` | the code's **first L digits**, read as an integer, fall in `[from, to]` — where `L` is the (equal) length of both bounds | `range: {from: "60", to: "64"}` matches `600`, `6412`, `64999`; not `65`, not `6` |

Both range bounds must be digit strings of the **same length**
(`bad-range` otherwise) and `from <= to`. A range is a contiguous band of
prefixes, nothing more.

### Precedence is fixed by the engine

```
exact   >   longest prefix   >   range (declaration order among ranges)
```

Declaration order in the file does **not** decide anything except among
overlapping ranges. In ZZ, code `100` is claimed by both `exact: "100"`
and `prefix: "10"`; the exact rule wins. Code `109` falls through to the
prefix rule. Code `650` matches nothing at all and comes out
**unclassified** — never guessed.

Unclassified is a first-class outcome, not a failure: the classify pass
marks the atom `method="unclassified"` with `line_id=None`, and the
canonical builder keeps its balance in the totals through explicit
`unclassified_debit` / `unclassified_credit` rows plus a `D9` diagnosis
entry. Value is never silently dropped. But an unclassified account in
*your* corpus means your pack has a hole — find it with coverage mode
([§6](#6-pack_lint)).

### The traps `pack_lint` catches

| finding | severity | what it means |
|---|---|---|
| `rule-shadowed-exact` / `-prefix` / `-range` | **error** (refuses to load) | two rules claim the same exact code / the same prefix / the same band. The later one can never win. |
| `range-shadowed-by-prefix` | **error** | a range's entire band lies under one prefix rule. Since prefix outranks range, the range is dead data. Classic case: a `3` catchall prefix plus a `391..398` band. |
| `range-overlap` | warning | two ranges of the same bound length intersect; declaration order silently decides the overlap. Legal, but usually a mistake. |
| `redundant-exact` | warning | an exact rule whose code a prefix rule already routes to the **same** line with the same `contra` and `side_flip`. It adds nothing. (Different target ⇒ not redundant — that is the intentional override, as with ZZ's `100`.) |
| `dangling-line-id` / `non-leaf-target` | **error** | the rule points at a line that does not exist, or at a subtotal. |
| `duplicate-rule-id` | **error** | `rule_id` must be unique within the pack. |

**Zero findings, warnings included, is the bar.** Both warnings above
describe rules whose author believed they were classifying something.

---

## 5. Effective dating

Every pack declares a half-open window `[effective_from, effective_to)`.
Resolution comes in two flavours:

```python
from engine.packs.runtime import active_pack

active_pack("ZZ")                            # the LATEST window
active_pack("ZZ", period_end="2024-06-30")   # the window containing that date
```

`active_pack(jur)` with no date picks the greatest `effective_from`
(version string as the deterministic tiebreak). It is deliberately
date-free: a `today()`-based resolve would be a determinism hazard.

Failures are typed and loud: `NoPackFoundError` when no window contains
the date (the message lists the known windows), `AmbiguousPackError` when
more than one does. There is no fallback table. The engine must not boot
half-classified.

### Why a 2024 document classifies under its 2024 pack **forever**

Because a statement is a claim about what the rules were *at the time*.
If the 2025 chart of accounts moves an account from one caption to
another and you re-serve a 2024 period under the 2025 pack, you have
silently restated a filed year. So:

- **A pack version is immutable once shipped.** Changing the rules means
  a **new version with its own window**, never an in-place edit of the
  old one. For the ported RO/HU/INTL packs, `scripts/port_*_pack.py
  --check` enforces that v1's bytes never change ([§7](#7-authoring-routes-direct-vs-the-frozen-generator)).
- **Windows must tile exactly** within a `(jurisdiction, pack_id)`
  lineage. Sorted by `effective_from`, consecutive windows must meet with
  no hole and no overlap: a hole is `effective-gap` (periods in it resolve
  to nothing), an intersection is `effective-overlap` (resolution would be
  ambiguous). Both are lint errors. Closing an open-ended window is
  therefore part of shipping its successor: set the old pack's
  `effective_to` to the new pack's `effective_from`.
- **Stored periods are pinned by content, not by date.** Every envelope
  records the `pack_hash` it was built under, and the serve path never
  re-resolves a pack — see [§9](#9-pinning-snapshot-keying-and-the-golden-corpus).

Worked example — Romania gaining a 2026 chart:

```
packs/ro/omfp1802-v1/pack.yaml     effective_from: 2015-01-01
                                   effective_to:   2026-01-01   # was null
packs/ro/omfp1802-v2/pack.yaml     effective_from: 2026-01-01
                                   effective_to:   null
```

Same `pack_id` (`omfp1802`) because it is the same lineage; new `version`;
windows tile at `2026-01-01`.

---

## 6. `pack_lint`

```bash
# one pack
.venv/bin/python scripts/pack_lint.py packs/test/zz-minimal-v1

# every pack under a root, plus the cross-pack effective-range analysis
.venv/bin/python scripts/pack_lint.py --root packs

# machine-readable
.venv/bin/python scripts/pack_lint.py --root packs --json
```

Exit codes: `0` clean (warnings permitted by the tool — **not** by this
document), `1` error findings or unmatched coverage codes, `2` usage or
internal error.

Four layers run: schema validation (everything `load_pack` checks,
reported as findings instead of raised), the per-pack shadowing analyses,
the cross-pack effective-range tiling, and — opt-in — coverage.

### Coverage mode

Coverage answers "does my pack actually classify the account codes that
appear in real documents from this jurisdiction?"

```bash
.venv/bin/python scripts/pack_lint.py packs/test/zz-minimal-v1 \
  --coverage corpus/<your-case>/expected/classification.json
```

Accepted inputs:

- a corpus `expected/classification.json` (reads `accounts[].code`),
- a corpus `expected/extraction.json` (reads `rows[].cont`),
- any JSON with either shape,
- a plain text/CSV file with one account code per line (`#` comments allowed).

Output is `matched/total`, a percentage, and **every unmatched code**.
Any unmatched code makes the run exit `1`. Point it at your own
jurisdiction's corpus case — running RO codes against a ZZ pack reports
the whole RO chart as unmatched, which is true and useless.

---

## 7. Authoring routes: direct vs the frozen generator

There are two ways a pack comes into existence, and they are not
interchangeable.

### Direct authoring — the normal case

You are writing rules for a jurisdiction the engine has never handled.
Write the YAML by hand. ZZ (`packs/test/zz-minimal-v1/`) is hand-authored
precisely so it reads as data rather than as generator output, and it is
the file set this document quotes throughout.

### The frozen-generator pattern — porting rules that already exist in code

RO and HU/INTL got their packs by **mechanical port** from in-code rule
tables that were already in production. Those packs carry a
`# GENERATED by scripts/port_*_pack.py — DO NOT EDIT BY HAND` header, and
the generator script keeps a **frozen snapshot** of the pre-cutover tables:

```bash
.venv/bin/python scripts/port_ro_pack.py            # (re)write packs/ro/omfp1802-v1/
.venv/bin/python scripts/port_ro_pack.py --check    # drift alarm — must stay clean
.venv/bin/python scripts/port_hu_pack.py --check
```

The `--check` invocation regenerates into memory and byte-compares
against the checked-in pack. It is a **CI gate**: the pack and the frozen
historical tables must never diverge, which is what makes "we moved the
rules to data without changing behavior" a provable statement instead of
a hope.

Use this pattern when — and only when — you are moving *existing*
behavior into a pack:

1. Write the generator with the old tables frozen inside it as literal data.
2. Generate the pack.
3. Prove equivalence before cutting over (`scripts/shadow_report.py --all`
   compares the production composition against the pack lane on every
   corpus case and must report zero divergence).
4. Cut the runtime over to the pack, delete the in-code tables, and leave
   `--check` behind as the permanent drift alarm.

If you are authoring a brand-new jurisdiction, **do not** invent a
generator. There is nothing to freeze, and a generated-looking pack with
no generator is a maintenance trap.

---

## 8. Deterministic lane vs AI lane, and prompt-from-pack

Two lanes consume a pack, and which one your jurisdiction uses decides
how much of the pack matters.

**Deterministic lane** — the document is a machine-readable trial balance
with real account codes. A front-end parses it into the `LedgerDoc` IR,
and `engine.passes.classify.classify(doc, pack)` applies the pack's rules
directly. `classification.yaml`'s rules are load-bearing; `prompt_guidance`
is unused. This is RO, and it is the ZZ scenario.

**AI lane** — the document is free-form, or the chart uses arbitrary
codes. An LLM does the classification, and the **prompt is rendered from
the pack**: `prompt_guidance.header`, the `class_map` entries, each rule's
`description` (as a "notable accounts" line) and the statement map's leaf
labels (as the offered vocabulary). This is HU and INTL.

### prompt_version derives from pack_hash

For AI-lane jurisdictions the classify prompt's version is **not** a
hand-maintained string:

```python
# engine/ai_lane/config.py
classify_prompt_version_for(pack)  ->  "classify_<jur>@<pack_hash[:12]>"
```

with a small alias table (`_CLASSIFY_PROMPT_VERSION_ALIASES`) keyed by
**`pack_hash`**, holding exactly the two shipped AI-lane v1 packs — HU
`actc2000-v1` and INTL `ifrs-captions-v1` — and mapping them to the frozen
legacy name `classify_v1`, so stored envelopes and the golden corpus stay
byte-stable across the cutover. **Your new pack is not in that table and
never should be**: it always gets the derived `classify_<jur>@<hash>` form,
which is the correct behavior for rules that have no pre-cutover history.
Consequences you must internalise:

- **Any semantic pack edit re-versions the prompt** — a rule, a
  `prompt_guidance` word, a statement-map label, one
  `confirmed_mappings.yaml` entry. There is no bump to forget.
- **A re-versioned prompt misses the AI cache.** The persisted envelope
  *is* the cache, keyed by content hash + prompt versions + model id. A
  pack edit therefore forces re-extraction on the next scan, which is the
  correct behavior and also means pack edits are not free.
- Reformat the YAML all you like: the hash is over normalised content, so
  comments and whitespace do not move it.

### Do you need a front-end?

Only if your documents arrive in a **layout** nothing parses yet.
Front-ends are registered in `engine/frontends/registry.py`
(`saga_10_col`, `saga_compact_6_col`, `generic_4_col`, `csv`,
`pdf_positional`, `llm_extract`), each exposing
`parse(data: bytes, hints: dict) -> (LedgerDoc, diagnostics)`. Jurisdiction
and currency arrive as **hints** — front-ends carry no jurisdiction
knowledge. ZZ's fixture is a plain 4-column delimited trial balance, so it
needed no new front-end at all. That is the usual case: a new jurisdiction
is a new *chart*, not necessarily a new *file format*.

---

## 9. Pinning, snapshot keying and the golden corpus

### `pack_provenance`

Every assembled envelope records, at the envelope **root**:

```json
"pack_provenance": {
  "jurisdiction": "ZZ",
  "pack": "zz-minimal@v1",
  "pack_hash": "<sha256 of the pack content>",
  "mapping_version": "zz_zz-minimal_pack_v1"
}
```

Additive by design: the *served* `canonical_bs` payload never carries it,
so goldens stay byte-stable. `mapping_version` derives mechanically as
`<jur>_<pack_id>_pack_<version>` — a new jurisdiction needs no entry
anywhere. (RO's v1 keeps a frozen legacy spelling via a small alias table,
purely so pre-existing stored envelopes keep their string.)

### The serve path never re-resolves a pack

Serving is a pure function of the persisted envelope. Deploying a newer
pack cannot re-classify a stored period — only *new* classification work
follows the new pack data. This is what makes [§5](#5-effective-dating)'s
"a 2024 document classifies under its 2024 pack forever" true in practice
and not just in intent.

### Snapshot keying

Reconciliation state carries forward across a re-scan of the same file
only when the snapshot key matches: `content_hash` + `parser_version` +
`mapping_version` **+ `pack_hash`**. A pack content change — even without
a version bump — drops stale reconciliation state, exactly like a parser
version bump does. (An old envelope with no `pack_provenance` at all is a
pre-cutover snapshot and is treated as matching.)

### Golden-corpus expectations for a new jurisdiction

`corpus/` freezes the full offline pipeline (parse → assemble →
auto-reconcile → persist → serve → FactsGateway) for one input file per
case, and `scripts/corpus_replay.py` byte-compares every stage artifact.

**Rule zero: existing cases must replay byte-identically.** Adding a
jurisdiction adds cases; it never changes one. If your change moves a
byte in an RO or HU golden, you changed shared behavior — stop and find
out why.

To contribute a case for your jurisdiction, create
`corpus/<case_id>/` with:

- exactly one `input.<ext>` — **frozen once created** (XLSX containers
  embed save timestamps, so rebuilds are never byte-identical and would
  orphan the goldens),
- `meta.yaml` with `case_id` (equal to the directory name), `jurisdiction`,
  `expected_parser` (the dispatch lane), `period` / `period_end`,
  `anonymized`, `source_notes`, and `expect_ai_never_consulted: true` for
  a deterministic case,
- `expected/` containing `extraction.json`, `classification.json`,
  `statuses.json`, `served_envelope.json`, `gateway_facts.json` — generate
  them with `UPDATE_GOLDEN=1 .venv/bin/python scripts/corpus_replay.py`
  **once**, then read every number before committing. A golden you did not
  read is a bug you have frozen.
- Real data must go through `scripts/anonymize_tb.py`; set
  `anonymized: true` so the replay re-proves the scrambling invariants on
  every run. Synthetic data is fine — say so in `source_notes`.

Corpus cases dispatch through lanes the replay runner knows about, so a
genuinely new lane needs a runner branch. Read `corpus/README.md` before
adding a case.

---

## 10. N7 — the acceptance gate

`tests/engine/test_new_jurisdiction.py`. Every new jurisdiction must
leave it green, and the properties it asserts are the ones your
jurisdiction should be able to claim too:

1. **Discovery admits the pack.** `active_pack("<JUR>")` resolves without
   any engine edit, effective-dated resolution reaches the same pack, and
   the resolved `pack_hash` equals the directory's.
2. **The pack lints clean** — zero findings, warnings included.
3. **The resolver can name it.** `jurisdiction_resolver.selectable_jurisdictions()`
   includes it and an explicit user hint resolves to it. Admission is by
   pack discovery, so this is automatic; if it ever stops being automatic,
   something has reintroduced a hardcoded jurisdiction list.
4. **The full pipeline serves a balanced statement**: front-end parse →
   LedgerDoc IR → `classify` → the pack's bound checks → the canonical
   builder → `stage_persist` (the auto-reconcile seam) →
   `served_canonical_bs` → `FactsGateway`, ending in `status: BALANCED`,
   `difference: 0.0`, and totals that close to the cent.
5. **The rule semantics are observable end to end**: the contra rule's row
   is negative and its section nets down; the side-flip rule flips on the
   named closing side and not the other; excluded accounts stay out of
   every total.
6. **The envelope is pinned** to the pack that classified it.
7. **The change-set lives only under `packs/` and `tests/`** — an explicit
   manifest of every path the scenario introduced, asserted against those
   two roots.
8. **`src/engine` contains no jurisdiction-specific branch** for it — a
   token scan over the engine tree, with an allowlist that is empty on
   purpose.

Properties 7 and 8 are what make the gate permanent rather than
decorative. If you find yourself editing `src/engine` to make your
jurisdiction work, **that is the finding**, not an inconvenience: fix the
mechanism so it reads pack data, and leave the manifest two roots long.

---

## 11. Checklist

- [ ] `packs/<jur>/<pack_id>-<version>/` created with all five required files.
- [ ] `pack.yaml`: correct `jurisdiction` / `pack_id` / `version`, a real
      `legal_sources` citation, a `changelog` entry that says *why*.
- [ ] Effective window set; if it succeeds an existing pack, the previous
      version's `effective_to` closed at exactly your `effective_from`.
- [ ] Every `line_id` and `side_flip.line_id` is a **leaf** in
      `statement_map.yaml`.
- [ ] Top-level BS node ids are canonical section ids; leaf ids are
      canonical bucket names.
- [ ] `current_year_profit` **and** `current_year_loss` declared under `equity`.
- [ ] Contra families carry `contra: true`; bifunctional families carry
      `side_flip`.
- [ ] `checks.yaml` references only registered `impl` ids; D3/D4 `params`
      name **your** chart's contra / bifunctional prefixes.
- [ ] `reconcile.yaml` has a `default` placement and at least one label.
- [ ] `scripts/pack_lint.py --root packs` → **zero** findings, warnings included.
- [ ] Coverage run against a real document from the jurisdiction → zero
      unmatched codes (or every one of them understood and written down).
- [ ] `active_pack("<JUR>")` resolves; the resolver lists it in
      `selectable_jurisdictions()`.
- [ ] Full battery green, corpus **byte-identical**:
      `pytest tests/engine`, `scripts/corpus_replay.py`,
      `scripts/verify_determinism.py`, `scripts/measure_bs_drift.py`,
      `scripts/check_import_boundary.py`, `scripts/shadow_report.py --all`,
      `scripts/port_ro_pack.py --check`, `scripts/port_hu_pack.py --check`.
- [ ] N7 green, and its change-set manifest still lists only `packs/` and
      `tests/` paths.

---

## 12. Known sharp edges

Honest list of places where the engine still carries assumptions from the
jurisdiction it was born in (Romania). None of them block admitting a
jurisdiction; all of them are worth knowing before you are surprised.

1. **The P&L is assumed to live in account classes 6 and 7.** The source
   anchor's `closing_result` block sums class-6/7 closing balances (plus
   account `121`) to derive the current-year result, and the canonical
   builder treats unmapped `6`/`7` codes as "absorbed in the result" and
   unmapped `8`/`9` codes as off-balance. A jurisdiction whose P&L sits
   elsewhere (Hungary's classes 8/9, for instance) does not get a result
   line from that path and must supply it through the envelope's
   `current_year_profit` / `current_year_loss` leaf, which is what the AI
   lane does. ZZ's fictional chart deliberately uses 6/7.
2. **The canonical builder and the canonical adapter live under
   `engine/country_packs/ro_romania/`** despite being the one shared
   builder both lanes use. Read the module name as historical, not as a
   scope statement.
3. **`canonical_bs.mapping_version` is stamped from the RO constant** for
   every jurisdiction; the jurisdiction-correct vintage is the one on
   `pack_provenance.mapping_version` at the envelope root. Read the
   provenance stamp, not the inner field.
4. **`derive_legacy(doc)`** (the IR → legacy-structures bridge) also runs
   the RO assemble-shape on its way to producing the source anchor. It is
   harmless for a non-RO document — you use the anchor and ignore the
   shape — but it is not jurisdiction-neutral yet.
5. **There is no assembler pass yet.** The compiler restructure has
   front-ends and a classify pass; assembly still lives inside
   `RomaniaPack` (deterministic, RO-specific) and inside the AI lane's
   `build_ai_envelope` (which stamps `method="llm"` and therefore can
   never report `BALANCED`). A new deterministic jurisdiction currently
   supplies the ~40 lines that turn a classification layer into canonical
   leaves; N7's `_assemble_zz` is that code, written pack-data-driven so
   it is a template rather than a special case.
6. **The AI lane's classify stage picks its pack by name**:
   `engine.ai_lane.config.classify_pack` maps `HU` to the HU pack and
   *everything else* to the generic INTL pack. A new AI-lane jurisdiction
   with its own pack would still be classified against INTL until that
   lookup becomes pack-driven. Deterministic-lane jurisdictions are
   unaffected.
7. **`packs/` is production data.** Everything under it ships in the
   backend image and is loaded at boot. That includes
   `packs/test/zz-minimal-v1/`, which is why any surface offering "every
   jurisdiction with a pack" will offer ZZ. ZZ classifies nothing unless a
   caller explicitly names it.
