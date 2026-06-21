// F6.1 (2026-06-21) — Demo financials generator.
//
// Builds a full `Statements` object for the fictional demo company, with
// `historicalPeriods` holding 4 prior years (oldest → newest) and the current
// (FY2025) as the head period — so the dashboard, Trend view, variance and
// scenarios all run on it through the SAME pipeline as real uploads.
//
// Realism rules (locked by tests):
//   · Believable mid-market food manufacturer (~45M→56M EUR revenue).
//   · A genuine DOWN YEAR (FY2024 −3%) — real companies don't grow every year.
//   · Every balance sheet BALANCES (assets = liabilities + equity), retained
//     earnings is the plug.
//   · ZERO real identifiers — invented numbers + the fictional company name.

import type {
  BalanceSheet,
  IncomeStatement,
  PriorPeriod,
  Statements,
} from "@/lib/financialReport";
import { DEMO_COMPANY } from "./demoCompany";

interface YearProfile {
  /** YoY revenue growth applied to the running base. */
  revenueGrowth: number;
  /** Gross-margin shift (pp) vs the base 30% gross margin. */
  marginShift: number;
}

// Base year (FY2021) headline financials — a healthy-but-imperfect manufacturer.
const BASE = {
  revenue: 45_200_000,
  grossMargin: 0.30, // 30% gross margin → 70% COGS
  opexPct: 0.186, // operating expenses as % of revenue
  depPct: 0.046, // depreciation as % of revenue
  amortPct: 0.008,
  interestPct: 0.020,
  taxRate: 0.16, // Romanian profit tax
};

// Five-year arc with a deliberate FY2024 dip (the believability anchor).
const PROFILE: YearProfile[] = [
  { revenueGrowth: 0.0, marginShift: 0.0 }, // FY2021 base
  { revenueGrowth: 0.08, marginShift: -0.005 }, // FY2022 growth, slight compression
  { revenueGrowth: 0.12, marginShift: 0.01 }, // FY2023 strong year
  { revenueGrowth: -0.03, marginShift: -0.015 }, // FY2024 DOWN YEAR
  { revenueGrowth: 0.06, marginShift: 0.008 }, // FY2025 recovery
];

function round(n: number): number {
  return Math.round(n);
}

interface YearFinancials {
  revenue: number;
  grossMargin: number;
}

function buildIncomeStatement(f: YearFinancials): IncomeStatement {
  const revenue = f.revenue;
  const cogs = revenue * (1 - f.grossMargin);
  const opex = revenue * BASE.opexPct;
  const dep = revenue * BASE.depPct;
  const amort = revenue * BASE.amortPct;
  const interest = revenue * BASE.interestPct;
  // EBIT = revenue − cogs − opex − D&A; PBT = EBIT − interest; tax on PBT.
  const ebit = revenue - cogs - opex - dep - amort;
  const pbt = ebit - interest;
  const tax = Math.max(0, pbt) * BASE.taxRate;
  return {
    revenue: round(revenue),
    costOfGoodsSold: round(cogs),
    operatingExpenses: round(opex),
    depreciationAmortization: round(dep + amort),
    interestExpense: round(interest),
    otherIncome: 0,
    taxExpense: round(tax),
  };
}

function buildBalanceSheet(f: YearFinancials, is: IncomeStatement): BalanceSheet {
  const revenue = f.revenue;
  const cogs = is.costOfGoodsSold;
  // Round every line FIRST, then derive retained earnings as the exact integer
  // plug from the rounded totals — so A = L + E balances to the unit.
  const cash = round(revenue * 0.06);
  const accountsReceivable = round(revenue * 0.15); // ~55 DSO
  const inventory = round(cogs * 0.164); // ~60 DIO
  const otherCurrentAssets = round(revenue * 0.02);
  const propertyPlantEquipment = round(revenue * 0.45);
  const intangibles = round(revenue * 0.03);
  const otherNonCurrentAssets = round(revenue * 0.02);

  const accountsPayable = round(cogs * 0.137); // ~50 DPO
  const shortTermDebt = round(revenue * 0.05);
  const otherCurrentLiabilities = round(revenue * 0.04);
  const longTermDebt = round(revenue * 0.18);
  const otherNonCurrentLiabilities = round(revenue * 0.02);

  const shareCapital = 5_000_000;
  const otherEquity = 500_000;

  const totalAssets =
    cash + accountsReceivable + inventory + otherCurrentAssets +
    propertyPlantEquipment + intangibles + otherNonCurrentAssets;
  const totalLiabilities =
    accountsPayable + shortTermDebt + otherCurrentLiabilities +
    longTermDebt + otherNonCurrentLiabilities;
  const retainedEarnings = totalAssets - totalLiabilities - shareCapital - otherEquity;

  return {
    cash,
    accountsReceivable,
    inventory,
    otherCurrentAssets,
    propertyPlantEquipment,
    intangibles,
    otherNonCurrentAssets,
    accountsPayable,
    shortTermDebt,
    otherCurrentLiabilities,
    longTermDebt,
    otherNonCurrentLiabilities,
    shareCapital,
    retainedEarnings,
    otherEquity,
  };
}

/** Compute the per-year financials by walking the growth profile. */
function yearFinancials(): YearFinancials[] {
  let revenue = BASE.revenue;
  let grossMargin = BASE.grossMargin;
  return PROFILE.map((p, i) => {
    if (i > 0) {
      revenue = revenue * (1 + p.revenueGrowth);
      grossMargin = grossMargin + p.marginShift;
    }
    return { revenue, grossMargin };
  });
}

/** Build the demo company's full Statements (FY2025 head + 4 prior years). */
export function buildDemoStatements(): Statements {
  const years = yearFinancials();
  const periods = DEMO_COMPANY.periods;

  const perYear = years.map((f, i) => {
    const incomeStatement = buildIncomeStatement(f);
    const balanceSheet = buildBalanceSheet(f, incomeStatement);
    return { meta: periods[i], incomeStatement, balanceSheet };
  });

  const historical: PriorPeriod[] = perYear.slice(0, -1).map((y) => ({
    periodLabel: y.meta.label,
    balanceSheet: y.balanceSheet,
    incomeStatement: y.incomeStatement,
  }));

  const head = perYear[perYear.length - 1];
  const prev = perYear[perYear.length - 2];

  return {
    companyName: DEMO_COMPANY.name,
    industry: DEMO_COMPANY.industry,
    currency: DEMO_COMPANY.currency,
    periodLabel: head.meta.label,
    balanceSheet: head.balanceSheet,
    incomeStatement: head.incomeStatement,
    supplementary: {
      employees: 320,
      capex: round(head.incomeStatement.revenue * 0.05),
      periodDays: 365,
    },
    prior: {
      periodLabel: prev.meta.label,
      balanceSheet: prev.balanceSheet,
      incomeStatement: prev.incomeStatement,
    },
    historicalPeriods: historical,
  };
}
