/**
 * THE THREE-STATE NAV LAW.
 *
 * `_features.py` has documented this contract from the start, and both
 * halves of it have been broken in one day:
 *
 *   active      — a working surface. Normal row.
 *   coming_soon — real on the roadmap, not built. The row STAYS, muted,
 *                 and its route renders PendingState.
 *   hidden      — deliberately off the menu. The row does not render.
 *
 * FIRST BREAK: the launch cut set ten live features to `hidden`, and the
 * sidebar dropped every one, so the owner opened the app and asked where
 * their features had gone. Nothing had been removed — but a vanished row
 * reads as data loss and teaches nothing.
 *
 * SECOND BREAK: fixing that by keeping ALL rows collapsed `hidden` into
 * `coming_soon`, so the owner could no longer take anything off the menu.
 * They then asked for exactly that: Inventory hidden because Products
 * already carries SKU-level stock detail and the trial balance carries
 * the class-3 accounts, and Receivables & Payables hidden until
 * e-Factura ingestion lands.
 *
 * So the law is three states, not two, and the part that keeps `hidden`
 * honest is the last assertion here: hiding a row is a MENU decision, and
 * the route must still render PendingState. A deep link, an old bookmark
 * or a stale tab explains itself instead of breaking.
 *
 * WHAT THIS REDS ON (TC-11)
 *   · a `coming_soon` row vanishing — the owner's original complaint;
 *   · a `hidden` row still rendering — the owner cannot clear the menu;
 *   · an unreachable registry emptying the nav, or worse, rendering rows
 *     as though the features worked;
 *   · an `active` feature marked pending, which makes a working surface
 *     look unavailable.
 * WHAT IT CANNOT SEE: the rendered PendingState copy itself, and whether
 * a route behind an `active` flag actually works — `e2e/launch-route-cut`
 * walks those.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

const featuresMock = vi.hoisted(() => ({
  value: {} as Record<string, { status: string }>,
  loading: false,
}));

vi.mock("@/lib/features", () => ({
  useFeatures: () => ({
    features: featuresMock.value,
    loading: featuresMock.loading,
    refresh: async () => {},
  }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
// PendingState's "Notify me" button reads the session to decide whether it
// can record interest. The route assertion below is about WHAT RENDERS, not
// about auth, so the session is stubbed signed-out — the honest default and
// the one that exercises the button's own guard.
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ isAuthenticated: false, user: null, session: null }),
}));
vi.mock("@/lib/prefs", () => ({
  getRemotePref: async () => null,
  setPref: async () => {},
}));

import { SHELL_NAV_ALL, useShellNav } from "@/components/cfo/Sidebar";

/** Rows gated by the registry rather than by a build flag. */
const REGISTRY_ROWS = SHELL_NAV_ALL.filter(
  (i) => i.featureKey && i.to !== "/decisions" && i.to !== "/alerts",
);

function navRows() {
  const { result } = renderHook(() => useShellNav());
  return result.current.flatMap((g) => g.items);
}

function setAll(status: string) {
  featuresMock.value = Object.fromEntries(
    REGISTRY_ROWS.map((i) => [i.featureKey as string, { status }]),
  );
}

beforeEach(() => {
  featuresMock.value = {};
  featuresMock.loading = false;
});

describe("the three-state nav law", () => {
  it("is not vacuous — there are registry-gated rows to reason about", () => {
    expect(REGISTRY_ROWS.length).toBeGreaterThanOrEqual(6);
  });

  it("keeps a coming_soon row, muted — a roadmap feature must not vanish", () => {
    setAll("coming_soon");
    const rows = navRows();
    for (const item of REGISTRY_ROWS) {
      const row = rows.find((r) => r.to === item.to);
      expect(
        row,
        `${item.to} vanished while its feature was coming_soon — the owner's ` +
          `report was "where did my features go"; a roadmap feature keeps ` +
          `its row and renders PendingState`,
      ).toBeTruthy();
      expect(row!.pending, `${item.to} was kept but not marked pending`).toBe(true);
    }
  });

  it("drops a hidden row — the owner can take something off the menu", () => {
    setAll("hidden");
    const rows = navRows();
    for (const item of REGISTRY_ROWS) {
      expect(
        rows.find((r) => r.to === item.to),
        `${item.to} is hidden and still rendered — Inventory and ` +
          `Receivables & Payables were hidden deliberately, and a menu that ` +
          `cannot be cleared is not a menu`,
      ).toBeUndefined();
    }
  });

  it("marks nothing pending when every feature is active", () => {
    setAll("active");
    expect(
      navRows().filter((r) => r.pending).map((r) => r.to),
      "an active feature was marked pending — a working surface must not look unavailable",
    ).toEqual([]);
  });

  it("treats an unreachable registry as pending, never as active and never as gone", () => {
    featuresMock.value = {};
    const rows = navRows();
    for (const item of REGISTRY_ROWS) {
      const row = rows.find((r) => r.to === item.to);
      expect(row, `${item.to} vanished while the registry was unreachable`).toBeTruthy();
      expect(row!.pending).toBe(true);
    }
  });

  it("never marks the ungated rows — Dashboard and Workspaces always stand", () => {
    featuresMock.value = {};
    const rows = navRows();
    for (const to of ["/dashboard", "/workspace"]) {
      const row = rows.find((r) => r.to === to);
      expect(row, `${to} must always be reachable`).toBeTruthy();
      expect(row!.pending).toBeFalsy();
    }
  });
});

describe("hiding a row is a menu decision, never a broken screen", () => {
  it("a hidden feature's ROUTE still renders PendingState", async () => {
    // The half that keeps `hidden` honest. FeatureRoute opens only on
    // `active`; everything else — hidden included — renders PendingState,
    // so a deep link or an old bookmark to /inventory explains itself.
    const { FeatureRoute } = await import("@/components/cfo/FeatureRoute");
    const { render, screen } = await import("@testing-library/react");

    featuresMock.value = { inventory: { status: "hidden" } };
    render(
      <FeatureRoute featureKey={"inventory" as never}>
        <div data-testid="the-real-screen">the real screen</div>
      </FeatureRoute>,
    );
    expect(screen.queryByTestId("the-real-screen")).toBeNull();
    expect(screen.getByTestId("pending-state")).toBeTruthy();
  });
});
