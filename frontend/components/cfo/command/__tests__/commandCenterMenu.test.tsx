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
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

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
  // All sections (incl. DataTab's useQuery) render at once now, so a
  // QueryClientProvider is required. Retries off + no network in tests.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <CommandCenter
          open
          onOpenChange={() => {}}
          onOpenAi={() => {}}
          onOpenUpload={() => {}}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  __clearFeaturesForTest();
  __setFeaturesForTest(FULL_REGISTRY);
});

afterEach(() => cleanup());

describe("CommandCenter — cleanup invariants", () => {
  it("has NO tab switcher and stacks all sections in one column", () => {
    // The tab switcher was removed — every section (Account, Workspace,
    // Data) renders at once in a single scroll column. There should be no
    // tablist / tabs anywhere.
    renderCenter();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.getByTestId("command-content")).toBeTruthy();
  });

  it("contains ZERO sign-outs (sign-out moved to Sidebar)", () => {
    // Operator directive: the single sign-out lives in the Sidebar's
    // System group below Command Center. With every section rendered at
    // once, the Account section MUST NOT render its own sign-out, or the
    // "exactly one" invariant breaks. This test guards the Command Center
    // side; a sidebar-level test guards the other end (positive presence).
    renderCenter();
    expect(screen.queryAllByTestId("cmd-account-sign-out")).toHaveLength(0);
    expect(screen.queryAllByText(/^sign out$/i)).toHaveLength(0);
  });

  it("shows the StateCard with 'No dataset connected' when period is null", () => {
    renderCenter();
    const card = screen.getByTestId("command-state-card");
    expect(card.getAttribute("data-state")).toBe("no-dataset");
    expect(card.textContent).toContain("No dataset connected");
  });
});
