/**
 * THE RADAR SURFACES — the page and the dashboard strip.
 *
 * Both are gated OFF today (the registry row is `hidden`, and the engine
 * mounts `/api/radar/*` only behind ANOMALY_RADAR_ENABLED). What this file
 * pins is the behaviour they must have when either flag is flipped —
 * because the flag exists precisely so that flipping it is a decision and
 * not a discovery.
 *
 * ── THE ONE THING NEITHER SURFACE MAY DO ────────────────────────────────
 *
 * Render a 404 as a clean book. `/api/radar/*` is absent unless the engine
 * flag is set, and a page that answered that with "no findings" would tell
 * a reader their book is clean when nothing has looked at it. "Measured
 * and clear" and "not measured" are different claims and only one of them
 * may look like silence — the sentence this whole product is built on.
 *
 * WHAT THIS REDS ON (TC-11)
 *   · a 404 rendering as an empty findings list on either surface;
 *   · the strip rendering while the feature is not `active` (a dead
 *     affordance advertising a surface that does not exist);
 *   · the strip restating findings instead of counts (there is already a
 *     FindingsPanel on that screen, and two answers is none);
 *   · the cap's held-back count disappearing, which is what keeps
 *     "7 findings" from reading as "7 problems exist";
 *   · a scan that RAN and found nothing rendering as nothing at all.
 * WHAT IT CANNOT SEE
 *   · the engine. `tests/engine/test_radar_wiring.py` owns the mount flag,
 *     the identity, the CAEN read and the line items.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import { TooltipProvider } from "@/components/ui/tooltip";

import Radar from "../Radar";
import { RadarStrip } from "@/components/cfo/RadarStrip";
import { CfoApiError } from "@/lib/cfoApi";

const PERIOD = { id: "p-1", label: "Dec 2025", statements: { currency: "RON" } };

vi.mock("@/lib/activePeriod", () => ({
  useActivePeriod: () => PERIOD,
}));

const radar = vi.fn();
vi.mock("@/lib/cfoApi", async () => {
  const actual = await vi.importActual<typeof import("@/lib/cfoApi")>("@/lib/cfoApi");
  return { ...actual, cfoApi: { radar: (...a: unknown[]) => radar(...a) } };
});

let featureStatus: string | undefined = "active";
vi.mock("@/lib/features", () => ({
  useFeatureStatus: () => featureStatus,
}));

/** A radar payload in the shape `engine.radar.serve.compose` emits.
 *
 *  THE ROWS ARE REAL ENGINE BYTES. `tests/engine/fixtures/radar/
 *  saga_10_col_agras.json` is the committed capture the Python R4
 *  determinism gate compares against, so what this file feeds
 *  `buildFindingsReport` is exactly what a browser receives — the
 *  seven-element `contract_elements` block included. A hand-written row
 *  would have been a lookalike: `parseFinding` returns null without that
 *  block, `hasContractRows` goes false, and `<FindingsPanel>` renders
 *  nothing, so a synthetic fixture would have quietly tested an empty
 *  panel. It did, on the first draft of this file.
 *
 *  The lane on the second row is rewritten to `detectors` — the capture
 *  is from a run with the detector lane OFF, and the lane label is what
 *  the page groups by. Nothing else is touched. */
const CAPTURE = JSON.parse(
  readFileSync(
    resolve(__dirname, "../../../../tests/engine/fixtures/radar/saga_10_col_agras.json"),
    "utf-8",
  ),
).radar as Record<string, unknown>;

function payload(over: Record<string, unknown> = {}) {
  const rows = (CAPTURE.surfaced as Array<Record<string, unknown>>).slice(0, 2);
  return {
    ...CAPTURE,
    surfaced: [
      rows[0],
      { ...rows[1], lane: "detectors" },
    ],
    counts: { ...(CAPTURE.counts as Record<string, number>), held_back: 3 },
    ...over,
  };
}

function wrap(node: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  // `TooltipProvider` mirrors App.tsx:209, which wraps every route — the
  // finding components reach for a Tooltip and throw without it. Named
  // here rather than stubbed so this harness stays the shape the app is.
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouter>{node}</MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  radar.mockReset();
  featureStatus = "active";
});

describe("the radar page", () => {
  it("renders a 404 as NOT SCANNED, never as a clean book", async () => {
    radar.mockRejectedValue(new CfoApiError("Not Found", 404, null));
    wrap(<Radar />);

    const absent = await screen.findByTestId("radar-surface-absent");
    expect(absent.textContent).toMatch(/not enabled/i);
    expect(
      absent.textContent,
      "the copy must say nothing looked at the period — an unmounted scan " +
        "read as a clean book is the one substitution this product refuses",
    ).toMatch(/nothing has looked at this period/i);
    expect(screen.queryByTestId("fnd-panel")).toBeNull();
  });

  it("shows a non-404 failure as the engine's own sentence", async () => {
    radar.mockRejectedValue(new CfoApiError("the spine mixes RON and EUR", 500, null));
    wrap(<Radar />);
    const detail = await screen.findByTestId("radar-error-detail");
    expect(detail.textContent).toContain("mixes RON and EUR");
    expect(screen.queryByTestId("radar-surface-absent")).toBeNull();
  });

  it("names each row's lane, so an engine rule and a detector are distinguishable", async () => {
    radar.mockResolvedValue(payload());
    wrap(<Radar />);
    const lanes = await screen.findByTestId("radar-lanes");
    expect(lanes.textContent).toMatch(/detectors · 1/);
    expect(lanes.textContent).toMatch(/this period · 1/);
  });

  it("mounts the SAME FindingsPanel the statements page uses", async () => {
    radar.mockResolvedValue(payload());
    wrap(<Radar />);
    expect(
      await screen.findByTestId("fnd-panel"),
      "a second renderer for a finding is how two surfaces come to disagree",
    ).toBeTruthy();
  });
});

describe("the dashboard strip", () => {
  it("renders nothing at all when the feature is not active", async () => {
    featureStatus = "hidden";
    radar.mockResolvedValue(payload());
    const { container } = wrap(<RadarStrip />);
    expect(container.textContent).toBe("");
    expect(
      radar,
      "a hidden feature must not even ask the engine",
    ).not.toHaveBeenCalled();
  });

  it("renders nothing when the engine answers 404", async () => {
    radar.mockRejectedValue(new CfoApiError("Not Found", 404, null));
    const { container } = wrap(<RadarStrip />);
    await new Promise((r) => setTimeout(r, 20));
    expect(
      container.textContent,
      '"0 findings" over an unmounted scan is the defect; nothing is correct',
    ).toBe("");
  });

  it("states counts by severity and the cap's held-back rows", async () => {
    radar.mockResolvedValue(payload());
    wrap(<RadarStrip />);
    const strip = await screen.findByTestId("radar-strip");
    expect(strip.getAttribute("data-radar-surfaced")).toBe("2");
    expect(screen.getByTestId("radar-strip-high").textContent).toMatch(/1/);
    expect(screen.getByTestId("radar-strip-medium").textContent).toMatch(/1/);
    expect(
      screen.getByTestId("radar-strip-held").textContent,
      "without the held-back count, '2 findings' reads as '2 problems exist'",
    ).toMatch(/3/);
  });

  it("restates no finding — it links out instead", async () => {
    radar.mockResolvedValue(payload());
    wrap(<RadarStrip />);
    const strip = await screen.findByTestId("radar-strip");
    expect(strip.textContent).not.toMatch(/Cash cover is thin/);
    expect(strip.textContent).not.toMatch(/depreciated/);
    expect(screen.getByTestId("radar-strip-link").getAttribute("href")).toBe(
      "/radar?period=p-1",
    );
  });

  it("a scan that RAN and found nothing says so — it is a measurement", async () => {
    radar.mockResolvedValue(payload({ surfaced: [], counts: { held_back: 0 } }));
    wrap(<RadarStrip />);
    const strip = await screen.findByTestId("radar-strip");
    expect(strip.getAttribute("data-radar-surfaced")).toBe("0");
    expect(strip.textContent).toMatch(/nothing surfaced/i);
  });
});
