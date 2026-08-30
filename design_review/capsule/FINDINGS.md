# THE CAPSULE — WHAT MEASURING THE SHIPPED SURFACE FOUND

> Four defects, all found by driving the real surface against a real
> trial balance, none of them visible from the unit gates that were
> green when this pack started. Each carries a reproduction someone else
> can run.
>
> **None of them is fixed here.** The frontend is read-only for this
> lane and `_capsule_tools.py` belongs to another. Root cause and the
> shape of the fix are given so the owning lane does not have to
> re-derive them.
>
> Code state under measurement: `MEASURED_TREE.md`.

---

## F1 · The engine's whole tool layer returns 422 — every call, every tool

**Severity: high.** It makes Tier 1 impossible and makes the model spend
money to say it has nothing.

### Reproduce

Against the live local engine, not a sidecar:

```
$ curl -sS -X POST http://127.0.0.1:8000/api/capsule/tools/get_facts \
    -H "Authorization: Bearer <any>" -H "content-type: application/json" \
    -d '{"args":{"metric":"revenue"}}'

{"detail":[{"type":"missing","loc":["query","body"],"msg":"Field required","input":null}]}
HTTP 422
```

Note `"loc": ["query", "body"]`. FastAPI is looking for `body` as a
**query parameter**.

### Root cause

`src/engine/api/_capsule_tools.py:80` carries `from __future__ import
annotations`, so every annotation in the module is a **string**.
`build_router()` then defines its body model inside the factory's
closure:

```python
def build_router():
    class ToolCall(BaseModel):          # ← closure-local, line ~1650
        args: Dict[str, Any] = Field(default_factory=dict)
        period: Optional[str] = None
    ...
    @router.post("/tools/{tool_name}")
    def call_tool(tool_name: str, body: ToolCall, ...):
```

FastAPI resolves the annotation `"ToolCall"` against the function's
**module** globals. `ToolCall` is not there — it only exists inside the
factory call. Unable to see a Pydantic model, FastAPI falls back to
treating `body` as a scalar query parameter, and every well-formed
request fails validation before the handler runs.

Minimal reproduction — both halves are necessary, neither alone is enough:

```python
# WITHOUT `from __future__ import annotations`  -> 200
# WITH it, same code                            -> 422 loc=["query","body"]
from __future__ import annotations
def build():
    from pydantic import BaseModel, Field
    class ToolCall(BaseModel):
        args: Dict[str, Any] = Field(default_factory=dict)
    r = APIRouter(prefix="/x")
    @r.post("/t/{name}")
    def call(name: str, body: ToolCall) -> Dict[str, Any]:
        return {"ok": True, "args": body.args}
    return r
```

Verified on this tree: fastapi 0.128.8, pydantic 2.13.3.

### Proof that only the binding is broken

The sidecar can be started with `--repair-tool-body`, which puts an
equivalent `ToolCall` into the module namespace before `build_router()`
runs — and touches nothing else, no `_context`, no `dispatch`, no tool.

| Sidecar | `POST /api/capsule/tools/get_facts` |
|---|---|
| `:8010` as shipped | `422` |
| `:8011` binding repaired | **`200`** — `revenue 48,349,081.59 RON`, with `snapshot_id: sha256-d9a520ba…` |

The tool layer is correct. Only FastAPI's view of the signature is wrong.

### What it costs on the surface

Measured end-to-end, asking *"what if revenue drops 10 percent for us"*:

```
retrieval trace:   Reading revenue · Dec 2025      unavailable
fact card:         not rendered
model seams hit:   /api/capsule/tools/get_facts  (422)
                   functions/v1/chat-llm          (200 — billed)
```

And the answer the reader is shown, for *"why is cash down this month"*:

> *"No cash figures were retrieved for this question, so I can't point to
> what drove the movement this month."*

The cash figure is on the dashboard behind the overlay — `1.3 M RON`.
The model was paid to say the product could not find it.

### Second instance of a known class

The root `CLAUDE.md` already records this exact failure once: a Pydantic
model nested in a route-factory closure broke `/openapi.json`, and
`ContactSalesRequest` was left as a live second instance. This is a
third. It suggests a gate rather than a third one-off fix: assert every
mounted POST route with a body parameter resolves that parameter to a
`requestBody` in the OpenAPI schema. (`/openapi.json` currently 500s on
this tree, which is itself the same class — so the gate has to build the
schema per-router, not fetch it.)

---

## F2 · Every provenance jump lands on the P&L tab

**Severity: high.** It is the trust affordance of the whole surface, and
it silently goes to the wrong statement.

### Reproduce

Ask *"what are our total assets"*, click the provenance dot.

```
dot:   data-traceable-source-statement="bs"
       data-traceable-source-bucket="totalAssets"
url:   /dashboard?period=…&tab=bs&highlight=totalAssets
lands: "P&L — Scandia Food SRL — 2025-12-31 (RON)"
row:   [data-traceable-target="totalAssets"]  … absent
url still carries ?highlight=   (the hook gave up, silently)
```

### Root cause

`frontend/components/instrument/shell/CommandPalette.tsx:543`:

```ts
next.set("tab", source.statement === "pl" ? "pnl" : source.statement);
```

emits `bs` / `pnl` / `cf`. `frontend/lib/financialStatementTabs.ts`
`TAB_SPECS` defines the ids `pl`, `balance_sheet`, `cash_flow`, `ratios`,
`valuation`, `risks`, `export`. None of the three emitted values is in
`TAB_SPECS` or in `LEGACY_TAB_MAP`, so `resolveActiveTab()` takes its
`requested = "pl"` default for all three.

Measured directly, one page load per value:

| `?tab=` | lands on | `totalAssets` row |
|---|---|---|
| `bs` (emitted) | **P&L** | absent |
| `balance_sheet` (real id) | Balance Sheet | **present — `TOTAL ASSETS 52.764.717,79`** |
| `cf` (emitted) | **P&L** | absent |
| `cash_flow` (real id) | Cash Flow | n/a |
| `pnl` (emitted) | P&L | n/a |
| `pl` (real id) | P&L | n/a |

So a **P&L** number's dot works by accident — the fallback happens to be
P&L. A **Balance Sheet** or **Cash Flow** number's dot is silently wrong.

### Why nobody noticed

`useHighlightFromUrl` is deliberately quiet: *"Silent give-up after 1s:
row genuinely doesn't exist on this page. We do NOT alert the user — the
most likely cause is a stale shared link, and a missing pulse is
preferable to a dismissable error toast."* That is the right call for a
stale link, and it is exactly what makes this invisible. Nothing logs,
nothing warns, and the reader lands on a real page with real numbers —
just not the ones they asked about.

### Fix shape

```ts
const TAB_FOR: Record<Statement, TabId> =
  { pl: "pl", bs: "balance_sheet", cf: "cash_flow" };
next.set("tab", TAB_FOR[source.statement]);
```

And a gate: every `Statement` in the traceable taxonomy must map to a
member of `TAB_SPECS`. The two vocabularies live in files that do not
import each other, which is how they drifted apart in the first place.

---

## F3 · Every level percentage is rendered by a delta formatter

**Severity: medium** — it changes what a correct number means.

The Capsule's own answers, measured on this surface:

| Question | On screen | Should read |
|---|---|---|
| what is the equity ratio | `+14.7%` | `14.7%` |
| what is the EBITDA margin | `+10.9%` | `10.9%` |
| what is the net margin | `+0.4%` | `0.4%` |

`CapsuleFigures.tsx` `FigureValue` routes any `unit === "percent"` fact
to `<Amount kind="percent">`. `Amount.tsx:174` sends `kind === "percent"`
to `formatPercentDelta` (`frontend/lib/amountFormat.ts:140`), which is a
**delta** formatter — it unconditionally prefixes `+` or `−`:

```ts
const exact = `${pct >= 0 ? "+" : "−"}${nf(locale, digits, digits).format(Math.abs(pct))}%`;
```

`+0.4%` on a net margin reads as *"net margin improved by 0.4 points"*.
It means *"0.4% of revenue was profit."* On this company, whose credit
class is CC and whose DSCR is 0.99×, a spurious `+` in front of every
ratio is the wrong direction to be wrong in.

`<Amount>` already distinguishes `multiple` and `count` from `percent`.
The gap is a `percentLevel` kind (or a `signed: false` option on the
existing one) and a call site that chooses between them.

---

## F4 · The fact card waits for the model, though the number arrived first

**Severity: medium** — it is most of the "answers are perceived as slow"
complaint that started this whole line of work.

`CapsuleAnswerPanel.tsx` says, in its own comment:

> *"2 — THE FACT CARD. Before the prose, because it is the answer and the
> prose is the commentary."*

and then gates it on `done`:

```tsx
{done && !turn.degraded && (
  <CapsuleFactCard evidence={evidence} visuals={turn.visuals} onJump={onJump} />
)}
```

`done` means the whole turn finished — **including the model call**. So
"before the prose" is true about the DOM order and false about time:
both appear on the same frame.

Measured on the repaired sidecar, five samples, ms from Enter
(`latency-repaired.json`):

| | p50 | p95 |
|---|---:|---:|
| **Tool response lands — the client HAS the number** | **24.5 ms** | 33.0 ms |
| Fact card painted | **7 317.2 ms** | 7 359.3 ms |
| Model prose painted | 7 317.0 ms | 7 359.2 ms |
| **Held behind the model** | **7 292.7 ms** | |

The card and the prose are **0.2 ms apart in all five samples**, and the
figure they show had been in the client for **seven and a quarter
seconds**. The engine answered the tool call in single-digit
milliseconds; the surface then waited for a model that is only writing
commentary about a number it already had.

A **300× gap between having the answer and showing it.**

Gating the card on the retrieval completing rather than on `done` would
put the number on screen seconds earlier without changing a single value.
The reserved-height skeleton that already sits below it means doing so
costs no layout shift.
