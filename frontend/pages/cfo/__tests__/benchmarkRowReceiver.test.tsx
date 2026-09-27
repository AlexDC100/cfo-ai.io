// cmdbar-evidence — the command bar's "worst ratio vs sector" item lands on
// its sector row on the REAL /benchmark page, WHATEVER the legacy report says
// (design C4; found by review, 2026-09-27).
//
// Two resolvers, one page: the item comes from the sector document, whose
// CAEN is the company's own (organizations.caen_code — what a workspace
// upload writes); the legacy report (/api/benchmarks/report/{period}) ignores
// that column on purpose and answers `caen_not_set` until a PER-PERIOD
// assignment exists. The page rendered the sector section only when the
// legacy CAEN was set, so for every workspace upload the bar's
// `/benchmark?row=receivables_days` landed on "Pick an industry" with no
// sector row at all — and the first-time picker opened over it.
//
// Here the page is mounted as the app mounts it, the period resolved, the
// two engine answers served (the legacy report in the ENGINE's own shapes —
// src/engine/api/_benchmarks.py — and the sector document the engine
// composed for Agras, fixtures/attention/agras.sector.json).
//
// WHAT IT REDS ON, AFTER THE REPAIR (TC-11): a legacy answer (caen_not_set,
// benchmarks_not_available, an HTTP error, an unreachable API) that leaves
// the sector row off the page or unmarked; the picker opening over a row the
// reader followed a link to. WHAT IT CANNOT SEE: pixels (the live G5 in
// e2e/design/cmdbar.spec.ts).

import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PERIOD = "7a9a0000-0000-4000-8000-00000000a9a9";

vi.mock("@/hooks/useActivePeriodFallback", () => ({
  useActivePeriodFallback: () => ({ periodId: PERIOD, status: "ready" }),
}));
vi.mock("@/lib/apiHeaders", () => ({
  authOrgHeaders: async () => ({ Authorization: "Bearer test" }),
}));
vi.mock("@/components/cfo/industry", () => ({
  IndustryPicker: ({ open }: { open: boolean }) => (open ? <div role="dialog" data-testid="industry-picker" /> : null),
  IndustryBadge: () => null,
}));

import { renderWithProviders } from "@/test/renderWithProviders";
import BenchmarkReportPage from "@/pages/cfo/BenchmarkReport";

const REPO = resolve(__dirname, "../../../..");
const SECTOR = JSON.parse(readFileSync(resolve(REPO, "frontend/lib/__tests__/fixtures/attention/agras.sector.json"), "utf-8"));
const ATTENTION = JSON.parse(readFileSync(resolve(REPO, "frontend/lib/__tests__/fixtures/attention/agras.attention.json"), "utf-8"));

/** The legacy report's answers, in the engine's own shapes. */
type Legacy = "caen_not_set" | "benchmarks_not_available" | "http_500" | "unreachable";
const LEGACY: Record<Exclude<Legacy, "http_500" | "unreachable">, unknown> = {
  // _benchmarks.py: `if not caen_code: return {"error": "caen_not_set", …}` (HTTP 200)
  caen_not_set: {
    error: "caen_not_set",
    message: "Industry is not set for this period. Open the industry picker to choose one.",
    period_id: PERIOD, org_id: "org-agras", refusal: null,
  },
  benchmarks_not_available: {
    error: "benchmarks_not_available",
    message: "No benchmark data for this CAEN yet.",
  },
};

let legacy: Legacy = "caen_not_set";
let savedFetch: unknown;

beforeEach(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  savedFetch = g.fetch;
  g.fetch = async (input: unknown) => {
    const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
    if (/\/api\/benchmarks\/report\//.test(url)) {
      if (legacy === "unreachable") throw new TypeError("Failed to fetch");
      if (legacy === "http_500") return new Response("boom", { status: 500 });
      return new Response(JSON.stringify(LEGACY[legacy]), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (/\/sector-benchmark$/.test(url)) {
      return new Response(JSON.stringify(SECTOR), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 404, headers: { "Content-Type": "application/json" } });
  };
});

afterEach(() => {
  (globalThis as unknown as Record<string, unknown>).fetch = savedFetch;
  cleanup();
});

/** The row the bar's "worst vs sector" item names for Agras, as served. */
function servedRow(): string {
  const item = (ATTENTION.items as { evidence: { kind: string; row?: string } }[])
    .find((i) => i.evidence.kind === "benchmark_row");
  expect(item, "Agras's served items include a worst-vs-sector row").toBeTruthy();
  return item!.evidence.row!;
}

async function land(route: string): Promise<HTMLElement[]> {
  renderWithProviders(<BenchmarkReportPage />, { route });
  await waitFor(() => expect(document.querySelectorAll("[data-sector-row]").length).toBeGreaterThan(0), { timeout: 3000 });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  return [...document.querySelectorAll<HTMLElement>("[data-sector-row]")];
}

describe("cmdbar-evidence — /benchmark?row= lands on its sector row whatever the legacy report says", () => {
  for (const answer of ["caen_not_set", "benchmarks_not_available", "http_500", "unreachable"] as Legacy[]) {
    it(`legacy report ${answer}: the sector section renders and marks the row the bar named — and no picker covers it`, async () => {
      legacy = answer;
      const row = servedRow();
      const rows = await land(`/benchmark?period=${PERIOD}&row=${row}`);
      expect(rows.length).toBeGreaterThan(1);
      expect(rows.filter((r) => r.dataset.highlighted === "true").map((r) => r.dataset.sectorRow)).toEqual([row]);
      expect(screen.queryByTestId("industry-picker"), "a modal over the evidence row").toBeNull();
    });
  }

  it("without an evidence row the first-time picker still opens on caen_not_set (the gate is unchanged)", async () => {
    legacy = "caen_not_set";
    await land(`/benchmark?period=${PERIOD}`);
    await waitFor(() => expect(screen.queryByTestId("industry-picker")).not.toBeNull());
  });
});
