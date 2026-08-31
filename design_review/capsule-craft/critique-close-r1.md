# Capsule — CLOSE lane, round 1: what the disputed complaints actually measured

Round 1 of 3+. Measured against `close-r0/` (the shipped build, before this
lane touched anything) with `design_review/capsule-craft/probe.mjs` —
4 states × 2 viewports × 2 themes, screenshots and `PROBE.json` for each.

The probe exists because the surface lane's own harness could not see three
of the six defects the owner reported. It measures the READER's page:
glyph boxes rather than element boxes, whole-document rather than
overlay-rooted, and it names the component that painted every node it
examined.

---

## The critic was right on all three, and here are the numbers

| | Complaint | Shipped build (`close-r0`) | Verdict |
|---|---|---|---|
| 3 | category labels | `trail=13` in the typing state at **1440 AND 390** | **OPEN** |
| 4 | native tooltips | 3 in-overlay in the answered state, on `capsule-fact-card` ×2 + `capsule-provenance-dot` | **OPEN** |
| — | 390 viewport | typing **617px = 73.0vh**, second answered turn **678px = 80.3vh** | **OPEN** |
| G2 | composer y | rest 265 · typing 579 · answering 444 · +1 turn 579 → **drift 314px** | **OPEN** |

Two further findings the brief did not name, both from the same probe:

- **The tooltip census was scoped wrong twice, not once.** The overlay-rooted
  sweep also missed `header-command-bar` (`title="Ask or jump (⌘K)"`) and
  the header's `trust-dot`, which carry a `title` in *every* state. They are
  part of this surface; they live outside the portal.
- **`data-row-source` did not exist**, so the r0 census reads
  `{"UNSTAMPED": 13}`. There was no way for any gate to state which
  component painted the rows it was judging — which is the precondition for
  the TC-7 defect, not a separate problem.

## What G1 could not see, restated as a number

The old G1 measures `overlay.bottom − deepest painted descendant.bottom`,
budget 8px. On `close-r0` that is **3px**. On the build that was complained
about it was also 3px. The metric did not move while the design did, because
a box that hugs its last child scores ~0 however much air sits above it.

The old G1's other clause is a 440px height ceiling, and the surface that was
complained about was 376px. It would have passed.

## Still unknown at the end of round 1

- Whether a fixed resting height (the owner's ruling) can be reconciled with
  ink density on a workspace that yields ONE suggestion instead of three.
  `close-r0` rest is 208px of content; three chips need ~292.
- Whether the two `title` sites owned by other lanes
  (`lib/narrativeMoney.tsx`, `components/cfo/TraceableNumber.tsx`) can be
  neutralised without deleting the FX disclosure they carry.
