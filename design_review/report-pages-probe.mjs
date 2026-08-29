#!/usr/bin/env node
/**
 * REPORT PAGES lane — fixture-fed screenshot probe.
 *
 * The live test stack cannot mint a backend session (Supabase env is
 * absent on the engine), so /report and /peer-report only ever render
 * their empty states in design_shots.mjs. This probe intercepts the two
 * pages' API calls with Scandia-flavored fixture JSON so the DATA-DENSE
 * rendering (the whole point of this lane) can be reviewed visually.
 *
 * Run: node design_review/report-pages-probe.mjs --label report-pages-rN
 * Output: design_review/<label>/fixture-*.png
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const ARGS = process.argv.slice(2);
function arg(name, dflt) {
  const i = ARGS.indexOf("--" + name);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : dflt;
}
const LABEL = arg("label", "report-pages-fixtures");
const BASE = arg("base", "http://localhost:5173");
const outDir = join("design_review", LABEL);
mkdirSync(outDir, { recursive: true });

// ── /api/period/<id> fixture — Scandia calibration numbers ─────────────
const PERIOD = {
  period: {
    id: "fx-scandia",
    period_end: "2025-12-31",
    currency: "RON",
    source_document: { filename: "balanta_scandia_dec_2025.xlsx", id: "doc-1" },
  },
  statements: {
    companyName: "Scandia Food SRL",
    industry: "food_manufacturing",
    assembled_pl: {
      revenue: 413727560,
      total_operating_revenue: 421500000,
      other_operating_income: 7772440,
      cogs: 248236536,
      opex_total: 100719630,
      depreciation: 18100000,
      ebitda_statutory: 54443834,
      ebitda_cash: 52800000,
      ebit: 36343834,
      financial_income: 2400000,
      financial_expense: 1300000,
      interest_expense: 4200000,
      pretax: 33243834,
      tax: 6455000,
      net_income_statutory: 34637353, // operational (legacy field name)
      capitalized_own_work_memo: 2150000,
    },
    assembled_bs: {
      cash: 17700000,
      ar_net: 78400000,
      inventory: 64200000,
      ar_other: 6100000,
      ppe_net: 108900000,
      intangibles_net: 2450000,
      investments: 15300000,
      share_capital: 12000000,
      revaluation_reserves: 18300000,
      retained_earnings: 83064198,
      other_equity_non_revaluation: 0,
      current_year_pnl: 36787353,
      lt_debt: 42000000,
      st_debt: 24000000,
      ap: 52100000,
      ap_other: 22600000,
      ap_dividends: 2200000,
      total_assets: 293050085,
      total_equity: 150151551,
      total_liabilities: 142898534,
      total_debt: 66000000,
    },
    assembled_cf: {
      is_approximated: true,
      approximation_notes: [
        "Working-capital deltas estimated (single-period upload).",
        "Dividends paid assumed at 50% of net profit.",
      ],
      net_profit: 36787353,
      depreciation: 18100000,
      provision_movement: -1200000,
      delta_inventory: -3210000,
      delta_receivables: -3920000,
      delta_trade_pay: 2605000,
      delta_tax_pay: 452000,
      cash_from_operating: 49614353,
      capex_real: -21400000,
      capex_other_approx: -2100000,
      cip_change: -1850000,
      affiliate_change: -306000,
      dividends_received: 1450000,
      interest_received: 620000,
      cash_used_in_investing: -23586000,
      delta_lt_debt: -4200000,
      delta_st_bank: 2400000,
      interest_paid: -4200000,
      dividends_paid: -18393676,
      cash_used_in_financing: -24393676,
      net_change_in_cash: 1634677,
    },
  },
  metrics: [
    ["gross_margin", 0.40], ["ebitda_margin", 0.132], ["net_margin", 0.089],
    ["roe", 0.245], ["roa", 0.126], ["roic", 0.141],
    ["current_ratio", 1.65], ["quick_ratio", 1.02], ["cash_ratio", 0.18],
    ["equity_ratio", 0.512], ["debt_to_equity", 0.44], ["debt_to_ebitda", 0.89],
    ["interest_coverage", 8.65],
    ["dio", 58], ["dso", 69], ["dpo", 54],
    ["credit_composite", 82], ["altman_z_score", 3.09],
    ["altman_x1", 0.21], ["altman_x2", 0.28], ["altman_x3", 0.12], ["altman_x4", 1.05],
    ["credit_subscore_altman", 78], ["credit_subscore_profitability", 88],
    ["credit_subscore_leverage", 90], ["credit_subscore_coverage", 80],
    ["credit_subscore_dscr", 70], ["credit_subscore_liquidity", 64],
    ["credit_subscore_equity", 100],
  ].map(([name, value]) => ({ name, value })),
  alerts: [
    { rule_key: "risk_inventory_receivables_quality", severity: "high", title: "Receivables provision elevated", body: "Provisions are 18% of trade receivables — historical credit issues with affiliated counterparties (491xxx)." },
    { rule_key: "risk_inventory_raw_materials", severity: "medium", title: "Raw material price exposure", body: "Materials are 34% of turnover — unhedged commodity risk on a 6-month horizon." },
    { rule_key: "risk_inventory_liquidity", severity: "critical", title: "Tight cash liquidity", body: "Cash ratio 0.18x — heavy dependence on revolvers for the seasonal working-capital peak." },
    { rule_key: "risk_inventory_asset_maturity", severity: "low", title: "Mature asset base", body: "Accumulated depreciation is 57% of gross PP&E — capex pressure ahead." },
  ],
  recommendations: [
    { severity: "critical", title: "Build minimum liquidity buffer to 5% of ST liabilities", why: "Cash ratio of 0.18x is the weakest metric; vulnerable to a 15-day disruption.", action: "Target 6.1M RON minimum cash. Fund by trimming the dividend and converting the ST revolver to a committed facility.", impact: "Cash ratio doubles; liquidity risk eliminated." },
    { severity: "high", title: "Investigate receivables provisions", why: "Provisions at 18% of gross trade receivables is unusual.", action: "Pull the aging schedule by counterparty; write off uncollectible affiliated balances.", impact: "Cleaner balance sheet; 2-4M potential additional hit if reserves need topping up." },
    { severity: "medium", title: "Hedge raw-material exposure 6-12 months forward", why: "Materials at 34% of turnover; a 10% spike costs ~14M of margin.", action: "Forward contracts on 50-70% of next 6-month volume.", impact: "Margin stability; lower earnings volatility." },
  ],
  briefing: {
    summary:
      "Scandia Food SRL is a strong food manufacturer with a conservative balance sheet. EBITDA margin of 13.2% sits at the top of the food-manufacturing band, and net debt of 0.9x EBITDA leaves ample headroom. The statutory net profit reconciles to account 121 within 1.4%. The principal watch item is cash: a 0.18x cash ratio depends on revolver availability through the seasonal peak.",
  },
  line_items: [
    { statement: "PL", bucket: "other_operating_income", ro_account_code: "758", ro_account_name: "Alte venituri din exploatare", amount: 3120000 },
    { statement: "PL", bucket: "other_operating_income", ro_account_code: "781", ro_account_name: "Venituri din provizioane", amount: 1890000 },
  ],
};

// ── /api/benchmarks/report/<id> fixture ────────────────────────────────
const cmp = (metric_name, en, company_value, p25, p50, p75, gap_pp, lower_is_better) => ({
  metric_name,
  display: { en },
  company_value,
  benchmark: { p25, p50, p75, unit: "%", source: "MF/ANAF 2024 sector aggregates", source_year: 2024, confidence: "high", notes: null },
  verdict: gap_pp != null && ((lower_is_better && gap_pp <= 0) || (!lower_is_better && gap_pp >= 0)) ? "ahead" : "behind",
  gap_pp,
  lower_is_better,
});
const BENCH = {
  caen_code: "1013",
  caen_label: "Meat products (CAEN 1013)",
  industry_category: "food_manufacturing",
  disclosure:
    "Benchmarks derive from MF/ANAF published sector aggregates (FY2024) plus named-peer statutory filings. Percentiles are indicative, not audited. Financial impact = |gap pp| x revenue / 100.",
  sections: {
    profitability: {
      comparisons: [
        cmp("ebitda_margin", "EBITDA margin", 13.2, 7.8, 11.0, 14.5, 2.2, false),
        cmp("net_margin", "Net margin", 8.9, 2.9, 5.4, 8.8, 3.5, false),
      ],
    },
    cost_structure: {
      comparisons: [
        cmp("raw_materials_pct", "Raw materials (601+602)", 34.1, 27.0, 30.5, 35.5, 3.6, true),
        cmp("personnel_pct", "Personnel (64x)", 12.4, 11.0, 13.5, 16.0, -1.1, true),
        cmp("energy_pct", "Energy & utilities (605)", 3.9, 2.4, 3.1, 4.2, 0.8, true),
        cmp("external_services_pct", "External services (62x)", 7.7, 5.2, 6.4, 8.1, 1.3, true),
        cmp("logistics_pct", "Rent & maintenance (61x)", 1.8, 1.5, 2.2, 3.0, -0.4, true),
      ],
    },
    capital_structure: {
      comparisons: [
        cmp("equity_ratio", "Equity ratio", 51.2, 28.0, 38.5, 52.0, 12.7, false),
      ],
    },
  },
  deep: {
    leader_company: "Transavia",
    leader_year: 2024,
    leader_revenue_mlei: 1120.4,
    leader_net_margin_pct: 14.8,
    leader_specialization: "Vertically integrated poultry",
    leader_reasons: [
      { rank: 1, title: "Full vertical integration", description: "Feed mill through retail brand — captures the margin at every stage and removes third-party markups from the cost base.", margin_impact_pp: 4.2, evidence_source: "Transavia FY2024 statutory filing" },
      { rank: 2, title: "Own energy program", description: "On-site cogeneration + PV cut the energy line to 1.9% of revenue vs the 3.1% sector median.", margin_impact_pp: 1.2, evidence_source: "Sustainability report 2024" },
      { rank: 3, title: "Brand premium in modern retail", description: "Branded SKUs carry a 8-12% shelf premium vs private label, with national listing coverage.", margin_impact_pp: 2.1, evidence_source: "Retail audit panel" },
    ],
    leader_total_impact_pp: 7.5,
    peers: [
      { company_name: "Transavia", fiscal_year: 2024, revenue_mlei: 1120.4, net_margin_pct: 14.8, ebitda_margin_pct: 21.5, equity_ratio_pct: 68.0, debt_to_equity: 0.2, specialization: "Integrated poultry", tier: "leader", source: "MF filings" },
      { company_name: "Scandia Food SRL", fiscal_year: 2025, revenue_mlei: 413.7, net_margin_pct: 8.9, ebitda_margin_pct: 13.2, equity_ratio_pct: 51.2, debt_to_equity: 0.44, specialization: "Canned meat & pate", tier: "self", source: "This upload" },
      { company_name: "Agricola Bacau", fiscal_year: 2024, revenue_mlei: 890.1, net_margin_pct: 6.2, ebitda_margin_pct: 11.8, equity_ratio_pct: 44.0, debt_to_equity: 0.6, specialization: "Poultry + processed", tier: "strong", source: "MF filings" },
      { company_name: "Cris-Tim", fiscal_year: 2024, revenue_mlei: 780.0, net_margin_pct: 4.9, ebitda_margin_pct: 9.6, equity_ratio_pct: 39.0, debt_to_equity: 0.8, specialization: "Cold cuts", tier: "median", source: "MF filings" },
      { company_name: "Meda Prod 98", fiscal_year: 2024, revenue_mlei: 310.5, net_margin_pct: 1.8, ebitda_margin_pct: 5.9, equity_ratio_pct: 22.0, debt_to_equity: 1.9, specialization: "Cold cuts", tier: "thin_margin", source: "MF filings" },
      { company_name: "Salbac", fiscal_year: 2024, revenue_mlei: 145.2, net_margin_pct: -3.1, ebitda_margin_pct: 1.2, equity_ratio_pct: 9.0, debt_to_equity: 4.2, specialization: "Dry salami", tier: "distressed", source: "MF filings" },
    ],
    target_tiers: {
      aspirational: { net_margin_pct: 12.0, ebitda_margin_pct: 18.0, label: "Integrated leader economics", comment: "Requires vertical integration moves and brand premium — a 3-5 year program." },
      realistic: { net_margin_pct: 9.5, ebitda_margin_pct: 15.0, label: "Top-quartile processor", comment: "Achievable in 18-24 months via raw-material hedging and energy contracts." },
      minimum_viable: { net_margin_pct: 4.0, ebitda_margin_pct: 8.5, label: "Bankable floor", comment: "Below this, refinancing conversations get materially harder." },
    },
    success_patterns: [
      "Vertical integration into feed/primary production",
      "Energy self-generation programs",
      "Branded SKUs in modern retail with national coverage",
    ],
    failure_modes: [
      "Unhedged raw-material exposure into a price spike",
      "Private-label dependence with single-retailer concentration",
      "Debt-funded capacity expansion at cycle peak",
    ],
    market_context:
      "Romanian processed-meat demand grew 4.1% in 2024, but input costs remain volatile; the spread between hedged and unhedged processors was ~5pp of EBITDA margin.",
  },
  company_metrics_raw: { revenue: 413727560, fiscal_year: 2025 },
};

// ── /api/public/companies/TLV fixture — assembled_canonical_v1 shape ───
const pubPeriod = (end, revenue, ebitda, netIncome, marketMetrics) => ({
  schema_version: "assembled_canonical_v1",
  normalizer_version: "1",
  source: "nasdaq_sharadar_sf1",
  ticker: "TLV",
  dimension: "ARY",
  fiscal_period_end: end,
  currency: "USD",
  headline: {
    revenue,
    ebitda,
    ebit: ebitda - 210000000,
    net_income: netIncome,
    total_assets: 8200000000,
    total_equity: 5100000000,
    total_debt: 1400000000,
    cash: 950000000,
    operating_cash_flow: ebitda * 0.8,
    free_cash_flow: ebitda * 0.55,
  },
  leaves: {
    cogs_materials: { magnitude: revenue * 0.42, sign_meaning: "expense", source_field: "cor" },
    external_services_other: { magnitude: revenue * 0.21, sign_meaning: "expense", source_field: "opex" },
    depreciation_total: { magnitude: 210000000, sign_meaning: "expense", source_field: "depamor" },
    interest_expense_bank: { magnitude: 61000000, sign_meaning: "expense", source_field: "intexp" },
    income_tax_current: { magnitude: netIncome * 0.19, sign_meaning: "expense", source_field: "taxexp" },
  },
  aggregates: {},
  unmapped: [],
  market_metrics: marketMetrics,
  round_trip_check: { passed: true, max_deviation_pct: 0.2 },
});
const PUBLIC_TLV = {
  ticker: "TLV",
  ticker_info: { name: "Banca Transilvania (fixture)", sector: "Financial Services", industry: "Banks — Regional", exchange: "BVB", country: "RO", currency: "USD" },
  dimension: "ARY",
  subscription_required: false,
  synced_at: new Date(Date.now() - 6 * 60000).toISOString(),
  periods: [
    pubPeriod("2025-12-31", 2410000000, 1260000000, 830000000, {
      as_of: "2026-08-27",
      market_cap: 8400000000,
      enterprise_value: 8850000000,
      ev_ebitda: 7.0,
      ev_ebit: 8.4,
      ev_revenue: 3.7,
      pe_ratio: 10.1,
      pb_ratio: 1.6,
      ps_ratio: 3.5,
      dividend_yield: 0.052,
      currency: "USD",
    }),
    pubPeriod("2024-12-31", 2150000000, 1090000000, 700000000, null),
  ],
};

// ── capture ────────────────────────────────────────────────────────────
const SHOTS = [
  { route: "/report?period=fx-scandia", name: "fixture-report" },
  { route: "/peer-report?period=fx-scandia", name: "fixture-peer-report" },
  { route: "/dashboard/public/TLV", name: "fixture-public-tlv-overview" },
  { route: "/dashboard/public/TLV?tab=ratios", name: "fixture-public-tlv-ratios" },
  { route: "/dashboard/public/TLV?tab=valuation", name: "fixture-public-tlv-valuation" },
];
const VIEWPORTS = [
  { name: "desktop-1440", width: 1440, height: 900 },
  { name: "mobile-390", width: 390, height: 844 },
];

const browser = await chromium.launch();
for (const theme of ["light", "dark"]) {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
      colorScheme: theme === "dark" ? "dark" : "light",
    });
    const page = await ctx.newPage();
    const json = (body) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    await page.route("**/api/period/**", (r) => r.fulfill(json(PERIOD)));
    await page.route("**/api/benchmarks/report/**", (r) => r.fulfill(json(BENCH)));
    await page.route("**/api/industry/**", (r) => r.fulfill({ status: 404, contentType: "application/json", body: "{}" }));
    await page.route("**/api/public/companies/**", (r) => r.fulfill(json(PUBLIC_TLV)));
    // Pre-seed the learning store so the GuideMe tour doesn't auto-open
    // its scrim over the header in every shot.
    await page.addInitScript(() => {
      try {
        localStorage.setItem(
          "cfo:learning-mode:v1",
          JSON.stringify({
            mode: "off",
            coachDismissed: true,
            tutorialsSeen: { "comprehensive-report": true, "peer-comparison": true, "multi-year-history": true, "public-company": true },
          }),
        );
      } catch {}
    });
    for (const s of SHOTS) {
      try {
        await page.goto(BASE + s.route, { waitUntil: "networkidle", timeout: 45000 });
      } catch {}
      await page.evaluate((t) => {
        try { localStorage.setItem("theme", t); } catch {}
        const root = document.documentElement;
        root.classList.remove("light", "dark");
        root.classList.add(t);
        root.style.colorScheme = t;
      }, theme);
      await page.waitForTimeout(400);
      try {
        const d = page.getByTestId("test-mode-banner-dismiss");
        if (await d.isVisible({ timeout: 600 })) await d.click();
      } catch {}
      await page.waitForTimeout(500);
      const name = `${s.name}--${vp.name}--${theme}.png`;
      await page.screenshot({ path: join(outDir, name), fullPage: vp.name !== "mobile-390" });
      process.stdout.write(`shot ${name}\n`);
    }
    await ctx.close();
  }
}
await browser.close();
console.log(`\nDONE -> ${outDir}`);
