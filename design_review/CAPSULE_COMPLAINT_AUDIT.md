# Capsule craft complaints — independent pre-redesign audit

Audited against the **shipped commit** `4d2eab6` by reading blobs out of
git rather than the working tree, because the redesign lanes are editing
those files right now and the working tree is a moving target.

Written before the redesign lands so the adversarial critics have a
baseline they did not author. Each entry names the file and line, so
"fixed" can be checked rather than asserted.

---

## 1. Native tooltip duplicating suggestion text — CONFIRMED, and broader

The owner saw one. There are **four** `title` attributes producing native
browser tooltips inside the Capsule:

| File | Line | Attribute |
|---|---|---|
| `capsuleEmpty/CapsuleSuggestionList.tsx` | 77 | ``title={`${question} — ${basis}`}`` — the reported one |
| `capsuleAnswer/CapsuleAnswerPanel.tsx` | 515 | `title={turn.question}` |
| `capsuleAnswer/CapsuleFigures.tsx` | 159 | `title={label}` |
| `TrustChip.tsx` | 109 | `title={label}` |

Fixing only the reported one leaves three. `TrustChip`'s is arguably
deliberate (the trust sentence is genuinely longer than the dot), so it
needs a decision rather than a blind delete — but it must be a decision.

## 2. Right-aligned category labels on navigation rows — CONFIRMED

`capsuleEmpty/CapsuleJumpList.tsx:92-96` renders `item.hint` as a
`shrink-0 truncate text-[11px] text-ink-soft` span after the flexed
label — the right-hand column. `item.group` is documented at line 33 as
*"Where it sits in the app — the rail group, usually. Display only."*
"Display only" is the tell: it is carried to the surface purely to be
shown, and the owner's point is that showing it buys nothing.

Note the row also renders `item.kbd`. Removing the category label must
not remove the keyboard hint, which does carry information.

## 3. Row density and the form-field input — TO MEASURE, NOT ASSERT

The owner reports ~700px of overlay with a large gap between the input
and the first row, rows around 56px, and an input that reads as a form
field. These are proportions, not code smells: they must be **measured
on the rendered surface at 1440**, before and after, not judged from the
source. G1 (resting height ≤ 440px, content height ±8px) and the 36px
row target are the gate; the before-numbers belong in the same table.

## 4. Detached Simple/Pro coach mark — CONFIRMED BY CONSTRUCTION

The coach mark is portaled to `<body>` deliberately, so that it spends
no header budget under H1 (exactly 4 controls at 1440). That is the
right call and must not be undone — but a `<body>` portal with no
anchoring logic is precisely how it ends up floating at the right edge.
The fix is to anchor it to the avatar's measured box while keeping the
portal, not to move it back into `<header>`.

---

## What "fixed" has to mean here

Every one of these is checkable. A critic reviewing the redesign should
be able to re-run the same greps and the same measurements and get a
different answer — not read a claim that it improved.
