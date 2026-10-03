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
import { briefingVisibility } from "@/lib/briefingDefinition";

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

// THE BROWSER'S TWIN OF THE ENGINE'S TEXT PREDICATE (2026-10-03).
//
// `isUnusableNarrative` runs on the body the engine SERVED AS USABLE. It must
// decide exactly as the engine's `stored_briefing_failure_code`
// (src/engine/api/pipeline.py) does: by the SHAPE of the body, never by a
// phrase somewhere inside it. Until this change it searched the provider's
// phrases anywhere, so a good briefing saying a supplier's "credit balance is
// too low" — which the engine serves as prose — was hidden by the page.
//
// The rows are the engine gate's own
// (tests/engine/test_briefing_keep_last_good_served.py), written out here
// independently; a change to one predicate is a change to both tables.
describe("the browser's failure-text predicate decides as the engine's does", () => {
  const PROVIDER_ERROR =
    "Error code: 400 - {'type': 'error', 'error': {'type': 'invalid_request_error', " +
    "'message': 'Your credit balance is too low to access the Anthropic API. " +
    "Please go to Plans & Billing to upgrade or purchase credits.'}}";

  const FAILURE_BODIES: Array<[string, string | null | undefined]> = [
    ["absent", undefined],
    ["null", null],
    ["empty", ""],
    ["whitespace", "  \n\t "],
    ["the sentinel", "[NARRATIVE_UNAVAILABLE]"],
    ["the sentinel, padded", " [NARRATIVE_UNAVAILABLE]\n"],
    ["the empty-reply sentence", "Narrative unavailable."],
    ["the old provider branch (credit)", "Narrative unavailable: " + PROVIDER_ERROR],
    ["the old provider branch (connection)", "Narrative unavailable: Connection error."],
    ["bare provider text", PROVIDER_ERROR],
    [
      "bare provider text (overloaded)",
      "Error code: 529 - {'type': 'error', 'error': {'type': 'overloaded_error', 'message': 'Overloaded'}}",
    ],
    ["the no-key sentence", "Set ANTHROPIC_API_KEY on the backend to enable AI narrative."],
    ["the no-SDK sentence", "anthropic SDK not installed on backend."],
    [
      "the numeral-guard sentence",
      "The briefing was withheld: the model cited figures the engine did not author. " +
        "The statements, ratios and alerts on this page are unaffected and remain engine-computed.",
    ],
    // The head of a raw model reply stored as the body: no briefing begins
    // with `{` or a backtick.
    ["a JSON reply cut off", '{"briefing": "The company posted reven'],
    ["a JSON reply with trailing text", '{"briefing": "Margins held.", "recommendations": []}\n\nLet me know.'],
    ["a JSON reply in single backticks", '`{"briefing": "Margins held."}`'],
    ["a JSON reply after whitespace", '\n  {"briefing": "Margins held'],
  ];

  const PROSE_BODIES: Array<[string, string]> = [
    ["english", "Agras closed the year with a comfortable liquidity position and a conservative balance sheet."],
    [
      "romanian",
      "Compania a încheiat anul cu o poziție de lichiditate confortabilă, iar marja EBITDA rămâne peste media sectorului.",
    ],
    ["with figures", "EBITDA was 10.8M."],
    // The defect: finance prose that says the provider's phrase.
    [
      "a credit balance that is too low, mid-sentence",
      "Trade payables fell during the year, but the supplier's credit balance is too low to offset the receivable; liquidity otherwise remains comfortable.",
    ],
    [
      "a credit balance that is too low, at the start",
      "Credit balance is too low on two supplier accounts to offset the receivable; liquidity otherwise remains comfortable.",
    ],
    // Every failure shape is anchored at the START of the body.
    [
      "'unavailable' mid-sentence",
      "Prior-year comparatives were unavailable, so growth is not stated; margins remain healthy.",
    ],
    [
      "'narrative unavailable' mid-sentence",
      "The narrative unavailable last quarter is now complete: revenue grew and costs fell.",
    ],
    [
      "an error code mid-sentence",
      "The bank export returned Error code: 5 twice before the statement was reloaded; the figures are final.",
    ],
    [
      "a provider error type mid-sentence",
      "The ERP log shows an invalid_request_error on the March import; the ledger itself is complete.",
    ],
    ["starts with Set", "Set against a healthy EBITDA margin, leverage is modest."],
    ["'withheld' mid-sentence", "Dividends were withheld this year to fund the capex programme."],
    ["a brace mid-sentence", "Margins held {see note 4} and liquidity is comfortable."],
    ["a backtick mid-sentence", "The `EBITDA` margin held and liquidity is comfortable."],
  ];

  it.each(FAILURE_BODIES)("a failure text is never prose: %s", (_name, body) => {
    expect(isUnusableNarrative(body)).toBe(true);
    if (typeof body === "string" && body.trim()) {
      const v = briefingVisibility({ body, language: "en" });
      expect(v.body).toBeNull();
      expect(v.unavailable).toBe(true);
    }
  });

  it.each(PROSE_BODIES)("prose is never mistaken for a failure text: %s", (_name, body) => {
    expect(isUnusableNarrative(body)).toBe(false);
    // The one chokepoint every reader goes through hands the prose on…
    expect(briefingVisibility({ body, language: "en" })).toEqual({ body, hiddenNote: null, language: "en" });
  });

  it("the card SHOWS a served briefing that says a credit balance is too low", () => {
    // …and the real card mounts it (a false positive here is a good briefing
    // the engine serves as usable and the page hides).
    const prose =
      "Trade payables fell during the year, but the supplier's credit balance is too low to offset the receivable; liquidity otherwise remains comfortable.";
    render(<CFOBriefingCard periodId="test-period" baseBriefing={prose} />);
    expect(screen.getByTestId("cfo-briefing").textContent ?? "").toContain("credit balance is too low to offset");
    // Positive control: the same card does not print a reply fragment.
    const fragment = '{"briefing": "The company posted reven';
    const view = render(<CFOBriefingCard periodId="test-period-2" baseBriefing={fragment} />);
    expect(view.container.textContent ?? "").not.toContain("posted reven");
  });
});
