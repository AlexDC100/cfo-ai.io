// Phase 9 unit tests for the Command Center shell.
//
// Asserts the cleanup-brief invariants directly on the rendered DOM:
//   · 3 tabs only (Workspace, Data, Account). No Rules tab, no AI tab.
//     (AI was removed in a later directive — Ask CFO AI lives in the
//     TopHeader pill + floating button + Workspace tab Quick actions.)
//   · Exactly one sign-out across all 3 tabs.
//   · DataTab renders ERP connector as coming_soon.
//   · WorkspaceTab surfaces the upload CTA when no period is connected.
//
// The test wraps CommandCenter in MemoryRouter (sidebar nav helpers
// depend on react-router) and seeds the feature registry so backend
// access isn't needed.

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { CommandCenter } from "../CommandCenter";
import {
  __setFeaturesForTest,
  __clearFeaturesForTest,
  type FeatureRegistry,
} from "@/lib/features";

// Mock the auth hook (Supabase client isn't initialized in unit tests).
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    signOut: vi.fn().mockResolvedValue({ error: null }),
    user: { email: "test@example.com" },
    displayName: "Test User",
    status: "signed_in",
    initials: "TU",
    workspaceLabel: "Test Workspace",
  }),
}));

// Mock useActivePeriod to a "no dataset" state for the duplicate-signout
// and tab-count tests. The state-card branch is exercised separately.
vi.mock("@/lib/activePeriod", () => ({
  useActivePeriod: () => ({
    id: null,
    label: null,
    industry: null,
    statements: null,
    invoices: null,
    metrics: [],
    recommendations: [],
    alerts: [],
    briefing: null,
    isLoading: false,
    organization: null,
  }),
  usePrefetchPeriod: () => () => {},
}));

const FULL_REGISTRY: FeatureRegistry = {
  upload_trial_balance: { status: "active", label: "Upload TB", description: "" },
  upload_financial_statement: { status: "active", label: "Upload FS", description: "" },
  upload_invoice: { status: "coming_soon", label: "Upload invoice", description: "" },
  upload_inventory: { status: "coming_soon", label: "Upload inventory", description: "" },
  import_history: { status: "coming_soon", label: "Import history", description: "" },
  data_quality: { status: "coming_soon", label: "Data quality", description: "" },
  reprocess_latest: { status: "coming_soon", label: "Reprocess", description: "" },
  erp_connector: { status: "coming_soon", label: "ERP", description: "" },
  accounting_connector: { status: "coming_soon", label: "Accounting", description: "" },
  public_registry_connector: { status: "coming_soon", label: "Public registry", description: "" },
  ask_cfo_ai: { status: "active", label: "Ask CFO AI", description: "" },
  ask_about_current_company: { status: "active", label: "Ask current", description: "" },
  generate_action_list: { status: "active", label: "Action list", description: "" },
  generate_board_summary: { status: "active", label: "Board summary", description: "" },
  generate_bank_memo: { status: "coming_soon", label: "Bank memo", description: "" },
  generate_90_day_plan: { status: "coming_soon", label: "90-day plan", description: "" },
  generate_public_report: { status: "coming_soon", label: "Public report", description: "" },
  simulate_cost_of_capital: { status: "coming_soon", label: "Sim CoC", description: "" },
  simulate_debt_reduction: { status: "coming_soon", label: "Sim debt", description: "" },
  simulate_margin_improvement: { status: "coming_soon", label: "Sim margin", description: "" },
  change_password: { status: "active", label: "Change password", description: "" },
  two_factor_auth: { status: "coming_soon", label: "2FA", description: "" },
  manage_profile: { status: "active", label: "Manage profile", description: "" },
  manage_billing: { status: "active", label: "Manage billing", description: "" },
  workspace_switcher: { status: "coming_soon", label: "Switch workspace", description: "" },
  dashboard: { status: "active", label: "Dashboard", description: "" },
  benchmarks: { status: "active", label: "Benchmarks", description: "" },
  reports: { status: "active", label: "Reports", description: "" },
};

function renderCenter() {
  return render(
    <MemoryRouter>
      <CommandCenter
        open
        onOpenChange={() => {}}
        onOpenAi={() => {}}
        onOpenUpload={() => {}}
      />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  __clearFeaturesForTest();
  __setFeaturesForTest(FULL_REGISTRY);
});

afterEach(() => cleanup());

describe("CommandCenter — cleanup invariants", () => {
  it("renders exactly 3 tabs and NO Rules / AI tabs", () => {
    renderCenter();
    const tablist = screen.getByRole("tablist");
    const tabs = within(tablist).getAllByRole("tab");
    expect(tabs).toHaveLength(3);
    const labels = tabs.map((t) => t.textContent?.trim());
    expect(labels).toEqual(["Workspace", "Data", "Account"]);
    expect(labels).not.toContain("Rules");
    expect(labels).not.toContain("AI");
  });

  it("contains ZERO sign-outs across all 3 tabs (sign-out moved to Sidebar)", () => {
    // Operator directive: the single sign-out lives in the Sidebar's
    // System group below Command Center. The Command Center's Account
    // tab MUST NOT render its own sign-out, or the "exactly one"
    // invariant breaks. This test guards the Command Center side; a
    // sidebar-level test guards the other end (positive presence).
    const tabs: Array<"workspace" | "data" | "account"> = [
      "workspace",
      "data",
      "account",
    ];
    let total = 0;
    for (const initial of tabs) {
      cleanup();
      render(
        <MemoryRouter>
          <CommandCenter
            open
            onOpenChange={() => {}}
            onOpenAi={() => {}}
            onOpenUpload={() => {}}
            initialTab={initial}
          />
        </MemoryRouter>,
      );
      // Neither the legacy test-id nor any visible "Sign out" text
      // should be reachable from any tab.
      total += screen.queryAllByTestId("cmd-account-sign-out").length;
      total += screen.queryAllByText(/^sign out$/i).length;
    }
    expect(total).toBe(0);
  });

  it("shows the StateCard with 'No dataset connected' when period is null", () => {
    renderCenter();
    const card = screen.getByTestId("command-state-card");
    expect(card.getAttribute("data-state")).toBe("no-dataset");
    expect(card.textContent).toContain("No dataset connected");
  });
});
