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

    // The flow reads the file's bytes (lib/fileKind) before it asks the engine.
    await waitFor(() => expect(api.identifyUpload).toHaveBeenCalledWith(file, "scandia"));
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

  it("a failure while calculating marks THAT step as failed and keeps the earlier steps done", async () => {
    // Owner-reported: every failed analysis showed step 1 ("Recognising the
    // document") as the one that failed and reset the completed steps —
    // whatever the document's status had reached. The card marks the step
    // the document was on when it failed, from the statuses it reported.
    api.identifyUpload.mockResolvedValue(identity());
    api.commitUpload.mockResolvedValue({ status: "queued", document_id: "doc-3", org_id: "agras", company_name: "Agras SA" });
    renderHome();
    await dropOnHome();
    await screen.findByText("Check before we analyse");
    fireEvent.click(within(card()).getByTestId("upload-card-analyse"));
    await screen.findByText("Analysing Agras SA");
    await waitFor(() => expect(status.listeners.has("doc-3")).toBe(true));
    act(() => status.listeners.get("doc-3")!({ id: "doc-3", status: "mapping", error: null, period_id: null }));
    act(() => status.listeners.get("doc-3")!({ id: "doc-3", status: "computing", error: null, period_id: null }));
    expect(screen.getByTestId("upload-progress-step-3")).toHaveAttribute("data-state", "running");
    act(() =>
      status.listeners.get("doc-3")!({ id: "doc-3", status: "failed", error: "RuntimeError: compute failed", period_id: null }),
    );
    expect(await screen.findByText("The analysis of Agras SA failed")).toBeInTheDocument();
    expect(screen.getByTestId("upload-card-progress")).toHaveAttribute("data-status", "failed");
    for (const done of [0, 1, 2]) {
      expect(screen.getByTestId(`upload-progress-step-${done}`), `step ${done + 1} was done before the failure`).toHaveAttribute("data-state", "done");
    }
    expect(screen.getByTestId("upload-progress-step-3"), "the step that failed").toHaveAttribute("data-state", "failed");
    expect(screen.getByTestId("upload-progress-step-4"), "never reached").toHaveAttribute("data-state", "waiting");
    expect(screen.getByText("RuntimeError: compute failed")).toBeInTheDocument();
  });

  it("a failure before anything was read marks the first step, and nothing as done", async () => {
    api.identifyUpload.mockResolvedValue(identity());
    api.commitUpload.mockResolvedValue({ status: "queued", document_id: "doc-4", org_id: "agras", company_name: "Agras SA" });
    renderHome();
    await dropOnHome();
    await screen.findByText("Check before we analyse");
    fireEvent.click(within(card()).getByTestId("upload-card-analyse"));
    await screen.findByText("Analysing Agras SA");
    await waitFor(() => expect(status.listeners.has("doc-4")).toBe(true));
    act(() => status.listeners.get("doc-4")!({ id: "doc-4", status: "failed", error: "The file is empty.", period_id: null }));
    await screen.findByText("The analysis of Agras SA failed");
    expect(screen.getByTestId("upload-progress-step-0")).toHaveAttribute("data-state", "failed");
    for (const later of [1, 2, 3, 4]) {
      expect(screen.getByTestId(`upload-progress-step-${later}`)).toHaveAttribute("data-state", "waiting");
    }
  });

  // The real file type comes from the bytes, never from the name. A Word
  // document renamed .pdf (a PK container with word/document.xml inside) is
  // told so on the card, and never leaves the browser.
  const docxRenamedPdf = () => {
    const head = new TextEncoder().encode("PK\u0003\u0004");
    const entry = new TextEncoder().encode("\u0000".repeat(26) + "word/document.xml<w:document/>");
    const bytes = new Uint8Array(head.length + entry.length);
    bytes.set(head, 0);
    bytes.set(entry, head.length);
    return new File([bytes], "raport.pdf", { type: "application/pdf" });
  };

  it("a Word document renamed .pdf is told so on the card, and identify is never called", async () => {
    api.identifyUpload.mockResolvedValue(identity());
    renderHome();
    const zone = await screen.findByTestId("upload-drop-zone");
    fireEvent.drop(zone, { dataTransfer: { files: [docxRenamedPdf()], types: ["Files"] } });
    expect(await screen.findByText("This is a Word document, not a PDF")).toBeInTheDocument();
    expect(card()).toHaveAttribute("data-phase", "error");
    expect(api.identifyUpload).not.toHaveBeenCalled();
    expect(within(card()).queryByTestId("upload-card-analyse")).toBeNull();
  });

  it("Romanian: 'Acesta este un document Word, nu un PDF'", async () => {
    await i18n.changeLanguage("ro");
    api.identifyUpload.mockResolvedValue(identity());
    renderHome();
    const zone = await screen.findByTestId("upload-drop-zone");
    fireEvent.drop(zone, { dataTransfer: { files: [docxRenamedPdf()], types: ["Files"] } });
    expect(await screen.findByText("Acesta este un document Word, nu un PDF")).toBeInTheDocument();
    expect(api.identifyUpload).not.toHaveBeenCalled();
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

  // Live walkthrough, 2026-09-26 (P0 for launch): a new account has ONE
  // empty workspace and a plan for one company; its first balance prints a
  // CUI. The engine reports that the empty workspace becomes the company, and
  // the card says so — the commit is the ordinary new-company commit, which
  // the engine turns into the adoption.
  it("a new account's first balance: 'Your empty workspace becomes this company', and the screen follows", async () => {
    api.identifyUpload.mockResolvedValue(
      identity(
        { target: { org_id: "scandia", name: "Carniprod SRL", is_new: true, reason: "adopt_empty_workspace" } },
        { cui: "RO999999", company_name: "Carniprod SRL", caen_code: "1011", industry_key: "manufacturing", industry_label: "Manufacturing" },
      ),
    );
    api.commitUpload.mockResolvedValue({
      status: "queued", document_id: "doc-adopt", org_id: "scandia", company_name: "Carniprod SRL",
      created_company: false, adopted_company: true,
    });
    renderHome();
    const file = await dropOnHome("carniprod.pdf");
    await screen.findByText("Check before we analyse");
    expect(within(card()).getByTestId("upload-card-adopt-note")).toHaveTextContent("Your empty workspace becomes this company.");
    expect(within(card()).queryByTestId("upload-card-new-note")).toBeNull();
    expect(row("upload-card-company-value")).toHaveTextContent("Carniprod SRL");
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
    // Renamed: the company list is re-read, and the screen follows the company.
    await waitFor(() => expect(activateWorkspace).toHaveBeenCalledWith("scandia", { name: "Carniprod SRL", listChanged: true }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/workspace/scandia"));
  });

  it("Romanian: 'Folosim spațiul tău gol pentru această companie'", async () => {
    await i18n.changeLanguage("ro");
    api.identifyUpload.mockResolvedValue(
      identity({ target: { org_id: "scandia", name: "Carniprod SRL", is_new: true, reason: "adopt_empty_workspace" } }, { cui: "RO999999", company_name: "Carniprod SRL" }),
    );
    renderHome();
    await dropOnHome();
    await screen.findByText("Verifică înainte să analizăm");
    expect(within(card()).getByTestId("upload-card-adopt-note")).toHaveTextContent("Folosim spațiul tău gol pentru această companie.");
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

  // Live walkthrough, 2026-09-26: the summary named the company's industry
  // ("from your company's settings") while Change's INDUSTRY select read
  // "Not set". The form starts from the value the card shows, and leaving it
  // untouched sends nothing — the company keeps its industry.
  it("Change starts from the industry the card shows — the company's own — and an untouched select sends none", async () => {
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
    api.commitUpload.mockResolvedValue({ status: "queued", document_id: "doc-10", org_id: "agras", company_name: "Agras SA" });
    renderHome();
    await dropOnHome();
    await screen.findByText("Check before we analyse");
    await waitFor(() => expect(row("upload-card-industry-value")).toHaveTextContent("Agriculture"));
    fireEvent.click(within(card()).getByTestId("upload-card-change"));
    const panel = await screen.findByTestId("upload-card-change-panel");
    const select = within(panel).getByTestId("upload-change-industry") as HTMLSelectElement;
    expect(select.value, "the form read another value than the card").toBe("agriculture");
    expect(select.selectedOptions[0]?.textContent).toBe("Agriculture");
    // An upload cannot clear the company's industry: "Not set" is not offered over it.
    expect([...select.options].map((o) => o.value)).not.toContain("");
    // Another field changed, the industry left as shown: the commit sends no industry.
    fireEvent.change(within(panel).getByTestId("upload-change-month"), { target: { value: "6" } });
    expect(row("upload-card-industry-value")).toHaveTextContent("Agriculture");
    expect(row("upload-card-industry-from")).toHaveTextContent("from your company's settings");
    fireEvent.click(within(card()).getByTestId("upload-card-analyse"));
    await waitFor(() => expect(api.commitUpload).toHaveBeenCalledTimes(1));
    expect(api.commitUpload.mock.calls[0][0].industryKey).toBeNull();
    expect(api.commitUpload.mock.calls[0][0].periodEnd).toBe("2025-06-30");
  });

  it("a new company's form still offers 'Not set' and starts from the document's industry", async () => {
    api.identifyUpload.mockResolvedValue(
      identity({ target: { org_id: null, name: "Carniprod SRL", is_new: true, reason: "new_cui" } }, { cui: "RO999999", company_name: "Carniprod SRL" }),
    );
    renderHome();
    await dropOnHome();
    await screen.findByText("Check before we analyse");
    fireEvent.click(within(card()).getByTestId("upload-card-change"));
    const select = within(await screen.findByTestId("upload-card-change-panel")).getByTestId("upload-change-industry") as HTMLSelectElement;
    expect(select.value).toBe("agriculture");
    expect([...select.options].map((o) => o.value)).toContain("");
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
      "We can't read this kind of file. Use an Excel sheet (.xlsx) or a PDF with a text layer.",
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
    await waitFor(() => expect(api.commitUpload).toHaveBeenCalledTimes(2));
    // The same commit, now carrying the answer — there is no stored document
    // yet for /api/plan/confirm-extra-doc to grant the extra to: the engine
    // grants it to the document this commit stores.
    expect(api.commitUpload.mock.calls[1]![0]).toEqual({ ...api.commitUpload.mock.calls[0]![0], confirmExtra: true });
    expect(api.commitUpload.mock.calls[0]![0].confirmExtra).toBeUndefined();
    expect(confirmExtraDoc).not.toHaveBeenCalled();
    expect(await screen.findByText("Analysing Agras SA")).toBeInTheDocument();
  });

  // Live walkthrough, 2026-09-26: a new company's commit at the plan's
  // workspace cap answered 500 and the card read "We couldn't save the file".
  // The engine answers 402 workspace_cap_reached; the card says how many
  // companies the plan allows, with the upgrade path and the choice of one of
  // the user's companies.
  it("the plan's company cap (402): the plan's words, the upgrade path and one of my companies — never 'couldn't save'", async () => {
    api.identifyUpload.mockResolvedValue(
      identity({ target: { org_id: null, name: "Carniprod SRL", is_new: true, reason: "new_cui" } }, { cui: "RO999999", company_name: "Carniprod SRL" }),
    );
    api.commitUpload.mockResolvedValue({ status: "cap_reached", plan: "trial", cap: 1, message: "Your plan allows 1 company." });
    renderHome();
    const file = await dropOnHome();
    await screen.findByText("Check before we analyse");
    fireEvent.click(within(card()).getByTestId("upload-card-analyse"));

    const cap = await within(card()).findByTestId("upload-card-cap");
    expect(within(cap).getByTestId("upload-card-cap-body")).toHaveTextContent(
      "Your plan allows 1 company — this file would be a new one. Upgrade to add it, or put the file in one of your companies.",
    );
    expect(within(cap).getByTestId("upload-card-cap-upgrade")).toHaveAttribute("href", "/pricing");
    expect(within(cap).getByTestId("upload-card-cap-upgrade")).toHaveTextContent("View plans");
    expect(card()).not.toHaveTextContent("We couldn't save the file");
    expect(within(card()).queryByTestId("upload-card-error")).toBeNull();
    // Analysing again would only meet the same cap.
    expect(within(card()).getByTestId("upload-card-analyse")).toBeDisabled();
    expect(activateWorkspace).not.toHaveBeenCalled();

    // "Choose one of your companies" opens Change; choosing one clears the cap.
    fireEvent.click(within(cap).getByTestId("upload-card-cap-choose"));
    const panel = await screen.findByTestId("upload-card-change-panel");
    fireEvent.click(within(panel).getByTestId("upload-change-company-scandia"));
    expect(within(card()).queryByTestId("upload-card-cap")).toBeNull();
    expect(within(card()).getByTestId("upload-card-analyse")).not.toBeDisabled();
    api.commitUpload.mockResolvedValue({ status: "queued", document_id: "doc-cap", org_id: "scandia", company_name: "Scandia Food SRL" });
    fireEvent.click(within(card()).getByTestId("upload-card-analyse"));
    await waitFor(() =>
      expect(api.commitUpload).toHaveBeenLastCalledWith(expect.objectContaining({ file, targetOrgId: "scandia", createCompany: null })),
    );
  });

  it("Romanian: 'Planul tău permite 5 companii — …'", async () => {
    await i18n.changeLanguage("ro");
    api.identifyUpload.mockResolvedValue(
      identity({ target: { org_id: null, name: "Carniprod SRL", is_new: true, reason: "new_cui" } }, { cui: "RO999999", company_name: "Carniprod SRL" }),
    );
    api.commitUpload.mockResolvedValue({ status: "cap_reached", plan: "pro", cap: 5, message: "Your plan allows 5 companies." });
    renderHome();
    await dropOnHome();
    await screen.findByText("Verifică înainte să analizăm");
    fireEvent.click(within(card()).getByTestId("upload-card-analyse"));
    const cap = await within(card()).findByTestId("upload-card-cap");
    expect(within(cap).getByTestId("upload-card-cap-body")).toHaveTextContent(
      "Planul tău permite 5 companii — fișierul ăsta ar fi o companie nouă.",
    );
    expect(within(cap).getByTestId("upload-card-cap-upgrade")).toHaveTextContent("Vezi planurile");
    expect(card()).not.toHaveTextContent("N-am putut salva fișierul");
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
