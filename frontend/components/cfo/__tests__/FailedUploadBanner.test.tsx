// GATE (owner ruling 2026-09-20): a failed analysis must never block the user
// from acting. Plant a failed upload → Retry · Replace file · Manage files ·
// View error are ALL present, and each one does something.
//
// Fails on: any of the four actions missing or inert; the error detail not
// shown; the Manage files link not scoped to the period. After the defect is
// repaired it keeps failing on any future failed-state surface that drops an
// action (TC-11).
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { FailedUploadBanner } from "@/components/cfo/FailedUploadBanner";
import type { UploadDoc } from "@/lib/uploadStore";

const PLANTED: UploadDoc = {
  docId: "38cf75b1-8265-4209-aaad-aa881cbdecad",
  filename: "Carniprod Trial Balance_FY2025.xlsx",
  status: "failed",
  surface: "dashboard",
  startedAt: Date.UTC(2026, 8, 20, 11, 51, 48),
  updatedAt: Date.UTC(2026, 8, 20, 11, 51, 49),
  error: "Failed to fetch dynamically imported module: https://cfo-ai.io/assets/uploadRefusals-MkRGsgxP.js",
  periodId: null,
};

function mount(over: Partial<Parameters<typeof FailedUploadBanner>[0]> = {}) {
  const props = {
    upload: PLANTED,
    periodId: "67206359-f064-4aca-8846-0ecd6e619295",
    onRetry: vi.fn(),
    onReplace: vi.fn(),
    onDismiss: vi.fn(),
    ...over,
  };
  render(<MemoryRouter><FailedUploadBanner {...props} /></MemoryRouter>);
  return props;
}

describe("failed upload — never a dead end", () => {
  it("offers all four actions plus dismiss", () => {
    mount();
    for (const id of ["failed-upload-retry", "failed-upload-replace", "failed-upload-manage", "failed-upload-view-error", "failed-upload-dismiss"]) {
      expect(screen.getByTestId(id), id).toBeTruthy();
    }
  });

  it("every action acts", () => {
    const p = mount();
    fireEvent.click(screen.getByTestId("failed-upload-retry"));
    fireEvent.click(screen.getByTestId("failed-upload-replace"));
    fireEvent.click(screen.getByTestId("failed-upload-dismiss"));
    expect(p.onRetry).toHaveBeenCalledTimes(1);
    expect(p.onReplace).toHaveBeenCalledTimes(1);
    expect(p.onDismiss).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("failed-upload-manage").getAttribute("href"))
      .toBe("/workspace?period=67206359-f064-4aca-8846-0ecd6e619295");
  });

  it("View error shows the recorded error, the file and the document id", () => {
    mount();
    expect(screen.queryByTestId("failed-upload-error")).toBeNull();
    fireEvent.click(screen.getByTestId("failed-upload-view-error"));
    const detail = screen.getByTestId("failed-upload-error").textContent ?? "";
    expect(detail).toContain("uploadRefusals-MkRGsgxP.js");
    expect(detail).toContain(PLANTED.filename);
    expect(detail).toContain(PLANTED.docId);
  });

  it("an upload that never reached the server still offers every action", () => {
    mount({ upload: { ...PLANTED, docId: "", error: null }, periodId: null });
    expect(screen.getByTestId("failed-upload-retry")).toBeTruthy();
    expect(screen.getByTestId("failed-upload-manage").getAttribute("href")).toBe("/workspace");
    fireEvent.click(screen.getByTestId("failed-upload-view-error"));
    expect(screen.getByTestId("failed-upload-error").textContent).toMatch(/No error detail/);
  });
});
