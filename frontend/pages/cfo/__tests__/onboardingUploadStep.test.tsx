// The workspace onboarding wizard's upload step — the one path every new
// user takes, and the one nothing gated until 2026-09-09.
//
// IT HAS BROKEN TWICE:
//   · 2026-08-04 it posted a balanță to /api/upload-excel, the legacy SKU
//     parser, which died on "missing Categ_Pr / Volume(to) / NIV (kRon)".
//   · 2026-09-05 that endpoint was walled behind LEGACY_SKU_AI_ENABLED, and
//     the wall answers 404 BEFORE routing — so the [TRIAL_BALANCE] reroute
//     added in August became unreachable by construction and every new
//     workspace ended on a bare "Upload failed 404".
// Separately the dropzone hard-coded `.xlsx,.csv`, so a Crystal Reports
// balanță (.xls — real, parseable, saga_10_col via xlrd) could not even be
// SELECTED.
//
// WHY HERE AND NOT IN PLAYWRIGHT. The e2e route needs an authenticated
// workspace, which needs PUBLIC_TEST_MODE on the engine. The battery does
// not run with it (measured: /workspace answers "Could not load your
// workspace" on the local stack), so an e2e spec would be a permanent
// skip — and a skip is not coverage. e2e/onboarding-upload.spec.ts exists
// for a session-bearing run and says so; THIS file is what gates.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { StepUpload } from "@/pages/cfo/Workspace";
import { FINANCIAL_UPLOAD_ACCEPT } from "@/lib/uploadAccept";

function fileOf(name: string) {
  return new File([new Uint8Array([1, 2, 3])], name, {
    type: "application/vnd.ms-excel",
  });
}

function renderStep() {
  const onUpload = vi.fn();
  const { container } = render(<StepUpload busy={false} onUpload={onUpload} />);
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  return { onUpload, input, container };
}

describe("onboarding wizard — upload step", () => {
  it("accepts .xls, not only .xlsx", () => {
    const { input } = renderStep();
    expect(input).not.toBeNull();
    const accept = input.getAttribute("accept") ?? "";
    // The exact 2026-09-09 failure: the real FY2025 client book is .xls and
    // could not be chosen.
    expect(accept).toContain(".xls");
    expect(accept).toContain(".csv");
    expect(accept).toContain(".pdf");
  });

  it("uses the SHARED accept list, not a second hand-written copy", () => {
    // FinancialStatements' copy carried a comment saying it was shared "so
    // the two can't drift" — and a third consumer had already drifted.
    const { input } = renderStep();
    expect(input.getAttribute("accept")).toBe(FINANCIAL_UPLOAD_ACCEPT);
  });

  it("hands a real .xls trial balance to the caller", () => {
    const { onUpload, input } = renderStep();
    fireEvent.change(input, { target: { files: [fileOf("Balanta_dec_2025.xls")] } });
    expect(
      onUpload,
      "an .xls balanță was refused by the client-side allowlist",
    ).toHaveBeenCalledTimes(1);
    expect((onUpload.mock.calls[0][0] as File).name).toBe("Balanta_dec_2025.xls");
  });

  it.each(["balanta.xlsx", "balanta.csv", "balanta.pdf"])(
    "hands %s to the caller too",
    (name) => {
      const { onUpload, input } = renderStep();
      fireEvent.change(input, { target: { files: [fileOf(name)] } });
      expect(onUpload).toHaveBeenCalledTimes(1);
    },
  );

  it("still refuses a genuinely unsupported file", () => {
    // POSITIVE CONTROL. Without this, the tests above would pass if the
    // allowlist had simply been deleted — and "accepts everything" is not
    // the fix, it is a different bug.
    const { onUpload, input } = renderStep();
    fireEvent.change(input, { target: { files: [fileOf("notes.txt")] } });
    expect(onUpload).not.toHaveBeenCalled();
  });

  it("does not describe the legacy SKU workbook", () => {
    renderStep();
    const body = document.body.textContent ?? "";
    expect(body).not.toContain("SKU sales, margin, and inventory");
    expect(body.toLowerCase()).not.toContain("classifies every product");
  });
});
