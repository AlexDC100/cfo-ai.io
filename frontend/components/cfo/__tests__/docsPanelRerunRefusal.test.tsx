// GATE rerun-refusal-surfaces (the panel half): THE DOCS PANEL SAYS WHY A
// RE-RUN WAS REFUSED — the sentence for the refusal's code, in the reader's
// language, under the title it always showed.
//
// The engine refuses "Re-run analysis" on a file whose month now belongs to
// another upload (engine gate rerun-data-loss; before 2026-10-04 it deleted
// the newer upload's month instead). It answers a code and nothing else.
// The panel used to discard the body of every failed retry.
//
// WHAT IS REAL: the panel itself (`DocsPanel`, its document row, its Radix
// menu), the client function that makes the call (`retryPipelineDetailed` in
// lib/supabase — NOT mocked), lib/rerunRefusals, the i18n bundles. The ONE
// channel a request leaves by (`fetch`) answers with the body COMMITTED at
// tests/engine/fixtures/rerun/retry_refused_superseded.json — the body the
// engine law O1 asserts the real route returns (an intercepted route is a
// route with no gate: the two laws read the same file).
//
// The expected strings are stated here, not read from the module or the
// locale files.
//
// Fails on: the body of a refused retry discarded again (title alone); the
// bare code, the key or the server's `message` on screen; a sentence in the
// wrong language; a refusal shown for an answer that carries no known code;
// a second request, or one that does not name the document; a successful
// re-run shown as a failure.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toastSpy = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

import i18n from "@/i18n";
import { DocsPanel } from "@/components/cfo/DocsPanel";
import { getSupabase, retryPipelineDetailed } from "@/lib/supabase";

const FIXTURE = resolve(__dirname, "../../../../tests/engine/fixtures/rerun/retry_refused_superseded.json");
const SUPERSEDED_ANSWER: unknown = JSON.parse(readFileSync(FIXTURE, "utf8"));

const DOC = "0d0c0000-0000-4000-8000-0000000000d1";
const PERIOD = "0d0c0000-0000-4000-8000-0000000000b1";

// ── The law, stated. ────────────────────────────────────────────────────
const TITLE = { en: "Couldn't start re-run", ro: "Nu am putut porni reanalizarea" } as const;
const MENU_ITEM = { en: "Re-run analysis", ro: "Reia analiza" } as const;
const STARTED = { en: "Re-running analysis", ro: "Se reia analiza" } as const;
const SENTENCE = {
  document_superseded: {
    en: "Another upload has replaced this file for its month, so it was not re-analysed and the month was not changed. To use this file for the month again, upload it again.",
    ro: "O altă încărcare a înlocuit acest fișier pentru luna lui, așa că nu a fost reanalizat, iar luna nu s-a schimbat. Ca să folosești din nou acest fișier pentru lună, încarcă-l din nou.",
  },
  rerun_period_not_own: {
    en: "This file isn't linked to an analysis of its own, so it was not re-analysed and nothing was changed. To analyse it, upload the file again.",
    ro: "Fișierul nu este legat de o analiză proprie, așa că nu a fost reanalizat și nu s-a schimbat nimic. Ca să îl analizezi, încarcă fișierul din nou.",
  },
  rerun_unavailable: {
    en: "We couldn't read this file's analysis just now, so the re-run didn't start. Nothing was changed — try again in a moment.",
    ro: "Nu am putut citi acum analiza acestui fișier, așa că reanalizarea nu a pornit. Nu s-a schimbat nimic — încearcă din nou peste puțin timp.",
  },
} as const;
type Code = keyof typeof SENTENCE;
const LANGS = ["en", "ro"] as const;

const PANEL = {
  active_period_id: PERIOD,
  periods: [
    {
      period_id: PERIOD,
      period_label: "2025-12",
      period_start: "2025-12-31",
      period_end: "2025-12-31",
      is_active: true,
      currency: "RON",
      extraction_confidence: 0.9,
      documents: [
        {
          id: DOC,
          display_name: "balanta decembrie.xlsx",
          original_filename: "balanta decembrie.xlsx",
          storage_path: "org/uploads/balanta.xlsx",
          mime_type: null,
          detected_type: "trial_balance",
          size_bytes: 1024,
          uploaded_at: "2026-10-01T10:00:00+00:00",
          status: "analyzed",
          is_active: true,
          confidence: 0.9,
          error: "superseded_by:0d0c0000-0000-4000-8000-0000000000d2",
        },
      ],
    },
  ],
  recently_deleted: [],
};

// ── the one channel a request can leave by ──────────────────────────────
type Answer = { status: number; body: unknown; notJson?: boolean };
let retryAnswer: Answer = { status: 202, body: { document_id: DOC, status: "queued" } };
const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
  const answer: Answer = String(url).includes("/api/pipeline/retry")
    ? retryAnswer
    : { status: 200, body: PANEL };
  return {
    ok: answer.status >= 200 && answer.status < 300,
    status: answer.status,
    json: async () => {
      if (answer.notJson) throw new SyntaxError("Unexpected token < in JSON");
      return answer.body;
    },
  };
});
const retryCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/pipeline/retry"));

beforeEach(() => {
  toastSpy.mockClear();
  fetchMock.mockClear();
  retryAnswer = { status: 202, body: { document_id: DOC, status: "queued" } };
  vi.stubGlobal("fetch", fetchMock);
  // A signed-in reader — on the REAL client lib/supabase built, so the real
  // `retryPipelineDetailed` and the panel's own list request both carry it.
  vi.spyOn(getSupabase()!.auth, "getSession").mockResolvedValue({
    data: { session: { access_token: "jwt-of-the-reader" } },
    error: null,
  } as never);
  localStorage.setItem("cfoai.docs_panel.open", "1");
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  await i18n.changeLanguage("en");
});

/** The panel, open, with one analysed document; then "Re-run analysis" from
 *  the document's own menu (Radix opens on the keyboard path a user has). */
async function rerunFromThePanel(lang: (typeof LANGS)[number]) {
  await i18n.changeLanguage(lang);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/dashboard"]}>
        <DocsPanel />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByTestId("doc-row");
  fireEvent.keyDown(screen.getByTestId("doc-menu"), { key: "Enter" });
  fireEvent.click(await screen.findByText(MENU_ITEM[lang]));
  await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1));
  return toastSpy.mock.calls[0][0] as { title: string; description?: string; variant?: string };
}

describe("F2 — the client reads the refusal's code from the answer", () => {
  it("the committed answer of the real route → refusal: document_superseded", async () => {
    retryAnswer = { status: 409, body: SUPERSEDED_ANSWER };
    expect(await retryPipelineDetailed(DOC)).toEqual({ ok: false, duplicate: null, refusal: "document_superseded" });
  });

  it("a failure that carries no known code → refusal: null", async () => {
    for (const answer of [
      { status: 500, body: { detail: "Internal Server Error" } },
      { status: 502, body: null, notJson: true },
      { status: 409, body: { detail: { code: "document_deleted", message: "This document was deleted." } } },
      { status: 409, body: { detail: { code: "a_code_of_tomorrow" } } },
    ] as Answer[]) {
      retryAnswer = answer;
      expect(await retryPipelineDetailed(DOC)).toEqual({ ok: false, duplicate: null, refusal: null });
    }
  });

  it("an accepted re-run carries no refusal", async () => {
    expect(await retryPipelineDetailed(DOC)).toEqual({ ok: true, duplicate: null, refusal: null });
  });
});

describe("F2 — the Docs panel prints the title and the refusal's sentence", () => {
  for (const lang of LANGS) {
    it(`${lang}: the real route's answer for a superseded file`, async () => {
      retryAnswer = { status: 409, body: SUPERSEDED_ANSWER };
      const toast = await rerunFromThePanel(lang);
      expect(toast.title).toBe(TITLE[lang]);
      expect(toast.description).toBe(SENTENCE.document_superseded[lang]);
      expect(toast.variant).toBe("destructive");
      // ONE request, naming the document, with the reader's bearer
      expect(retryCalls()).toHaveLength(1);
      const [, init] = retryCalls()[0];
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ document_id: DOC });
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer jwt-of-the-reader");
    });

    for (const [code, status] of [["rerun_period_not_own", 409], ["rerun_unavailable", 503]] as [Code, number][]) {
      it(`${lang}: ${status} ${code}`, async () => {
        retryAnswer = { status, body: { detail: { code } } };
        const toast = await rerunFromThePanel(lang);
        expect(toast.title).toBe(TITLE[lang]);
        expect(toast.description).toBe(SENTENCE[code][lang]);
        expect(toast.variant).toBe("destructive");
      });
    }

    it(`${lang}: a failure with no known code shows the title alone`, async () => {
      retryAnswer = { status: 503, body: { detail: "Service Unavailable" } };
      const toast = await rerunFromThePanel(lang);
      expect(toast.title).toBe(TITLE[lang]);
      expect(toast.description).toBeUndefined();
      expect(toast.variant).toBe("destructive");
    });
  }

  it("never the bare code, the key or another language's sentence", async () => {
    retryAnswer = { status: 409, body: SUPERSEDED_ANSWER };
    const toast = await rerunFromThePanel("ro");
    const shown = JSON.stringify(toast);
    expect(shown).not.toContain("document_superseded");
    expect(shown).not.toContain("panels.rerun");
    expect(shown).not.toContain(SENTENCE.document_superseded.en);
  });
});

describe("F3 — the server's words are never printed", () => {
  const SERVER_WORDS = "period 0d0c0000-0000-4000-8000-0000000000b1 belongs to document 0d0c0000-…-d2";

  it("a refusal that also carries a message prints the code's sentence only", async () => {
    retryAnswer = {
      status: 409,
      body: { detail: { code: "document_superseded", message: SERVER_WORDS, period_id: PERIOD } },
    };
    const toast = await rerunFromThePanel("en");
    expect(toast.description).toBe(SENTENCE.document_superseded.en);
    expect(JSON.stringify(toast)).not.toContain("belongs to document");
    expect(JSON.stringify(toast)).not.toContain(PERIOD);
  });

  it("an answer whose code is not a re-run refusal prints no message either", async () => {
    retryAnswer = {
      status: 409,
      body: { detail: { code: "document_deleted", message: "This document was deleted. Restore it before re-running it." } },
    };
    const toast = await rerunFromThePanel("en");
    expect(toast).toEqual({ title: TITLE.en, description: undefined, variant: "destructive" });
  });
});

describe("control — an accepted re-run is not shown as a failure", () => {
  for (const lang of LANGS) {
    it(`${lang}: 202 queued says the analysis is re-running`, async () => {
      const toast = await rerunFromThePanel(lang);
      expect(toast.title).toBe(STARTED[lang]);
      expect(toast.variant).toBeUndefined();
      expect(toast.description).toBe("balanta decembrie.xlsx");
    });
  }
});
