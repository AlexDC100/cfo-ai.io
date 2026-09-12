// useUploadEnqueue — the confirm/close race on the extra-document dialog.
//
// MEASURED IN PRODUCTION, 2026-09-12 05:50 UTC, mobile Safari, workspace
// "Q&A · Dec 2025":
//
//     05:50:17  POST /api/pipeline/run          402   (extra doc required)
//     05:50:20  POST /api/plan/confirm-extra-doc 200  (user tapped Confirm)
//     05:50:21  POST /api/pipeline/run          202   (retry queued)
//     05:50:29  document fc046ae8 status=analyzed, error=null
//
// and on screen: "STEP 1 OF 5 — Detect format — Analysis failed".
//
// The dialog fired onConfirmed() and then onClose() in the same tick.
// handleConfirmed awaited the retry enqueue; handleClose ran next, read
// the STALE render-closure `pending` (setPending(null) does not update a
// closure) and resolved the upload promise FIRST — as extra_doc_cancelled.
// The caller mapped that to status "failed" and never subscribed to the
// document, so the 202 → analyzed that followed was invisible. Every
// paid extra document since the dialog shipped (a385343, 2026-08-27)
// took this path.
//
// WHAT THESE RED ON, with the hook repaired (TC-11):
//   · ownership of the pending promise moving back into render state
//   · the dialog calling onClose() after onConfirmed() again
//   · a close that arrives after confirm being allowed to settle the promise
//   · (positive control) a real dismissal no longer resolving as cancelled
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { useUploadEnqueue, type UploadOutcome } from "../useUploadEnqueue";

vi.mock("@/lib/supabase", () => ({
  enqueuePipeline: vi.fn(),
}));

vi.mock("@/lib/planState", async () => {
  const actual = await vi.importActual<typeof import("@/lib/planState")>("@/lib/planState");
  return { ...actual, confirmExtraDoc: vi.fn() };
});

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

const EXTRA_REQUIRED = {
  kind: "extra_doc_required" as const,
  planKey: "starter",
  docsUsed: 5,
  docsIncluded: 5,
  extraDocEur: 3.0,
  message: "This will be an extra document — confirm to proceed.",
};

function Harness({ onOutcome }: { onOutcome: (o: UploadOutcome) => void }) {
  const upload = useUploadEnqueue();
  return (
    <>
      <button
        data-testid="go"
        onClick={() => {
          void upload.enqueue("doc-1").then(onOutcome);
        }}
      >
        go
      </button>
      {upload.dialog}
    </>
  );
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe("useUploadEnqueue — confirm must win over the dialog's trailing close", () => {
  it("402 → Confirm → slow retry 202 resolves QUEUED, never cancelled", async () => {
    const sb = await import("@/lib/supabase");
    const planState = await import("@/lib/planState");
    (planState.confirmExtraDoc as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, extra_doc_eur_marked: 3.0, plan_key: "starter",
    });
    // The retry is SLOW on purpose: the race window is "confirm handler is
    // awaiting the network while the dialog's close event lands".
    (sb.enqueuePipeline as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(EXTRA_REQUIRED)
      .mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve({ kind: "queued" }), 60)),
      );

    const outcome = vi.fn<(o: UploadOutcome) => void>();
    render(
      <MemoryRouter>
        <Harness onOutcome={outcome} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("go"));
    const confirm = await screen.findByTestId("extra-doc-confirm");
    fireEvent.click(confirm);

    await waitFor(() => expect(outcome).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(outcome.mock.calls[0][0]).toEqual({ kind: "queued" });
    expect(sb.enqueuePipeline).toHaveBeenCalledTimes(2);
    // The dialog is gone once the owner cleared its pending state.
    expect(screen.queryByTestId("extra-doc-confirm")).toBeNull();
  });

  it("a close arriving AFTER confirm cannot settle the promise a second time", async () => {
    const sb = await import("@/lib/supabase");
    const planState = await import("@/lib/planState");
    (planState.confirmExtraDoc as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, extra_doc_eur_marked: 3.0, plan_key: "starter",
    });
    let releaseRetry: (v: unknown) => void = () => {};
    (sb.enqueuePipeline as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(EXTRA_REQUIRED)
      .mockImplementationOnce(() => new Promise((resolve) => { releaseRetry = resolve; }));

    const outcome = vi.fn<(o: UploadOutcome) => void>();
    render(
      <MemoryRouter>
        <Harness onOutcome={outcome} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("go"));
    fireEvent.click(await screen.findByTestId("extra-doc-confirm"));
    // While the retry is in flight, hammer the dismiss path (Escape closes a
    // Radix dialog → onOpenChange(false) → onClose). In the defect this was
    // exactly the event that resolved the upload as cancelled.
    await waitFor(() => expect(planState.confirmExtraDoc).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(outcome).not.toHaveBeenCalled();

    releaseRetry({ kind: "queued" });
    await waitFor(() => expect(outcome).toHaveBeenCalledTimes(1));
    expect(outcome.mock.calls[0][0]).toEqual({ kind: "queued" });
  });

  it("POSITIVE CONTROL — a real dismissal still resolves extra_doc_cancelled", async () => {
    const sb = await import("@/lib/supabase");
    (sb.enqueuePipeline as ReturnType<typeof vi.fn>).mockResolvedValueOnce(EXTRA_REQUIRED);

    const outcome = vi.fn<(o: UploadOutcome) => void>();
    render(
      <MemoryRouter>
        <Harness onOutcome={outcome} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("go"));
    await screen.findByTestId("extra-doc-confirm");
    fireEvent.keyDown(document.body, { key: "Escape" });

    await waitFor(() => expect(outcome).toHaveBeenCalledTimes(1));
    expect(outcome.mock.calls[0][0]).toEqual({ kind: "extra_doc_cancelled" });
    expect(sb.enqueuePipeline).toHaveBeenCalledTimes(1);
  });
});
