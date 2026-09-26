// Per-account early access (2026-09-21). A key in the signed-in user's
// `user_prefs.prefs.preview_features` opens a `coming_soon` surface for THAT
// user only, labelled Beta; the registry's answer for everyone else stands.
import { describe, expect, it } from "vitest";
import { applyPreview, type FeatureRegistry } from "@/lib/features";

const REG: FeatureRegistry = {
  forecast: { status: "coming_soon", label: "Forecast", description: "" },
  scenarios: { status: "coming_soon", label: "Scenarios", description: "" },
  benchmarks: { status: "active", label: "Benchmark", description: "" },
  inventory: { status: "hidden", label: "Inventory", description: "" },
  // `preview` (the workspace redesign): the registry ships it OFF for
  // everyone and the SAME list opens it — one mechanism, one label.
  workspace_v2: { status: "preview", label: "Company workspaces", description: "" },
};

describe("applyPreview", () => {
  it("opens a coming_soon surface for an account that lists it, as Beta", () => {
    const out = applyPreview(REG, ["forecast", "scenarios"]);
    expect(out.forecast).toMatchObject({ status: "active", beta: true });
    expect(out.scenarios).toMatchObject({ status: "active", beta: true });
  });

  it("opens a preview surface for an account that lists it, as Beta — the same mechanism", () => {
    const out = applyPreview(REG, ["workspace_v2"]);
    expect(out.workspace_v2).toMatchObject({ status: "active", beta: true });
    expect(out.forecast?.status).toBe("coming_soon");
  });

  it("leaves every other account on the registry's answer — a preview row stays off", () => {
    for (const none of [undefined, null, [], "forecast", { forecast: true }, ["other_key"]]) {
      const out = applyPreview(REG, none);
      expect(out.forecast?.status).toBe("coming_soon");
      expect(out.scenarios?.status).toBe("coming_soon");
      expect(out.workspace_v2?.status).toBe("preview");
      expect(out.forecast?.beta).toBeUndefined();
      expect(out.workspace_v2?.beta).toBeUndefined();
    }
  });

  it("never promotes a hidden surface, never relabels an active one, ignores unknown keys", () => {
    const out = applyPreview(REG, ["inventory", "benchmarks", "nope", 42]);
    expect(out.inventory?.status).toBe("hidden");
    expect(out.benchmarks).toEqual(REG.benchmarks);
    expect(out).toEqual(REG);
  });

  it("does not mutate the shared registry cache", () => {
    const before = JSON.stringify(REG);
    applyPreview(REG, ["forecast"]);
    expect(JSON.stringify(REG)).toBe(before);
  });
});
