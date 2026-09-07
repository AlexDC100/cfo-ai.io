// G5 — THE INDUSTRY GATE.
//
// THE DEFECT. The Agras Dec-2025 report was headed "Real estate ·
// residential rental" over a trial balance carrying 301 raw materials,
// 341/345 own-produced stock, 371 merchandise and 70.5M of cost of
// sales — and the sector-calibrated content downstream followed the
// SETTING, not the book: recommendations about vacancy, LTV and
// single-tenant risk on a food factory. `organizations.industry_key` is
// a user setting and nothing checked it against the account mix.
//
// WHAT THIS GATE ASSERTS, over the RENDERED DOM of the real report page
// (TC-7), on ALL FOUR committed books:
//
//   A. MIS-SET workspace → the confirm prompt is present and names BOTH
//      sectors; no sector-calibrated content renders anywhere; no
//      real-estate vocabulary (EN + RO) survives outside the prompt
//      itself, which must name the sector to do its job.
//   B. MIS-SET workspace → the sector-INDEPENDENT report still renders:
//      P&L, balance sheet, cash flow and ratios are all on the page with
//      their figures. A block that blanks the report is not a fix.
//   C. AGREEING workspace → no prompt, and the same sector-calibrated
//      content renders normally. THIS IS THE NON-VACUITY HALF: without
//      it the gate would pass by blocking everything, always.
//
// WHAT IS REAL HERE AND WHAT IS A STAND-IN.
//   · The report page, the served statements, the served metrics and the
//     `industry_signal` block are all REAL engine output. The signal
//     comes from `tests/engine/fixtures/firm/industry_signal.json`,
//     written by `capture_industry_signal.py` from the real module;
//     `tests/engine/test_structural_industry_signal.py` reds if it goes
//     stale, so this gate cannot pass over a payload production never
//     serves.
//   · The AI narrative half (`recommendations` / `alerts` / `briefing`)
//     is a STAND-IN carrying the vocabulary the owner reported reading.
//     The engine's Opus narrative is not reproducible in a unit test and
//     no committed fixture carries it. The claim under test is therefore
//     "whatever sector-calibrated content the server sends, this page
//     does not render it while the industry is in doubt" — which the
//     stand-in tests exactly, because the stand-in is the INPUT, not a
//     double for anything under test.
//
// WHAT THIS GATE CANNOT SEE (TC-11): it cannot see whether the ENGINE
// still writes real-estate vocabulary into the narrative for a mis-set
// workspace — only that the report refuses to render it. It cannot see
// the standalone HTML export (`renderReportHtml`), which carries its own
// header industry line and its own profile-gated rules; that surface has
// its own gate in `frontend/lib/__tests__/industryBlockExport.test.ts`.
// And it cannot see a book whose account mix is UNREADABLE: on those the
// signal returns `undetermined`, nothing is blocked, and the workspace
// setting stands unchallenged — by design, and asserted engine-side.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi, afterEach } from "vitest";

// Environment only — nothing sector-shaped is stubbed. `RiskInventory`
// and the recommendation list stay REAL, because they are the surfaces
// under test: a gate that mocked them away could not tell a blocked
// report from a rendered one.
vi.mock("@/stores/currency", () => ({
  useCurrency: () => ({ display: "RON", rates: { rates: {} } }),
  CurrencyProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/lib/supabase", () => ({ getSupabase: () => null }));
const stableToast = { toast: () => undefined };
vi.mock("@/hooks/use-toast", () => ({ useToast: () => stableToast }));
vi.mock("@/hooks/useActivePeriodFallback", () => ({
  useActivePeriodFallback: () => ({ periodId: "p", status: "resolved" }),
}));
vi.mock("@/components/learning/GuideMeButton", () => ({ GuideMeButton: () => null }));
vi.mock("@/components/learning/LearnableNumber", () => ({
  LearnableNumber: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { TooltipProvider } from "@/components/ui/tooltip";
import ComprehensiveReport from "@/pages/cfo/ComprehensiveReport";

const repoRoot = resolve(__dirname, "../../../..");
const firm = (name: string) => resolve(repoRoot, "tests/engine/fixtures/firm", name);

const BOOKS = ["agras", "carniprod", "realestate", "retail"] as const;
type Book = (typeof BOOKS)[number];

/** The workspace setting each book is rendered under. `wrong` is a
 *  DIFFERENT FAMILY from what the book reads; `right` agrees with it. */
const SETTINGS: Record<Book, { wrong: string; right: string }> = {
  agras: { wrong: "real_estate_residential", right: "manufacturing" },
  carniprod: { wrong: "real_estate_residential", right: "manufacturing" },
  retail: { wrong: "real_estate_residential", right: "retail_ecom" },
  realestate: { wrong: "manufacturing", right: "real_estate_residential" },
};

const SIGNALS = JSON.parse(
  readFileSync(firm("industry_signal.json"), "utf-8"),
) as Record<Book, Record<string, Record<string, unknown>>>;

const SERVED_METRICS = JSON.parse(
  readFileSync(firm("served_metrics.json"), "utf-8"),
) as Record<Book, Record<string, number | null>>;

function fixtureFor(book: Book) {
  return JSON.parse(readFileSync(firm(`saga_10_col_${book}.json`), "utf-8")) as {
    currency: string;
    period_end: string;
    statements: Record<string, unknown>;
    line_items?: Array<Record<string, unknown>>;
  };
}

// ── The sector-calibrated content the server sends ─────────────────────
// Carries the vocabulary the owner reported on the Agras export. Every
// piece is tagged with a probe string the assertions look for, so a
// half-blocked section (recs hidden, alerts leaking) still reds.
const SECTOR_RECS = [
  {
    severity: "critical",
    title: "Re-underwrite the single-tenant lease before the LTV test",
    why: "Vacancy risk is concentrated in one tenant.",
    action: "Model the exit cap rate against the lender's LTV covenant.",
    impact: "Protects the rent roll through the renewal window.",
  },
  {
    severity: "high",
    title: "Build a property-tax reassessment provision",
    why: "Investment property carries a material book value.",
    action: "Pre-engage a property tax advisor.",
    impact: "Keeps DSCR clear of the covenant floor.",
  },
];

const SECTOR_ALERTS = [
  {
    id: "a-cre-1",
    alert_key: "tenant_concentration",
    // Section 7 selects on this prefix — see `RiskInventory`.
    rule_key: "risk_inventory_tenant_concentration",
    title: "Tenant concentration: occupancy exposed to a single lease",
    body: "The top tenant carries the rent roll; a vacancy here moves the LTV test.",
    severity: "high",
    industry: "real_estate_residential",
  },
];

const SECTOR_BRIEFING = {
  summary:
    "Occupancy held steady across the portfolio; vacancy remains the dominant swing factor for NOI.",
  body:
    "Occupancy held steady across the portfolio; vacancy remains the dominant swing factor for NOI.",
};

/** Words that only belong in a real-estate report. Deliberately NOT the
 *  sector NAMES ("real estate", "residential") — the confirm prompt has
 *  to print those to name the disagreement. RO forms included because
 *  the narrative follows the UI language. */
const REAL_ESTATE_VOCABULARY = [
  "vacancy",
  "ltv",
  "single-tenant",
  "single tenant",
  "cap rate",
  "rent roll",
  "occupancy",
  "noi",
  "tenant",
  // RO
  "grad de ocupare",
  "chiria",
  "chirias",
  "chiriaș",
  "rata de capitalizare",
  "venit net din exploatare",
];

function periodResponse(book: Book, workspaceKey: string) {
  const fx = fixtureFor(book);
  return {
    period: {
      id: `p-${book}`,
      period_end: fx.period_end,
      currency: fx.currency,
      source_document: { filename: `${book}.xlsx`, id: `d-${book}` },
    },
    organization: {
      id: `o-${book}`,
      name: book,
      industry_key: workspaceKey,
      industry_display_name: (SIGNALS[book][workspaceKey] as { workspace: { display: string } })
        .workspace.display,
    },
    industry_signal: SIGNALS[book][workspaceKey],
    statements: { companyName: book, ...fx.statements },
    metrics: Object.entries(SERVED_METRICS[book]).map(([name, value]) => ({
      name,
      value,
      unit: "RON",
      direction: "neutral",
    })),
    line_items: fx.line_items ?? [],
    alerts: SECTOR_ALERTS,
    recommendations: SECTOR_RECS,
    briefing: SECTOR_BRIEFING,
  };
}

async function mount(book: Book, workspaceKey: string): Promise<HTMLElement> {
  const body = periodResponse(book, workspaceKey);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => body })),
  );
  render(
    <TooltipProvider>
      <MemoryRouter initialEntries={[`/report?period=p-${book}`]}>
        <ComprehensiveReport />
      </MemoryRouter>
    </TooltipProvider>,
  );
  return screen.findByTestId("comprehensive-report");
}

/** All rendered text of the report EXCEPT the confirm prompt, which is
 *  required to name the sectors it is asking about. */
function textOutsideBanner(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('[data-testid="industry-confirm-banner"]').forEach((n) => n.remove());
  return (clone.textContent ?? "").toLowerCase();
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("G5 — sector-calibrated content is blocked when the account mix disagrees with the workspace", () => {
  it.each(BOOKS)(
    "%s: a mis-set workspace raises the confirm prompt naming BOTH sectors",
    async (book) => {
      const root = await mount(book, SETTINGS[book].wrong);
      const banner = within(root).getByTestId("industry-confirm-banner");
      const signal = SIGNALS[book][SETTINGS[book].wrong] as {
        display: string;
        workspace: { display: string };
      };
      expect(within(banner).getByTestId("industry-signal-family")).toHaveTextContent(
        signal.display,
      );
      expect(within(banner).getByTestId("industry-workspace-setting")).toHaveTextContent(
        signal.workspace.display,
      );
      // The evidence, not a bare label: the accounts the reading rests on.
      expect(within(banner).getByTestId("industry-signal-evidence")).toBeInTheDocument();
    },
  );

  it.each(BOOKS)("%s: no sector-calibrated content renders while it is in doubt", async (book) => {
    const root = await mount(book, SETTINGS[book].wrong);
    const text = textOutsideBanner(root);
    for (const rec of SECTOR_RECS) {
      expect(text).not.toContain(rec.title.toLowerCase());
    }
    for (const alert of SECTOR_ALERTS) {
      expect(text).not.toContain(alert.title.toLowerCase());
    }
    expect(text).not.toContain(SECTOR_BRIEFING.summary.slice(0, 40).toLowerCase());
  });

  it.each(BOOKS)("%s: no real-estate vocabulary survives outside the prompt", async (book) => {
    const root = await mount(book, SETTINGS[book].wrong);
    const text = textOutsideBanner(root);
    const leaked = REAL_ESTATE_VOCABULARY.filter((w) => text.includes(w));
    expect(leaked, `leaked sector vocabulary on ${book}: ${leaked.join(", ")}`).toEqual([]);
  });

  it.each(BOOKS)("%s: the sector-INDEPENDENT report still renders in full", async (book) => {
    const root = await mount(book, SETTINGS[book].wrong);
    for (const id of [
      "report-section-2-pnl",
      "report-section-3-bs",
      "report-section-4-cf",
      "report-section-5-ratios",
      "report-section-6-valuation",
    ]) {
      const section = within(root).getByTestId(id);
      expect(section.textContent ?? "").not.toEqual("");
      expect(section.querySelectorAll("tr").length).toBeGreaterThan(2);
    }
  });

  it.each(BOOKS)(
    "%s: NON-VACUITY — an agreeing workspace shows no prompt and renders the sector view",
    async (book) => {
      const root = await mount(book, SETTINGS[book].right);
      expect(within(root).queryByTestId("industry-confirm-banner")).toBeNull();
      const text = (root.textContent ?? "").toLowerCase();
      for (const rec of SECTOR_RECS) {
        expect(text).toContain(rec.title.toLowerCase());
      }
      for (const alert of SECTOR_ALERTS) {
        expect(text).toContain(alert.title.toLowerCase());
      }
    },
  );
});
