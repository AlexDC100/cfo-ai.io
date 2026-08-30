// THE CARD, MEASURED THE WAY THE BASELINE WAS MEASURED.
//
// `design_review/findings/BASELINE.md` audited PRODUCTION rows, not
// intentions: 80% carried no imperative verb, 58% carried fewer than two
// figures, and the worked 461 note scored 1.5 of the seven elements.
// These tests re-run those same measurements against the rendered DOM,
// so the rebuild is checked by the metric it was written to move — and
// so a future refactor that quietly drops a region fails here rather
// than in someone's board pack.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// In-memory localStorage (this jsdom build ships a broken one) — the
// same shim `simple/__tests__/statementDisclosure.test.tsx` installs.
const bag = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => bag.get(k) ?? null,
    setItem: (k: string, v: string) => void bag.set(k, String(v)),
    removeItem: (k: string) => void bag.delete(k),
    clear: () => void bag.clear(),
    key: (i: number) => [...bag.keys()][i] ?? null,
    get length() {
      return bag.size;
    },
  },
});

const RATES = { EUR: 1, RON: 5.2489, USD: 1.16 };

vi.mock("@/stores/currency", () => ({
  useCurrency: () => ({
    display: "EUR",
    rates: { rates: RATES, as_of: "2026-05-22", source: "BNR", stale: false },
    setDisplay: () => {},
    refresh: async () => {},
    refreshing: false,
  }),
  useDisplayCurrency: () => "EUR",
  useRates: () => ({ rates: RATES }),
  useAmountFormatter: () => (v: number | null | undefined) => String(v ?? ""),
}));

import { buildFindingsReport, type FindingDismissal } from "@/lib/findings";
import { FindingCard } from "../FindingCard";
import { FindingsPanel } from "../FindingsPanel";

import { ENGINE_REPORT, ENGINE_SILENCE } from "./engineFixture";

const MODE_KEY = "cfo-view-mode-v1";

/** The lexicon from `_finding.BANNED_PHRASES` — the exact strings the
 *  baseline's five worst rows shipped. */
const BANNED = [
  "should be monitored",
  "may warrant review",
  "consider evaluating",
  "best practice",
  "should be confirmed",
  "should be reviewed",
];

/** `_finding._NUMBER_RX`, ported. */
const NUMBER_RX = /-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?/g;

function report() {
  return buildFindingsReport(ENGINE_REPORT);
}

function renderCard(mode: "simple" | "pro", onDismiss?: (d: FindingDismissal) => void) {
  localStorage.setItem(MODE_KEY, mode);
  const finding = report().surfaced[0];
  return render(
    <MemoryRouter>
      <FindingCard finding={finding} onDismiss={onDismiss} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
});

// ── the seven, visible ─────────────────────────────────────────────────

describe("the contract is visible on the card", () => {
  it("renders a region per element, each labelled", () => {
    renderCard("pro");
    // subject — the account code is on the page, so the sentence is about
    // one book and cannot be reused for another company
    expect(screen.getByTestId("fnd-card-concentration_related_party").textContent).toContain(
      "461",
    );
    expect(screen.getByTestId("fnd-evidence")).toBeInTheDocument();
    expect(screen.getByTestId("fnd-provenance-dots")).toBeInTheDocument();
    expect(screen.getByTestId("fnd-threshold")).toBeInTheDocument();
    expect(screen.getByTestId("fnd-impact")).toBeInTheDocument();
    expect(screen.getByTestId("fnd-whyhere")).toBeInTheDocument();
    expect(screen.getByTestId("fnd-action")).toBeInTheDocument();
    expect(screen.getByTestId("fnd-confidence")).toBeInTheDocument();
  });

  it("states the rule, the limit and the observed value", () => {
    renderCard("pro");
    const text = screen.getByTestId("fnd-threshold").textContent ?? "";
    expect(text).toContain("concentration_related_party");
    expect(text).toContain("above");
    expect(text).toContain("10.0%"); // the limit the baseline never printed
    expect(text).toContain("19.6%"); // observed
    expect(text).toContain("profiles.yaml"); // where the parameter came from
  });

  it("shows provenance as filled dots for what the payload carries", () => {
    renderCard("pro");
    const dots = screen
      .getByTestId("fnd-provenance-dots")
      .querySelectorAll("[data-filled]");
    expect(dots).toHaveLength(4);
    // period + snapshot + line refs + source — all four present here
    expect(Array.from(dots).every((d) => d.getAttribute("data-filled") === "1")).toBe(true);
  });

  it("draws a hollow dot for provenance the payload does NOT carry", () => {
    localStorage.setItem(MODE_KEY, "pro");
    const built = report();
    const f = built.surfaced[0];
    const stripped = {
      ...f,
      elements: {
        ...f.elements,
        evidence: {
          ...f.elements.evidence!,
          provenance: { ...f.elements.evidence!.provenance!, snapshot_id: null },
        },
      },
    };
    render(
      <MemoryRouter>
        <FindingCard finding={stripped} />
      </MemoryRouter>,
    );
    const dots = Array.from(
      screen.getByTestId("fnd-provenance-dots").querySelectorAll("[data-filled]"),
    ).map((d) => d.getAttribute("data-filled"));
    expect(dots).toEqual(["1", "0", "1", "1"]);
  });
});

// ── the baseline's own metrics, re-run on the DOM ──────────────────────

describe("the measured baseline gates, re-run on the rendered card", () => {
  it("carries at least two figures (58% of the baseline failed this)", () => {
    renderCard("pro");
    const text = screen.getByTestId("fnd-card-concentration_related_party").textContent ?? "";
    expect((text.match(NUMBER_RX) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("carries an imperative verb (80% of the baseline failed this)", () => {
    renderCard("pro");
    const text = (
      screen.getByTestId("fnd-card-concentration_related_party").textContent ?? ""
    ).toLowerCase();
    expect(text).toContain("pull");
    expect(text).toContain("recompute");
  });

  it("carries none of the banned boilerplate", () => {
    renderCard("pro");
    const text = (
      screen.getByTestId("fnd-card-concentration_related_party").textContent ?? ""
    ).toLowerCase();
    for (const phrase of BANNED) expect(text).not.toContain(phrase);
  });

  it("names the artefact and the provider for every step", () => {
    renderCard("pro");
    const text = screen.getByTestId("fnd-action").textContent ?? "";
    expect(text).toContain("461 aging schedule per related entity");
    expect(text).toContain("the group financial controller");
    expect(text).toContain("restated covenant calculation");
    expect(text).toContain("the treasury team");
  });
});

// ── one currency per claim ─────────────────────────────────────────────

describe("one currency per rendered claim", () => {
  it("routes every money figure through the same conversion decision", () => {
    const { container } = renderCard("pro");
    const currencies = Array.from(
      container.querySelectorAll("[data-narrative-money]"),
    ).map((n) => n.getAttribute("data-narrative-currency"));
    expect(currencies.length).toBeGreaterThanOrEqual(2);
    expect(new Set(currencies).size).toBe(1);
    expect(currencies[0]).toBe("EUR");
  });

  it("leaves no native RON label beside a converted figure", () => {
    const { container } = renderCard("pro");
    // The exact defect: "RON 7,692,203" surviving next to a EUR sibling.
    expect(container.textContent ?? "").not.toContain("RON 7,692,203");
  });

  it("never converts a dimensionless value", () => {
    const { container } = renderCard("pro");
    const text = container.textContent ?? "";
    // A percent, and a ratio impact — both dimensionless, both native at
    // EUR display while the money beside them converted.
    expect(text).toContain("19.6%");
    expect(text).toContain("2.12×");
    expect(text).toContain("1.52×");
  });
});

// ── the dial ───────────────────────────────────────────────────────────

describe("Simple and Pro over one payload", () => {
  it("Simple gives a plain headline with two figures and exactly ONE action", () => {
    renderCard("simple");
    const card = screen.getByTestId("fnd-card-concentration_related_party");
    expect(card.getAttribute("data-mode")).toBe("simple");
    // headline built from the same typed values — scope, observed, limit
    expect(card.textContent).toContain("Related-party receivable on 461");
    expect(card.textContent).toContain("19.6%");
    expect(card.textContent).toContain("10.0%");
    // one step, not two
    expect(screen.getByTestId("fnd-action").querySelectorAll("li")).toHaveLength(1);
    // and no rule id / threshold source / materiality policy in the
    // reader's face
    expect(card.textContent).not.toContain("profiles.yaml");
    expect(card.textContent).not.toContain("floor 0.50%");
    expect(screen.queryByTestId("fnd-threshold")).toBeNull();
  });

  it("Simple offers the four moves that act on this finding, not six", () => {
    renderCard("simple");
    expect(screen.getByTestId("fnd-act-evidence")).toBeInTheDocument();
    expect(screen.getByTestId("fnd-act-recompute")).toBeInTheDocument();
    expect(screen.getByTestId("fnd-act-ask")).toBeInTheDocument();
    expect(screen.getByTestId("fnd-act-dismiss")).toBeInTheDocument();
    // analyst work rides with the full check
    expect(screen.queryByTestId("fnd-act-compare")).toBeNull();
    expect(screen.queryByTestId("fnd-act-pack")).toBeNull();

    fireEvent.click(screen.getByTestId("fnd-expand"));
    expect(screen.getByTestId("fnd-act-compare")).toBeInTheDocument();
    expect(screen.getByTestId("fnd-act-pack")).toBeInTheDocument();
  });

  it("Simple can open the full check without switching mode", () => {
    renderCard("simple");
    fireEvent.click(screen.getByTestId("fnd-expand"));
    expect(screen.getByTestId("fnd-threshold")).toBeInTheDocument();
    expect(screen.getByTestId("fnd-action").querySelectorAll("li")).toHaveLength(2);
  });

  it("Pro adds the rule id, the threshold source and the score breakdown", () => {
    renderCard("pro");
    const card = screen.getByTestId("fnd-card-concentration_related_party");
    expect(card.getAttribute("data-mode")).toBe("pro");
    expect(card.textContent).toContain("concentration_related_party");
    expect(card.textContent).toContain("profiles.yaml");
    expect(card.textContent).toContain("score 0.468");
    // ...and the method behind the recomputed figure
    expect(card.textContent).toContain("recomputed_ratio");
    expect(card.textContent).toContain("current_ratio_ex_related_party");
  });
});

// ── recompute reads, it does not compute ───────────────────────────────

describe("recompute without this item", () => {
  it("reveals the engine's adjusted figure and never derives one", () => {
    renderCard("pro");
    const impact = screen.getByTestId("fnd-impact");
    expect(impact.getAttribute("data-recomputed")).toBe("0");
    // Both endpoints are on the page before and after — the toggle
    // changes emphasis, not arithmetic.
    expect(impact.textContent).toContain("2.12×");
    expect(impact.textContent).toContain("1.52×");

    fireEvent.click(screen.getByTestId("fnd-act-recompute"));
    const after = screen.getByTestId("fnd-impact");
    expect(after.getAttribute("data-recomputed")).toBe("1");
    expect(after.textContent).toContain("1.52×");
    // the delta is the engine's, printed as sent
    expect(after.textContent).toContain("0.59");
  });
});

// ── dismissal is a decision, and it is visible ─────────────────────────

describe("dismissal", () => {
  it("refuses to submit without a reason", () => {
    renderCard("pro");
    fireEvent.click(screen.getByTestId("fnd-act-dismiss"));
    const confirm = screen.getByTestId("fnd-dismiss-confirm") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
  });

  it("hands back a payload scoped to the rule AND the subject", () => {
    const seen: FindingDismissal[] = [];
    renderCard("pro", (d) => seen.push(d));
    fireEvent.click(screen.getByTestId("fnd-act-dismiss"));
    fireEvent.change(screen.getByLabelText(/reason/i), {
      target: { value: "settles 15 Jan" },
    });
    fireEvent.click(screen.getByTestId("fnd-dismiss-confirm"));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      rule_id: "concentration_related_party",
      scope_key: "461+451+452+455",
      reason: "settles 15 Jan",
    });
  });

  it("states the scope it will apply to before the reader confirms", () => {
    renderCard("pro");
    fireEvent.click(screen.getByTestId("fnd-act-dismiss"));
    expect(screen.getByTestId("fnd-dismiss-form").textContent).toContain(
      "concentration_related_party",
    );
    expect(screen.getByTestId("fnd-dismiss-form").textContent).toContain(
      "461+451+452+455",
    );
  });
});

// ── the export pack ────────────────────────────────────────────────────

describe("export pack", () => {
  it("toggles the finding in and out, and says how many are in", () => {
    localStorage.setItem(MODE_KEY, "pro");
    render(
      <MemoryRouter>
        <FindingsPanel report={report()} />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId("fnd-pack-count")).toBeNull();
    // One button per card; the count only counts SURFACED findings.
    const buttons = screen.getAllByTestId("fnd-act-pack");
    fireEvent.click(buttons[0]);
    expect(screen.getByTestId("fnd-pack-count").textContent).toContain("1");
    fireEvent.click(screen.getAllByTestId("fnd-act-pack")[0]);
    expect(screen.queryByTestId("fnd-pack-count")).toBeNull();
  });
});

// ── demoted findings and silence ───────────────────────────────────────

describe("demoted findings never appear as recommendations", () => {
  it("lists them under All checks with the missing element, and no prose", () => {
    localStorage.setItem(MODE_KEY, "pro");
    render(
      <MemoryRouter>
        <FindingsPanel report={report()} />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId("fnd-card-input_cost_exposure")).toBeNull();
    fireEvent.click(screen.getByTestId("fnd-checks-toggle"));
    const panel = screen.getByTestId("fnd-all-checks");
    const checks = panel.textContent ?? "";
    expect(checks).toContain("no action supplied");
    // ...and it is filed as DEMOTED, not lumped in with the rules that
    // surfaced above it.
    const demotedGroup = screen.getByTestId("fnd-checks-group-demoted");
    expect(demotedGroup.textContent).toContain("input_cost_exposure");
    expect(demotedGroup.textContent).not.toContain("concentration_related_party");
    // The reason is stated ONCE. `rank_findings._check_from` concatenates
    // a note that already embeds the reasons with `demotion_reason`,
    // which is the same reasons again.
    const occurrences = (demotedGroup.textContent ?? "").split(
      "action: no action supplied",
    ).length - 1;
    expect(occurrences).toBe(1);
  });

  it("files a SURFACED rule's own check row under 'shown above'", () => {
    // The first classifier put every fired check in the demoted group,
    // which told the reader that the recommendations above had been
    // demoted. Disposition is a lookup against the report, not a guess.
    localStorage.setItem(MODE_KEY, "pro");
    render(
      <MemoryRouter>
        <FindingsPanel report={report()} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("fnd-checks-toggle"));
    const shown = screen.getByTestId("fnd-checks-group-shown");
    expect(shown.textContent).toContain("concentration_related_party");
    expect(shown.textContent).toContain("liquidity_cash_tight");
  });

  it("prints the engine's own statement about what is shown", () => {
    localStorage.setItem(MODE_KEY, "pro");
    render(
      <MemoryRouter>
        <FindingsPanel report={report()} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("fnd-all-checks").textContent).toContain(
      "2 finding(s) surfaced",
    );
  });
});

describe("F8 — silence is valid", () => {
  const silent = () =>
    buildFindingsReport({ report: { surfaced: [] }, silence: ENGINE_SILENCE });

  it("states the claim verbatim and lists what was checked", () => {
    render(
      <MemoryRouter>
        <FindingsPanel report={silent()} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("fnd-silence-statement").textContent).toBe(
      (ENGINE_SILENCE as { statement: string }).statement,
    );
    const panel = screen.getByTestId("fnd-all-checks");
    const checks = panel.textContent ?? "";
    expect(checks).toContain("leverage_debt_to_ebitda");
    expect(checks).toContain("receivables_allowance_quality");
    // Every check states its parameter, its limit and what it saw.
    expect(checks).toContain("allowance_share_high");
    expect(checks).toContain("15.0%");
    // ABSENT IS NOT ZERO: a rule that could not form its quantity says
    // which field was missing instead of reporting 0.
    expect(checks).toContain("asset_maturity");
    expect(checks).toContain("not run:");
    // The printed figure follows the engine's own per-unit rounding
    // (`_format_value`: a count prints whole), and the EXACT value the
    // rule judged is carried alongside so an audit never loses it.
    const exact = Array.from(panel.querySelectorAll("[data-observed-exact]")).map((n) =>
      n.getAttribute("data-observed-exact"),
    );
    expect(exact).toContain("0.19761700568498627");
  });

  it("renders NOTHING when the period carries no contract rows at all", () => {
    const legacy = buildFindingsReport([{ id: "x", rule_key: "old", title: "t" }]);
    const { container } = render(
      <MemoryRouter>
        <FindingsPanel report={legacy} />
      </MemoryRouter>,
    );
    // A period the rules never ran on must not be told it is quiet.
    expect(container.querySelector("[data-testid='fnd-panel']")).toBeNull();
    expect(container.textContent).toBe("");
  });
});
