// @vitest-environment jsdom
/**
 * PER-ACCOUNT EARLY ACCESS, frontend half (forecast-scenarios-live, converged
 * on release/live d734beed; engine half:
 * tests/engine/test_scenarios_preview_acceptance.py, gate scenarios-preview).
 *
 * ONE mechanism, the deployed one: the engine serves `coming_soon`, and
 * `applyPreview` in `lib/features.ts` opens it per signed-in user — `active`
 * + `beta` when the user's personal prefs bag
 * (`user_prefs.prefs.preview_features`) names the key, the registry's answer
 * for everyone else, whose UI is then exactly what it was. The owner's
 * everyone-on switch is server-side (CFO_FEATURES_ACTIVE), and a key it
 * promotes arrives here as `active` (no Beta label).
 *
 * RED ON (TC-11): an early-access key opening for a user who did not opt in;
 * an opted-in user seeing it muted/pending (the brief: "no grey, no dots");
 * the resolution not following the prefs bag when it hydrates or changes; a
 * non-array opt-in read as a partial one; an `active` or `hidden` row being
 * touched by the opt-in; the sidebar row of an opted-in feature still marked
 * pending or missing its Beta label; an opted-in user's rows grey on a reload
 * while the bag is still on its way (first paint reads this user's cached
 * list — the redesign's own cache key); another user on the same browser
 * inheriting that cached opt-in; a stale cached list outliving the bag.
 * CANNOT SEE: the engine's env promotion (the engine half) or who may write
 * the prefs bag (RLS on user_prefs).
 */

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const prefs = vi.hoisted(() => ({
  bag: null as Record<string, unknown> | null,
  listeners: new Set<(scope: "user" | "org") => void>(),
}));
/** Who is signed in (null: nobody). */
const auth = vi.hoisted(() => ({ uid: null as string | null }));
vi.mock("@/lib/auth", () => ({
  useAuth: () =>
    auth.uid ? { status: "signed_in", user: { id: auth.uid } } : { status: "signed_out", user: null },
}));

vi.mock("@/lib/prefs", () => ({
  getRemotePref: (scope: string, key: string) =>
    scope === "user" && prefs.bag ? prefs.bag[key] : undefined,
  prefsHydrated: (scope: string) => scope === "user" && prefs.bag !== null,
  subscribePrefs: (cb: (scope: "user" | "org") => void) => {
    prefs.listeners.add(cb);
    return () => prefs.listeners.delete(cb);
  },
  setPref: () => undefined,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import {
  __clearFeaturesForTest,
  __setFeaturesForTest,
  getFeatureStatus,
  applyPreview,
  PREVIEW_CACHE_KEY,
  readPreviewCache,
  useFeatures,
  type FeatureRegistry,
} from "@/lib/features";
import { useShellNav } from "@/components/cfo/Sidebar";

const RAW: FeatureRegistry = {
  forecast: { status: "coming_soon", label: "Forecast", description: "" },
  scenarios: { status: "coming_soon", label: "Scenario planning", description: "" },
  benchmarks: { status: "active", label: "Benchmarks", description: "" },
  variance: { status: "hidden", label: "Comparison", description: "" },
  erp_connector: { status: "coming_soon", label: "ERP", description: "" },
};

function hydrate(bag: Record<string, unknown> | null) {
  prefs.bag = bag;
  act(() => {
    prefs.listeners.forEach((l) => l("user"));
  });
}

beforeEach(() => {
  prefs.bag = null;
  prefs.listeners.clear();
  auth.uid = null;
  localStorage.removeItem(PREVIEW_CACHE_KEY);
  __clearFeaturesForTest();
  __setFeaturesForTest(RAW);
});

describe("applyPreview (the one early-access resolver)", () => {
  it("a coming_soon key is active + Beta only for the keys the user opted into", () => {
    const out = applyPreview(RAW, ["forecast"]);
    expect(out.forecast).toMatchObject({ status: "active", beta: true });
    expect(out.scenarios?.status).toBe("coming_soon");
    expect(out.erp_connector?.status).toBe("coming_soon");
  });

  it("an active or hidden row is never touched by an opt-in", () => {
    const out = applyPreview(RAW, ["benchmarks", "variance"]);
    expect(out.benchmarks).toEqual(RAW.benchmarks);
    expect(out.variance?.status).toBe("hidden");
    expect(out.erp_connector?.status).toBe("coming_soon");
  });
});

describe("useFeatures follows the personal prefs bag", () => {
  it("not opted in (or not signed in): coming_soon, the UI as it was", () => {
    const { result } = renderHook(() => useFeatures());
    expect(result.current.features.forecast?.status).toBe("coming_soon");
    expect(getFeatureStatus("forecast")).toBe("coming_soon");
  });

  it("opted in: active the moment the bag lands, and back when it changes", () => {
    const { result } = renderHook(() => useFeatures());
    hydrate({ preview_features: ["forecast", "scenarios"] });
    expect(result.current.features.forecast?.status).toBe("active");
    expect(result.current.features.scenarios?.status).toBe("active");
    expect(getFeatureStatus("scenarios")).toBe("active");
    hydrate({ preview_features: ["scenarios"] });
    expect(result.current.features.forecast?.status).toBe("coming_soon");
  });

  it("a malformed opt-in is no opt-in, never a partial one", () => {
    const { result } = renderHook(() => useFeatures());
    hydrate({ preview_features: "forecast,scenarios" });
    expect(result.current.features.forecast?.status).toBe("coming_soon");
    hydrate({ preview_features: [42, null] });
    expect(result.current.features.forecast?.status).toBe("coming_soon");
  });
});

describe("the sidebar: an opted-in early-access row is a normal row labelled Beta (no grey, no dot)", () => {
  const rows = () => {
    const { result } = renderHook(() => useShellNav());
    return result.current.flatMap((g) => g.items);
  };

  it("opted in: Forecast and Scenarios are not pending", () => {
    hydrate({ preview_features: ["forecast", "scenarios"] });
    const byKey = new Map(rows().map((r) => [r.featureKey, r]));
    expect(byKey.get("forecast")?.pending).toBeFalsy();
    expect(byKey.get("scenarios")?.pending).toBeFalsy();
    expect(byKey.get("forecast")?.beta).toBe(true);
    expect(byKey.get("scenarios")?.beta).toBe(true);
  });

  it("not opted in: both stay in the menu, marked pending, as before", () => {
    const byKey = new Map(rows().map((r) => [r.featureKey, r]));
    expect(byKey.get("forecast")?.pending).toBe(true);
    expect(byKey.get("scenarios")?.pending).toBe(true);
  });
});

describe("first paint: a reload never greys an opted-in user's rows", () => {
  it("before the bag lands, this user's cached list opens the rows", () => {
    auth.uid = "u-owner";
    localStorage.setItem(PREVIEW_CACHE_KEY, JSON.stringify({ uid: "u-owner", keys: ["forecast", "scenarios"] }));
    const { result } = renderHook(() => useFeatures());
    expect(result.current.features.forecast?.status).toBe("active");
    expect(result.current.features.scenarios?.status).toBe("active");
  });

  it("another user on the same browser misses the cache, never inherits it", () => {
    auth.uid = "u-someone-else";
    localStorage.setItem(PREVIEW_CACHE_KEY, JSON.stringify({ uid: "u-owner", keys: ["forecast", "scenarios"] }));
    const { result } = renderHook(() => useFeatures());
    expect(result.current.features.forecast?.status).toBe("coming_soon");
  });

  it("signed out, a cached list opens nothing", () => {
    localStorage.setItem(PREVIEW_CACHE_KEY, JSON.stringify({ uid: "u-owner", keys: ["forecast"] }));
    const { result } = renderHook(() => useFeatures());
    expect(result.current.features.forecast?.status).toBe("coming_soon");
  });

  it("the bag, once read, wins and rewrites the cached list", () => {
    auth.uid = "u-owner";
    localStorage.setItem(PREVIEW_CACHE_KEY, JSON.stringify({ uid: "u-owner", keys: ["forecast", "scenarios"] }));
    const { result } = renderHook(() => useFeatures());
    hydrate({ preview_features: ["scenarios"] });
    expect(result.current.features.forecast?.status).toBe("coming_soon");
    expect(result.current.features.scenarios?.status).toBe("active");
    expect([...(readPreviewCache("u-owner") ?? [])]).toEqual(["scenarios"]);
  });
});
