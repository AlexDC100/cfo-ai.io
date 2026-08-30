# THE CAPSULE — CRAFT GATES G1–G8

**Lane 2, Part F.** Measured 2026-08-30/31 against the live authed
test-mode stack (vite `:5173` + engine `:8000` `PUBLIC_TEST_MODE`),
viewport 1440×900, Chromium.

This lane owns no product code. It owns the proof that the redesigned
surface reads as a conversation, and the proof that every invariant the
old surface kept is still kept by the new one.

Three files hold the gates, each measuring what only it can:

| File | What only it can state |
|---|---|
| `e2e/design/capsule-craft.spec.ts` | geometry, CLS, composited contrast, the wire |
| `frontend/components/instrument/shell/__tests__/capsuleCraft.test.tsx` | attributes on real components; the Enter boundary under a fetch trap |
| `scripts/check_capsule_craft.mjs` | source text, in 200 ms, with no browser — so it can sit in the battery |

---

## 1. THE VERDICT, HONESTLY

**Live spec: 16 passed, 4 failed** — reproduced identically across two full runs (2026-08-31, 4.3 min each). The four reds are real product
findings, stated below with the measured number. Nothing was arranged to
be green.

| Gate | Verdict | Measured |
|---|---|---|
| G0 anchor liveness | **GREEN** | all 7 anchors resolve, closed / open / answered |
| G1 proportion — rest | **GREEN** | 208px (budget 440), **1px** dead space |
| G1 proportion — typing / answering | **GREEN** | 227px / 451px (ceiling 630 = 70vh), 1px dead |
| G2 nothing below the composer | **RED** | `capsule-keys` sits **+25px below** the composer at rest |
| G2 composer y stable ±2px | **RED** | **243px drift** — rest 244, typing 263, answering 487 |
| G3 no hint restates the placeholder | **GREEN** | 5 hints examined, worst overlap 25% |
| G3 no native tooltip on a row | **GREEN** | 5 rows across 3 states, 0 `title` |
| G4 no category column | **GREEN** | 24 rows summoned across 9 states, 0 offenders |
| G5 CLS | **GREEN** | 0 on open, typing, streaming, close |
| G6 contrast (light) | **RED** | `text-ink-soft/70` = **3.07:1**, needs 4.5 |
| G6 contrast (dark) | **RED** | same token = **4.33:1**, needs 4.5 |
| G7 Tier-0 spends nothing at Enter | **GREEN** | 0 seam requests, turn painted, figure present |
| G7 C1 fabricated numerals | **GREEN** | 3 fragments rejected, turn still rendered |
| G7 C3 provenance | **GREEN** | 0 unprovenanced figures, ≥1 provenanced (floor held) |
| G7 C5 missing-data honesty | **GREEN** | absence stated, no zero substituted |
| G7 C2 read-only at the wire | **GREEN** | 1 tool request, POST read, no mutation body |
| G7 C4 navigation never spends | **GREEN** | 0 spend, 12 rows, router p50 21ms / p95 28ms (budget 50) |
| G7 H1 header budget | **GREEN** | exactly 4 controls at 1440 |
| Static F1 no tooltip in source | **GREEN** | 9 row sites scanned |
| Static F2 no category column in source | **RED** | `CommandPalette.tsx` renders `item.hint` on the router row |
| Static F3 strings discipline | **GREEN** | 6 bundles, EN/RO parity, all registered |
| Static F4 footer ≠ placeholder | **GREEN** | 0 rendered hint keys restate it |
| Static F5 spec alive | **GREEN** | 29 anchors, all producible |
| Static vacuity self-probe | **GREEN** | discovery emptied ⇒ gate FAILS, as required |

### The four reds, in full

**R1 — `capsule-keys` is painted below the composer (G2).**
`CommandPalette.tsx`, the key legend `↑↓ move · Tab to ask · esc`, sits
25px under the input at rest. The composer is otherwise correctly at the
bottom (nothing else follows it, and the tab order after it contains only
`capsule-send`, which ships with the input and is therefore permitted).
Moving the legend above the input, or into the composer row itself,
closes this.

**R2 — the composer moves 243px between states (G2).**
rest 244 → typing 263 → answering 487. The panel is top-anchored
(`sm:top-[68px]`) and grows downward, so every change of content moves
the thing the reader types into. G1 and G2 together specify exactly one
solution: **bottom-anchor the panel and let it grow upward.** A
fixed-height panel would hold the composer still but would fail G1's
dead-space clause at rest; a top-anchored variable panel passes G1 and
fails G2. Bottom-anchored + variable height passes both.

This is also the source of the only CLS this surface has ever produced:
under the earlier layout, G5 recorded `0.0025` on streaming with
`capsule-composer-block` named as the shifting node. G5 is green today
because the streaming answer happens to settle before the observer
samples; the anchoring fix removes the cause rather than the symptom.

**R3 — `text-ink-soft/70` fails AA in both themes (G6).**
`frontend/components/instrument/shell/capsuleAnswer/CapsuleFactCard.tsx:129`
(and the same token at `CapsuleTier0Preview.tsx:182`) renders the
citation scope — `· December 2024` — at 10px in `text-ink-soft/70`.
Composited against the glass it measures **3.07:1 in light** and
**4.33:1 in dark**; AA for text under 18.66px is 4.5:1.

The cause is the token, not the glass — which is the whole reason this
gate measures the composited colour rather than eyeballing the panel. A
previous pass on this surface found the same class of defect and
misattributed it to the backdrop. Dropping the `/70` (using the full
`text-ink-soft`) is the fix; the backdrop needs no change.

*Advisory, not gating:* the `·` separators in `CapsuleContextStrip.tsx:87`
measure 2.54:1 (light) / 3.5:1 (dark) at `text-ink-soft/60`. They are
`aria-hidden` and their entire content is separator punctuation, which is
"pure decoration" under WCAG 1.4.3 and therefore exempt. **The exemption
is conditional on the `aria-hidden`**: this gate reports a separator that
is not declared decorative as a gating failure. Declaring it in the
accessibility tree is the price of the exemption.

**R4 — the category column is still renderable (static F2).**
`CommandPalette.tsx` (the router row, ~L1131 — the gate prints the
current line) renders `{item.hint && !item.destination &&
!item.trailing && <span …>{item.hint}</span>}`. No row currently
satisfies that condition, which is why the LIVE G4 is green over 24 rows
— but the capability is one prop away from returning, and `item.hint` is
documented in `CapsuleJumpList.tsx` as "the rail group, usually". The
static gate bans the render site; the live gate bans the observed
behaviour. Both are kept: the live one alone would have gone green today
for the wrong reason.

---

## 2. G8 — EVERY GATE PROVEN CAPABLE OF FAILING

A gate that has never been observed going red is a decoration. Each plant
below was applied, observed RED, reverted, and observed GREEN again. The
exact diff and the exact red output are recorded.

### P3 — THE SEAM REPLANT (the one the brief names)

*Disable the Tier-0 short-circuit at the Enter boundary.*

```diff
--- a/frontend/components/instrument/shell/CommandPalette.tsx
+++ b/frontend/components/instrument/shell/CommandPalette.tsx
@@ enterAnswerMode
-      if (answer.answerLocally(q, resolveTier0(q, factIndex))) {
+      // G8 PLANT P3 — the short-circuit disabled.
+      if (false && answer.answerLocally(q, resolveTier0(q, factIndex))) {
         rememberCapsuleQuestion(orgKey, q);
         return;
       }
       askModel(q);
```

**RED — jsdom** (`capsuleCraft.test.tsx`, 6 failed / 4 passed):

```
→ G7/K10: Enter on "total assets" reached a model seam. Observed:
  http://127.0.0.1:8000/api/capsule/tools/get_facts
  https://cjclenykwlngqvapmisb.supabase.co/functions/v1/chat-llm
The seams that must stay silent: /api/capsule/tools/get_facts (engine tool
endpoint) · functions/v1/chat-llm (Edge Function).
Tier 0 already holds this answer, with provenance, in microseconds — paying
for it is paying twice for a figure the client had.: expected [ …(2) ] to
deeply equal []
```

**RED — live** (`capsule-craft.spec.ts -g "G7/K10"`, 1 failed / 1 passed):

```
Error: G7/K10: pressing Enter on "total assets" reached a model seam:
  POST http://127.0.0.1:8000/api/capsule/tools/get_facts
  POST https://cjclenykwlngqvapmisb.supabase.co/functions/v1/chat-llm
The seams that must stay silent: /api/capsule/tools/get_facts (engine tool
endpoint), functions/v1/chat-llm (Edge Function)
```

Both seams are named, in both harnesses, exactly as required.

**GREEN after revert:** jsdom 10/10; live G7/K10 2/2.

> **A correction this plant forced, worth keeping.** The first draft of
> both gates asserted "a turn painted" BEFORE it read the wire. Under the
> plant the red was `Unable to find [data-testid="capsule-fact-card"]` —
> true (the model path 503s in the trap and paints no card) and *silent
> about money*. A gate whose red does not name the defect gets triaged as
> flake. Both gates now assert SPEND FIRST and the canvas second; the
> canvas assertion still runs, so a zero bought by rendering nothing is
> still caught. The plant is what surfaced this; a gate that has only
> ever been green cannot tell you its red is illegible.

### P1 — the native tooltip returns (G3, static F1)

```diff
--- a/frontend/components/instrument/shell/capsuleEmpty/CapsuleSuggestionList.tsx
+++ b/frontend/components/instrument/shell/capsuleEmpty/CapsuleSuggestionList.tsx
                 // NO `title`. See the header.
+                title={`${question} — ${basis}`}   /* G8 PLANT P1 */
                 aria-label={t("capsuleCraft.suggest.aria", { question, basis })}
```

**RED — jsdom:**
```
→ G3: suggestion rows carry native browser tooltips:
  unattached: title="Aug 2026 has no file yet — what should I upload? — From
              this workspace's period list"
  trust:      title="capsuleEmpty.suggest.trust.simple — From the balance
              verdict on this period"
  covenant:   title="capsuleEmpty.suggest.covenant.simple — Compared with a
              typical Romanian facility test — not your loan documents"
```

**RED — live:**
```
Error: G3: 1 row(s) carry a native `title` tooltip:
  [capsule-suggestion] title="Aug 2026 has no file yet — what should I
                              upload? — From this workspace's period list"
      row text: "Aug 2026 has no file yet — what should I upload?"
```

**RED — static:**
```
[F1 no-native-tooltip] .../CapsuleSuggestionList.tsx:114 — a Capsule row
carries `title=` ("${question").
```

**GREEN after revert:** all three.

### P2 / P2b — the category column returns (G4, static F2)

P2 restored `{item.hint}` to `CapsuleJumpList`; the jsdom gate went red
and the LIVE gate stayed green, because the redesign moved the jump list
behind a keystroke and it is not mounted at rest. **A plant that does not
reach the surface under test proves nothing**, so P2b planted the same
defect on the ROUTER rows the live gate actually sees:

```diff
--- a/frontend/components/instrument/shell/CommandPalette.tsx
+++ b/frontend/components/instrument/shell/CommandPalette.tsx
-      {item.hint && !item.destination && !item.trailing && (
+      {/* G8 PLANT P2b */}
+      {true && (
         <span className="max-w-[38%] shrink-0 truncate text-[11px] text-ink-soft">
-          {item.hint}
+          {item.hint ?? "Overview"}
         </span>
       )}
```

**RED — jsdom (P2):**
```
→ G4: navigation rows print their section label: Overview, Analyze.
  expected [ 'Overview', 'Analyze' ] to deeply equal []
```

**RED — live (P2b):** `G4: 16 navigation row(s) carry a right-aligned
category label`, with the per-state census printed:
```
[G4 rest] rows=0 offenders=0
[G4 typing:work] rows=3 offenders=2
[G4 typing:cash] rows=13 offenders=13
```

**GREEN after revert:** live G4 24 rows / 0 offenders; jsdom 10/10.

### PA — dead space at the foot of the panel (G1)

```diff
-            rounded-[14px] border border-rule
+            rounded-[14px] border border-rule pb-[120px]
             ring-1 ring-inset ring-rule-soft
```

**RED:**
```
[G1 rest] height=328px content=275 dead=121px width=680
Error: G1: 121px of the resting panel is painted with nothing. The panel's
height must be the sum of what is actually true — the gap between the last
painted pixel (275) and the panel's own bottom (396) is dead space.
Error: G1: 121px of dead space in the typing state.
```

**GREEN after revert:** `[G1 rest] height=208px content=275 dead=1px`.

### PB — one planted footer, three detectors (G2, G3, G6)

```diff
             {composer}
+            {/* G8 PLANT PB */}
+            <div className="px-4 pb-2 text-[11px] text-ink-soft/40"
+                 data-testid="craft-plant-footer">
+              Ask anything
+            </div>
```

**RED — G2 (geometry):**
```
Error: G2: in the rest state 2 painted element(s) sit below the composer
```

**RED — G6 (contrast):** `G6 (light): 4 text token(s) below AA on the
glass` — the `/40` token, in all three phases.

**RED — G3 (restatement):**
```
[G3] placeholder="Ask anything…" · examined 6 hints · 1 restate it
   100%  "Ask anything"
Error: G3: 1 hint(s) restate the placeholder:
  100% overlap  "Ask anything" [craft-plant-footer]
```

> The first version of PB read *"Ask about this period — or jump
> anywhere"* and G3 stayed GREEN at 20% overlap — correctly, because the
> redesign had by then shortened the placeholder to *"Ask anything…"* and
> the planted text was no longer a restatement of it. The plant was
> retuned to restate the CURRENT placeholder. Recorded because it is
> evidence the detector reads the live placeholder rather than a
> hard-coded string.

**GREEN after revert:** G2-below 1 offender (the real R1, not the plant),
G3 0 restatements, G6 1 real failure (R3).

### PC — the deleted footer string rendered again (static F4)

```diff
-              {t("capsuleCraft.keys")}
+              {t("capsuleCraft.keys")}{t("capsuleEmpty.enter.idle")}{/* G8 PLANT PC */}
```

**RED:**
```
renderedHintPairs=4
[F4 footer-restates-placeholder] capsuleEmptyStrings.json [en] —
"enter.idle" restates the placeholder (75% of its content words).
    hint:        "Type to ask, or to jump anywhere"
    placeholder: "Ask about {{period}} — or jump anywhere"
… and the same in [ro]:
    hint:        "Scrie ca să întrebi sau ca să sari oriunde"
    placeholder: "Întreabă despre {{period}} — sau sari oriunde"
```

Both languages fire. The Romanian pair only fires because content words
are diacritic-folded and clipped to five characters, so `întreabă` and
`întrebi` count as one word; without that fold the RO copy would pass a
rule the EN copy fails, which is how a bilingual product ends up with two
standards.

**GREEN after revert:** `renderedHintPairs=0` — no hint key is rendered at
all, which is the strongest possible form of "the footer does not restate
the placeholder".

### PD — a selector nothing can emit (static F5)

```diff
   turn: '[data-testid="capsule-turn"]',
+  /** G8 PLANT PD */
+  ghost: '[data-testid="capsule-ghost-row"]',
```

**RED:**
```
[F5 spec-alive] e2e/design/capsule-craft.spec.ts names
data-testid="capsule-ghost-row", which NO component under frontend/ can
emit. A selector nothing produces makes every assertion about it a tautology.
```

### PE — a dead anchor in the live spec (G0)

```diff
-  trigger: '[data-testid="header-command-bar"]',
+  trigger: '[data-testid="header-command-bar-PLANT"]',   /* G8 PLANT PE */
```

**RED:**
```
Error: G0: anchor "trigger" ([data-testid="header-command-bar-PLANT"])
matched nothing with the surface closed. Every negative assertion in this
file is only a ban if the thing it forbids is renderable — an anchor that
matches nothing turns all of them into decoration.
```

### G5.a — the CLS plant is PERMANENT, not a one-off

CLS is the one gate whose green is indistinguishable from a broken
observer, so its plant lives in the file and runs on every invocation:
insert an 80px block at the top of the open overlay and require the
observer to record a shift.

```
[G5.a plant] cls=0.00831224279835391 shifts=[{"v":0.0083,"nodes":["capsule-stack"]}]
```

Only after that fires are the four zeros below it worth reading.

---

## 3. VACUITY — WHAT THIS LANE DID ABOUT THE FIVE FALSE GREENS

`design_review/FALSE_GREEN_FINDINGS.md` records five battery gates that
passed while examining nothing, including one whose DISCOVERY-BROKEN
canary sat **inside** its per-item loop and therefore could never fire on
the one case it existed to catch.

### The static gate proves it is not the sixth

`node scripts/check_capsule_craft.mjs --probe-vacuity` empties the gate's
own discovery roots and requires the run to FAIL:

```
  files=0 rows=0 rowComponents=0 bundles=0 renderedKeys=0 placeholders=0 specAnchors=0
GATE-WORK capsule-craft units=0 floor=12 …

FAIL check_capsule_craft — DISCOVERY BROKEN
  units=0 floor=12 · files=0 rows=0 bundles=0 renderedKeys=0 placeholders=0 anchors=0
  A census that finds nothing is a broken gate, never a passing one.

VACUITY PROBE PASSED: with discovery emptied the gate FAILS, as it must.
The floor is asserted after the loops, against the totals — not inside them,
where an empty discovery would skip the check entirely.
```

The floor and the discovery canary are both computed **after** every
loop, from the totals. That placement is the whole antibody.

### Two counts, not one

F4 tracks `placeholders` (its DISCOVERY canary — zero means the strings
file moved and the gate is blind) separately from `renderedHintPairs`
(its WORKLOAD — zero is a legitimate answer, meaning the surface renders
no static hint at all). Folding them together would make the correct end
state look like a broken gate, and **a gate that goes red when the defect
is fixed gets deleted by the next lane.**

### Every live "this is empty" has a positive control in the same run

| Assertion | Its control |
|---|---|
| G7.b Tier-0 spends nothing | G7.a — a Tier-1 question DOES hit both seams |
| G7.b zero spend | the same test asserts a turn painted, with a figure |
| G5.b CLS is 0 | G5.a — a planted 80px insert IS recorded |
| G7/C1 no fabricated numeral | the same test asserts the turn rendered |
| G7/C3 no unprovenanced figure | ≥1 PROVENANCED figure required first |
| G7/C5 no substituted zero | the answer's text length must be > 0 |
| G7/C2 no write at the wire | ≥1 tool request required — this is the exact trap that made K9/C2's ancestor vacuous when Tier 0 started short-circuiting its question |
| G4 no category column | ≥5 rows summoned across a 9-state sweep |
| G3 no restatement | ≥2 hint texts examined |
| G6 all tokens AA | ≥6 text nodes measured per theme |
| G7/C4 no spend while navigating | ≥1 row must have been produced |

### Floors are measurements, and both numbers are recorded

| Floor | Set to | Measured | Note |
|---|---|---|---|
| `contrastNodes` | 6 | 21 → 9 | 21 before the redesign; 9 after it thinned the resting surface. Lowered from 10 to 6 **after** re-measuring twice at 9 — one intermediate run read 5, which was a race with another lane's rebuild, not the design. |
| `navRows` | 5 | 24 | across a 9-state sweep. Rest alone is 0: navigation now lives behind a keystroke. |
| `hintTexts` | 2 | 5 | |
| `routerSamples` | 8 | 10 | |
| `units` (static) | 12 | 119 | |

Raising a floor to turn a red green would be the exact fraud these gates
exist to prevent. Lowering one without recording the measurement is the
same fraud running the other way, which is why both numbers are here.

---

## 4. THE BATTERY LINE

The coordinator owns `scripts/run_battery.py`; this lane may not edit it.
Add verbatim, beside the other frontend gates:

```python
        # THE CAPSULE READS AS A CONVERSATION. Static half: no native
        # tooltip on a row, no category column beside a destination's
        # name, per-feature strings registered with addResourceBundle in
        # EN+RO, no hint that restates the placeholder, and the live
        # craft spec's anchors all producible. In the battery because the
        # shipped surface duplicated its own placeholder in a footer and
        # drew an OS tooltip over every suggestion for weeks while every
        # C-gate stayed green — a surface can satisfy every correctness
        # law and still read as a command menu. Live half (G1-G7, needs
        # vite :5173 + engine :8000): e2e/design/capsule-craft.spec.ts.
        # Self-test: --probe-vacuity empties its own discovery roots and
        # requires the run to fail. Plants + proven-RED transcripts:
        # design_review/capsule-craft/GATES.md
        Gate("capsule-craft", ["node", "scripts/check_capsule_craft.mjs"],
             work_rx=r"GATE-WORK capsule-craft units=(\d+)", floor=12,
             units="capsule files + rows + bundles + placeholders + spec anchors",
             canaries=("CAPSULE-CRAFT GATES", "GATE-WORK capsule-craft")),
```

The gate currently exits 1 on R4 (`item.hint` on the router row in
`CommandPalette.tsx`). It is honest and it is red; do not register it
green.

---

## 5. WHAT WOULD MAKE THE FOUR REDS GREEN

Not this lane's code to change — recorded so the redesign lane does not
have to re-derive it.

1. **Bottom-anchor the panel** (`sm:top-[68px]` → a bottom-pinned
   position) so it grows upward. Closes R2, and removes the cause of the
   streaming CLS G5 caught under the previous layout. G1's dead-space
   clause keeps this honest: the panel still may not be taller than its
   contents.
2. **Move `capsule-keys` above the input** or into the composer row.
   Closes R1.
3. **Drop the `/70` from the citation scope token**
   (`CapsuleFactCard.tsx:129`, `CapsuleTier0Preview.tsx:182`). Closes R3
   in both themes. Do not compensate with a darker backdrop — the token
   fails on its own, everywhere it is used.
4. **Delete the `item.hint` render on the router row in
   `CommandPalette.tsx`.** Closes
   R4. The group HEADING (`capsule-section-label`) is the right home for
   a category and is explicitly permitted: one label above a run of rows
   is a different object from one label on every row.

Also flagged, outside this lane's files and outside its gates:

- `node scripts/check_design_lint.mjs` is RED on two violations neither
  authored nor ownable here — a raw hex `#0E7C6B` at
  `frontend/components/instrument/shell/CapsuleComposer.tsx:241`, and
  `shadow-xl` at `frontend/components/cfo/TopHeader.tsx:243`.
- `scripts/check_capsule_craft.mjs` reports, advisory and not gating,
  five hint strings in `capsuleEmptyStrings.json` that no `t(…)` call in
  the shell renders any more (`enter.idle`, `enter.keys`, `enter.ask`,
  `enter.go`, `enter.askFallbackHint`). Dead copy is a loaded gun: the
  next lane that needs a footer reaches for the key that is already
  there, and the deleted defect returns under its original name.

---

## 6. GATE CORRECTIONS MADE DURING THIS PASS

Recorded because a gate quietly changing its own rule is indistinguishable
from a gate being weakened, unless the change is written down.

1. **The Tier-0 attribution assertion was too specific.** It required a
   `capsule-provenance-dot` on every Tier-0 turn. "is it balanced"
   resolves to a VERDICT with no figure to hang a dot on — it carries a
   citation and a Tier-0 note instead, which IS the invariant. The gate
   now requires *any* of {provenance dot, citation, Tier-0 note}. C3 is
   "every answer traces to a fact", not "every answer wears a particular
   ornament"; asserting the ornament would have failed a correct answer,
   which is how a gate teaches the next lane to delete it.

2. **"The composer is the last focusable element" was too strict.** A
   send button that ships with the input is part of the composer. The
   rule is now: no focusable element from OUTSIDE the composer's own
   block may follow it. `capsule-send` passes; a suggestion row would not.

3. **EN/RO key parity now compares plural BASE keys.** i18next spells
   CLDR plural categories as `key_one` / `key_few` / `key_other`, and the
   set of forms a language has is a property of the language — English
   has two, Romanian has three. Raw set comparison reported
   `strip.unattached_few` as "missing in en" forever, which trains the
   reader to ignore the gate.

4. **F4 evaluates only copy that is actually rendered.** A string nobody
   renders cannot restate anything. Unrendered hint strings are reported
   under their own name (dead copy, advisory) rather than as
   restatements — a different problem deserves a different report.
