// GATE pl-one-ebitda-page (owner ruling R2, 2026-09-28; coordinator ruling
// D2, 2026-10-02) — /report PRINTS NET PROVISIONS ON ONE CONVENTION PER ROW:
// §1 (the reconciliation panel the page mounts) and §2 (the P&L table).
//
// THE DEFECTS (review 2026-10-02), both on the rendered page:
//   · §2's table pushed `{ label: np.label.en, val: 0 − np.value }` — the
//     engine's CHARGE label over the EFFECT: agras "Net provisions and
//     impairment adjustments (6812 + 6814 − 7812 − 7814) −131,395" (the label
//     evaluates to +131,394.66); carniprod the same label over "67,194" (it
//     evaluates to −67,194.32). The printed report and the workbook had been
//     repaired through `printedPl`; the on-screen table had not, and no law
//     read its row.
//   · §1's panel chain row printed the engine's full label AND the effect
//     chip: two opposite arithmetics on one row.
//
// LAW, on the three firm books that post the accounts (real engine output),
// with the page mounted whole — the panel NOT mocked:
//   · §2: the row is there, it prints the effect (like D&A above it, negated
//     in this column), and every account arithmetic in its label evaluates to
//     the figure it prints (frontend/test/netProvisionsArithmetic.ts);
//   · §1: the chain row states ONE arithmetic, its figure's; the bridge after
//     EBITDA the same — in English and in Romanian;
//   · on a book that posts none of the accounts the row is not printed.
// REDS ON: either row printing a figure its own text contradicts; §2 losing
// the row on a book that posts the accounts.
// CANNOT SEE: whether the served figures are right; pixels.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TooltipProvider } from "@/components/ui/tooltip";
import i18n from "@/i18n";
import { arithmeticsIn, rowProblems } from "@/test/netProvisionsArithmetic";

vi.mock("@/stores/currency", () => ({
  useCurrency: () => ({ display: "RON", rates: { rates: {} } }),
  CurrencyProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/lib/supabase", () => ({ getSupabase: () => null }));
const stableToast = { toast: () => undefined };
vi.mock("@/hooks/use-toast", () => ({ useToast: () => stableToast }));
vi.mock("@/hooks/useActivePeriodFallback", () => ({
  useActivePeriodFallback: () => ({ periodId: "p-book", status: "resolved" }),
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

import ComprehensiveReport from "@/pages/cfo/ComprehensiveReport";

type Json = Record<string, unknown>;
const repoRoot = resolve(__dirname, "../../../..");
const book = (name: string) =>
  JSON.parse(
    readFileSync(resolve(repoRoot, `tests/engine/fixtures/firm/saga_10_col_${name}.json`), "utf-8"),
  ) as { currency: string; period_end: string; statements: Json };
const npOf = (fx: ReturnType<typeof book>) => (fx.statements.assembled_pl as Json).net_provisions as Json;

async function mount(fx: ReturnType<typeof book>) {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    json: async () => ({
      period: { id: "p-book", period_end: fx.period_end, currency: fx.currency, source_document: null },
      statements: { companyName: "Book", ...fx.statements },
      metrics: [], alerts: [], recommendations: [],
    }),
  })));
  render(
    <TooltipProvider>
      <MemoryRouter initialEntries={["/report?period=p-book"]}>
        <ComprehensiveReport />
      </MemoryRouter>
    </TooltipProvider>,
  );
  await screen.findByTestId("comprehensive-report");
}

function textWithout(node: Element, ...selectors: string[]): string {
  const copy = node.cloneNode(true) as Element;
  for (const sel of selectors) copy.querySelectorAll(sel).forEach((n) => n.remove());
  return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
}

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("en");
});

const EFFECT = "7812 + 7814 − 6812 − 6814";

describe("/report — net provisions on one convention per row (§1 panel, §2 table)", () => {
  for (const name of ["agras", "carniprod", "retail"] as const) {
    for (const lang of ["en", "ro"] as const) {
      it(`${name} (${lang}): §2's row and §1's chain row each print the figure their own text states`, async () => {
        await i18n.changeLanguage(lang);
        const fx = book(name);
        const np = npOf(fx);
        expect(Math.abs(np.value as number), "the book posts the accounts").toBeGreaterThan(1);
        await mount(fx);

        // ── §2: the P&L table ──
        const section2 = screen.getByTestId("report-section-2-pnl");
        const tr = section2.querySelector<HTMLElement>('tr[data-pl-row="net_provisions"]');
        expect(tr, "§2 prints the net-provisions row").not.toBeNull();
        const cells = tr!.querySelectorAll("td");
        const label = (cells[0]?.textContent ?? "").trim();
        const exact = Number(tr!.getAttribute("data-pl-exact"));
        expect(exact, "§2 prints the effect, like the negated D&A above it").toBeCloseTo(-(np.value as number), 2);
        expect(rowProblems({
          surface: `/report §2 (${lang})`,
          text: label,
          value: exact,
          printed: cells[1]?.textContent ?? "",
        }, np)).toEqual([]);
        expect(arithmeticsIn(label), "the label states the effect's arithmetic").toEqual([EFFECT]);
        expect(label.startsWith(np.name_en as string), label).toBe(true);
        // The row above it follows the same convention (the pattern).
        const rows = Array.from(section2.querySelectorAll("tbody tr"));
        const dna = rows[rows.indexOf(tr!) - 1];
        expect(dna.querySelector("td")?.textContent).toContain("Depreciation");
        expect(Number(dna.getAttribute("data-pl-exact"))).toBeLessThanOrEqual(0);

        // ── §1: the reconciliation panel the page mounts ──
        const section1 = screen.getByTestId("report-section-1-overview");
        const chain = section1.querySelector<HTMLElement>('[data-recon-line="net_provisions"]');
        expect(chain, "§1's panel carries the chain row").not.toBeNull();
        const chainText = textWithout(chain!, ".text-right");
        expect(rowProblems({
          surface: `/report §1 chain row (${lang})`,
          text: chainText,
          value: Number(chain!.getAttribute("data-recon-value")),
          printed: chain!.querySelector(".text-right")?.textContent ?? "",
        }, np)).toEqual([]);
        expect(arithmeticsIn(chainText), "one arithmetic on the row").toEqual([EFFECT]);
        const after = section1.querySelector<HTMLElement>(
          '[data-testid="ebitda-recon-bridge"] [data-bridge-after="net_provisions"]',
        );
        expect(after, "§1's bridge carries net provisions after EBITDA").not.toBeNull();
        const value = after!.querySelector<HTMLElement>("[data-bridge-value]")!;
        expect(rowProblems({
          surface: `/report §1 bridge after EBITDA (${lang})`,
          text: textWithout(after!, "[data-bridge-value]"),
          value: Number(value.getAttribute("data-bridge-value")),
          printed: value.textContent,
        }, np)).toEqual([]);
      });
    }
  }

  it("realestate posts none of the accounts: §2 prints no net-provisions row", async () => {
    const fx = book("realestate");
    expect(npOf(fx).value).toBe(0);
    await mount(fx);
    const section2 = screen.getByTestId("report-section-2-pnl");
    expect(section2.querySelector('tr[data-pl-row="net_provisions"]')).toBeNull();
    expect(section2.textContent ?? "").not.toContain("6812");
  });
});
