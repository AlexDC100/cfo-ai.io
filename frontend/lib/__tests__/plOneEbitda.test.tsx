// GATE pl-one-ebitda-page — THE P&L TAB PRINTS THE ONE EBITDA THE ENGINE
// SERVES, AND EXPLAINS IT (owner ruling 2026-09-26, design A7).
//
// THE RULING. Account 711 — "Variația stocurilor de produse" — sits INSIDE
// EBITDA and the operating result, with its sign, next to cost of sales;
// never as revenue, never inside cifra de afaceri. 72x (own work
// capitalised) the same way: operating, inside EBITDA, outside turnover.
// 767 is financial. Margins divide by net turnover. One definition, with the
// reconciliation line shown.
//
// THE DEFECTS THIS STANDS AGAINST, all on the P&L tab before the ruling:
//   · both builders DERIVED their own EBITDA from the lines they had (the
//     aggregates builder from `total_operating_revenue`, the line-item one
//     from its exact-code table) — a second EBITDA beside the engine's;
//   · 722 and 767 sat inside "Total operating revenue", so the first
//     subtotal was not net turnover and every margin over it was wrong;
//   · the 711 stock variation appeared nowhere, so EBITDA and the net
//     result could not be read off the page on any manufacturer;
//   · the "clean EBITDA" footnote and the "+ Capitalized own work (722) →
//     statutory" bridge stated EBITDA without 72x as the operating truth.
//
// THE BOOKS — every figure is REAL ENGINE OUTPUT, nothing hand-typed:
//   · the four firm books (tests/engine/fixtures/firm/saga_10_col_*.json,
//     captured GET /api/period) — every one a closed book whose 711 is the
//     121 bridge (retail: no 711 postings);
//   · six CONSTRUCTED books of the net-711-rule gate sent through the real
//     write seam and route (fixtures/oneEbitda/constructed_books.json, held
//     to the live route by tests/engine/test_one_ebitda_fe_books.py): the
//     bridge, no 711 postings with a 121 remainder, 72x beside a bridge, an
//     open book, and the two refusals (account 121 absent; its opening not
//     cleared).
//
// WHAT IT REDS ON (TC-11), with the tab correct:
//   · any builder printing an EBITDA, EBIT or profit before tax that is not
//     the served one — including a derivation that happens to agree on a
//     book whose 711 is zero (the bridge books make it disagree);
//   · a refused figure printed as a number or a bare dash, or without the
//     engine's reason in the reader's language;
//   · the stock-variation row missing, unsigned, not the served value, not
//     beside the cost block, or without the engine's provenance sentence;
//   · 72x or 767 inside the net-turnover subtotal;
//   · a 121 remainder folded into the stock variation;
//   · the retired footnote or +722 step coming back.
// WHAT IT CANNOT SEE: whether the engine's figures are right (net-711-rule
// is that gate), pixels.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";

import i18n from "@/i18n";
import { renderWithProviders } from "@/test/renderWithProviders";
import { PLStatementView } from "@/components/cfo/PLStatementView";
import { EbitdaReconciliationPanel } from "@/components/cfo/EbitdaReconciliationPanel";
import { pickPLBuilder, buildPLStatementFromAggregates, STOCK_VARIATION_NOT_MEASURED } from "@/lib/buildPlStatement";
import { GLOSSARY } from "@/lib/glossary";
import { metricsV2En, metricsV2Ro } from "@/components/dashboard/metricsV2Strings";
import { readServedOneEbitda } from "@/lib/servedOneEbitda";
import type { ApiLineItem, PLStatement } from "@/lib/plStructure";
import type { Statements } from "@/lib/financialReport";
import en from "@/i18n/locales/en.json";
import ro from "@/i18n/locales/ro.json";

import constructed from "./fixtures/oneEbitda/constructed_books.json";

const REPO = resolve(__dirname, "../../..");
const LINE_NAME = "Variația stocurilor de produse";

type Body = { statements: Statements; line_items: ApiLineItem[] };

function firmBook(name: string): Body {
  const fx = JSON.parse(
    readFileSync(resolve(REPO, `tests/engine/fixtures/firm/saga_10_col_${name}.json`), "utf-8"),
  ) as Body;
  return { statements: fx.statements, line_items: fx.line_items };
}

const CONSTRUCTED = constructed as unknown as Record<string, Body>;
const BOOKS: Record<string, () => Body> = {
  agras: () => firmBook("agras"),
  carniprod: () => firmBook("carniprod"),
  realestate: () => firmBook("realestate"),
  retail: () => firmBook("retail"),
  ...Object.fromEntries(
    Object.keys(CONSTRUCTED).map((k) => [k, () => JSON.parse(JSON.stringify(CONSTRUCTED[k])) as Body]),
  ),
};
const REFUSED = ["unanchored", "g6_uncleared"];

function build(body: Body): PLStatement {
  return pickPLBuilder(
    { lineItems: body.line_items, entity: "E", period: "P", currency: "RON" },
    body.statements,
  );
}

function servedOf(body: Body) {
  const s = readServedOneEbitda(body.statements.assembled_pl);
  expect(s, "the book serves an assembled_pl block").not.toBeNull();
  return s!;
}

const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");
const centsOf = (n: number) => Math.abs(n).toFixed(2).replace(/\D/g, "");

beforeEach(async () => {
  localStorage.setItem("cfo-view-mode-v1", "pro");
  await i18n.changeLanguage("en");
});
afterEach(cleanup);

// ── 1. THE FIGURES ARE THE SERVED ONES ────────────────────────────────

describe("the P&L's subtotals are the engine's served figures, on every book", () => {
  it("covers ten books, two of them refused", () => {
    // Non-vacuity: a gate that loops over nothing passes.
    expect(Object.keys(BOOKS).length).toBe(10);
    for (const b of REFUSED) expect(servedOf(BOOKS[b]()).ebitda, b).toBeNull();
  });

  for (const name of Object.keys(BOOKS)) {
    it(`${name}: EBITDA, EBIT, profit before tax and net turnover`, () => {
      const body = BOOKS[name]();
      const served = servedOf(body);
      const st = build(body);
      expect(st.ebitda, "EBITDA").toBe(served.ebitda);
      expect(st.ebit, "EBIT").toBe(served.ebit);
      expect(st.profitBeforeTax, "profit before tax").toBe(served.pretax);
      if (served.ebitda === null) {
        expect(st.ebitdaRefusal?.code).toBe(served.refusal?.code);
      }
      // The first subtotal IS net turnover — never total operating revenue.
      const turnover = st.sections.find((s) => s.role === "operatingRevenue")!;
      expect(turnover.subtotalAmount).toBe(served.turnover);
      for (const l of turnover.lines) {
        expect(l.accountCode ?? "", "no 72x / 767 / 711 inside net turnover").not.toMatch(/^(72|767|711)/);
      }
    });

    it(`${name}: the rows above EBITDA add up to the served EBITDA`, () => {
      const body = BOOKS[name]();
      const st = build(body);
      if (st.ebitda === null) return;
      const by = (role: string) => st.sections.find((s) => s.role === role);
      const cost = by("operatingExpenses")?.subtotalAmount ?? 0;
      const stock = by("stockVariation")?.lines[0]?.amount ?? 0;
      const sum =
        (by("operatingRevenue")?.subtotalAmount ?? 0) +
        (by("otherOperatingIncome")?.subtotalAmount ?? 0) +
        (by("capitalizedOwnWork")?.lines[0]?.amount ?? 0) -
        cost + stock;
      expect(Math.abs(sum - st.ebitda), `${name}: the column sums to ${sum}, EBITDA ${st.ebitda}`).toBeLessThan(0.005);
    });
  }
});

// ── 2. THE STOCK VARIATION ROW ────────────────────────────────────────

describe("'Variația stocurilor de produse' — beside the cost block, signed, with its provenance", () => {
  for (const name of Object.keys(BOOKS)) {
    it(`${name}`, () => {
      const body = BOOKS[name]();
      const served = servedOf(body);
      const iv = served.inventoryVariation!;
      const st = build(body);
      const roles = st.sections.map((s) => s.role);
      const shown = iv.value === null ? iv.refusal !== null : Math.abs(iv.value) >= 0.005;
      if (!shown) {
        expect(roles, `${name}: no 711 postings, no row`).not.toContain("stockVariation");
        return;
      }
      // Right after the cost block, before EBITDA.
      expect(roles.indexOf("stockVariation")).toBe(roles.indexOf("operatingExpenses") + 1);
      const row = st.sections.find((s) => s.role === "stockVariation")!.lines[0];
      expect(row.roName?.ro).toBe(LINE_NAME);
      expect(row.bucket).toBe("inventoryVariation");
      expect(row.accountCode).toBe("711");
      if (iv.value === null) {
        expect(row.amount).toBeUndefined();
        expect(row.refusal?.code).toBe(iv.refusal?.code);
      } else {
        expect(row.amount).toBe(iv.value);
        expect(row.sign).toBe(iv.value > 0 ? "positive" : "negative");
        expect(row.stockDirection).toBe(iv.value > 0 ? "increase" : "decrease");
        expect(row.provenance?.key).toBe(iv.provenance);
        expect(row.provenance?.label).toEqual(iv.provenanceLabel);
      }
    });
  }

  it("renders the owner's name verbatim in Romanian, and with the engine's gloss in English", async () => {
    const st = build(BOOKS.agras());
    await i18n.changeLanguage("ro");
    const { container, unmount } = renderWithProviders(<PLStatementView statement={st} hideGuide />);
    const row = container.querySelector('[data-traceable-target="inventoryVariation"]')!;
    const label = row.querySelector(".pl-label")!;
    expect(label.firstChild?.textContent).toBe(LINE_NAME);
    expect(row.textContent).toContain("+ creștere de stoc");
    expect(container.querySelector('[data-testid="pl-provenance"]')?.textContent).toContain(
      "derivată: rezultatul din contul 121",
    );
    unmount();
    await i18n.changeLanguage("en");
    const again = renderWithProviders(<PLStatementView statement={st} hideGuide />);
    const enRow = again.container.querySelector('[data-traceable-target="inventoryVariation"] .pl-label')!;
    expect(enRow.textContent).toContain(`${LINE_NAME} — change in inventories of finished goods`);
    expect(again.container.querySelector('[data-testid="pl-provenance"]')?.textContent).toContain(
      "derived: the result in account 121",
    );
    // Signed as its effect on the result.
    const amount = again.container.querySelector('[data-traceable-target="inventoryVariation"] .pl-amount')!;
    expect(amount.textContent?.startsWith("+")).toBe(true);
    expect(digits(amount.textContent)).toBe(centsOf(servedOf(BOOKS.agras()).inventoryVariation!.value!));
  });
});

// ── 3. REFUSALS CARRY — NEVER A ZERO, NEVER A BARE DASH ──────────────

describe("a refused stock variation refuses EBITDA, EBIT, profit before tax and their margins", () => {
  for (const name of REFUSED) {
    it(`${name}: every refused figure states the engine's reason, RO and EN`, async () => {
      const body = BOOKS[name]();
      const served = servedOf(body);
      const st = build(body);
      for (const lang of ["en", "ro"] as const) {
        await i18n.changeLanguage(lang);
        const { container, unmount } = renderWithProviders(<PLStatementView statement={st} hideGuide />);
        const box = container.querySelector('[data-testid="pl-ebitda"]')!;
        expect(box.querySelector('[data-testid="pl-ebitda-refused"]')).not.toBeNull();
        expect(digits(box.querySelector(".pl-row .pl-amount")?.textContent)).toBe("");
        const reason = lang === "ro" ? served.refusal!.text.ro : served.refusal!.text.en;
        const notes = Array.from(container.querySelectorAll('[data-testid="pl-refusal"]')).map((n) => n.textContent);
        expect(notes, "the reason, at the 711 row and the EBITDA line").toContain(reason);
        // EBIT and profit before tax: refused, with a pointer to the reason.
        const derived = container.querySelectorAll('[data-testid="pl-refusal-derived"]');
        expect(derived.length).toBeGreaterThanOrEqual(2);
        for (const d of Array.from(derived)) {
          expect(d.textContent).toBe(lang === "ro" ? ro.statements.pl.refusedWithEbitda : en.statements.pl.refusedWithEbitda);
        }
        // No refused cell prints a figure or a bare dash.
        for (const cell of Array.from(container.querySelectorAll(".pl-refused"))) {
          expect(cell.textContent).toBe(lang === "ro" ? "refuzat" : "refused");
        }
        // The EBITDA margin states the refusal, never a percent.
        const margins = Array.from(container.querySelectorAll(".pl-key-margins li")).map((l) => l.textContent ?? "");
        expect(margins[0]).not.toMatch(/%/);
        unmount();
      }
    });
  }

  it("unanchored: the net result is refused too — never the served build-up that lacks 711", () => {
    const body = BOOKS.unanchored();
    const st = build(body);
    const served = servedOf(body);
    // The served `net_income_statutory` is the reconstruction WITHOUT the
    // refused 711; the statement does not print it as the net result.
    expect(served.netIncomeStatutory).not.toBeNull();
    expect(st.netProfit).toBeNull();
    const closing = st.sections.find((s) => s.role === "closing")!;
    expect(closing.subtotalAmount).toBeUndefined();
    expect(closing.subtotalRefusal?.code).toBe(served.refusal?.code);
    expect(st.keyMargins.find((m) => m.label === "Net margin")?.value).toBeNull();
    expect(st.keyMargins.find((m) => m.label === "Net margin")?.refusal).toBeDefined();
  });

  it("g6_uncleared: EBITDA refused, yet account 121 is filed and still printed", () => {
    const body = BOOKS.g6_uncleared();
    const st = build(body);
    const served = servedOf(body);
    const closing = st.sections.find((s) => s.role === "closing")!;
    expect(closing.subtotalAmount).toBe(served.netIncomeStatutory);
    expect(closing.subtotalBucket).toBe("netIncomeStatutory");
  });
});

// ── 4. THE 121 REMAINDER STAYS VISIBLE ────────────────────────────────

describe("a closed book with no 711 postings keeps its 121 remainder on its own line", () => {
  it("closed_no_activity: no stock-variation row, the remainder labelled, then account 121", () => {
    const body = BOOKS.closed_no_activity();
    const served = servedOf(body);
    const st = build(body);
    expect(st.sections.map((s) => s.role)).not.toContain("stockVariation");
    const closing = st.sections.find((s) => s.role === "closing")!;
    const gap = closing.lines.find((l) => l.roName?.ro.startsWith("Neexplicat"));
    expect(gap?.amount).toBe(body.statements.assembled_pl!.net_income_unexplained_vs_121);
    expect(Math.abs(gap!.amount!)).toBeGreaterThan(1);
    expect(closing.subtotalAmount).toBe(served.netIncomeStatutory);
    // EBITDA is the one definition WITHOUT the remainder in it.
    expect(st.ebitda).toBe(served.ebitda);
    expect(served.inventoryVariation?.provenance).toBe("no_711_activity");
  });
});

// ── 5. 72x — INSIDE EBITDA, OUTSIDE TURNOVER ─────────────────────────

describe("own work capitalised (72x) is an operating line outside net turnover", () => {
  it("bridge_with_722: its own row, its own provenance, inside EBITDA", () => {
    const body = BOOKS.bridge_with_722();
    const served = servedOf(body);
    const st = build(body);
    const turnover = st.sections.find((s) => s.role === "operatingRevenue")!;
    expect(turnover.subtotalAmount).toBe(served.turnover);
    const cap = st.sections.find((s) => s.role === "capitalizedOwnWork")!;
    expect(cap.lines[0].amount).toBe(served.capitalizedOwnWork!.value);
    expect(cap.lines[0].provenance?.key).toBe(served.capitalizedOwnWork!.provenance);
    expect(cap.lines[0].roName?.ro).toBe("Producția realizată pentru scopuri proprii și capitalizată");
    // The split assumption the engine serves when 711 and 72x both moved.
    const { container } = renderWithProviders(<PLStatementView statement={st} hideGuide />);
    expect(container.querySelector('[data-testid="pl-split-assumption"]')?.textContent).toBe(
      served.reconciliation!.splitAssumption!.en,
    );
  });
});

// ── 6. THE RECONCILIATION LINE UNDER EBITDA ───────────────────────────

describe("the engine's reconciliation line stands under EBITDA", () => {
  for (const name of Object.keys(BOOKS)) {
    it(`${name}: every part is the served value`, () => {
      const body = BOOKS[name]();
      const served = servedOf(body);
      const { container } = renderWithProviders(<PLStatementView statement={build(body)} hideGuide />);
      const parts = Array.from(container.querySelectorAll("[data-bridge-part]"));
      expect(parts.map((p) => p.getAttribute("data-bridge-part"))).toEqual([
        "ebitda_before_stock_variation", "inventory_variation", "capitalized_own_work", "ebitda",
      ]);
      for (const [i, p] of parts.entries()) {
        const v = served.reconciliation!.bridge.parts[i].value;
        expect(p.querySelector("[data-bridge-value]")?.getAttribute("data-bridge-value")).toBe(
          v === null ? "refused" : String(v),
        );
      }
      if (served.reconciliation!.identityWith121) {
        expect(container.querySelector('[data-testid="pl-identity-note"]')?.textContent).toBe(
          served.reconciliation!.identityNote!.en,
        );
      }
    });
  }
});

// ── 7. THE PANEL THAT EXPLAINS EBITDA ─────────────────────────────────

describe("EbitdaReconciliationPanel prints the served chain, bridge and Core strip", () => {
  it("agras: every line in the served order, with the served values", () => {
    const body = BOOKS.agras();
    const served = servedOf(body);
    renderWithProviders(<EbitdaReconciliationPanel statements={body.statements} />);
    const rows = Array.from(document.querySelectorAll("[data-recon-line]"));
    expect(rows.map((r) => r.getAttribute("data-recon-line"))).toEqual(
      served.reconciliation!.lines.map((l) => l.key),
    );
    for (const [i, r] of rows.entries()) {
      const v = served.reconciliation!.lines[i].value;
      expect(r.getAttribute("data-recon-value")).toBe(v === null ? "none" : String(v));
    }
    expect(document.querySelector('[data-testid="ebitda-recon-identity-note"]')?.textContent).toBe(
      served.reconciliation!.identityNote!.en,
    );
    const core = document.querySelector('[data-testid="ebitda-recon-core-total"]')!;
    expect(digits(core.textContent)).toBe(centsOf(served.coreEbitda!));
    // One EBITDA — the panel no longer claims two.
    expect(document.body.textContent).not.toMatch(/two valid EBITDAs|Reported EBITDA/i);
  });

  it("unanchored: the refusals print their reason and account 121 says it is not in the file", () => {
    const body = BOOKS.unanchored();
    const served = servedOf(body);
    renderWithProviders(<EbitdaReconciliationPanel statements={body.statements} />);
    const refusals = Array.from(document.querySelectorAll('[data-testid="ebitda-recon-refused"]')).map((n) => n.textContent);
    expect(refusals).toContain(served.refusal!.text.en);
    expect(document.querySelector('[data-recon-line="account_121"]')?.textContent).toContain(
      en.statements.ebitdaRecon.notAnchored,
    );
    expect(document.querySelector('[data-testid="ebitda-recon-core-refused"]')?.textContent).toBe(
      served.refusal!.text.en,
    );
  });

  it("a payload with no served block says so and prints no figure", () => {
    renderWithProviders(<EbitdaReconciliationPanel statements={{}} />);
    expect(document.querySelector('[data-testid="ebitda-recon-not-served"]')?.textContent).toBe(
      en.statements.ebitdaRecon.notServed,
    );
    expect(document.querySelectorAll("[data-recon-line]").length).toBe(0);
  });
});

// ── 8. A PAYLOAD THE ENGINE DID NOT ASSEMBLE ─────────────────────────

describe("a payload with no served block builds the SAME definition, or refuses", () => {
  const payload = (inventoryVariationMemo: number) =>
    ({
      companyName: "Demo SRL", currency: "RON", periodLabel: "FY2025",
      balanceSheet: {}, supplementary: {},
      incomeStatement: {
        revenue: 1_000_000, costOfGoodsSold: 400_000, operatingExpenses: 300_000,
        otherIncome: 20_000, capitalizedOwnWork: 30_000, depreciationAmortization: 50_000,
        interestExpense: 10_000, financialIncome: 0, financialExpense: 0, taxExpense: 40_000,
        inventoryVariationMemo,
      },
    }) as unknown as Statements;

  it("no 711 activity: turnover + other + 72x − costs, 72x outside turnover", () => {
    const st = buildPLStatementFromAggregates(payload(0));
    expect(st.ebitda).toBe(1_000_000 + 20_000 + 30_000 - 400_000 - 300_000);
    expect(st.sections[0].subtotalAmount).toBe(1_000_000);
    expect(st.served).toBeNull();
  });

  it("711 activity the payload did not measure: EBITDA refused, never derived without it", () => {
    const st = buildPLStatementFromAggregates(payload(750_000));
    expect(st.ebitda).toBeNull();
    expect(st.ebitdaRefusal).toEqual(STOCK_VARIATION_NOT_MEASURED);
    expect(st.ebit).toBeNull();
    expect(st.profitBeforeTax).toBeNull();
  });
});

// ── 9. RETIRED ────────────────────────────────────────────────────────

describe("the 'clean EBITDA' footnote and the +722 steps are retired", () => {
  it("no book renders them", () => {
    for (const name of ["agras", "bridge_with_722", "realestate"]) {
      const { container, unmount } = renderWithProviders(<PLStatementView statement={build(BOOKS[name]())} hideGuide />);
      expect(container.querySelector('[data-testid="pl-footnote"]'), name).toBeNull();
      expect(container.querySelector('[data-testid="pl-recon-bridge"]'), name).toBeNull();
      const text = container.textContent ?? "";
      expect(text, name).not.toMatch(/clean EBITDA|\+ Capitalized own work|operational \(excl\. 722\)|excluded from operating revenue/i);
      unmount();
    }
  });

  it("no source keeps a second EBITDA formula or the retired copy", () => {
    const builder = readFileSync(resolve(REPO, "frontend/lib/buildPlStatement.ts"), "utf-8");
    expect(builder).not.toMatch(/cleanEbitda|function oneEbitda|netProfit \+ (revCapOwnWork|capOwnWork)/);
    const view = readFileSync(resolve(REPO, "frontend/components/cfo/PLStatementView.tsx"), "utf-8");
    expect(view).not.toMatch(/PLFootnote|PLReconciliationBridge/);
    for (const locale of [en, ro] as const) {
      const pl = (locale as { tablesV2?: { pl?: unknown } }).tablesV2?.pl;
      expect(pl, "the retired footnote copy").toBeUndefined();
    }
  });
});

// ── 10. THE WORDS: glossary, metric tooltips, i18n parity ─────────────

describe("the definition in words, EN and RO", () => {
  it("EBITDA names the two non-cash lines inside it, in both languages", () => {
    const e = GLOSSARY.ebitda.plain;
    expect(e.en).toMatch(/711/);
    expect(e.en).toMatch(/72x/);
    expect(e.ro).toMatch(/variația stocurilor de produse \(711\)/i);
    expect(e.ro).toMatch(/72x/);
    expect(e.en).not.toMatch(/proxy for the cash/i);
    expect(metricsV2En.concepts.ebitda).toMatch(/711/);
    expect(metricsV2Ro.concepts.ebitda).toMatch(/711/);
    expect(metricsV2En.concepts.ebitda).not.toMatch(/proxy for cash/i);
    expect(metricsV2En.concepts.ebitda_margin).toMatch(/net turnover/);
    expect(metricsV2Ro.concepts.ebitda_margin).toMatch(/cifra de afaceri netă/);
  });

  it("the two components have glossary entries (Simple mode explains the rows)", () => {
    expect(GLOSSARY.stock_variation.term.ro).toContain(LINE_NAME);
    expect(GLOSSARY.stock_variation.term.en).toContain(LINE_NAME);
    expect(GLOSSARY.own_work_capitalised.term.ro).toContain("72x");
  });

  it("every key the P&L tab and the panel read exists in both locales, with the same placeholders", () => {
    const flat = (o: unknown, p = ""): Record<string, string> =>
      Object.entries(o as Record<string, unknown>).reduce<Record<string, string>>((acc, [k, v]) => {
        const path = p ? `${p}.${k}` : k;
        if (v && typeof v === "object") Object.assign(acc, flat(v, path));
        else if (typeof v === "string") acc[path] = v;
        return acc;
      }, {});
    for (const block of ["pl", "ebitdaRecon"] as const) {
      const e = flat((en.statements as Record<string, unknown>)[block]);
      const r = flat((ro.statements as Record<string, unknown>)[block]);
      expect(Object.keys(r).sort(), block).toEqual(Object.keys(e).sort());
      for (const k of Object.keys(e)) {
        const ph = (s: string) => (s.match(/\{\{\s*\w+\s*\}\}/g) ?? []).sort();
        expect(ph(r[k]), `${block}.${k}`).toEqual(ph(e[k]));
        expect(r[k].trim(), `${block}.${k} (ro)`).not.toBe("");
      }
    }
    expect(ro.statements.cmp.refused).toBeTruthy();
    expect(en.statements.cmp.refused).toBeTruthy();
  });
});
