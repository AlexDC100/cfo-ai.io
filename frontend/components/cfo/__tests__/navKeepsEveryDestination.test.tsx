/**
 * THE LAUNCH CUT MUST NOT EMPTY THE NAV.
 *
 * The owner opened the app after the cut deployed and asked where their
 * features had gone: the sidebar showed Dashboard and Workspaces and
 * nothing else. `filterByRegistry` had been DROPPING every row whose
 * feature the registry did not report `active`, which is not what the
 * launch spec says — "every unfinished but roadmap-real feature REACHABLE
 * FROM NAV gets a designed PendingState component". A vanished row teaches
 * a user nothing and reads as data loss; a marked row says the feature
 * exists and is not in this release, and its destination explains itself.
 *
 * WHAT THIS REDS ON AFTER THE REPAIR (TC-11)
 *   · a registry status other than `active` removing a row from the nav
 *     (the exact regression the owner hit);
 *   · a row for a non-active feature NOT being marked pending, which would
 *     make it look shipped;
 *   · an `active` feature being marked pending, which would make a working
 *     surface look unavailable.
 * WHAT IT CANNOT SEE: whether the destination itself renders PendingState
 * — that is `FeatureRoute`'s job and `e2e/launch-route-cut.spec.ts` walks
 * it; and the two build-flag rows (/decisions, /alerts), which are
 * compiled out of the product entirely, so there is no route to reach and
 * no honest "not in this release" to show.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

const featuresMock = vi.hoisted(() => ({ value: {} as Record<string, { status: string }> }));

vi.mock("@/lib/features", () => ({
  useFeatures: () => ({ features: featuresMock.value, loading: false, refresh: async () => {} }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { SHELL_NAV_ALL, useShellNav } from "@/components/cfo/Sidebar";

/** Every nav row that is gated by the registry (not by a build flag). */
const REGISTRY_ROWS = SHELL_NAV_ALL.filter(
  (i) => i.featureKey && i.to !== "/decisions" && i.to !== "/alerts",
);

function navRows() {
  const { result } = renderHook(() => useShellNav());
  return result.current.flatMap((g) => g.items);
}

beforeEach(() => {
  featuresMock.value = {};
});

describe("the nav keeps every destination through the launch cut", () => {
  it("is not vacuous — there are registry-gated rows to reason about", () => {
    expect(REGISTRY_ROWS.length).toBeGreaterThanOrEqual(6);
  });

  it("keeps a hidden feature's row and marks it pending", () => {
    featuresMock.value = Object.fromEntries(
      REGISTRY_ROWS.map((i) => [i.featureKey as string, { status: "hidden" }]),
    );
    const rows = navRows();
    for (const item of REGISTRY_ROWS) {
      const row = rows.find((r) => r.to === item.to);
      expect(
        row,
        `${item.to} vanished from the nav when its feature was hidden — the ` +
          `owner's report was "where did my features go"; a hidden feature ` +
          `keeps its row and renders PendingState`,
      ).toBeTruthy();
      expect(row!.pending, `${item.to} was kept but not marked pending`).toBe(true);
    }
  });

  it("marks nothing pending when every feature is active", () => {
    featuresMock.value = Object.fromEntries(
      REGISTRY_ROWS.map((i) => [i.featureKey as string, { status: "active" }]),
    );
    const marked = navRows().filter((r) => r.pending);
    expect(
      marked.map((r) => r.to),
      "an active feature was marked pending — a working surface must not look unavailable",
    ).toEqual([]);
  });

  it("treats an unreachable registry as pending, never as active and never as gone", () => {
    // `features` empty is the fetch failing or not having resolved. The
    // honest reading is "not confirmed working", not "confirmed working"
    // and not "does not exist".
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
