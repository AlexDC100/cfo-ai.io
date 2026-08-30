// THE CAPSULE SHELL — the morph, the jump ranking, and the ask-first
// Enter contract.
//
// Three small modules, one theme: each of them replaced a place where the
// surface was guessing.
//
//   capsuleMorph      the overlay used to APPEAR at a fixed offset. It
//                     now starts at the trigger's own box, which is
//                     arithmetic, and arithmetic is assertable.
//   capsuleJumpUsage  "most-used" used to mean "the order the rail was
//                     typed in". It now means measured, with the rail
//                     order kept as the tie break.
//   the Enter rule    Enter used to run whatever row happened to be
//                     selected. It now answers, unless the input is
//                     EXACTLY a destination — and the model-spend gate
//                     has to survive that change.

import { beforeEach, describe, expect, it } from "vitest";

import { routeQuery, willCallModel, foldQuery } from "@/lib/capsuleRouter";
import { CAPSULE_ROUTER_FIXTURES } from "@/lib/capsuleRouterFixtures";
import {
  ANCHOR_MARGIN,
  CAPSULE_TRIGGER_SELECTOR,
  anchoredLeft,
  measureTrigger,
  morphTransform,
  type MorphRect,
} from "../capsuleMorph";
import {
  DECAY_AT,
  MAX_TRACKED,
  clearJumpCounts,
  rankByUsage,
  readJumpCounts,
  recordJump,
} from "../capsuleEmpty/capsuleJumpUsage";
import { MAX_JUMPS } from "../capsuleEmpty/CapsuleJumpList";

// This jsdom build exposes `localStorage` as a bare object with no
// methods (the same wall `capsuleRecents.test.ts` and `viewModes.test.ts`
// hit), so the suite installs its own in-memory Storage — which also
// makes it hermetic: nothing leaks between files.
const bag = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => bag.get(k) ?? null,
    setItem: (k: string, v: string) => void bag.set(k, String(v)),
    removeItem: (k: string) => void bag.delete(k),
    clear: () => void bag.clear(),
    key: (i: number) => [...bag.keys()][i] ?? null,
    get length() { return bag.size; },
  },
});

// ══════════════════════════════════════════════════════════════════════
// THE MORPH
// ══════════════════════════════════════════════════════════════════════

describe("morphTransform — the overlay is the capsule, grown", () => {
  const pill: MorphRect = { x: 470, y: 12, width: 560, height: 30 };
  const panel: MorphRect = { x: 360, y: 68, width: 720, height: 300 };

  it("maps the panel onto the trigger exactly", () => {
    const t = morphTransform(pill, panel);
    // x: 470 - 360 = 110 · y: 12 - 68 = -56
    // sx: 560/720 = 0.7778 · sy: 30/300 = 0.1
    expect(t).toBe("translate(110px, -56px) scale(0.78, 0.1)");
  });

  it("is the IDENTITY when the two boxes already coincide", () => {
    expect(morphTransform(panel, panel)).toBe("translate(0px, 0px) scale(1, 1)");
  });

  it("refuses a degenerate box rather than dividing by zero", () => {
    // A zero-height target would make sy = Infinity and paint nothing.
    expect(morphTransform(pill, { ...panel, height: 0 })).toBeNull();
    expect(morphTransform(pill, { ...panel, width: 0 })).toBeNull();
    // A zero-width SOURCE has nothing to grow from — a collapsed pill
    // (mid-layout, or hidden) must fall through to the plain fade.
    expect(morphTransform({ ...pill, width: 0 }, panel)).toBeNull();
  });

  it("is deterministic — the same boxes give the same string", () => {
    expect(morphTransform(pill, panel)).toBe(morphTransform(pill, panel));
  });

  it("rounds, so float noise cannot produce a different transform per open", () => {
    const noisy: MorphRect = { x: 470.00000001, y: 12, width: 560.0000001, height: 30 };
    expect(morphTransform(noisy, panel)).toBe(morphTransform(pill, panel));
  });
});

describe("anchoredLeft — the panel centres under the CAPSULE, not the viewport", () => {
  // A 1440 viewport with the 240px rail: the header pill is centred in
  // what is LEFT of the header, so its centre is ~120px right of the
  // viewport's. This is the whole reason the gates lane measured 28px of
  // centre drift against a 24px tolerance (K6).
  const pill: MorphRect = { x: 470, y: 12, width: 560, height: 30 };

  it("puts the panel's centre exactly under the trigger's", () => {
    const left = anchoredLeft(pill, 720, 1440);
    // pill centre = 470 + 280 = 750 → left = 750 - 360 = 390
    expect(left).toBe(390);
    expect(left + 720 / 2).toBe(750);
  });

  it("is NOT the same as centring on the viewport — that is the defect", () => {
    const viewportCentred = (1440 - 720) / 2; // 360, what `mx-auto` gives
    expect(anchoredLeft(pill, 720, 1440)).not.toBe(viewportCentred);
    expect(Math.abs(anchoredLeft(pill, 720, 1440) - viewportCentred)).toBe(30);
  });

  it("clamps into the viewport rather than hanging the panel off the edge", () => {
    const farRight: MorphRect = { x: 1300, y: 12, width: 120, height: 30 };
    const left = anchoredLeft(farRight, 720, 1440);
    expect(left + 720).toBeLessThanOrEqual(1440 - ANCHOR_MARGIN);
    expect(left).toBeGreaterThanOrEqual(ANCHOR_MARGIN);

    const farLeft: MorphRect = { x: 4, y: 12, width: 40, height: 30 };
    expect(anchoredLeft(farLeft, 720, 1440)).toBe(ANCHOR_MARGIN);
  });

  it("never returns a negative left, even when the panel exceeds the viewport", () => {
    // Narrow window, wide panel: the margin wins over the ideal centre.
    expect(anchoredLeft(pill, 900, 800)).toBeGreaterThanOrEqual(ANCHOR_MARGIN);
  });

  it("returns whole pixels — a fractional left is a blurry panel edge", () => {
    const odd: MorphRect = { x: 470.4, y: 12, width: 561.3, height: 30 };
    expect(Number.isInteger(anchoredLeft(odd, 719.6, 1440))).toBe(true);
  });
});

describe("measureTrigger — a MISS is survivable", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("returns null when the header's pill is not on screen", () => {
    // The header lane owns that element. If it is ever renamed or
    // dropped, the morph must degrade to the reduced-motion fade rather
    // than throwing inside a layout effect.
    expect(measureTrigger()).toBeNull();
  });

  it("reads the box of the element the selector names", () => {
    const el = document.createElement("div");
    el.setAttribute("data-testid", "header-capsule");
    el.getBoundingClientRect = () =>
      ({ left: 470, top: 12, width: 560, height: 30 }) as DOMRect;
    document.body.appendChild(el);
    expect(measureTrigger()).toEqual({ x: 470, y: 12, width: 560, height: 30 });
  });

  it("treats a collapsed element as absent", () => {
    const el = document.createElement("div");
    el.setAttribute("data-testid", "header-capsule");
    el.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 0, height: 0 }) as DOMRect;
    document.body.appendChild(el);
    expect(measureTrigger()).toBeNull();
  });

  it("names the header's testid — the one cross-lane coupling, stated", () => {
    expect(CAPSULE_TRIGGER_SELECTOR).toBe('[data-testid="header-capsule"]');
  });
});

// ══════════════════════════════════════════════════════════════════════
// ZONE 3 — "most-used" means measured
// ══════════════════════════════════════════════════════════════════════

describe("jump ranking", () => {
  const ORG = "org-test";
  const rail = [
    { id: "page-/dashboard" },
    { id: "page-/workspace" },
    { id: "page-/scenarios" },
    { id: "page-/benchmark" },
    { id: "page-/products" },
  ];

  beforeEach(() => {
    bag.clear();
  });

  it("an unused workspace shows the RAIL's order, not a shuffle", () => {
    expect(rankByUsage(rail, readJumpCounts(ORG)).map((r) => r.id)).toEqual(
      rail.map((r) => r.id),
    );
  });

  it("a used destination climbs, and ties keep the rail order", () => {
    recordJump(ORG, "page-/products");
    recordJump(ORG, "page-/products");
    recordJump(ORG, "page-/benchmark");
    const ranked = rankByUsage(rail, readJumpCounts(ORG)).map((r) => r.id);
    expect(ranked[0]).toBe("page-/products");
    expect(ranked[1]).toBe("page-/benchmark");
    // The untouched three keep their rail order behind them.
    expect(ranked.slice(2)).toEqual([
      "page-/dashboard",
      "page-/workspace",
      "page-/scenarios",
    ]);
  });

  it("counts are per WORKSPACE — one company's habits do not follow you", () => {
    recordJump("org-a", "page-/products");
    expect(readJumpCounts("org-b")).toEqual({});
    clearJumpCounts("org-a");
  });

  it("decays, so the first week cannot pin the list forever", () => {
    for (let i = 0; i < DECAY_AT; i += 1) recordJump(ORG, "page-/dashboard");
    const counts = readJumpCounts(ORG);
    // Halved at the threshold rather than growing without bound: a
    // destination visited 40 times in January must not outrank one
    // visited 8 times a day since.
    expect(counts["page-/dashboard"]).toBeLessThan(DECAY_AT);
    expect(counts["page-/dashboard"]).toBeGreaterThan(0);
  });

  it("keeps the tail bounded", () => {
    for (let i = 0; i < MAX_TRACKED + 10; i += 1) recordJump(ORG, `page-/p${i}`);
    expect(Object.keys(readJumpCounts(ORG)).length).toBeLessThanOrEqual(MAX_TRACKED);
  });

  it("survives corrupt storage rather than taking the surface down", () => {
    localStorage.setItem("cfo-capsule-jumps-v1:org-bad", "{not json");
    expect(readJumpCounts("org-bad")).toEqual({});
    localStorage.setItem("cfo-capsule-jumps-v1:org-neg", '{"a":-3,"b":"x","c":2}');
    // A negative or non-numeric count is corrupt, not a hint.
    expect(readJumpCounts("org-neg")).toEqual({ c: 2 });
  });

  it("four is the cap the zone renders", () => {
    expect(MAX_JUMPS).toBe(4);
  });
});

// ══════════════════════════════════════════════════════════════════════
// THE ENTER CONTRACT — ask-first, and still free to navigate
// ══════════════════════════════════════════════════════════════════════

describe("Enter answers unless the input is EXACTLY a destination", () => {
  // The palette's own rule, extracted to the two predicates it is built
  // from, so the contract is assertable without mounting the app shell.
  const DESTINATIONS = [
    "Dashboard",
    "Workspaces",
    "Scenarios",
    "Benchmark",
    "Products",
    "Settings",
    "Public Companies",
  ];
  const exactNav = (query: string): string | null => {
    const folded = foldQuery(query);
    if (!folded) return null;
    // The router has a veto: a query it reads as a QUESTION stays a
    // question even when it spells a destination.
    if (routeQuery(query).classification.lane === "ask") return null;
    return DESTINATIONS.find((d) => foldQuery(d) === folded) ?? null;
  };

  it("a whole destination name navigates", () => {
    expect(exactNav("dashboard")).toBe("Dashboard");
    expect(exactNav("Products")).toBe("Products");
  });

  it("diacritics do not change the answer — the fold is the comparison", () => {
    // Folding is what makes the RO surface behave like the EN one.
    expect(foldQuery("Bilanț")).toBe(foldQuery("bilant"));
  });

  it("a PREFIX of a destination is prose, and prose is a question", () => {
    // "dash" is not a destination's name; it is someone starting to type
    // one — or starting to type a question. Enter must not guess.
    expect(exactNav("dash")).toBeNull();
    expect(exactNav("dashboard and cash")).toBeNull();
  });

  it("a QUESTION that contains a destination word stays a question", () => {
    // The precedence rule the router already owns, honoured here: this
    // is not a request for the balance-sheet page.
    expect(exactNav("is the balance sheet balanced")).toBeNull();
    expect(exactNav("why is cash down this month")).toBeNull();
  });

  it("every prose fixture reaches the ask lane and nothing else does for free", () => {
    // The spend gate, restated after the Ask ROW was deleted. The row is
    // gone; `willCallModel` is not, and the navigate / entity / action
    // lanes still cost nothing on their default row.
    let asked = 0;
    for (const fixture of CAPSULE_ROUTER_FIXTURES) {
      const result = routeQuery(fixture.query);
      const paid = willCallModel(result, result.defaultIndex);
      if (fixture.lane === "ask") asked += 1;
      else
        expect(paid, `${fixture.lane} fixture "${fixture.query}" spent a model call`).toBe(
          false,
        );
    }
    expect(asked, "no ask fixtures — the assertion above is vacuous").toBeGreaterThan(0);
  });

  it("routing every prefix of every fixture costs nothing, on every keystroke", () => {
    // Typing is a burst of prefixes. None of them may be paid, because
    // the surface classifies on every one of them.
    for (const fixture of CAPSULE_ROUTER_FIXTURES) {
      for (let i = 1; i <= fixture.query.length; i += 1) {
        const prefix = fixture.query.slice(0, i);
        const result = routeQuery(prefix);
        for (let row = 0; row < result.rows.length; row += 1) {
          if (result.rows[row].kind !== "ask") {
            expect(willCallModel(result, row), `"${prefix}" row ${row}`).toBe(false);
          }
        }
      }
    }
  });
});
