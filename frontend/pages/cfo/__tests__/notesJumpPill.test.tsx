// THE "N NOTES" PILL ON THE OVERVIEW GOES SOMEWHERE.
//
// Live on cfo-ai.io: on the dashboard Overview the pill
// (`data-testid="notes-jump-pill"`) scrolled to
// `[data-testid^="statement-notes-"]`, which the Overview never renders —
// it renders `overview-recommendations`. `querySelector` returned null and
// the click did nothing: a dead button on the demo path.
//
// ── WHAT IT REDS ON, after the repair (TC-11) ─────────────────────────
//  · a click on the pill that scrolls nothing when the Overview's
//    recommendations section is the only notes surface on the page;
//  · a statement-notes section losing precedence when one IS on the page;
//  · a click that throws when neither surface is mounted.

import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({ getSupabase: () => null, currentOrgId: async () => null }));

import { renderWithProviders } from "@/test/renderWithProviders";
import { NotesJumpPill } from "@/pages/cfo/FinancialStatements";
import { notesJumpTarget } from "@/lib/notesJumpTarget";

const scrolled: Element[] = [];

beforeEach(() => {
  scrolled.length = 0;
  // jsdom implements no scrolling; record the element each call lands on.
  Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
    scrolled.push(this);
  }) as unknown as Element["scrollIntoView"];
});

afterEach(() => {
  cleanup();
});

function mountOverview(extra?: React.ReactNode) {
  return renderWithProviders(
    <div>
      <NotesJumpPill alerts={[{ severity: "high" }]} recommendationCount={3} />
      <section data-testid="overview-recommendations">recommendations</section>
      {extra}
    </div>,
  );
}

describe("notes-jump-pill", () => {
  it("on the Overview, scrolls to the recommendations section", () => {
    mountOverview();
    expect(document.querySelector('[data-testid^="statement-notes-"]')).toBeNull();
    fireEvent.click(screen.getByTestId("notes-jump-pill"));
    expect(scrolled).toHaveLength(1);
    expect(scrolled[0]).toBe(screen.getByTestId("overview-recommendations"));
  });

  it("a statement-notes section, when on the page, still wins", () => {
    mountOverview(<section data-testid="statement-notes-bs">notes</section>);
    fireEvent.click(screen.getByTestId("notes-jump-pill"));
    expect(scrolled).toEqual([screen.getByTestId("statement-notes-bs")]);
  });

  it("with neither surface mounted, a click is a no-op rather than a throw", () => {
    renderWithProviders(<NotesJumpPill alerts={[]} recommendationCount={1} />);
    expect(notesJumpTarget()).toBeNull();
    expect(() => fireEvent.click(screen.getByTestId("notes-jump-pill"))).not.toThrow();
    expect(scrolled).toHaveLength(0);
  });
});
