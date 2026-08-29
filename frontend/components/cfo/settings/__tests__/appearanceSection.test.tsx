// Appearance section — density contract + Paper/Terminal labels.
//
// The load-bearing bits: `data-density` lands on <html> (the attribute IS
// the contract table surfaces consume), localStorage stays the source of
// first paint, and the theme control speaks Paper/Terminal while the
// underlying next-themes values remain "light"/"dark".

import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

// This jsdom build exposes localStorage as a bare object with no working
// methods (same workaround as viewModes.test.ts) — install an in-memory
// Storage for the tests. Imports hoist above this, so the component's
// module-load read still sees the broken global — that path is try/catch
// guarded and falls back to "comfortable", which is also what it does in
// a private browser window.
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

import { ThemeProvider } from "@/theme";
import "@/pages/cfo/settingsXI18n";
import {
  AppearanceSection,
  applyDensityAttr,
  readStoredDensity,
} from "@/components/cfo/settings/AppearanceSection";

describe("density helpers", () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.density;
  });

  it("defaults to comfortable when nothing is stored", () => {
    expect(readStoredDensity()).toBe("comfortable");
  });

  it("reads a stored compact choice and rejects junk", () => {
    localStorage.setItem("cfo-density-v1", "compact");
    expect(readStoredDensity()).toBe("compact");
    localStorage.setItem("cfo-density-v1", "cozy");
    expect(readStoredDensity()).toBe("comfortable");
  });

  it("stamps data-density on <html>", () => {
    applyDensityAttr("compact");
    expect(document.documentElement.dataset.density).toBe("compact");
  });
});

describe("<AppearanceSection />", () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.density;
  });

  function mount() {
    return render(
      <ThemeProvider defaultTheme="light" enableSystem={false}>
        <AppearanceSection />
      </ThemeProvider>,
    );
  }

  it("renders Paper/Terminal labels, not light/dark", () => {
    mount();
    expect(screen.getByTestId("settings-theme-paper").textContent).toContain("Paper");
    expect(screen.getByTestId("settings-theme-terminal").textContent).toContain("Terminal");
  });

  it("switches density: attribute + localStorage follow the click", () => {
    mount();
    fireEvent.click(screen.getByTestId("settings-density-compact"));
    expect(document.documentElement.dataset.density).toBe("compact");
    expect(localStorage.getItem("cfo-density-v1")).toBe("compact");
    fireEvent.click(screen.getByTestId("settings-density-comfortable"));
    expect(document.documentElement.dataset.density).toBe("comfortable");
  });

  it("marks the active density segment aria-checked", () => {
    localStorage.setItem("cfo-density-v1", "compact");
    mount();
    expect(
      screen.getByTestId("settings-density-compact").getAttribute("aria-checked"),
    ).toBe("true");
  });
});
