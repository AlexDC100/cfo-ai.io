# THE PLACEMENT LAW — header gates H0–H7

> **The law (permanent):** a header element must be needed on EVERY screen,
> EVERY session. The budget is an **EXACT sanctioned set**, not a ceiling:
>
> | Width | The set | Count |
> |---|---|---|
> | ≥ 1024 | brand mark · **THE CAPSULE** · notifications · avatar | **4** |
> | < 1024 | nav toggle · **THE CAPSULE** · avatar | **3** |
>
> Enforced by test (H1), not taste — and by identity, not arithmetic: a bare
> count would stay green if the bell replaced the brand mark.

Four enforcement layers, cheapest first:

| Layer | File | Runs | Covers |
|---|---|---|---|
| Static tripwire | `scripts/check_header_law.mjs` | `node scripts/check_header_law.mjs` (<100 ms, CI-safe, no browser) | L1–L6 |
| DOM law | `frontend/components/cfo/__tests__/headerLaw.test.tsx` | `npx vitest run frontend/components/cfo/__tests__/headerLaw.test.tsx` | H1s, H2, H3a, H3b, H4, H6s, H7 |
| Live law | `e2e/design/header.spec.ts` | `npx playwright test e2e/design/header.spec.ts --project=chromium` (the `prod` project runs signed-out and every gate needs an authed header) | H0, H1, H2, H3, H4, H5, H6 |
| Probe | `design_review/header/census-probe.mjs` | `node design_review/header/census-probe.mjs [routes] [widths]` (~30 s) | the census at arbitrary widths, while you work |

> **Doc-drift fixed 2026-08-30:** this file used to advertise `npm run
> header:law` / `header:unit` / `header:e2e` / `header:gates`. **Those
> scripts have never existed in `package.json`.** The commands above are
> the real ones. A runbook that names a command nobody can run is the
> documentation version of a false green.

**The census — "what counts as a header control" — is defined exactly ONCE**,
in `scripts/check_header_law.mjs` (`INTERACTIVE_SELECTORS`,
`COMPOSITE_SELECTORS`, `headerCensus`). The e2e spec, the vitest suite and
the probe all import it. It is deliberately not restated in prose here,
because the last time it was restated it drifted — see the audit below.

---

## H0 — the gate audits itself

Added in Part E, because the previous round produced **both** failure modes
a gate can have, and only one of them was caught by a human noticing:

1. **A violation that does not exist (false red).** The census selector list
   already contained `[role="radiogroup"]`, and a collapse-fix appended it a
   second time to "make sure the dial counts once". It counted twice: the
   census reported **6** for a **5**-control header. A gate that cries wolf
   is as bad as a false green, because the next person silences it.
2. **A pass aimed at nothing (false green).** Several selectors pointed at
   elements that had been deleted or were never reachable — listed below.

H0 makes both mechanical:

- **`the census selector list has no repeats and no orphan composite`** —
  asserts `INTERACTIVE_SELECTORS` is repeat-free and every
  `COMPOSITE_SELECTORS` entry is *inside* it, so composites are matched by
  the ONE pass and never appended to the result afterwards. Mirrored
  statically as lint **L5**.
- **`every REQUIRED selector resolves live`** — every id the spec depends on
  is probed **where it lives** (menu-scoped ids with the menu open, the
  compact-width ids at 900 px). Mirrored statically as lint **L6**, which
  additionally forces every testid the spec touches into one of three
  declared lists, so a future selector cannot be added unclassified.

### Selector classification (in `e2e/design/header.spec.ts`, parsed by L6)

| List | Meaning | Enforced by |
|---|---|---|
| `REQUIRED_TESTIDS` | must exist in `frontend/` source **and** resolve live | L6a + H0 |
| `CONDITIONAL_TESTIDS` | exists in source; may be legitimately absent from a given boot (trust chip without a canonical envelope; the coach mark before it arms). The spec annotates the skip instead of passing silently | L6a |
| `BANNED_TESTIDS` | must not appear in `TopHeader.tsx` | L6b |

### Audit findings — what was actually wrong

| # | Finding | Class | Fix |
|---|---|---|---|
| 1 | `[role="radiogroup"]` appended a second time after the top-level filter | false red — double count | Removed (already, in the prior round); now **structurally impossible**: L5/H0 assert the list is repeat-free and composites live inside the single pass. The redundant `p.getAttribute("role") === "radiogroup"` clause in the ancestor walk was also deleted — it was dead (the selector set already matched it) and it was the shape the double count grew out of. |
| 2 | `H5 currency` drove `currency-menu-eur` / `currency-menu-ron` | **stale — element deleted** | `CurrencyMenu` is no longer rendered anywhere in the app (grep: only its own file + a dead vitest mock). The real path is avatar → `currency-toggle-eur`. Rewritten. |
| 3 | `H5 currency` asserted the account trigger `toContainText("EUR")` | **stale — assertion about a removed design** | The avatar shows initials; it never showed a currency code after the currency menu left the bar. Now asserts `aria-checked` on the toggle segment. |
| 4 | `H6 Escape` used `header-capsule` as a focus-return target | **stale in reverse — aimed at an element that can never satisfy it** | The Capsule is a composite `<div>`; its focusable trigger is `header-command-bar`. Retargeted. This immediately exposed a real defect — see the cross-lane item below. |
| 5 | `headerLaw.test.tsx` mocked `@/components/cfo/CurrencyMenu` | **dead mock** | `TopHeader` never imported it. A mock for a module nothing imports makes a suite look like it covers a surface it does not. Deleted. |
| 6 | `H2` proved "no Ask control" **only** by `[data-testid="topheader-ask-cfo-ai"]`, a testid that exists nowhere | **false green** | `toHaveCount(0)` on a string that no longer exists passes forever, and would keep passing if the button shipped under a new testid. Kept as a cheap trip, but the load-bearing check is now behavioural: no header control's accessible name or text matches ask / CFO AI / chat / întreab. |
| 7 | `H6 coach marks` was a conditional clause that had never armed | **vacuous** | Part E ships a real coach mark, and the gate now seeds its arming condition so it actually runs. |
| 8 | `GATES.md` documented four `npm run header:*` scripts | **doc drift** | They do not exist in `package.json`. Replaced with the real commands. |
| 9 | `HEADER_BUDGET = 5` with `toBeLessThanOrEqual` | **too slack to be a law** | A ceiling permits a silent swap (bell out, something else in). Replaced with an exact identity set per width. |

---

## H1 — the budget gate

**The census must equal the sanctioned set EXACTLY**, by testid, in order,
on `/dashboard` and `/chat` at 1440×900 and on `/dashboard` at 1023×900.

### The one definition of "a header control"

Implemented once in `headerCensus` (`scripts/check_header_law.mjs`). Count an
element when ALL of:

1. it matches `INTERACTIVE_SELECTORS`;
2. it is **visible** (non-zero rect, not `display:none`/`visibility:hidden`)
   — so `lg:hidden` affordances don't count at 1440;
3. it is **not inside an open overlay** (`[role="dialog"]`, `[role="menu"]`,
   radix popper portals) — popover interiors are second-level homes;
4. it is **top-level**: no ancestor inside the header also matches the set.

Consequences, by design:

- **A composite counts once.** `COMPOSITE_SELECTORS` = `[role="radiogroup"]`
  (a segmented control is one control) and `[data-testid="header-capsule"]`
  (one pill the user scans once, holding the trust dot and the command bar).
  Both are *inside* `INTERACTIVE_SELECTORS`, so they are matched by the same
  pass and their children are swallowed by rule 4 — never appended.
- **H1b bounds the composite.** "Collapse to one" is only honest while a
  composite stays small, so `MAX_COMPOSITE_CHILDREN = 2` caps interactive
  descendants inside one. Without it, the collapse would be a hiding place.
- The count is **deliberately not depth-limited** — a depth rule is gameable
  with one extra `<div>`; top-level-interactive is not.
- **No exemptions.** The brand mark is interactive and counts.

### Role selectors vs identity selectors (why L6 does not flag `radiogroup`)

`INTERACTIVE_SELECTORS` mixes two kinds of entry and the difference decides
what "stale" means:

- **Role selectors** (`button`, `a[href]`, `[role="radiogroup"]`, …) describe
  a *class* of control. They are a taxonomy, not a list of elements the
  header is expected to have. `[role="radiogroup"]` matches nothing in the
  header now that the dial is gone — that is the gate **standing ready**, not
  staleness, and it is exactly what caught Plant B below.
- **Identity selectors** (`[data-testid="…"]`) name ONE element. Those go
  stale, and L6 hunts them.

### Structural vs live census

`headerCensus(root, { …, structural: true })` drops the visibility clause.
jsdom has **no layout** — every rect is 0×0 and Tailwind's responsive classes
are never resolved — so a visibility clause there returns an empty census and
reads as a green. The vitest half therefore censuses STRUCTURE (what exists,
how it nests, what a composite swallows) and the e2e half owns responsive
truth. Each says which it is; neither pretends to be the other.

That split is what makes **H1s** possible: the live test-mode period serves
no canonical envelope, so the trust chip never renders there and the Capsule
is only ever measured holding ONE child. In vitest the chip is mocked into
existence, and the two-child Capsule is proven to still collapse to one.

---

## Part E — what moved, and why

| Control | Was | Now | Reachability |
|---|---|---|---|
| **Simple \| Pro dial** | in the bar (`hidden md:block`) | avatar quick-settings · Settings > Appearance · ⌘K palette action | 2 interactions (H5) |
| **Notifications bell** | in the bar from `sm` up | in the bar from `lg` up; below that, the avatar menu's row **with the count mirrored on the avatar** | 2 interactions (H5) |
| **Brand mark** | every width | `lg` and up | below `lg` the nav toggle owns the left slot; `/dashboard` is 2 interactions through the drawer |

**Why the dial, specifically.** It was the fifth element and the only
candidate that fails the law's own test — it is not needed on every screen of
every session. A user picks Simple or Pro roughly once and lives there; the
bar was paying permanent width for a once-a-quarter decision. Nothing was
deleted: it keeps three homes, and `useViewModeSync()` stays seated in
`TopHeader` (lint **L4** fails if it is removed) because the avatar menu's
content mounts lazily and cross-device adoption needs an always-mounted host.

**Why the brand mark yields below `lg`.** Rendering the hamburger *and* the
logo put two left-hand "go somewhere" controls side by side on the narrowest
screen. The drawer carries the product identity there.

**The relocation coach mark.** One-time, Escape-dismissible, never re-shown
(`cfo:header-mode-coachmark-v1`). Two deliberate properties:

- It is **portaled to `<body>`**, never rendered inside `<header>` — a hint
  *about* a control is not a header control, and the census must not have to
  special-case it away. H6's `the coach mark spends no header budget` proves
  the census is unchanged while it is on screen.
- It **arms only for a user who holds an explicit view-mode choice**
  (`cfo-view-mode-v1` present) — someone who actually operated the dial while
  it was in the bar. A first-run user is not told about a control they never
  touched, and no other lane's e2e run trips over an overlay it never asked
  for.

---

## H2 — the no-duplicate law

**No header-level action shares a destination/action with a sidebar nav item.**
`SHELL_NAV_ALL` (exported from `frontend/components/cfo/Sidebar.tsx`, also
feeding the ⌘K palette) is the source of truth; the vitest law imports it and
the lint / e2e parse the same literal, so the lists cannot drift.

- **Header-level** = `TopHeader`'s own DOM/wiring. Popover interiors (account
  menu → Settings, palette actions) are second-level homes, governed by H5's
  ≤2-interaction budget instead.
- `onOpenAi` counts as destination **`/chat`**. Lint **L1** bans
  `onClick={onOpenAi}` in `TopHeader.tsx` outright.
- **One grandfathered idiom:** the brand mark's `navigate("/dashboard")`.
  The lint allows at most ONE; the vitest law exempts only the element whose
  aria-label is the brand's. `/login` (signed-out) is not a nav destination.
- The e2e half also asserts the **precondition that makes the removal safe**:
  the sidebar's accent Ask row (`sidebar-chat`) is visible.
- Since Part E the Ask check is **behavioural** (see audit finding 6).

---

## H3 — trust parity

### H3a · the status→tone map, snapshot-locked (vitest)

| Engine presentation band | Chip tone | Locked class | Locked wording |
|---|---|---|---|
| `balanced` | success | `text-success` | "… · machine-computed" |
| `balanced` + extraction `llm` | accent | `bg-brand-tint` | "AI-read · verified" |
| `reconciled` | caution | `text-caution` | "… · auto-adjusted" |
| `minor_drift` / `needs_review` | caution | `text-caution` | presenter wording |
| `material_imbalance` | alert | `text-alert` | presenter wording |
| `unverified` | — | **no chip renders** | no fake trust |

The dot is `bg-current` inside the tone span, so dot colour ≡ tone colour —
locked by its own test.

### H3b · receipt field parity (vitest + live half)

The receipt must keep every row it carried when the law was written: **status
sentence**, **difference**, **mapping version**, **extraction method +
model**, the **reconciliation rows** (original difference, applied adjustment,
placement, origin), and the **diagnosis codes**. The served envelope exposes
no hash field anywhere in `lib/servedFacts.ts`; `mappingVersion` is its
version identity and is locked as that row.

The live half opens the receipt only when the booted period actually serves a
canonical envelope (the test-mode demo period doesn't) and annotates the skip.

---

## H4 — one ⌘K hint

The `<kbd>` badge is the ONE shortcut hint:

- the command bar's text (excluding its `<kbd>`) must not match
  `/⌘|ctrl|cmd|K\b/i` — live (e2e) and rendered-DOM (vitest);
- `shell.palette.hint` (en + ro) must not contain `⌘`, `{{mod}}`, `ctrl`,
  `cmd` — vitest + lint L3;
- exactly one visible `<kbd>` inside the header — e2e; at most one in
  `TopHeader.tsx` — lint. (The sidebar Ask row's hover ⌘J kbd is outside the
  header and unaffected.)

---

## H5 — two-interaction reachability (from /dashboard)

| Control | Path | Interactions |
|---|---|---|
| Mode switch | avatar → dial segment | 2 |
| Currency | avatar → `currency-toggle-*` | 2 |
| Notifications (< 1024) | avatar → notifications row | 2 |
| Theme | rail footer `sidebar-theme-toggle` | 1 |
| Ask CFO AI | sidebar accent row (`sidebar-chat`) | 1 |
| Period switch | Capsule → palette row | 2 |

Plus the persistence regression: **mode** (`aria-checked` after reload) and
**currency** (`aria-checked` after reload) both survive a reload through their
new homes.

---

## H6 — a11y

- **Escape** closes every header popover (Capsule palette, account menu).
- **Focus return**: to the avatar trigger — green. To the Capsule's command
  bar — **RED, cross-lane** (below).
- **Focus rings**: walking Tab through the header, every focused control
  paints a visible ring.
- **Trust label-in-name**: the trust control's accessible name must contain
  its visible status word. Vacuously green today — the demo period wears no
  chip, and the spec says so in an annotation.
- **Coach mark**: arms, dismisses on Escape, never re-shows, and spends no
  header budget. This clause used to be vacuous; Part E arms it.

### ⚠ Cross-lane defect — palette focus restore (owner: the palette lane)

**Measured on the live stack, 2026-08-30:** Escape from the ⌘K palette closes
it and leaves focus on `<body>`. A keyboard user loses their place and must
Tab from the top of the document (WCAG 2.4.3 Focus Order). The palette is a
Radix Dialog opened from `AppShell` state rather than from a
`<DialogTrigger>`, so nothing owns the restore.

```tsx
// CommandPalette.tsx — DialogPrimitive.Content
onCloseAutoFocus={(e) => {
  e.preventDefault();
  document.querySelector<HTMLElement>('[data-testid="header-command-bar"]')?.focus();
}}
```

`H6 › Escape returns focus to the Capsule's command bar` is **left RED on
purpose**. It is a real defect in shipped behaviour. Making it green from the
header lane would mean either bending the law or bolting a `MutationObserver`
onto `TopHeader` to paper over another surface's focus management — the
header lane owns the trigger, not the dialog.

---

## H7 — the relocated dial is still wired

- `TopHeader` still calls `useViewModeSync()` (lint L4 fails if it doesn't).
- `ModeSwitch.tsx` publishes `toggleViewMode()` and `MODE_PALETTE_ACTION`
  (`id`, `labelKey`, `hintKey`, `nextMode()`), and `modes.switch.paletteLabel`
  resolves in **en + ro**.

### ⚠ Cross-lane need — the ⌘K row (owner: the palette lane)

`CommandPalette.tsx` is not this lane's file, and it has no registry — its
`actions` array is a local literal. The behaviour and the strings ship here;
the ROW is two lines there:

```tsx
import { MODE_PALETTE_ACTION, toggleViewMode } from "./ModeSwitch";
// …inside the `actions` array:
{
  id: MODE_PALETTE_ACTION.id,
  group: t("shell.palette.actions"),
  label: t(MODE_PALETTE_ACTION.labelKey, {
    mode: t(`modes.switch.${MODE_PALETTE_ACTION.nextMode()}`),
  }),
  hint: t(MODE_PALETTE_ACTION.hintKey),
  icon: SlidersHorizontal,
  run: () => { toggleViewMode(); close(); },
},
```

Nothing is stubbed: `toggleViewMode()` is the one mutation path and is unit-
tested. Only the palette row is pending. The dial is at 2 interactions
through the avatar with or without it, so H5 is green either way.

---

## Kill-list — every plant executed, every gate proven to trip

| # | Plant | Gates that must trip | Proof (live stack + jsdom, 2026-08-30) |
|---|---|---|---|
| **A** | A **generic** fifth header control — `<button data-testid="header-help" aria-label="Help">?</button>` — proving the census catches *any* addition, not just the named regression | H1 (e2e, both widths), H1s (vitest) | e2e `@1440`: **5** counted, diff `+ "header-help"`, `desktop set holds on /dashboard` FAILED; `@1023`: **4** counted, `compact set holds` FAILED. vitest H1s FAILED on the structural set. **Lint L4 stayed GREEN — correctly:** L4 is a named-regression rule, not a counting rule. The census is the counting rule, and it is the one that caught this. Reverted → all green. |
| **B** | The **named** regression: `<ModeSwitch/>` back in the bar | L4 (lint), H1 + "dial is not in the bar at any width" (e2e), H1s ×2 (vitest) | Lint exit 1: `✗ [L4] TopHeader.tsx renders <ModeSwitch/> ×1`. e2e `@1440`: **5** counted, diff `+ "mode-switch"`. **The dial counted ONCE** — its two radios were reported as `composite mode-switch: 2 interactive descendant(s) — mode-switch-simple, mode-switch-pro`, not as top-level entries. That is the exact double-count false positive from the previous round, proven dead on the live DOM in the very scenario that produced it. vitest: 2 failed / 18 passed. Reverted → lint 10/10, vitest 20/20. |
| 1 | Re-add a labeled Ask CFO AI header button | H2 (and H1) | Prior round: e2e H2, vitest H2 and lint L1 all FAILED; excised → green. Since Part E the e2e half is behavioural, so a *renamed* button trips it too. |
| 2 | Remove the method line from the receipt | H3b | Prior round: deleted the `Extraction` ReceiptRow → vitest H3b FAILED (missing "Extraction"/"llm"); reverted → green. |
| 3 | Add "⌘K" back to the search placeholder | H4 | Prior round: e2e H4, vitest H4 and lint L3 (en + ro) all FAILED; hint cleaned → green. |

Also proven: planting `navigate("/products")` in `TopHeader` trips lint L2.

---

## Status — 2026-08-30, live test-mode stack, Part E end state

| Gate | Verdict | Detail |
|---|---|---|
| L1–L6 (lint) | 🟢 **10/10** | `node scripts/check_header_law.mjs` → `all clean.` |
| H0 | 🟢 PASS | Selector list repeat-free; all 16 required ids resolve live; 21 required+conditional ids exist in source; 16 distinct ids classified. |
| H1 | 🟢 PASS | **1440 = exactly 4** (`header-brand · header-capsule · notifications-button · account-menu-trigger`) on `/dashboard` and `/chat`; **1023 = exactly 3** (`header-nav-toggle · header-capsule · account-menu-trigger`), with the fold verified (the bell's row is live in the avatar menu). H1b: Capsule holds 1 descendant live, 2 under mock — both ≤ 2. |
| H1s / H7 | 🟢 PASS | Structural census incl. the trust chip; no radiogroup in the bar; palette action descriptor + en/ro label present. |
| H2 | 🟢 PASS | Banned testids absent; behavioural Ask scan clean; no header anchor duplicates any of the 12 `SHELL_NAV_ALL` destinations; sidebar Ask row live. |
| H3a / H3b | 🟢 PASS | All 6 band locks + no-fake-trust + dot-inherits-tone; all locked receipt rows. Live half annotated as skipped (no canonical envelope on the demo period). |
| H4 | 🟢 PASS | Bar text clean, exactly one `<kbd>`. |
| H5 | 🟢 PASS | All six paths ≤2 interactions; mode + currency persist across reload through their new homes. |
| H6 | 🟡 **1 RED** | Escape-closes, avatar focus-return, focus rings, coach mark (arms / Escape / never re-shows / no budget) all green. **`Escape returns focus to the Capsule's command bar` is RED — the cross-lane palette focus-restore defect documented above.** Trust label-in-name vacuous by annotation. |

Totals: **lint 10/10 · vitest 20/20 · e2e 23/24** (the 1 red is the
cross-lane defect, deliberately not silenced).

### Timing note for whoever edits this spec next

Radix's dismissable layer keeps swallowing the next click for a beat **after**
the menu has left the DOM. Measured on this stack: a click 1.2 s later is
eaten, 2.5 s lands. Waiting on the DOM alone is not enough — `RADIX_SETTLE_MS`
exists for this and its value came from a measurement, not a guess.
