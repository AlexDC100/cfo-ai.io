// GATE ai-figures — WHAT THE READER SEES IN ASK CFO AI (and what the command
// bar's guard is handed).
//
// OWNER ORDER (2026-10-04): "make chat and briefings write numbers in
// Romanian format in Romanian text (413.727.560 RON, ~77,4 mil. EUR),
// currency after the figure. Use the product's own formatting standard, with
// a gate."
//
// THE DEFECT. The chat stored and rendered the model's text as it came: on
// 2026-10-04 a Romanian answer read "~EUR 12.3M (convertit din RON 64,567,890
// la cursul BNR 0.1905)" (figures invented here, the shape is the incident's).
//
// These laws drive the REAL send pipeline (chatTurns.startChatTurn) and the
// REAL list and bubble (CFOMessageList / CFOMessageBubble) with a recorder
// where the model would be — it answers the wrong-format replies of the
// shared corpus (tests/engine/fixtures/ai_figures/reply_corpus.json, expected
// strings typed by hand) — and read what is STORED, what is RENDERED and what
// is SENT BACK as history with the repository's independent number-shape
// detector (frontend/test/numberLanguage.ts), never with the normaliser.
//
//   10  a reply, from the transport to the bubble: stored = shown = expected;
//       one model request per turn; the snapshot's figures reach the pass;
//   11  a wrong-format reply ALREADY in the store (before the release, an
//       older function's prompt) is shown right — and never flashes its old
//       shape while typing out; the reader's own turn, a refusal, a failed
//       and an interrupted turn with the same digits are not touched;
//   12  the next request's history carries the reply as the reader saw it,
//       and the reader's own turns as typed;
//   13  THE COMMAND BAR IS NOT A CALLER: its guard receives the transport's
//       text byte for byte, and its real request's prompt holds no
//       figure-format rule (its contract is "write NO digits");
//   +   the three headings `anchorsOfSnapshot` cuts at are the ones the real
//       snapshot builder writes.
//
// REDS ON, with the repair in place (TC-11): the pass taken out of the send
// pipeline or out of the bubble; the bubble normalising after the typewriter;
// the UI language deciding a reply's format; a refusal or the reader's own
// turn rewritten; history sent as stored; the normaliser put in front of the
// command bar's guard or inside cfoApi.chatLlm; a snapshot heading renamed.
//
// CANNOT SEE: what a model WRITES (the recorder is a script); a token left by
// design (a lone three-digit group); the report page; real layout; a bundle
// older than the release (it shows what the function returned).
//
// PLANT LOG: docs/engine_book/gates.md "ai-figures" (stage 2).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, render, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import type { ChatMessage } from "../types";

vi.mock("../chatRemote", () => ({
  chatIdentity: async () => ({ userId: "0f0e0d0c-0000-4000-8000-00000000f1a5", orgId: null }),
  deleteMessages: async () => true,
  deleteThread: async () => true,
  fetchConversations: async () => null,
  importLocalConversations: async () => 0,
  insertMessage: async () => true,
  insertThread: async () => true,
  updateThread: async () => true,
}));
vi.mock("@/lib/org", () => ({ useActiveOrg: () => ({ org: null, loading: false }) }));

// THE RECORDER: where the model would be. Every call is counted; a call no
// law scripted answers nothing usable and is seen by the count.
const chatLlmMock = vi.fn();
vi.mock("@/lib/cfoApi", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/cfoApi")>();
  return { ...orig, cfoApi: { ...orig.cfoApi, chatLlm: chatLlmMock } };
});

// The command bar's guard, REAL, with a tap on what it is handed.
const guardSaw: string[] = [];
vi.mock("@/components/instrument/shell/capsuleAnswer/capsuleAnswerGuard", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/components/instrument/shell/capsuleAnswer/capsuleAnswerGuard")>();
  return {
    ...orig,
    guardAnswer: (text: string, input: Parameters<typeof orig.guardAnswer>[1]) => {
      guardSaw.push(text);
      return orig.guardAnswer(text, input);
    },
  };
});

const i18n = (await import("@/i18n")).default;
const { startChatTurn } = await import("../chatTurns");
const { chatAppendUserTurn, chatCompleteAssistantTurn, getChatConversation, resetChatLiveState, visibleConversations } = await import("../useChatStore");
const { clearAiDegraded } = await import("@/lib/aiDegraded");
const { CFOMessageList } = await import("../CFOMessageList");
const { CFOHistorySidebar } = await import("../CFOHistorySidebar");
const { searchFold } = await import("../useChatSearchHighlight");
const { FALLBACK_PAYLOAD } = await import("@/lib/rates");
const { anchorsOfSnapshot, displayModelText, normaliseFigures } = await import("@/lib/readerFigures");
const { CURRENCY_BEFORE_FIGURE, foreignNumbersInProse, maskNotProse, plainSpaces } = await import("@/test/numberLanguage");
const { buildWorkspaceSnapshot } = await import("@/pages/cfo/Chat");
const { edgeGenerationTransport, runAnswerTurn } = await import("@/components/instrument/shell/capsuleAnswer/capsuleAnswerClient");
const { planRetrieval } = await import("@/components/instrument/shell/capsuleAnswer/capsuleRetrieval");
const { ANSWER_FIXTURES, FIXTURE_PERIODS, fixtureToolTransport } = await import("@/components/instrument/shell/capsuleAnswer/capsuleAnswerFixtures");
const { FIGURE_FORMAT_SECTION, buildSystemPrompt } = await import("../../../../../supabase/functions/chat-llm/prompt");
const pairJson = (await import("@/lib/__tests__/fixtures/comparatives/pair_served.json")).default;

type Lang = "ro" | "en";
interface Kept { token: string; reason: string }
interface Case {
  id: string; lang: Lang; surface: "chat" | "briefing" | "both"; wrong: boolean;
  input: string; expected: string; kept: Kept[]; anchors?: number[]; allowed?: { text: string }[];
}

const REPO = resolve(__dirname, "../../../../..");
const CORPUS: Case[] = JSON.parse(readFileSync(resolve(REPO, "tests/engine/fixtures/ai_figures/reply_corpus.json"), "utf-8")).cases;
/** The replies a CHAT can hold. */
const CHAT_CASES = CORPUS.filter((c) => c.surface !== "briefing");
const NBSP = String.fromCharCode(0xa0);
const other = (lang: Lang): Lang => (lang === "ro" ? "en" : "ro");
/** The case is a text returned whole because it holds a lone three-digit
 *  group (never half a text): stored and shown exactly as the model wrote it,
 *  counted — the detector is not run on what is not ours. */
const held = (c: Case) => c.kept.some((k) => k.reason === "text_held");

/** The question each reply answers — in the reply's language (each reads as
 *  that language on its function words; a control below holds it). */
const QUESTION: Record<Lang, string> = {
  ro: "Care este situația firmei și cum se compară cu anul trecut?",
  en: "What is the position of the company and how does it compare with the prior year?",
};

const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The independent detector, as the normaliser's own gate reads with it. */
function findings(text: string, lang: Lang, kept: readonly Kept[] = [], allowed: readonly { text: string }[] = []): string[] {
  let t = maskNotProse(text);
  for (const a of allowed) t = t.split(a.text).join("#".repeat(a.text.length));
  for (const k of kept) t = t.replace(new RegExp(`(?<![0-9.,])${escapeRx(k.token)}(?![0-9]|[.,][0-9])`, "g"), (m) => "#".repeat(m.length));
  return [...foreignNumbersInProse(t, lang), ...[...t.matchAll(new RegExp(CURRENCY_BEFORE_FIGURE.source, "g"))].map((m) => m[0])];
}

/** The TEXT a reader sees for a markdown reply — written here, not taken
 *  from the bubble: headings and bullets lose their marker, bold and code
 *  lose their marks, a labelled link shows its label, a paragraph keeps its
 *  line breaks, blocks follow each other. (A reply with none of these reads
 *  as itself.) */
function mdText(md: string): string {
  const inline = (s: string) => s.replace(/`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]\n]+)\]\(\/[^)\n]*\)/g, (_m, code, bold, label) => code ?? bold ?? label);
  const blocks: string[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) { blocks.push(para.map(inline).join("\n")); para = []; } };
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) { flush(); continue; }
    const marked = /^#{2,3}\s+(.*)$/.exec(line) ?? /^\s*[-*]\s+(.*)$/.exec(line);
    if (marked) { flush(); blocks.push(inline(marked[1])); continue; }
    para.push(line);
  }
  flush();
  return blocks.join("");
}

/** A workspace snapshot that hands the model `anchors` — printed as the real
 *  snapshot prints a figure (en-US), above any prose section. */
const EN_US = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });
function snapshotOf(anchors: readonly number[] | undefined): string {
  const lines = ["Period: FY2025 (period ending 2025-12-31)", "Company: Invented SRL"];
  if (anchors?.length) {
    lines.push("", "Headline metrics (server-computed):");
    anchors.forEach((a, i) => lines.push(`  · fact_${String.fromCharCode(97 + i)}: ${EN_US.format(a)}`));
  }
  lines.push("", "Prior engine-generated briefing:", "Lichiditatea curentă este 9,87 și scorul 6,54; soldul este 98.765,43 RON.");
  return lines.join("\n");
}

function turnCtx(text: string, workspaceSnapshot?: string) {
  return {
    orgId: null, text, attachments: [], periodId: null, periodLabel: null,
    groundedLabel: null, workspaceSnapshot, companyName: "Invented SRL",
    displayCurrency: "EUR" as const, sourceCurrency: "RON" as const, rates: FALLBACK_PAYLOAD,
  };
}

async function settled() {
  const id = visibleConversations(null)[0].id;
  await waitFor(() => {
    const c = getChatConversation(null, id)!;
    expect(c.messages[c.messages.length - 1].pending).toBeFalsy();
  }, { timeout: 5000 });
  return getChatConversation(null, id)!;
}

/** One real turn: the reader asks, the recorder answers `answer`. */
async function answeredTurn(question: string, answer: string, snapshot?: string) {
  chatLlmMock.mockResolvedValueOnce({ answer, model: null, usage: null });
  startChatTurn(turnCtx(question, snapshot));
  const conv = await settled();
  return { conv, reply: conv.messages[conv.messages.length - 1] };
}

const assistant = (content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: `a-${Math.random()}`, role: "assistant", content, createdAt: 2, ...extra });
const user = (content: string): ChatMessage => ({ id: `u-${Math.random()}`, role: "user", content, createdAt: 1 });
function shown(messages: ChatMessage[]): { bubbles: string[]; text: string; unmount: () => void } {
  const { container, unmount } = render(<CFOMessageList messages={messages} onRetryFailed={() => {}} />);
  const bubbles = [...container.querySelectorAll('[data-role="assistant"]')].map((b) => b.textContent ?? "");
  return { bubbles, text: container.textContent ?? "", unmount };
}

const WORK = { turns: 0, rendered: 0, requests: 0 };

/** What the send pipeline logged (console.debug), silenced and kept. */
let debugLog: unknown[][] = [];
let debugSpy: MockInstance | null = null;

afterEach(() => { debugSpy?.mockRestore(); debugSpy = null; });
beforeEach(() => {
  debugLog = [];
  debugSpy = vi.spyOn(console, "debug").mockImplementation((...args: unknown[]) => { debugLog.push(args); });
  try {
    if (typeof localStorage.clear === "function") localStorage.clear();
    else for (const k of Object.keys(localStorage)) localStorage.removeItem?.(k);
  } catch { /* the module reset below is the real isolation */ }
  resetChatLiveState(null);
  clearAiDegraded();
  chatLlmMock.mockReset();
  guardSaw.length = 0;
});
afterAll(async () => {
  await i18n.changeLanguage("en");
  // eslint-disable-next-line no-console
  console.log(`GATE-WORK ai-figures-chat turns=${WORK.turns} rendered=${WORK.rendered} requests=${WORK.requests}`);
});

// ══ controls ══════════════════════════════════════════════════════════════

describe("POSITIVE CONTROL — the cases, the questions, the reference text", () => {
  it("the chat cases are a real share of the corpus, in both languages, and the first is the incident's sentence in shape", () => {
    expect(CHAT_CASES.length).toBeGreaterThanOrEqual(130);
    expect(CHAT_CASES.filter((c) => c.wrong).length).toBeGreaterThanOrEqual(80);
    expect(CHAT_CASES.filter((c) => c.lang === "en").length).toBeGreaterThanOrEqual(20);
    expect(CHAT_CASES.filter(held).length).toBeGreaterThanOrEqual(3);
    expect(CHAT_CASES[0].id).toBe("incident-shape");
    expect(CHAT_CASES[0].input).toContain("~EUR 12.3M (convertit din RON 64,567,890 la cursul BNR 0.1905)");
    for (const c of CHAT_CASES) {
      expect(c.input.trim(), c.id).toBe(c.input); // the pipeline trims a reply
      if (c.wrong) expect(findings(c.input, c.lang).length, c.id).toBeGreaterThan(0);
    }
    // The shapes the review of 2026-10-05 found no case for: a figure inside a
    // labelled link (an app path — the bubble renders it), a reply with no letter.
    expect(CHAT_CASES.filter((c) => /\]\(\//.test(c.input)).map((c) => c.id)).toEqual(["figure-in-a-link-label"]);
    expect(CHAT_CASES.filter((c) => !/\p{L}/u.test(c.input)).map((c) => c.id)).toEqual(["reply-that-is-one-percentage", "reply-that-is-one-handed-amount"]);
  });

  it("each question reads as its language; no reply of the corpus reads as the OTHER language (some read as none: the question decides)", () => {
    const own = (t: string) => displayModelText(`${t} 1.5%`).lang;
    expect([own(QUESTION.ro), own(QUESTION.en)]).toEqual(["ro", "en"]);
    let unread = 0;
    for (const c of CHAT_CASES) {
      const lang = displayModelText(c.input).lang;
      if (lang === null) unread += 1;
      else expect(lang, c.id).toBe(c.lang);
    }
    expect(unread).toBeGreaterThanOrEqual(10); // …so the context law below is exercised
  });

  it("mdText: a reply without markdown reads as itself; a marked one loses its marks only", () => {
    expect(CHAT_CASES.filter((c) => mdText(c.expected) === c.expected).length).toBeGreaterThanOrEqual(85);
    expect(mdText("## Sinteză\n- **Cifra:** 1,5%\n- Zile: 45\n\nUn rând\nal doilea `cod`")).toBe("SintezăCifra: 1,5%Zile: 45Un rând\nal doilea cod");
    expect(mdText("Vezi [EBITDA de 38,9 mil. RON](/dashboard?tab=pl) aici.")).toBe("Vezi EBITDA de 38,9 mil. RON aici.");
  });
});

// ══ 10 — a reply, from the transport to the bubble ════════════════════════

describe("10 a reply the model wrote in the wrong format is stored and shown in the reader's — whatever the UI language", () => {
  it.each(CHAT_CASES.map((c) => [c.id, c] as const))("%s", async (_id, c) => {
    // The interface is in the OTHER language than the conversation: it must decide nothing.
    await i18n.changeLanguage(other(c.lang));
    const snapshot = snapshotOf(c.anchors);
    expect(anchorsOfSnapshot(snapshot)).toEqual(c.anchors ?? []);
    const { conv, reply } = await answeredTurn(QUESTION[c.lang], c.input, snapshot);
    WORK.turns += 1;
    // ONE model request per turn — the pass asks nobody.
    expect(chatLlmMock).toHaveBeenCalledTimes(1);
    // STORED: the expected string, typed by hand; nothing foreign left but what the corpus names.
    expect(plainSpaces(reply.content)).toBe(c.expected);
    if (held(c)) expect(reply.content).toBe(c.input); // never half a text: byte for byte what the model wrote
    else expect(findings(reply.content, c.lang, c.kept, c.allowed)).toEqual([]);
    expect(reply.content.replace(/[^0-9]/g, "")).toBe(c.input.replace(/[^0-9]/g, ""));
    expect([reply.failed, reply.refused, reply.interrupted]).toEqual([undefined, undefined, undefined]);
    // SHOWN: the real list and bubble.
    const view = shown(conv.messages);
    WORK.rendered += 1;
    expect(view.bubbles).toHaveLength(1);
    expect(plainSpaces(view.bubbles[0])).toBe(mdText(c.expected));
    // …a code span's own text is not prose; everything else the reader sees is read by the detector.
    if (!c.input.includes("`") && !held(c)) expect(findings(view.bubbles[0], c.lang, c.kept, c.allowed)).toEqual([]);
    // STORED = SHOWN, byte for byte (joiners included): the bubble's pass changes nothing of a stored reply.
    expect(view.bubbles[0]).toBe(mdText(reply.content));
    // The reader's own turn is shown as typed.
    expect(view.text.startsWith(QUESTION[c.lang])).toBe(true);
    view.unmount();
  });

  it("the snapshot's figures reach the pass: a ratio the model was handed is proved a figure — and the briefing quoted in the snapshot hands nothing", async () => {
    const handed = CHAT_CASES.filter((c) => c.anchors && normaliseFigures(c.input, c.lang).text !== normaliseFigures(c.input, c.lang, c.anchors).text);
    expect(handed.length).toBeGreaterThanOrEqual(3); // …the cases above could not pass without the anchors
    const text = "Lichiditatea curentă este 1.42, iar scorul este 9.87 și 6.54.";
    const withFigure = await answeredTurn(QUESTION.ro, text, snapshotOf([1.42]));
    // 9,87 and 6,54 stand in the snapshot's "Prior engine-generated briefing" — prose, not a handed figure.
    expect(plainSpaces(withFigure.reply.content)).toBe("Lichiditatea curentă este 1,42, iar scorul este 9.87 și 6.54.");
    resetChatLiveState(null);
    const without = await answeredTurn(QUESTION.ro, text, snapshotOf(undefined));
    expect(without.reply.content).toBe(text);
  });

  it("a reply too short to tell its language takes the QUESTION's — never the interface's", async () => {
    const short = "EBITDA: 4.58M RON.";
    for (const ui of ["ro", "en"] as const) {
      await i18n.changeLanguage(ui);
      resetChatLiveState(null);
      expect(plainSpaces((await answeredTurn(QUESTION.ro, short)).reply.content), ui).toBe("EBITDA: 4,58 mil. RON.");
      resetChatLiveState(null);
      expect((await answeredTurn(QUESTION.en, short)).reply.content, ui).toBe(short);
      resetChatLiveState(null);
      // A question that does not read either: the reply is stored exactly as written.
      expect((await answeredTurn("EBITDA?", short)).reply.content, ui).toBe(short);
    }
  });

  it("what the pipeline logs about a reply is its language and COUNTS by reason — never a token, never a figure", async () => {
    const text = `${CORPUS[0].input} Lichiditatea curentă este 2.87, iar bugetul de EUR 1.5-2.5M.`;
    await answeredTurn(QUESTION.ro, text);
    let lines = debugLog.filter((a) => a[0] === "[figures] chat reply");
    expect(lines).toHaveLength(1);
    let payload = lines[0][1] as { lang: string; rewritten: number; left: Record<string, number> };
    expect(payload.lang).toBe("ro");
    expect(payload.rewritten).toBeGreaterThanOrEqual(3);
    expect(payload.left).toEqual({ bare_decimal: 1, open_amount: 1 });
    let logged = JSON.stringify(lines[0]);
    for (const token of text.match(/\d[\d.,]*\d/g) ?? []) expect(logged.includes(token), token).toBe(false);
    // A reply HELD whole (it holds a lone three-digit group) says so — by count.
    const c = CHAT_CASES.find((x) => x.id === "single-group-with-code-before")!;
    const heldText = `${CORPUS[0].input} ${c.input}`;
    debugLog = [];
    resetChatLiveState(null);
    expect((await answeredTurn(QUESTION.ro, heldText)).reply.content).toBe(heldText);
    lines = debugLog.filter((a) => a[0] === "[figures] chat reply");
    expect(lines).toHaveLength(1);
    payload = lines[0][1] as { lang: string; rewritten: number; left: Record<string, number> };
    expect([payload.rewritten, payload.left]).toEqual([0, { single_group: 1, text_held: 1 }]);
    logged = JSON.stringify(lines[0]);
    for (const token of heldText.match(/\d[\d.,]*\d/g) ?? []) expect(logged.includes(token), token).toBe(false);
    // A reply with nothing to format logs nothing.
    debugLog = [];
    resetChatLiveState(null);
    await answeredTurn(QUESTION.ro, "Da, firma este în creștere și este peste media sectorului.");
    expect(debugLog.filter((a) => a[0] === "[figures] chat reply")).toEqual([]);
  });

  it("a reply in a language the product defines no figure format for is stored and shown as the model wrote it — Spanish and Portuguese share words with Romanian, not its format", async () => {
    // (review 2026-10-05: read as Romanian, "12,3M EUR" became "12,3 mil. EUR" — twelve THOUSAND in Spanish)
    const replies = [
      ["¿Cuál es la situación de la empresa y cómo se compara con el año anterior?", "Este ejercicio la empresa registró ingresos de 12,3M EUR y un EBITDA de 2,1M EUR, lo que puede dar lugar a una mejora del margen."],
      ["Qual é a situação da empresa e como se compara com o ano anterior?", "Este exercício a empresa vai dar um resultado de 918K EUR, e este valor pode dar origem a 12,3M EUR de receitas."],
    ] as const;
    for (const ui of ["ro", "en"] as const) {
      await i18n.changeLanguage(ui);
      for (const [question, reply] of replies) {
        resetChatLiveState(null);
        const { conv, reply: stored } = await answeredTurn(question, reply);
        expect(stored.content, `${ui}: ${reply}`).toBe(reply);
        const view = shown(conv.messages);
        expect(view.bubbles[view.bubbles.length - 1]).toBe(reply);
        view.unmount();
        // POSITIVE CONTROL: read as Romanian, the pass WOULD have re-spelt its magnitudes.
        expect(normaliseFigures(reply, "ro").text).not.toBe(reply);
      }
    }
  });

  it("a correct Romanian reply written as labels with one English gloss keeps its right figures — it is not read as English", async () => {
    const reply = "- Cifra de afaceri: 64.567.890 RON\n- EBITDA: 7.654.321 RON\n- Marjă: 11,85%\n- Free cash flow from the operations: 2.345.678 RON";
    const { conv, reply: stored } = await answeredTurn(QUESTION.ro, reply);
    expect(stored.content).toBe(reply);
    const view = shown(conv.messages);
    expect(plainSpaces(view.bubbles[0])).toBe(mdText(reply));
    expect(findings(view.bubbles[0], "ro")).toEqual([]);
    view.unmount();
    // POSITIVE CONTROL: read as English, every figure of it WOULD be rewritten into English notation.
    expect(findings(normaliseFigures(reply, "en").text, "ro").length).toBeGreaterThanOrEqual(4);
  });

  it("an upstream failure and an empty answer take their own paths: nothing is formatted", async () => {
    chatLlmMock.mockResolvedValueOnce({ answer: "Couldn't reach Claude: 529 {\"type\":\"error\",\"request_id\":\"req_011CV4.58M\"}", model: null, usage: null });
    startChatTurn(turnCtx(QUESTION.ro));
    const failed = (await settled()).messages.at(-1)!;
    expect([failed.content, typeof failed.failed]).toEqual(["", "string"]);
    resetChatLiveState(null);
    clearAiDegraded();
    expect((await answeredTurn(QUESTION.ro, "   ")).reply.content).toBe("(no response)");
  });
});

// ══ 11 — what is already in the store ═════════════════════════════════════

/** A reply stored as the model wrote it — nothing was handed at render. */
const STORED_WRONG = CHAT_CASES.filter((c) => c.wrong && !c.anchors);

describe("11 a wrong-format reply ALREADY in the store is shown right — and only a model's reply is touched", () => {
  it.each(STORED_WRONG.map((c) => [c.id, c] as const))("%s", async (_id, c) => {
    await i18n.changeLanguage(other(c.lang));
    const view = shown([user(QUESTION[c.lang]), assistant(c.input)]);
    WORK.rendered += 1;
    expect(plainSpaces(view.bubbles[0])).toBe(mdText(c.expected));
    if (!c.input.includes("`") && !held(c)) expect(findings(view.bubbles[0], c.lang, c.kept, c.allowed)).toEqual([]);
    view.unmount();
  });

  it("the incident's reply, alone in a conversation (its own prose says Romanian), under either interface language", async () => {
    const c = CORPUS[0];
    for (const ui of ["ro", "en"] as const) {
      await i18n.changeLanguage(ui);
      const view = shown([assistant(c.input)]);
      expect(plainSpaces(view.bubbles[0])).toBe(c.expected);
      expect(view.bubbles[0]).toContain(`~12,3${NBSP}mil.${NBSP}EUR (convertit din 64.567.890${NBSP}RON la cursul BNR 0,1905)`);
      view.unmount();
    }
  });

  it("the reader's own turn, a refusal, a failed and an interrupted turn holding the SAME digits are not touched", async () => {
    await i18n.changeLanguage("ro");
    const wrong = CORPUS[0].input;
    const view = render(<CFOMessageList
      messages={[
        user(wrong),
        assistant(wrong, { refused: true }),
        assistant(wrong, { failed: "service" }),
        assistant(wrong, { interrupted: true }),
      ]}
      onRetryFailed={() => {}}
    />);
    expect(view.container.querySelector('[data-role="user"]')!.textContent).toBe(wrong);
    const rest = [...view.container.querySelectorAll('[data-role="assistant"]')];
    expect(rest).toHaveLength(3);
    expect(rest[0].textContent).toBe(wrong); // the refusal: the app's own sentence, as written
    // A failed turn is the calm panel, an interrupted one the marker: neither prints the content.
    expect(rest[1].getAttribute("data-testid")).toBe("chat-ai-degraded");
    expect(rest[2].getAttribute("data-testid")).toBe("chat-interrupted");
    for (const el of [rest[1], rest[2]]) expect(el.textContent).not.toMatch(/\d/);
    // POSITIVE CONTROL: the same content as an ordinary reply IS rewritten.
    view.unmount();
    const plain = shown([assistant(wrong)]);
    expect(plain.bubbles[0]).not.toBe(wrong);
    plain.unmount();
  });

  it("a short reply is shown in the language of the nearest earlier turn that reads — a refusal (the app's notice, in the UI language) gives none", async () => {
    await i18n.changeLanguage("ro");
    const short = "EBITDA: 4.58M RON.";
    const bubble = (messages: ChatMessage[]) => { const v = shown(messages); const last = v.bubbles[v.bubbles.length - 1]; v.unmount(); return plainSpaces(last); };
    expect(bubble([user(QUESTION.ro), assistant(short)])).toBe("EBITDA: 4,58 mil. RON.");
    expect(bubble([user(QUESTION.en), assistant(short)])).toBe(short);
    expect(bubble([assistant(short)])).toBe(short);
    expect(bubble([user("EBITDA?"), assistant(short)])).toBe(short);
    // nearest first: an English question after a Romanian exchange
    expect(bubble([user(QUESTION.ro), assistant("Da, este în creștere față de anul trecut și este peste medie."), user(QUESTION.en), assistant(short)])).toBe(short);
    // a Romanian refusal before it is nobody's prose
    expect(bubble([user("EBITDA?"), assistant("**Ai atins limita zilnică Ask CFO AI**\n\nPlanul tău include 25 mesaje pe zi, iar cele de azi au fost folosite.", { refused: true }), assistant(short)])).toBe(short);
    // POSITIVE CONTROL: the same sentence as an ordinary reply DOES give the hint.
    expect(bubble([user("EBITDA?"), assistant("Planul tău include 25 mesaje pe zi, iar cele de azi au fost folosite."), assistant(short)])).toBe("EBITDA: 4,58 mil. RON.");
  });

  it("a freshly arrived reply TYPES OUT in the reader's format: no frame ever shows the shape the model wrote", async () => {
    await i18n.changeLanguage("en");
    const c = CORPUS[0];
    const question = user(QUESTION.ro);
    const pending = assistant("", { id: "a-typing", pending: true });
    vi.useFakeTimers();
    try {
      const view = render(<CFOMessageList messages={[question, pending]} onRetryFailed={() => {}} />);
      view.rerender(<CFOMessageList messages={[question, { ...pending, content: c.input, pending: false }]} onRetryFailed={() => {}} />);
      const frames: string[] = [];
      for (let i = 0; i < 400; i++) {
        frames.push(view.container.querySelector('[data-role="assistant"]')?.textContent ?? "");
        act(() => { vi.advanceTimersByTime(16); });
      }
      const last = frames[frames.length - 1];
      expect(plainSpaces(last)).toBe(c.expected);
      // It really typed: many distinct frames, starting from nothing.
      expect(new Set(frames).size).toBeGreaterThan(20);
      expect(frames[0]).toBe("");
      for (const f of frames) {
        expect(last.startsWith(f), f).toBe(true);
        expect(f).not.toMatch(/EUR 1|RON 6|12\.3M|0\.19/);
      }
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ══ the joiners and find-in-conversation ══════════════════════════════════

describe("a figure the reader TYPES is found: the product's no-break joiners match plain spaces", () => {
  const stored = displayModelText(CORPUS[0].input).text;

  it("POSITIVE CONTROL: the shown reply holds U+00A0 joiners — a plain indexOf of what a reader types finds nothing", () => {
    expect(stored).toContain(`12,3${NBSP}mil.${NBSP}EUR`);
    expect(stored.includes("12,3 mil. EUR")).toBe(false);
    expect(searchFold(stored)).toContain("12,3 mil. eur");
    expect(searchFold(stored).length).toBe(stored.length); // one character for one: a match index is a text index
  });

  it("find-in-conversation counts the match, and the history filter keeps the conversation", async () => {
    await i18n.changeLanguage("en");
    // jsdom has no scrollIntoView; the hook brings the focused match into view with it.
    const proto = Element.prototype as { scrollIntoView?: unknown };
    const had = proto.scrollIntoView;
    proto.scrollIntoView = () => {};
    try {
      for (const [query, want] of [["12,3 mil. EUR", "1 of 1"], ["64.567.890 RON", "1 of 1"], ["12.3M", "No matches"]] as const) {
        const view = render(<CFOMessageList messages={[user(QUESTION.ro), assistant(CORPUS[0].input)]} searchQuery={query} onRetryFailed={() => {}} />);
        await waitFor(() => expect(view.getByTestId("chat-search-pill").textContent).toContain(want));
        view.unmount();
      }
    } finally {
      proto.scrollIntoView = had;
    }
    const conversation = { id: "c1", title: "Cifra de afaceri", createdAt: 1, updatedAt: 1, messages: [user(QUESTION.ro), assistant(stored)] };
    const store = { conversations: [conversation], currentId: null, select: () => {}, remove: () => {}, createNew: () => {}, rename: () => {} };
    for (const [query, rows] of [["12,3 mil. EUR", 1], ["cifra de AFACERI", 1], ["12.3M EUR", 0]] as const) {
      const view = render(<CFOHistorySidebar store={store as never} query={query} onQueryChange={() => {}} />);
      expect(view.container.textContent?.includes("Cifra de afaceri"), query).toBe(rows === 1);
      view.unmount();
    }
  });
});

// ══ 12 — what goes back to the model ══════════════════════════════════════

describe("12 the next request's history carries a reply as the reader saw it, and the reader's turns as typed", () => {
  type Sent = { role: string; content: string }[];

  it("a wrong-format reply stored before the release is sent in the reader's format; the reader's own figures are sent as typed", async () => {
    await i18n.changeLanguage("en");
    const c = CORPUS[0];
    // A conversation as an older bundle left it: the reply stored as the model wrote it.
    const typed = "Cât este EUR 12.3M în RON și de ce este marja 11.25%?";
    const seeded = chatAppendUserTurn(null, { content: typed });
    chatCompleteAssistantTurn(null, { conversationId: seeded.conversationId, assistantId: seeded.assistantId, content: c.input });
    expect(getChatConversation(null, seeded.conversationId)!.messages[1].content).toBe(c.input);

    const { reply } = await answeredTurn("Și marja?", "Marja EBITDA este 11.25%.");
    WORK.requests += 1;
    expect(chatLlmMock).toHaveBeenCalledTimes(1);
    const sent = (chatLlmMock.mock.calls[0] as unknown as [{ messages: Sent }])[0].messages;
    expect(sent.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(sent[0].content).toBe(typed);
    expect(plainSpaces(sent[1].content)).toBe(c.expected);
    expect(findings(sent[1].content, "ro")).toEqual([]);
    expect(sent[2].content).toBe("Și marja?");
    // …and the new short reply took the conversation's language.
    expect(reply.content).toBe("Marja EBITDA este 11,25%.");
  });

  it("the request itself is what it always was: the display currency, the FX context, the snapshot as built — the pass adds nothing to it", async () => {
    const snapshot = snapshotOf([1.42]);
    await answeredTurn(QUESTION.ro, "Lichiditatea este 1.42.", snapshot);
    WORK.requests += 1;
    const req = (chatLlmMock.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(Object.keys(req).sort()).toEqual(["company_name", "dataset_summary", "display_currency", "fx_context", "messages", "mode", "page", "public_company"]);
    expect(req.dataset_summary).toBe(snapshot);
    expect(req.display_currency).toBe("EUR");
    // Ask CFO AI's real request DOES carry the figure-format rule (the function builds it from the display currency).
    expect(buildSystemPrompt(req as never).split(FIGURE_FORMAT_SECTION).length - 1).toBe(1);
  });
});

// ══ 13 — the command bar is not a caller ══════════════════════════════════

describe("13 the command bar's guard reads the function's text exactly as it was returned", () => {
  const CTX = {
    periodId: FIXTURE_PERIODS[0].id,
    periodLabel: FIXTURE_PERIODS[0].label,
    periods: FIXTURE_PERIODS.map((p) => ({ id: p.id, label: p.label })),
  };
  const fixture = ANSWER_FIXTURES.find((f) => f.id === "assets")!;
  const run = (language: string) =>
    runAnswerTurn({
      turnId: "t1", question: fixture.question, history: [], plan: planRetrieval(fixture.question, CTX),
      toolTransport: fixtureToolTransport(), generate: edgeGenerationTransport(), language, companyName: "Fixture SRL",
    });

  it("a reply holding a digit, a percentage and a placeholder reaches the guard byte for byte — twice (the one regeneration) — and is rejected as it always was", async () => {
    await i18n.changeLanguage("ro");
    const first = "Activele totale sunt {{money:total_assets}}, în creștere cu 4.5% — adică ~EUR 12.3M pentru anul acesta.";
    const second = "Activele totale sunt {{money:total_assets}} și marja este 11.25% din RON 64,567,890.";
    chatLlmMock.mockResolvedValueOnce({ answer: first, model: null, usage: null }).mockResolvedValueOnce({ answer: second, model: null, usage: null });
    const turn = await run("ro");
    expect(chatLlmMock).toHaveBeenCalledTimes(2);
    expect(guardSaw).toEqual([first, second]);
    // POSITIVE CONTROL: the normaliser WOULD have changed both — had it stood before the guard, the guard would have read another text.
    for (const t of [first, second]) expect(displayModelText(t, { fallback: "ro" }).text).not.toBe(t);
    // The rejected text quoted back to the model is the one it wrote.
    const retry = (chatLlmMock.mock.calls[1] as unknown as [{ messages: { role: string; content: string }[] }])[0].messages;
    expect(retry[retry.length - 2]).toEqual({ role: "assistant", content: first });
    // Both rejected: the prose is discarded whole, the figures come from the interface.
    expect([turn.deterministic, turn.regenerated, turn.blocks.length]).toEqual([true, true, 0]);
    expect(turn.violations.length).toBeGreaterThan(0);
  });

  it("a clean answer passes the guard untouched and is rendered from its placeholders", async () => {
    chatLlmMock.mockResolvedValueOnce({ answer: fixture.answer, model: null, usage: null });
    const turn = await run("en");
    expect(guardSaw).toEqual([fixture.answer]);
    expect([turn.deterministic, turn.regenerated]).toEqual([false, false]);
    expect(turn.blocks.map((b) => b.template).join("\n")).toContain("{{money:total_assets}}");
  });

  it("its real request carries no display currency — so the prompt the function builds for it holds no figure-format rule and no digit example", async () => {
    chatLlmMock.mockResolvedValueOnce({ answer: fixture.answer, model: null, usage: null });
    await run("ro");
    const req = (chatLlmMock.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect("display_currency" in req || "fx_context" in req).toBe(false);
    const prompt = buildSystemPrompt(req as never);
    expect(prompt).not.toContain(FIGURE_FORMAT_SECTION);
    expect(prompt).not.toContain("Figure format");
    expect(prompt).not.toContain("Display-currency rule");
  });
});

// ══ the snapshot's headings ═══════════════════════════════════════════════

describe("the snapshot the chat really builds: its figures are handed, its prose sections are not", () => {
  type Period = Parameters<typeof buildWorkspaceSnapshot>[0];
  const pair = pairJson as unknown as { current_body: { statements: Record<string, unknown>; metrics: { name: string; value: number | null }[] } };
  const periodOf = (over: Record<string, unknown>): Period =>
    ({
      id: "0b6f2c1e-7a44-4d0c-9c1b-5e2f8a3d9b17", label: "Example Foods SRL", periodEnd: "2025-12-31", organizationId: null, industry: null,
      statements: pair.current_body.statements, lineItems: [], invoices: null, metrics: pair.current_body.metrics,
      recommendations: [], alerts: [], briefing: null, source: "upload",
      ...over,
    }) as unknown as Period;
  // Sentinels no served figure equals.
  const BRIEFING = "Lichiditatea este 98,765.43 și scorul 87,654.32 la închidere.";
  const RECS = [{ urgency: "high", title: "Reduce stock to 76,543.21 units" }];
  const ALERTS = [{ severity: "critical", title: "Cash ratio fell to 65,432.19" }];
  const SENTINELS = [98765.43, 87654.32, 76543.21, 65432.19];

  it("with every prose section present, and with each one alone: no sentinel is an anchor, and the served figures above are", () => {
    const base = anchorsOfSnapshot(buildWorkspaceSnapshot(periodOf({})));
    expect(base.length).toBeGreaterThan(10);
    for (const over of [
      { briefing: BRIEFING, recommendations: RECS, alerts: ALERTS },
      { briefing: BRIEFING },
      { recommendations: RECS },
      { alerts: ALERTS },
    ]) {
      const snapshot = buildWorkspaceSnapshot(periodOf(over))!;
      // POSITIVE CONTROL: the sentinel IS in the snapshot's text — under a heading the reader cuts at.
      expect(SENTINELS.some((s) => snapshot.includes(EN_US.format(s)))).toBe(true);
      const anchors = anchorsOfSnapshot(snapshot);
      for (const s of SENTINELS) expect(anchors, JSON.stringify(over)).not.toContain(s);
      expect(anchors).toEqual(base);
    }
  });
});
