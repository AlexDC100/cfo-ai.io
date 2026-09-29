// ui-language-figures — EVERY FIGURE IS PRINTED IN THE READER'S LANGUAGE.
//
// Owner ticket 2026-09-28: in the ENGLISH interface of cfo-ai.io money and
// numbers printed in Romanian format — the command bar ("413,7 mil. RON",
// "36,8 mil. RON", "32,4 mil. RON"), the workspace home's company cards and
// the company page's year tiles ("413,7 mil. RON", "110,8 mil. RON") — and
// the report's days fallback printed "1 days". lib/money chose the locale
// from the CURRENCY (RON → ro-RO), whatever the reader's language.
//
// The law, per surface, in English AND Romanian: the figure is the owner's
// string for that language ("413.7M RON" / "413,7 mil. RON"), and nothing on
// the surface is a number in the OTHER language's format
// (frontend/test/numberLanguage.ts). The served value never changes — only
// the locale it is printed in.
//
//   the one printer        lib/money formatMoneyFrom / formatAmountFrom and
//                          the one mapping moneyLocaleFor
//   <Money>                follows a language switch with no remount
//   useAmountFormatter     the P&L / BS / CF table digits
//   workspace home         each company card's latest-year revenue
//   company page           each year tile's revenue
//   the command bar        servedMoney bound to the printer's language (the
//                          rendered bar: commandBar.test.tsx, cmdbar-ui-language)
//   the report             formatRatio's days fallback agrees with its count
//
// Plant log: docs/engine_book/gates.md, "ui-language-figures".
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import { TestProviders } from "@/test/renderWithProviders";
import { foreignNumber, plainSpaces } from "@/test/numberLanguage";
import { __setFeaturesForTest } from "@/lib/features";
import { writeWorkspaceName } from "@/lib/workspaceName";
import { __resetUploadFlowForTest } from "@/lib/uploadFlow";
import { activeMoneyLocale, formatAmountFrom, formatMoneyFrom, moneyLocaleFor } from "@/lib/money";
import { formatRatio, type Ratio } from "@/lib/financialReport";
import { Money } from "@/components/ui/Money";
import { useAmountFormatter } from "@/stores/currency";
import { MEASURE_NOUNS, printMeasure, servedMoney } from "@/components/instrument/shell/cmdbar/cmdbarFigures";
import { formatMeasure } from "@/lib/insights";
import { resolveMoneyDisplay } from "@/lib/narrativeMoney";
import { compactMoney, fullMoney } from "@/components/forecast/cockpit/format";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).IntersectionObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// The served years (the owner's screenshots: Scandia 413,727,560 RON in 2025).
const YEARS: Record<string, unknown[]> = {
  scandia: [
    { period_id: "s-2023", year: 2023, period_end: "2023-12-31", revenue: 350_000_000, revenue_change_pct: null },
    { period_id: "s-2024", year: 2024, period_end: "2024-12-31", revenue: 380_000_000, revenue_change_pct: 8.6 },
    { period_id: "s-2025", year: 2025, period_end: "2025-12-31", revenue: 413_727_560, revenue_change_pct: 8.9 },
  ],
  agras: [
    { period_id: "a-2025", year: 2025, period_end: "2025-12-31", revenue: 110_798_309.14, revenue_change_pct: null },
  ],
};
vi.mock("@/lib/uploadsApi", () => ({
  identifyUpload: vi.fn(() => new Promise(() => {})),
  commitUpload: vi.fn(),
  UploadApiError: class extends Error {},
  fetchCompanyYears: vi.fn(async (orgId: string) => YEARS[orgId] ?? []),
  fetchCompanyDirectory: vi.fn(async (ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, { cui: id === "scandia" ? "RO1234567" : null, companyName: null }]))),
}));
vi.mock("@/lib/org", () => {
  const orgs = [
    { id: "scandia", name: "Scandia Food SRL", industry_key: "fmcg", industry_display_name: null, default_currency: null, role: "owner", archived_at: null, purge_after: null, created_at: "2025-01-01" },
    { id: "agras", name: "Agras SA", industry_key: "agriculture", industry_display_name: null, default_currency: null, role: "owner", archived_at: null, purge_after: null, created_at: "2025-02-01" },
  ];
  return {
    useActiveOrg: () => ({
      org: orgs[0], orgs, archived: [], loading: false, loadError: false, needsOnboarding: false,
      refresh: async () => {}, switchOrg: async () => {},
      archiveWorkspace: async () => true, purgeWorkspace: async () => true, renameWorkspace: async () => true,
      setWorkspaceIndustry: async () => true, restoreWorkspace: async () => true,
    }),
    activateWorkspace: vi.fn(async () => true),
    daysUntilPurge: () => 19,
  };
});
vi.mock("@/lib/supabase", () => ({
  getSupabase: () => null,
  supabaseEnabled: false,
  currentOrgId: async () => "scandia",
  subscribeToDocumentStatus: () => () => {},
  fetchDocumentStatus: async () => null,
}));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/components/cfo/command/DecisionRulesModal", () => ({
  DecisionRulesPanel: () => <div data-testid="decision-rules-panel" />,
}));

import WorkspaceHomeV2 from "@/pages/cfo/WorkspaceHomeV2";
import CompanyPage from "@/pages/cfo/CompanyPage";

type Lang = "en" | "ro";
const REPO = resolve(__dirname, "../../../..");
const LANGS: readonly Lang[] = ["en", "ro"];
const RATES = { RON: 1, EUR: 5, USD: 4.6 } as never;

/** The owner's strings: the figure as each language writes it. */
const OWNER = {
  en: { scandia2025: "413.7M RON", scandia2024: "380M RON", scandia2023: "350M RON", agras2025: "110.8M RON" },
  ro: { scandia2025: "413,7 mil. RON", scandia2024: "380 mil. RON", scandia2023: "350 mil. RON", agras2025: "110,8 mil. RON" },
} as const;

let figuresChecked = 0;
/** One printed figure: the owner's string, and no number in the other
 *  language's format anywhere in the surface's text. */
function expectFigure(lang: Lang, printed: string | null | undefined, want: string, surface: string) {
  expect(plainSpaces(printed), `${surface} (${lang})`).toBe(want);
  figuresChecked++;
}
function expectNoForeignNumber(lang: Lang, text: string | null | undefined, surface: string) {
  expect(foreignNumber(text ?? "", lang), `${surface} (${lang}): a number in the other language's format`).toBeNull();
}

async function useLang(lang: Lang) {
  await act(async () => { await i18n.changeLanguage(lang); });
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  writeWorkspaceName("Scandia Food SRL");
  __resetUploadFlowForTest();
  __setFeaturesForTest({ products_legacy: { status: "active", label: "Products", description: "" } });
});
afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
});

function renderAt(route: string) {
  return render(
    <TestProviders route={route}>
      <Routes>
        <Route path="/workspace" element={<WorkspaceHomeV2 />} />
        <Route path="/workspace/:orgId" element={<CompanyPage />} />
      </Routes>
    </TestProviders>,
  );
}

// ── the detector is not vacuous ─────────────────────────────────────────

describe("the detector sees the defect the owner saw, and nothing else", () => {
  it("every string from the ticket reads as Romanian on an English surface; the English strings do not", () => {
    for (const seen of ["413,7 mil. RON", "36,8 mil. RON", "32,4 mil. RON", "110,8 mil. RON", "-2.577.640,82 RON", "1.234,56 EUR", "402,9 K RON", "-61,6 mii RON", "552 mii RON"]) {
      expect(foreignNumber(seen.replace(/ /g, "\u00a0"), "en"), seen).not.toBeNull();
      expect(foreignNumber(seen, "en"), seen).not.toBeNull();
    }
    for (const right of ["413.7M RON", "110.8M RON", "-2,577,640.82 RON", "1,234.56 EUR", "402.9K RON", "+8.9 % vs 2024", "Net turnover 2025", "CUI RO1234567", "1 day", "12 days"]) {
      expect(foreignNumber(right, "en"), right).toBeNull();
    }
    for (const seen of ["413.7M RON", "380M RON", "-2,577,640.82 RON", "1,234.56 EUR", "402.9K RON"]) {
      expect(foreignNumber(seen, "ro"), seen).not.toBeNull();
    }
    for (const right of ["413,7 mil. RON", "380 mil. RON", "-2.577.640,82 RON", "402,9 K RON", "31.12.2025", "+8,9 %"]) {
      expect(foreignNumber(right, "ro"), right).toBeNull();
    }
  });
});

// ── the one printer ─────────────────────────────────────────────────────

describe("lib/money — the locale is the reader's language, never the currency's", () => {
  for (const lang of LANGS) {
    it(`${lang}: the served value in the owner's format, every currency with its code after the figure`, async () => {
      await useLang(lang);
      expect(activeMoneyLocale()).toBe(lang === "ro" ? "ro-RO" : "en-US");
      const want = lang === "en"
        ? ["413.7M RON", "-2,577,640.82 RON", "+402.9K RON", "1,234.56 EUR", "1.2K USD", "0.00 RON", "10,922,666.19", "10.9M"]
        : ["413,7 mil. RON", "-2.577.640,82 RON", "+402,9 K RON", "1.234,56 EUR", "1,2 K USD", "0,00 RON", "10.922.666,19", "10,9 mil."];
      const printed = [
        formatMoneyFrom(413_727_560, "RON", "RON", RATES, { compact: true }),
        formatMoneyFrom(-2_577_640.82, "RON", "RON", RATES),
        formatMoneyFrom(402_869.16, "RON", "RON", RATES, { compact: true, signed: true }),
        formatMoneyFrom(1_234.56, "EUR", "EUR", RATES),
        formatMoneyFrom(1_234.56, "USD", "USD", RATES, { compact: true }),
        formatMoneyFrom(0, "RON", "RON", RATES),
        formatAmountFrom(10_922_666.19, "RON", "RON", RATES),
        formatAmountFrom(10_922_666.19, "RON", "RON", RATES, { compact: true }),
      ].map(plainSpaces);
      expect(printed).toEqual(want);
      for (const p of printed) expectNoForeignNumber(lang, p, "lib/money");
      figuresChecked += printed.length;
    });
  }

  it("an explicit locale wins over the active language, through the one mapping", async () => {
    await useLang("en");
    expect(plainSpaces(formatMoneyFrom(413_727_560, "RON", "RON", RATES, { compact: true, locale: moneyLocaleFor("ro") }))).toBe("413,7 mil. RON");
    await useLang("ro");
    expect(plainSpaces(formatMoneyFrom(413_727_560, "RON", "RON", RATES, { compact: true, locale: moneyLocaleFor("en-GB") }))).toBe("413.7M RON");
    for (const l of ["ro", "ro-RO", "RO"]) expect(moneyLocaleFor(l)).toBe("ro-RO");
    for (const l of ["en", "en-GB", "en-US", null, undefined, ""]) expect(moneyLocaleFor(l)).toBe("en-US");
  });

  it("the value never moves: the same digits in both languages", async () => {
    const digits = (s: string) => s.replace(/[^\d-]/g, "");
    await useLang("en");
    const en = formatMoneyFrom(-2_577_640.82, "RON", "RON", RATES);
    await useLang("ro");
    const ro = formatMoneyFrom(-2_577_640.82, "RON", "RON", RATES);
    expect(digits(en)).toBe("-257764082");
    expect(digits(ro)).toBe(digits(en));
  });
});

// ── <Money> and the table formatter ─────────────────────────────────────

function TableCell({ value }: { value: number }) {
  const fmt = useAmountFormatter("RON");
  return <span data-testid="table-cell">{fmt(value, { compact: false })}</span>;
}

describe("<Money> and useAmountFormatter follow the language, live", () => {
  it("one mounted <Money> and one table cell re-print on a language switch — no remount", async () => {
    render(
      <TestProviders>
        <span data-testid="money"><Money value={413_727_560} fromCurrency="RON" compact /></span>
        <TableCell value={10_922_666.19} />
      </TestProviders>,
    );
    const money = () => screen.getByTestId("money").firstElementChild as HTMLElement;
    expectFigure("en", money().textContent, "413.7M RON", "<Money> compact");
    expect(plainSpaces(money().getAttribute("title"))).toBe("413,727,560.00 RON");
    expectFigure("en", screen.getByTestId("table-cell").textContent, "10,922,666.19", "table cell");
    await useLang("ro");
    expectFigure("ro", money().textContent, "413,7 mil. RON", "<Money> compact");
    expect(plainSpaces(money().getAttribute("title"))).toBe("413.727.560,00 RON");
    expectFigure("ro", screen.getByTestId("table-cell").textContent, "10.922.666,19", "table cell");
    await useLang("en");
    expectFigure("en", money().textContent, "413.7M RON", "<Money> compact, switched back");
  });
});

// ── the two pages of the ticket ─────────────────────────────────────────

describe("workspace home — each company card's revenue", () => {
  for (const lang of LANGS) {
    it(`${lang}: Scandia ${OWNER[lang].scandia2025}, Agras ${OWNER[lang].agras2025}; no number in the other language's format`, async () => {
      await useLang(lang);
      const { container } = renderAt("/workspace");
      const scandia = await screen.findByTestId("company-card-scandia");
      await waitFor(() => expect(within(scandia).getByTestId("company-card-revenue").textContent).toMatch(/413/));
      const agras = screen.getByTestId("company-card-agras");
      await waitFor(() => expect(within(agras).getByTestId("company-card-revenue").textContent).toMatch(/110/));
      const figure = (card: HTMLElement) =>
        within(card).getByTestId("company-card-revenue").querySelector(".tabular-nums")?.textContent;
      expectFigure(lang, figure(scandia), OWNER[lang].scandia2025, "workspace card, Scandia");
      expectFigure(lang, figure(agras), OWNER[lang].agras2025, "workspace card, Agras");
      expectNoForeignNumber(lang, container.textContent, "workspace home");
    });
  }
});

describe("company page — each year tile's revenue", () => {
  for (const lang of LANGS) {
    it(`${lang}: 2025 ${OWNER[lang].scandia2025}, 2024 ${OWNER[lang].scandia2024}, 2023 ${OWNER[lang].scandia2023}; no number in the other language's format`, async () => {
      await useLang(lang);
      const { container } = renderAt("/workspace/scandia");
      await screen.findByTestId("company-year-2025");
      for (const year of [2025, 2024, 2023] as const) {
        const cell = screen.getByTestId(`company-year-${year}-revenue`);
        expectFigure(lang, cell.textContent, OWNER[lang][`scandia${year}`], `company tile ${year}`);
      }
      expect(plainSpaces(screen.getByTestId("company-year-2025-change").textContent)).toMatch(
        lang === "en" ? /^\+8\.9 % / : /^\+8,9 % /);
      expectNoForeignNumber(lang, container.textContent, "company page");
    });
  }
});

// ── the command bar's printer ───────────────────────────────────────────

describe("the command bar's servedMoney prints in the printer's language", () => {
  it("bound to a language, it prints that language whatever the global state; unbound, the active one", async () => {
    const en = servedMoney("RON", { compact: true, lang: "en" });
    const ro = servedMoney("RON", { compact: true, lang: "ro" });
    expect(en).not.toBe(ro);
    for (const global of LANGS) {
      await useLang(global);
      expectFigure("en", en(413_727_560), "413.7M RON", `bar printer en (UI ${global})`);
      expectFigure("en", en(36_787_353), "36.8M RON", `bar printer en (UI ${global})`);
      expectFigure("ro", ro(413_727_560), "413,7 mil. RON", `bar printer ro (UI ${global})`);
      expectFigure(global, servedMoney("RON", { compact: true })(32_400_000), global === "en" ? "32.4M RON" : "32,4 mil. RON", "bar printer, unbound");
    }
    // One stable printer per (currency, compactness, language).
    expect(servedMoney("RON", { compact: true, lang: "en" })).toBe(en);
  });

  it("a finding's measure (the resting items, the evidence drawer's headline) in the printer's language; the engine's own spelling unchanged", () => {
    const money = { key: "m", label: "m", value: -2_577_640.82, unit: "money" } as const;
    const share = { key: "r", label: "r", value: 0.704, unit: "ratio" } as const;
    const multiple = { key: "x", label: "x", value: 1.5, unit: "multiple" } as const;
    const days = { key: "d", label: "d", value: 37.3, value_q: "37.3", unit: "days" } as const;
    const want = {
      en: ["-2,577,640.82 RON", "70.4%", "1.50×", "37.3 days"],
      ro: ["-2.577.640,82 RON", "70,4%", "1,50×", "37,3 zile"],
    } as const;
    for (const lang of LANGS) {
      const printed = [money, share, multiple, days].map((m) => plainSpaces(printMeasure({ lang, money: (v) => String(v) }, m, "RON")));
      expect(printed, lang).toEqual([...want[lang]]);
      for (const p of printed) expectNoForeignNumber(lang, p, "finding measure");
      figuresChecked += printed.length;
    }
    // The report (English by contract) keeps the engine's format_measure bytes.
    expect(formatMeasure(money, "RON")).toBe("RON -2,577,640.82");
    expect(formatMeasure(share, "RON")).toBe("70.4%");
    expect(formatMeasure({ ...share, value: 0.0000012 }, "RON")).toBe("0.0001%");
    expect(formatMeasure({ ...share, value: 0.0000012 }, "RON", { locale: "ro-RO" })).toBe("0,0001%");
  });
});

// ── the report ──────────────────────────────────────────────────────────

// ── every WORD too (owner ruling 2026-09-29) ─────────────────────────────

/** English unit and refusal words a Romanian surface must never print. */
const ENGLISH_WORDS = /\b(?:not reported|years?|days?|accounts?)\b/;
/** Their Romanian counterparts, which an English surface must never print. */
const ROMANIAN_WORDS = /\b(?:neraportat|ani|zile|zi|conturi|cont)\b/;

describe("a finding's measure: every unit and the absent case in the reader's words", () => {
  const m = (unit: string, value: number | null, extra: Record<string, unknown> = {}) =>
    ({ key: "k", label: "k", unit, value, ...extra }) as never;
  const cases: [string, unknown, { en: string; ro: string }][] = [
    ["absent", m("money", null), { en: "not reported", ro: "neraportat" }],
    ["years", m("years", 12.5), { en: "12.5 years", ro: "12,5 ani" }],
    ["years (one decimal, the engine's)", m("years", 1), { en: "1.0 years", ro: "1,0 ani" }],
    ["days, served value_q", m("days", 37.3, { value_q: "37.3" }), { en: "37.3 days", ro: "37,3 zile" }],
    ["days, no value_q", m("days", 37.34), { en: "37.3 days", ro: "37,3 zile" }],
    ["a count of days", m("count", 12, { noun: "day" }), { en: "12 days", ro: "12 zile" }],
    ["a count of one day", m("count", 1, { noun: "day" }), { en: "1 day", ro: "1 zi" }],
    ["a count of accounts", m("count", 3, { noun: "account" }), { en: "3 accounts", ro: "3 conturi" }],
    ["a count of one account", m("count", 1, { noun: "account" }), { en: "1 account", ro: "1 cont" }],
    ["twenty accounts (the Romanian 'de')", m("count", 20, { noun: "account" }), { en: "20 accounts", ro: "20 de conturi" }],
    ["a count with no noun", m("count", 1234), { en: "1,234", ro: "1.234" }],
  ];
  it.each(cases)("%s", (_name, measure, want) => {
    for (const lang of LANGS) {
      const printed = plainSpaces(printMeasure({ lang, money: (v) => String(v) }, measure as never, "RON"));
      expect(printed, lang).toBe(want[lang]);
      if (lang === "ro") expect(ENGLISH_WORDS.exec(printed), `ro: "${printed}"`).toBeNull();
      else expect(ROMANIAN_WORDS.exec(printed), `en: "${printed}"`).toBeNull();
      expectNoForeignNumber(lang, printed, "finding measure");
      figuresChecked++;
    }
  });

  it("every count noun the engine's detectors emit is worded in both languages", () => {
    const src = readFileSync(resolve(REPO, "src/engine/insights/detectors.py"), "utf-8");
    const nouns = [...src.matchAll(/noun="(\w+)"/g)].map((x) => x[1]);
    expect(nouns.length, "VACUITY: the detectors' nouns").toBeGreaterThanOrEqual(2);
    for (const noun of nouns) {
      expect(noun === "day" || MEASURE_NOUNS.has(noun), `the engine's noun "${noun}" has no Romanian words in the bar`).toBe(true);
      for (const n of [1, 3, 20]) {
        const ro = printMeasure({ lang: "ro", money: (v) => String(v) }, m("count", n, { noun }) as never, "RON");
        expect(ENGLISH_WORDS.exec(ro), `ro, ${n} ${noun}: "${ro}"`).toBeNull();
      }
    }
  });
});

describe("the money tooltip's exchange rate in the reader's numbering", () => {
  it("5.2489 in English, 5,2489 in Romanian — the same digits", async () => {
    const rates = { EUR: 1, RON: 5.2489, USD: 1.16 } as never;
    for (const lang of LANGS) {
      await useLang(lang);
      const d = resolveMoneyDisplay(7_692_202.74, "RON", "EUR", rates, "2026-05-22");
      const prov = plainSpaces(d.provenance);
      expect(prov, lang).toContain(lang === "en" ? "1 EUR = 5.2489 RON" : "1 EUR = 5,2489 RON");
      expect(prov, lang).toContain(lang === "en" ? "7,692,202.74 RON" : "7.692.202,74 RON");
      expectNoForeignNumber(lang, prov.replace(/\(\d{4}-\d{2}-\d{2}\)/, ""), "tooltip");
      figuresChecked += 2;
    }
  });
});

describe("the Forecast cockpit prints through the same printer", () => {
  it("compact and full money are lib/money's, in the page's language, cents under one unit", () => {
    const want = {
      en: { compact: "54.4M RON", compactK: "123.5K RON", full: "100,000,000 RON", cents: "0.01 RON" },
      ro: { compact: "54,4 mil. RON", compactK: "123,5 K RON", full: "100.000.000 RON", cents: "0,01 RON" },
    } as const;
    for (const [lang, uiLocale] of [["en", "en-GB"], ["ro", "ro-RO"]] as const) {
      const compact = compactMoney("RON", uiLocale);
      const full = fullMoney("RON", uiLocale);
      const printed = {
        compact: plainSpaces(compact(54_400_000)),
        compactK: plainSpaces(compact(123_456)),
        full: plainSpaces(full(100_000_000)),
        cents: plainSpaces(full(0.01)),
      };
      expect(printed, lang).toEqual(want[lang]);
      expect(plainSpaces(compact(54_400_000))).toBe(plainSpaces(formatMoneyFrom(54_400_000, "RON", "RON", RATES, { compact: true, locale: moneyLocaleFor(lang) })));
      for (const v of Object.values(printed)) expectNoForeignNumber(lang, v, "cockpit");
      figuresChecked += 4;
    }
  });

  it("every bilingual string the engine serves the cockpit and the margin note: its own language's numbers, the ISO code after the figure, never 'lei'", () => {
    const docs = [
      ...readdirSync(resolve(REPO, "tests/engine/fixtures/forecast"))
        .filter((f) => /^cockpit_.*\.json$/.test(f))
        .map((f) => `tests/engine/fixtures/forecast/${f}`),
      "tests/engine/fixtures/firm/margin_meaning.json",
    ];
    const byLang: Record<Lang, string[]> = { en: [], ro: [] };
    const collect = (node: unknown, lang: Lang | null): void => {
      if (typeof node === "string") { if (lang) byLang[lang].push(node); return; }
      if (Array.isArray(node)) { node.forEach((x) => collect(x, lang)); return; }
      if (node && typeof node === "object") {
        const o = node as Record<string, unknown>;
        if ("en" in o && "ro" in o) { collect(o.en, "en"); collect(o.ro, "ro"); return; }
        for (const v of Object.values(o)) collect(v, lang);
      }
    };
    for (const d of docs) collect(JSON.parse(readFileSync(resolve(REPO, d), "utf-8")), null);
    for (const lang of LANGS) {
      const money = byLang[lang].filter((x) => /\bRON\b/.test(x));
      expect(money.length, `VACUITY: ${lang} money strings served`).toBeGreaterThanOrEqual(50);
      for (const x of byLang[lang]) {
        expect(foreignNumber(x, lang), `${lang}: "${x}"`).toBeNull();
        expect(/\bRON\s*[−-]?\d/.exec(x), `${lang}: a code BEFORE the figure: "${x}"`).toBeNull();
        expect(/\blei\b/.exec(x), `${lang}: "lei" is not the code: "${x}"`).toBeNull();
      }
      figuresChecked += money.length;
    }
  });
});

describe("the report's days fallback agrees with its count", () => {
  const days = (value: number): Ratio =>
    ({ key: "dso", label: "DSO", formula: "", value, unit: "days", verdict: "unknown" }) as unknown as Ratio;
  it.each([
    [1, "1 day"], [0.6, "1 day"], [1.4, "1 day"], [-1, "-1 day"],
    [0, "0 days"], [1.6, "2 days"], [12, "12 days"], [101, "101 days"],
  ] as const)("%s → %s", (value, want) => {
    expect(formatRatio(days(value))).toBe(want);
    expect(formatRatio(days(value))).not.toMatch(/(^|[^\d])-?1 days$/);
  });
});

afterAll(() => {
  // eslint-disable-next-line no-console
  console.log(`GATE-WORK ui-language-figures figures=${figuresChecked}`);
});
