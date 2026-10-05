// GATE rerun-refusal-surfaces (the Workspace half): "MAKE SOURCE" REFUSED
// OVER ANOTHER FILE'S ANALYSIS SAYS SO IN THE READER'S LANGUAGE.
//
// The engine's make-active wiped the month's statements, metrics and
// briefing BEFORE the promoted file's own re-run had produced anything —
// on a month that holds another analysed file's analysis that destroyed it
// (engine gate rerun-data-loss; review 2026-10-05). It now refuses there,
// before its first write, with a code and an English sentence. This screen
// printed whatever sentence the server sent.
//
// WHAT IS REAL: the file row itself (`PeriodFileRow`, its Radix menu), the
// client function that makes the call (`makeDocumentSource` in
// ../periodFiling — NOT mocked), the i18n bundle. The ONE channel a request
// leaves by (`fetch`) answers with the body COMMITTED at
// tests/engine/fixtures/rerun/make_active_refused_another_analysis.json —
// the body the engine law holds the real route to (an intercepted route is
// a route with no gate: the two laws read the same file).
//
// The expected strings are stated here, not read from the module or the
// strings file.
//
// Fails on: the server's English shown for the known code; the bare code or
// the key on screen; the sentence in the wrong language; our sentence shown
// for a refusal that carries another code (the server's message is shown
// then, as before); a second request, or one that does not name the file;
// `onChanged` fired for a refusal (nothing changed).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  message: vi.fn(),
}));

vi.mock("@/components/ui/sonner", () => ({ toast }));

import i18n from "@/i18n";
import { getSupabase } from "@/lib/supabase";
import { PeriodFileRow } from "../PeriodFileRow";
import {
  FilingRefused,
  MONTH_HAS_ANOTHER_ANALYSIS,
  makeDocumentSource,
  makeSourceRefusalKey,
} from "../periodFiling";

const FIXTURE = resolve(
  __dirname,
  "../../../../../tests/engine/fixtures/rerun/make_active_refused_another_analysis.json",
);
const REFUSED_ANSWER = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
  detail: { code: string; message: string };
};

const ORG = "0d0c0000-0000-4000-8000-0000000000a0";
const DOC = "0d0c0000-0000-4000-8000-0000000000d1";

// ── The law, stated. ────────────────────────────────────────────────────
const CODE = "month_has_another_analysis";
const TITLE = { en: "Couldn't change the source file", ro: "Nu am putut schimba fișierul-sursă" } as const;
const SENTENCE = {
  en: "This month already has an analysis from another file, so this file was not made its source and nothing was changed. To use this file for the month, upload it again.",
  ro: "Luna are deja o analiză făcută din alt fișier, așa că acest fișier nu a devenit sursa ei și nu s-a schimbat nimic. Ca să folosești acest fișier pentru lună, încarcă-l din nou.",
} as const;
const LANGS = ["en", "ro"] as const;

type Answer = { status: number; body: unknown };
let answer: Answer = { status: 409, body: REFUSED_ANSWER };
const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
  ok: answer.status >= 200 && answer.status < 300,
  status: answer.status,
  json: async () => answer.body,
}));

beforeEach(() => {
  Object.values(toast).forEach((spy) => spy.mockClear());
  fetchMock.mockClear();
  answer = { status: 400, body: REFUSED_ANSWER };
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(getSupabase()!.auth, "getSession").mockResolvedValue({
    data: { session: { access_token: "jwt-of-the-reader" } },
    error: null,
  } as never);
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await i18n.changeLanguage("en");
});

/** An ATTACHMENT's row; "Make source" from its own menu (Radix opens on the
 *  keyboard path a user has). Returns what the row was told and the toast. */
async function makeSourceFromTheRow(lang: (typeof LANGS)[number]) {
  await i18n.changeLanguage(lang);
  const onChanged = vi.fn();
  render(
    <PeriodFileRow
      orgId={ORG}
      file={{
        id: DOC,
        filename: "balanta decembrie (veche).xlsx",
        status: "analyzed",
        uploaded_at: "2026-10-01T10:00:00Z",
      }}
      isSource={false}
      showRole
      detection={null}
      onMove={() => {}}
      onChanged={onChanged}
    />,
  );
  fireEvent.keyDown(screen.getByTestId(`pf-file-menu-${DOC}`), { key: "Enter" });
  fireEvent.click(await screen.findByTestId(`pf-file-makesource-${DOC}`));
  await waitFor(() =>
    expect(toast.error.mock.calls.length + toast.success.mock.calls.length).toBeGreaterThan(0),
  );
  return { onChanged };
}

describe("the fixture is the answer stated here", () => {
  it("carries the code this screen knows, and the engine's own literal is the same", () => {
    expect(REFUSED_ANSWER.detail.code).toBe(CODE);
    expect(MONTH_HAS_ANOTHER_ANALYSIS).toBe(CODE);
    expect(makeSourceRefusalKey(CODE)).toBe("pf.sourceHasAnalysis");
    expect(makeSourceRefusalKey("period_missing")).toBeNull();
    expect(makeSourceRefusalKey(null)).toBeNull();
  });
});

describe("the client carries the refusal's code out of the answer", () => {
  it("the committed answer of the real route → FilingRefused with the code", async () => {
    const refused = await makeDocumentSource(ORG, DOC).then(
      () => null,
      (err: unknown) => err,
    );
    expect(refused).toBeInstanceOf(FilingRefused);
    expect((refused as FilingRefused).code).toBe(CODE);
    // ONE request, naming the file, with the reader's bearer and company
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(new RegExp(`/api/documents/${DOC}/make-active$`));
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer jwt-of-the-reader");
    expect(headers["X-Org-Id"]).toBe(ORG);
  });

  it("a refusal with no code carries none", async () => {
    answer = { status: 500, body: { detail: "Internal Server Error" } };
    const refused = (await makeDocumentSource(ORG, DOC).catch((err: unknown) => err)) as FilingRefused;
    expect(refused).toBeInstanceOf(FilingRefused);
    expect(refused.code).toBeNull();
    expect(refused.message).toBe("Internal Server Error");
  });
});

describe("the row prints the title and OUR sentence for the refusal", () => {
  for (const lang of LANGS) {
    it(`${lang}: the real route's answer over another file's analysis`, async () => {
      const { onChanged } = await makeSourceFromTheRow(lang);
      expect(toast.error).toHaveBeenCalledTimes(1);
      const [title, options] = toast.error.mock.calls[0] as [string, { description?: string }];
      expect(title).toBe(TITLE[lang]);
      expect(options.description).toBe(SENTENCE[lang]);
      // never the code, the key — nor, in Romanian, the server's English
      expect(options.description).not.toContain(CODE);
      expect(options.description).not.toContain("pf.");
      if (lang === "ro") expect(options.description).not.toBe(REFUSED_ANSWER.detail.message);
      expect(toast.success).not.toHaveBeenCalled();
      expect(onChanged).not.toHaveBeenCalled();     // nothing changed: nothing to refetch
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  }

  it("a refusal with another code still shows the server's sentence, never ours", async () => {
    answer = {
      status: 400,
      body: { detail: { code: "document_deleted", message: "This file was deleted. Restore it first." } },
    };
    await makeSourceFromTheRow("en");
    const [, options] = toast.error.mock.calls[0] as [string, { description?: string }];
    expect(options.description).toBe("This file was deleted. Restore it first.");
  });

  it("an accepted promotion is still a success", async () => {
    answer = {
      status: 200,
      body: { changed: true, document_id: DOC, period_id: "p", period_end: "2025-12-31",
              requeue_document_id: DOC, orphaned_after: [] },
    };
    const { onChanged } = await makeSourceFromTheRow("en");
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});
