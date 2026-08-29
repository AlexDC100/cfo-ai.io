// THE DIAL — M5, UI half (switcher): the ModeSwitch drives the shared
// view-mode store and the choice PERSISTS across a full unmount/remount
// (localStorage via lib/viewMode — the component itself stores nothing).
//
// prefs is mocked: persistence-to-server is fire-and-forget product
// plumbing (asserted by call, not by wire), and usePrefSync would
// otherwise reach for Supabase in tests.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prefs", () => ({
  setPref: vi.fn(),
  usePrefSync: vi.fn(),
}));

import { setPref } from "@/lib/prefs";
import { getViewMode } from "@/lib/viewMode";
import { ModeSwitch } from "../ModeSwitch";

// This jsdom build exposes localStorage as a bare object with no working
// methods (same as lib/__tests__/viewModes.test.ts) — install an
// in-memory Storage, which also keeps the suite hermetic.
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

beforeEach(() => {
  bag.clear();
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("<ModeSwitch> — M5 UI half", () => {
  it("renders both segments with Simple active by default", () => {
    render(<ModeSwitch />);
    expect(screen.getByTestId("mode-switch-simple")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("mode-switch-pro")).toHaveAttribute("aria-checked", "false");
  });

  it("clicking Pro switches the shared store and re-renders the control", () => {
    render(<ModeSwitch />);
    fireEvent.click(screen.getByTestId("mode-switch-pro"));
    expect(getViewMode()).toBe("pro");
    expect(screen.getByTestId("mode-switch-pro")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("mode-switch-simple")).toHaveAttribute("aria-checked", "false");
  });

  it("the choice persists across unmount/remount (localStorage) and mirrors to prefs", () => {
    render(<ModeSwitch />);
    fireEvent.click(screen.getByTestId("mode-switch-pro"));
    expect(bag.get("cfo-view-mode-v1")).toBe("pro");
    expect(setPref).toHaveBeenCalledWith("user", "view_mode", "pro");

    cleanup();
    render(<ModeSwitch />);
    expect(screen.getByTestId("mode-switch-pro")).toHaveAttribute("aria-checked", "true");
  });

  it("switching back to Simple is an explicit choice, not a default", () => {
    render(<ModeSwitch />);
    fireEvent.click(screen.getByTestId("mode-switch-pro"));
    fireEvent.click(screen.getByTestId("mode-switch-simple"));
    expect(getViewMode()).toBe("simple");
    // Persisted as an explicit value — a later role change cannot flip it.
    expect(bag.get("cfo-view-mode-v1")).toBe("simple");
  });
});
