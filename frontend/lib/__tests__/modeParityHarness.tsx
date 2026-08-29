// THE DIAL — gate M1 harness: render one fixture in BOTH modes.
//
// Hard rule 1 (modes are presentation only) is enforced by rendering the
// same component tree under mode=simple and mode=pro and asserting the
// FIGURES are cent-identical strings. This module is the shared machinery:
// the story-dashboard lane's parity test imports `renderBothModes` and
// asserts with `expectParityBySelector`; other lanes may reuse it for any
// mode-aware surface.
//
// Written defensively on purpose: it imports NOTHING from the story
// lane's components (they may not exist yet when this lands), installs a
// working localStorage when the jsdom build ships a broken stub (see
// viewModes.test.ts for the same workaround), and forces the mode by
// writing the persisted key directly — no `setViewMode` side effects
// (prefs sync) inside tests.
//
// Not a test file itself (no .test in the name) — vitest will not
// collect it. The companion smoke test is modeParityHarness.test.tsx.

import { ReactNode } from "react";
import { render, RenderResult } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { getViewMode, type ViewMode } from "@/lib/viewMode";

// The persisted key from lib/viewMode.ts (not exported there — the smoke
// test asserts this constant still steers getViewMode(), so a silent
// rename upstream fails loudly here instead of rendering the wrong mode).
export const MODE_STORAGE_KEY = "cfo-view-mode-v1";

// ── localStorage that actually works ───────────────────────────────────

/** Some jsdom builds expose `localStorage` without working methods.
 *  Install a Map-backed Storage when a round-trip probe fails; return
 *  the storage-like object either way. Idempotent. */
export function ensureTestLocalStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem" | "clear"> {
  const probeKey = "__mode-harness-probe__";
  try {
    localStorage.setItem(probeKey, "1");
    if (localStorage.getItem(probeKey) === "1") {
      localStorage.removeItem(probeKey);
      return localStorage;
    }
  } catch {
    /* fall through to the stub */
  }
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
  return stub;
}

/** Force the persisted view mode for the NEXT render. Direct storage
 *  write — components read the mode per render via useSyncExternalStore's
 *  getSnapshot, so a fresh tree picks this up without a notify. */
export function forceViewMode(mode: ViewMode): void {
  ensureTestLocalStorage().setItem(MODE_STORAGE_KEY, mode);
}

// ── the both-modes renderer ────────────────────────────────────────────

export interface ModeRender {
  mode: ViewMode;
  /** Detached clone of the rendered container — safe to query after the
   *  live tree was unmounted. */
  container: HTMLElement;
  html: string;
  text: string;
}

export interface BothModes {
  simple: ModeRender;
  pro: ModeRender;
}

function wrapProviders(ui: ReactNode): ReactNode {
  // Defensive provider stack: mode-aware components in this codebase can
  // reach for tooltips (<Term>, <Amount>), the router (period links) and
  // TanStack Query. Retries off so an absent backend fails fast in tests.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TooltipProvider>{ui}</TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

/**
 * Render `fixture` once per mode. The trees are rendered SEQUENTIALLY and
 * unmounted in between — both modes subscribe to the same mode store, so
 * two live trees would flip together on the second mode write.
 *
 * `fixture` may be a plain node or a `(mode) => node` factory (a factory
 * gets a fresh element per render — required for components that keep
 * internal state keyed on identity).
 */
export function renderBothModes(fixture: ReactNode | ((mode: ViewMode) => ReactNode)): BothModes {
  const out: Partial<BothModes> = {};
  for (const mode of ["simple", "pro"] as const) {
    forceViewMode(mode);
    if (getViewMode() !== mode) {
      throw new Error(
        `modeParityHarness: forceViewMode("${mode}") did not take — ` +
          `lib/viewMode.ts no longer reads "${MODE_STORAGE_KEY}"? Update MODE_STORAGE_KEY.`,
      );
    }
    const ui = typeof fixture === "function" ? fixture(mode) : fixture;
    const result: RenderResult = render(wrapProviders(ui));
    const clone = result.container.cloneNode(true) as HTMLElement;
    out[mode] = {
      mode,
      container: clone,
      html: clone.innerHTML,
      text: clone.textContent ?? "",
    };
    result.unmount();
  }
  return out as BothModes;
}

// ── parity assertions ──────────────────────────────────────────────────

/** Text content (trimmed) of every node matching `selector`, in DOM
 *  order. Use data-testid selectors shared by both arrangements. */
export function textsBySelector(container: HTMLElement, selector: string): string[] {
  return Array.from(container.querySelectorAll(selector)).map((n) =>
    (n.textContent ?? "").trim(),
  );
}

/**
 * THE M1 assertion: every element matching `selector` renders the exact
 * same string in Simple and Pro. Cent-identical means STRING-identical —
 * a formatting drift ("1.2 M" vs "1,235,000") is a failure even when the
 * underlying number matches.
 *
 * Both modes must also AGREE ON THE COUNT of matched nodes: a figure that
 * exists in Pro but not Simple is an arrangement choice (allowed) only
 * when it is NOT marked with the shared parity selector.
 */
export function expectParityBySelector(both: BothModes, selector: string): void {
  const simple = textsBySelector(both.simple.container, selector);
  const pro = textsBySelector(both.pro.container, selector);
  expect(simple.length, `parity selector "${selector}" matched nothing in Simple`).toBeGreaterThan(0);
  expect(simple, `mode parity broken for "${selector}" (simple vs pro)`).toEqual(pro);
}

/** Loose helper: every numeric-looking token in the rendered text.
 *  Useful for exploratory checks; the binding gate is the selector-based
 *  assertion above (arrangement legitimately differs between modes, so a
 *  raw token-set comparison is NOT a parity test). */
export function numericStrings(target: ModeRender | HTMLElement | string): string[] {
  const text =
    typeof target === "string"
      ? target
      : "text" in (target as ModeRender)
        ? (target as ModeRender).text
        : ((target as HTMLElement).textContent ?? "");
  const re = /\(?[−+-]?\d[\d.,   ]*(?:\s?[kMB])?\s?(?:€|\$|RON|lei|%|×|x)?\)?/g;
  return (text.match(re) ?? []).map((t) => t.trim()).filter((t) => /\d/.test(t));
}
