// The `workspace_v2` gate — a feature whose registry status is `preview` is
// on ONLY for a signed-in user whose user_prefs.prefs.preview_features names
// it; `active` (the engine's CFO_FEATURES_ACTIVE promotion) is on for all;
// anything else is off. And a preview feature never opens a FeatureRoute for
// anyone — routes open on `active` only.
import { act, render, renderHook, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ status: "signed_in" as string, user: { id: "u-owner" } as { id: string } | null }));
vi.mock("@/lib/auth", () => ({ useAuth: () => auth }));

const prefs = vi.hoisted(() => {
  const listeners = new Set<(scope: string) => void>();
  return {
    hydrated: true,
    bag: { preview_features: ["workspace_v2"] } as Record<string, unknown>,
    listeners,
  };
});
vi.mock("@/lib/prefs", () => ({
  prefsHydrated: () => prefs.hydrated,
  getRemotePref: (_scope: string, key: string) => prefs.bag[key],
  subscribePrefs: (cb: (scope: string) => void) => {
    prefs.listeners.add(cb);
    return () => prefs.listeners.delete(cb);
  },
}));

import { __clearFeaturesForTest, __setFeaturesForTest, type FeatureStatus } from "@/lib/features";
import { isFeatureOnFor, useFeatureEnabled, useUploadRoute } from "@/lib/previewFeatures";
import { FeatureRoute } from "@/components/cfo/FeatureRoute";

function registry(status: FeatureStatus) {
  __setFeaturesForTest({ workspace_v2: { status, label: "Workspace redesign", description: "" } });
}

beforeEach(() => {
  auth.status = "signed_in";
  auth.user = { id: "u-owner" };
  prefs.hydrated = true;
  prefs.bag = { preview_features: ["workspace_v2"] };
  try {
    localStorage.removeItem("cfoai.preview_features.v1");
  } catch {
    /* ignore */
  }
});
afterEach(() => __clearFeaturesForTest());

describe("isFeatureOnFor — the decision", () => {
  it.each<[FeatureStatus | undefined, string[], boolean, boolean]>([
    ["active", [], false, true],
    ["active", [], true, true],
    ["preview", ["workspace_v2"], true, true],
    ["preview", [], true, false],
    ["preview", ["other_key"], true, false],
    ["preview", ["workspace_v2"], false, false], // signed out: never
    ["hidden", ["workspace_v2"], true, false],
    ["coming_soon", ["workspace_v2"], true, false],
    [undefined, ["workspace_v2"], true, false], // registry unreachable: off
  ])("%s · opted %j · signed-in %s → %s", (status, opted, signedIn, on) => {
    expect(isFeatureOnFor(status, opted, "workspace_v2", signedIn)).toBe(on);
  });
});

describe("useFeatureEnabled — registry × the user's opt-in", () => {
  it("preview + opted in → on", () => {
    registry("preview");
    const { result } = renderHook(() => useFeatureEnabled("workspace_v2"));
    expect(result.current).toEqual({ enabled: true, loading: false });
  });

  it("preview + not opted in → off (the current UI stays)", () => {
    registry("preview");
    prefs.bag = {};
    const { result } = renderHook(() => useFeatureEnabled("workspace_v2"));
    expect(result.current.enabled).toBe(false);
  });

  it("preview + signed out → off", () => {
    registry("preview");
    auth.status = "signed_out";
    auth.user = null;
    const { result } = renderHook(() => useFeatureEnabled("workspace_v2"));
    expect(result.current.enabled).toBe(false);
  });

  it("active → on for a user who never opted in", () => {
    registry("active");
    prefs.bag = {};
    const { result } = renderHook(() => useFeatureEnabled("workspace_v2"));
    expect(result.current.enabled).toBe(true);
  });

  it("an opt-in that lands after first paint turns it on; the next paint starts on", () => {
    registry("preview");
    prefs.hydrated = false;
    prefs.bag = {};
    const { result, unmount } = renderHook(() => useFeatureEnabled("workspace_v2"));
    // Nothing known yet: a screen-swapping route holds rather than flashing.
    expect(result.current).toEqual({ enabled: false, loading: true });
    act(() => {
      prefs.hydrated = true;
      prefs.bag = { preview_features: ["workspace_v2"] };
      prefs.listeners.forEach((l) => l("user"));
    });
    expect(result.current).toEqual({ enabled: true, loading: false });
    unmount();
    // Reload: the per-user cache paints ON before the prefs read lands.
    prefs.hydrated = false;
    const second = renderHook(() => useFeatureEnabled("workspace_v2"));
    expect(second.result.current).toEqual({ enabled: true, loading: false });
  });

  it("another user's cached opt-in is never inherited", () => {
    registry("preview");
    prefs.hydrated = false;
    localStorage.setItem("cfoai.preview_features.v1", JSON.stringify({ uid: "u-other", keys: ["workspace_v2"] }));
    const { result } = renderHook(() => useFeatureEnabled("workspace_v2"));
    expect(result.current.enabled).toBe(false);
  });

  it("'Upload' shortcuts lead to the redesign's home only when it is on", () => {
    registry("preview");
    expect(renderHook(() => useUploadRoute("/dashboard")).result.current).toBe("/workspace");
    prefs.bag = {};
    expect(renderHook(() => useUploadRoute("/dashboard")).result.current).toBe("/dashboard");
  });
});

describe("FeatureRoute opens on `active` only", () => {
  it("a preview feature renders the pending page, never the route, even for an opted-in user", () => {
    registry("preview");
    render(
      <MemoryRouter>
        <FeatureRoute featureKey="workspace_v2">
          <div data-testid="guarded-content" />
        </FeatureRoute>
      </MemoryRouter>,
    );
    expect(screen.queryByTestId("guarded-content")).toBeNull();
  });
});
