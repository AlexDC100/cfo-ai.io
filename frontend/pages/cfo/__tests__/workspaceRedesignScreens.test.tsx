// Screens 1 and 3 of the workspace redesign.
//
//   Home (/workspace)          one drop zone (the one primary action) + a card
//                              per company: name, CUI, latest year's revenue;
//                              a card opens the company page.
//   Company (/workspace/<id>)  the name as the title; its years as tiles on
//                              ONE line (year, revenue, % vs prior year); a
//                              dashed next-year tile as the drop target;
//                              settings / decision rules (Products active
//                              only) / financing / danger zone behind a gear,
//                              with no left settings sub-nav.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import { TestProviders } from "@/test/renderWithProviders";
import { __setFeaturesForTest } from "@/lib/features";
import { writeWorkspaceName } from "@/lib/workspaceName";
import { __resetUploadFlowForTest, readUploadFlow } from "@/lib/uploadFlow";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).IntersectionObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const YEARS: Record<string, unknown[]> = {
  scandia: [
    { period_id: "s-2023", year: 2023, period_end: "2023-12-31", revenue: 350_000_000, revenue_change_pct: null },
    { period_id: "s-2024", year: 2024, period_end: "2024-12-31", revenue: 380_000_000, revenue_change_pct: 8.6 },
    { period_id: "s-2025", year: 2025, period_end: "2025-12-31", revenue: 413_727_560, revenue_change_pct: 8.9 },
  ],
  agras: [],
};
const identifyUpload = vi.hoisted(() => vi.fn(() => new Promise(() => {})));
vi.mock("@/lib/uploadsApi", () => ({
  identifyUpload,
  commitUpload: vi.fn(),
  UploadApiError: class extends Error {},
  fetchCompanyYears: vi.fn(async (orgId: string) => YEARS[orgId] ?? []),
  fetchCompanyDirectory: vi.fn(async (ids: string[]) => {
    const all: Record<string, { cui: string | null; companyName: string | null }> = {
      scandia: { cui: "RO1234567", companyName: "Scandia Food SRL" },
      agras: { cui: null, companyName: null },
    };
    return Object.fromEntries(ids.map((id) => [id, all[id] ?? { cui: null, companyName: null }]));
  }),
}));

const orgApi = vi.hoisted(() => ({
  activeId: "scandia",
  // Companies a single test adds (reset in beforeEach).
  extra: [] as Array<Record<string, unknown>>,
  archiveWorkspace: vi.fn(async () => true),
  purgeWorkspace: vi.fn(async () => true),
  renameWorkspace: vi.fn(async () => true),
  setWorkspaceIndustry: vi.fn(async () => true),
  restoreWorkspace: vi.fn(async () => true),
}));
vi.mock("@/lib/org", () => {
  const orgs = [
    { id: "scandia", name: "Scandia Food SRL", industry_key: "fmcg", industry_display_name: null, default_currency: null, role: "owner", archived_at: null, purge_after: null, created_at: "2025-01-01" },
    { id: "agras", name: "Agras SA", industry_key: "agriculture", industry_display_name: null, default_currency: null, role: "owner", archived_at: null, purge_after: null, created_at: "2025-02-01" },
  ];
  const archived = [
    { id: "old", name: "Old Co SRL", industry_key: null, industry_display_name: null, default_currency: null, role: "owner", archived_at: "2026-09-10", purge_after: "2026-10-10", created_at: "2024-01-01" },
  ];
  return {
    useActiveOrg: () => ({
      org: [...orgs, ...orgApi.extra].find((o) => o.id === orgApi.activeId) ?? null,
      orgs: [...orgs, ...orgApi.extra],
      archived,
      loading: false,
      loadError: false,
      needsOnboarding: false,
      refresh: async () => {},
      switchOrg: async () => {},
      archiveWorkspace: orgApi.archiveWorkspace,
      purgeWorkspace: orgApi.purgeWorkspace,
      renameWorkspace: orgApi.renameWorkspace,
      setWorkspaceIndustry: orgApi.setWorkspaceIndustry,
      restoreWorkspace: orgApi.restoreWorkspace,
    }),
    activateWorkspace: vi.fn(async () => true),
    daysUntilPurge: () => 19,
  };
});
vi.mock("@/lib/supabase", () => ({
  getSupabase: () => null,
  supabaseEnabled: false,
  currentOrgId: async () => "scandia",
  subscribeToDocumentStatus: () => () => {},
  fetchDocumentStatus: async () => null,
}));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// The decision-rules panel reads the engine's sales datasets — out of scope.
vi.mock("@/components/cfo/command/DecisionRulesModal", () => ({
  DecisionRulesPanel: () => <div data-testid="decision-rules-panel" />,
}));

import WorkspaceHomeV2 from "@/pages/cfo/WorkspaceHomeV2";
import CompanyPage from "@/pages/cfo/CompanyPage";
import { NoAnalysisYet } from "@/components/cfo/NoAnalysisYet";

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname + loc.search}</div>;
}

function renderAt(route: string) {
  return render(
    <TestProviders route={route}>
      <LocationProbe />
      <Routes>
        <Route path="/workspace" element={<WorkspaceHomeV2 />} />
        <Route path="/workspace/:orgId" element={<CompanyPage />} />
        <Route path="*" element={<div data-testid="elsewhere" />} />
      </Routes>
    </TestProviders>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  orgApi.activeId = "scandia";
  orgApi.extra = [];
  writeWorkspaceName("Scandia Food SRL");
  __resetUploadFlowForTest();
  identifyUpload.mockClear();
  __setFeaturesForTest({ products_legacy: { status: "active", label: "Products", description: "" } });
});
afterEach(() => cleanup());

describe("Home — /workspace", () => {
  it("one drop zone, one primary button, and a card per company with name, CUI and latest revenue", async () => {
    renderAt("/workspace");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Your companies");
    expect(screen.getAllByTestId("upload-drop-zone")).toHaveLength(1);
    expect(screen.getByTestId("upload-drop-choose")).toHaveTextContent("Choose a file");

    const scandia = await screen.findByTestId("company-card-scandia");
    expect(within(scandia).getByTestId("company-card-name")).toHaveTextContent("Scandia Food SRL");
    await waitFor(() => expect(within(scandia).getByTestId("company-card-cui")).toHaveTextContent("CUI RO1234567"));
    await waitFor(() => expect(within(scandia).getByTestId("company-card-revenue")).toHaveTextContent("Revenue 2025"));
    expect(within(scandia).getByTestId("company-card-revenue").textContent).toMatch(/413/);

    const agras = screen.getByTestId("company-card-agras");
    await waitFor(() => expect(within(agras).getByTestId("company-card-revenue")).toHaveTextContent("No year analysed yet"));
    expect(within(agras).getByTestId("company-card-cui")).toHaveTextContent("No CUI yet");
  });

  it("a company card opens that company's page", async () => {
    renderAt("/workspace");
    fireEvent.click(await screen.findByTestId("company-card-agras"));
    expect(screen.getByTestId("location")).toHaveTextContent("/workspace/agras");
  });

  it("the drop zone hands the file to the flow with the company on screen", async () => {
    renderAt("/workspace");
    const file = new File(["x"], "balanta.xlsx");
    fireEvent.drop(screen.getByTestId("upload-drop-zone"), { dataTransfer: { files: [file], types: ["Files"] } });
    await waitFor(() => expect(identifyUpload).toHaveBeenCalledWith(file, "scandia"));
    expect(readUploadFlow().phase).toBe("identifying");
  });

  it("soft-deleted companies stay restorable here", async () => {
    renderAt("/workspace");
    const shelf = screen.getByTestId("workspace-home-deleted");
    expect(shelf).toHaveTextContent("Old Co SRL");
    expect(shelf).toHaveTextContent("Deleted for good in 19 days");
    fireEvent.click(within(shelf).getByTestId("workspace-home-restore-old"));
    await waitFor(() => expect(orgApi.restoreWorkspace).toHaveBeenCalledWith("old"));
  });

  it("every file input on the screen belongs to the one upload component", async () => {
    const { container } = renderAt("/workspace");
    await screen.findByTestId("company-card-scandia");
    const inputs = [...container.querySelectorAll('input[type="file"]')];
    expect(inputs.length).toBe(1);
    inputs.forEach((i) => expect(i.getAttribute("data-upload-component")).toBe("zone"));
  });
});

describe("Company page — /workspace/<orgId>", () => {
  it("the name is the title, the years sit on one line with revenue and % vs the year before", async () => {
    renderAt("/workspace/scandia");
    expect(await screen.findByTestId("company-title")).toHaveTextContent("Scandia Food SRL");
    await waitFor(() => expect(screen.getByTestId("company-cui")).toHaveTextContent("CUI RO1234567"));

    const line = screen.getByTestId("company-years");
    // One line: a non-wrapping, sideways-scrolling row.
    expect(line.className).toMatch(/\bflex\b/);
    expect(line.className).toMatch(/overflow-x-auto/);
    expect(line.className).not.toMatch(/flex-wrap|grid/);

    const y2025 = await screen.findByTestId("company-year-2025");
    expect(y2025).toHaveTextContent("2025");
    expect(within(y2025).getByTestId("company-year-2025-revenue").textContent).toMatch(/413/);
    expect(within(y2025).getByTestId("company-year-2025-change")).toHaveTextContent("+8.9 % vs 2024");
    expect(screen.getByTestId("company-year-2023-change")).toHaveTextContent("first year");

    // Tiles in order, the dashed next-year tile closing the row.
    const order = [...line.querySelectorAll("[data-testid]")]
      .map((el) => el.getAttribute("data-testid") ?? "")
      .filter((id) => /^company-year-\d{4}$/.test(id) || id === "upload-drop-tile");
    expect(order).toEqual(["company-year-2023", "company-year-2024", "company-year-2025", "upload-drop-tile"]);
    expect(screen.getByTestId("upload-drop-tile")).toHaveTextContent("Add 2026");
  });

  it("a year tile opens that year's dashboard, company pinned in the link", async () => {
    renderAt("/workspace/scandia");
    fireEvent.click(await screen.findByTestId("company-year-2024"));
    expect(screen.getByTestId("location")).toHaveTextContent("/dashboard?period=s-2024&org=scandia");
  });

  it("the dashed tile is the drop target for the next year — routed to THIS company", async () => {
    renderAt("/workspace/scandia");
    const tile = await screen.findByTestId("upload-drop-tile");
    const file = new File(["x"], "balanta_2026.xlsx");
    fireEvent.drop(tile, { dataTransfer: { files: [file], types: ["Files"] } });
    await waitFor(() => expect(identifyUpload).toHaveBeenCalledWith(file, "scandia"));
  });

  it("the industry is words, never its catalog key", async () => {
    orgApi.extra = [
      { id: "carni", name: "Carniprod SRL", industry_key: "food_manufacturing", industry_display_name: null, default_currency: null, role: "owner", archived_at: null, purge_after: null, created_at: "2025-03-01" },
    ];
    orgApi.activeId = "carni";
    writeWorkspaceName("Carniprod SRL");
    const { unmount } = renderAt("/workspace/carni");
    expect(await screen.findByTestId("company-title")).toHaveTextContent("Carniprod SRL");
    // No catalog label, no stored name: no industry line — not "food_manufacturing".
    expect(screen.queryByTestId("company-industry")).toBeNull();
    expect(screen.getByTestId("company-page").textContent).not.toMatch(/food_manufacturing/);
    unmount();
    orgApi.extra = [{ ...orgApi.extra[0], industry_display_name: "Food manufacturing" }];
    renderAt("/workspace/carni");
    expect(await screen.findByTestId("company-industry")).toHaveTextContent("Food manufacturing");
  });

  it("a company with no year yet says where the first file goes", async () => {
    orgApi.activeId = "agras";
    writeWorkspaceName("Agras SA");
    renderAt("/workspace/agras");
    expect(await screen.findByTestId("company-title")).toHaveTextContent("Agras SA");
    expect(await screen.findByTestId("company-no-years")).toHaveTextContent(
      "No analysis yet. Drop the first file on the dashed tile.",
    );
    // With nothing on record the tile offers last year.
    expect(screen.getByTestId("upload-drop-tile")).toHaveTextContent(`Add ${new Date().getUTCFullYear() - 1}`);
  });

  it("the gear holds settings, decision rules (Products active), financing and the danger zone — no left sub-nav", async () => {
    renderAt("/workspace/scandia");
    fireEvent.click(await screen.findByTestId("company-gear"));
    const sheet = await screen.findByTestId("company-settings");
    expect(within(sheet).getByTestId("company-settings-general")).toBeInTheDocument();
    expect(within(sheet).getByTestId("company-settings-rules")).toBeInTheDocument();
    expect(within(sheet).getByTestId("company-settings-financing")).toBeInTheDocument();
    expect(within(sheet).getByTestId("company-settings-danger")).toBeInTheDocument();
    expect(within(sheet).queryByTestId("wsset-nav")).toBeNull();
    // One company per workspace — the settings say "company".
    expect(within(sheet).getByText("Company name")).toBeInTheDocument();
    expect(within(sheet).getByTestId("workspace-settings-delete")).toHaveTextContent("Delete company");
    // Settings carry no upload control.
    expect(sheet.querySelector('input[type="file"]')).toBeNull();
  });

  it("decision rules are not offered while Products is off", async () => {
    __setFeaturesForTest({ products_legacy: { status: "hidden", label: "Products", description: "" } });
    renderAt("/workspace/scandia");
    fireEvent.click(await screen.findByTestId("company-gear"));
    const sheet = await screen.findByTestId("company-settings");
    expect(within(sheet).queryByTestId("company-settings-rules")).toBeNull();
    expect(within(sheet).getByTestId("company-settings-financing")).toBeInTheDocument();
  });

  it("every file input on the page belongs to the one upload component", async () => {
    const { container } = renderAt("/workspace/scandia");
    await screen.findByTestId("company-year-2025");
    const inputs = [...container.querySelectorAll('input[type="file"]')];
    expect(inputs.length).toBe(1);
    expect(inputs[0]!.getAttribute("data-upload-component")).toBe("tile");
  });

  it("Romanian", async () => {
    await i18n.changeLanguage("ro");
    renderAt("/workspace/scandia");
    const y2025 = await screen.findByTestId("company-year-2025");
    expect(within(y2025).getByTestId("company-year-2025-change")).toHaveTextContent("față de 2024");
    expect(screen.getByTestId("company-year-2023-change")).toHaveTextContent("primul an");
    expect(screen.getByTestId("upload-drop-tile")).toHaveTextContent("Adaugă 2026");
    expect(screen.getByTestId("company-back")).toHaveTextContent("Toate companiile");
  });
});

describe("Dashboard with nothing analysed — no upload control there", () => {
  it("points to the company page (its dashed tile), and carries no file input", () => {
    const { container } = render(
      <TestProviders route="/dashboard">
        <NoAnalysisYet />
      </TestProviders>,
    );
    const open = screen.getByTestId("dashboard-no-analysis-open");
    expect(open).toHaveTextContent("Open Scandia Food SRL");
    expect(open.getAttribute("href")).toBe("/workspace/scandia");
    expect(container.querySelector('input[type="file"]')).toBeNull();
  });
});

// ── G8 — archive, never delete ─────────────────────────────────────────
//
// Owner rule: every removal in the redesign is an ARCHIVE (organizations
// .archived_at — restorable from Home for 30 days), never a hard delete.
// Reds on: the danger zone calling anything but the archive; the Home shelf
// offering a permanent deletion; any redesign module naming a purge or a
// delete call.
const REDESIGN_MODULES = [
  "pages/cfo/CompanyPage.tsx",
  "pages/cfo/WorkspaceHomeV2.tsx",
  "components/cfo/upload/UploadDrop.tsx",
  "components/cfo/upload/UploadFlowHost.tsx",
  "components/cfo/upload/identitySources.ts",
  "components/cfo/upload/industryLabel.ts",
  "lib/uploadFlow.ts",
  "lib/uploadsApi.ts",
  "lib/uploadNotices.ts",
  "lib/companyOnScreen.ts",
  "lib/previewFeatures.ts",
];
// A permanent deletion in any of its shapes: the purge RPC or its wrapper,
// a permanent-delete / clear-deleted route, a PostgREST `.delete()`, an HTTP
// DELETE. (Set/Map `.delete` and the archive's own purge COUNTDOWN label are
// not deletions.)
const PERMANENT_DELETE =
  /\b(purge_workspace|purgeWorkspace\w*|purge_expired\w*|permanent[_-]?delete\w*|permanentDelete\w*|delete_my_\w+|delete_all_my_data|clear[_-]deleted)\b|method:\s*["'`]DELETE|\.from\([^)]*\)\s*\.delete\s*\(/i;

describe("G8 — archive, never delete", () => {
  beforeEach(() => {
    orgApi.archiveWorkspace.mockClear();
    orgApi.purgeWorkspace.mockClear();
  });

  it("the danger zone ARCHIVES the company (restorable) and never purges it", async () => {
    renderAt("/workspace/scandia");
    fireEvent.click(await screen.findByTestId("company-gear"));
    const sheet = await screen.findByTestId("company-settings");
    fireEvent.click(within(sheet).getByTestId("workspace-settings-delete"));
    const dialog = await screen.findByTestId("workspace-settings-delete-dialog");
    fireEvent.change(within(dialog).getByTestId("wsset-delete-confirm-input"), {
      target: { value: "Scandia Food SRL" },
    });
    fireEvent.click(within(dialog).getByTestId("workspace-settings-delete-confirm"));
    await waitFor(() => expect(orgApi.archiveWorkspace).toHaveBeenCalledWith("scandia"));
    expect(orgApi.archiveWorkspace).toHaveBeenCalledTimes(1);
    expect(orgApi.purgeWorkspace).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/workspace"));
  });

  it("Home keeps archived companies restorable and offers no permanent deletion", async () => {
    renderAt("/workspace");
    const shelf = await screen.findByTestId("workspace-home-deleted");
    expect(within(shelf).getByTestId("workspace-home-restore-old")).toBeInTheDocument();
    expect(shelf.textContent ?? "").not.toMatch(/permanent|definitiv/i);
    expect(orgApi.purgeWorkspace).not.toHaveBeenCalled();
  });

  it("no redesign module names a purge or a delete call", () => {
    const FE = resolve(__dirname, "../../..");
    const hits: string[] = [];
    for (const rel of REDESIGN_MODULES) {
      const code = readFileSync(resolve(FE, rel), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
      code.split("\n").forEach((line, i) => {
        if (PERMANENT_DELETE.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});

