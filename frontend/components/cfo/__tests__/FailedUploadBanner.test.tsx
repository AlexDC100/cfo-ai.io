// GATE (owner ruling 2026-09-20): a failed analysis must never block the user
// from acting. Plant a failed upload → Retry · Replace file · Manage files ·
// View error are ALL present, and each one does something.
//
// Fails on: any of the four actions missing or inert; the error detail not
// shown; the Manage files link not scoped to the period. After the defect is
// repaired it keeps failing on any future failed-state surface that drops an
// action (TC-11).
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import i18n from "@/i18n";
import { FailedUploadBanner } from "@/components/cfo/FailedUploadBanner";
import { documentRefusalKey } from "@/lib/uploadRefusals";
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

// GATE rerun-refusal-surfaces (round 2, 2026-10-10): a FAILED document that
// owns its period keeps `rerun_failed: <remainder>` on its row when its
// staged re-run then fails; "View error" printed the row's error AS STORED —
// the engine's remainder (a RuntimeError's text, a model id) on screen. The
// app's own sentence for the marker's kind is printed instead, with the
// plan refusal's sentence after it when the remainder carries that code;
// an error that is not a re-run's is still shown as recorded.
//
// Fails on: the remainder on screen for a marker; the wrong sentence for a
// kind; the plan sentence missing; a plain error no longer shown as stored.
const MARKER = {
  interrupted: {
    error: "rerun_failed: interrupted_replacing",
    en: "The last re-run was interrupted while it was replacing the analysis. Run it again.",
    ro: "Ultima reanalizare a fost întreruptă în timp ce înlocuia analiza. Reia analiza.",
  },
  month_taken: {
    error: "rerun_failed: rerun_month_taken",
    en: "The last re-run was not applied: the file now reads as a month that already has its own analysis. Nothing was changed.",
    ro: "Ultima reanalizare nu a fost aplicată: fișierul indică acum o lună care are deja propria analiză. Nu s-a schimbat nimic.",
  },
  kept: {
    error: "rerun_failed: RuntimeError: Your credit balance is too low to access the Anthropic API.",
    en: "The last re-run didn't finish. You're still seeing the previous analysis.",
    ro: "Ultima reanalizare nu s-a încheiat. Vezi în continuare analiza anterioară.",
  },
} as const;

describe("failed upload — a re-run's marker is said in the app's words", () => {
  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  for (const kind of Object.keys(MARKER) as (keyof typeof MARKER)[]) {
    for (const lang of ["en", "ro"] as const) {
      it(`${lang}: ${kind} — the sentence, never the remainder`, async () => {
        await i18n.changeLanguage(lang);
        mount({ upload: { ...PLANTED, error: MARKER[kind].error } });
        fireEvent.click(screen.getByTestId("failed-upload-view-error"));
        const text = screen.getByTestId("failed-upload-error-text");
        expect(text.textContent).toBe(MARKER[kind][lang]);
        expect(text.getAttribute("data-kind")).toBe("rerun");
        for (const raw of ["rerun_failed", "interrupted_replacing", "rerun_month_taken", "RuntimeError", "Anthropic"]) {
          expect(text.textContent).not.toContain(raw);
        }
      });
    }
  }

  it("a remainder carrying a plan refusal's code adds that code's sentence", () => {
    mount({ upload: { ...PLANTED, error: 'rerun_failed: {"error": "non_ro_not_included"}' } });
    fireEvent.click(screen.getByTestId("failed-upload-view-error"));
    const text = screen.getByTestId("failed-upload-error-text").textContent ?? "";
    expect(text.startsWith(MARKER.kept.en)).toBe(true);
    expect(text.length).toBeGreaterThan(MARKER.kept.en.length);
    expect(text).toBe(`${MARKER.kept.en} ${i18n.t(documentRefusalKey("non_ro_not_included") as string)}`);
    expect(text).not.toContain("non_ro_not_included");
  });

  it("an error that is not a re-run's is still shown as recorded", () => {
    mount();
    fireEvent.click(screen.getByTestId("failed-upload-view-error"));
    const text = screen.getByTestId("failed-upload-error-text");
    expect(text.textContent).toBe(PLANTED.error);
    expect(text.getAttribute("data-kind")).toBe("stored");
  });
});
