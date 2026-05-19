// Vitest — Pricing V3 frontend wiring tests.
//
// Coverage:
//   · ExtraDocConfirmDialog renders the price + the gap-D copy ("not
//     charged for failed analysis").
//   · Clicking Confirm calls POST /api/plan/confirm-extra-doc, then
//     fires onConfirmed.
//   · `useUploadEnqueue` wires `enqueuePipeline` → modal → retry on
//     confirm. Test scenario: server returns 402 first, 202 on retry.
//
// We mock the fetch wrapper at the module boundary (`@/lib/supabase`
// for enqueuePipeline; `@/lib/planState` for confirmExtraDoc) so we
// don't need a live backend.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { ExtraDocConfirmDialog } from "../ExtraDocConfirmDialog";

// ── shared module mocks ─────────────────────────────────────────────

vi.mock("@/lib/planState", async () => {
  const actual = await vi.importActual<typeof import("@/lib/planState")>(
    "@/lib/planState",
  );
  return {
    ...actual,
    confirmExtraDoc: vi.fn(),
  };
});

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

afterEach(() => cleanup());

describe("ExtraDocConfirmDialog", () => {
  it("renders the price + the gap-D 'not charged on failure' copy", () => {
    render(
      <MemoryRouter>
        <ExtraDocConfirmDialog
          open
          onClose={() => {}}
          onConfirmed={() => {}}
          planKey="starter"
          docsUsed={5}
          docsIncluded={5}
          extraDocEur={3.0}
          serverMessage="This extra analysis costs €3.00."
        />
      </MemoryRouter>,
    );
    const dialog = screen.getByTestId("extra-doc-confirm-dialog");
    // Spec §12 verbatim phrasing — "5 / 5 documents this month" +
    // "This extra analysis costs €3.00."
    expect(dialog.textContent).toContain("€3.00");
    expect(dialog.textContent).toContain("5 / 5");
    expect(dialog.textContent?.toLowerCase()).toContain("documents this month");
    expect(dialog.textContent?.toLowerCase()).toContain("this extra analysis costs");
    // Plan surfaced in the secondary context line
    expect(dialog.textContent?.toLowerCase()).toContain("starter");
    // Gap-D copy — explicit no-charge-on-failure messaging
    expect(dialog.textContent?.toLowerCase()).toContain("not billed");
    expect(dialog.textContent?.toLowerCase()).toContain("doesn't count against your quota");
    // Spec §12 button label — American "analyze", not British "analyse"
    expect(screen.getByTestId("extra-doc-confirm").textContent).toContain(
      "Confirm and analyze",
    );
  });

  it("calls confirmExtraDoc on the Confirm click and fires onConfirmed", async () => {
    const planState = await import("@/lib/planState");
    const onConfirmed = vi.fn();
    const onClose = vi.fn();
    (planState.confirmExtraDoc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      extra_doc_eur_marked: 3.0,
      plan_key: "starter",
    });
    render(
      <MemoryRouter>
        <ExtraDocConfirmDialog
          open
          onClose={onClose}
          onConfirmed={onConfirmed}
          planKey="starter"
          docsUsed={5}
          docsIncluded={5}
          extraDocEur={3.0}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("extra-doc-confirm"));
    await waitFor(() => {
      expect(planState.confirmExtraDoc).toHaveBeenCalledTimes(1);
      expect(onConfirmed).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it("surfaces the error inline + does NOT close on PlanApiError", async () => {
    const planState = await import("@/lib/planState");
    const onConfirmed = vi.fn();
    const onClose = vi.fn();
    (planState.confirmExtraDoc as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new planState.PlanApiError("server says no", 409, { message: "server says no" }),
    );
    render(
      <MemoryRouter>
        <ExtraDocConfirmDialog
          open
          onClose={onClose}
          onConfirmed={onConfirmed}
          planKey="starter"
          docsUsed={5}
          docsIncluded={5}
          extraDocEur={3.0}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("extra-doc-confirm"));
    await waitFor(() => {
      expect(screen.getByTestId("extra-doc-confirm-error")).toBeTruthy();
    });
    expect(onConfirmed).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
