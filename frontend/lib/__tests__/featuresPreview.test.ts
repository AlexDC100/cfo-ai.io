// @vitest-environment jsdom
/**
 * THE PREVIEW STATUS, frontend half (forecast-scenarios-live; engine half:
 * tests/engine/test_scenarios_preview_acceptance.py, gate scenarios-preview).
 *
 * `preview` is the workspace redesign's mechanism, added compatibly: the
 * engine serves `preview`, and the frontend resolves it ONCE, in
 * `lib/features.ts`, per signed-in user — `active` when the user's personal
 * prefs bag (`user_prefs.prefs.preview_features`) names the key,
 * `coming_soon` for everyone else, whose UI is then exactly what it was. The
 * owner's everyone-on switch is server-side (CFO_FEATURES_ACTIVE), and a key
 * it promotes arrives here as `active`.
 *
 * RED ON (TC-11): a preview key opening for a user who did not opt in; an
 * opted-in user seeing it muted/pending (the brief: "no grey, no dots"); the
 * resolution not following the prefs bag when it hydrates or changes; a
 * non-array opt-in read as a partial one; any status other than `preview`
 * being touched by the resolution; the sidebar row of an opted-in preview
 * feature still marked pending.
 * CANNOT SEE: the engine's env promotion (the engine half) or who may write
 * the prefs bag (RLS on user_prefs).
 */

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const prefs = vi.hoisted(() => ({
  bag: null as Record<string, unknown> | null,
  listeners: new Set<(scope: "user" | "org") => void>(),
}));

vi.mock("@/lib/prefs", () => ({
  getRemotePref: (scope: string, key: string) =>
    scope === "user" && prefs.bag ? prefs.bag[key] : undefined,
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
  resolvePreview,
  useFeatures,
  type FeatureRegistry,
} from "@/lib/features";
import { useShellNav } from "@/components/cfo/Sidebar";

const RAW: FeatureRegistry = {
  forecast: { status: "preview", label: "Forecast", description: "" },
  scenarios: { status: "preview", label: "Scenario planning", description: "" },
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
  __clearFeaturesForTest();
  __setFeaturesForTest(RAW);
});

describe("resolvePreview", () => {
  it("a preview key is active only for the keys the user opted into", () => {
    const out = resolvePreview(RAW, new Set(["forecast"]));
    expect(out.forecast?.status).toBe("active");
    expect(out.scenarios?.status).toBe("coming_soon");
  });

  it("every other status passes through untouched", () => {
    const out = resolvePreview(RAW, new Set(["benchmarks", "variance", "erp_connector"]));
    expect(out.benchmarks?.status).toBe("active");
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

describe("the sidebar: an opted-in preview row is a normal row (no grey, no dot)", () => {
  const rows = () => {
    const { result } = renderHook(() => useShellNav());
    return result.current.flatMap((g) => g.items);
  };

  it("opted in: Forecast and Scenarios are not pending", () => {
    hydrate({ preview_features: ["forecast", "scenarios"] });
    const byKey = new Map(rows().map((r) => [r.featureKey, r]));
    expect(byKey.get("forecast")?.pending).toBeFalsy();
    expect(byKey.get("scenarios")?.pending).toBeFalsy();
  });

  it("not opted in: both stay in the menu, marked pending, as before", () => {
    const byKey = new Map(rows().map((r) => [r.featureKey, r]));
    expect(byKey.get("forecast")?.pending).toBe(true);
    expect(byKey.get("scenarios")?.pending).toBe(true);
  });
});
