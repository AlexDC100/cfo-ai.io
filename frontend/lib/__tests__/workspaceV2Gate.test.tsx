// The `workspace_v2` gate — a feature whose registry status is `preview` is
// on ONLY for a signed-in user whose user_prefs.prefs.preview_features names
// it; `active` (the engine's CFO_FEATURES_ACTIVE promotion) is on for all;
// anything else is off. ONE mechanism decides it — `applyPreview` in
// lib/features.ts, the deployed per-account early access (the same one that
// opens a `coming_soon` surface early) — so an opted-in user's row is served
// `active` + `beta`: a FeatureRoute opens for them with the "Beta" label and
// stays the pending page for everyone else.
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
  // As lib/prefs: nothing is readable before the bag hydrates, and a
  // sign-out resets the bag (`resetPrefs`) — the test below does the same.
  getRemotePref: (_scope: string, key: string) => (prefs.hydrated ? prefs.bag[key] : undefined),
  subscribePrefs: (cb: (scope: string) => void) => {
    prefs.listeners.add(cb);
    return () => prefs.listeners.delete(cb);
  },
}));

import { __clearFeaturesForTest, __setFeaturesForTest, applyPreview, type FeatureStatus } from "@/lib/features";
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
    ["coming_soon", ["workspace_v2"], true, true], // early access, the same mechanism
    ["coming_soon", [], true, false],
    [undefined, ["workspace_v2"], true, false], // registry unreachable: off
  ])("%s · opted %j · signed-in %s → %s", (status, opted, signedIn, on) => {
    expect(isFeatureOnFor(status, opted, "workspace_v2", signedIn)).toBe(on);
  });

  it("is applyPreview on one row — the deployed mechanism, not a second one", () => {
    const row = { status: "preview" as const, label: "", description: "" };
    for (const opted of [["workspace_v2"], [], ["other_key"]]) {
      expect(isFeatureOnFor("preview", opted, "workspace_v2", true)).toBe(
        applyPreview({ workspace_v2: row }, opted).workspace_v2?.status === "active",
      );
    }
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
    // Sign-out resets the prefs bag (lib/org.ts calls `resetPrefs`); a
    // signed-out viewer has no list to be found in.
    prefs.hydrated = false;
    prefs.bag = {};
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

describe("FeatureRoute — a preview row is `active` + Beta for the opted-in user only", () => {
  function routed() {
    return render(
      <MemoryRouter>
        <FeatureRoute featureKey="workspace_v2">
          <div data-testid="guarded-content" />
        </FeatureRoute>
      </MemoryRouter>,
    );
  }

  it("opens the route for an opted-in user, labelled Beta", () => {
    registry("preview");
    routed();
    expect(screen.getByTestId("guarded-content")).toBeTruthy();
    expect(screen.getByTestId("feature-beta-label").textContent).toMatch(/Beta/);
  });

  it("renders the pending page, never the route, for a user who did not opt in", () => {
    registry("preview");
    prefs.bag = {};
    routed();
    expect(screen.queryByTestId("guarded-content")).toBeNull();
    expect(screen.queryByTestId("feature-beta-label")).toBeNull();
  });

  it("an `active` row (CFO_FEATURES_ACTIVE for everyone) opens without the Beta label", () => {
    registry("active");
    prefs.bag = {};
    routed();
    expect(screen.getByTestId("guarded-content")).toBeTruthy();
    expect(screen.queryByTestId("feature-beta-label")).toBeNull();
  });
});
