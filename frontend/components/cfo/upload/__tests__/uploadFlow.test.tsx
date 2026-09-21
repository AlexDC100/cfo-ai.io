// The workspace-redesign upload flow, end to end in the browser half:
// drop on Home → identify → confirmation card → Analyse / Change → commit →
// the screen follows the company → five live steps → toast + bell → the
// analysed company's dashboard. Plus the owner's named cases: an Agras file
// dropped while Scandia is open lands in Agras (G1), the period comes from
// the document or from the user — never from the filename (G2), a duplicate
// is refused with "Already uploaded — open it", a new CUI creates a company.
//
// The engine contract (/api/uploads/identify, /api/uploads/commit) is mocked
// at lib/uploadsApi; the document-status channel at lib/supabase.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import { TestProviders } from "@/test/renderWithProviders";
import type { IdentifyResult } from "@/lib/uploadsApi";
import { __resetUploadFlowForTest } from "@/lib/uploadFlow";
import { __resetUploadNoticesForTest } from "@/lib/uploadNotices";

// ── jsdom polyfills Radix needs ────────────────────────────────────────
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

// ── mocks ──────────────────────────────────────────────────────────────
const api = vi.hoisted(() => ({
  identifyUpload: vi.fn(),
  commitUpload: vi.fn(),
}));
vi.mock("@/lib/uploadsApi", async () => {
  class UploadApiError extends Error {
    httpStatus: number;
    constructor(m: string, s: number) {
      super(m);
      this.httpStatus = s;
    }
  }
  return {
    identifyUpload: api.identifyUpload,
    commitUpload: api.commitUpload,
    UploadApiError,
    fetchCompanyYears: vi.fn(async () => []),
    fetchCompanyDirectory: vi.fn(async () => ({
      scandia: { cui: "RO1234567", companyName: "Scandia Food SRL" },
      agras: { cui: "RO7654321", companyName: "Agras SA" },
    })),
  };
});

const status = vi.hoisted(() => ({ listeners: new Map<string, (row: unknown) => void>() }));
vi.mock("@/lib/supabase", () => ({
  getSupabase: () => null,
  supabaseEnabled: false,
  subscribeToDocumentStatus: (docId: string, cb: (row: unknown) => void) => {
    status.listeners.set(docId, cb);
    return () => status.listeners.delete(docId);
  },
  fetchDocumentStatus: vi.fn(async () => null),
  fetchAlerts: vi.fn(async () => []),
  enqueuePipeline: vi.fn(),
  currentOrgId: vi.fn(async () => "scandia"),
}));

const activateWorkspace = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/lib/org", () => {
  const orgs = [
    { id: "scandia", name: "Scandia Food SRL", industry_key: "fmcg", industry_display_name: null, default_currency: null, role: "owner", archived_at: null, purge_after: null, created_at: "2025-01-01" },
    { id: "agras", name: "Agras SA", industry_key: "agriculture", industry_display_name: null, default_currency: null, role: "owner", archived_at: null, purge_after: null, created_at: "2025-02-01" },
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
      restoreWorkspace: async () => true,
    }),
    activateWorkspace,
    daysUntilPurge: () => 30,
  };
});

// The plan's extra-document confirmation (the existing dialog's own call).
const confirmExtraDoc = vi.hoisted(() => vi.fn(async () => ({ ok: true, extra_doc_eur_marked: 3, plan_key: "starter" })));
vi.mock("@/lib/planState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/planState")>()),
  confirmExtraDoc,
}));

// The industry catalog the engine labels a new company's industry from.
vi.mock("@/lib/industryApi", () => ({
  listProfiles: vi.fn(async () => [
    { key: "agriculture", display_name: "Agriculture", display_name_ro: "Agricultură", sector: "primary" },
    { key: "food_manufacturing", display_name: "Food manufacturing", display_name_ro: "Producție alimentară", sector: "manufacturing" },
    { key: "manufacturing", display_name: "Manufacturing", display_name_ro: "Producție", sector: "manufacturing" },
  ]),
}));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), message: vi.fn() }));
vi.mock("@/components/ui/sonner", () => ({ toast }));

import { UploadFlowHost } from "@/components/cfo/upload/UploadFlowHost";
import WorkspaceHomeV2 from "@/pages/cfo/WorkspaceHomeV2";
import { NotificationsMenu } from "@/components/cfo/NotificationsMenu";

// ── fixtures ───────────────────────────────────────────────────────────
const COMPANIES = [
  { org_id: "scandia", name: "Scandia Food SRL", cui: "RO1234567" },
  { org_id: "agras", name: "Agras SA", cui: "RO7654321" },
];

function identity(over: Partial<IdentifyResult> = {}, idOver: Partial<IdentifyResult["identity"]> = {}): IdentifyResult {
  return {
    content_hash: "hash-1",
    identity: {
      cui: "RO7654321",
      company_name: "Agras SA",
      period_end: "2025-12-31",
      caen_code: "0111",
      industry_key: "agriculture",
      industry_label: "Agriculture",
      // The engine's own tokens (company_identity.py / _period_detect.SIGNALS).
      sources: {
        cui: { signal: "document_header_cui", evidence: "C.U.I. 7654321" },
        company_name: { signal: "registry", evidence: "registry CUI 7654321" },
        caen_code: { signal: "registry", evidence: "registry CUI 7654321" },
        period_end: { signal: "in_document", evidence: "Perioada: 01.01.2025 - 31.12.2025" },
        industry_key: { signal: "caen_catalogue", evidence: "CAEN 0111" },
      },
      ...idOver,
    },
    target: { org_id: "agras", name: "Agras SA", is_new: false, reason: "cui_match" },
    duplicate: null,
    companies: COMPANIES,
    ...over,
  };
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname + loc.search}</div>;
}

function renderHome() {
  return render(
    <TestProviders route="/workspace">
      <Routes>
        <Route
          path="*"
          element={
            <>
              <LocationProbe />
              <NotificationsMenu />
              <WorkspaceHomeV2 />
              <UploadFlowHost />
            </>
          }
        />
      </Routes>
    </TestProviders>,
  );
}

const fileOf = (name: string) => new File([new Uint8Array([1, 2, 3])], name, { type: "application/vnd.ms-excel" });

async function dropOnHome(name = "Balanta_Agras_dec_2025.xls") {
  const zone = await screen.findByTestId("upload-drop-zone");
  const file = fileOf(name);
  fireEvent.drop(zone, { dataTransfer: { files: [file], types: ["Files"] } });
  return file;
}

const card = () => screen.getByTestId("upload-card");
const row = (id: string) => within(card()).getByTestId(id);

beforeEach(async () => {
  await i18n.changeLanguage("en");
  __resetUploadFlowForTest();
  __resetUploadNoticesForTest();
  status.listeners.clear();
  api.identifyUpload.mockReset();
  api.commitUpload.mockReset();
  activateWorkspace.mockClear();
  confirmExtraDoc.mockClear();
  Object.values(toast).forEach((f) => f.mockClear());
});

afterEach(() => {
  cleanup();
});

describe("confirmation card", () => {
  it("G1 — an Agras file dropped while Scandia is open is addressed to Agras, each field saying where it came from", async () => {
    api.identifyUpload.mockResolvedValue(identity());
    renderHome();
    const file = await dropOnHome();

    expect(api.identifyUpload).toHaveBeenCalledWith(file, "scandia");
    await screen.findByText("Check before we analyse");
    expect(row("upload-card-company-value")).toHaveTextContent("Agras SA");
    expect(row("upload-card-company-from")).toHaveTextContent("from the ONRC/MF registry");
    expect(row("upload-card-cui-value")).toHaveTextContent("RO7654321");
    expect(row("upload-card-cui-from")).toHaveTextContent("from the document header");
    expect(row("upload-card-period-value")).toHaveTextContent("ending 31 December 2025");
    expect(row("upload-card-period-from")).toHaveTextContent("from the document's period line");
    expect(row("upload-card-industry-value")).toHaveTextContent("Agriculture");
    expect(row("upload-card-industry-from")).toHaveTextContent("from the CAEN code");
    expect(within(card()).getByTestId("upload-card-other-note")).toHaveTextContent(
      "This document belongs to Agras SA, not to the company open now.",
    );
    // One primary action; Change is the secondary.
    expect(within(card()).getByTestId("upload-card-analyse")).toHaveTextContent("Analyse");
    expect(within(card()).getByTestId("upload-card-change")).toHaveTextContent("Change");
  });

  it("G1 — Analyse commits to Agras and the screen and header follow it there", async () => {
    api.identifyUpload.mockResolvedValue(identity());
    api.commitUpload.mockResolvedValue({ status: "queued", document_id: "doc-1", org_id: "agras", company_name: "Agras SA" });
    renderHome();
    const file = await dropOnHome();
    await screen.findByText("Check before we analyse");
    fireEvent.click(within(card()).getByTestId("upload-card-analyse"));

    await waitFor(() => expect(api.commitUpload).toHaveBeenCalledTimes(1));
    expect(api.commitUpload).toHaveBeenCalledWith({
      file,
      onScreenOrgId: "scandia",
      periodEnd: "2025-12-31",
      industryKey: "agriculture",
      targetOrgId: "agras",
      createCompany: null,
    });
    await waitFor(() => expect(activateWorkspace).toHaveBeenCalledWith("agras", { name: "Agras SA", listChanged: false }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/workspace/agras"));
    // Five live steps, naming the company.
    expect(await screen.findByText("Analysing Agras SA")).toBeInTheDocument();
    expect(screen.getByTestId("upload-progress-step")).toHaveTextContent("Step 1 of 5");
    expect(screen.getByTestId("upload-progress-step-0")).toHaveAttribute("data-state", "running");
  });

  it("progress walks the pipeline, then toast + bell, then the analysed company's dashboard", async () => {
    api.identifyUpload.mockResolvedValue(identity());
    api.commitUpload.mockResolvedValue({ status: "queued", document_id: "doc-1", org_id: "agras", company_name: "Agras SA" });
    renderHome();
    await dropOnHome();
    await screen.findByText("Check before we analyse");
    fireEvent.click(within(card()).getByTestId("upload-card-analyse"));
    await screen.findByText("Analysing Agras SA");
    await waitFor(() => expect(status.listeners.has("doc-1")).toBe(true));

    act(() => status.listeners.get("doc-1")!({ id: "doc-1", status: "mapping", error: null, period_id: null }));
    expect(screen.getByTestId("upload-progress-step")).toHaveTextContent("Step 3 of 5");
    expect(screen.getByTestId("upload-progress-step-1")).toHaveAttribute("data-state", "done");
    expect(screen.getByTestId("upload-progress-step-2")).toHaveAttribute("data-state", "running");
    // A late poll can never walk the steps backwards.
    act(() => status.listeners.get("doc-1")!({ id: "doc-1", status: "extracting", error: null, period_id: null }));
    expect(screen.getByTestId("upload-progress-step")).toHaveTextContent("Step 3 of 5");

    act(() => status.listeners.get("doc-1")!({ id: "doc-1", status: "analyzed", error: null, period_id: "p-agras-2025" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Agras SA is analysed", expect.anything()));
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("/dashboard?period=p-agras-2025&org=agras"),
    );
    expect(activateWorkspace).toHaveBeenLastCalledWith("agras", { name: "Agras SA" });

    // The bell carries it, unread, and it opens the same dashboard.
    expect(screen.getByTestId("notifications-badge")).toHaveTextContent("1");
    fireEvent.click(screen.getByTestId("notifications-button"));
    const entry = await screen.findByTestId("notifications-analysis");
    expect(entry).toHaveAttribute("data-kind", "done");
    expect(entry).toHaveTextContent("Agras SA is analysed");
  });

  it("a failed analysis is announced as failed — toast, bell and the card", async () => {
    api.identifyUpload.mockResolvedValue(identity());
    api.commitUpload.mockResolvedValue({ status: "queued", document_id: "doc-2", org_id: "agras", company_name: "Agras SA" });
    renderHome();
    await dropOnHome();
    await screen.findByText("Check before we analyse");
    fireEvent.click(within(card()).getByTestId("upload-card-analyse"));
    await screen.findByText("Analysing Agras SA");
    await waitFor(() => expect(status.listeners.has("doc-2")).toBe(true));
    act(() =>
      status.listeners.get("doc-2")!({ id: "doc-2", status: "failed", error: "The trial balance does not balance.", period_id: null }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("The analysis of Agras SA failed", { description: "The trial balance does not balance." }),
    );
    expect(screen.getByText("The analysis of Agras SA failed")).toBeInTheDocument();
    expect(screen.getByText("The trial balance does not balance.")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("notifications-button"));
    expect(await screen.findByTestId("notifications-analysis")).toHaveAttribute("data-kind", "failed");
  });

  it("a duplicate is refused: nothing stored, 'Already uploaded — open it' opens that period", async () => {
    api.identifyUpload.mockResolvedValue(
      identity({ duplicate: { document_id: "doc-old", period_id: "p-agras-2025", org_id: "agras" } }),
    );
    renderHome();
    await dropOnHome();
    await screen.findByText("Already uploaded");
    expect(screen.getByTestId("upload-card-duplicate")).toHaveTextContent(
      "This exact file is already analysed for Agras SA. It wasn't saved again and it doesn't count.",
    );
    const open = screen.getByTestId("upload-card-duplicate-open");
    expect(open).toHaveTextContent("Already uploaded — open it");
    fireEvent.click(open);
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("/dashboard?period=p-agras-2025&org=agras"),
    );
    expect(activateWorkspace).toHaveBeenCalledWith("agras", { name: "Agras SA" });
    expect(api.commitUpload).not.toHaveBeenCalled();
  });

  it("a duplicate the commit finds (a race) ends on the same card", async () => {
    api.identifyUpload.mockResolvedValue(identity());
    api.commitUpload.mockResolvedValue({ status: "duplicate", document_id: "doc-old", period_id: "p-agras-2025", org_id: "agras" });
    renderHome();
    await dropOnHome();
    await screen.findByText("Check before we analyse");
    fireEvent.click(within(card()).getByTestId("upload-card-analyse"));
    expect(await screen.findByTestId("upload-card-duplicate-open")).toHaveTextContent("Already uploaded — open it");
  });

  it("a new CUI shows 'New company' and Analyse creates it — then the screen goes to it", async () => {
    api.identifyUpload.mockResolvedValue(
      identity(
        { target: { org_id: null, name: "Carniprod SRL", is_new: true, reason: "new_cui" } },
        { cui: "RO999999", company_name: "Carniprod SRL", caen_code: "1011", industry_key: "manufacturing", industry_label: "Manufacturing" },
      ),
    );
    api.commitUpload.mockResolvedValue({ status: "queued", document_id: "doc-3", org_id: "org-new", company_name: "Carniprod SRL" });
    renderHome();
    const file = await dropOnHome("carniprod.pdf");
    await screen.findByText("Check before we analyse");
    expect(within(card()).getByTestId("upload-card-new-badge")).toHaveTextContent("New company");
    expect(within(card()).getByTestId("upload-card-new-note")).toBeInTheDocument();
    fireEvent.click(within(card()).getByTestId("upload-card-analyse"));
    await waitFor(() =>
      expect(api.commitUpload).toHaveBeenCalledWith({
        file,
        onScreenOrgId: "scandia",
        periodEnd: "2025-12-31",
        industryKey: "manufacturing",
        targetOrgId: null,
        createCompany: { name: "Carniprod SRL", cui: "RO999999", caen_code: "1011", industry_key: "manufacturing" },
      }),
    );
    await waitFor(() => expect(activateWorkspace).toHaveBeenCalledWith("org-new", { name: "Carniprod SRL", listChanged: true }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/workspace/org-new"));
    expect(await screen.findByText("Analysing Carniprod SRL")).toBeInTheDocument();
  });

  it("Change — another of my companies, another period, another industry; each then reads 'chosen by you'", async () => {
    api.identifyUpload.mockResolvedValue(identity());
    api.commitUpload.mockResolvedValue({ status: "queued", document_id: "doc-4", org_id: "scandia", company_name: "Scandia Food SRL" });
    renderHome();
    const file = await dropOnHome();
    await screen.findByText("Check before we analyse");
    fireEvent.click(within(card()).getByTestId("upload-card-change"));
    const panel = await screen.findByTestId("upload-card-change-panel");
    fireEvent.click(within(panel).getByTestId("upload-change-company-scandia"));
    fireEvent.change(within(panel).getByTestId("upload-change-month"), { target: { value: "6" } });
    fireEvent.change(within(panel).getByTestId("upload-change-year"), { target: { value: "2024" } });
    fireEvent.change(within(panel).getByTestId("upload-change-industry"), { target: { value: "food_manufacturing" } });
    // Done = the same footer button that opened Change.
    fireEvent.click(within(card()).getByTestId("upload-card-change"));

    expect(row("upload-card-company-value")).toHaveTextContent("Scandia Food SRL");
    expect(row("upload-card-company-from")).toHaveTextContent("chosen by you");
    expect(row("upload-card-cui-value")).toHaveTextContent("RO1234567");
    expect(row("upload-card-period-value")).toHaveTextContent("ending 30 June 2024");
    expect(row("upload-card-period-from")).toHaveTextContent("chosen by you");
    expect(row("upload-card-industry-value")).toHaveTextContent("Food manufacturing");
    expect(row("upload-card-industry-from")).toHaveTextContent("chosen by you");

    fireEvent.click(within(card()).getByTestId("upload-card-analyse"));
    await waitFor(() =>
      expect(api.commitUpload).toHaveBeenCalledWith({
        file,
        onScreenOrgId: "scandia",
        periodEnd: "2024-06-30",
        industryKey: "food_manufacturing",
        targetOrgId: "scandia",
        createCompany: null,
      }),
    );
  });

  it("Change — 'New company' from the list creates one with the name and CUI typed", async () => {
    api.identifyUpload.mockResolvedValue(identity());
    api.commitUpload.mockResolvedValue({ status: "queued", document_id: "doc-5", org_id: "org-x", company_name: "Agras Trading SRL" });
    renderHome();
    await dropOnHome();
    await screen.findByText("Check before we analyse");
    fireEvent.click(within(card()).getByTestId("upload-card-change"));
    const panel = await screen.findByTestId("upload-card-change-panel");
    fireEvent.click(within(panel).getByTestId("upload-change-company-new"));
    fireEvent.change(within(panel).getByTestId("upload-change-new-name"), { target: { value: "Agras Trading SRL" } });
    fireEvent.change(within(panel).getByTestId("upload-change-new-cui"), { target: { value: "RO5555" } });
    fireEvent.click(within(card()).getByTestId("upload-card-analyse"));
    await waitFor(() =>
      expect(api.commitUpload).toHaveBeenCalledWith(
        expect.objectContaining({
          targetOrgId: null,
          createCompany: { name: "Agras Trading SRL", cui: "RO5555", caen_code: "0111", industry_key: "agriculture" },
        }),
      ),
    );
  });

  it("no CUI in the document → the company on screen, said so on the card", async () => {
    api.identifyUpload.mockResolvedValue(
      identity(
        { target: { org_id: "scandia", name: "Scandia Food SRL", is_new: false, reason: "on_screen_company" } },
        { cui: null, company_name: null, sources: { period_end: { signal: "period_line" } } },
      ),
    );
    renderHome();
    await dropOnHome("balanta.xlsx");
    await screen.findByText("Check before we analyse");
    expect(within(card()).getByTestId("upload-card-nocui-note")).toHaveTextContent(
      "We couldn't read a CUI in the document, so it goes to Scandia Food SRL. Change it if that's wrong.",
    );
    expect(row("upload-card-company-from")).toHaveTextContent("the company open now");
    expect(row("upload-card-cui-value")).toHaveTextContent("RO1234567");
    expect(row("upload-card-cui-from")).toHaveTextContent("from your company's settings");
  });

  it("G2 — no period in the document: Analyse waits for the user, Change opens by itself", async () => {
    api.identifyUpload.mockResolvedValue(identity({}, { period_end: null, sources: {} }));
    renderHome();
    // A filename that NAMES a month must not become the period.
    await dropOnHome("Balanta_decembrie_2025.xls");
    await screen.findByText("Check before we analyse");
    expect(row("upload-card-period-value")).toHaveTextContent("Not in the document");
    expect(within(card()).getByTestId("upload-card-analyse")).toBeDisabled();
    const panel = screen.getByTestId("upload-card-change-panel");
    fireEvent.change(within(panel).getByTestId("upload-change-month"), { target: { value: "12" } });
    expect(within(card()).getByTestId("upload-card-analyse")).not.toBeDisabled();
  });

  it("no industry in the document → the company keeps its own, said so; nothing is sent", async () => {
    api.identifyUpload.mockResolvedValue(
      identity({}, {
        industry_key: null,
        industry_label: null,
        caen_code: null,
        sources: {
          cui: { signal: "document_header_cui", evidence: "C.U.I. 7654321" },
          period_end: { signal: "closing_balance", evidence: "la data de 31.12.2025" },
        },
      }),
    );
    api.commitUpload.mockResolvedValue({ status: "queued", document_id: "doc-9", org_id: "agras", company_name: "Agras SA" });
    renderHome();
    await dropOnHome();
    await screen.findByText("Check before we analyse");
    // Agras is recorded as agriculture: that is what it keeps.
    await waitFor(() => expect(row("upload-card-industry-value")).toHaveTextContent("Agriculture"));
    expect(row("upload-card-industry-from")).toHaveTextContent("from your company's settings");
    fireEvent.click(within(card()).getByTestId("upload-card-analyse"));
    await waitFor(() => expect(api.commitUpload).toHaveBeenCalledTimes(1));
    // The company's own industry is not re-sent as a choice.
    expect(api.commitUpload.mock.calls[0][0].industryKey).toBeNull();
  });

  it("a value the engine gave no origin for shows none — the card never guesses one", async () => {
    api.identifyUpload.mockResolvedValue(identity({}, { sources: {} }));
    renderHome();
    await dropOnHome();
    await screen.findByText("Check before we analyse");
    expect(row("upload-card-period-value")).toHaveTextContent("ending 31 December 2025");
    expect(within(card()).queryByTestId("upload-card-period-from")).toBeNull();
    expect(within(card()).queryByTestId("upload-card-industry-from")).toBeNull();
    expect(within(card()).queryByTestId("upload-card-cui-from")).toBeNull();
  });

  it("a file the pipeline cannot read never reaches the engine", async () => {
    renderHome();
    await dropOnHome("notes.docx");
    expect(await screen.findByTestId("upload-card-error-view")).toHaveTextContent(
      "We can't read this kind of file. Use PDF, Excel (.xlsx, .xls), CSV or a photo.",
    );
    expect(api.identifyUpload).not.toHaveBeenCalled();
  });

  it("the plan's extra-document question (402) goes through the existing dialog, then the same commit runs", async () => {
    api.identifyUpload.mockResolvedValue(identity());
    api.commitUpload
      .mockResolvedValueOnce({
        status: "needs_confirmation",
        confirmation: { planKey: "starter", docsUsed: 5, docsIncluded: 5, extraDocEur: 3, message: "" },
      })
      .mockResolvedValueOnce({ status: "queued", document_id: "doc-6", org_id: "agras", company_name: "Agras SA" });
    renderHome();
    await dropOnHome();
    await screen.findByText("Check before we analyse");
    fireEvent.click(within(card()).getByTestId("upload-card-analyse"));
    fireEvent.click(await screen.findByTestId("extra-doc-confirm"));
    await waitFor(() => expect(confirmExtraDoc).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.commitUpload).toHaveBeenCalledTimes(2));
    expect(api.commitUpload.mock.calls[1]![0]).toEqual(api.commitUpload.mock.calls[0]![0]);
    expect(await screen.findByText("Analysing Agras SA")).toBeInTheDocument();
  });

  it("dismissing the extra-document question leaves the card as it was, saying nothing ran", async () => {
    api.identifyUpload.mockResolvedValue(identity());
    api.commitUpload.mockResolvedValueOnce({
      status: "needs_confirmation",
      confirmation: { planKey: "starter", docsUsed: 5, docsIncluded: 5, extraDocEur: 3, message: "" },
    });
    renderHome();
    await dropOnHome();
    await screen.findByText("Check before we analyse");
    fireEvent.click(within(card()).getByTestId("upload-card-analyse"));
    fireEvent.click(await screen.findByTestId("extra-doc-cancel"));
    expect(await screen.findByTestId("upload-card-error")).toHaveTextContent("The analysis didn't start.");
    expect(row("upload-card-company-value")).toHaveTextContent("Agras SA");
    expect(api.commitUpload).toHaveBeenCalledTimes(1);
  });
});

describe("plain language, both languages", () => {
  it("Romanian (tu-form): the card's own words", async () => {
    await i18n.changeLanguage("ro");
    api.identifyUpload.mockResolvedValue(
      identity({ target: { org_id: null, name: "Carniprod SRL", is_new: true, reason: "new_cui" } }),
    );
    renderHome();
    await dropOnHome();
    await screen.findByText("Verifică înainte să analizăm");
    expect(within(card()).getByTestId("upload-card-analyse")).toHaveTextContent("Analizează");
    expect(within(card()).getByTestId("upload-card-change")).toHaveTextContent("Modifică");
    expect(within(card()).getByTestId("upload-card-new-badge")).toHaveTextContent("Companie nouă");
    expect(row("upload-card-cui-from")).toHaveTextContent("din antetul documentului");
    expect(row("upload-card-company-from")).toHaveTextContent("din registrul ONRC/MF");
    expect(row("upload-card-industry-from")).toHaveTextContent("din codul CAEN");
    await waitFor(() => expect(row("upload-card-industry-value")).toHaveTextContent("Agricultură"));
  });

  it("Romanian: the duplicate reads 'Deja încărcat — deschide'", async () => {
    await i18n.changeLanguage("ro");
    api.identifyUpload.mockResolvedValue(
      identity({ duplicate: { document_id: "d", period_id: "p", org_id: "agras" } }),
    );
    renderHome();
    await dropOnHome();
    expect(await screen.findByTestId("upload-card-duplicate-open")).toHaveTextContent("Deja încărcat — deschide");
  });

  it.each(["en", "ro"])("no source / attachment words anywhere on the card (%s)", async (lang) => {
    await i18n.changeLanguage(lang);
    api.identifyUpload.mockResolvedValue(identity());
    renderHome();
    await dropOnHome();
    await screen.findByTestId("upload-card-analyse");
    fireEvent.click(within(card()).getByTestId("upload-card-change"));
    const text = card().textContent ?? "";
    expect(text).not.toMatch(/\b(source|attachment|attached)\b/i);
    expect(text).not.toMatch(/surs[ăa]|ata[șs]ament/i);
  });
});
