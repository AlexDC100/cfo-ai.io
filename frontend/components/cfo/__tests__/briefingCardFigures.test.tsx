// GATE ai-figures — WHAT THE READER SEES ON THE BRIEFING CARD (law 15).
//
// OWNER ORDER (2026-10-04): "make chat and briefings write numbers in
// Romanian format in Romanian text (413.727.560 RON, ~77,4 mil. EUR),
// currency after the figure. Use the product's own formatting standard, with
// a gate."
//
// A briefing narrated AFTER the release is stored in the reader's format by
// the engine (gate ai-figures-engine). The card holds what is SHOWN for
// everything else: a row stored before the release, and the answer of an
// engine that predates it. It is DISPLAY ONLY — the served bytes stay what
// every rule of the card reads (unusable-narrative, stale, the language
// mismatch, the session comparison).
//
// The real CFOBriefingCard; `fetch` is the one channel a request can leave
// by, and it is counted. The bodies are the shared corpus's briefing cases
// (tests/engine/fixtures/ai_figures/reply_corpus.json, expected typed by
// hand), read by the repository's independent number-shape detector.
//
//   · a wrong-format Romanian body stamped `ro` is shown right;
//   · stamped `en` — as every row written before 2026-10-02 is, whatever its
//     language — it is shown right when its own prose says which language it
//     is written in, and exactly as stored when it does not: an `en` stamp is
//     never trusted;
//   · a German, French, Spanish, Italian, Portuguese, Dutch or Polish body is
//     not changed by a byte;
//   · a failure text is never prose; mounting makes no request;
//   · the narration of an explicit regenerate (one counted request) is shown
//     right, in the language the engine says it narrated in.
//
// REDS ON (TC-11): the pass taken off the card; an `en` stamp trusted (a
// German row re-printed as English); the UI language deciding; the pass fed
// to the card's own decisions instead of the served bytes; a request on
// mount; the session narration shown as answered.
//
// CANNOT SEE: the report page and the exports (they print the stored bytes:
// right for every briefing narrated after the release); a token left by
// design; what a model writes.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ currency: "RON" as string }));
vi.mock("@/stores/currency", () => ({ useDisplayCurrency: () => env.currency }));
vi.mock("@/lib/supabase", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/supabase")>()),
  getSupabase: () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: "jwt-of-the-reader", user: { id: "reader-1" } } } }) },
  }),
  currentOrgId: async () => "AMBIENT-COMPANY",
}));

import i18n from "@/i18n";
import { CFOBriefingCard } from "@/components/cfo/CFOBriefingCard";
import { queryClient } from "@/lib/queryClient";
import { displayModelText, normaliseFigures, proseLanguageOf } from "@/lib/readerFigures";
import { CURRENCY_BEFORE_FIGURE, foreignNumbersInProse, maskNotProse, plainSpaces } from "@/test/numberLanguage";

type Lang = "ro" | "en";
interface Kept { token: string; reason: string }
interface Case { id: string; lang: Lang; surface: string; wrong: boolean; input: string; expected: string; kept: Kept[]; anchors?: number[]; allowed?: { text: string }[] }

const REPO = resolve(__dirname, "../../../..");
const CORPUS: Case[] = JSON.parse(readFileSync(resolve(REPO, "tests/engine/fixtures/ai_figures/reply_corpus.json"), "utf-8")).cases;
/** The bodies a BRIEFING can hold; the card hands the pass no figures. A
 *  briefing is one paragraph: the card prints it as plain text. */
const CASES = CORPUS.filter((c) => c.surface !== "chat" && !c.anchors);
const other = (lang: Lang): Lang => (lang === "ro" ? "en" : "ro");
/** The case is a text returned whole because it holds a lone three-digit
 *  group (never half a text): shown exactly as stored, counted. */
const held = (c: Case) => c.kept.some((k) => k.reason === "text_held");
const PERIOD = "11111111-2222-4333-8444-555555555555";

const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function findings(text: string, lang: Lang, kept: readonly Kept[] = [], allowed: readonly { text: string }[] = []): string[] {
  let t = maskNotProse(text);
  for (const a of allowed) t = t.split(a.text).join("#".repeat(a.text.length));
  for (const k of kept) t = t.replace(new RegExp(`(?<![0-9.,])${escapeRx(k.token)}(?![0-9]|[.,][0-9])`, "g"), (m) => "#".repeat(m.length));
  return [...foreignNumbersInProse(t, lang), ...[...t.matchAll(new RegExp(CURRENCY_BEFORE_FIGURE.source, "g"))].map((m) => m[0])];
}

// ── the one channel a request can leave by ──────────────────────────────
let answer: { status: number; body: unknown } = { status: 200, body: {} };
const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
  ok: answer.status >= 200 && answer.status < 300,
  status: answer.status,
  statusText: "",
  json: async () => answer.body,
}));
let invalidate: ReturnType<typeof vi.spyOn>;
let shownBodies = 0;

beforeEach(() => {
  env.currency = "RON";
  answer = { status: 200, body: {} };
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  invalidate = vi.spyOn(queryClient, "invalidateQueries").mockImplementation(async () => {});
});
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  invalidate.mockRestore();
  await i18n.changeLanguage("en");
});
afterAll(() => {
  // eslint-disable-next-line no-console
  console.log(`GATE-WORK ai-figures-briefing bodies=${shownBodies}`);
});

type CardProps = Partial<Parameters<typeof CFOBriefingCard>[0]>;
const card = (props: CardProps) => (
  <MemoryRouter>
    <CFOBriefingCard periodId={PERIOD} baseBriefing={null} baseLanguage="en" orgId="99999999-8888-4777-8666-555555555555" {...props} />
  </MemoryRouter>
);
/** The body the card shows for a stored briefing. */
function shownBody(baseBriefing: string, baseLanguage: string | null): string {
  const view = render(card({ baseBriefing, baseLanguage }));
  const text = screen.getByTestId("cfo-briefing-body").textContent ?? "";
  view.unmount();
  shownBodies += 1;
  return text;
}
const quiet = () => act(async () => { await new Promise((r) => setTimeout(r, 40)); });

describe("POSITIVE CONTROL — the bodies", () => {
  it("the briefing cases are a real share of the corpus; the wrong ones ARE flagged; none reads as the other language", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(120);
    expect(CASES.filter((c) => c.lang === "ro" && c.wrong).length).toBeGreaterThanOrEqual(60);
    expect(CASES.filter((c) => c.lang === "en").length).toBeGreaterThanOrEqual(20);
    expect(CASES.filter(held).length).toBeGreaterThanOrEqual(4);
    for (const c of CASES) {
      if (c.wrong) expect(findings(c.input, c.lang).length, c.id).toBeGreaterThan(0);
      expect([c.lang, null], c.id).toContain(proseLanguageOf(c.input));
    }
    expect(CASES.map((c) => c.id)).toContain("briefing-wrong-format");
  });
});

describe("15 a stored briefing is SHOWN in the reader's format", () => {
  it.each(CASES.filter((c) => c.lang === "ro").map((c) => [c.id, c] as const))("stamped ro — %s", async (_id, c) => {
    // The interface in English: the stamp and the text decide, never the UI.
    await i18n.changeLanguage(other(c.lang));
    const text = shownBody(c.input, "ro");
    expect(plainSpaces(text)).toBe(c.expected);
    if (held(c)) expect(text).toBe(c.input); // never half a text: the stored bytes
    else if (!c.input.includes("`")) expect(findings(text, c.lang, c.kept, c.allowed)).toEqual([]);
    expect(text.replace(/[^0-9]/g, "")).toBe(c.input.replace(/[^0-9]/g, ""));
    // No request left on mount.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stamped en — as every row written before 2026-10-02 is, whatever its language: shown right when its own prose says which language it is written in, exactly as stored when it does not", async () => {
    const counts = { ro: { repaired: 0, as_stored: 0 }, en: { repaired: 0, as_stored: 0 } };
    for (const ui of ["ro", "en"] as const) {
      await i18n.changeLanguage(ui);
      for (const c of CASES) {
        const text = shownBody(c.input, "en");
        if (proseLanguageOf(c.input) === c.lang) {
          expect(plainSpaces(text), `${ui} ${c.id}`).toBe(c.expected);
          if (ui === "en" && c.wrong) counts[c.lang].repaired += 1;
        } else {
          // The stamp is not evidence: the body is the stored bytes.
          expect(text, `${ui} ${c.id}`).toBe(c.input);
          if (ui === "en" && c.wrong) counts[c.lang].as_stored += 1;
        }
      }
    }
    // Old Romanian rows ARE repaired (their prose reads), and so are English ones that read.
    expect(counts.ro.repaired).toBeGreaterThanOrEqual(40);
    expect(counts.en.repaired).toBeGreaterThanOrEqual(3);
    // …and the cases too short to tell are a real share: the `en` stamp alone repaired none of them.
    expect(counts.ro.as_stored + counts.en.as_stored).toBeGreaterThanOrEqual(10);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("with no stamp at all the text's own prose decides — the same as an `en` stamp", async () => {
    const c = CORPUS.find((x) => x.id === "briefing-wrong-format")!;
    for (const stamp of [null, "", "en", "EN"]) expect(plainSpaces(shownBody(c.input, stamp)), String(stamp)).toBe(c.expected);
    const short = "EBITDA: 4.58M RON.";
    for (const stamp of [null, "", "en", "xx"]) expect(shownBody(short, stamp), String(stamp)).toBe(short);
    // A stamp that NAMES another language (es, pt, de, any code that is not ro / en) is believed: the body is shown as served.
    for (const stamp of ["xx", "es", "pt", "de", "ES", "pt-BR"]) expect(shownBody(c.input, stamp), stamp).toBe(c.input);
    for (const stamp of ["ro", "RO", "ro-RO"]) expect(plainSpaces(shownBody(short, stamp)), stamp).toBe("EBITDA: 4,58 mil. RON.");
  });

  it("a briefing already in the reader's format is not changed by a byte (the owner's own briefing, in shape)", async () => {
    const c = CORPUS.find((x) => x.id === "briefing-right-format")!;
    expect(c.wrong).toBe(false);
    for (const stamp of ["ro", "en"]) expect(shownBody(c.input, stamp)).toBe(c.input);
  });

  it.each([
    ["de", "Der Umsatz betrug RON 64,567,890 und die EBITDA-Marge lag bei 11.85%. Das Unternehmen ist nicht verschuldet (2.35x)."],
    ["fr", "Le chiffre d'affaires est de RON 64,567,890 et la marge d'EBITDA est de 11.85%. La société est peu endettée (2.35x)."],
    ["es", "La cifra de negocios fue de RON 64,567,890 y el margen EBITDA del 11.85%. La empresa no está endeudada (2.35x)."],
    ["it", "Il fatturato è stato di RON 64,567,890 e il margine EBITDA dell'11.85%. La società non si è indebitata (2.35x)."],
    ["pt", "O volume de negócios foi de RON 64,567,890 e a margem EBITDA de 11.85%. A empresa não está endividada (2.35x)."],
    ["nl", "De omzet bedroeg RON 64,567,890 en de EBITDA-marge was 11.85%. Het bedrijf heeft weinig schulden (2.35x)."],
    ["pl", "Przychody wyniosły RON 64,567,890, a marża EBITDA 11.85%. Firma nie jest zadłużona (2.35x)."],
    // "este" and "dar" are everyday Spanish and Portuguese (review 2026-10-05):
    // read as Romanian, the glued magnitude became "mil." / "mii" — a thousand there.
    ["es", "Este ejercicio la empresa registró ingresos de 12,3M EUR y un EBITDA de 2,1M EUR, lo que puede dar lugar a una mejora del margen."],
    ["es", "Este año el margen puede dar un resultado de 918K EUR, que este trimestre se suma a los RON 4.58M."],
    ["pt", "Este exercício a empresa vai dar um resultado de 918K EUR, e este valor pode dar origem a 12,3M EUR de receitas."],
  ])("a %s narration — stamped en like every narration in a language the stamp cannot name — is not changed by a byte", async (code, body) => {
    for (const ui of ["ro", "en"] as const) {
      await i18n.changeLanguage(ui);
      for (const stamp of ["en", code, null]) expect(shownBody(body, stamp), `${ui} ${stamp}`).toBe(body);
    }
    // POSITIVE CONTROL: read as Romanian or English, the pass WOULD rewrite it.
    expect(normaliseFigures(body, "ro").text).not.toBe(body);
    expect(normaliseFigures(body, "en").text).not.toBe(body);
    // A HINT (the language of an earlier turn) never makes it either (round 2).
    expect(displayModelText(body, { fallback: "ro" }).text).toBe(body);
    expect(displayModelText(body, { fallback: "en" }).text).toBe(body);
  });
});

describe("the pass is display only", () => {
  const WRONG = CORPUS.find((x) => x.id === "briefing-wrong-format")!;

  it("a failure text is never prose, whatever digits it holds; mounting makes no request", async () => {
    for (const text of ["[NARRATIVE_UNAVAILABLE]", "Narrative unavailable: Error code: 400 - RON 4.58M (8.75%)", "   "]) {
      const view = render(card({ baseBriefing: text, baseLanguage: "ro" }));
      expect(screen.queryByTestId("cfo-briefing-body")).toBeNull();
      expect(screen.getByTestId("cfo-briefing").textContent).not.toMatch(/4[.,]58|8[.,]75/);
      view.unmount();
    }
    render(card({ baseBriefing: WRONG.input, baseLanguage: "ro" }));
    await quiet();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the card's own decisions read the SERVED bytes: a Romanian body under a Romanian interface offers nothing and is 'verificat' — collapsed or open", async () => {
    await i18n.changeLanguage("ro");
    for (const collapsed of [true, false]) {
      const view = render(card({ baseBriefing: WRONG.input, baseLanguage: "ro", collapsed, onToggle: () => {} }));
      expect(plainSpaces(screen.getByTestId("cfo-briefing-body").textContent ?? "")).toBe(WRONG.expected);
      expect(screen.queryByTestId("briefing-regenerate")).toBeNull();
      expect(screen.getByTestId("briefing-header").textContent).toMatch(/verificat/i);
      expect(screen.getByTestId("cfo-briefing").getAttribute("data-briefing-state")).toBe("current");
      view.unmount();
    }
    // A kept (stale) briefing stays stale: the pass changes what is printed, not what the card knows.
    render(card({ baseBriefing: WRONG.input, baseLanguage: "ro", stale: { since: "2026-10-03T10:00:00Z" } as never }));
    expect(screen.getByTestId("cfo-briefing").getAttribute("data-briefing-state")).toBe("stale");
    expect(plainSpaces(screen.getByTestId("cfo-briefing-body").textContent ?? "")).toBe(WRONG.expected);
  });

  it("the source: ONE call of the pass, its result printed in ONE place and read by nothing else", () => {
    const src = readFileSync(resolve(__dirname, "../CFOBriefingCard.tsx"), "utf8");
    const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(code.match(/displayModelText\(/g)).toHaveLength(1);
    expect(code.match(/\bshownText\b/g)).toHaveLength(2); // its definition, and the body's <p>
    expect(code).toMatch(/>\s*\{shownText\}\s*<\/p>/);
    expect(code).not.toMatch(/normaliseFigures|i18n\.language[^;]*displayModelText/);
    // The decisions name the served text.
    for (const decision of ["const langMismatch = !!text", "const currencyMismatch = !!text", "const isStale = !!text", "const hadProse = !!text"]) {
      expect(code, decision).toContain(decision);
    }
  });
});

describe("the narration of an explicit regenerate", () => {
  const WRONG_RO = CORPUS.find((x) => x.id === "briefing-regenerated-in-eur")!;
  const WRONG_EN = CORPUS.find((x) => x.id === "briefing-english-regenerated-in-eur")!;
  const STORED = "Veniturile au crescut, iar marja s-a menținut; lichiditatea este redusă față de datoriile pe termen scurt.";

  async function regenerated(body: Record<string, unknown>, ui: Lang, stored = STORED): Promise<string> {
    await i18n.changeLanguage(ui);
    env.currency = "EUR";
    answer = { status: 200, body: { ok: true, regenerated: true, persisted: false, stale: false, ...body } };
    render(card({ baseBriefing: stored, baseLanguage: ui }));
    await quiet();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("briefing-regenerate"));
    await waitFor(() => expect(screen.getByTestId("cfo-briefing-body").textContent).not.toBe(stored));
    // ONE counted request: the click's.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain(`/api/period/${PERIOD}/briefing/regenerate`);
    shownBodies += 1;
    return screen.getByTestId("cfo-briefing-body").textContent ?? "";
  }

  it("an engine that predates the release answers a Romanian narration in EUR as the model wrote it — the card shows it right", async () => {
    expect(WRONG_RO.input).toContain("EUR 12.3M");
    const text = await regenerated({ briefing: WRONG_RO.input, language: "ro", currency: "EUR" }, "ro");
    expect(plainSpaces(text)).toBe(WRONG_RO.expected);
    expect(findings(text, "ro")).toEqual([]);
    expect(screen.getByTestId("briefing-header").textContent).toMatch(/EUR/);
  });

  it("the language the engine SAYS it narrated in is trusted for this session's narration — `en` too, unlike a stored stamp", async () => {
    expect(proseLanguageOf(WRONG_EN.input)).toBeNull(); // its own prose does not say
    const text = await regenerated({ briefing: WRONG_EN.input, language: "en", currency: "EUR" }, "en", "Revenue grew and the margin held; liquidity is thin against short-term debt.");
    expect(plainSpaces(text)).toBe(WRONG_EN.expected);
    // POSITIVE CONTROL: the same body as a STORED row stamped en is shown as stored.
    cleanup();
    expect(shownBody(WRONG_EN.input, "en")).toBe(WRONG_EN.input);
  });

  it("a narration in a language the standard does not define is shown as answered", async () => {
    const german = "Der Umsatz betrug EUR 12.3M und die Marge lag bei 11.85%.";
    expect(await regenerated({ briefing: german, language: "de", currency: "EUR" }, "ro")).toBe(german);
  });

  it("…a Spanish one too, though it shares words with Romanian — the engine SAID which language it narrated in", async () => {
    const spanish = "Este ejercicio la empresa registró ingresos de 12,3M EUR y un EBITDA de 2,1M EUR, lo que puede dar lugar a una mejora del margen.";
    expect(await regenerated({ briefing: spanish, language: "es", currency: "EUR" }, "ro")).toBe(spanish);
    // POSITIVE CONTROL: handed to the pass as Romanian (what the card did before it believed the stamp), it IS re-spelt.
    expect(displayModelText(spanish, { known: "ro" }).text).not.toBe(spanish);
  });
});
