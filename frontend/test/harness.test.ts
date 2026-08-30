// Harness self-test — proves the test ENVIRONMENT works before any suite
// relies on it.
//
// ── WHY ───────────────────────────────────────────────────────────────
// 7 of the 19 standing vitest failures were not product bugs and not test
// bugs. They were one environment defect: Node 25 installs its own
// `localStorage` / `sessionStorage` globals, and with no `--localstorage-file`
// configured the value degrades to a bare `{}` — no getItem, no setItem, no
// clear. That global occupies the name before vitest's jsdom environment can
// install jsdom's working Storage, so every test saw a dud and calls as
// ordinary as `localStorage.clear()` threw `is not a function`.
//
// The failures surfaced far from the cause, in four unrelated feature suites,
// each of which looked like its own separate "pre-existing" problem. ~18 test
// files had independently hand-rolled a private storage stub to get around
// it. Nothing anywhere stated the requirement, so nothing could report it
// broken — the diagnosis had to be re-derived from scratch every time.
//
// This file states it. If the shim regresses — a Node upgrade changes the
// shape again, an import order shifts, someone deletes it as unused — these
// assertions fail immediately, by name, in a file whose title says the
// environment is at fault. That is the difference between one red line
// naming the cause and a scattering of confusing failures in feature suites.
//
// It doubles as the battery gate's canary: a vitest gate that runs zero
// tests, or whose discovery silently breaks, must not be able to report
// green, and it can prove it ran by finding this file's assertions.

import { describe, it, expect } from "vitest";

describe("test harness — environment invariants", () => {
  describe("web storage is real, not the Node 25 stub", () => {
    for (const name of ["localStorage", "sessionStorage"] as const) {
      it(`${name} implements the full Storage interface`, () => {
        const store = (globalThis as Record<string, unknown>)[name] as Storage;
        expect(store, `${name} global is missing entirely`).toBeTruthy();
        // The exact shape of the Node 25 defect: the object exists and is
        // truthy, so a `typeof` check passes, but every method is absent.
        expect(typeof store.getItem).toBe("function");
        expect(typeof store.setItem).toBe("function");
        expect(typeof store.removeItem).toBe("function");
        expect(typeof store.clear).toBe("function");
        expect(typeof store.key).toBe("function");
      });

      it(`${name} round-trips values with real Storage semantics`, () => {
        const store = (globalThis as Record<string, unknown>)[name] as Storage;
        store.clear();

        // Absent keys are null, NOT undefined. Product code branches on
        // `=== null`; a stub returning undefined would pass a lazy test and
        // diverge from the browser.
        expect(store.getItem("__absent__")).toBeNull();

        store.setItem("k", "v");
        expect(store.getItem("k")).toBe("v");
        expect(store.length).toBe(1);
        expect(store.key(0)).toBe("k");

        // Storage stringifies on write.
        store.setItem("n", 42 as unknown as string);
        expect(store.getItem("n")).toBe("42");

        store.removeItem("k");
        expect(store.getItem("k")).toBeNull();

        store.clear();
        expect(store.length).toBe(0);
      });
    }

    it("window and the bare global are the same storage", () => {
      // A split between `localStorage` and `window.localStorage` would be
      // worse than the bug the shim fixes: writes through one would be
      // invisible to code reading the other, and only some tests would show
      // it. Product code uses both spellings.
      expect(window.localStorage).toBe(globalThis.localStorage);
      window.localStorage.setItem("__shared__", "1");
      expect(globalThis.localStorage.getItem("__shared__")).toBe("1");
      window.localStorage.clear();
    });
  });

  it("storage does not leak across test files", () => {
    // setupFiles run once per test file, so each file gets a fresh store.
    // If this key is ever already present, files are sharing state and
    // suites have become order-dependent.
    expect(localStorage.getItem("__leak_probe__")).toBeNull();
    localStorage.setItem("__leak_probe__", "1");
  });
});
