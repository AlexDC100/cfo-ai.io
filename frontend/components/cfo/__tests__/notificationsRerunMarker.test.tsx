// GATE rerun-refusal-surfaces (round 2, 2026-10-10): THE BELL'S FAILED
// NOTICE SAYS A RE-RUN'S MARKER IN THE APP'S WORDS.
//
// The bell (NotificationsMenu) lists the finished analyses the upload flow
// recorded; a failed one printed `documents.error` AS STORED under the
// company's name. A `failed` document that owns its period keeps
// `rerun_failed: <remainder>` on its row when its staged re-run then fails
// (engine gate rerun-data-loss), so the bell printed the engine's remainder
// — a RuntimeError's text, a model id. Now: one of the three sentences by
// kind (lib/rerunRefusals), in the reader's language; an error that is not
// a re-run's is still printed as recorded; a done notice prints its file.
//
// WHAT IS REAL: the bell itself (its button, its Radix dialog, the notices
// it reads from lib/uploadNotices), the i18n bundles, lib/rerunRefusals.
// Doubled: the alerts read (`fetchAlerts`, an empty list — the bell's other
// half) and the router.
//
// Fails on: the remainder on screen; the wrong sentence for a kind; a
// sentence in the wrong language; a plain error no longer shown as stored;
// the notice missing from the dialog.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/supabase")>()),
  fetchAlerts: vi.fn(async () => []),
}));

import i18n from "@/i18n";
import { NotificationsMenu } from "@/components/cfo/NotificationsMenu";
import { __resetUploadNoticesForTest, pushUploadNotice } from "@/lib/uploadNotices";

// ── The law, stated. ────────────────────────────────────────────────────
const LINE = {
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
    error: "rerun_failed: AiLaneError: model claude-opus-4-7 refused the request",
    en: "The last re-run didn't finish. You're still seeing the previous analysis.",
    ro: "Ultima reanalizare nu s-a încheiat. Vezi în continuare analiza anterioară.",
  },
} as const;
type Kind = keyof typeof LINE;
const LANGS = ["en", "ro"] as const;
const RAW = ["rerun_failed", "interrupted_replacing", "rerun_month_taken", "AiLaneError", "claude-opus"];

const ORG = "0d0c0000-0000-4000-8000-0000000000a0";
const DOC = "0d0c0000-0000-4000-8000-0000000000d1";

function notice(error: string | null, kind: "done" | "failed" = "failed") {
  pushUploadNotice({
    id: DOC,
    kind,
    companyName: "Compania SRL",
    orgId: ORG,
    periodId: null,
    filename: "balanta decembrie.xlsx",
    error,
  });
}

async function openTheBell(lang: (typeof LANGS)[number]): Promise<string> {
  await i18n.changeLanguage(lang);
  render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <NotificationsMenu />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByTestId("notifications-button"));
  await waitFor(() => expect(screen.getByTestId("notifications-analysis")).toBeTruthy());
  return screen.getByTestId("notifications-analysis-detail").textContent ?? "";
}

beforeEach(() => {
  __resetUploadNoticesForTest();
});

afterEach(async () => {
  cleanup();
  __resetUploadNoticesForTest();
  await i18n.changeLanguage("en");
});

describe("the bell prints a re-run's marker as the app's sentence", () => {
  for (const kind of Object.keys(LINE) as Kind[]) {
    for (const lang of LANGS) {
      it(`${lang}: ${kind} — the sentence, never the remainder`, async () => {
        notice(LINE[kind].error);
        const detail = await openTheBell(lang);
        expect(detail).toBe(LINE[kind][lang]);
        for (const raw of RAW) expect(detail).not.toContain(raw);
      });
    }
  }

  it("an error that is not a re-run's is still shown as recorded", async () => {
    notice("Failed to fetch dynamically imported module: /assets/uploadRefusals-MkRGsgxP.js");
    const detail = await openTheBell("en");
    expect(detail).toBe("Failed to fetch dynamically imported module: /assets/uploadRefusals-MkRGsgxP.js");
  });

  it("a done notice prints its file", async () => {
    notice(null, "done");
    const detail = await openTheBell("ro");
    expect(detail).toBe("balanta decembrie.xlsx");
  });
});
