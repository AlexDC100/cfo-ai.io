// Locks the fix for the usePrefSync infinite-adopt loop ("Maximum update
// depth exceeded", 2026-07-23). Postgres jsonb reorders object keys (by
// length, then lexicographically), so a preference object round-tripped
// through user_prefs/org_prefs comes back deep-equal but serialized
// differently — a naive JSON.stringify comparison saw "changed" on every
// hydration and re-adopted forever. stableStringify must be order-blind.

import { describe, expect, it } from "vitest";

import { stableStringify } from "../prefs";

describe("stableStringify", () => {
  it("is insensitive to key order (the jsonb round-trip case)", () => {
    // Exactly the learning-mode shape that triggered the loop: jsonb returns
    // keys ordered mode < tutorialsSeen < coachDismissed (length-first),
    // while the client builds mode, coachDismissed, tutorialsSeen.
    const local = { mode: "guided", coachDismissed: false, tutorialsSeen: { dash: true } };
    const fromJsonb = { mode: "guided", tutorialsSeen: { dash: true }, coachDismissed: false };
    expect(JSON.stringify(local)).not.toBe(JSON.stringify(fromJsonb)); // the trap
    expect(stableStringify(local)).toBe(stableStringify(fromJsonb)); // the fix
  });

  it("sorts nested objects recursively", () => {
    expect(stableStringify({ b: { d: 1, c: 2 }, a: 3 })).toBe('{"a":3,"b":{"c":2,"d":1}}');
  });

  it("preserves array order (arrays are ordered data, not bags)", () => {
    expect(stableStringify({ xs: [2, 1] })).toBe('{"xs":[2,1]}');
    expect(stableStringify({ xs: [2, 1] })).not.toBe(stableStringify({ xs: [1, 2] }));
  });

  it("still distinguishes genuinely different values", () => {
    expect(stableStringify({ mode: "guided" })).not.toBe(stableStringify({ mode: "off" }));
    expect(stableStringify(null)).not.toBe(stableStringify({}));
  });

  it("handles scalars and null like JSON.stringify", () => {
    expect(stableStringify("RON")).toBe('"RON"');
    expect(stableStringify(true)).toBe("true");
    expect(stableStringify(null)).toBe("null");
  });
});
