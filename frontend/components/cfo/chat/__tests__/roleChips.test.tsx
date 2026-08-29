// @vitest-environment jsdom
// THE DIAL (Part E) — mode/role-aware chat suggestion chips.
//
//   · Simple mode leads with the three mandate questions ("Can I afford
//     to hire?" / "Why is profit lower than last year?" / "Do I have a
//     cash problem?") for owners and unknowns;
//   · analyst role reorders (valuation-flavoured first) without ever
//     changing membership;
//   · Pro mode returns the pre-modes DSCR/leverage/covenant set,
//     byte-identical (hard rule 3 — nothing pro is removed);
//   · RO strings exist for every chip (tu-form, diacritics);
//   · the list is deterministic — no model call, same input same output.

import { beforeEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";

import i18n from "@/i18n";
import {
  SIMPLE_WORKSPACE_CHIP_DEFS,
  orderChipsForRole,
  useSimpleWorkspacePrompts,
} from "../roleChips";
import { useWorkspacePrompts } from "../CFOEmptyState";

// Hermetic in-memory localStorage — this jsdom build's global has no
// working methods (same workaround as lib/__tests__/viewModes.test.ts).
const bag = new Map<string, string>();
const stub = {
  getItem: (k: string) => bag.get(k) ?? null,
  setItem: (k: string, v: string) => void bag.set(k, String(v)),
  removeItem: (k: string) => void bag.delete(k),
  clear: () => void bag.clear(),
  key: (i: number) => [...bag.keys()][i] ?? null,
  get length() {
    return bag.size;
  },
};
Object.defineProperty(globalThis, "localStorage", { value: stub, configurable: true });

const MODE_KEY = "cfo-view-mode-v1";
const ROLE_KEY = "cfo-user-role-v1";

function seed(mode: "simple" | "pro" | null, role: string | null) {
  bag.clear();
  if (mode) bag.set(MODE_KEY, mode);
  if (role) bag.set(ROLE_KEY, role);
}

const MANDATE_EN = [
  "Can I afford to hire?",
  "Why is profit lower than last year?",
  "Do I have a cash problem?",
];

beforeEach(() => {
  bag.clear();
});

describe("Simple-mode chips — the mandate three lead for owners", () => {
  it("owner role: the three questions are the first three chips", () => {
    seed("simple", "owner");
    const { result } = renderHook(() => useWorkspacePrompts());
    expect(result.current.slice(0, 3).map((p) => p.title)).toEqual(MANDATE_EN);
  });

  it("no role recorded: same three-first order (base order)", () => {
    seed("simple", null);
    const { result } = renderHook(() => useWorkspacePrompts());
    expect(result.current.slice(0, 3).map((p) => p.title)).toEqual(MANDATE_EN);
  });

  it("every chip carries a non-empty title and a longer composer prompt", () => {
    seed("simple", "owner");
    const { result } = renderHook(() => useWorkspacePrompts());
    expect(result.current).toHaveLength(SIMPLE_WORKSPACE_CHIP_DEFS.length);
    for (const p of result.current) {
      expect(p.title.trim()).toBeTruthy();
      expect(p.prompt.trim()).toBeTruthy();
      // No raw i18n keys leaking.
      expect(p.title).not.toContain("roleChips.");
      expect(p.prompt).not.toContain("roleChips.");
    }
  });
});

describe("role ordering — membership never changes, only order", () => {
  it("analyst: valuation-flavoured chips first, rest in base order", () => {
    const ordered = orderChipsForRole(SIMPLE_WORKSPACE_CHIP_DEFS, "analyst");
    const valuationIds = SIMPLE_WORKSPACE_CHIP_DEFS.filter((d) => d.valuation).map((d) => d.id);
    const restIds = SIMPLE_WORKSPACE_CHIP_DEFS.filter((d) => !d.valuation).map((d) => d.id);
    expect(ordered.map((d) => d.id)).toEqual([...valuationIds, ...restIds]);
  });

  it("owner / accountant / null: base order untouched", () => {
    const base = SIMPLE_WORKSPACE_CHIP_DEFS.map((d) => d.id);
    for (const role of ["owner", "accountant", null] as const) {
      expect(orderChipsForRole(SIMPLE_WORKSPACE_CHIP_DEFS, role).map((d) => d.id)).toEqual(base);
    }
  });

  it("analyst hook path: reordered but same membership as owner", () => {
    seed("simple", "analyst");
    const analyst = renderHook(() => useWorkspacePrompts()).result.current;
    seed("simple", "owner");
    const owner = renderHook(() => useWorkspacePrompts()).result.current;
    expect(analyst).toHaveLength(owner.length);
    expect(new Set(analyst.map((p) => p.title))).toEqual(new Set(owner.map((p) => p.title)));
    // Valuation-flavoured chips actually lead.
    expect(analyst[0].title).not.toBe(owner[0].title);
  });
});

describe("Pro mode — the existing DSCR/leverage/covenant set, unchanged", () => {
  it("returns the legacy chatX.prompts.ws list in its original order", () => {
    seed("pro", "owner");
    const { result } = renderHook(() => useWorkspacePrompts());
    const legacyKeys = [
      "risk",
      "cashFlow",
      "pnl",
      "workingCapital",
      "dscr",
      "yoy",
      "leverage",
      "liquidity",
    ];
    expect(result.current.map((p) => p.title)).toEqual(
      legacyKeys.map((k) => i18n.t(`chatX.prompts.ws.${k}.title`)),
    );
    expect(result.current.map((p) => p.prompt)).toEqual(
      legacyKeys.map((k) => i18n.t(`chatX.prompts.ws.${k}.prompt`)),
    );
  });

  it("accountant with no explicit mode defaults to Pro and gets the legacy set", () => {
    seed(null, "accountant");
    const { result } = renderHook(() => useWorkspacePrompts());
    expect(result.current[4].title).toBe(i18n.t("chatX.prompts.ws.dscr.title"));
  });
});

describe("RO strings — complete, tu-form register", () => {
  it("every chip resolves in Romanian, distinct from English", () => {
    const tRo = i18n.getFixedT("ro");
    const tEn = i18n.getFixedT("en");
    for (const d of SIMPLE_WORKSPACE_CHIP_DEFS) {
      const ro = { title: tRo(`roleChips.ws.${d.id}.title`), prompt: tRo(`roleChips.ws.${d.id}.prompt`) };
      const en = { title: tEn(`roleChips.ws.${d.id}.title`), prompt: tEn(`roleChips.ws.${d.id}.prompt`) };
      expect(ro.title.trim(), `${d.id}.title.ro`).toBeTruthy();
      expect(ro.prompt.trim(), `${d.id}.prompt.ro`).toBeTruthy();
      expect(ro.title, `${d.id} ro title untranslated`).not.toBe(en.title);
      expect(ro.title).not.toContain("roleChips.");
    }
  });

  it("the mandate three have their RO equivalents", () => {
    const tRo = i18n.getFixedT("ro");
    expect(tRo("roleChips.ws.hire.title")).toBe("Îmi permit să angajez?");
    expect(tRo("roleChips.ws.profitWhy.title")).toBe("De ce e profitul mai mic decât anul trecut?");
    expect(tRo("roleChips.ws.cashProblem.title")).toBe("Am o problemă de bani?");
  });
});

describe("determinism — same input, same output, no model call", () => {
  it("two independent renders produce identical lists", () => {
    seed("simple", "owner");
    const a = renderHook(() => useSimpleWorkspacePrompts("owner")).result.current;
    const b = renderHook(() => useSimpleWorkspacePrompts("owner")).result.current;
    expect(a.map((p) => [p.title, p.prompt])).toEqual(b.map((p) => [p.title, p.prompt]));
  });
});
