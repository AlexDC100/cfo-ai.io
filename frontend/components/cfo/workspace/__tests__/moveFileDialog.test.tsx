// PART D — THE MOVE, from the user's side.
//
// This is where `documents.period_end_hint` is legitimately written. The
// channel means "a human confirmed THIS document belongs to THIS month",
// and the whole period-assignment bug was the upload path filling it with
// the DROP TARGET's date instead. So the dialog has to make the
// confirmation real, and these tests pin what "real" means:
//
//   · The month offered comes from the ENGINE reading the document
//     (`/api/period/detect`, hint-free by construction), never from the
//     row the file is sitting in.
//   · A file the engine could not read, and a file the engine read and
//     found silent, are DIFFERENT states with different words. Saying
//     "this file doesn't say which month it covers" when we never got an
//     answer would be asserting a fact about a document we never read —
//     the same error, one level up.
//   · Nothing is pre-selected unless the document itself pointed at it.
//     ABSENT != ZERO: no month, no default, no move.
//   · A completed move sends the month the human confirmed, and only
//     that.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import "@/i18n";
import type { DetectOutcome, MoveResult } from "../periodFiling";

const detectPeriodForFilename = vi.fn<[], Promise<DetectOutcome>>();
const moveDocumentToPeriod = vi.fn();

vi.mock("../periodFiling", () => ({
  detectPeriodForFilename: (...a: unknown[]) =>
    detectPeriodForFilename(...(a as [])),
  moveDocumentToPeriod: (...a: unknown[]) => moveDocumentToPeriod(...(a as [])),
}));

const toastSuccess = vi.fn();
const toastWarning = vi.fn();
const toastError = vi.fn();
vi.mock("@/components/ui/sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...(a as [])),
    warning: (...a: unknown[]) => toastWarning(...(a as [])),
    error: (...a: unknown[]) => toastError(...(a as [])),
    info: vi.fn(),
    message: vi.fn(),
  },
}));

import { MoveFileDialog } from "../MoveFileDialog";

const CARNIPROD = {
  id: "doc-carniprod",
  name: "Carniprod Trial Balance 2025.xlsx",
  // The audited row: a 2025 trial balance sitting in 2017-12.
  currentMonth: "2017-12",
};

const ANSWERED_2025: DetectOutcome = {
  kind: "answered",
  detection: {
    proposed_period_end: "2025-12-31",
    confidence: 0.6,
    signal_used: "filename",
    evidence_snippet: "Carniprod Trial Balance 2025.xlsx",
    candidates: [],
  },
};

const ANSWERED_SILENT: DetectOutcome = {
  kind: "answered",
  detection: {
    proposed_period_end: null,
    confidence: 0,
    signal_used: "none",
    evidence_snippet: null,
    candidates: [],
  },
};

const MOVED: MoveResult = {
  ok: true,
  moved: true,
  document_id: "doc-carniprod",
  period_end_hint: "2025-12-31",
  from: { period_id: "p-2017-12", period_end: "2017-12-31", action: "deleted" },
  to: { period_end: "2025-12-31", period_id: null },
  rebuild_document_id: null,
  orphaned_after: [],
};

function renderDialog() {
  const onMoved = vi.fn();
  const onClose = vi.fn();
  render(
    <MoveFileDialog
      orgId="org-1"
      target={CARNIPROD}
      onClose={onClose}
      onMoved={onMoved}
    />,
  );
  return { onMoved, onClose };
}

beforeEach(() => {
  detectPeriodForFilename.mockReset();
  moveDocumentToPeriod.mockReset();
  toastSuccess.mockReset();
  toastWarning.mockReset();
  toastError.mockReset();
  moveDocumentToPeriod.mockResolvedValue(MOVED);
});
afterEach(cleanup);

describe("the month is offered by the document, not by the row", () => {
  it("shows what the file says, with the reason, and pre-selects it", async () => {
    detectPeriodForFilename.mockResolvedValue(ANSWERED_2025);
    renderDialog();
    await waitFor(() =>
      expect(screen.getByTestId("pf-move-evidence").textContent).toContain(
        "Dec 2025",
      ),
    );
    expect(screen.getByTestId("pf-move-evidence").textContent).toContain(
      "from the file name",
    );
    expect(
      (screen.getByTestId("pf-move-month") as HTMLInputElement).value,
    ).toBe("2025-12");
  });

  it("never pre-selects the period the file is currently sitting in", async () => {
    // The bug, restated as a UI law: 2017-12 is where it IS, and that is
    // exactly the value that must never be offered as the answer.
    detectPeriodForFilename.mockResolvedValue(ANSWERED_2025);
    renderDialog();
    await waitFor(() =>
      expect(
        (screen.getByTestId("pf-move-month") as HTMLInputElement).value,
      ).not.toBe("2017-12"),
    );
  });

  it("asks the engine about the FILE, and passes it nothing else", async () => {
    detectPeriodForFilename.mockResolvedValue(ANSWERED_2025);
    renderDialog();
    await waitFor(() => expect(detectPeriodForFilename).toHaveBeenCalled());
    const args = detectPeriodForFilename.mock.calls[0] as unknown[];
    expect(args).toEqual(["org-1", "Carniprod Trial Balance 2025.xlsx"]);
  });
});

describe("'we could not ask' is not 'the file said nothing'", () => {
  it("says the read failed when the engine could not be reached", async () => {
    detectPeriodForFilename.mockResolvedValue({ kind: "unavailable" });
    renderDialog();
    await waitFor(() =>
      expect(screen.getByTestId("pf-move-unavailable")).toBeTruthy(),
    );
    expect(screen.queryByTestId("pf-move-no-signal")).toBeNull();
    // and it still leaves the picker empty rather than guessing
    expect((screen.getByTestId("pf-move-month") as HTMLInputElement).value).toBe("");
  });

  it("says the file is silent only when the engine actually answered", async () => {
    detectPeriodForFilename.mockResolvedValue(ANSWERED_SILENT);
    renderDialog();
    await waitFor(() =>
      expect(screen.getByTestId("pf-move-no-signal")).toBeTruthy(),
    );
    expect(screen.queryByTestId("pf-move-unavailable")).toBeNull();
  });

  it("refuses to move until a human picks a month", async () => {
    detectPeriodForFilename.mockResolvedValue(ANSWERED_SILENT);
    renderDialog();
    await waitFor(() =>
      expect(screen.getByTestId("pf-move-no-signal")).toBeTruthy(),
    );
    expect(
      (screen.getByTestId("pf-move-confirm") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(moveDocumentToPeriod).not.toHaveBeenCalled();
  });
});

describe("a completed move", () => {
  it("sends the confirmed month and reports both ends re-analysing", async () => {
    detectPeriodForFilename.mockResolvedValue(ANSWERED_2025);
    const { onMoved, onClose } = renderDialog();
    await waitFor(() =>
      expect(
        (screen.getByTestId("pf-move-month") as HTMLInputElement).value,
      ).toBe("2025-12"),
    );
    fireEvent.click(screen.getByTestId("pf-move-confirm"));
    await waitFor(() => expect(moveDocumentToPeriod).toHaveBeenCalledTimes(1));
    // Month, not a full date: resolving a month to its last day is the
    // engine's convention and stays in one place.
    expect(moveDocumentToPeriod.mock.calls[0]).toEqual([
      "org-1",
      "doc-carniprod",
      "2025-12",
    ]);
    await waitFor(() => expect(onMoved).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(toastSuccess).toHaveBeenCalled();
    expect(String(toastSuccess.mock.calls[0][0])).toContain("Dec 2025");
  });

  it("surfaces a W4 violation instead of reporting a clean success", async () => {
    // `orphaned_after` is the engine's audit of its OWN move. It should
    // always be empty; if it is not, the user has a fact worth seeing.
    detectPeriodForFilename.mockResolvedValue(ANSWERED_2025);
    moveDocumentToPeriod.mockResolvedValue({
      ...MOVED,
      orphaned_after: [{ period_id: "p-2017-12", reason: "period_has_no_live_documents" }],
    });
    renderDialog();
    await waitFor(() =>
      expect(
        (screen.getByTestId("pf-move-month") as HTMLInputElement).value,
      ).toBe("2025-12"),
    );
    fireEvent.click(screen.getByTestId("pf-move-confirm"));
    await waitFor(() => expect(toastWarning).toHaveBeenCalledTimes(1));
  });

  it("refuses a move that would not move anything", async () => {
    detectPeriodForFilename.mockResolvedValue({
      kind: "answered",
      detection: {
        proposed_period_end: "2017-12-31",
        confidence: 0.6,
        signal_used: "filename",
        evidence_snippet: "x",
        candidates: [],
      },
    });
    renderDialog();
    await waitFor(() => expect(screen.getByTestId("pf-move-same")).toBeTruthy());
    expect(
      (screen.getByTestId("pf-move-confirm") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("keeps the failure visible and does not claim the move happened", async () => {
    detectPeriodForFilename.mockResolvedValue(ANSWERED_2025);
    moveDocumentToPeriod.mockRejectedValue(new Error("engine unreachable"));
    const { onMoved } = renderDialog();
    await waitFor(() =>
      expect(
        (screen.getByTestId("pf-move-month") as HTMLInputElement).value,
      ).toBe("2025-12"),
    );
    fireEvent.click(screen.getByTestId("pf-move-confirm"));
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(onMoved).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
