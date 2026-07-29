// F5.0 Phase 1.5 — Global popover stack manager.
//
// The stack is the architectural fix that makes RECURSIVE LearnableNumber
// work cleanly: every <LearnableNumber> click pushes onto a shared stack
// instead of self-rendering a popover. A single global renderer reads the
// stack and paints all popovers, so nested popovers compose without
// nested-portal hell, focus-trap fights, or the close-on-outside-tap
// races that plagued the Radix-Popover-per-instance approach.
//
// Stack semantics:
//   · push(entry)         → add a new popover on top (drill-down)
//   · pop()               → close the top popover (Back button)
//   · clear()             → close all (X button, backdrop tap, route change)
//   · replaceTop(entry)   → swap the top without animation (Phase 4 future)
//
// The renderer is mounted ONCE at the app root (PopoverStackRenderer) so
// popovers escape z-index conflicts in nested cards / drawers / dialogs.

import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useState,
  useMemo,
  type ReactNode,
} from "react";
import { useLocation } from "react-router-dom";

export interface PopoverStackEntry {
  /** Stable id — used as React key + for stack identity. */
  id: string;
  /** Concept registry key. */
  conceptKey: string;
  /** The value that was clicked. */
  value: number;
  /** Origin trigger rect — used for positioning the desktop popover
   *  relative to the originally-clicked element. Mobile ignores this. */
  triggerRect?: DOMRect;
  /** When set, overrides the concept's default format. */
  formatOverride?: import("@/lib/learning/concepts/_schema").ValueFormat;
  /** How the bottom-most entry is presented. "popover" (default) anchors a
   *  floating panel to the trigger; "sheet" slides a panel in from the right
   *  edge (the dashboard KPI cards use this). Only the bottom entry's value is
   *  read — the whole stack, including drill-downs, follows it. */
  presentation?: "popover" | "sheet";
}

interface PopoverStackContextValue {
  stack: PopoverStackEntry[];
  push: (entry: Omit<PopoverStackEntry, "id">) => void;
  pop: () => void;
  clear: () => void;
}

const PopoverStackContext = createContext<PopoverStackContextValue | null>(null);

let idCounter = 0;
function nextId(): string {
  // Math.random/Date.now are intentionally avoided per harness rules.
  return `pop_${++idCounter}`;
}

export function PopoverStackProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<PopoverStackEntry[]>([]);
  const location = useLocation();

  const push = useCallback((entry: Omit<PopoverStackEntry, "id">) => {
    setStack((s) => [...s, { ...entry, id: nextId() }]);
  }, []);

  const pop = useCallback(() => {
    setStack((s) => s.slice(0, -1));
  }, []);

  const clear = useCallback(() => {
    setStack([]);
  }, []);

  // Close all on route change — popovers are ephemeral per-page UI.
  useEffect(() => {
    clear();
  }, [location.pathname, clear]);

  // Esc closes the top popover.
  useEffect(() => {
    if (stack.length === 0) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        pop();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [stack.length, pop]);

  const value = useMemo<PopoverStackContextValue>(
    () => ({ stack, push, pop, clear }),
    [stack, push, pop, clear],
  );

  return (
    <PopoverStackContext.Provider value={value}>
      {children}
    </PopoverStackContext.Provider>
  );
}

export function usePopoverStack(): PopoverStackContextValue {
  const ctx = useContext(PopoverStackContext);
  if (!ctx) {
    // Graceful degradation: if a LearnableNumber renders outside the
    // provider, return no-ops so the click is silently swallowed instead
    // of crashing the page. The provider should be mounted in App.tsx at
    // the same level as ThemeProvider / CurrencyProvider.
    return {
      stack: [],
      push: () => {},
      pop: () => {},
      clear: () => {},
    };
  }
  return ctx;
}
