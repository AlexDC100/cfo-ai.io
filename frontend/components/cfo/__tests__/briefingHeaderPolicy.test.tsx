// A4 policy — model ids never render in the briefing's primary DOM.
//
// The briefing header must read "AI briefing · verified"; the model /
// prompt mechanics live behind the "About this analysis" disclosure,
// which is CLOSED by default. This test renders the real component and
// asserts (1) no model name in the header, (2) no model name anywhere in
// the default (closed-disclosure) DOM, (3) the model detail exists but
// only after the disclosure is opened.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

// Currency store is context-backed (throws outside its provider in dev);
// mock the one hook the briefing consumes so it renders standalone.
vi.mock("@/stores/currency", () => ({
  useDisplayCurrency: () => "RON",
}));

import { CFOBriefingCard, isUnusableNarrative } from "@/components/cfo/CFOBriefingCard";

const MODEL_ID = /opus|claude|sonnet|haiku|gpt/i;

describe("briefing header policy (A4)", () => {
  it("renders no model id in the briefing header", () => {
    render(
      <CFOBriefingCard
        periodId="test-period"
        baseBriefing="A calm, verified narrative about the period."
      />,
    );
    const header = screen.getByTestId("briefing-header");
    expect(header.textContent ?? "").not.toMatch(MODEL_ID);
    expect(header.textContent).toMatch(/AI briefing/i);
    expect(header.textContent).toMatch(/verified/i);
  });

  it("keeps model ids out of the default DOM entirely; they appear only inside the opened About disclosure", () => {
    const { container } = render(
      <CFOBriefingCard
        periodId="test-period"
        baseBriefing="A calm, verified narrative about the period."
      />,
    );
    // Closed by default → no model id anywhere on first paint.
    expect(container.textContent ?? "").not.toMatch(MODEL_ID);

    fireEvent.click(screen.getByTestId("briefing-about-analysis"));
    const body = screen.getByTestId("briefing-about-analysis-body");
    // The disclosure is where the model attribution lives — it must
    // actually carry it (moved, not deleted).
    expect(body.textContent ?? "").toMatch(MODEL_ID);
    // And the header still stays clean with the disclosure open.
    expect(screen.getByTestId("briefing-header").textContent ?? "").not.toMatch(MODEL_ID);
  });

  it("collapsed variant renders no About disclosure at all", () => {
    const { container } = render(
      <CFOBriefingCard
        periodId="test-period"
        baseBriefing="A calm, verified narrative about the period."
        collapsed
        onToggle={() => {}}
      />,
    );
    expect(screen.queryByTestId("briefing-about-analysis")).toBeNull();
    expect(container.textContent ?? "").not.toMatch(MODEL_ID);
  });

  it("isUnusableNarrative still gates broken narratives", () => {
    expect(isUnusableNarrative(null)).toBe(true);
    expect(isUnusableNarrative("[NARRATIVE_UNAVAILABLE]")).toBe(true);
    expect(isUnusableNarrative("Fine prose.")).toBe(false);
  });
});
