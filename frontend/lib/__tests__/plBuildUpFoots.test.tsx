// G2 — THE P&L FOOTS.
//
// Every rendered build-up sums, line by line, to the figure it ends on,
// on all four firm books. A reader who adds the column the report shows
// them must land on the number the report prints at the bottom of it;
// where they cannot, the difference is a LABELLED line in the same
// column, never a silent step.
//
// This gate reads the PRINTED text of the P&L table — the amounts a
// person sees — and does the addition. It also reads the exact value
// each row declares (`data-pl-exact`) and foots that chain to the cent,
// then checks each declared value against what was painted, so the
// attribute cannot drift away from the paint and foot on its own.
//
// Measured on the current tree before the repair (2026-09-06), agras:
//
//   Pre-tax profit          15,577,652
//   Income tax              −1,471,550
//   ...ends on               7,533,676   ← account 121, the filed figure
//   the column sums to      14,106,102   ← the class-6/7 reconstruction
//   unexplained step        −6,572,426
//
// and again at EBITDA, which printed 18,420,491 while the rows above it
// summed to 15,075,054: "Other operating income" painted the gap glyph
// (the report read `assembled_pl.other_operating_income`, a field the
// engine never emitted) and D&A was subtracted ABOVE the EBITDA line
// it is added back into.
//
// WHAT IT REDS ON, after the repair (TC-11): a row dropped from the
// build-up; a row whose amount changes so its subtotal no longer foots;
// a reconciling difference that appears without a label; a new
// contributing row added without being counted; and a declared exact
// value that stops matching the painted one.
//
// WHAT IT CANNOT SEE: whether the figures are RIGHT — a build-up over
// four wrong numbers foots as happily as one over four right ones. That
// is the anchor gate's job (`tests/engine/test_one_concept_one_value.py`,
// and G1 next door). It also says nothing about the balance sheet or the
// cash flow, which have their own footing question and no gate here.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

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
vi.mock("@/components/cfo/CreditScoreCard", () => ({
  CreditScoreCard: () => null,
  readCreditFromMetrics: () => null,
}));
vi.mock("@/components/cfo/RiskInventory", () => ({ RiskInventory: () => null }));
vi.mock("@/components/cfo/EbitdaReconciliationPanel", () => ({
  EbitdaReconciliationPanel: () => null,
}));

import { cleanup, screen } from "@testing-library/react";

import { BOOKS, type Book, mountReport, parseMoney } from "./reportBooks";

/**
 * The rows the build-up must always carry. The column itself is read
 * from the DOM in render order — each row declares whether it is a
 * `step` (accumulates), a `subtotal` (states the running total) or a
 * `memo` (stands beside the column and is never added) — so a row added
 * to the build-up is automatically part of what must foot. This list is
 * the floor: it reds when one of them is silently dropped.
 */
const REQUIRED_ROWS = [
  "Net turnover",
  "Other operating income",
  "Cost of goods sold",
  "Operating expenses",
  "EBITDA",
  "Depreciation & amortization",
  "EBIT",
  "Net financial result",
  "Pre-tax profit",
  "Income tax",
  "Net profit — reconstructed (class 6/7 movements)",
  "= Net profit — statutory (account 121, as filed)",
];

type PlRow = {
  label: string;
  printed: string;
  exact: number | null;
  role: string | null;
};

/** Every row of the P&L table, in render order. */
function pnlRows(): PlRow[] {
  const section = screen.getByTestId("report-section-2-pnl");
  const out: PlRow[] = [];
  for (const tr of Array.from(section.querySelectorAll("tr"))) {
    const tds = Array.from(tr.querySelectorAll("td"));
    if (tds.length < 2) continue;
    const raw = tr.getAttribute("data-pl-exact");
    out.push({
      label: (tds[0].textContent ?? "").replace(/\s+/g, " ").trim(),
      printed: (tds[1].textContent ?? "").replace(/\s+/g, " ").trim(),
      exact: raw == null || raw === "" ? null : Number(raw),
      role: tr.getAttribute("data-pl-role"),
    });
  }
  return out;
}

const money = (n: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

describe("G2 — the rendered P&L build-up foots", () => {
  beforeEach(() => cleanup());
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("the required rows are a real floor, not an empty list", () => {
    expect(REQUIRED_ROWS.length).toBeGreaterThanOrEqual(10);
  });

  for (const book of BOOKS) {
    it(`${book}: every row declares its part in the column`, async () => {
      await mountReport(book as Book);
      const rows = pnlRows();

      const labels = rows.map((r) => r.label);
      const missing = REQUIRED_ROWS.filter((l) => !labels.includes(l));
      expect(missing, `${book}: the build-up carries no row labelled`).toEqual([]);

      // A row with no declared role is a row nobody can tell is part of
      // the sum or not — the state the table was in before this gate.
      const undeclared = rows
        .filter((r) => !["step", "subtotal", "memo"].includes(r.role ?? ""))
        .map((r) => `${r.label} (role=${JSON.stringify(r.role)})`);
      expect(undeclared, `${book}: a P&L row declares no role`).toEqual([]);

      const steps = rows.filter((r) => r.role === "step").length;
      const subtotals = rows.filter((r) => r.role === "subtotal").length;
      expect(steps, `${book}: steps`).toBeGreaterThanOrEqual(6);
      expect(subtotals, `${book}: subtotals`).toBeGreaterThanOrEqual(5);
    });

    it(`${book}: the printed column adds up to every subtotal it states`, async () => {
      await mountReport(book as Book);
      const failures: string[] = [];
      let running = 0;
      let counted = 0;
      for (const row of pnlRows()) {
        if (row.role === "memo") continue;
        const value = parseMoney(row.printed);
        if (value === undefined) {
          failures.push(
            `${row.label}: printed ${JSON.stringify(row.printed)} cannot be read as a figure`,
          );
          continue;
        }
        if (value === null) {
          failures.push(
            `${row.label}: painted the gap glyph, so the column below it cannot ` +
              `foot — a build-up may not skip a step it needs`,
          );
          continue;
        }
        if (row.role === "step") {
          running += value;
          counted += 1;
          continue;
        }
        // Printed amounts are whole RON, so a subtotal may sit up to half
        // a RON away per contributing row — never wider.
        if (Math.abs(value - running) > Math.max(counted, 1)) {
          failures.push(
            `${row.label}: states ${money(value)} but the rows above it sum to ` +
              `${money(running)} (unexplained step ${money(value - running)})`,
          );
        }
        running = value; // the report's own figure carries forward
        counted = 0;
      }
      expect(failures, `${book}: the rendered P&L does not foot`).toEqual([]);
    });

    it(`${book}: the exact chain foots to the cent, and matches what was painted`, async () => {
      await mountReport(book as Book);
      const drift: string[] = [];
      const failures: string[] = [];
      const undeclared: string[] = [];
      let running = 0;
      for (const row of pnlRows()) {
        if (row.role === "memo") continue;
        if (row.exact == null) {
          undeclared.push(row.label);
          continue;
        }
        const painted = parseMoney(row.printed);
        // The declared value must be what was painted, to the precision
        // it was painted at — otherwise the chain foots on a number no
        // reader ever saw.
        if (typeof painted === "number" && Math.abs(painted - row.exact) > 0.5) {
          drift.push(`${row.label}: painted ${money(painted)} but declares ${money(row.exact)}`);
        }
        if (row.role === "step") {
          running = Math.round((running + row.exact) * 100) / 100;
          continue;
        }
        if (Math.abs(row.exact - running) > 0.005) {
          failures.push(
            `${row.label}: ${money(row.exact)} vs ${money(running)} from the rows above ` +
              `(${money(row.exact - running)})`,
          );
        }
        running = row.exact;
      }
      expect(
        undeclared,
        `${book}: a build-up row states no exact value, so "foots to the cent" ` +
          `cannot be checked on it`,
      ).toEqual([]);
      expect(drift, `${book}: a declared exact value is not what was painted`).toEqual([]);
      expect(failures, `${book}: the exact chain does not foot to the cent`).toEqual([]);
    });
  }
});
