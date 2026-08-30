// THE CAPSULE — intent-router gates.
//
//   C4   the forty-query fixture set, at 100%. Not "most", not "no
//        regressions" — every line, every run.
//   INV-1 exactly one Ask row, always at index 0 or 1, reachable in one
//        keystroke by ArrowDown or Tab from anywhere.
//   INV-2 a model call happens only on the Ask row — and never on the
//        default selection of a navigation, entity or action query.
//        (Credits are live. A router that bills for navigation is a bug
//        with an invoice attached.)
//   PERF  under 5 ms per keystroke, measured the way a user types:
//        every prefix of every fixture, in order.
//   PURE  no fetch, no storage, no clock; same input, same output.
//   i18n  every key the router emits exists in EN and RO.

import { describe, expect, it, beforeEach, vi } from "vitest";

import {
  ASK_ROW_ID,
  CAPSULE_ACTIONS,
  CAPSULE_ENTITY_RULES,
  CAPSULE_ROUTES,
  clearCapsuleRouterCache,
  foldQuery,
  nextIndex,
  routeQuery,
  willCallModel,
  type CapsuleRouterResult,
} from "@/lib/capsuleRouter";
import {
  AMBIGUOUS_FIXTURES,
  CAPSULE_ROUTER_FIXTURES,
  FIXTURE_CONTEXT,
  NAV_NEVER_MODEL,
} from "@/lib/capsuleRouterFixtures";
import strings from "@/lib/capsuleRouterStrings.json";

function run(query: string): CapsuleRouterResult {
  return routeQuery(query, FIXTURE_CONTEXT);
}

beforeEach(() => {
  clearCapsuleRouterCache(FIXTURE_CONTEXT);
});

// ── C4 — the fixture set ────────────────────────────────────────────

describe("C4 — the forty-query fixture set", () => {
  it("has exactly forty distinct queries covering all four lanes", () => {
    expect(CAPSULE_ROUTER_FIXTURES).toHaveLength(40);
    const queries = CAPSULE_ROUTER_FIXTURES.map((f) => f.query);
    expect(new Set(queries).size).toBe(40);
    const lanes = new Set(CAPSULE_ROUTER_FIXTURES.map((f) => f.lane));
    expect([...lanes].sort()).toEqual(["action", "ask", "entity", "navigate"]);
  });

  it.each(CAPSULE_ROUTER_FIXTURES.map((f) => [f.query, f.lane, f.note]))(
    "classifies %j as %s",
    (query, lane, note) => {
      const result = run(query as string);
      expect(
        result.classification.lane,
        `${note}\n  reasons: ${result.classification.reasons.join(", ")}`,
      ).toBe(lane);
    },
  );

  it("classifies all forty with no misses (the aggregate the gate is for)", () => {
    const misses = CAPSULE_ROUTER_FIXTURES.filter(
      (f) => run(f.query).classification.lane !== f.lane,
    );
    expect(misses.map((m) => m.query)).toEqual([]);
  });
});

// ── INV-2 — navigation never burns a model call ─────────────────────

describe("INV-2 — a model call costs a deliberate keystroke", () => {
  it.each(NAV_NEVER_MODEL.map((f) => [f.query]))(
    "Enter on %j never reaches the model",
    (query) => {
      const result = run(query as string);
      expect(willCallModel(result, result.defaultIndex)).toBe(false);
      expect(result.rows[result.defaultIndex].kind).not.toBe("ask");
    },
  );

  it("only the Ask row is a model call, on every fixture", () => {
    for (const fixture of CAPSULE_ROUTER_FIXTURES) {
      const result = run(fixture.query);
      result.rows.forEach((row, i) => {
        expect(willCallModel(result, i)).toBe(row.id === ASK_ROW_ID);
      });
    }
  });

  it("no prefix of a navigation query ever selects Ask by default", () => {
    // Typed character by character, "dashboard" must never pass through
    // a state where Enter would bill a turn — once it matches anything.
    for (const fixture of NAV_NEVER_MODEL) {
      for (let i = 1; i <= fixture.query.length; i += 1) {
        const result = run(fixture.query.slice(0, i));
        if (result.noResults) continue; // nothing matched yet — Ask is the only offer
        expect(
          willCallModel(result, result.defaultIndex),
          `${fixture.query.slice(0, i)} (from ${fixture.query})`,
        ).toBe(false);
      }
    }
  });

  it("makes no network call, ever", () => {
    const fetchSpy = vi.fn();
    const original = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      for (const fixture of CAPSULE_ROUTER_FIXTURES) run(fixture.query);
    } finally {
      globalThis.fetch = original;
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── INV-1 — the Ask row is always one keystroke away ────────────────

describe("INV-1 — Ask is always one keystroke away", () => {
  it("every result carries exactly one Ask row at index 0 or 1", () => {
    const queries = [
      "", " ", ...CAPSULE_ROUTER_FIXTURES.map((f) => f.query),
      "zzz", "qq", "a b c d e f g",
    ];
    for (const query of queries) {
      const result = run(query);
      const askRows = result.rows.filter((r) => r.kind === "ask");
      expect(askRows, query).toHaveLength(1);
      expect(result.askIndex, query).toBeLessThanOrEqual(1);
      expect(result.askInOneKeystroke, query).toBe(true);
    }
  });

  it("one ArrowDown from the default selection lands on Ask", () => {
    for (const fixture of CAPSULE_ROUTER_FIXTURES) {
      const result = run(fixture.query);
      const after = result.askIndex === result.defaultIndex
        ? result.defaultIndex
        : nextIndex(result, result.defaultIndex, "ArrowDown");
      expect(result.rows[after].kind, fixture.query).toBe("ask");
    }
  });

  it("Tab jumps to Ask from anywhere in the list", () => {
    const result = run("cash flow");
    for (let i = 0; i < result.rows.length; i += 1) {
      expect(result.rows[nextIndex(result, i, "Tab")].kind).toBe("ask");
    }
  });

  it("arrow keys stay inside the list", () => {
    const result = run("dashboard");
    expect(nextIndex(result, 0, "ArrowUp")).toBe(0);
    expect(nextIndex(result, result.rows.length - 1, "ArrowDown"))
      .toBe(result.rows.length - 1);
    expect(nextIndex(result, 3, "Home")).toBe(0);
    expect(nextIndex(result, 0, "End")).toBe(result.rows.length - 1);
  });

  it("an empty query offers destinations plus Ask, not a blank panel", () => {
    const result = run("");
    expect(result.rows.length).toBeGreaterThan(1);
    expect(result.rows[0].kind).toBe("route");
    expect(result.askIndex).toBe(1);
  });
});

// ── Ambiguity — both readings are offered ───────────────────────────

describe("ambiguous input returns both readings", () => {
  it.each(AMBIGUOUS_FIXTURES.map((q) => [q]))(
    "%j offers matches AND the Ask row",
    (query) => {
      const result = run(query as string);
      expect(result.classification.ambiguous).toBe(true);
      expect(result.rows.some((r) => r.kind === "ask")).toBe(true);
      expect(result.rows.some((r) => r.kind !== "ask")).toBe(true);
    },
  );

  it("a question that names a page keeps the page reachable", () => {
    const result = run("is the balance sheet balanced");
    expect(result.classification.lane).toBe("ask");
    expect(result.rows.some((r) => r.to?.includes("balance-sheet"))).toBe(true);
    expect(result.rows[0].kind).toBe("ask");
  });

  it("an action that names a page keeps the page reachable", () => {
    const result = run("download report");
    expect(result.classification.lane).toBe("action");
    expect(result.rows[0].kind).toBe("action");
    expect(result.rows.some((r) => r.to === "/report")).toBe(true);
  });
});

// ── Lane-specific behaviour worth pinning ───────────────────────────

describe("lane details", () => {
  it("extracts the entity value, not just the lane", () => {
    expect(run("cont 5121").rows[0].entity)
      .toEqual({ kind: "account_code", value: "5121" });
    expect(run("RO14399840").rows[0].entity)
      .toEqual({ kind: "cui", value: "14399840" });
    expect(run("SNP.BVB").rows[0].entity)
      .toEqual({ kind: "ticker", value: "SNP.BVB" });
    expect(run("TLV").rows[0].entity)
      .toEqual({ kind: "ticker", value: "TLV" });
  });

  it("carries the destination and the command id the host needs", () => {
    expect(run("cash flow").rows[0].to)
      .toBe("/dashboard?tab=statements#cash-flow");
    expect(run("upload trial balance").rows[0].commandId)
      .toBe("capsule.upload");
  });

  it("a one-or-two-word miss is not promoted to a question", () => {
    const result = run("scandiaa");
    expect(result.classification.lane).toBe("navigate");
    expect(result.classification.reasons).toContain("unmatched_short");
    expect(result.noResults).toBe(true);
  });

  it("an unmatched three-word phrase is a question", () => {
    const result = run("supplier concentration risk");
    expect(result.classification.lane).toBe("ask");
    expect(result.classification.reasons).toContain("ask:unmatched_long");
  });

  it("folds diacritics so RO matches with or without them", () => {
    expect(foldQuery("Bilanț")).toBe("bilant");
    expect(run("bilant").classification.lane).toBe("navigate");
    expect(run("bilanț").rows[0].to).toBe(run("bilant").rows[0].to);
  });

  it("matches route prefixes so typing resolves before the last letter", () => {
    const result = run("dashb");
    expect(result.classification.lane).toBe("navigate");
    expect(result.rows[0].to).toBe("/dashboard");
  });
});

// ── PERF + PURITY ───────────────────────────────────────────────────

describe("performance and purity", () => {
  it("classifies a keystroke in well under 5 ms", () => {
    // Cold: every prefix of every fixture, memo cleared, worst case
    // first — this is the shape of a user typing, not a micro-benchmark.
    clearCapsuleRouterCache(FIXTURE_CONTEXT);
    let worst = 0;
    let calls = 0;
    for (const fixture of CAPSULE_ROUTER_FIXTURES) {
      for (let i = 1; i <= fixture.query.length; i += 1) {
        const start = performance.now();
        routeQuery(fixture.query.slice(0, i), FIXTURE_CONTEXT);
        worst = Math.max(worst, performance.now() - start);
        calls += 1;
      }
    }
    expect(calls).toBeGreaterThan(500);
    expect(worst).toBeLessThan(5);
  });

  it("is deterministic — same query, same result", () => {
    for (const fixture of CAPSULE_ROUTER_FIXTURES) {
      clearCapsuleRouterCache(FIXTURE_CONTEXT);
      const first = JSON.stringify(run(fixture.query));
      clearCapsuleRouterCache(FIXTURE_CONTEXT);
      const second = JSON.stringify(run(fixture.query));
      expect(second).toBe(first);
    }
  });

  it("the memo cannot change an answer", () => {
    clearCapsuleRouterCache(FIXTURE_CONTEXT);
    const cold = JSON.stringify(run("balance sheet"));
    const warm = JSON.stringify(run("balance sheet"));
    expect(warm).toBe(cold);
  });

  it("touches no storage", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    try {
      for (const fixture of CAPSULE_ROUTER_FIXTURES) run(fixture.query);
      expect(getItem).not.toHaveBeenCalled();
      expect(setItem).not.toHaveBeenCalled();
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });
});

// ── The rules are data, and the data is complete ────────────────────

describe("rules-as-data hygiene", () => {
  it("every rule id is unique and every route has tokens", () => {
    const ids = [
      ...CAPSULE_ROUTES.map((r) => r.id),
      ...CAPSULE_ACTIONS.map((a) => a.id),
      ...CAPSULE_ENTITY_RULES.map((e) => e.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    for (const route of CAPSULE_ROUTES) {
      expect(route.tokens.length, route.id).toBeGreaterThan(0);
      expect(route.to.startsWith("/"), route.id).toBe(true);
    }
    for (const action of CAPSULE_ACTIONS) {
      expect(action.verbs.length, action.id).toBeGreaterThan(0);
      expect(action.objects.length, action.id).toBeGreaterThan(0);
      expect(action.commandId.startsWith("capsule."), action.id).toBe(true);
    }
  });

  it("every match token is already folded — a rule with an accent in it "
     + "can never fire", () => {
    for (const route of CAPSULE_ROUTES) {
      for (const token of route.tokens) {
        expect(foldQuery(token), `${route.id}: ${token}`).toBe(token);
      }
    }
    for (const action of CAPSULE_ACTIONS) {
      for (const token of [...action.verbs, ...action.objects]) {
        expect(foldQuery(token), `${action.id}: ${token}`).toBe(token);
      }
    }
  });

  it("every emitted i18n key exists in EN and RO", () => {
    const seen = new Set<string>();
    for (const query of ["", ...CAPSULE_ROUTER_FIXTURES.map((f) => f.query)]) {
      for (const row of run(query).rows) {
        seen.add(row.group);
        if (row.labelKey) seen.add(row.labelKey);
      }
    }
    const resolve = (bag: unknown, key: string): unknown =>
      key.split(".").reduce<unknown>(
        (acc, part) =>
          acc && typeof acc === "object"
            ? (acc as Record<string, unknown>)[part]
            : undefined,
        bag,
      );
    for (const key of seen) {
      // Route rows reuse the rail's own `sidebar.*` names, which live in
      // the locale files this lane does not own.
      if (key.startsWith("sidebar.")) continue;
      expect(typeof resolve(strings.en, key), `EN ${key}`).toBe("string");
      expect(typeof resolve(strings.ro, key), `RO ${key}`).toBe("string");
    }
    expect(seen.size).toBeGreaterThan(5);
  });

  it("the RO bundle mirrors the EN bundle exactly", () => {
    const flatten = (bag: unknown, prefix = ""): string[] => {
      if (typeof bag !== "object" || bag === null) return [prefix];
      return Object.entries(bag as Record<string, unknown>).flatMap(([k, v]) =>
        flatten(v, prefix ? `${prefix}.${k}` : k),
      );
    };
    expect(flatten(strings.ro).sort()).toEqual(flatten(strings.en).sort());
  });
});
