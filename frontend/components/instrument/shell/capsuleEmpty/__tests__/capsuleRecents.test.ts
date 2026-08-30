/**
 * THE CAPSULE — recent questions gate (Part D.3).
 *
 * Three properties the surface depends on:
 *   · newest first, de-duplicated on the ROUTER's folded form (so the
 *     palette and the recents list agree on what "the same question" is);
 *   · scoped per workspace — one company's questions never appear in
 *     another's palette;
 *   · ⌘K → ArrowUp recalls the last question, and arrowing back down
 *     returns to the empty composing position rather than sticking.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MAX_RECENTS,
  MAX_RECENT_LENGTH,
  capsuleRecents,
  clearCapsuleRecents,
  rememberCapsuleQuestion,
  resetCapsuleRecentsCache,
  useCapsuleRecall,
  useCapsuleRecents,
} from "../capsuleRecents";

const ORG_A = "org-a";
const ORG_B = "org-b";

// This jsdom build exposes `localStorage` as a bare object with no
// methods (see lib/__tests__/viewModes.test.ts, which hit the same wall),
// so the suite installs its own in-memory Storage. It also makes the
// suite hermetic — nothing leaks between files.
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

beforeEach(() => {
  bag.clear();
  resetCapsuleRecentsCache();
});
afterEach(() => {
  // Unmount FIRST: `resetCapsuleRecentsCache` wakes every subscriber, and
  // a still-mounted hook would set state outside act().
  cleanup();
  bag.clear();
  resetCapsuleRecentsCache();
});

describe("recording", () => {
  it("keeps the newest first", () => {
    rememberCapsuleQuestion(ORG_A, "why did receivables jump?");
    rememberCapsuleQuestion(ORG_A, "dscr headroom?");
    expect(capsuleRecents(ORG_A)).toEqual(["dscr headroom?", "why did receivables jump?"]);
  });

  it("de-duplicates on the folded form and MOVES the repeat to the front", () => {
    rememberCapsuleQuestion(ORG_A, "Cash flow?");
    rememberCapsuleQuestion(ORG_A, "dscr headroom?");
    rememberCapsuleQuestion(ORG_A, "  cash   flow ?  ");
    const rows = capsuleRecents(ORG_A);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toBe("cash   flow ?");
    expect(rows[1]).toBe("dscr headroom?");
  });

  it("stores the question AS TYPED — folding is for comparison only", () => {
    rememberCapsuleQuestion(ORG_A, "De ce a scăzut marja?");
    expect(capsuleRecents(ORG_A)[0]).toBe("De ce a scăzut marja?");
  });

  it("caps the list", () => {
    for (let i = 0; i < MAX_RECENTS + 5; i += 1) {
      rememberCapsuleQuestion(ORG_A, `question number ${i}`);
    }
    expect(capsuleRecents(ORG_A)).toHaveLength(MAX_RECENTS);
  });

  it("ignores empty input and a pasted essay", () => {
    rememberCapsuleQuestion(ORG_A, "   ");
    rememberCapsuleQuestion(ORG_A, "");
    rememberCapsuleQuestion(ORG_A, "x".repeat(MAX_RECENT_LENGTH + 1));
    expect(capsuleRecents(ORG_A)).toEqual([]);
  });
});

describe("workspace scoping", () => {
  it("keeps one company's questions out of another's palette", () => {
    rememberCapsuleQuestion(ORG_A, "manufacturer question");
    rememberCapsuleQuestion(ORG_B, "property vehicle question");
    expect(capsuleRecents(ORG_A)).toEqual(["manufacturer question"]);
    expect(capsuleRecents(ORG_B)).toEqual(["property vehicle question"]);
  });

  it("a null workspace has its own bucket rather than leaking into one", () => {
    rememberCapsuleQuestion(null, "signed-out question");
    expect(capsuleRecents(ORG_A)).toEqual([]);
    expect(capsuleRecents(null)).toEqual(["signed-out question"]);
  });

  it("clear empties only the workspace it was called for", () => {
    rememberCapsuleQuestion(ORG_A, "a");
    rememberCapsuleQuestion(ORG_B, "b");
    clearCapsuleRecents(ORG_A);
    expect(capsuleRecents(ORG_A)).toEqual([]);
    expect(capsuleRecents(ORG_B)).toEqual(["b"]);
  });
});

describe("storage failures degrade to empty, never to a throw", () => {
  it("survives an unparseable payload", () => {
    bag.set("cfo:capsule-recents:v1:org-a", "{not json");
    resetCapsuleRecentsCache();
    expect(capsuleRecents(ORG_A)).toEqual([]);
  });

  it("drops non-string members of a hand-edited payload", () => {
    bag.set(
      "cfo:capsule-recents:v1:org-a",
      JSON.stringify(["real question", 42, null, "  ", "another"]),
    );
    resetCapsuleRecentsCache();
    expect(capsuleRecents(ORG_A)).toEqual(["real question", "another"]);
  });
});

describe("useCapsuleRecents — live", () => {
  it("re-renders subscribers when a question is recorded", () => {
    const { result } = renderHook(() => useCapsuleRecents(ORG_A));
    expect(result.current).toEqual([]);
    act(() => rememberCapsuleQuestion(ORG_A, "why is profit down?"));
    expect(result.current).toEqual(["why is profit down?"]);
  });
});

describe("useCapsuleRecall — ⌘K then ArrowUp", () => {
  it("ArrowUp recalls the last question", () => {
    rememberCapsuleQuestion(ORG_A, "older");
    rememberCapsuleQuestion(ORG_A, "newest");
    const { result } = renderHook(() => useCapsuleRecall(ORG_A));

    let recalled: string | null = null;
    act(() => { recalled = result.current.older(); });
    expect(recalled).toBe("newest");
    expect(result.current.value).toBe("newest");
    expect(result.current.index).toBe(0);
  });

  it("walks back through the list and stops at the oldest", () => {
    rememberCapsuleQuestion(ORG_A, "third");
    rememberCapsuleQuestion(ORG_A, "second");
    rememberCapsuleQuestion(ORG_A, "first");
    const { result } = renderHook(() => useCapsuleRecall(ORG_A));

    act(() => { result.current.older(); });
    act(() => { result.current.older(); });
    act(() => { result.current.older(); });
    expect(result.current.value).toBe("third");
    act(() => { result.current.older(); });
    expect(result.current.value).toBe("third");
    expect(result.current.index).toBe(2);
  });

  it("ArrowDown returns to the empty composing position, not to a stuck row", () => {
    rememberCapsuleQuestion(ORG_A, "only one");
    const { result } = renderHook(() => useCapsuleRecall(ORG_A));

    act(() => { result.current.older(); });
    expect(result.current.value).toBe("only one");

    let back: string | null = null;
    act(() => { back = result.current.newer(); });
    expect(back).toBe("");
    expect(result.current.value).toBeNull();
    expect(result.current.index).toBe(-1);
  });

  it("returns null with nothing to recall, so the caller leaves the input alone", () => {
    const { result } = renderHook(() => useCapsuleRecall(ORG_A));
    let recalled: string | null = "sentinel";
    act(() => { recalled = result.current.older(); });
    expect(recalled).toBeNull();
    expect(result.current.count).toBe(0);
  });

  it("reset returns to composing", () => {
    rememberCapsuleQuestion(ORG_A, "q");
    const { result } = renderHook(() => useCapsuleRecall(ORG_A));
    act(() => { result.current.older(); });
    act(() => { result.current.reset(); });
    expect(result.current.index).toBe(-1);
    expect(result.current.value).toBeNull();
  });
});
