// AI LANE — FE affordance tests (jurisdiction dropdown, AI-read badge,
// needs-review panel, re-extraction confirm flow). Contract semantics:
// docs/CANONICAL_BS_V2_CONTRACT.md + the AI-lane operator spec (2026-08-19):
//   · AI-lane output is permanently extraction.method "llm" +
//     classification.method "llm" and its status can NEVER be BALANCED —
//     the FE renders provenance verbatim and never derives it;
//   · the AI-read badge is permanent (no dismiss affordance) and its
//     tooltip carries model + prompt version + the review warning;
//   · canonical_bs.needs_review (ARRAY form) lists low-confidence lines
//     that sit in Unclassified rows pending human mapping — rendered as a
//     calm amber collapsible panel sorted by confidence ascending;
//   · the resolved jurisdiction renders as a badge with an override
//     select; changing it arms a confirm ("Re-extraction re-reads the
//     document with AI.") that calls cfoApi.reextractPeriod.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Currency store is context-backed (throws outside its provider in dev);
// mock the hooks the BS renderer consumes so the view renders standalone.
vi.mock("@/stores/currency", () => ({
  useAmountFormatter:
    () =>
    (v: number | null | undefined): string =>
      v === null || v === undefined ? "0" : String(Math.round(v * 100) / 100),
  useDisplayCurrency: () => "RON",
  useCurrency: () => ({ display: "RON", rates: { rates: {} } }),
  useRates: () => ({ rates: {} }),
  CurrencyProvider: ({ children }: { children: unknown }) => children,
}));

import { AiReadBadge, BSStatementView } from "@/components/cfo/BSStatementView";
import {
  JurisdictionSelect,
  jurisdictionHintFromSelection,
} from "@/components/cfo/JurisdictionSelect";
import { buildBSStatement } from "@/lib/buildBsStatement";
import type { CanonicalBs } from "@/lib/financialReport";
import { cfoApi } from "@/lib/cfoApi";
import { queryClient } from "@/lib/queryClient";

// ─── fixtures ────────────────────────────────────────────────────────────

const MODEL = "claude-sonnet-4-5";
const EXTRACT_PROMPT = "bs_extract_v3";

function deterministicCanonicalBs(overrides: Partial<CanonicalBs> = {}): CanonicalBs {
  return {
    schema: "bs_v2",
    mapping_version: "ro_omfp1802_v2",
    extraction: {
      method: "deterministic",
      parser_version: "tb_parser_v4",
      source_format: "saga_10_col",
      number_locale: "ro",
    },
    rows: [
      {
        id: "cash",
        section: "current_assets",
        label: "Cash at bank",
        account_codes: ["5121"],
        amount: 50,
        opening: null,
      },
    ],
    sections: [
      { id: "current_assets", subtotal: 50 },
      { id: "equity", subtotal: 50 },
    ],
    totals: {
      assets: 50,
      equity: 50,
      liabilities: 0,
      equity_plus_liabilities: 50,
      current_assets: 50,
      current_liabilities: 0,
    },
    difference: 0,
    status: "BALANCED",
    diagnosis: [],
    ...overrides,
  };
}

/** AI-lane envelope: llm extraction + classification, capped status (never
 *  BALANCED), resolved jurisdiction, unsorted needs_review entries. */
function llmCanonicalBs(overrides: Partial<CanonicalBs> = {}): CanonicalBs {
  return deterministicCanonicalBs({
    extraction: {
      method: "llm",
      parser_version: "tb_parser_v4",
      source_format: "llm_freeform",
      number_locale: "ro",
      model: MODEL,
      prompt_version: EXTRACT_PROMPT,
    },
    classification: {
      method: "llm",
      model: MODEL,
      prompt_version: "bs_classify_v2",
    },
    status: "MINOR_DRIFT",
    difference: 12.5,
    jurisdiction: { resolved: "RO", source: "hint" },
    // Deliberately UNSORTED, mixing 0..1 and 0..100 confidence forms.
    needs_review: [
      {
        account_code: "4511",
        label: "Decontări în cadrul grupului",
        amount: 1200,
        confidence: 0.92,
        rationale: "Group settlements — side ambiguous in the source",
      },
      {
        account_code: "473",
        label: "Decontări din operații în curs",
        amount: -300,
        confidence: 0.41,
        rationale: "Bifunctional account with no balance-side signal",
      },
      {
        code: "999x",
        name: "Unlabeled line",
        amount: 5,
        confidence: 77,
        rationale: "No account code printed on the row",
      },
    ],
    ...overrides,
  });
}

function renderView(cbs: CanonicalBs, periodId = "p1") {
  const statement = buildBSStatement({
    lineItems: [],
    entity: "Test SRL",
    asOf: "31.12.2025",
    comparativeDate: "01.01.2025",
    currency: "RON",
    canonicalBs: cbs,
  });
  return render(
    <MemoryRouter>
      <BSStatementView statement={statement} hideGuide periodId={periodId} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.spyOn(queryClient, "resetQueries").mockResolvedValue();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ─── jurisdiction dropdown (pre-scan) ────────────────────────────────────

describe("JurisdictionSelect — the pre-scan dropdown", () => {
  it("renders with Auto-detect as the default and all four options", () => {
    render(<JurisdictionSelect data-testid="period-confirm-jurisdiction" />);
    const select = screen.getByTestId("period-confirm-jurisdiction") as HTMLSelectElement;
    expect(select.value).toBe("auto");
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toEqual([
      "Auto-detect",
      "Romania",
      "Hungary",
      "Other (international)",
    ]);
  });

  it("maps the selection to the upload hint — Auto sends NO hint", () => {
    expect(jurisdictionHintFromSelection("auto")).toBeNull();
    expect(jurisdictionHintFromSelection("RO")).toBe("RO");
    expect(jurisdictionHintFromSelection("HU")).toBe("HU");
    expect(jurisdictionHintFromSelection("INTL")).toBe("INTL");
  });

  it("reports changes through onChange", () => {
    const onChange = vi.fn();
    render(<JurisdictionSelect onChange={onChange} />);
    fireEvent.change(screen.getByTestId("jurisdiction-select"), {
      target: { value: "HU" },
    });
    expect(onChange).toHaveBeenCalledWith("HU");
  });
});

// ─── AI-read badge ───────────────────────────────────────────────────────

describe("AI-read badge", () => {
  it("renders for llm extraction with model + prompt version + warning in the tooltip", () => {
    renderView(llmCanonicalBs());
    const badge = screen.getByTestId("ai-read-badge");
    expect(badge.textContent).toContain("AI-read");
    const title = badge.getAttribute("title") ?? "";
    expect(title).toContain(MODEL);
    expect(title).toContain(EXTRACT_PROMPT);
    expect(title).toContain(
      "Numbers were read by AI, not mechanically extracted — review before external use.",
    );
  });

  it("does NOT render for deterministic extraction", () => {
    renderView(deterministicCanonicalBs());
    expect(screen.queryByTestId("ai-read-badge")).toBeNull();
  });

  it("renders standalone from classification method llm alone (accuracy-banner mount)", () => {
    render(<AiReadBadge classification={{ method: "llm", model: MODEL }} />);
    expect(screen.getByTestId("ai-read-badge")).toBeInTheDocument();
  });

  it("renders null when neither method is llm", () => {
    const { container } = render(
      <AiReadBadge extraction={deterministicCanonicalBs().extraction} />,
    );
    expect(container.firstChild).toBeNull();
  });
});

// ─── needs-review panel ──────────────────────────────────────────────────

describe("Needs-review panel", () => {
  it("lists entries sorted by confidence ascending with code, label, amount and confidence %", () => {
    renderView(llmCanonicalBs());
    const panel = screen.getByTestId("bs-needs-review-panel");
    // Copy explains where these values sit.
    expect(panel.textContent).toContain(
      "These values sit in Unclassified rows pending human mapping",
    );
    expect(panel.textContent).toContain("Lines to review (3)");

    const entries = screen.getAllByTestId("bs-needs-review-entry");
    expect(entries).toHaveLength(3);
    // Ascending confidence: 41% (473) → 77% (999x) → 92% (4511). The 0..1
    // and 0..100 confidence forms normalize to the same scale.
    expect(entries[0].textContent).toContain("473");
    expect(entries[0].textContent).toContain("41% confidence");
    expect(entries[0].textContent).toContain("-300");
    expect(entries[0].textContent).toContain("Bifunctional account");
    expect(entries[1].textContent).toContain("999x");
    expect(entries[1].textContent).toContain("77% confidence");
    expect(entries[1].textContent).toContain("Unlabeled line");
    expect(entries[2].textContent).toContain("4511");
    expect(entries[2].textContent).toContain("92% confidence");
    expect(entries[2].textContent).toContain("1200");
  });

  it("is collapsible — toggling hides the lines, the header count stays", () => {
    renderView(llmCanonicalBs());
    const toggle = screen.getByTestId("bs-needs-review-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryAllByTestId("bs-needs-review-entry")).toHaveLength(0);
    // The panel itself never disappears.
    expect(screen.getByTestId("bs-needs-review-panel").textContent).toContain(
      "Lines to review (3)",
    );
    fireEvent.click(toggle);
    expect(screen.getAllByTestId("bs-needs-review-entry")).toHaveLength(3);
  });

  it("does not render when needs_review is empty or the boolean reconcile flag", () => {
    renderView(deterministicCanonicalBs());
    expect(screen.queryByTestId("bs-needs-review-panel")).toBeNull();
    cleanup();
    // Boolean form (auto-reconcile "needs manual mapping") must NOT feed
    // the AI-lane panel — it drives the status strip state instead.
    renderView(
      deterministicCanonicalBs({
        status: "MINOR_DRIFT",
        difference: -46.61,
        needs_review: true,
      }),
    );
    expect(screen.queryByTestId("bs-needs-review-panel")).toBeNull();
    expect(screen.getByTestId("bs-status-needs-review")).toBeInTheDocument();
  });
});

// ─── jurisdiction badge + re-extraction confirm flow ─────────────────────

describe("Jurisdiction badge + re-extraction", () => {
  it("shows the resolved jurisdiction on the served result", () => {
    renderView(llmCanonicalBs());
    const badge = screen.getByTestId("bs-jurisdiction-badge");
    expect(badge.textContent).toContain("Romania");
    // Override select carries the resolved value and no Auto option.
    const select = screen.getByTestId("bs-jurisdiction-override") as HTMLSelectElement;
    expect(select.value).toBe("RO");
    expect(Array.from(select.options).map((o) => o.value)).not.toContain("auto");
  });

  it("normalizes a bare string jurisdiction from the engine", () => {
    renderView(llmCanonicalBs({ jurisdiction: "HU" }));
    expect(screen.getByTestId("bs-jurisdiction-badge").textContent).toContain("Hungary");
  });

  it("changing the jurisdiction arms the confirm and Confirm calls the reextract API", async () => {
    const reextract = vi
      .spyOn(cfoApi, "reextractPeriod")
      .mockResolvedValue({ ok: true });

    renderView(llmCanonicalBs(), "p1");
    fireEvent.change(screen.getByTestId("bs-jurisdiction-override"), {
      target: { value: "HU" },
    });

    const confirm = screen.getByTestId("bs-jurisdiction-confirm");
    expect(confirm.textContent).toContain(
      "Re-extraction re-reads the document with AI.",
    );
    // Nothing fires until the explicit confirm.
    expect(reextract).not.toHaveBeenCalled();

    fireEvent.click(within(confirm).getByTestId("bs-jurisdiction-reextract"));
    await waitFor(() => expect(reextract).toHaveBeenCalledWith("p1", "HU"));
    // The period query is reset so the re-extracted result refetches.
    expect(queryClient.resetQueries).toHaveBeenCalledWith({
      queryKey: ["period", "p1"],
    });
    // Confirm affordance disarms after success.
    await waitFor(() =>
      expect(screen.queryByTestId("bs-jurisdiction-confirm")).toBeNull(),
    );
  });

  it("Cancel disarms without calling the API", () => {
    const reextract = vi.spyOn(cfoApi, "reextractPeriod").mockResolvedValue({ ok: true });
    renderView(llmCanonicalBs(), "p1");
    fireEvent.change(screen.getByTestId("bs-jurisdiction-override"), {
      target: { value: "INTL" },
    });
    fireEvent.click(screen.getByTestId("bs-jurisdiction-cancel"));
    expect(screen.queryByTestId("bs-jurisdiction-confirm")).toBeNull();
    expect(reextract).not.toHaveBeenCalled();
  });

  it("a failed re-extraction shows a calm inline note and keeps the confirm armed", async () => {
    vi.spyOn(cfoApi, "reextractPeriod").mockRejectedValue(new Error("engine down"));
    renderView(llmCanonicalBs(), "p1");
    fireEvent.change(screen.getByTestId("bs-jurisdiction-override"), {
      target: { value: "HU" },
    });
    fireEvent.click(screen.getByTestId("bs-jurisdiction-reextract"));
    const note = await screen.findByTestId("bs-jurisdiction-error");
    expect(note.textContent).toContain("Couldn't start re-extraction");
    expect(screen.getByTestId("bs-jurisdiction-confirm")).toBeInTheDocument();
  });
});

// ─── honesty invariant: llm status is never BALANCED ─────────────────────

describe("AI-lane status rendering", () => {
  it("renders the llm fixture's capped status verbatim (MINOR_DRIFT, never a green BALANCED strip)", () => {
    renderView(llmCanonicalBs());
    expect(screen.getByTestId("bs-status-minor-drift")).toBeInTheDocument();
    expect(screen.queryByTestId("bs-status-balanced")).toBeNull();
  });
});
