// GATE rerun-refusal-surfaces (F4): A RE-RUN THAT DID NOT FINISH IS SAID ON
// THE FILE'S OWN ROW — one of three sentences, in the reader's language,
// and never the text the engine stored.
//
// Since 2026-10-04 "Re-run analysis" is STAGED beside the file's month
// (engine gate rerun-data-loss): the month keeps being served while the run
// goes, and a run that fails leaves the file `analyzed` over the analysis it
// had. The row would look as if nothing had been tried. The engine stores
// `documents.error = "rerun_failed: <remainder>"`; the remainder is a code
// or the run's own diagnostic text.
//
// WHAT IS REAL: `DocRerunNote`, lib/rerunRefusals, lib/uploadRefusals, the
// i18n bundles — and, for the last block, the Docs panel itself with its
// document row, over a `fetch` that answers the panel's list.
//
// The expected sentences are stated here, not read from the module or the
// locale files (a second law holds those equal: rerunRefusals.test.ts).
//
// Fails on: a `rerun_failed:` row that says nothing; the wrong sentence for
// a kind; the remainder (a code, an exception's text) on screen; a sentence
// in the wrong language; the note on a row whose error is not a re-run's
// (a superseded marker, a plain failure); the plan refusal's sentence
// missing when the remainder carries its code — or printed twice on a
// `failed` row, where DocRefusalReason already prints it; the Docs panel
// not rendering the note on its row.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import i18n from "@/i18n";
import { DocRerunNote } from "@/components/cfo/DocRerunNote";
import { DocsPanel } from "@/components/cfo/DocsPanel";
import { getSupabase } from "@/lib/supabase";

// ── The law, stated. ────────────────────────────────────────────────────
const LINE = {
  interrupted: {
    en: "The last re-run was interrupted while it was replacing the analysis. Run it again.",
    ro: "Ultima reanalizare a fost întreruptă în timp ce înlocuia analiza. Reia analiza.",
  },
  month_taken: {
    en: "The last re-run was not applied: the file now reads as a month that already has its own analysis. Nothing was changed.",
    ro: "Ultima reanalizare nu a fost aplicată: fișierul indică acum o lună care are deja propria analiză. Nu s-a schimbat nimic.",
  },
  kept: {
    en: "The last re-run didn't finish. You're still seeing the previous analysis.",
    ro: "Ultima reanalizare nu s-a încheiat. Vezi în continuare analiza anterioară.",
  },
} as const;
type Kind = keyof typeof LINE;
const LANGS = ["en", "ro"] as const;

/** What the engine stores → the kind of line the row prints. */
const STORED: [string, Kind][] = [
  ["rerun_failed: interrupted_replacing", "interrupted"],
  ["rerun_failed: rerun_month_taken", "month_taken"],
  ["rerun_failed: RuntimeError: compute failed", "kept"],
  ["rerun_failed: ReadTimeout: The read operation timed out", "kept"],
  ["rerun_failed: document_superseded", "kept"],
  // A re-run that now reads as a public-records summary (engine gate
  // rerun-data-loss, A3): refused before any write — the previous analysis IS
  // still the one served, and the row has no sentence of its own for it.
  ["rerun_failed: rerun_not_a_trial_balance", "kept"],
  ["rerun_failed: The period this run was staged under no longer exists — the month was not replaced; the analysis already there is unchanged.", "kept"],
  ["rerun_failed: ", "kept"],
];

/** A plan refusal as the engine stores it (the neutral code, JSON form) and
 *  the sentence lib/uploadRefusals prints for it. */
const PLAN_REFUSAL = 'rerun_failed: {"error": "non_ro_not_included"}';

const FRONTEND = resolve(__dirname, "../../..");
const source = (rel: string) => readFileSync(resolve(FRONTEND, rel), "utf8");
const at = (tree: Record<string, unknown>, key: string): unknown =>
  key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], tree);
const locale = (lang: string) => JSON.parse(source(`i18n/locales/${lang}.json`));

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  await i18n.changeLanguage("en");
});

describe("F4 — the row says what happened to the last re-run", () => {
  for (const lang of LANGS) {
    for (const [stored, kind] of STORED) {
      it(`${lang}: "${stored.slice(0, 44)}" on an analysed row → the ${kind} line`, async () => {
        await i18n.changeLanguage(lang);
        render(<DocRerunNote status="analyzed" error={stored} />);
        const note = screen.getByTestId("doc-rerun-note");
        expect(note.textContent).toBe(LINE[kind][lang]);
        expect(note.getAttribute("data-kind")).toBe(kind);
      });
    }
  }

  it("the remainder is never printed — not a code, not an exception's text, not the prefix", async () => {
    for (const lang of LANGS) {
      await i18n.changeLanguage(lang);
      for (const [stored] of STORED) {
        cleanup();
        const { container } = render(<DocRerunNote status="analyzed" error={stored} />);
        const shown = container.textContent ?? "";
        for (const raw of ["rerun_failed", "interrupted_replacing", "rerun_month_taken", "document_superseded",
                           "rerun_not_a_trial_balance", "RuntimeError", "ReadTimeout", "compute failed",
                           "staged under", "panels."]) {
          expect(shown, `${lang}: ${stored}`).not.toContain(raw);
        }
      }
    }
  });

  it("an error that is not a re-run's prints nothing", () => {
    const others: (string | null | undefined)[] = [
      null,
      undefined,
      "",
      "superseded_by:0d0c0000-0000-4000-8000-0000000000d2",
      "duplicate_of:0d0c0000-0000-4000-8000-0000000000d1",
      "RuntimeError: compute failed",
      '{"error": "non_ro_not_included"}',
      "the last rerun_failed: interrupted_replacing",   // the prefix is a PREFIX
      "rerun_failed:interrupted_replacing",              // … exactly as the engine writes it
    ];
    for (const status of ["analyzed", "failed", "queued"]) {
      for (const error of others) {
        cleanup();
        render(<DocRerunNote status={status} error={error} />);
        expect(screen.queryByTestId("doc-rerun-note"), `${status}: ${error}`).toBeNull();
      }
    }
  });

  it("the note does not depend on the row's status (a staged re-run never changes it)", () => {
    for (const status of ["analyzed", "failed", "queued"]) {
      cleanup();
      render(<DocRerunNote status={status} error="rerun_failed: interrupted_replacing" />);
      expect(screen.getByTestId("doc-rerun-note").textContent).toBe(LINE.interrupted.en);
    }
  });
});

describe("F4 — a plan refusal inside a re-run that did not finish", () => {
  // The plan refusal's own sentence belongs to another gate
  // (lib/__tests__/uploadRefusalCodes.test.ts); here it is only required to
  // FOLLOW the kept line — so it is read from the locale file, by its key.
  const PLAN_KEY = "pricing.nonRoBlockedDesc";
  const PLAN = { en: at(locale("en"), PLAN_KEY) as string, ro: at(locale("ro"), PLAN_KEY) as string };

  it("the plan sentences this block expects exist, in both languages, and differ", () => {
    expect(typeof PLAN.en).toBe("string");
    expect(typeof PLAN.ro).toBe("string");
    expect(PLAN.en.length).toBeGreaterThan(20);
    expect(PLAN.ro).not.toBe(PLAN.en);
  });

  for (const lang of LANGS) {
    for (const stored of [PLAN_REFUSAL, 'rerun_failed: NonRoNotIncludedError: {"error": "non_ro_not_included"}']) {
      it(`${lang}: "${stored.slice(14, 44)}…" → the kept line, then the sentence of the refusal's code`, async () => {
        await i18n.changeLanguage(lang);
        render(<DocRerunNote status="analyzed" error={stored} />);
        const shown = screen.getByTestId("doc-rerun-note").textContent ?? "";
        expect(shown).toBe(`${LINE.kept[lang]} ${PLAN[lang]}`);
        expect(shown).not.toContain("non_ro_not_included");
        expect(shown).not.toContain("NonRoNotIncludedError");
        expect(shown).not.toMatch(/[{}"]/);
      });
    }
  }

  it("on a FAILED row the plan sentence is DocRefusalReason's to print — not twice", () => {
    render(<DocRerunNote status="failed" error={PLAN_REFUSAL} />);
    expect(screen.getByTestId("doc-rerun-note").textContent).toBe(LINE.kept.en);
  });

  it("the two codes of a re-run are never read as a plan refusal", () => {
    for (const stored of ["rerun_failed: interrupted_replacing", "rerun_failed: rerun_month_taken"]) {
      cleanup();
      render(<DocRerunNote status="analyzed" error={stored} />);
      const shown = screen.getByTestId("doc-rerun-note").textContent ?? "";
      expect([LINE.interrupted.en, LINE.month_taken.en]).toContain(shown);
    }
  });
});

// ── the Docs panel renders it, on the file's own row ────────────────────

const DOC = "0d0c0000-0000-4000-8000-0000000000d1";
const PERIOD = "0d0c0000-0000-4000-8000-0000000000b1";

function panelWith(error: string | null, status = "analyzed") {
  return {
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
            status,
            is_active: true,
            confidence: 0.9,
            error,
          },
        ],
      },
    ],
    recently_deleted: [],
  };
}

async function openThePanel(payload: unknown, lang: (typeof LANGS)[number]) {
  await i18n.changeLanguage(lang);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => payload })),
  );
  vi.spyOn(getSupabase()!.auth, "getSession").mockResolvedValue({
    data: { session: { access_token: "jwt-of-the-reader" } },
    error: null,
  } as never);
  localStorage.setItem("cfoai.docs_panel.open", "1");
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/dashboard"]}>
        <DocsPanel />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return screen.findByTestId("doc-row");
}

describe("F4 — the Docs panel prints the note on the file's row", () => {
  beforeEach(() => localStorage.clear());

  for (const lang of LANGS) {
    it(`${lang}: an analysed file whose last re-run was interrupted`, async () => {
      const row = await openThePanel(panelWith("rerun_failed: interrupted_replacing"), lang);
      const note = await screen.findByTestId("doc-rerun-note");
      expect(row.contains(note)).toBe(true);
      expect(note.textContent).toBe(LINE.interrupted[lang]);
      expect(row.textContent).not.toContain("interrupted_replacing");
      expect(row.textContent).not.toContain("rerun_failed");
    });
  }

  it("an analysed file whose last re-run failed keeps its row and says so", async () => {
    const row = await openThePanel(panelWith("rerun_failed: RuntimeError: compute failed"), "en");
    expect((await screen.findByTestId("doc-rerun-note")).textContent).toBe(LINE.kept.en);
    expect(row.textContent).not.toContain("compute failed");
  });

  it("a file with no such error shows no note (the superseded marker is not a re-run's)", async () => {
    for (const error of [null, "superseded_by:0d0c0000-0000-4000-8000-0000000000d2"]) {
      cleanup();
      await openThePanel(panelWith(error), "en");
      expect(screen.queryByTestId("doc-rerun-note")).toBeNull();
    }
  });

  it("the panel renders it beside DocRefusalReason, from a static import", () => {
    const panel = source("components/cfo/DocsPanel.tsx");
    expect(panel).toMatch(/<DocRefusalReason status=\{doc\.status\} error=\{doc\.error\} \/>/);
    expect(panel).toMatch(/<DocRerunNote status=\{doc\.status\} error=\{doc\.error\} \/>/);
    expect(panel).toMatch(/^import \{ DocRerunNote \} from "@\/components\/cfo\/DocRerunNote";$/m);
    expect(source("components/cfo/DocRerunNote.tsx")).toMatch(
      /^import \{[^}]*rerunFailedKind[^}]*\} from "@\/lib\/rerunRefusals";$/m,
    );
  });
});
