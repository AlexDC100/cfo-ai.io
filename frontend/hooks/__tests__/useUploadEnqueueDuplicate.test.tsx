// useUploadEnqueue — a server-side duplicate is "Already uploaded — open it",
// never a failure and never the extra-document dialog.
//
// When /api/pipeline/run archives a document as a duplicate of a live copy
// (same file, account, company, period) it answers 202 {status: "duplicate"}.
// The hook must resolve that as its own outcome, show the owner's message
// with a way to open the existing analysis, and never open the €-dialog.
//
// WHAT THESE RED ON: the duplicate resolving as queued / transport_failed;
// the message missing or worded otherwise; the extra-document dialog
// opening; "open it" leading anywhere but the existing period.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { isValidElement, type ReactElement } from "react";

import { useUploadEnqueue, type UploadOutcome } from "../useUploadEnqueue";

const toastSpy = vi.fn();

vi.mock("@/lib/supabase", () => ({
  enqueuePipeline: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}

function Harness({ onOutcome }: { onOutcome: (o: UploadOutcome) => void }) {
  const upload = useUploadEnqueue();
  return (
    <>
      <button data-testid="go" onClick={() => void upload.enqueue("copy-1").then(onOutcome)}>go</button>
      {upload.dialog}
      <Where />
    </>
  );
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe("useUploadEnqueue — duplicate", () => {
  it("resolves 'duplicate', shows the owner's message and opens the existing period", async () => {
    const sb = await import("@/lib/supabase");
    (sb.enqueuePipeline as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: "duplicate", existingDocumentId: "orig-1", periodId: "period-1",
    });
    const outcome = vi.fn<(o: UploadOutcome) => void>();
    render(
      <MemoryRouter initialEntries={["/workspace"]}>
        <Routes>
          <Route path="*" element={<Harness onOutcome={outcome} />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("go"));
    await waitFor(() => expect(outcome).toHaveBeenCalledTimes(1));
    expect(outcome.mock.calls[0][0]).toEqual({ kind: "duplicate", existingDocumentId: "orig-1", periodId: "period-1" });
    expect(screen.queryByTestId("extra-doc-confirm")).toBeNull();

    expect(toastSpy).toHaveBeenCalledTimes(1);
    const arg = toastSpy.mock.calls[0][0] as { title: string; variant?: string; action: ReactElement };
    expect(arg.title).toBe("Already uploaded — open it");
    expect(arg.variant).toBeUndefined(); // not a destructive / failure toast
    expect(isValidElement(arg.action)).toBe(true);
    // "open it" → the existing analysed period
    const onClick = (arg.action.props as { onClick: () => void }).onClick;
    onClick();
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/dashboard?period=period-1"));
  });
});
