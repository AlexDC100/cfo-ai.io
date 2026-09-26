// The company surfaces say "company", never "workspace" (redesign, 2026-09-26).
//
// One company per workspace: the workspace IS the company, and the screens
// that are about it — the company page and its gear (General, Financing,
// Danger zone) — call it a company. The words on screen and the words a
// screen reader is given (aria-label, title, placeholder), in both languages.
//
// Fails on: "workspace" (EN, or the Romanian borrowing "workspace-ul") or
// "spațiu de lucru" anywhere on the company page or in its settings sheet.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import { TestProviders } from "@/test/renderWithProviders";
import { __setFeaturesForTest } from "@/lib/features";
import { writeWorkspaceName } from "@/lib/workspaceName";

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

vi.mock("@/lib/uploadsApi", () => ({
  identifyUpload: vi.fn(() => new Promise(() => {})),
  commitUpload: vi.fn(),
  UploadApiError: class extends Error {},
  fetchCompanyYears: vi.fn(async () => [
    { period_id: "s-2025", year: 2025, period_end: "2025-12-31", revenue: 413_727_560, revenue_change_pct: null },
  ]),
  fetchCompanyDirectory: vi.fn(async (ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, { cui: "16070576", companyName: "Scandia Food SRL" }])),
  ),
}));
vi.mock("@/lib/org", () => {
  const orgs = [
    { id: "scandia", name: "Scandia Food SRL", industry_key: "fmcg", industry_display_name: null, default_currency: null, role: "owner", archived_at: null, purge_after: null, created_at: "2025-01-01" },
  ];
  return {
    useActiveOrg: () => ({
      org: orgs[0],
      orgs,
      archived: [],
      loading: false,
      loadError: false,
      needsOnboarding: false,
      refresh: async () => {},
      switchOrg: async () => {},
      archiveWorkspace: vi.fn(async () => true),
      purgeWorkspace: vi.fn(async () => true),
      renameWorkspace: vi.fn(async () => true),
      setWorkspaceIndustry: vi.fn(async () => true),
      restoreWorkspace: vi.fn(async () => true),
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
vi.mock("@/components/cfo/command/DecisionRulesModal", () => ({
  DecisionRulesPanel: () => <div data-testid="decision-rules-panel" />,
}));

import CompanyPage from "@/pages/cfo/CompanyPage";

const NOT_A_COMPANY = /\b(workspaces?|workspace-ul(?:ui)?|spa[țt]i(?:u|ul|i|ile) de lucru)\b/i;

/** The words on screen plus the words handed to a screen reader. */
function wordsOn(root: HTMLElement): string[] {
  const attrs = [...root.querySelectorAll("[aria-label], [title], [placeholder]")]
    .flatMap((el) => [el.getAttribute("aria-label"), el.getAttribute("title"), el.getAttribute("placeholder")])
    .filter((v): v is string => !!v);
  return [root.textContent ?? "", ...attrs];
}

beforeEach(() => {
  writeWorkspaceName("Scandia Food SRL");
  __setFeaturesForTest({ products_legacy: { status: "active", label: "Products", description: "" } });
});
afterEach(() => cleanup());

for (const lang of ["en", "ro"] as const) {
  describe(`${lang}: the company page and its gear`, () => {
    it("say company, never workspace — on screen and to a screen reader", async () => {
      await i18n.changeLanguage(lang);
      render(
        <TestProviders route="/workspace/scandia">
          <Routes>
            <Route path="/workspace/:orgId" element={<CompanyPage />} />
          </Routes>
        </TestProviders>,
      );
      const page = await screen.findByTestId("company-page");
      await screen.findByTestId("company-year-2025");
      fireEvent.click(screen.getByTestId("company-gear"));
      const sheet = await screen.findByTestId("company-settings");
      await within(sheet).findByTestId("wsset-industry-current");
      // Open the name editor too: its buttons carry their own labels.
      fireEvent.click(within(sheet).getByTestId("workspace-settings-name-edit"));
      const offenders = [...wordsOn(page), ...wordsOn(sheet)].filter((line) => NOT_A_COMPANY.test(line));
      expect(offenders).toEqual([]);
    });
  });
}
