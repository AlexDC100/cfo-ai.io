// THE CHAT FUNCTION'S REFUSALS, AS THE READER SEES THEM (C8).
//
// The Edge Function refuses three ways without calling the model — 401
// sign_in_required, 429 chat_cap_reached, 503 metering_unavailable — and
// sends an English sentence with each. Until 2026-10-03 the chat printed the
// server's sentence for the one refusal it knew (the cap): English on a
// Romanian screen, the plan named in the server's words.
//
// These laws drive the REAL send pipeline (chatTurns.startChatTurn) with the
// errors exactly as lib/cfoApi's callUrl builds them from the function's
// bodies, in both languages, and read the conversation the reader sees.
//
// WHAT THEY RED ON (TC-11): a refusal rendered from the server's `message`;
// a refusal in the wrong language; a refusal shown as the generic "CFO AI is
// unavailable" panel (or as a raw status); the cap's number missing; a "see
// plans" link that leaves the site; the cap no longer locking the composer;
// "sign in" or "could not check your plan" being written to chat history.
//
// WHAT THEY CANNOT SEE: the function's bodies themselves — the shapes here
// are held to guard.ts by chatLlmGuard.test.ts (same codes, same fields) and
// to the deployed wiring by scripts/check_chat_cap_real.py.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";

const insertMessage = vi.fn(async () => true);
vi.mock("../chatRemote", () => ({
  // An identity, so a turn that IS written to history reaches insertMessage.
  chatIdentity: async () => ({ userId: "0f0e0d0c-0000-4000-8000-00000000c4a7", orgId: null }),
  deleteMessages: async () => true,
  deleteThread: async () => true,
  fetchConversations: async () => null,
  importLocalConversations: async () => 0,
  insertMessage: (...a: unknown[]) => insertMessage(...(a as [])),
  insertThread: async () => true,
  updateThread: async () => true,
}));
vi.mock("@/lib/org", () => ({ useActiveOrg: () => ({ org: null, loading: false }) }));

const chatLlmMock = vi.fn();
vi.mock("@/lib/cfoApi", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/cfoApi")>();
  return { ...orig, cfoApi: { ...orig.cfoApi, chatLlm: chatLlmMock } };
});

const i18n = (await import("@/i18n")).default;
const { CfoApiError } = await import("@/lib/cfoApi");
const { startChatTurn, useChatCapBlocked } = await import("../chatTurns");
const { getChatConversation, resetChatLiveState, visibleConversations } = await import("../useChatStore");
const { getAiDegraded, clearAiDegraded } = await import("@/lib/aiDegraded");
const { chatRefusalCopy, chatRefusalMarkdown, chatRefusalOf } = await import("@/lib/chatRefusal");
const { CFOMessageList } = await import("../CFOMessageList");
const { FALLBACK_PAYLOAD } = await import("@/lib/rates");
const {
  handleChat,
} = await import("../../../../../supabase/functions/chat-llm/guard");
const { buildPlans } = await import("../../../../../supabase/functions/chat-llm/plans");

type Lang = "en" | "ro";

/** The error lib/cfoApi.callUrl throws for a non-2xx body: `detail` is the
 *  body's `detail`, the message is `detail.message` (the SERVER's sentence). */
function asCallUrlThrows(status: number, body: { detail?: unknown }) {
  const detail = body.detail as { message?: string } | string | undefined;
  const msg = typeof detail === "string" ? detail : detail?.message ?? `${status}`;
  return new CfoApiError(String(msg), status, detail);
}

/** The function's REAL body for each refusal — produced by guard.handleChat
 *  itself, so these laws cannot drift from what the function sends. */
async function functionRefusal(kind: "sign_in" | "metering" | "daily" | "monthly", language: Lang) {
  const base = {
    plans: buildPlans(() => undefined),
    modelConfigured: true,
    now: () => new Date("2026-10-03T09:00:00Z"),
    verifyUser: async () => ({ kind: "verified" as const, userId: "0f0e0d0c-0000-4000-8000-00000000c4a7" }),
    readPlan: async () => ({ tier: "pro" }),
    reserve: async (): Promise<unknown> => ({ kind: "allowed" }),
    commit: async () => ({}),
    release: async () => ({}),
    callModel: async () => { throw new Error("the model must not be called for a refusal"); },
  };
  const deps =
    kind === "metering" ? { ...base, reserve: async () => { throw new Error("RPC down"); } }
    : kind === "daily" ? { ...base, reserve: async () => ({ kind: "daily_cap_reached", daily_used: 25, monthly_used: 60 }) }
    : kind === "monthly" ? { ...base, reserve: async () => ({ kind: "monthly_cap_reached", daily_used: 2, monthly_used: 150 }) }
    : base;
  const reply = await handleChat(deps, {
    authorization: kind === "sign_in" ? null : "Bearer t",
    body: { messages: [{ role: "user", content: "q" }], language },
  });
  return { status: reply.status, body: reply.body as { error: string; detail: { code: string; message: string } } };
}

function turnCtx() {
  return {
    orgId: null, text: "What is our EBITDA?", attachments: [], periodId: null, periodLabel: null,
    groundedLabel: null, workspaceSnapshot: undefined, companyName: null,
    displayCurrency: "RON" as const, sourceCurrency: "RON" as const, rates: FALLBACK_PAYLOAD,
  };
}

async function refusedTurn(kind: "sign_in" | "metering" | "daily" | "monthly", lang: Lang) {
  await i18n.changeLanguage(lang);
  const sent = await functionRefusal(kind, lang);
  chatLlmMock.mockRejectedValueOnce(asCallUrlThrows(sent.status, sent.body));
  startChatTurn(turnCtx());
  const id = visibleConversations(null)[0].id;
  await waitFor(() => {
    const c = getChatConversation(null, id)!;
    expect(c.messages[c.messages.length - 1].pending).toBeFalsy();
  });
  const conv = getChatConversation(null, id)!;
  return { sent, conv, last: conv.messages[conv.messages.length - 1] };
}

function CapProbe() {
  const cap = useChatCapBlocked();
  return <output data-testid="cap">{cap ? JSON.stringify(cap) : "none"}</output>;
}

beforeEach(() => {
  try {
    if (typeof localStorage.clear === "function") localStorage.clear();
    else for (const k of Object.keys(localStorage)) localStorage.removeItem?.(k);
  } catch { /* the module reset below is the real isolation */ }
  resetChatLiveState(null);
  clearAiDegraded();
  chatLlmMock.mockReset();
  insertMessage.mockClear();
});
afterAll(async () => { await i18n.changeLanguage("en"); });

const WANT: Record<"sign_in" | "metering" | "daily" | "monthly", Record<Lang, { headline: string; body: string; link: string | null }>> = {
  sign_in: {
    en: { headline: "Sign in to keep using Ask CFO AI", body: "Your session has ended, so this question was not sent to the assistant. Sign in again and ask it once more.", link: "[Sign in →](/login?next=%2Fchat)" },
    ro: { headline: "Autentifică-te ca să folosești în continuare Ask CFO AI", body: "Sesiunea ta s-a încheiat, așa că întrebarea nu a fost trimisă asistentului. Autentifică-te din nou și pune-o încă o dată.", link: "[Autentifică-te →](/login?next=%2Fchat)" },
  },
  metering: {
    en: { headline: "Ask CFO AI could not check your plan's message allowance", body: "Your question was not sent to the assistant and nothing was counted against your plan. Try again in a moment.", link: null },
    ro: { headline: "Ask CFO AI nu a putut verifica mesajele incluse în planul tău", body: "Întrebarea nu a fost trimisă asistentului și nu s-a contorizat nimic din planul tău. Încearcă din nou în câteva momente.", link: null },
  },
  daily: {
    en: { headline: "Daily Ask CFO AI limit reached", body: "Your plan includes 25 Ask CFO AI messages a day, and today's have been used. The count starts again at midnight UTC.", link: "[See plans →](/pricing)" },
    ro: { headline: "Ai atins limita zilnică Ask CFO AI", body: "Planul tău include 25 mesaje Ask CFO AI pe zi, iar cele de azi au fost folosite. Contorul repornește la miezul nopții (UTC).", link: "[Vezi planurile →](/pricing)" },
  },
  monthly: {
    en: { headline: "Monthly Ask CFO AI limit reached", body: "Your plan includes 150 Ask CFO AI messages a month, and this month's have been used. The count starts again on the 1st of next month (UTC).", link: "[See plans →](/pricing)" },
    ro: { headline: "Ai atins limita lunară Ask CFO AI", body: "Planul tău include 150 mesaje Ask CFO AI pe lună, iar cele din luna aceasta au fost folosite. Contorul repornește pe 1 ale lunii următoare (UTC).", link: "[Vezi planurile →](/pricing)" },
  },
};

describe("POSITIVE CONTROL — the function's own refusal bodies carry a code AND a server sentence", () => {
  it.each(["sign_in", "metering", "daily", "monthly"] as const)("%s", async (kind) => {
    const { status, body } = await functionRefusal(kind, "en");
    expect([status, body.error, body.detail.code]).toEqual(
      kind === "sign_in" ? [401, "sign_in_required", "sign_in_required"]
      : kind === "metering" ? [503, "metering_unavailable", "metering_unavailable"]
      : [429, "chat_cap_reached", "chat_cap_reached"],
    );
    // The sentence the app must NOT print is really there to be printed.
    expect(body.detail.message.length).toBeGreaterThan(20);
    expect(asCallUrlThrows(status, body).message).toBe(body.detail.message);
  });
});

// FIRST among the turns: the cap lock is module state for the rest of the
// session, so "no lock yet" can only be observed before any cap is hit.
describe("what each refusal does besides its sentence", () => {
  it("the cap locks the composer with the same headline and body, in the reader's language; the others do not", async () => {
    const probe = render(<CapProbe />);
    expect(probe.getByTestId("cap").textContent).toBe("none");
    await refusedTurn("sign_in", "en");
    await refusedTurn("metering", "en");
    expect(probe.getByTestId("cap").textContent).toBe("none");
    await refusedTurn("monthly", "ro");
    await waitFor(() => expect(probe.getByTestId("cap").textContent).not.toBe("none"));
    expect(JSON.parse(probe.getByTestId("cap").textContent!)).toEqual({
      headline: WANT.monthly.ro.headline, body: WANT.monthly.ro.body, href: "/pricing",
    });
    probe.unmount();
  });

  it("'sign in' and 'could not check your plan' are shown but never written to chat history; the cap message is, as it always was", async () => {
    await refusedTurn("sign_in", "en");
    await refusedTurn("metering", "en");
    await new Promise((r) => setTimeout(r, 20));
    const assistantWrites = () => insertMessage.mock.calls.filter((c) => (c as unknown[])[1] && ((c as unknown[])[1] as { role?: string }).role === "assistant");
    expect(assistantWrites()).toHaveLength(0);
    await refusedTurn("daily", "en");
    await waitFor(() => expect(assistantWrites()).toHaveLength(1));
  });
});

describe.each(["en", "ro"] as const)("a refused turn reads as the app's own sentence, from the code — %s", (lang) => {
  it.each(["sign_in", "metering", "daily", "monthly"] as const)("%s", async (kind) => {
    const { sent, last } = await refusedTurn(kind, lang);
    const want = WANT[kind][lang];
    expect(last.content).toBe(`**${want.headline}**\n\n${want.body}${want.link ? `\n\n${want.link}` : ""}`);
    // Never the server's sentence — in either of its languages.
    expect(last.content).not.toContain(sent.body.detail.message);
    expect(last.content).not.toContain((await functionRefusal(kind, lang === "en" ? "ro" : "en")).body.detail.message);
    // Never the plan's server-side display name, a status, a code or a brace.
    for (const leak of ["Pro plan", "planului Pro", "401", "429", "503", "sign_in_required", "metering_unavailable", "chat_cap_reached", "{", "}"]) {
      expect(last.content, leak).not.toContain(leak);
    }
    // A refusal is not "CFO AI is unavailable": no degraded panel, no lock on the assistant.
    expect(last.failed).toBeUndefined();
    expect(getAiDegraded()).toBeNull();
  });

  it("the rendered conversation shows the sentence, with a link that stays on the site", async () => {
    for (const kind of ["sign_in", "daily"] as const) {
      const { last } = await refusedTurn(kind, lang);
      // (the refused turn alone: the conversation also holds the earlier ones)
      const { container, unmount } = render(<CFOMessageList messages={[last]} onRetryFailed={() => {}} />);
      expect(container.textContent).toContain(WANT[kind][lang].headline);
      expect(container.textContent).toContain(WANT[kind][lang].body);
      expect(container.querySelector('[data-testid="chat-ai-degraded"]')).toBeNull();
      const links = [...container.querySelectorAll("a")].map((a) => [a.getAttribute("href"), a.textContent, a.getAttribute("target")]);
      expect(links).toEqual(kind === "sign_in"
        ? [["/login?next=%2Fchat", lang === "ro" ? "Autentifică-te →" : "Sign in →", null]]
        : [["/pricing", lang === "ro" ? "Vezi planurile →" : "See plans →", null]]);
      // …a link, not the brackets it is written with.
      expect(container.textContent).not.toContain("](");
      unmount();
    }
  });
});

describe("the bubble's labelled link is for pages of THIS app only", () => {
  const bubble = (content: string) =>
    render(<CFOMessageList messages={[{ id: "m1", role: "assistant", content, createdAt: 1 }]} onRetryFailed={() => {}} />);

  it("a labelled link to another host keeps its URL in view — a model's answer cannot hide where a link goes", () => {
    for (const md of ["[Sign in](https://evil.example/login)", "[Sign in](//evil.example/login)", "[x](javascript:alert(1))"]) {
      const { container, unmount } = bubble(`Read this: ${md}`);
      const labelled = [...container.querySelectorAll("a")].filter((a) => a.textContent === "Sign in" || a.textContent === "x");
      expect(labelled, md).toHaveLength(0);
      for (const a of container.querySelectorAll("a")) expect(a.textContent).toBe(a.getAttribute("href"));
      unmount();
    }
  });

  it("a labelled same-site path is a link with its label", () => {
    const { container, unmount } = bubble("Open [the dashboard](/dashboard?tab=pl) now.");
    expect([...container.querySelectorAll("a")].map((a) => [a.getAttribute("href"), a.textContent])).toEqual([["/dashboard?tab=pl", "the dashboard"]]);
    expect(container.textContent).toContain("Open the dashboard now.");
    unmount();
  });
});

describe("chatRefusalOf — which errors are refusals", () => {
  const err = (status: number, detail: unknown) => new CfoApiError("server words", status, detail);

  it("reads the code, the period and the cap; nothing else is a refusal", () => {
    expect(chatRefusalOf(err(401, { code: "sign_in_required", message: "x" }))).toEqual({ code: "sign_in_required" });
    expect(chatRefusalOf(err(401, "401 Unauthorized"))).toEqual({ code: "sign_in_required" }); // a 401 with no body it can read
    expect(chatRefusalOf(err(503, { code: "metering_unavailable" }))).toEqual({ code: "metering_unavailable" });
    expect(chatRefusalOf(err(429, { code: "chat_cap_reached", kind: "daily_cap_reached", daily_cap: 3, monthly_cap: 5 })))
      .toEqual({ code: "chat_cap_reached", period: "daily", cap: 3, href: "/pricing" });
    expect(chatRefusalOf(err(429, { code: "chat_cap_reached", kind: "monthly_cap_reached", daily_cap: 3, monthly_cap: 5, upgrade_url: "/pricing?from=chat" })))
      .toEqual({ code: "chat_cap_reached", period: "monthly", cap: 5, href: "/pricing?from=chat" });
    for (const notOne of [
      err(503, { code: "auth_unavailable" }), err(503, { code: "ai_not_configured" }), err(503, "503 Service Unavailable"), err(429, { code: "rate_limited" }),
      err(429, "429"), err(500, { code: "chat_cap_reached" }), err(400, { error: "invalid_request" }), new TypeError("Failed to fetch"), null, "x",
    ]) expect(chatRefusalOf(notOne)).toBeNull();
  });

  it("a cap with no readable number falls back to the general sentence — never 'undefined', never the server's", () => {
    const r = chatRefusalOf(err(429, { code: "chat_cap_reached", kind: "daily_cap_reached", daily_cap: "3", message: "Daily Ask CFO AI limit reached for the Pro plan" }))!;
    expect(r).toMatchObject({ code: "chat_cap_reached", cap: null });
    const md = chatRefusalMarkdown(chatRefusalCopy(r, "en"));
    expect(md).toBe("**Daily Ask CFO AI limit reached**\n\nYou've hit your plan's chat cap. It resets automatically — or upgrade for more headroom.\n\n[See plans →](/pricing)");
    expect(md).not.toMatch(/undefined|null|NaN|Pro plan/);
  });

  it("'See plans' never leaves the site, whatever the server put in upgrade_url", () => {
    for (const hostile of ["https://evil.example/pricing", "//evil.example", "javascript:alert(1)", "/\\evil", "pricing", 7, null, "/a b", "/x\"><script>"]) {
      const r = chatRefusalOf(err(429, { code: "chat_cap_reached", kind: "daily_cap_reached", daily_cap: 3, upgrade_url: hostile }));
      expect(r, String(hostile)).toMatchObject({ href: "/pricing" });
    }
  });

  it("the copy can be asked for in a named language, whatever the UI is in", async () => {
    await i18n.changeLanguage("en");
    expect(chatRefusalCopy({ code: "metering_unavailable" }, "ro").headline).toBe(WANT.metering.ro.headline);
    expect(chatRefusalCopy({ code: "metering_unavailable" }).headline).toBe(WANT.metering.en.headline);
  });
});
