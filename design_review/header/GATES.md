# THE PLACEMENT LAW — header gates H1–H6 (Part D)

> **The law (permanent):** a header element must be needed on EVERY screen,
> EVERY session. Hard budget: **≤6 interactive elements as direct header
> children at 1440px** — enforced by test (H1), not taste.

Three enforcement layers, cheapest first:

| Layer | File | Runs | Covers |
|---|---|---|---|
| Static tripwire | `scripts/check_header_law.mjs` | `npm run header:law` (<100ms, CI-safe, no browser) | H2 (L1+L2), H4 (L3) |
| DOM law | `frontend/components/cfo/__tests__/headerLaw.test.tsx` | `npm run header:unit` (vitest/jsdom) | H2, H3a, H3b, H4 |
| Live law | `e2e/design/header.spec.ts` | `npm run header:e2e` (Playwright vs the :5173 test-mode stack, **`--project=chromium`** — the `prod` project runs signed-out and every gate needs an authed header) | H1, H2 (live half), H3 (live half), H4, H5, H6 |

`package.json` scripts (the only package.json change this lane makes):

```json
"header:law":   "node scripts/check_header_law.mjs",
"header:unit":  "vitest run frontend/components/cfo/__tests__/headerLaw.test.tsx",
"header:e2e":   "playwright test e2e/design/header.spec.ts --project=chromium",
"header:gates": "npm run header:law && npm run header:unit && npm run header:e2e"
```

---

## H1 — the budget gate

**≤6 top-level interactive elements inside `<header>` at 1440×900, on
`/dashboard` and `/chat`.**

### The one definition of "direct" (documented here, implemented once in
`countHeaderInteractive` in the spec)

Count an element when ALL of:

1. it matches the interactive selector set:
   `button, a[href], input, select, textarea, [role="button"], [role="radiogroup"], [role="combobox"]`;
2. it is **visible** (non-zero client rect, not `display:none` /
   `visibility:hidden`) — so `lg:hidden` mobile affordances don't count at 1440;
3. it is **not inside an open overlay** (`[role="dialog"]`, `[role="menu"]`,
   radix popper portals) — popover interiors are second-level homes;
4. it is **top-level**: no ancestor inside the header also matches the set.

Consequences, by design:

- A composite widget counts **once**: the Simple|Pro dial is a
  `role="radiogroup"` and matches the set itself, so its two inner radios
  are swallowed by rule 4.
- The count is **deliberately not depth-limited** — the original sketch said
  "direct children or children of direct wrapper divs", but a depth rule is
  gameable with one extra `<div>`. Top-level-interactive is not: wrapping a
  control deeper never removes it, and hiding two controls inside a fake
  parent "button" would break its a11y semantics (H6 territory) long before
  it fooled the census.
- **No exemptions.** The brand mark is interactive and counts. If the header
  carries it, it spends budget like everything else.

### Standing finding (for the header lane / owner)

Measured on the live stack 2026-08-30 (mid-lane): **8** top-level elements —
brand · context-object · mode-switch · ⌘K bar · **Ask (slated for removal)**
· currency · bell · avatar. Removing Ask lands at **7 — still one over
budget**. The law stays as written; the lane owes one more consolidation
(candidates by the every-screen/every-session test: the bell → palette or
account menu, or currency → the ContextObject/account surface). Do not bend
the gate to the DOM.

---

## H2 — the no-duplicate law

**No header-level action shares a destination/action with a sidebar nav item.**
The sidebar's `SHELL_NAV_ALL` (exported from
`frontend/components/cfo/Sidebar.tsx`, also feeding the ⌘K palette) is the
source of truth; both the vitest law (real import) and the static lint /
e2e (literal parse of the same array) read it, so the lists cannot drift.

- **Header-level** = TopHeader's own DOM/wiring. Popover interiors
  (account menu → Settings, ContextObject rows, palette actions) are
  second-level homes by design and are governed by H5's ≤2-interaction
  budget instead.
- `onOpenAi` counts as destination **`/chat`** — `AppShell.openAskCfoAi`
  navigates there. A header control wired to it is exactly the
  Ask-CFO-AI-in-both-places bug this law exists to keep dead. The static
  lint (L1) bans `onClick={onOpenAi}` in TopHeader.tsx outright.
- **One grandfathered idiom:** the brand mark's `navigate("/dashboard")`
  (logo-home). The lint allows at most ONE `navigate("/dashboard")`;
  the vitest law exempts only the element whose aria-label is the
  brand's ("Go to dashboard"). `/login` (signed-out) is not a nav
  destination and stays free.
- The e2e half additionally asserts the **precondition that makes the
  removal safe**: the sidebar's accent Ask row (`sidebar-chat`) is visible —
  killing the header button while the sidebar home is missing would strand
  the product's headline capability, and the gate says so.

---

## H3 — trust parity

### H3a · the status→tone map, snapshot-locked (vitest)

Locked band-by-band to the lane's shipped `TrustChip` map (read from their
source, then pinned — change the map, change this lock **consciously**):

| Engine presentation band | Chip tone | Locked class | Locked wording |
|---|---|---|---|
| `balanced` | success | `text-success` | "… · machine-computed" |
| `balanced` + extraction `llm` | accent | `bg-brand-tint` | "AI-read · verified" |
| `reconciled` | caution | `text-caution` | "… · auto-adjusted" |
| `minor_drift` / `needs_review` | caution | `text-caution` | presenter wording |
| `material_imbalance` | alert | `text-alert` | presenter wording |
| `unverified` | — | **no chip renders** | no fake trust |

The dot is `bg-current` inside the tone span, so dot color ≡ tone color —
locked by its own test.

### H3b · receipt field parity (vitest + live half)

The receipt sheet must keep every field row it carried when the law was
written: **status sentence** (title + machine status), **difference**,
**mapping version**, **extraction method + model**, the **reconciliation
check rows** (original difference, applied adjustment, placement, origin),
and the **diagnosis codes**. Note on the directive's "snapshot hash": the
served envelope exposes no hash field anywhere in `lib/servedFacts.ts`;
`mappingVersion` is the envelope's version identity and is locked as that
row. If the engine ever serves a real snapshot hash, add it to the lock.

The live e2e half opens the receipt only when the booted period actually
serves a canonical envelope (the test-mode demo period doesn't); the
authoritative lock is the vitest one, where every band is forced through
a mocked envelope.

---

## H4 — one ⌘K hint

The `<kbd>` badge is the ONE shortcut hint:

- the command bar's text (excluding its `<kbd>`) must not match
  `/⌘|ctrl|cmd|K\b/i` — live (e2e) and rendered-DOM (vitest);
- `shell.palette.hint` (en + ro) must not contain `⌘`, `{{mod}}`, `ctrl`,
  `cmd` — vitest + static lint;
- exactly one visible `<kbd>` inside the header — e2e; at most one `<kbd>`
  in TopHeader.tsx — lint. (The sidebar Ask row's hover ⌘J kbd is outside
  the header and unaffected.)

---

## H5 — two-interaction reachability (from /dashboard)

| Control | Path | Interactions |
|---|---|---|
| Mode switch | header dial | 1 |
| Currency | header currency menu → option | 2 |
| Theme | rail footer `sidebar-theme-toggle` | 1 |
| Ask CFO AI | sidebar accent row (`sidebar-chat`) | 1 |
| Period switch | `context-object` → popover row | 2 |

Plus the persistence regression: **mode** (aria-checked after reload) and
**currency** (trigger label after reload) both survive a reload after being
changed through their homes.

---

## H6 — a11y

- **Escape** closes each header popover (currency, context object, account)
  and returns focus to its trigger.
- **Focus rings**: walking Tab through the header, every focused control
  paints a visible ring (`box-shadow`/outline ≠ none).
- **Trust label-in-name**: the trust control's accessible name must contain
  its visible status word. ⚠ The current `TrustChip` aria-label is the
  static "Balance status — open receipt" — once a canonical period is
  served in the test stack this gate will (correctly) go red until the
  aria-label carries the live sentence (e.g. "Balanced · machine-computed —
  open receipt"). Vacuously green today only because the demo period wears
  no chip.
- **Coach marks** (conditional law): if any `[data-coachmark]` /
  `coach-mark` testid renders, Escape must dismiss it and it must NOT
  re-show after reload. No coach marks exist on /dashboard today → the
  gate passes vacuously and says so in an annotation. If the lane ships
  relocation coach marks, this gate arms itself automatically.

---

## Kill-list — every plant executed, every gate proven to trip

| # | Plant | Gate that must trip | Proof |
|---|---|---|---|
| 1 | Re-add a labeled Ask CFO AI header button | H2 (and H1) | The mid-lane live stack *is* this plant (button present 2026-08-30): e2e H2 FAILED ("an Ask CFO AI control is back at header level"), vitest H2 FAILED ("topheader-ask-cfo-ai → onOpenAi (/chat duplicate)"), lint L1 FAILED — and H1 counted it (8 > 6). After excising the button (mirror), all three go green. |
| 2 | Remove the method line from the receipt | H3b | Deleted the `Extraction` ReceiptRow from TrustChip.tsx → vitest H3b FAILED (missing "Extraction"/"llm" rows); reverted → green again. |
| 3 | Add "⌘K" back to the search placeholder | H4 | The mid-lane live stack *is* this plant (`shell.palette.hint` = "Search or press {{mod}}K"): e2e H4 FAILED ("Search or press Ctrl+K"), vitest H4 FAILED (strings + DOM), lint L3 FAILED (en + ro). With hint = "Search"/"Caută", all three go green. |

Also proven: planting `navigate("/products")` in TopHeader trips lint L2;
the clean end-state (Ask removed + hint cleaned) passes lint 5/5 and
vitest 12/12 — no false positives.

---

## Status at gate-authoring time (2026-08-30, live test-mode stack, mid-lane)

Red here is EXPECTED until the header lane lands its end state; these rows
are what the gates exist to flip and then hold.

| Gate | Verdict | Detail |
|---|---|---|
| H1 | 🔴 FAIL | 8 top-level interactive elements on /dashboard AND /chat (budget 6). Ask removal → 7: still over — see the standing finding above. |
| H2 | 🔴 FAIL | Ask button live in the header (trips lint L1 + vitest + e2e). Anchors/destinations half: 🟢 clean. |
| H3a | 🟢 PASS | All 6 band locks + no-fake-trust + dot-inherits-tone green against the lane's shipped map. |
| H3b | 🟢 PASS | All locked receipt rows render (vitest). Live half vacuous — no canonical envelope on the demo period. |
| H4 | 🔴 FAIL | Bar text "Search or press ⌘K/Ctrl+K" + the kbd = double hint (lint + vitest + e2e). Kbd-count half: 🟢 exactly one. |
| H5 | 🟢 PASS | All five paths ≤2 interactions; mode + currency persist across reload. |
| H6 | 🟢 PASS | Escape + focus-return on all three popovers; visible rings on the walked controls. Trust-name + coach-mark clauses vacuously green (see H6 notes). |

To go fully green the lane must: remove the Ask header button (H2), clean
`shell.palette.hint` en+ro (H4), get the census to ≤6 (H1), and — once a
canonical period exists in the test stack — put the live trust sentence in
the chip's accessible name (H6).


## Owner amendment — 2026-08-30: the dial returns, budget = 5

The Capsule consolidation landed the header at FOUR interactive
elements (brand · capsule · bell · avatar), removing the Simple|Pro
dial to the avatar menu per the directive.

The owner then asked for the dial back in the header: *"why remove pro
or light option for the website, leave that there it was a nice
touch."* Restored. The sanctioned set is now FIVE:

    brand · dial · capsule · notifications · avatar

`HEADER_BUDGET` is tightened from 6 to **5** — the exact new count, so
the gate still blocks the next unplanned addition. The dial remains in
the avatar menu and Settings as well: the header instance is
`hidden md:block`, so those are what keep it reachable on phones.

What did NOT come back: the trust TEXT (still a dot + receipt), the
Ask CFO AI button (sidebar + ⌘J + palette), and the currency selector
(avatar menu). Those three were the owner's original complaint.
