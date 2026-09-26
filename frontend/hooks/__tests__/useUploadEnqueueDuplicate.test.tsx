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

// ── The upload SURFACE survives the €-dialog (P2-C, 2026-09-26) ──────────
//
// A Products (SKU) upload that meets the 402, is confirmed, and is then
// caught as a duplicate on the retry got "open it" pointing at the
// DASHBOARD: `_resolveEnqueueOutcome` dropped the surface the first call
// was made with. It must link to the Products page, and it is never a
// failure — the retry's duplicate is the same message as the first call's.
describe("useUploadEnqueue — duplicate on a Products upload", () => {
  vi.mock("@/lib/planState", async () => {
    const actual = await vi.importActual<typeof import("@/lib/planState")>("@/lib/planState");
    return { ...actual, confirmExtraDoc: vi.fn() };
  });

  function SkuHarness({ onOutcome }: { onOutcome: (o: UploadOutcome) => void }) {
    const upload = useUploadEnqueue();
    return (
      <>
        <button data-testid="go" onClick={() => void upload.enqueue("copy-1", { surface: "sku" }).then(onOutcome)}>go</button>
        {upload.dialog}
        <Where />
      </>
    );
  }

  it("a server-caught duplicate (pre-check skipped) links a Products upload to /products", async () => {
    const sb = await import("@/lib/supabase");
    (sb.enqueuePipeline as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: "duplicate", existingDocumentId: "orig-1", periodId: null,
    });
    const outcome = vi.fn<(o: UploadOutcome) => void>();
    render(
      <MemoryRouter initialEntries={["/workspace"]}>
        <Routes><Route path="*" element={<SkuHarness onOutcome={outcome} />} /></Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("go"));
    await waitFor(() => expect(outcome).toHaveBeenCalledTimes(1));
    expect(outcome.mock.calls[0][0]).toEqual({ kind: "duplicate", existingDocumentId: "orig-1", periodId: null });
    const arg = toastSpy.mock.calls[0][0] as { title: string; variant?: string; action: ReactElement };
    expect(arg.title).toBe("Already uploaded — open it");
    expect(arg.variant).toBeUndefined();
    (arg.action.props as { onClick: () => void }).onClick();
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/products"));
  });

  it("a duplicate caught on the retry after Confirm still links to /products, and is not a failure", async () => {
    const sb = await import("@/lib/supabase");
    const planState = await import("@/lib/planState");
    (planState.confirmExtraDoc as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, extra_doc_eur_marked: 0.99, plan_key: "pro",
    });
    (sb.enqueuePipeline as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        kind: "extra_doc_required", planKey: "pro", docsUsed: 15, docsIncluded: 15,
        extraDocEur: 0.99, message: "This will be an extra document — confirm to proceed.",
      })
      .mockResolvedValueOnce({ kind: "duplicate", existingDocumentId: "orig-1", periodId: null });
    const outcome = vi.fn<(o: UploadOutcome) => void>();
    render(
      <MemoryRouter initialEntries={["/workspace"]}>
        <Routes><Route path="*" element={<SkuHarness onOutcome={outcome} />} /></Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("go"));
    fireEvent.click(await screen.findByTestId("extra-doc-confirm"));
    await waitFor(() => expect(outcome).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(outcome.mock.calls[0][0]).toEqual({ kind: "duplicate", existingDocumentId: "orig-1", periodId: null });
    expect(sb.enqueuePipeline).toHaveBeenCalledTimes(2);
    const dup = toastSpy.mock.calls
      .map((c) => c[0] as { title: string; variant?: string; action?: ReactElement })
      .find((a) => a.title === "Already uploaded — open it");
    expect(dup).toBeTruthy();
    expect(dup!.variant).toBeUndefined();
    expect(toastSpy.mock.calls.some((c) => (c[0] as { variant?: string }).variant === "destructive")).toBe(false);
    (dup!.action!.props as { onClick: () => void }).onClick();
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/products"));
  });
});
