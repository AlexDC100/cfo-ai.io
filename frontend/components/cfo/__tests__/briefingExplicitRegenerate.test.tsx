// GATE briefing-explicit-regenerate: THE BRIEFING CARD MAKES NO MODEL CALL
// UNLESS THE READER PRESSES THE BUTTON.
//
// Owner ruling 2026-10-02: "a failed regenerate must NEVER overwrite a stored
// briefing with [NARRATIVE_UNAVAILABLE] — keep the last good one, mark it
// stale. The frontend must not auto-fire regenerate on a language mismatch:
// explicit, metered 'regenerează în română' action instead."
//
// The card used to POST /briefing/regenerate from an effect, 600 ms after
// mount, whenever the UI language differed from the briefing's or the display
// currency was not RON. No test drove it (no vitest rendered a mismatch, no
// Playwright spec intercepted the route), so a page load by a Romanian reader
// re-narrated — and, with the provider out of credit, destroyed — an English
// briefing with no click.
//
// The real component is rendered; `fetch` is the one channel a request can
// leave by, and it is counted. Expected strings are STATED here in English
// and Romanian.
//
// Fails on: any request on mount, on a language mismatch, on a language
// switch or on a currency toggle (the planted auto-fire); more or fewer than
// one request per click; a body that is not the D9 body, a query string, the
// ambient company in X-Org-Id; a failed regeneration replacing the prose or
// printing a failure text, a status code or the server's words; a cap refusal
// without its counts or its /pricing link; "verified" over a kept or an
// unavailable briefing; a failure text getting through `briefingVisibility`;
// a second reader of the served body.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ currency: "RON" as string }));

// The currency store is context-backed; the card reads one hook from it.
vi.mock("@/stores/currency", () => ({
  useDisplayCurrency: () => env.currency,
}));

// A signed-in session, and an AMBIENT company that is not the period's — the
// header must carry the period's.
vi.mock("@/lib/supabase", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/supabase")>()),
  getSupabase: () => ({
    auth: {
      getSession: async () => ({
        data: { session: { access_token: "jwt-of-the-reader", user: { id: "reader-1" } } },
      }),
    },
  }),
  currentOrgId: async () => "AMBIENT-COMPANY",
}));

import i18n from "@/i18n";
import { CFOBriefingCard } from "@/components/cfo/CFOBriefingCard";
import { BRIEFING_UNAVAILABLE_NOTE, briefingVisibility, isUnusableNarrative } from "@/lib/briefingDefinition";
import { queryClient } from "@/lib/queryClient";
import instrumentStrings from "@/components/cfo/dashInstrumentStrings.json";

const PERIOD = "11111111-2222-4333-8444-555555555555";
const PERIOD_COMPANY = "99999999-8888-4777-8666-555555555555";
const ENGLISH = "Revenue grew and the margin held; liquidity is thin against short-term debt.";
const ROMANIAN = "Veniturile au crescut, iar marja s-a menținut; lichiditatea este redusă față de datoriile pe termen scurt.";

const FAILURE_TEXTS = [
  "[NARRATIVE_UNAVAILABLE]",
  "Narrative unavailable.",
  "Narrative unavailable: Error code: 400 - {'type': 'error', 'error': {'type': 'invalid_request_error', 'message': 'Your credit balance is too low to access the Anthropic API.'}}",
  "Set ANTHROPIC_API_KEY on the backend to enable AI narrative.",
  "anthropic SDK not installed on backend.",
  "The briefing was withheld: the model cited figures that are not in the analysis.",
  "",
  "   ",
];

// ── the one channel a request can leave by ──────────────────────────────
type Answer = { status: number; body: unknown };
let answer: Answer = { status: 200, body: {} };
const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
  ok: answer.status >= 200 && answer.status < 300,
  status: answer.status,
  statusText: answer.status === 429 ? "Too Many Requests" : "",
  json: async () => answer.body,
}));
const regenerateCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes("/briefing/regenerate"));

let invalidate: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  env.currency = "RON";
  answer = { status: 200, body: {} };
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  invalidate = vi.spyOn(queryClient, "invalidateQueries").mockImplementation(async () => {});
});

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  invalidate.mockRestore();
  await i18n.changeLanguage("en");
});

type CardProps = Partial<Parameters<typeof CFOBriefingCard>[0]>;
const card = (props: CardProps = {}) => (
  <MemoryRouter>
    <CFOBriefingCard
      periodId={PERIOD}
      baseBriefing={ENGLISH}
      baseLanguage="en"
      orgId={PERIOD_COMPANY}
      collapsed
      onToggle={() => {}}
      {...props}
    />
  </MemoryRouter>
);

/** Let everything a mount could have scheduled run: the old effect waited
 *  600 ms and then awaited a session before it fetched. */
async function settle() {
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
}

/** Real timers: long enough for a request fired on mount to have left. */
const quiet = () => act(async () => { await new Promise((r) => setTimeout(r, 40)); });

const header = () => screen.getByTestId("briefing-header").textContent ?? "";
const button = () => screen.getByTestId("briefing-regenerate");

describe("no automatic model call", () => {
  it("on mount: no request, and no action offered when language and currency already match", async () => {
    vi.useFakeTimers();
    render(card());
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("briefing-regenerate")).toBeNull();
    expect(screen.getByTestId("cfo-briefing-body").textContent).toBe(ENGLISH);
    expect(header()).toMatch(/verified/i);
  });

  it("on a language mismatch (a Romanian reader, an English briefing): no request — one button, 'Regenerează în română', visible while collapsed", async () => {
    await i18n.changeLanguage("ro");
    vi.useFakeTimers();
    render(card());
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(button().textContent).toBe("Regenerează în română");
    expect(screen.getByTestId("briefing-regenerate-cost").textContent).toBe("Folosește un mesaj Ask CFO AI.");
    // collapsed: the About disclosure is not rendered, the button is
    expect(screen.queryByTestId("briefing-about-analysis")).toBeNull();
    expect(screen.getAllByTestId("briefing-regenerate")).toHaveLength(1);
    // the English prose stays on screen until the reader asks
    expect(screen.getByTestId("cfo-briefing-body").textContent).toBe(ENGLISH);
  });

  it("on a language mismatch (an English reader, a Romanian briefing): no request — 'Regenerate in English'", async () => {
    vi.useFakeTimers();
    render(card({ baseBriefing: ROMANIAN, baseLanguage: "en" })); // every old row is stamped 'en'
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(button().textContent).toBe("Regenerate in English");
    expect(screen.getByTestId("briefing-regenerate-cost").textContent).toBe("Uses one Ask CFO AI message.");
  });

  it("the briefing's language is the served stamp when it says 'ro', else the diacritics probe", async () => {
    vi.useFakeTimers();
    // stamped 'ro', no diacritic in the body: Romanian — an English reader is offered the action
    const { unmount } = render(card({ baseBriefing: "Marja a crescut cu 2 pp.", baseLanguage: "ro" }));
    expect(button().textContent).toBe("Regenerate in English");
    unmount();
    // stamped 'ro' and read in Romanian: nothing to offer
    await i18n.changeLanguage("ro");
    render(card({ baseBriefing: ROMANIAN, baseLanguage: "ro" }));
    expect(screen.queryByTestId("briefing-regenerate")).toBeNull();
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("on a language switch while mounted: no request", async () => {
    vi.useFakeTimers();
    render(card());
    await settle();
    await act(async () => { await i18n.changeLanguage("ro"); });
    await settle();
    await act(async () => { await i18n.changeLanguage("en"); });
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("on a currency toggle: no request — 'Regenerate in EUR', and the eyebrow does not claim the prose is in EUR", async () => {
    vi.useFakeTimers();
    const view = render(card());
    await settle();
    for (const currency of ["EUR", "USD", "RON", "EUR"]) {
      env.currency = currency;
      view.rerender(card());
      await settle();
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(button().textContent).toBe("Regenerate in EUR");
    expect(header()).not.toMatch(/EUR/);
    await act(async () => { await i18n.changeLanguage("ro"); });
    // both differ: the one button narrates into the reader's language
    expect(screen.getAllByTestId("briefing-regenerate")).toHaveLength(1);
    expect(button().textContent).toBe("Regenerează în română");
    await act(async () => { await i18n.changeLanguage("en"); });
    env.currency = "RON";
    view.rerender(card());
    expect(screen.queryByTestId("briefing-regenerate")).toBeNull();
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an unavailable briefing: no request — the note, 'Generate the briefing', never 'verified'", async () => {
    vi.useFakeTimers();
    const view = render(card({ baseBriefing: null, unavailable: true }));
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("cfo-briefing-unavailable").textContent).toBe(
      "The AI briefing is unavailable for this period — the analysis figures are unaffected.",
    );
    expect(button().textContent).toBe("Generate the briefing");
    expect(header()).not.toMatch(/verified/i);
    expect(header()).toMatch(/unavailable/i);
    await act(async () => { await i18n.changeLanguage("ro"); });
    view.rerender(card({ baseBriefing: null, unavailable: true }));
    expect(screen.getByTestId("cfo-briefing-unavailable").textContent).toBe(
      "Briefingul AI nu este disponibil pentru această perioadă — cifrele analizei nu sunt afectate.",
    );
    expect(button().textContent).toBe("Generează briefingul");
    expect(header()).not.toMatch(/verificat/i);
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a stored failure text handed to the card is never prose and triggers nothing", async () => {
    vi.useFakeTimers();
    for (const text of FAILURE_TEXTS) {
      const view = render(card({ baseBriefing: text }));
      await settle();
      expect(screen.queryByTestId("cfo-briefing-body"), JSON.stringify(text)).toBeNull();
      expect(screen.getByTestId("cfo-briefing").textContent, JSON.stringify(text)).not.toMatch(
        /NARRATIVE_UNAVAILABLE|Narrative unavailable|ANTHROPIC|credit balance|withheld/,
      );
      view.unmount();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the card's source holds no effect-driven request: no fetch, no lazy import, one call site — the click handler", () => {
    const src = readFileSync(resolve(__dirname, "../CFOBriefingCard.tsx"), "utf8");
    const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(code).not.toMatch(/\bfetch\(/);
    expect(code).not.toMatch(/\bimport\(/);
    expect(code).not.toMatch(/setTimeout/);
    expect(code.match(/cfoApi\.regenerateBriefing\(/g)).toHaveLength(1);
    expect(code.match(/regenerate\(\)/g)).toHaveLength(2); // its definition, and the button's onClick
    expect(code).toMatch(/onClick=\{\(\) => void regenerate\(\)\}/);
    // no effect depends on the language or the currency
    for (const deps of code.matchAll(/useEffect\([\s\S]*?\}, \[([^\]]*)\]\);/g)) {
      expect(deps[1]).not.toMatch(/display|activeLang|langMismatch|currency/);
    }
  });
});

describe("exactly one request per click, with the D9 body", () => {
  it("a click sends ONE POST: no query string, the explicit-intent body, the period's company — and that body is the fixture the engine test posts", async () => {
    await i18n.changeLanguage("ro");
    answer = {
      status: 200,
      body: { ok: true, regenerated: true, persisted: true, briefing: ROMANIAN, briefing_length: ROMANIAN.length, language: "ro", currency: "RON", stale: false },
    };
    render(card());
    // nothing left on mount — the one request below is the click's
    await quiet();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(button());
    fireEvent.click(button()); // a double click while in flight is one request
    await waitFor(() => expect(screen.getByTestId("cfo-briefing-body").textContent).toBe(ROMANIAN));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(regenerateCalls()).toHaveLength(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://api.test.invalid/api/period/${PERIOD}/briefing/regenerate`);
    expect(String(url)).not.toContain("?");
    expect(init?.method).toBe("POST");
    const sent = String(init?.body);
    expect(sent).toBe('{"intent":"user","language":"ro","currency":"RON"}');
    expect(JSON.parse(sent)).toEqual({ intent: "user", language: "ro", currency: "RON" });
    const headers = init?.headers as Record<string, string>;
    expect(headers["X-Org-Id"]).toBe(PERIOD_COMPANY);
    expect(headers["X-Org-Id"]).not.toBe("AMBIENT-COMPANY");
    expect(headers.Authorization).toBe("Bearer jwt-of-the-reader");
    expect(headers["Content-Type"]).toBe("application/json");

    // D11 (CLAUDE.md §22 — an intercepted route is a route with no gate):
    // the EXACT bytes this card sent, for the engine test that posts them to
    // the real route on the real app.
    const fixture = resolve(__dirname, "../../../../tests/engine/fixtures/hotfix2/regenerate_request_body.json");
    if (!existsSync(fixture) || readFileSync(fixture, "utf8") !== sent) {
      mkdirSync(dirname(fixture), { recursive: true });
      writeFileSync(fixture, sent, "utf8");
    }
    expect(readFileSync(fixture, "utf8")).toBe(sent);

    // the persisted narration replaced the stored row: every reader of the
    // period re-reads it
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["period", PERIOD] });
    // nothing left to offer: the prose is in the reader's language
    expect(screen.queryByTestId("briefing-regenerate")).toBeNull();
    expect(screen.queryByTestId("briefing-regenerate-notice")).toBeNull();
    expect(header()).toMatch(/verificat/i);
  });

  it("the currency action narrates for the session: one request, the display currency in the body, nothing invalidated", async () => {
    env.currency = "EUR";
    const inEur = "Revenue was 83.2M EUR; the margin held.";
    answer = { status: 200, body: { ok: true, regenerated: true, persisted: false, briefing: inEur, language: "en", currency: "EUR", stale: false } };
    const view = render(card());
    expect(button().textContent).toBe("Regenerate in EUR");
    await quiet();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(button());
    await waitFor(() => expect(screen.getByTestId("cfo-briefing-body").textContent).toBe(inEur));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][1]?.body)).toBe('{"intent":"user","language":"en","currency":"EUR"}');
    expect(invalidate).not.toHaveBeenCalled();
    expect(header()).toMatch(/displayed in EUR/);
    expect(screen.queryByTestId("briefing-regenerate")).toBeNull();
    // back to RON: the stored prose, no request
    env.currency = "RON";
    view.rerender(card());
    expect(screen.getByTestId("cfo-briefing-body").textContent).toBe(ENGLISH);
    expect(header()).not.toMatch(/EUR/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("'Generate the briefing' sends the same body and shows the narration", async () => {
    answer = { status: 200, body: { ok: true, regenerated: true, persisted: true, briefing: ENGLISH, language: "en", currency: "RON", stale: false } };
    render(card({ baseBriefing: null, unavailable: true }));
    fireEvent.click(button());
    await waitFor(() => expect(screen.getByTestId("cfo-briefing-body").textContent).toBe(ENGLISH));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][1]?.body)).toBe('{"intent":"user","language":"en","currency":"RON"}');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["period", PERIOD] });
    expect(screen.queryByTestId("cfo-briefing-unavailable")).toBeNull();
  });

  // Review 2026-10-03: every action sent the DISPLAY currency. With the display
  // currency EUR, "Generate the briefing" and the language action were narrated
  // converted — metered, returned for the session, never stored: after a reload
  // the period was unavailable (or in the other language) again. An action that
  // creates or replaces the STORED briefing asks for RON.
  it("with the display currency EUR, 'Generate the briefing' asks for RON — the narration is stored", async () => {
    env.currency = "EUR";
    answer = { status: 200, body: { ok: true, regenerated: true, persisted: true, briefing: ENGLISH, language: "en", currency: "RON", stale: false } };
    render(card({ baseBriefing: null, unavailable: true }));
    expect(button().textContent).toBe("Generate the briefing");
    fireEvent.click(button());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0][1]?.body)).toBe('{"intent":"user","language":"en","currency":"RON"}');
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["period", PERIOD] }));
  });

  it("with the display currency EUR, the language action asks for RON too — and the currency action still asks for EUR", async () => {
    await i18n.changeLanguage("ro");
    env.currency = "EUR";
    answer = { status: 200, body: { ok: true, regenerated: true, persisted: true, briefing: ROMANIAN, language: "ro", currency: "RON", stale: false } };
    const view = render(card()); // an English stored briefing, a Romanian reader, EUR on display
    expect(button().textContent).toBe("Regenerează în română"); // the language comes first
    fireEvent.click(button());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0][1]?.body)).toBe('{"intent":"user","language":"ro","currency":"RON"}');
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["period", PERIOD] }));
    // the period query hands the card the stored Romanian briefing: the
    // currency action is offered next, and IT asks for the display currency
    view.rerender(card({ baseBriefing: ROMANIAN, baseLanguage: "ro" }));
    await waitFor(() => expect(button().textContent).toBe("Regenerează în EUR"));
    answer = { status: 200, body: { ok: true, regenerated: true, persisted: false, briefing: ROMANIAN, language: "ro", currency: "EUR", stale: false } };
    fireEvent.click(button());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1][1]?.body)).toBe('{"intent":"user","language":"ro","currency":"EUR"}');
  });

  // Review 2026-10-04: the two actions above ask for RON, and the card showed a
  // session narration only when its currency WAS the display currency. With EUR
  // on display the paid, stored answer never appeared: the card stayed as it was
  // before the click, the same paid button enabled, until the period query
  // re-read (for the whole session when that re-read failed). NO rerender here —
  // the period query has not answered yet.
  it("with the display currency EUR, a stored 'Generate the briefing' is SHOWN at once — and the next action is the currency one, not the same paid click", async () => {
    env.currency = "EUR";
    answer = { status: 200, body: { ok: true, regenerated: true, persisted: true, briefing: ENGLISH, language: "en", currency: "RON", stale: false } };
    render(card({ baseBriefing: null, unavailable: true }));
    fireEvent.click(button());
    await waitFor(() => expect(screen.getByTestId("cfo-briefing-body").textContent).toBe(ENGLISH));
    expect(screen.queryByTestId("cfo-briefing-unavailable")).toBeNull();
    expect(header()).not.toMatch(/displayed in EUR/);
    expect(button().textContent).toBe("Regenerate in EUR");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // the next click is a DIFFERENT request: the conversion, for the session
    answer = { status: 200, body: { ok: true, regenerated: true, persisted: false, briefing: "Revenue was 83.2M EUR.", language: "en", currency: "EUR", stale: false } };
    fireEvent.click(button());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1][1]?.body)).toBe('{"intent":"user","language":"en","currency":"EUR"}');
    await waitFor(() => expect(screen.getByTestId("cfo-briefing-body").textContent).toBe("Revenue was 83.2M EUR."));
    expect(screen.queryByTestId("briefing-regenerate")).toBeNull();
  });

  it("with the display currency EUR, a stored language regeneration is SHOWN at once — the language action is not offered again", async () => {
    await i18n.changeLanguage("ro");
    env.currency = "EUR";
    answer = { status: 200, body: { ok: true, regenerated: true, persisted: true, briefing: ROMANIAN, language: "ro", currency: "RON", stale: false } };
    render(card()); // an English stored briefing, a Romanian reader, EUR on display
    expect(button().textContent).toBe("Regenerează în română");
    fireEvent.click(button());
    await waitFor(() => expect(screen.getByTestId("cfo-briefing-body").textContent).toBe(ROMANIAN));
    expect(button().textContent).toBe("Regenerează în EUR");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("a failed regeneration keeps the briefing", () => {
  const KEPT = {
    en: "Couldn't regenerate — the previous briefing was kept.",
    ro: "Regenerarea nu a reușit — briefingul anterior a fost păstrat.",
  };

  it.each([
    ["the engine's answer", { ok: false, regenerated: false, reason: "provider_error", stale: true, briefing: ENGLISH, briefing_length: ENGLISH.length }],
    ["an engine that predates the ruling (ok:true over the sentinel)", { ok: true, briefing: "[NARRATIVE_UNAVAILABLE]", briefing_length: 23, currency: "RON" }],
    // An engine that predates the truthful `stale` (2026-10-03) answers the
    // inert shape with no `stale` at all: the cautious reading stands.
    ["the inert legacy answer of an engine that says nothing about stale", { ok: true, regenerated: false, legacy: true, briefing: ENGLISH, briefing_length: ENGLISH.length, currency: "RON" }],
    ["the inert legacy answer over a stored briefing the engine reports stale", { ok: true, regenerated: false, legacy: true, briefing: ENGLISH, briefing_length: ENGLISH.length, currency: "RON", stale: true }],
  ])("ok:false — %s: the prose stays, one sentence says so, the eyebrow stops saying 'verified'", async (_name, body) => {
    await i18n.changeLanguage("ro");
    answer = { status: 200, body };
    render(card());
    fireEvent.click(button());
    await waitFor(() => expect(screen.getByTestId("briefing-regenerate-notice").textContent).toBe(KEPT.ro));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("cfo-briefing-body").textContent).toBe(ENGLISH);
    expect(screen.getByTestId("cfo-briefing").textContent).not.toMatch(/NARRATIVE_UNAVAILABLE|provider_error/);
    expect(header()).not.toMatch(/verificat/i);
    expect(header()).toMatch(/versiunea anterioară păstrată/i);
    expect(screen.getByTestId("cfo-briefing").getAttribute("data-briefing-state")).toBe("stale");
    expect(invalidate).not.toHaveBeenCalled();
    // the reader can ask again
    expect(button().textContent).toBe("Regenerează în română");
    await act(async () => { await i18n.changeLanguage("en"); });
    expect(screen.getByTestId("briefing-regenerate-notice").textContent).toBe(KEPT.en);
  });

  // OWNER RULING 2026-10-03: "Never report a state that isn't stored." The
  // engine's `stale` is what the stored row holds. A failure that marked
  // NOTHING — a failed currency conversion (a converted briefing is never
  // stored), a marker the database refused, the inert legacy answer over a
  // current row — answers `stale: false`: the prose on screen is still the
  // current briefing, and the card must not present it as a kept, stale one
  // just because a request failed.
  it.each([
    ["a failed conversion, nothing marked", { ok: false, regenerated: false, reason: "provider_error", stale: false, briefing: ENGLISH, briefing_length: ENGLISH.length, currency: "EUR" }],
    ["a failure whose marker was not stored", { ok: false, regenerated: false, reason: "no_api_key", stale: false, briefing: ENGLISH, briefing_length: ENGLISH.length, currency: "RON" }],
    ["the inert legacy answer over a current row", { ok: true, regenerated: false, legacy: true, briefing: ENGLISH, briefing_length: ENGLISH.length, currency: "RON", stale: false }],
  ])("stale:false — %s: the sentence is shown, and the briefing is still presented as the current one", async (_name, body) => {
    env.currency = "EUR";
    answer = { status: 200, body };
    render(card());
    expect(header()).toMatch(/verified/i);
    fireEvent.click(button());
    await waitFor(() => expect(screen.getByTestId("briefing-regenerate-notice").textContent).toBe(KEPT.en));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("cfo-briefing-body").textContent).toBe(ENGLISH);
    expect(screen.getByTestId("cfo-briefing").getAttribute("data-briefing-state")).toBe("current");
    expect(header()).toMatch(/verified/i);
    expect(header()).not.toMatch(/previous version kept/i);
    expect(screen.getByTestId("cfo-briefing").textContent).not.toMatch(/provider_error|no_api_key/);
    expect(invalidate).not.toHaveBeenCalled();
    // the reader can ask again
    expect(button().textContent).toBe("Regenerate in EUR");
  });

  it("the same failure with stale:true IS presented as kept — the difference above is the engine's word, not the failure", async () => {
    env.currency = "EUR";
    answer = { status: 200, body: { ok: false, regenerated: false, reason: "provider_error", stale: true, briefing: ENGLISH, briefing_length: ENGLISH.length, currency: "EUR" } };
    render(card());
    fireEvent.click(button());
    await waitFor(() => expect(screen.getByTestId("briefing-regenerate-notice").textContent).toBe(KEPT.en));
    expect(screen.getByTestId("cfo-briefing").getAttribute("data-briefing-state")).toBe("stale");
    expect(header()).not.toMatch(/verified/i);
    expect(header()).toMatch(/previous version kept/i);
  });

  // The route refuses what it cannot serve BEFORE the meter (422
  // unsupported_language / unsupported_currency, 503 fx_unavailable) and
  // answers a dead meter 503 metering_unavailable. None of them is a cap and
  // none marks anything: the one generic sentence, never the code, and the
  // stored briefing is still the current one.
  it.each([
    [422, "unsupported_language"],
    [422, "unsupported_currency"],
    [503, "fx_unavailable"],
    [503, "metering_unavailable"],
  ])("HTTP %s {code: %s}: the generic sentence — no code, no plans link, nothing presented as stale", async (status, code) => {
    env.currency = "EUR";
    answer = { status, body: { detail: { code } } };
    render(card());
    fireEvent.click(button());
    await waitFor(() => expect(screen.getByTestId("briefing-regenerate-notice").textContent).toBe(KEPT.en));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const shown = screen.getByTestId("cfo-briefing").textContent ?? "";
    expect(shown).not.toMatch(/unsupported|fx_unavailable|metering|HTTP|\b422\b|\b503\b/);
    expect(screen.queryByTestId("briefing-regenerate-plans")).toBeNull();
    expect(screen.getByTestId("cfo-briefing-body").textContent).toBe(ENGLISH);
    expect(screen.getByTestId("cfo-briefing").getAttribute("data-briefing-state")).toBe("current");
    expect(header()).toMatch(/verified/i);
    expect(invalidate).not.toHaveBeenCalled();
    await act(async () => { await i18n.changeLanguage("ro"); });
    expect(screen.getByTestId("briefing-regenerate-notice").textContent).toBe(KEPT.ro);
  });

  it.each([500, 502, 403])("HTTP %s: the same sentence — never a status code, never the server's words", async (status) => {
    env.currency = "EUR";
    answer = { status, body: { detail: "Claude extraction failed: credit balance is too low" } };
    render(card());
    fireEvent.click(button());
    await waitFor(() => expect(screen.getByTestId("briefing-regenerate-notice").textContent).toBe(KEPT.en));
    const shown = screen.getByTestId("cfo-briefing").textContent ?? "";
    expect(shown).not.toMatch(/HTTP|\b50\d\b|\b403\b|credit balance|Claude/);
    expect(screen.getByTestId("cfo-briefing-body").textContent).toBe(ENGLISH);
  });

  it("a failed 'Generate the briefing' has nothing to keep and does not say it kept one", async () => {
    answer = { status: 200, body: { ok: false, regenerated: false, reason: "no_api_key", stale: true, briefing: null, briefing_length: 0 } };
    render(card({ baseBriefing: null, unavailable: true }));
    fireEvent.click(button());
    await waitFor(() =>
      expect(screen.getByTestId("briefing-regenerate-notice").textContent).toBe(
        "Couldn't generate the briefing — try again in a few minutes.",
      ),
    );
    expect(screen.queryByTestId("cfo-briefing-body")).toBeNull();
    expect(screen.getByTestId("cfo-briefing").textContent).not.toMatch(/no_api_key|was kept/);
    await act(async () => { await i18n.changeLanguage("ro"); });
    expect(screen.getByTestId("briefing-regenerate-notice").textContent).toBe(
      "Briefingul nu a putut fi generat — încearcă din nou în câteva minute.",
    );
  });

  it("a briefing the route serves as stale is never called 'verified'; a current one is", () => {
    const view = render(card({ stale: { since: "2026-10-02T21:14:00Z", reason: "provider_error" } }));
    expect(header()).not.toMatch(/verified/i);
    expect(header()).toMatch(/previous version kept/i);
    expect(header()).not.toMatch(/provider_error/);
    expect(screen.getByTestId("cfo-briefing-body").textContent).toBe(ENGLISH);
    view.unmount();
    render(card({ stale: null }));
    expect(header()).toMatch(/AI briefing/i);
    expect(header()).toMatch(/verified/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the allowance is spent: 429 briefing_regen_cap_reached", () => {
  const detail = (kind: string, extra: Record<string, unknown> = {}) => ({
    detail: {
      code: "briefing_regen_cap_reached",
      kind,
      plan_key: "trial",
      daily_used: 3,
      daily_cap: 3,
      monthly_used: 4,
      monthly_cap: 5,
      upgrade_url: "/pricing",
      ...extra,
    },
  });

  it("daily: the served counts in a sentence, a link to /pricing, the prose untouched — in English and in Romanian", async () => {
    answer = { status: 429, body: detail("daily_cap_reached") };
    env.currency = "EUR";
    render(card());
    fireEvent.click(button());
    await waitFor(() => expect(screen.getByTestId("briefing-regenerate-notice")).toBeTruthy());
    const notice = () => screen.getByTestId("briefing-regenerate-notice").textContent;
    expect(notice()).toBe("You've used 3 of 3 Ask CFO AI messages today, so the briefing wasn't written. See plans");
    const link = screen.getByTestId("briefing-regenerate-plans");
    expect(link.getAttribute("href")).toBe("/pricing");
    expect(link.textContent).toBe("See plans");
    expect(screen.getByTestId("cfo-briefing-body").textContent).toBe(ENGLISH);
    // the caller's plan key is not copy
    expect(screen.getByTestId("cfo-briefing").textContent).not.toMatch(/trial|briefing_regen_cap_reached|429/);
    expect(header()).toMatch(/verified/i); // nothing failed: the stored briefing is still the current one
    await act(async () => { await i18n.changeLanguage("ro"); });
    expect(notice()).toBe("Ai folosit 3 din 3 mesaje Ask CFO AI azi, așa că briefingul nu a fost scris. Vezi planurile");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("monthly: the month's counts", async () => {
    await i18n.changeLanguage("ro");
    answer = { status: 429, body: detail("monthly_cap_reached", { monthly_used: 5 }) };
    render(card());
    fireEvent.click(button());
    await waitFor(() => expect(screen.getByTestId("briefing-regenerate-notice")).toBeTruthy());
    expect(screen.getByTestId("briefing-regenerate-notice").textContent).toBe(
      "Ai folosit 5 din 5 mesaje Ask CFO AI luna aceasta, așa că briefingul nu a fost scris. Vezi planurile",
    );
    await act(async () => { await i18n.changeLanguage("en"); });
    expect(screen.getByTestId("briefing-regenerate-notice").textContent).toBe(
      "You've used 5 of 5 Ask CFO AI messages this month, so the briefing wasn't written. See plans",
    );
  });

  // (An engine before 2026-10-03 answered a DEAD meter as this 429 with no
  // usable counts; the route now answers that 503 metering_unavailable — the
  // generic sentence, gated above. A cap refusal without counts must still
  // never invent one.)
  it("a cap refusal with no counts prints no invented number", async () => {
    answer = { status: 429, body: { detail: { code: "briefing_regen_cap_reached", kind: "monthly_cap_reached", upgrade_url: "/pricing" } } };
    env.currency = "USD";
    render(card());
    fireEvent.click(button());
    await waitFor(() => expect(screen.getByTestId("briefing-regenerate-notice")).toBeTruthy());
    expect(screen.getByTestId("briefing-regenerate-notice").textContent).toBe(
      "Your plan's Ask CFO AI messages are used up, so the briefing wasn't written. See plans",
    );
    expect(screen.getByTestId("briefing-regenerate-notice").textContent).not.toMatch(/\d/);
  });
});

describe("briefingVisibility — the one chokepoint never lets a failure text through", () => {
  it("a row the route serves as unavailable: body null, the note, no hidden-definition note", () => {
    const v = briefingVisibility({ body: null, language: "en", model: null, definition: null, unavailable: true, unavailable_reason: "provider_error", stale: null });
    expect(v.body).toBeNull();
    expect(v.unavailable).toBe(true);
    expect(v.hiddenNote).toBeNull();
    expect(v.unavailableNote).toEqual({
      en: "The AI briefing is unavailable for this period — the analysis figures are unaffected.",
      ro: "Briefingul AI nu este disponibil pentru această perioadă — cifrele analizei nu sunt afectate.",
    });
  });

  it("an engine that still serves the failure text as the body: unavailable, whatever its definition stamp", () => {
    for (const text of FAILURE_TEXTS.filter((t) => t.trim())) {
      expect(isUnusableNarrative(text), text).toBe(true);
      for (const previous of [true, false]) {
        const v = briefingVisibility({
          body: text,
          language: "en",
          definition: { written_under: "x", current_definition: "y", written_under_previous_definition: previous, note: null },
        });
        expect(v.body, text).toBeNull();
        expect(v.unavailable, text).toBe(true);
        expect(v.hiddenNote, text).toBeNull();
      }
    }
  });

  it("an accounting sentence about a credit balance is prose, not a failure", () => {
    const prose = "Account 4111 carries a credit balance of 1.2M RON that should be reclassified.";
    expect(isUnusableNarrative(prose)).toBe(false);
    expect(briefingVisibility({ body: prose }).body).toBe(prose);
  });

  it("a usable briefing reads exactly { body, hiddenNote: null } — the new properties are absent, not null", () => {
    const v = briefingVisibility({ body: ENGLISH, definition: { written_under: "x", current_definition: "x", written_under_previous_definition: false, note: null } });
    expect(v).toEqual({ body: ENGLISH, hiddenNote: null });
    expect(Object.keys(v).sort()).toEqual(["body", "hiddenNote"]);
    expect(briefingVisibility({ body: ENGLISH, stale: null, unavailable: false }).stale).toBeUndefined();
    expect(briefingVisibility({ body: ENGLISH, stale: null, unavailable: false }).unavailable).toBeUndefined();
  });

  it("a kept briefing carries its stale marker and the served language", () => {
    const v = briefingVisibility({ body: ROMANIAN, language: "ro", stale: { since: "2026-10-02T21:14:00Z", reason: "provider_error" } });
    expect(v.body).toBe(ROMANIAN);
    expect(v.stale).toEqual({ since: "2026-10-02T21:14:00Z", reason: "provider_error" });
    expect(v.language).toBe("ro");
  });

  it("the note is the dashboard's own sentence, in both locale files", () => {
    const locale = (lang: string) => JSON.parse(readFileSync(resolve(__dirname, `../../../i18n/locales/${lang}.json`), "utf8"));
    expect(locale("en").dash.narrativeUnavailable).toBe(BRIEFING_UNAVAILABLE_NOTE.en);
    expect(locale("ro").dash.narrativeUnavailable).toBe(BRIEFING_UNAVAILABLE_NOTE.ro);
  });

  it("the dashboard, the report, the chat snapshot and the command bar all read through it — no second reader of the served body", () => {
    const ROOT = resolve(__dirname, "../../..");
    const files: string[] = [];
    (function walk(dir: string) {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "__tests__" || name === "dist" || name === "test") continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name)) files.push(p);
      }
    })(ROOT);
    expect(files.length).toBeGreaterThan(300);
    const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

    // who touches the served object's body at all
    const bodyReaders = files
      .filter((f) => /\bbriefing\??\.(body|summary)\b|payload\.briefing\b/.test(readFileSync(f, "utf8")))
      .map((f) => relative(ROOT, f))
      .sort();
    expect(bodyReaders).toEqual(["lib/activePeriod.ts", "lib/briefingDefinition.ts", "pages/cfo/ComprehensiveReport.tsx"]);

    // the dashboard, the chat snapshot and the command bar: the active period's briefing
    const activePeriod = read("lib/activePeriod.ts");
    expect(activePeriod).toMatch(/const shownBriefing = briefingVisibility\(payload\.briefing\);/);
    expect(activePeriod).toMatch(/briefing: shownBriefing\.body,/);
    expect(activePeriod.match(/payload\.briefing\b/g)).toHaveLength(1);
    expect(read("pages/cfo/Chat.tsx")).toMatch(/lines\.push\(p\.briefing\.trim\(\)\);/);
    expect(read("components/cfo/command/StateCard.tsx")).toMatch(/if \(period\.briefing\) \{/);

    expect(activePeriod).toMatch(/briefingUnavailable: shownBriefing\.unavailable === true,/);
    expect(activePeriod).toMatch(/briefingStale: shownBriefing\.stale \?\? null,/);
    expect(activePeriod).toMatch(/briefingLanguage: shownBriefing\.language \?\? null,/);

    // the dashboard mounts the card for prose OR for an unavailable briefing,
    // and hands it the period's company, the served language and the marker
    const dashboard = read("pages/cfo/FinancialStatements.tsx");
    expect(dashboard).toMatch(/\{\(briefing \|\| briefingUnavailable\) && briefingPeriodId \? \(\s*<CFOBriefingCard/);
    for (const prop of [
      "baseBriefing={briefing ?? null}", "baseLanguage={briefingLanguage}", "unavailable={briefingUnavailable}",
      "stale={briefingStale}", "orgId={briefingOrgId}",
      "briefingOrgId={remotePeriod.organizationId}", "briefingUnavailable={remotePeriod.briefingUnavailable === true}",
    ]) {
      expect(dashboard, prop).toContain(prop);
    }

    // the report: only what briefingVisibility returned is printed
    const report = read("pages/cfo/ComprehensiveReport.tsx");
    expect(report).toMatch(/const briefingShown = briefingVisibility\(/);
    expect(report.match(/report\.briefing\b/g)?.length).toBe(4); // all inside that one call
    expect(report).toMatch(/\{briefingShown\.body\}/);
    expect(report).toMatch(/data-testid="report-briefing-unavailable"/);
  });
});

describe("the copy no longer promises an automatic regeneration", () => {
  const locale = (lang: string) => JSON.parse(readFileSync(resolve(__dirname, `../../../i18n/locales/${lang}.json`), "utf8"));
  const AUTOMATIC = /automatic|regenerates when|will regenerate|se va regenera|se regenerează la schimbarea|automat/i;

  it("dash.narrativeUnavailable, dash.regenFailed and dashIx.aboutAnalysisBody, in English and Romanian", () => {
    expect(locale("en").dash.narrativeUnavailable).toBe("The AI briefing is unavailable for this period — the analysis figures are unaffected.");
    expect(locale("ro").dash.narrativeUnavailable).toBe("Briefingul AI nu este disponibil pentru această perioadă — cifrele analizei nu sunt afectate.");
    expect(locale("en").dash.regenFailed).toBe("Couldn't regenerate — the previous briefing was kept.");
    expect(locale("ro").dash.regenFailed).toBe("Regenerarea nu a reușit — briefingul anterior a fost păstrat.");
    expect(instrumentStrings.en.dashIx.aboutAnalysisBody).toBe(
      "Narrative generated by the platform's language model (Opus 4.7) from this period's extracted figures; it is regenerated only when you ask for it, and each regeneration uses one Ask CFO AI message. The figures themselves come from the deterministic engine, not the model.",
    );
    expect(instrumentStrings.ro.dashIx.aboutAnalysisBody).toBe(
      "Narativul este generat de modelul lingvistic al platformei (Opus 4.7) din cifrele extrase ale acestei perioade; se regenerează doar la cererea ta, iar fiecare regenerare folosește un mesaj Ask CFO AI. Cifrele vin din motorul determinist, nu din model.",
    );
    for (const s of [
      locale("en").dash.narrativeUnavailable, locale("ro").dash.narrativeUnavailable,
      locale("en").dash.regenFailed, locale("ro").dash.regenFailed,
      instrumentStrings.en.dashIx.aboutAnalysisBody, instrumentStrings.ro.dashIx.aboutAnalysisBody,
    ]) {
      expect(s).not.toMatch(AUTOMATIC);
      expect(s).not.toMatch(/\{\{error\}\}|\{\{currency\}\}/);
    }
  });

  it("every string the card prints exists in both languages, and the Romanian is not the English", () => {
    const keys = [
      "regenerating", "regeneratingIn", "regenFailed", "generateFailed", "regenerateInLanguage", "regenerateInCurrency",
      "generateBriefing", "regenerateCost", "regenCapDaily", "regenCapMonthly", "regenCapNoCounts", "narrativeUnavailable", "displayedIn",
    ];
    for (const key of keys) {
      const en = locale("en").dash[key];
      const ro = locale("ro").dash[key];
      expect(typeof en === "string" && en.length > 0, `en dash.${key}`).toBe(true);
      expect(typeof ro === "string" && ro.length > 0, `ro dash.${key}`).toBe(true);
      expect(ro, `dash.${key}`).not.toBe(en);
    }
    expect(locale("en").dash.regenerateInLanguage).toBe("Regenerate in English");
    expect(locale("ro").dash.regenerateInLanguage).toBe("Regenerează în română");
    expect(locale("en").dash.regenerateInCurrency).toBe("Regenerate in {{currency}}");
    expect(locale("ro").dash.regenerateInCurrency).toBe("Regenerează în {{currency}}");
    for (const key of ["briefingStale", "briefingUnavailable", "briefingVerified"] as const) {
      expect(instrumentStrings.en.dashIx[key]).toBeTruthy();
      expect(instrumentStrings.ro.dashIx[key]).toBeTruthy();
      expect(instrumentStrings.ro.dashIx[key]).not.toBe(instrumentStrings.en.dashIx[key]);
    }
  });
});
