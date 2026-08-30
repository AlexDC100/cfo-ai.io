// PART D + E — THE CORRECTION PATH AND THE HONEST DISPLAY.
//
// WHAT THESE TESTS DEFEND
// ───────────────────────
// Part C stopped new uploads being misfiled. These pieces are for the
// rows already in the database — "Carniprod Trial Balance 2025.xlsx"
// sitting under 2017-12, and a 2025-12 period holding two different
// companies' books — and for making such a row VISIBLE before anyone can
// be expected to fix it.
//
// LAWS PINNED HERE
//   · The chip renders the ENGINE'S verdict, never a recomputed one, and
//     renders NOTHING when the engine recorded no verdict. A period
//     written before the detection stamp shipped has no record, and
//     "no record" is not "no problem" — ABSENT != ZERO.
//   · Disputed and unknown are DIFFERENT states. A file that named a
//     month the period disagrees with is a conflict; a file that named no
//     month at all is an absence. Merging them would hide the second.
//   · A file row shows BOTH dates and never lets one stand in for the
//     other. When the document's own month was never recorded, the row
//     says so instead of borrowing the period's date — borrowing is
//     exactly how an eight-year error stayed invisible.
//   · SOURCE is read from the engine's declared pointer. When the engine
//     declared nothing, no badge is drawn: the old
//     most-recently-analyzed guess silently crowned a winner on the
//     period that held two companies.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import "@/i18n";
import type { PeriodDetection, PeriodFilingFacts } from "../periodFiling";
import {
  hasVerdict,
  isMismatch,
  isUnconfirmed,
  needsAttention,
  resolveSourceDocumentId,
  verdictAppliesTo,
} from "../periodFiling";

vi.mock("@/components/ui/sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
  },
}));

import { PeriodFileRow } from "../PeriodFileRow";
import { PeriodFilingChip, PeriodFilingReviewDialog } from "../PeriodFilingReview";

afterEach(cleanup);

// ─── fixtures pinned to the production audit ─────────────────────────────

const DISPUTED: PeriodDetection = {
  resolved_period_end: "2017-12-31",
  signal_used: "user_confirmed",
  confidence: 1,
  evidence_snippet: "user-confirmed period end: 2017-12-31",
  hint: "2017-12-31",
  detected: {
    proposed_period_end: "2025-12-31",
    confidence: 0.6,
    signal_used: "filename",
    evidence_snippet: "Carniprod Trial Balance 2025.xlsx",
    candidates: [
      {
        signal: "filename",
        period_end: "2025-12-31",
        evidence_snippet: "Carniprod Trial Balance 2025.xlsx",
      },
    ],
  },
  mismatch: true,
};

const UNKNOWN: PeriodDetection = {
  resolved_period_end: "2026-08-30",
  signal_used: "fallback_today",
  confidence: 0,
  evidence_snippet: null,
  hint: null,
  detected: {
    proposed_period_end: null,
    confidence: 0,
    signal_used: "none",
    evidence_snippet: null,
    candidates: [],
  },
  mismatch: false,
};

const AGREED: PeriodDetection = {
  resolved_period_end: "2025-12-31",
  signal_used: "closing_balance",
  confidence: 0.85,
  evidence_snippet: "BALANTA DE VERIFICARE la data de 31.12.2025",
  hint: null,
  detected: {
    proposed_period_end: "2025-12-31",
    confidence: 0.85,
    signal_used: "closing_balance",
    evidence_snippet: "BALANTA DE VERIFICARE la data de 31.12.2025",
    candidates: [],
  },
  mismatch: false,
};

function facts(
  detection: PeriodDetection | null,
  over: Partial<PeriodFilingFacts> = {},
): PeriodFilingFacts {
  return {
    period_id: "p-2017-12",
    period_end: "2017-12-31",
    source_document_id: "doc-carniprod",
    period_detection: detection,
    ...over,
  };
}

// ─── the record, read not recomputed ─────────────────────────────────────

describe("the engine's verdict is read, never re-derived", () => {
  it("treats a period with no record as ABSENT, not as clean", () => {
    const legacy = facts(null);
    expect(hasVerdict(legacy)).toBe(false);
    expect(needsAttention(legacy)).toBe(false);
    expect(isMismatch(legacy)).toBe(false);
  });

  it("reports a dispute straight off the engine's flag", () => {
    expect(isMismatch(facts(DISPUTED))).toBe(true);
    expect(isUnconfirmed(facts(DISPUTED))).toBe(false);
  });

  it("keeps 'filed under the upload day' as its own state", () => {
    // Not a mismatch — there is nothing to disagree with. Merging it into
    // the dispute state would hide every period nobody ever dated.
    expect(isUnconfirmed(facts(UNKNOWN))).toBe(true);
    expect(isMismatch(facts(UNKNOWN))).toBe(false);
    expect(needsAttention(facts(UNKNOWN))).toBe(true);
  });

  it("stays quiet when the document and the period agree", () => {
    expect(needsAttention(facts(AGREED))).toBe(false);
  });

  it("attributes the record ONLY to the file it describes", () => {
    // The record is stamped from an envelope, and an envelope is built
    // from exactly one document. Showing it against a sibling would put
    // words in that document's mouth.
    const f = facts(DISPUTED);
    expect(verdictAppliesTo(f, "doc-carniprod")).toBe(true);
    expect(verdictAppliesTo(f, "doc-scandia")).toBe(false);
  });
});

describe("which file the numbers come from", () => {
  it("prefers the engine's declared pointer over any local guess", () => {
    const resolved = resolveSourceDocumentId(
      facts(AGREED, { source_document_id: "doc-carniprod" }),
      ["doc-carniprod", "doc-scandia"],
      "doc-scandia", // the most-recently-analyzed guess
    );
    expect(resolved).toEqual({ id: "doc-carniprod", declared: true });
  });

  it("falls back but says the fallback is NOT declared", () => {
    // Legacy rows have no pointer. The caller must be able to tell a
    // guess from a fact — that is what suppresses the badge.
    const resolved = resolveSourceDocumentId(facts(null), ["a", "b"], "b");
    expect(resolved).toEqual({ id: "b", declared: false });
  });

  it("refuses a pointer at a document that is no longer attached", () => {
    const resolved = resolveSourceDocumentId(
      facts(AGREED, { source_document_id: "doc-gone" }),
      ["doc-carniprod"],
      "doc-carniprod",
    );
    expect(resolved).toEqual({ id: "doc-carniprod", declared: false });
  });
});

// ─── the chip ────────────────────────────────────────────────────────────

describe("the chip on a period row", () => {
  it("renders nothing for a period the engine never judged", () => {
    const { container } = render(
      <PeriodFilingChip facts={facts(null)} onReview={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the document and the period agree", () => {
    const { container } = render(
      <PeriodFilingChip facts={facts(AGREED)} onReview={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("marks the audited Carniprod row as disputed", () => {
    render(<PeriodFilingChip facts={facts(DISPUTED)} onReview={() => {}} />);
    const chip = screen.getByTestId("pf-chip-p-2017-12");
    expect(chip.getAttribute("data-state")).toBe("mismatch");
  });

  it("marks an undated file as unknown, not as disputed", () => {
    render(<PeriodFilingChip facts={facts(UNKNOWN)} onReview={() => {}} />);
    expect(screen.getByTestId("pf-chip-p-2017-12").getAttribute("data-state")).toBe(
      "unknown",
    );
  });

  it("opens the review in one tap and does not change anything itself", () => {
    const onReview = vi.fn();
    render(<PeriodFilingChip facts={facts(DISPUTED)} onReview={onReview} />);
    fireEvent.click(screen.getByTestId("pf-chip-p-2017-12"));
    expect(onReview).toHaveBeenCalledTimes(1);
  });
});

// ─── the file row ────────────────────────────────────────────────────────

function renderRow(over: Partial<React.ComponentProps<typeof PeriodFileRow>> = {}) {
  const onMove = vi.fn();
  render(
    <PeriodFileRow
      orgId="org-1"
      file={{
        id: "doc-carniprod",
        filename: "Carniprod Trial Balance 2025.xlsx",
        status: "analyzed",
        uploaded_at: "2026-01-14T09:00:00Z",
      }}
      isSource
      showRole
      detection={DISPUTED}
      onMove={onMove}
      onChanged={() => {}}
      {...over}
    />,
  );
  return { onMove };
}

describe("a file row shows two different facts", () => {
  it("shows the upload date and the document's own date side by side", () => {
    renderRow();
    // The eight-year gap the old row could not show: uploaded in 2026,
    // document dated 2025, filed under 2017.
    expect(screen.getByText(/Uploaded/)).toBeTruthy();
    expect(screen.getByText(/File says/)).toBeTruthy();
    expect(screen.getByText(/Dec 2025/)).toBeTruthy();
  });

  it("says the document's date was never recorded rather than borrowing one", () => {
    renderRow({ detection: null });
    expect(screen.getByText(/File date not recorded/)).toBeTruthy();
    expect(screen.queryByText(/File says/)).toBeNull();
  });

  it("labels the analysis source and its attachments", () => {
    renderRow();
    expect(screen.getByTestId("pf-file-source-doc-carniprod")).toBeTruthy();
    cleanup();
    renderRow({ isSource: false });
    expect(screen.getByTestId("pf-file-attachment-doc-carniprod")).toBeTruthy();
  });

  it("draws no role badge when the engine declared no source", () => {
    // showRole=false is what the caller passes for a legacy period. A
    // guess must never be dressed as a fact.
    renderRow({ showRole: false });
    expect(screen.queryByTestId("pf-file-source-doc-carniprod")).toBeNull();
    expect(screen.queryByTestId("pf-file-attachment-doc-carniprod")).toBeNull();
  });

  it("offers the move from the file's own menu", () => {
    const { onMove } = renderRow();
    // Radix opens the menu on pointerdown / keyboard, not on a synthetic
    // click — Enter is the keyboard path a real user has too.
    fireEvent.keyDown(screen.getByTestId("pf-file-menu-doc-carniprod"), {
      key: "Enter",
    });
    fireEvent.click(screen.getByTestId("pf-file-move-doc-carniprod"));
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove.mock.calls[0][0].id).toBe("doc-carniprod");
  });

  it("keeps the menu reachable without a hover", () => {
    // r1 defect 1. The kebab was `opacity-0` until hover, so on a touch
    // device the ONLY route to "Move to another period…" did not exist.
    renderRow();
    const trigger = screen.getByTestId("pf-file-menu-doc-carniprod");
    expect(trigger.className).not.toMatch(/(^|\s)opacity-0(\s|$)/);
  });

  it("cannot promote the file that is already the source", () => {
    renderRow();
    // Radix opens the menu on pointerdown / keyboard, not on a synthetic
    // click — Enter is the keyboard path a real user has too.
    fireEvent.keyDown(screen.getByTestId("pf-file-menu-doc-carniprod"), {
      key: "Enter",
    });
    expect(
      screen.getByTestId("pf-file-makesource-doc-carniprod").getAttribute("aria-disabled"),
    ).toBe("true");
  });
});

// ─── the review, after r1 ────────────────────────────────────────────────

function renderReview(detection: PeriodDetection) {
  const onChooseMonth = vi.fn();
  const onMoved = vi.fn();
  render(
    <PeriodFilingReviewDialog
      orgId="org-1"
      target={{
        facts: facts(detection),
        documentId: "doc-carniprod",
        documentName: "Carniprod Trial Balance 2025.xlsx",
      }}
      onClose={() => {}}
      onMoved={onMoved}
      onChooseMonth={onChooseMonth}
    />,
  );
  return { onChooseMonth, onMoved };
}

describe("the review always leaves a way to act", () => {
  it("offers the month picker when the engine found no month at all", () => {
    // r1 defect 2. This state told the reader to "pick the month it
    // really covers" and then offered only "Keep it here" — a dead end
    // in precisely the case that cannot be resolved any other way.
    const { onChooseMonth } = renderReview(UNKNOWN);
    fireEvent.click(screen.getByTestId("pf-review-choose"));
    expect(onChooseMonth).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("pf-review-move")).toBeNull();
  });

  it("keeps the detected month primary but still allows another", () => {
    renderReview(DISPUTED);
    expect(screen.getByTestId("pf-review-move").textContent).toContain("Dec 2025");
    expect(screen.getByTestId("pf-review-choose")).toBeTruthy();
  });

  it("names the confirmed month instead of saying 'this month'", () => {
    // r1 defect 4: "this month" sat under "THE FILE SAYS Dec 2025" and
    // read as Dec 2025 when it meant Dec 2017.
    renderReview(DISPUTED);
    expect(screen.getByText(/A person confirmed Dec 2017 for this file/)).toBeTruthy();
  });

  it("shows both months side by side, labelled", () => {
    renderReview(DISPUTED);
    expect(screen.getByTestId("pf-review-filed-as").textContent).toContain("Dec 2017");
    expect(screen.getByTestId("pf-review-file-says").textContent).toContain("Dec 2025");
  });

  it("keeping it here changes nothing", () => {
    const { onMoved } = renderReview(DISPUTED);
    fireEvent.click(screen.getByTestId("pf-review-keep"));
    expect(onMoved).not.toHaveBeenCalled();
  });
});
