# BEFORE / AFTER — THE EVIDENCE ITSELF

> `BEFORE_AFTER.md` compares the *surface* across this wave. This page
> compares the **evidence**: what the delivery pack was showing before,
> and what it shows now that a real trial balance is behind it.
>
> Same driver, same seven frames, same two themes. The only variable is
> where the numbers came from.
>
> `before-fictional/` ← → `grounded-r2/` · both `--1440--light.png` and
> `--1440--dark.png` · receipts in each folder's `demo-report.json`.

---

## THE ONE-LINE VERSION

The Capsule's answer card looked identical in both. Its **citation
footer** did not, and that is the whole difference between a screenshot
and evidence.

---

## SIDE BY SIDE — THE SAME QUESTION, THE SAME FRAME

Question in both: **"what are our total assets"**. Frame `3-answered`.

| | **BEFORE** — `demo-meridian` | **AFTER** — a real trial balance |
|---|---|---|
| Company | Meridian Industries SRL *(fictional, invented for the pre-upload demo)* | Scandia Food SRL · Dec 2025 |
| Figure, light run | `249.372.520 RON` | `52.764.717,79 RON` |
| Figure, dark run | `236.122.126 RON` | `52.764.717,79 RON` |
| Citation — period | **"No period in scope"** | **"Period · Dec 2025"** |
| Citation — source file | *absent* | **"Source file · prod_scandia_frozen_31.12.2025.xlsx"** |
| Citation — trust | **"Not verified by the engine"** | **"Balanced"** |
| Header trust chip | "Unverified" | "Verified · extraction drift 0.00%" |
| Independently checkable? | No | **Yes — to the cent** |
| Model seam requests | 0 | 0 |

### Two things to notice in that table

**The before answered a different number in each of the two theme runs.**
`249,372,520` and `236,122,126`, minutes apart, same question, same
sample. The gap is 5.6% — the demo company's own ~6% annual growth — so
the two runs indexed different years of its five-year history. Neither
answer said which. A surface that names no period cannot be caught
answering about the wrong one, and that is exactly what happened.

**The after is checkable by someone who does not trust this pack.**
`52,764,717.79` appears in `corpus/saga_10_col/expected/gateway_facts.json`
as `total_assets_cents: 5276471779`, committed to this repo and
byte-compared by `scripts/corpus_replay.py` on every battery run. The
input file is byte-identical to that case's `input.xlsx`
(sha256 `d9a520ba…`, both verified). The claim does not rest on my
arithmetic, my driver, or my screenshot.

---

## THE STUB THAT WAS REMOVED, AND WHAT IT WAS COVERING

| | Before | After |
|---|---|---|
| `/api/capsule/tools/*` | Fulfilled by `design_shots_capsule.mjs --stub-tools 1` — a literal in the driver | The **real** `_capsule_tools.build_router()` over the real persisted envelope |
| `/api/period/{id}` | Not called — `demo-meridian` resolves through `SAMPLE_DATASETS` | The **real** `pipeline.build_router()` handler, over HTTP |
| Figures shown | `SERIES` in the driver: `revenue: [41372756000, …]` | Whatever the engine computed from 382 real trial-balance rows |

Removing the tool stub, and only that, is what exposed **F1**: `POST
/api/capsule/tools/*` has been returning `422` for every call, so the
Tier-1 fact card cannot paint and the model is billed to answer with no
evidence attached.

**A stub added to get a screenshot had been standing in for a broken
endpoint for as long as the endpoint has been broken.** That is the
sharpest lesson in this pack, and it is the same shape as the incident
that frames the whole wave: an instrument that reported success while
measuring nothing.

---

## THE FRAMES

| Frame | Before (`before-fictional/`) | After (`grounded-r2/`) |
|---|---|---|
| `1-pill` | header pill, fictional workspace | header pill, real period |
| `2-typed` | Tier-0 preview, fictional figure | Tier-0 preview, real figure |
| `3-answered` | figure with **no period, no file, "Not verified"** | figure with **period, file, "Balanced"** |
| `4-dot-hover` | dot present | dot present |
| `5a-landed-SHIPPED` | P&L tab, no target row | P&L tab, no target row — **the same defect, F2** |
| `5b-landed-CORRECTED-URL` | Balance sheet, **still no target row** | Balance sheet, **`TOTAL ASSETS 52.764.717,79`, pulsed** |
| `6-amount` | no `<Amount>` figure with provenance | `+14.7%` through `<Amount>`, `data-provenance="true"` |

Row `5b` is worth its own sentence. On the fictional sample the corrected
URL *also* finds nothing, because the sample's balance sheet renders no
`data-traceable-target` rows at all. So on the pre-existing evidence
surface the provenance jump was broken at **both** ends and neither end
could be told from the other. F2 was findable only once the far end
existed.

---

## WHAT DID NOT CHANGE

* Zero model-seam requests for the whole sequence, both themes, both
  datasets. The Tier-0 spend boundary from `62fba00` holds on real data
  exactly as K10 proves it in jsdom.
* The morph, the overlay geometry, the empty-state budget, and every
  other K-gate: untouched by this lane, and not re-measured here.

---

## THE HONEST GAP IN THIS COMPARISON

The "before" column is the **evidence surface** as it stood, not the
product as it stood at the parent commit. Re-measuring the pre-`62fba00`
product end-to-end needs a checkout or a worktree — a git mutation this
lane is not permitted to make. Where this pack refers to pre-fix
behaviour of the spend boundary it says *inferred from the diff and from
K10's jsdom proof*, and does not present it as measured.
