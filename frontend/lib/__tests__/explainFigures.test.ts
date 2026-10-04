// GATE ai-figures — WHAT THE READER SEES IN "EXPLAIN" (law 14).
//
// Explain's AI path is the third caller of the chat function. Its answer is a
// model's prose about the panel on screen, asked for in the reader's language
// (the prompt orders it): its figures follow the same standard as every
// other model-written text — the format of the language the answer is
// written in, the ISO code after the figure (owner order 2026-10-04) —
// through lib/readerFigures: notation only, never a value.
//
// The REAL getExplanation with a recorder where the model would be:
//
//   · a FRESH answer and the one served from the CACHE are shown in the
//     reader's format; the cache holds what was shown; an answer cached
//     before the release (stored as the model wrote it) is repaired on read;
//   · one model request for a fresh answer, none for a cached one;
//   · the TEMPLATE path — no AI, or a failed AI — is the panel's own strings
//     verbatim: it is never passed through the normaliser;
//   · the request Explain really sends carries no display currency, so the
//     prompt the function builds for it holds no figure-format rule.
//
// REDS ON (TC-11): the pass taken off the fresh answer or off the cache hit;
// the cache storing something other than what was shown; the template
// re-formatted; the UI language (not the request's) deciding; a second model
// call; Explain's request gaining a display currency.
//
// CANNOT SEE: what a model writes; an answer in a language Explain never
// asks for (it would be read in the asked language); the panel's own figures
// (they are the panel's, printed by lib/money).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const bag = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => bag.get(k) ?? null,
    setItem: (k: string, v: string) => void bag.set(k, String(v)),
    removeItem: (k: string) => void bag.delete(k),
    clear: () => void bag.clear(),
    key: (i: number) => [...bag.keys()][i] ?? null,
    get length() { return bag.size; },
  },
});

// THE RECORDER: where the model would be.
const chatLlmMock = vi.fn();
vi.mock("@/lib/cfoApi", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/cfoApi")>();
  return { ...orig, cfoApi: { ...orig.cfoApi, chatLlm: chatLlmMock } };
});

const i18n = (await import("@/i18n")).default;
const { explainCacheKey, getExplanation, templateExplanation } = await import("@/lib/explain");
import type { ExplainRequest } from "@/lib/explain";
const { displayModelText } = await import("@/lib/readerFigures");
const { CURRENCY_BEFORE_FIGURE, foreignNumbersInProse, maskNotProse, plainSpaces } = await import("@/test/numberLanguage");
const { FIGURE_FORMAT_SECTION, buildSystemPrompt } = await import("../../../supabase/functions/chat-llm/prompt");

type Lang = "ro" | "en";
interface Kept { token: string; reason: string }
interface Case { id: string; lang: Lang; surface: string; wrong: boolean; input: string; expected: string; kept: Kept[]; anchors?: number[]; allowed?: { text: string }[] }

const REPO = resolve(__dirname, "../../..");
const CORPUS: Case[] = JSON.parse(readFileSync(resolve(REPO, "tests/engine/fixtures/ai_figures/reply_corpus.json"), "utf-8")).cases;
/** Explain hands the pass no figures: the cases whose expected string needs none. */
const CASES = CORPUS.filter((c) => !c.anchors);
const other = (lang: Lang): Lang => (lang === "ro" ? "en" : "ro");

const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function findings(text: string, lang: Lang, kept: readonly Kept[] = [], allowed: readonly { text: string }[] = []): string[] {
  let t = maskNotProse(text);
  for (const a of allowed) t = t.split(a.text).join("#".repeat(a.text.length));
  for (const k of kept) t = t.replace(new RegExp(`(?<![0-9.,])${escapeRx(k.token)}(?![0-9]|[.,][0-9])`, "g"), (m) => "#".repeat(m.length));
  return [...foreignNumbersInProse(t, lang), ...[...t.matchAll(new RegExp(CURRENCY_BEFORE_FIGURE.source, "g"))].map((m) => m[0])];
}

const REQ: ExplainRequest = {
  panelId: "benchmark-profitability",
  panelKind: "benchmark",
  snapshotKey: "period-1",
  lang: "ro",
  title: "Profitabilitate",
  // The panel's own strings, as a panel that prints English figures hands them.
  figures: [
    { termId: "ebitda", label: "Marja EBITDA", value: "12.4%", compare: "9.8%" },
    { label: "Marja netă", value: "6.1%", compare: "4.2%" },
  ],
  companyName: "Invented SRL",
};
const reqFor = (c: Case, n: number): ExplainRequest => ({ ...REQ, lang: c.lang === "ro" ? "ro-RO" : "en", snapshotKey: `period-${n}` });
const answers = (answer: string) => chatLlmMock.mockResolvedValueOnce({ answer, model: null, usage: null });

let checked = 0;
beforeEach(() => {
  chatLlmMock.mockReset();
  bag.clear();
});
afterAll(async () => {
  await i18n.changeLanguage("en");
  // eslint-disable-next-line no-console
  console.log(`GATE-WORK ai-figures-explain answers=${checked}`);
});

describe("14 an AI explanation is shown in the reader's format — fresh, and from the cache", () => {
  it("POSITIVE CONTROL: the cases are a real share of the corpus and the wrong ones ARE flagged", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(100);
    expect(CASES.filter((c) => c.wrong).length).toBeGreaterThanOrEqual(70);
    for (const c of CASES) if (c.wrong) expect(findings(c.input, c.lang).length, c.id).toBeGreaterThan(0);
  });

  it.each(CASES.map((c, n) => [c.id, c, n] as const))("%s", async (_id, c, n) => {
    // The interface in the OTHER language: the language is the request's, never the UI's.
    await i18n.changeLanguage(other(c.lang));
    const req = reqFor(c, n);
    answers(c.input);
    const fresh = await getExplanation(req);
    checked += 1;
    expect([fresh.source, fresh.degraded]).toEqual(["ai", null]);
    expect(plainSpaces(fresh.text)).toBe(c.expected);
    expect(findings(fresh.text, c.lang, c.kept, c.allowed)).toEqual([]);
    expect(fresh.text.replace(/[^0-9]/g, "")).toBe(c.input.replace(/[^0-9]/g, ""));
    expect(chatLlmMock).toHaveBeenCalledTimes(1);
    // The cache holds what was shown — and the second read asks nobody.
    const stored = JSON.parse(bag.get("cfo-explain-cache-v1")!)[explainCacheKey(req)].t as string;
    expect(stored).toBe(fresh.text);
    const again = await getExplanation(req);
    expect(again).toEqual(fresh);
    expect(chatLlmMock).toHaveBeenCalledTimes(1);
  });

  it("an answer CACHED BEFORE the release (stored as the model wrote it) is repaired on read, with no model request", async () => {
    let repaired = 0;
    for (const [n, c] of CASES.filter((x) => x.wrong).entries()) {
      const req = reqFor(c, 1000 + n);
      bag.set("cfo-explain-cache-v1", JSON.stringify({ [explainCacheKey(req)]: { t: c.input, at: 1 } }));
      const out = await getExplanation(req);
      expect(out.source).toBe("ai");
      expect(plainSpaces(out.text), c.id).toBe(c.expected);
      repaired += 1;
    }
    expect(repaired).toBeGreaterThanOrEqual(70);
    expect(chatLlmMock).not.toHaveBeenCalled();
  });

  it("the answer's OWN language wins over the one that was asked for: an English answer to a Romanian request keeps English figures", async () => {
    const english = "The EBITDA margin for the year is 12.4%, and the net margin is 6.1% with this definition.";
    answers(english);
    expect((await getExplanation({ ...REQ, lang: "ro", snapshotKey: "own-en" })).text).toBe(english);
    const romanian = "Marja EBITDA pentru anul acesta este 12,4%, iar marja netă este 6,1%.";
    answers(romanian);
    expect((await getExplanation({ ...REQ, lang: "en", snapshotKey: "own-ro" })).text).toBe(romanian);
    // …and a short answer that says nothing about its language takes the request's.
    answers("EBITDA: 12.4%.");
    expect((await getExplanation({ ...REQ, lang: "ro", snapshotKey: "short-ro" })).text).toBe("EBITDA: 12,4%.");
    answers("EBITDA: 12,4%.");
    expect((await getExplanation({ ...REQ, lang: "en", snapshotKey: "short-en" })).text).toBe("EBITDA: 12.4%.");
  });
});

describe("the TEMPLATE path is the panel's own strings, verbatim", () => {
  it("no figures on screen, a failed AI path, the upstream-failure sentinel and an empty answer: the template, byte for byte", async () => {
    const template = templateExplanation(REQ);
    expect(template).toContain("12.4%"); // the panel's string, as the panel printed it
    // POSITIVE CONTROL: passed through the normaliser, the template WOULD change.
    expect(displayModelText(template, { fallback: "ro" }).text).not.toBe(template);

    const quiet = vi.spyOn(console, "debug").mockImplementation(() => {});
    chatLlmMock.mockRejectedValueOnce(new Error("network"));
    const failed = await getExplanation(REQ);
    quiet.mockRestore();
    expect([failed.source, failed.text]).toEqual(["template", template]);

    answers("Couldn't reach Claude: 529 {\"type\":\"error\",\"request_id\":\"req_011X4.58M\"}");
    const upstream = await getExplanation({ ...REQ, snapshotKey: "p2" });
    expect([upstream.source, upstream.text]).toEqual(["template", template]);

    answers("   ");
    const empty = await getExplanation({ ...REQ, snapshotKey: "p3" });
    expect([empty.source, empty.text]).toEqual(["template", template]);

    const none = await getExplanation({ ...REQ, figures: [] });
    expect(none.source).toBe("template");
    expect(none.text).toBe(templateExplanation({ ...REQ, figures: [] }));
    // Nothing a failure returned was cached.
    expect(bag.get("cfo-explain-cache-v1")).toBeUndefined();
  });
});

describe("13 Explain's real request", () => {
  it("carries no display currency: the prompt the function builds for it holds no figure-format rule and no digit example of it", async () => {
    answers("Marja EBITDA este 12,4%.");
    await getExplanation(REQ);
    const req = (chatLlmMock.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(Object.keys(req).sort()).toEqual(["company_name", "messages", "mode", "page"]);
    const prompt = buildSystemPrompt(req as never);
    expect(prompt).not.toContain(FIGURE_FORMAT_SECTION);
    expect(prompt).not.toContain("Figure format");
    expect(prompt).not.toContain("Display-currency rule");
    // Its own brief still tells the model to quote the panel's figures exactly.
    expect((req.messages as { content: string }[])[0].content).toContain("quote them exactly as written");
  });
});
