// THE THREAD — Escape collapses, ten minutes preserves, a scope change
// discards.

import { afterEach, describe, expect, it } from "vitest";

import { newTurn } from "../capsuleAnswerClient";
import {
  THREAD_TTL_MS,
  __resetCapsuleThreadForTests,
  clearThread,
  collapseThread,
  getThread,
  openThread,
  patchTurn,
  pushTurn,
} from "../capsuleThread";
import {
  __resetCapsulePackForTests,
  inPack,
  packEntries,
  togglePack,
} from "../capsuleExportPack";

afterEach(() => {
  __resetCapsuleThreadForTests();
  __resetCapsulePackForTests();
});

const T0 = 1_000_000;

describe("collapse and resume", () => {
  it("keeps the thread across a collapse inside the grace window", () => {
    openThread("p1", T0);
    pushTurn(newTurn("a", "assets?", T0));
    collapseThread(T0);
    expect(getThread(T0 + THREAD_TTL_MS - 1).turns).toHaveLength(1);
    expect(openThread("p1", T0 + THREAD_TTL_MS - 1)).toBe(true);
  });

  it("drops it one millisecond past the window", () => {
    openThread("p1", T0);
    pushTurn(newTurn("a", "assets?", T0));
    collapseThread(T0);
    expect(getThread(T0 + THREAD_TTL_MS + 1).turns).toEqual([]);
    expect(openThread("p1", T0 + THREAD_TTL_MS + 1)).toBe(false);
  });

  it("expires on READ, so a backgrounded tab ages on the same schedule", () => {
    openThread("p1", T0);
    pushTurn(newTurn("a", "assets?", T0));
    collapseThread(T0);
    // No timer fired; the read alone must clear it.
    expect(getThread(T0 + THREAD_TTL_MS + 5).turns).toEqual([]);
    expect(getThread(T0 + 1).turns).toEqual([]);
  });

  it("discards a thread asked against a different period", () => {
    openThread("dec", T0);
    pushTurn(newTurn("a", "assets?", T0));
    collapseThread(T0);
    expect(openThread("jan", T0 + 1000)).toBe(false);
    expect(getThread(T0 + 1000).turns).toEqual([]);
  });

  it("a fresh open on the same scope with no turns is not a resume", () => {
    expect(openThread("p1", T0)).toBe(false);
  });
});

describe("turn bookkeeping", () => {
  it("patches in place and keeps order", () => {
    openThread("p1", T0);
    pushTurn(newTurn("a", "one", T0));
    pushTurn(newTurn("b", "two", T0));
    const updated = { ...newTurn("a", "one", T0), status: "done" as const };
    patchTurn(updated);
    const turns = getThread(T0).turns;
    expect(turns.map((t) => t.id)).toEqual(["a", "b"]);
    expect(turns[0].status).toBe("done");
  });

  it("ignores a patch for a turn that is not in the thread", () => {
    openThread("p1", T0);
    pushTurn(newTurn("a", "one", T0));
    patchTurn(newTurn("ghost", "x", T0));
    expect(getThread(T0).turns).toHaveLength(1);
  });

  it("clear wipes everything", () => {
    openThread("p1", T0);
    pushTurn(newTurn("a", "one", T0));
    clearThread();
    expect(getThread(T0).turns).toEqual([]);
  });
});

describe("export pack", () => {
  const entry = {
    id: "turn-1",
    question: "assets?",
    answer: "Total assets: RON 293,050,085.11",
    currency: "RON",
    periods: ["Dec 2025"],
    snapshot: "snap-a1b2c3d4",
    trust: "Balanced",
    addedAt: T0,
  };

  it("toggles membership", () => {
    expect(inPack("turn-1")).toBe(false);
    expect(togglePack(entry)).toBe(true);
    expect(inPack("turn-1")).toBe(true);
    expect(togglePack(entry)).toBe(false);
    expect(packEntries()).toEqual([]);
  });

  it("stores resolved native text, never a placeholder template", () => {
    togglePack(entry);
    const stored = packEntries()[0];
    expect(stored.answer).not.toContain("{{");
    expect(stored.currency).toBe("RON");
    expect(stored.trust).toBe("Balanced");
  });
});
