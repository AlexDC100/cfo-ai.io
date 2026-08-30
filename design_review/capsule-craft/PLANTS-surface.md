# Plant record — SURFACE lane

Every gate this lane wrote or touched, planted with the defect it claims
to catch, observed RED, reverted, observed GREEN. A gate that has never
been seen going red is a decoration; five in this repo were caught
passing while examining nothing, so nothing here ships on inspection.

Stack: vite :5173 + engine :8000 `PUBLIC_TEST_MODE`, chromium project.

---

## S1 — the measured height reaches the box
`e2e/design/capsule-craft-surface.spec.ts`

**Plant** (`frontend/components/instrument/shell/CommandPalette.tsx`) —
restore the flex shorthand that silently disabled the animation for two
rounds:

```diff
-              flex min-h-0 flex-col overflow-hidden
+              flex min-h-0 flex-1 flex-col overflow-hidden
```

**RED**

```
Error: S1: the measured height stopped reaching the box while typing.
```

**Reverted → GREEN** (5 passed).

The gate also carries its own in-page positive control: it applies
`flex: 1 1 0%` to the stack live and requires the detector to see the
divergence before it asserts the clean state. That control failed on the
first attempt (`Received: 0`) because it planted at REST, where
`data-measured` IS the content height and the override agrees with it to
the pixel. It now plants in the typing state, where the `min(70vh, 520)`
clamp binds and the two genuinely differ. **A positive control that
cannot fire is the same disease as the gate it protects.**

---

## S2 — the composer paints no box
`e2e/design/capsule-craft-surface.spec.ts`

**Plant** (`frontend/components/instrument/shell/CapsuleComposer.tsx`) —
give `index.css`'s global focus ring back its effect:

```diff
-              focus-visible:shadow-none focus:shadow-none
+              /* PLANT: ring restored */
```

**RED**

```
Error: S2: the composer is enclosed by box-shadow: rgba(59, 130, 246, 0.5) 0px 0px 0px 3px.
```

That colour is `--ring-focus` — i.e. the plant restored the *actual* r0
defect, from the actual stylesheet, not a synthetic one.

**Reverted → GREEN** (5 passed).

This gate's predicate was wrong twice before it was right, and both
false REDS are worth recording because both look like defects and are
not:

| computed style | paints | why |
|---|---|---|
| `box-shadow: rgba(0,0,0,0) 0px 0px 0px 0px, …` | nothing | Tailwind's `shadow-none` sets the shadow custom properties rather than clearing the property |
| `outline-width: 2px` with `outline-style: none` | nothing | the used width of an absent outline is not zero |
| `outline: 2px solid` with `outline-color: transparent` | nothing | Tailwind's `outline-none` is literally `outline: 2px solid transparent` |

A predicate that stopped at width, or at width + style, would have failed
a correct surface and sent the next person to "fix" it. That is the
false-red twin of a false green.

---

## K10.e — Shift+Enter composes a newline, it does not ask
`frontend/components/instrument/shell/__tests__/capsuleSpendBoundary.test.tsx`

**Plant** (`CommandPalette.tsx`) — stop intercepting Shift+Enter, so it
falls through to `runPrimary`:

```diff
-    } else if (e.key === "Enter" && e.shiftKey) {
+    } else if (false) { // PLANT
```

**RED** — `× K10.e … a question Tier 0 refuses spends NOTHING when
committed with Shift`. **Reverted → GREEN** (13 passed).

---

## K10.f — one turn at a time
Same file.

**This one is the instructive failure of the session.** It was written
believing that the guard it protects lives in `CommandPalette.runPrimary`
— where the deleted `CapsuleAnswerPanel` composer's `if (!q || busy)
return` was moved to. Planting that line alone left the gate GREEN.
Planting `useCapsuleAnswer`'s `ask` guard alone left it GREEN too.

The invariant is guarded **three times** (`runPrimary`, `ask`,
`answerLocally`), and any one of them stops a second turn. Only the
combined plant goes red:

```diff
-    if (answer.busy) return;                      // CommandPalette.runPrimary
+    // PLANT
-      if (!q || busyRef.current) return;          // useCapsuleAnswer.ask
+      if (!q) return; // PLANT
-      if (!q || busyRef.current) return false;    // useCapsuleAnswer.answerLocally
+      if (!q) return false; // PLANT
```

**RED**

```
× K10.f — one turn at a time … expected 2 to be 1
```

**Reverted → GREEN** (13 passed).

Two things were changed because of this rather than left as they were:

1. The gate's own message no longer claims `runPrimary` is load-bearing.
   It names all three guards and points at this file.
2. The comment on `runPrimary`'s guard says it is the third of three and
   why it stays anyway (it is the guard at the layer the reader acts on
   — a composer whose Enter fires an action the hook will silently drop
   is a surface with a dead key).

A gate that goes green under a single-line plant and green again under a
different single-line plant is not proof of anything until you find out
whether that is redundancy or vacuity. Here it was redundancy — but the
only way to know was to plant all of them.

### The confound that had to be removed first

`capsuleAskGuard` enforces a minimum gap between asks, so a second Enter
fired straight after the first is refused by the THROTTLE regardless.
The gate calls `resetCapsuleAskGuard()` between the two turns so the
busy guards are the only thing left that can stop the second one. It
also holds the model seam open (`trapDelayMs = 2000`) so the first turn
is genuinely still running — without that the trap answers in the same
microtask, `busy` is already false, and the gate asserts nothing.
