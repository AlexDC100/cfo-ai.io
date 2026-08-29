// @vitest-environment jsdom
// Mode-dial gates: M2 glossary coverage + M5 default routing (pure half).
// jsdom pinned: .ts tests default to the node environment, where Node's
// stub localStorage global exists but has no working methods.
import { beforeEach, describe, expect, it } from "vitest";

import { GLOSSARY } from "../glossary";
import {
  adoptRemoteViewMode,
  getViewMode,
  setRole,
  setViewMode,
} from "../viewMode";

describe("M2 — glossary coverage", () => {
  it("every entry carries BOTH languages for term, simple label and plain text", () => {
    for (const [id, e] of Object.entries(GLOSSARY)) {
      for (const field of ["term", "simple", "plain"] as const) {
        expect(e[field].en?.trim(), `${id}.${field}.en`).toBeTruthy();
        expect(e[field].ro?.trim(), `${id}.${field}.ro`).toBeTruthy();
      }
      // Dual-label completeness: the Simple label must actually be
      // plain-first — it may not BE the bare term.
      expect(e.simple.en.toLowerCase(), `${id} simple label is not plain-first`)
        .not.toBe(e.term.en.toLowerCase());
    }
  });

  it("plain explanations stay short (1-2 sentences, no lectures)", () => {
    for (const [id, e] of Object.entries(GLOSSARY)) {
      for (const lang of ["en", "ro"] as const) {
        const sentences = e.plain[lang].split(/[.!?]+/).filter((s) => s.trim());
        expect(sentences.length, `${id}.plain.${lang}`).toBeLessThanOrEqual(3);
      }
    }
  });

  it("the brief's core terms are all covered", () => {
    for (const id of [
      "ebitda", "net_debt", "dso", "covenant", "working_capital",
      "leverage", "margin", "liquidity",
    ]) {
      expect(GLOSSARY[id], id).toBeDefined();
    }
  });
});

describe("M5 — default routing (role → mode)", () => {
  // This jsdom build exposes localStorage as a bare object with no
  // methods, so the suite installs its own in-memory Storage — which
  // also makes it hermetic.
  const bag = new Map<string, string>();
  const stub = {
    getItem: (k: string) => bag.get(k) ?? null,
    setItem: (k: string, v: string) => void bag.set(k, String(v)),
    removeItem: (k: string) => void bag.delete(k),
    clear: () => void bag.clear(),
    key: (i: number) => [...bag.keys()][i] ?? null,
    get length() { return bag.size; },
  };
  Object.defineProperty(globalThis, "localStorage", { value: stub, configurable: true });
  const reset = () => bag.clear();
  beforeEach(reset);

  it("unknown users default to Simple — the safer first impression", () => {
    expect(getViewMode()).toBe("simple");
  });

  it("owner → Simple; accountant/CFO and analyst → Pro", () => {
    setRole("owner");
    expect(getViewMode()).toBe("simple");
    reset();
    setRole("accountant");
    expect(getViewMode()).toBe("pro");
    reset();
    setRole("analyst");
    expect(getViewMode()).toBe("pro");
  });

  it("an explicit choice beats the role, and persists", () => {
    setRole("accountant");
    setViewMode("simple");
    expect(getViewMode()).toBe("simple");
    // Role changing later cannot override the explicit choice.
    setRole("analyst");
    expect(getViewMode()).toBe("simple");
  });

  it("KILL-LIST: onboarding can never force Pro on an owner", () => {
    setRole("owner");
    expect(getViewMode()).toBe("simple");
  });

  it("remote adoption accepts only valid modes", () => {
    adoptRemoteViewMode("pro");
    expect(getViewMode()).toBe("pro");
    adoptRemoteViewMode("weird" as never);
    expect(getViewMode()).toBe("pro");
  });
});
