// THE DIAL — M5, UI half (onboarding): the first-login question stores a
// role (mode follows via the lib), skip stores nothing and leaves Simple,
// and the cfo-onboarding-role-asked-v1 guard makes the page show ONCE —
// every later visit redirects to /workspace like the pre-DIAL hard
// redirect did.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prefs", () => ({
  setPref: vi.fn(),
  getRemotePref: vi.fn(() => undefined),
  usePrefSync: vi.fn(),
}));

import { setPref } from "@/lib/prefs";
import { getViewMode } from "@/lib/viewMode";
import Onboarding, { ROLE_ASKED_KEY } from "../Onboarding";

// In-memory localStorage (this jsdom build ships one without working
// methods — same pattern as lib/__tests__/viewModes.test.ts).
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

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/onboarding"]}>
      <Routes>
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/workspace" element={<div data-testid="workspace-page" />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  bag.clear();
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("/onboarding — first-login role question (M5 UI half)", () => {
  it("first visit renders the question with three options and a quiet skip", () => {
    renderPage();
    expect(screen.getByText("What describes you best?")).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-role-owner")).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-role-accountant")).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-role-analyst")).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-skip")).toBeInTheDocument();
  });

  it("answering stores the role, marks the guard (both mirrors) and moves on", () => {
    renderPage();
    fireEvent.click(screen.getByTestId("onboarding-role-accountant"));
    // Role stored — mode FOLLOWS via the lib's default chain.
    expect(bag.get("cfo-user-role-v1")).toBe("accountant");
    expect(getViewMode()).toBe("pro");
    // Show-once guard: localStorage + user_prefs mirror.
    expect(bag.get(ROLE_ASKED_KEY)).toBe("1");
    expect(setPref).toHaveBeenCalledWith("user", "onboarding_role_asked", true);
    // Continues into the /workspace setup wizard.
    expect(screen.getByTestId("workspace-page")).toBeInTheDocument();
  });

  it("an owner answer keeps Simple", () => {
    renderPage();
    fireEvent.click(screen.getByTestId("onboarding-role-owner"));
    expect(bag.get("cfo-user-role-v1")).toBe("owner");
    expect(getViewMode()).toBe("simple");
  });

  it("skip stores NO role, still marks the guard, and leaves Simple", () => {
    renderPage();
    fireEvent.click(screen.getByTestId("onboarding-skip"));
    expect(bag.has("cfo-user-role-v1")).toBe(false);
    expect(setPref).not.toHaveBeenCalledWith("user", "role", expect.anything());
    expect(bag.get(ROLE_ASKED_KEY)).toBe("1");
    expect(getViewMode()).toBe("simple");
    expect(screen.getByTestId("workspace-page")).toBeInTheDocument();
  });

  it("shows ONCE — a later visit redirects to /workspace without rendering the question", () => {
    bag.set(ROLE_ASKED_KEY, "1");
    renderPage();
    expect(screen.queryByText("What describes you best?")).toBeNull();
    expect(screen.getByTestId("workspace-page")).toBeInTheDocument();
  });
});
