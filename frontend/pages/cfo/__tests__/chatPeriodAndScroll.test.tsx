// THE ASSISTANT IS TOLD WHICH PERIOD IT READS — AND ITS ANSWER STAYS ON SCREEN.
//
// Two defects one real question on production showed (2026-10-04):
//
// 1. THE PERIOD. The workspace snapshot's first line was
//    `Period: ${p.label ?? p.id}`. `label` is the COMPANY's name, so the
//    assistant was handed the company as its period — or, with no name, the
//    period's row id, which it then printed to the reader: "the period is
//    <uuid> (an internal identifier); the snapshot carries no readable
//    label". LAW: the line is the statements' own period label and the
//    closing date; the row id appears NOWHERE in the snapshot; with neither
//    a label nor a date the line says so.
//
// 2. THE SCROLL. On the full /chat page the window was scrolled to the end
//    of the DOCUMENT after every message. The document also holds what the
//    app shell renders below the chat, so a short conversation was pushed
//    up under the header and the footer was on screen instead of the answer.
//    LAW: the window goes to the end of the CHAT COLUMN (messages + the
//    in-flow composer); a conversation shorter than the viewport stays at
//    the top; a reader who scrolled up is left where they are.
//
// Fails on: the id or the company printed as the period; a snapshot with no
// period line; the closing date dropped; `scrollTo` handed the document's
// height; a short conversation scrolled at all; the column not marked on
// the page.
// Cannot see: what the model answers; real layout (jsdom has none — the
// column's box is stated by the test); the compact slide-over panel's own
// inner scroller, which is unchanged.
// Plant log: docs/engine_book/gates.md, "chat-period-and-scroll".
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { act, cleanup, render } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "@/i18n";
import { CFOMessageList, CHAT_COLUMN_ATTR, chatEndScrollTop } from "@/components/cfo/chat/CFOMessageList";
import type { ChatMessage } from "@/components/cfo/chat/types";
import { buildWorkspaceSnapshot, snapshotPeriodLine } from "@/pages/cfo/Chat";
import type { Statements } from "@/lib/financialReport";

import pairJson from "@/lib/__tests__/fixtures/comparatives/pair_served.json";

type Json = Record<string, unknown>;
const pair = pairJson as unknown as {
  current_body: { statements: Statements & Json; metrics: { name: string; value: number | null }[] };
};
const PERIOD_ID = "0b6f2c1e-7a44-4d0c-9c1b-5e2f8a3d9b17";
let checked = 0;

type Period = Parameters<typeof buildWorkspaceSnapshot>[0];
const periodOf = (over: Partial<Record<keyof Period, unknown>>): Period =>
  ({
    id: PERIOD_ID, label: "Example Foods SRL", periodEnd: "2025-12-31", organizationId: null, industry: null,
    statements: pair.current_body.statements, lineItems: [], invoices: null, metrics: pair.current_body.metrics,
    recommendations: [], alerts: [], briefing: null, source: "upload",
    ...over,
  }) as unknown as Period;
const firstLine = (snapshot: string | undefined) => (snapshot ?? "").split("\n")[0];

afterAll(() => {
  // eslint-disable-next-line no-console
  console.log(`GATE-WORK chat-period-and-scroll checks=${checked}`);
});

describe("the snapshot's period line", () => {
  const withLabel = (periodLabel: string | undefined) =>
    ({ ...pair.current_body.statements, periodLabel }) as unknown as Statements;

  it("is the statements' label and the closing date — every shape", () => {
    const CASES: { label: string | undefined; end: string | null; want: string }[] = [
      { label: "FY 2025", end: "2025-12-31", want: "FY 2025 (period ending 2025-12-31)" },
      { label: "  Dec 2024 ", end: "2024-12-31T00:00:00+00:00", want: "Dec 2024 (period ending 2024-12-31)" },
      { label: "FY 2025", end: null, want: "FY 2025" },
      { label: "", end: "2025-06-30", want: "period ending 2025-06-30" },
      { label: undefined, end: "2025-06-30", want: "period ending 2025-06-30" },
      { label: undefined, end: null, want: "not stated in the workspace" },
      { label: "", end: "31.12.2025", want: "not stated in the workspace" },
    ];
    for (const c of CASES) {
      const p = periodOf({ statements: withLabel(c.label), periodEnd: c.end });
      expect(snapshotPeriodLine(p), JSON.stringify(c)).toBe(c.want);
      expect(firstLine(buildWorkspaceSnapshot(p)), JSON.stringify(c)).toBe(`Period: ${c.want}`);
      checked += 2;
    }
  });

  it("THE DEFECT: with no company name the period was the row id — the id is nowhere in the snapshot", () => {
    for (const label of [null, "", "Example Foods SRL"]) {
      for (const statements of [pair.current_body.statements, withLabel(undefined), null]) {
        const snap = buildWorkspaceSnapshot(periodOf({ label, statements })) ?? "";
        expect(snap, `label=${String(label)}`).not.toContain(PERIOD_ID);
        expect(snap.toLowerCase()).not.toContain(PERIOD_ID.slice(0, 13));
        expect(firstLine(snap)).toMatch(/^Period: (?!$)/);
        checked += 1;
      }
    }
  });

  it("the company is never printed as the period, and is still named on its own line", () => {
    const named = { ...pair.current_body.statements, companyName: "Example Foods SRL" } as unknown as Statements;
    const snap = buildWorkspaceSnapshot(periodOf({ statements: named, label: "Example Foods SRL" })) ?? "";
    expect(firstLine(snap)).not.toContain("Example Foods");
    expect(snap.split("\n")).toContain("Company: Example Foods SRL");
    // The statements carry no name: the header's name (the workspace's) is the company line.
    const unnamed = { ...pair.current_body.statements, companyName: "" } as unknown as Statements;
    const snap2 = buildWorkspaceSnapshot(periodOf({ statements: unnamed, label: "Workspace Name SRL" })) ?? "";
    expect(firstLine(snap2)).not.toContain("Workspace Name");
    expect(snap2.split("\n")).toContain("Company: Workspace Name SRL");
    // Neither: no company line at all (never "Company: " with nothing after it).
    const snap3 = buildWorkspaceSnapshot(periodOf({ statements: unnamed, label: null })) ?? "";
    expect(snap3).not.toMatch(/^Company:/m);
    checked += 3;
  });

  it("no period on screen, no snapshot", () => {
    expect(buildWorkspaceSnapshot(periodOf({ id: null }))).toBeUndefined();
    checked += 1;
  });
});

describe("the page scrolls to the end of the conversation, not of the document", () => {
  const DOCUMENT_HEIGHT = 5000; // the chat column AND what the shell renders below it
  const VIEWPORT = 800;
  let scrollTo: ReturnType<typeof vi.fn>;
  let columnBottom = 0;

  const msg = (id: string, role: "user" | "assistant", content: string): ChatMessage =>
    ({ id, role, content, createdAt: 1 }) as ChatMessage;

  beforeEach(() => {
    scrollTo = vi.fn();
    vi.stubGlobal("scrollTo", scrollTo);
    Object.defineProperty(window, "innerHeight", { configurable: true, value: VIEWPORT });
    Object.defineProperty(window, "scrollY", { configurable: true, writable: true, value: 0 });
    Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: DOCUMENT_HEIGHT });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const bottom = this.hasAttribute(CHAT_COLUMN_ATTR) ? columnBottom : 123;
      return { top: 0, left: 0, right: 0, bottom, width: 0, height: bottom, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const renderList = (messages: ChatMessage[]) =>
    render(
      <div {...{ [CHAT_COLUMN_ATTR]: "" }}>
        <CFOMessageList messages={messages} documentScroll bottomInset wideContent />
        <div data-testid="composer" />
      </div>,
    );
  const tops = () => scrollTo.mock.calls.map((c) => (c[0] as { top: number }).top);

  it("the arithmetic: the column's end at the viewport's bottom, never above the top", () => {
    expect(chatEndScrollTop(2000, 0, 800)).toBe(1200);
    expect(chatEndScrollTop(900, 1100, 800)).toBe(1200); // already scrolled: the same place
    expect(chatEndScrollTop(700, 0, 800)).toBe(0); // shorter than the viewport
    expect(chatEndScrollTop(800, 0, 800)).toBe(0);
    expect(chatEndScrollTop(1000.4, 0, 800)).toBe(200);
    checked += 5;
  });

  it("THE DEFECT: a short conversation is not scrolled — the document's end is never the target", () => {
    columnBottom = 700; // the column ends above the viewport's bottom
    const view = renderList([msg("u1", "user", "What is my period?")]);
    view.rerender(
      <div {...{ [CHAT_COLUMN_ATTR]: "" }}>
        <CFOMessageList
          messages={[msg("u1", "user", "What is my period?"), msg("a1", "assistant", "FY 2025.")]}
          documentScroll bottomInset wideContent
        />
        <div data-testid="composer" />
      </div>,
    );
    expect(scrollTo).toHaveBeenCalled();
    for (const top of tops()) expect(top).toBe(0);
    expect(tops()).not.toContain(DOCUMENT_HEIGHT);
    checked += 1;
  });

  it("a long conversation lands on the column's end — the composer in view, the footer not", () => {
    columnBottom = 2000;
    renderList([msg("u1", "user", "A long question"), msg("a1", "assistant", "A long answer")]);
    expect(tops().length).toBeGreaterThan(0);
    for (const top of tops()) expect(top).toBe(1200);
    expect(tops()).not.toContain(DOCUMENT_HEIGHT);
    checked += 1;
  });

  it("a reader who scrolled up is left where they are; back at the end, the next message follows", () => {
    columnBottom = 2000;
    const first = [msg("u1", "user", "q"), msg("a1", "assistant", "a")];
    const view = renderList(first);
    scrollTo.mockClear();
    // The reader scrolls up to re-read: 1200 is the end, 300 is far above it.
    (window as unknown as { scrollY: number }).scrollY = 300;
    columnBottom = 2000 - 300;
    act(() => { window.dispatchEvent(new Event("scroll")); });
    const next = [...first, msg("u2", "user", "q2")];
    const again = (messages: ChatMessage[]) =>
      view.rerender(
        <div {...{ [CHAT_COLUMN_ATTR]: "" }}>
          <CFOMessageList messages={messages} documentScroll bottomInset wideContent />
          <div data-testid="composer" />
        </div>,
      );
    again(next);
    expect(scrollTo).not.toHaveBeenCalled();
    // Back at the conversation's end (not the document's): pinned again.
    (window as unknown as { scrollY: number }).scrollY = 1195;
    columnBottom = 2000 - 1195;
    act(() => { window.dispatchEvent(new Event("scroll")); });
    again([...next, msg("a2", "assistant", "a2")]);
    expect(tops()).toEqual([1200]);
    checked += 2;
  });

  it("with no column marked the list's own end is the target — still never the document's", () => {
    columnBottom = 2000;
    render(<CFOMessageList messages={[msg("u1", "user", "q")]} documentScroll />);
    expect(tops().length).toBeGreaterThan(0);
    expect(tops()).not.toContain(DOCUMENT_HEIGHT);
    for (const top of tops()) expect(top).toBe(0); // the list's stated box ends at 123
    checked += 1;
  });

  it("the /chat page marks its column — the one holding the list and the composer", () => {
    const shell = readFileSync(resolve(process.cwd(), "frontend/components/cfo/chat/CFOChatShell.tsx"), "utf8");
    const at = shell.indexOf(`<div ${CHAT_COLUMN_ATTR}=""`);
    expect(at).toBeGreaterThan(-1);
    expect(shell.split(`${CHAT_COLUMN_ATTR}=""`).length - 1).toBe(1);
    const after = shell.slice(at);
    expect(after.indexOf("<CFOMessageList")).toBeGreaterThan(-1);
    expect(after.indexOf("<CFOComposer")).toBeGreaterThan(after.indexOf("<CFOMessageList"));
    const list = readFileSync(resolve(process.cwd(), "frontend/components/cfo/chat/CFOMessageList.tsx"), "utf8");
    expect(list).not.toMatch(/scrollTo\(\{ top: document\.documentElement\.scrollHeight \}\)/);
    checked += 2;
  });
});
