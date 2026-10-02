// GATE pl-one-ebitda-page (owner ruling R2, 2026-09-28; coordinator ruling
// D2, 2026-10-02) — NET PROVISIONS, ONE CONVENTION PER ROW, ON EVERY SURFACE.
//
// THE LAW: on every surface that prints the net-provisions row, ANY account
// arithmetic in the row's FULL TEXT evaluates — each prefix replaced by the
// served by-account amounts under it — to the figure the row prints, and the
// printed string carries that figure's sign.
//
// WHY THE FULL TEXT. Three review rounds each found one more surface with a
// figure under the opposite arithmetic. The last two (2026-10-02):
//   · /report §2 printed the EFFECT under the engine's CHARGE label — agras
//     "Net provisions and impairment adjustments (6812 + 6814 − 7812 − 7814)
//     −131,395", a label that evaluates to +131,394.66;
//   · the reconciliation panel's chain row (Valuation tab, /report §1) printed
//     BOTH arithmetics on one row: the engine's label "… (6812 + 6814 − 7812
//     − 7814)" beside the effect chip "7812 + 7814 − 6812 − 6814" and the
//     effect figure. The law then read only `[data-recon-accounts]` — the
//     chip — and stayed green.
// So the check (frontend/test/netProvisionsArithmetic.ts) takes the row's
// whole text and evaluates every expression it finds.
//
// SURFACES HELD HERE, on the three firm books that post 6812 / 6814 / 7812 /
// 7814 (agras and retail a net charge, carniprod a net release — real engine
// output, tests/engine/fixtures/firm), EN and RO:
//   · the P&L tab — the row, and the reconciliation line under EBITDA;
//   · the Valuation tab's reconciliation panel — the chain row and the bridge
//     after EBITDA (the same component /report §1 mounts; the page itself is
//     held by pages/cfo/__tests__/comprehensiveReportNetProvisions.test.tsx,
//     with §2's table);
//   · the printed report (the HTML document) and the workbook (the P&L
//     sheet), read back from the documents the builders produce — and the
//     shared `printedPl` rows under them.
// The compare cells (prior, Δ) are held on the committed comparatives pair in
// netProvisionsRowSign.test.tsx.
// And, beside the row (review 2026-10-02, low): the account chips the engine
// words apart print in the reader's language — "68x fără 6812, 6814" for a
// Romanian reader, never the English "excl.".
//
// REDS ON: any surface printing the charge under the effect's arithmetic or
// the effect under the charge's; two arithmetics on one row that cannot both
// be the printed figure; a printed sign that is not the figure's; a Romanian
// P&L tab printing "excl."; a surface that stops printing the row on a book
// that posts the accounts (each lookup is asserted to find it).
// CANNOT SEE: whether the served figures are right (provisions-symmetric);
// pixels.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as XLSX from "xlsx";

import i18n from "@/i18n";
import { renderWithProviders } from "@/test/renderWithProviders";
import { arithmeticsIn, rowProblems, type RowReading } from "@/test/netProvisionsArithmetic";
import { adoptRemoteViewMode } from "@/lib/viewMode";
import { PLStatementView } from "@/components/cfo/PLStatementView";
import { EbitdaReconciliationPanel } from "@/components/cfo/EbitdaReconciliationPanel";
import { pickPLBuilder } from "@/lib/buildPlStatement";
import { printedPl } from "@/lib/printedPl";
import { buildExcelWorkbook, buildReportHtml } from "@/lib/financialExports";
import type { Statements } from "@/lib/financialReport";

type Rec = Record<string, unknown>;
const repoRoot = resolve(__dirname, "../../..");
const book = (name: string): Statements => {
  const fx = JSON.parse(
    readFileSync(resolve(repoRoot, `tests/engine/fixtures/firm/saga_10_col_${name}.json`), "utf-8"),
  ) as { statements: Rec };
  return { companyName: "Book", ...fx.statements } as unknown as Statements;
};
const npOf = (s: Statements): Rec => ((s as unknown as Rec).assembled_pl as Rec).net_provisions as Rec;

/** Net charge, net release, net charge. */
const BOOKS = ["agras", "carniprod", "retail"] as const;
const CHARGE = "6812 + 6814 − 7812 − 7814";
const EFFECT = "7812 + 7814 − 6812 − 6814";

/** A node's text without the cells that print figures. */
function textWithout(node: Element, ...selectors: string[]): string {
  const copy = node.cloneNode(true) as Element;
  for (const sel of selectors) copy.querySelectorAll(sel).forEach((n) => n.remove());
  return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
}

function renderPlTab(s: Statements) {
  const statement = pickPLBuilder({ lineItems: [], entity: "Entity", period: "Period", currency: "RON" }, s);
  return renderWithProviders(<PLStatementView statement={statement} hideGuide />);
}

beforeAll(async () => {
  adoptRemoteViewMode("pro");
  await i18n.changeLanguage("en");
});
afterAll(async () => {
  cleanup();
  await i18n.changeLanguage("en");
  try { window.localStorage.removeItem("cfo-view-mode-v1"); } catch { /* jsdom */ }
});

describe("net provisions — any arithmetic in the row's text is the row's figure, on every surface", () => {
  it("the witnesses: two books a net charge, one a net release; the engine's arithmetic is the charge", () => {
    const signs = BOOKS.map((b) => Math.sign(npOf(book(b)).value as number));
    expect(signs).toEqual([1, -1, 1]);
    for (const b of BOOKS) {
      const np = npOf(book(b));
      expect(arithmeticsIn(np.label_en as string)).toEqual([CHARGE]);
      expect(rowProblems({ surface: "engine", text: np.label_en as string, value: np.value as number }, np)).toEqual([]);
      // ...and the same label over the EFFECT is the defect this law reds on.
      expect(rowProblems({ surface: "engine", text: np.label_en as string, value: -(np.value as number) }, np))
        .toHaveLength(1);
    }
  });

  for (const name of BOOKS) {
    for (const lang of ["en", "ro"] as const) {
      it(`${name} (${lang}): the P&L tab — the row and the reconciliation line under EBITDA`, async () => {
        await i18n.changeLanguage(lang);
        const s = book(name);
        const np = npOf(s);
        const { container } = renderPlTab(s);
        try {
          const row = container.querySelector<HTMLElement>('.pl-row[data-traceable-target="netProvisions"]');
          expect(row, "the P&L tab prints the net-provisions row").not.toBeNull();
          const amount = row!.querySelector(".pl-amount")?.textContent ?? "";
          const reading: RowReading = {
            surface: `P&L tab row (${lang})`,
            text: textWithout(row!, ".pl-amount", ".cmp-cells"),
            value: np.value as number,
            printed: amount,
          };
          expect(rowProblems(reading, np)).toEqual([]);
          expect(amount.replace(/\D/g, ""), "the row prints the served charge").toBe(
            Math.abs(np.value as number).toFixed(2).replace(/\D/g, ""),
          );

          const after = container.querySelector<HTMLElement>(
            '[data-testid="pl-ebitda-bridge"] [data-bridge-after="net_provisions"]',
          );
          expect(after, "the line under EBITDA carries net provisions").not.toBeNull();
          const value = after!.querySelector<HTMLElement>("[data-bridge-value]")!;
          expect(rowProblems({
            surface: `P&L tab reconciliation line (${lang})`,
            text: textWithout(after!, "[data-bridge-value]"),
            value: Number(value.getAttribute("data-bridge-value")),
            printed: value.textContent,
          }, np)).toEqual([]);
        } finally {
          cleanup();
        }
      });

      it(`${name} (${lang}): the Valuation tab's panel — the chain row states ONE arithmetic, its figure's`, async () => {
        await i18n.changeLanguage(lang);
        const s = book(name);
        const np = npOf(s);
        const { container } = renderWithProviders(<EbitdaReconciliationPanel statements={s} currency="RON" />);
        try {
          const row = container.querySelector<HTMLElement>('[data-recon-line="net_provisions"]');
          expect(row, "the chain carries net provisions").not.toBeNull();
          const text = textWithout(row!, ".text-right");
          const figure = row!.querySelector(".text-right")?.textContent ?? "";
          const reading: RowReading = {
            surface: `panel chain row (${lang})`,
            text,
            value: Number(row!.getAttribute("data-recon-value")),
            printed: figure,
          };
          expect(reading.value, "the chain prints the effect").toBeCloseTo(-(np.value as number), 2);
          expect(rowProblems(reading, np)).toEqual([]);
          // One arithmetic on the row — the effect's — and the name beside it
          // carries none (the defect printed the charge's as well).
          expect(arithmeticsIn(text)).toEqual([EFFECT]);
          expect(text).toContain(np.name_ro as string);
          if (lang === "en") expect(text).toContain(np.name_en as string);

          const after = container.querySelector<HTMLElement>(
            '[data-testid="ebitda-recon-bridge"] [data-bridge-after="net_provisions"]',
          );
          expect(after, "the panel's bridge carries net provisions after EBITDA").not.toBeNull();
          const value = after!.querySelector<HTMLElement>("[data-bridge-value]")!;
          expect(rowProblems({
            surface: `panel bridge after EBITDA (${lang})`,
            text: textWithout(after!, "[data-bridge-value]"),
            value: Number(value.getAttribute("data-bridge-value")),
            printed: value.textContent,
          }, np)).toEqual([]);
        } finally {
          cleanup();
        }
      });
    }

    it(`${name}: the printed report and the workbook — the row read back from each document`, () => {
      const s = book(name);
      const np = npOf(s);
      const nameEn = np.name_en as string;

      // The shared rows both documents print.
      const ppl = printedPl(s);
      const pRow = ppl.rows.find((r) => r.key === "net_provisions");
      expect(pRow, "printedPl carries the row").toBeDefined();
      expect(rowProblems({ surface: "printedPl", text: pRow!.label, value: pRow!.value as number }, np)).toEqual([]);

      // The HTML document.
      const doc = new DOMParser().parseFromString(buildReportHtml(s, {}), "text/html");
      const tr = Array.from(doc.querySelectorAll("table.fin tr")).find((r) =>
        (r.querySelector("td")?.textContent ?? "").trim().startsWith(nameEn),
      );
      expect(tr, "the printed report's P&L table carries the row").toBeDefined();
      const cells = tr!.querySelectorAll("td");
      const printed = (cells[1]?.textContent ?? "").trim();
      const magnitude = Number(printed.replace(/[^\d.]/g, ""));
      const signed = (printed.startsWith("−") || printed.startsWith("-") || printed.startsWith("(") ? -1 : 1) * magnitude;
      // The document prints at its own precision; the exact figure is the
      // shared row's, and the printed string must be that figure rounded.
      expect(Math.abs(signed - (pRow!.value as number)), `the report prints ${printed}`).toBeLessThanOrEqual(0.5);
      expect(rowProblems({
        surface: "printed report (HTML)",
        text: (cells[0]?.textContent ?? "").trim(),
        value: pRow!.value as number,
        printed: printed.startsWith("(") ? `−${printed}` : printed,
      }, np)).toEqual([]);

      // The workbook's P&L sheet.
      const wb = buildExcelWorkbook(s);
      const rows = XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets["P&L"], { header: 1 });
      const wRow = rows.find((r) => typeof r[0] === "string" && (r[0] as string).startsWith(nameEn));
      expect(wRow, "the workbook's P&L sheet carries the row").toBeDefined();
      expect(typeof wRow![1], "the workbook cell is a number").toBe("number");
      expect(rowProblems({ surface: "workbook P&L sheet", text: wRow![0] as string, value: wRow![1] as number }, np))
        .toEqual([]);
    });
  }
});

describe("the P&L tab's account chips are worded in the reader's language", () => {
  // The engine serves the chip twice where the wording differs: "68x fără
  // 6812, 6814" / "68x excl. 6812, 6814" for D&A, and the same pair for other
  // operating income. The builder used to hand the view the English one
  // whatever the language (review 2026-10-02).
  for (const name of BOOKS) {
    it(`${name}: "fără" for a Romanian reader, "excl." for an English one — D&A and other operating income`, async () => {
      const s = book(name);
      const lines = (((s as unknown as Rec).assembled_pl as Rec).ebitda_reconciliation as Rec).lines as Rec[];
      const served = (key: string) => lines.find((l) => l.key === key) as Rec;
      const dna = served("depreciation");
      expect(dna.accounts, "the engine words the D&A chip apart").not.toBe(dna.accounts_en);
      expect(String(dna.accounts)).toContain("fără");
      expect(String(dna.accounts_en)).toContain("excl.");
      try {
        for (const [lang, key] of [["ro", "accounts"], ["en", "accounts_en"]] as const) {
          await i18n.changeLanguage(lang);
          const { container } = renderPlTab(s);
          const row = container.querySelector<HTMLElement>('.pl-row[data-traceable-target="depreciationAmortization"]');
          expect(row, `${lang}: the D&A row`).not.toBeNull();
          const text = textWithout(row!, ".pl-amount", ".cmp-cells");
          expect(text, `${lang}: the D&A chip`).toContain(String(dna[key]));
          // Every ROW of the tab (the section headers are the builder's own
          // English words, not served chips, and are not this law's subject).
          const whole = Array.from(container.querySelectorAll(".pl-row"))
            .map((r) => r.textContent ?? "").join("\n");
          if (lang === "ro") {
            expect(whole, "no English 'excl.' chip on a row of the Romanian P&L tab").not.toContain("excl.");
          } else {
            expect(whole, "no Romanian 'fără' chip on the English P&L tab").not.toContain("fără");
          }
          const ooi = served("other_operating_income");
          if (ooi && container.querySelector('.pl-row[data-traceable-target="otherOperatingIncome"]')) {
            expect(whole, `${lang}: the other-operating-income chip`).toContain(String(ooi[key]));
          }
          cleanup();
        }
      } finally {
        await i18n.changeLanguage("en");
        cleanup();
      }
    });
  }
});
