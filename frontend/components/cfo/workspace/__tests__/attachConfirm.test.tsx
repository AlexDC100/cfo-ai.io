// PART C — THE ATTACH/REPLACE CONFIRM STEP.
//
// THE BUG THESE TESTS EXIST FOR
// ─────────────────────────────
// `documents.period_end_hint` is a CONFIRMATION channel: the engine's
// `stage_persist` ranks it above its own (correct) detection because the
// hint is supposed to mean "a human confirmed THIS document belongs to
// THIS month". PeriodsSection filled it with the DROP TARGET's date:
//
//     uploadDocument(file, { periodEndHint: p.period_end })   // ← the row
//
// Nothing in that value came off the document. The 2026-08-30 production
// audit found every mismatched row carrying `hint == stored`, including
// "Carniprod Trial Balance 2025.xlsx" filed under 2017-12, and one month
// (2025-12) holding two different companies' books.
//
// The fix: the target's date NEVER becomes a hint. A hint is written only
// after a human confirmed a month in the dialog below, against evidence
// read off the document itself.
//
// LAWS PINNED HERE
//   · The drop target is context, never a default and never a hint.
//   · ABSENT != ZERO — "not detected" disables the confirm until a human
//     picks; it never falls back to today or to the open period.
//   · A choice that disagrees with the document is ALLOWED but never
//     SILENT (mismatch guard), and so is a second company in one month
//     (entity guard) — which offers a new period as the primary way out.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { OrgPeriod, OrgPeriodsPayload } from "@/lib/orgPeriods";
import type { DocumentInspection, EntityIdentity, PeriodDetection } from "@/lib/periodDetect";

// ─── module mocks (shared by both halves) ────────────────────────────────

const uploadDocument = vi.fn(async () => ({ row: { id: "doc-new" }, error: null }));
const subscribeToDocumentStatus = vi.fn(() => () => {});
const createEmptyPeriod = vi.fn(async () => ({ id: "period-created" }));

vi.mock("@/lib/supabase", () => ({
  getSupabase: () => null,
  uploadDocument: (...args: unknown[]) => uploadDocument(...(args as [])),
  subscribeToDocumentStatus: (...args: unknown[]) =>
    subscribeToDocumentStatus(...(args as [])),
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));

vi.mock("@/hooks/useUploadEnqueue", () => ({
  useUploadEnqueue: () => ({
    enqueue: async () => ({ kind: "queued" as const }),
    dialog: null,
  }),
}));

vi.mock("@/lib/activePeriod", () => ({
  periodQueryKey: (id: string) => ["period", id],
  useActivePeriod: () => ({ id: null }),
  fetchPeriodFromApi: async () => ({ kind: "error" as const }),
}));

const PERIODS: OrgPeriod[] = [
  {
    period_id: "p-2025-12",
    period_label: "2025-12-31",
    period_start: null,
    period_end: "2025-12-31",
    documents: [
      {
        id: "doc-scandia",
        filename: "Scandia RealEstate TB.xlsx",
        status: "analyzed",
        uploaded_at: "2026-01-14T09:00:00Z",
      },
    ],
  },
  {
    period_id: "p-2017-12",
    period_label: "2017-12-31",
    period_start: null,
    period_end: "2017-12-31",
    documents: [],
  },
];

const PAYLOAD: OrgPeriodsPayload = { active_period_id: null, periods: PERIODS };

vi.mock("@/lib/orgPeriods", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/orgPeriods")>();
  return {
    ...actual,
    fetchWorkspacePeriodsDirect: async () => PAYLOAD,
    createEmptyPeriod: (...args: unknown[]) => createEmptyPeriod(...(args as [])),
    updatePeriodEnd: async () => null,
    deleteEmptyPeriod: async () => null,
  };
});

import { AttachConfirmDialog } from "../AttachConfirmDialog";
import { PeriodsSection } from "../PeriodsSection";

// ─── fixtures pinned to the production audit ─────────────────────────────

const CARNIPROD_FILE = () =>
  new File(["balanta"], "Carniprod Trial Balance 2025.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });

const DETECTED_2025: PeriodDetection = {
  proposedPeriodEnd: "2025-12-31",
  confidence: 0.85,
  signalUsed: "closing_balance",
  evidenceSnippet: "BALANTA DE VERIFICARE la data de 31.12.2025",
  candidates: [],
  origin: "engine",
};

const ABSENT: PeriodDetection = {
  proposedPeriodEnd: null,
  confidence: 0,
  signalUsed: "none",
  evidenceSnippet: null,
  candidates: [],
  origin: "engine",
};

const CARNIPROD_ENTITY: EntityIdentity = {
  name: "S.C. CARNIPROD S.R.L.",
  cui: "1234567",
  evidence: "S.C. CARNIPROD S.R.L.",
};

const NO_ENTITY: EntityIdentity = { name: null, cui: null, evidence: null };

function inspector(inspection: DocumentInspection) {
  return vi.fn(async () => inspection);
}

function renderDialog(props: Partial<React.ComponentProps<typeof AttachConfirmDialog>>) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const utils = render(
    <MemoryRouter>
      <AttachConfirmDialog
        open
        mode="attach"
        file={CARNIPROD_FILE()}
        periods={PERIODS}
        context={{ periodId: "p-2017-12", periodEnd: "2017-12-31", reason: "dropped" }}
        replacing={null}
        onConfirm={onConfirm}
        onCancel={onCancel}
        inspect={inspector({ detection: DETECTED_2025, entity: CARNIPROD_ENTITY })}
        resolvePeriodEntity={async () => null}
        {...props}
      />
    </MemoryRouter>,
  );
  return { ...utils, onConfirm, onCancel };
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

afterEach(() => cleanup());

// ─── the confirm step itself ─────────────────────────────────────────────

describe("AttachConfirmDialog — the document decides the default", () => {
  it("pre-fills the DETECTED month, not the row the file was dropped on", async () => {
    renderDialog({});
    const month = (await screen.findByTestId("attach-confirm-month")) as HTMLInputElement;
    await waitFor(() => expect(month.value).toBe("2025-12"));
    expect(month.value).not.toBe("2017-12");
  });

  it("always says WHY — the evidence line names the signal", async () => {
    renderDialog({});
    const evidence = await screen.findByTestId("attach-confirm-evidence");
    await waitFor(() => expect(evidence.textContent).toMatch(/closing date/i));
    expect(evidence.textContent).toMatch(/December 2025/i);
  });

  it("W1 — detection is handed the FILE and nothing else", async () => {
    const inspect = inspector({ detection: DETECTED_2025, entity: CARNIPROD_ENTITY });
    renderDialog({ inspect });
    await waitFor(() => expect(inspect).toHaveBeenCalledTimes(1));
    const call = inspect.mock.calls[0] as unknown[];
    expect(call).toHaveLength(1);
    expect(call[0]).toBeInstanceOf(File);
  });

  it("confirms the detected month with no extra clicks when nothing disagrees", async () => {
    const { onConfirm } = renderDialog({});
    const submit = await screen.findByTestId("attach-confirm-submit");
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0][0]).toMatchObject({
      periodEnd: "2025-12-31",
      overrodeDetection: false,
    });
  });
});

describe("AttachConfirmDialog — ABSENT != ZERO", () => {
  it("pre-fills nothing and blocks the confirm until a human picks", async () => {
    renderDialog({
      inspect: inspector({ detection: ABSENT, entity: NO_ENTITY }),
    });
    const month = (await screen.findByTestId("attach-confirm-month")) as HTMLInputElement;
    await waitFor(() => expect(screen.getByTestId("attach-confirm-evidence")).toBeTruthy());
    expect(month.value).toBe("");
    expect(screen.getByTestId("attach-confirm-evidence").textContent).toMatch(
      /not detected/i,
    );
    expect(screen.getByTestId("attach-confirm-submit")).toBeDisabled();
  });

  it("never falls back to today", async () => {
    renderDialog({
      inspect: inspector({ detection: ABSENT, entity: NO_ENTITY }),
    });
    const month = (await screen.findByTestId("attach-confirm-month")) as HTMLInputElement;
    await waitFor(() => expect(screen.getByTestId("attach-confirm-evidence")).toBeTruthy());
    expect(month.value).not.toBe(new Date().toISOString().slice(0, 7));
  });

  it("enables the confirm once the human chooses", async () => {
    const { onConfirm } = renderDialog({
      inspect: inspector({ detection: ABSENT, entity: NO_ENTITY }),
    });
    const month = (await screen.findByTestId("attach-confirm-month")) as HTMLInputElement;
    fireEvent.change(month, { target: { value: "2024-06" } });
    const submit = screen.getByTestId("attach-confirm-submit");
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);
    expect(onConfirm.mock.calls[0][0]).toMatchObject({ periodEnd: "2024-06-30" });
  });
});

describe("AttachConfirmDialog — mismatch guard (the Carniprod case)", () => {
  it("blocks a silent override and names both months", async () => {
    const { onConfirm } = renderDialog({});
    const month = (await screen.findByTestId("attach-confirm-month")) as HTMLInputElement;
    await waitFor(() => expect(month.value).toBe("2025-12"));

    fireEvent.change(month, { target: { value: "2017-12" } });

    const guard = await screen.findByTestId("attach-confirm-mismatch");
    expect(guard.textContent).toMatch(/December 2025/i);
    expect(guard.textContent).toMatch(/December 2017/i);
    // Not silent: the confirm is unavailable until it is acknowledged.
    expect(screen.getByTestId("attach-confirm-submit")).toBeDisabled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("allows the override once acknowledged, and records it", async () => {
    const { onConfirm } = renderDialog({});
    const month = (await screen.findByTestId("attach-confirm-month")) as HTMLInputElement;
    await waitFor(() => expect(month.value).toBe("2025-12"));
    fireEvent.change(month, { target: { value: "2017-12" } });
    fireEvent.click(await screen.findByTestId("attach-confirm-override"));
    const submit = screen.getByTestId("attach-confirm-submit");
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);
    expect(onConfirm.mock.calls[0][0]).toMatchObject({
      periodEnd: "2017-12-31",
      periodId: "p-2017-12",
      overrodeDetection: true,
    });
  });
});

describe("AttachConfirmDialog — entity guard (two companies, one month)", () => {
  it("warns and offers a new period as the PRIMARY way out", async () => {
    const { onConfirm } = renderDialog({
      resolvePeriodEntity: async (periodId: string) =>
        periodId === "p-2025-12"
          ? { name: "SCANDIA REALESTATE SRL", cui: null, evidence: null }
          : null,
    });
    const guard = await screen.findByTestId("attach-confirm-entity");
    expect(guard.textContent).toMatch(/CARNIPROD/i);
    expect(guard.textContent).toMatch(/SCANDIA/i);

    const newPeriod = screen.getByTestId("attach-confirm-new-period");
    fireEvent.click(newPeriod);
    expect(onConfirm.mock.calls[0][0]).toMatchObject({
      periodEnd: "2025-12-31",
      periodId: null, // a NEW period for that month — not Scandia's
    });
  });

  it("still allows attaching anyway, but only after an explicit acknowledgement", async () => {
    const { onConfirm } = renderDialog({
      resolvePeriodEntity: async (periodId: string) =>
        periodId === "p-2025-12"
          ? { name: "SCANDIA REALESTATE SRL", cui: null, evidence: null }
          : null,
    });
    await screen.findByTestId("attach-confirm-entity");
    expect(screen.getByTestId("attach-confirm-submit")).toBeDisabled();
    fireEvent.click(screen.getByTestId("attach-confirm-override"));
    const submit = screen.getByTestId("attach-confirm-submit");
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);
    expect(onConfirm.mock.calls[0][0]).toMatchObject({ periodId: "p-2025-12" });
  });
});

describe("AttachConfirmDialog — replace mode", () => {
  it("shows what is being replaced: filename, period and upload date", async () => {
    renderDialog({
      mode: "replace",
      context: { periodId: "p-2025-12", periodEnd: "2025-12-31", reason: "replacing" },
      replacing: {
        id: "doc-scandia",
        filename: "Scandia RealEstate TB.xlsx",
        status: "analyzed",
        uploaded_at: "2026-01-14T09:00:00Z",
      },
      resolvePeriodEntity: async () => null,
    });
    const card = await screen.findByTestId("attach-confirm-replacing");
    expect(card.textContent).toContain("Scandia RealEstate TB.xlsx");
    expect(card.textContent).toMatch(/December 2025/i);
    expect(card.textContent).toMatch(/14/); // the upload date
  });
});

// ─── THE CORE FIX, at the call site ──────────────────────────────────────

describe("PeriodsSection — the drop target is never a hint", () => {
  function renderSection() {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <PeriodsSection orgId="org-1" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  function dropOn(row: HTMLElement, file: File) {
    fireEvent.drop(row, {
      dataTransfer: { files: [file], types: ["Files"], items: [] },
    });
  }

  it("dropping a file uploads NOTHING until a human confirms the month", async () => {
    renderSection();
    const row = await screen.findByTestId("wsset-period-row-p-2017-12");
    dropOn(row, CARNIPROD_FILE());
    await screen.findByTestId("attach-confirm-dialog");
    expect(uploadDocument).not.toHaveBeenCalled();
  });

  it("sends the CONFIRMED month as the hint — never the row's own date", async () => {
    renderSection();
    const row = await screen.findByTestId("wsset-period-row-p-2017-12");
    dropOn(row, CARNIPROD_FILE());
    await screen.findByTestId("attach-confirm-dialog");

    // The dialog reads the real inspector here; force the production
    // answer through the month field the way a human would confirm it.
    const month = (await screen.findByTestId("attach-confirm-month")) as HTMLInputElement;
    fireEvent.change(month, { target: { value: "2025-12" } });
    const override = screen.queryByTestId("attach-confirm-override");
    if (override) fireEvent.click(override);
    const submit = screen.getByTestId("attach-confirm-submit");
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);

    await waitFor(() => expect(uploadDocument).toHaveBeenCalledTimes(1));
    const opts = uploadDocument.mock.calls[0][1] as { periodEndHint?: string | null };
    expect(opts.periodEndHint).toBe("2025-12-31");
    expect(opts.periodEndHint).not.toBe("2017-12-31");
  });
});
