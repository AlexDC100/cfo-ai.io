// F5.0 — Seed concepts.
//
// 5 concepts only. The minimum set to make Phase 1's Dashboard EBITDA-
// tile proof point work end-to-end across the full glance / hover
// rendering pipeline. Adding more concepts here is scope creep —
// Phase 4 expands to 50-80 spread across category files.
//
// Why these 5 specifically:
//   1. ebitda          — the value rendered in the Dashboard EBITDA tile
//                        (a raw value, no interpretation classifier)
//   2. ebitda_margin   — the most-asked-about derived metric on Dashboard
//                        (full interpretation: sentiment + narrative)
//   3. revenue         — the denominator the user will trace TO when
//                        clicking "see how this was computed"
//   4. net_income      — the bottom-line value below EBITDA, almost
//                        always rendered next to EBITDA
//   5. gross_margin    — sits between EBITDA and Revenue conceptually;
//                        completes the profitability concept neighborhood
//
// Phase 1 wires <LearnableNumber conceptKey="ebitda_margin"> as the
// proof point. Hover that span → popover reads from this seed. Phase
// 2 onwards extends; Phase 4 grows to the full library.

import type { Concept } from "./_schema";

/** Global mid-cap baseline benchmark for EBITDA margin. Phase 4 swaps
 *  to per-industry lookup; Phase 1 uses this so the concept renders
 *  even when no industry context is set. Source: in-repo sector risk
 *  library median across non-financial sectors. */
const EBITDA_MARGIN_BASELINE_BENCHMARK = {
  p25: 0.06,
  median: 0.12,
  p75: 0.20,
  source: "Global mid-cap baseline (non-financial)",
};

/** Global gross-margin baseline. Wide variance by sector — software ~70%,
 *  food retail ~25%. Phase 4 swaps to per-industry lookup. */
const GROSS_MARGIN_BASELINE_BENCHMARK = {
  p25: 0.18,
  median: 0.32,
  p75: 0.52,
  source: "Global mid-cap baseline (non-financial)",
};

// ─── ebitda ───────────────────────────────────────────────────────────────
// Raw-value concept. No interpretation classifier — EBITDA in absolute
// terms tells you nothing without scale context. The MARGIN (next concept)
// is what carries the good/bad signal.
const ebitda: Concept = {
  key: "ebitda",
  name: {
    en: "EBITDA",
    ro: "EBITDA",
  },
  category: "Profitability",
  // THE ONE EBITDA (owner ruling 2026-09-26): it includes two lines that
  // move no cash — the stock variation (711, "Variația stocurilor de
  // produse") and own work capitalised (72x) — so it is no longer described
  // as a read on cash generated.
  shortDefinition: {
    en:
      "Earnings before interest, taxes, depreciation, and amortization — " +
      "the operating result before depreciation. It includes two lines " +
      "that move no cash: the stock variation (711, \"Variația stocurilor " +
      "de produse\") and own work capitalised (72x).",
    ro:
      "Profitul înainte de dobânzi, impozite, depreciere și amortizare — " +
      "rezultatul din exploatare înainte de amortizare. Include două linii " +
      "care nu mișcă numerar: variația stocurilor de produse (711) și " +
      "producția imobilizată (72x).",
  },
  inlineFormula: "EBIT + Depreciation + Amortization",
  plainEnglish: {
    en: "What the day-to-day business earns before interest, tax and " +
        "wear-and-tear on equipment — counting the change in the stock of " +
        "products you made, not only what you sold.",
    ro: "Cât câștigă activitatea zilnică înainte de dobânzi, impozit și " +
        "uzura echipamentelor — socotind și variația stocului de produse " +
        "fabricate, nu doar ce ai vândut.",
  },
  // No interpretation — raw EBITDA in RON tells you nothing without
  // a denominator. See ebitda_margin for the interpreted form.
  related: ["ebitda_margin", "revenue", "net_income", "gross_margin"],
  computation: (ctx, value) => {
    const m = ctx.metrics ?? {};
    // EBITDA = EBIT + D&A + net provisions (owner ruling R2, 2026-09-28:
    // the 6812 / 6814 charges and 7812 / 7814 reversals sit OUTSIDE
    // EBITDA, their net between it and the operating result). D&A is the
    // served P&L line when the engine assembled the period, else the
    // income statement's; net provisions only where the engine serves them.
    const dna = m.plDepreciation ?? m.depreciation ?? 0;
    const netProvisions = m.netProvisions;
    const provisionTokens =
      typeof netProvisions === "number" && Math.abs(netProvisions) >= 0.005
        ? ([
            { type: "operator", op: netProvisions >= 0 ? "+" : "−" },
            {
              type: "value",
              value: Math.abs(netProvisions),
              conceptKey: "net_provisions",
              label: "Net provisions",
              format: "currency",
            },
          ] as const)
        : ([] as const);
    return {
      result: { value, format: "currency", conceptKey: "ebitda" },
      layout: "stacked",
      tokens: [
        {
          type: "value",
          value: m.ebit ?? value - dna - (m.amortization ?? 0) - (netProvisions ?? 0),
          conceptKey: "ebit",
          label: "EBIT",
          format: "currency",
        },
        { type: "operator", op: "+" },
        {
          type: "value",
          value: dna,
          conceptKey: "depreciation_amortization",
          label: "D&A",
          format: "currency",
        },
        ...provisionTokens,
      ],
    };
  },
};

// ─── ebitda_margin ────────────────────────────────────────────────────────
// The interpreted version of EBITDA. This is the Phase 1 proof point —
// LearnableNumber will wrap whatever Dashboard tile renders this and the
// popover will show getSentiment + getNarrative.
const ebitda_margin: Concept = {
  key: "ebitda_margin",
  name: {
    en: "EBITDA Margin",
    ro: "Marja EBITDA",
  },
  category: "Profitability",
  shortDefinition: {
    en:
      "EBITDA as a share of NET TURNOVER (70x − 709) — how much of every " +
      "unit of sales becomes operating result before depreciation. The " +
      "denominator is turnover only: the stock variation (711) and own " +
      "work capitalised (72x) are inside EBITDA, never in the denominator.",
    ro:
      "EBITDA ca procent din CIFRA DE AFACERI NETĂ (70x − 709) — cât din " +
      "fiecare unitate vândută devine rezultat din exploatare înainte de " +
      "amortizare. Numitorul este doar cifra de afaceri: variația " +
      "stocurilor (711) și producția imobilizată (72x) sunt în EBITDA, " +
      "niciodată în numitor.",
  },
  inlineFormula: "EBITDA ÷ Net turnover × 100",
  plainEnglish: {
    en: "Of every 1 RON the business sells, this much becomes operating " +
        "earnings before financing and tax decisions. Bigger = more cushion.",
    ro: "Din fiecare 1 RON vândut, atât rămâne ca profit operațional, " +
        "înainte de finanțare și impozit. Mai mare = mai multă marjă.",
  },
  benchmark: EBITDA_MARGIN_BASELINE_BENCHMARK,
  interpretation: {
    getSentiment: (value, ctx) => {
      const median = ctx?.benchmark?.median ?? EBITDA_MARGIN_BASELINE_BENCHMARK.median;
      if (value > median * 1.2) return "positive";
      if (value < median * 0.7) return "negative";
      return "neutral";
    },
    getNarrative: (value, ctx) => {
      const median = ctx?.benchmark?.median ?? EBITDA_MARGIN_BASELINE_BENCHMARK.median;
      const diff = (value - median) / median;
      // Note: narratives are NOT translated via this seed file — Phase 4
      // moves narrative generation to a translated table. Phase 1 ships
      // English-only and the i18n hook returns English when locale=ro
      // until Phase 4 fills the Romanian narratives.
      if (diff > 0.2) {
        return "Stronger than typical for your industry — margin discipline is a real strength.";
      }
      if (diff < -0.3) {
        return "Below industry median — investigate pricing power, mix, or cost structure.";
      }
      return "In line with industry typical for your sector.";
    },
  },
  related: ["ebitda", "ebit_margin", "gross_margin", "net_income", "operating_leverage"],
  computation: (ctx, value) => {
    const m = ctx.metrics ?? {};
    return {
      result: { value, format: "percentage", conceptKey: "ebitda_margin" },
      layout: "fraction",
      tokens: [
        {
          type: "value",
          value: m.ebitda ?? value * (m.revenue ?? 0),
          conceptKey: "ebitda",
          label: "EBITDA",
          format: "currency",
        },
        { type: "operator", op: "÷" },
        {
          type: "value",
          value: m.revenue ?? 0,
          conceptKey: "revenue",
          label: "Net turnover",
          format: "currency",
        },
      ],
    };
  },
};

// ─── revenue ──────────────────────────────────────────────────────────────
// Raw-value concept. Revenue in isolation has no good/bad classifier;
// the GROWTH RATE (Phase 4 expansion) is what gets interpreted. Phase 1
// surfaces revenue so the Layer 3 deep-dive can trace ebitda_margin's
// denominator to its source.
const revenue: Concept = {
  key: "revenue",
  name: {
    en: "Revenue",
    ro: "Cifră de afaceri",
  },
  category: "Profitability",
  shortDefinition: {
    en:
      "Total amount your business billed customers in the period, before " +
      "any deductions for returns, discounts, or cost of goods sold. The " +
      "top-line number that every margin ratio uses as its denominator.",
    ro:
      "Totalul facturat clienților în perioadă, înainte de orice " +
      "deducere pentru retururi, reduceri sau cost al bunurilor vândute. " +
      "Numărul de top din care se calculează toate marjele.",
  },
  inlineFormula: "Σ (701..708) − 709 reductions",
  plainEnglish: {
    en: "Total amount you invoiced customers in this period. " +
        "The starting point of the P&L — everything else is subtracted from this.",
    ro: "Totalul facturat clienților în perioadă. Punctul de plecare al " +
        "contului de profit — toate cheltuielile se scad din aici.",
  },
  // No interpretation — see comment on `ebitda`.
  related: ["gross_margin", "ebitda_margin", "ebitda", "net_income"],
  computation: (ctx, value) => {
    const trace = ctx.metrics?.accountTraces?.["revenue"] ?? [];
    return {
      result: { value, format: "currency", conceptKey: "revenue" },
      layout: "stacked",
      tokens: [],
      // Leaf concept — bottoms out at source accounts. When the trial
      // balance accounts are available in ReportingMetrics.accountTraces,
      // the popover renders them as deep links to /financials. When
      // missing, the popover shows the inlineFormula text instead.
      trace: trace.length > 0 ? { accounts: trace } : undefined,
    };
  },
};

// ─── net_income ───────────────────────────────────────────────────────────
// Raw-value concept. Phase 4 will add net_margin (the interpreted form);
// Phase 1 ships net_income as a raw-value for the deep-dive trace.
const net_income: Concept = {
  key: "net_income",
  name: {
    en: "Net Income",
    ro: "Profit net",
  },
  category: "Profitability",
  shortDefinition: {
    en:
      "What's left after every expense — operating costs, depreciation, " +
      "interest, and taxes — has been subtracted from revenue. The " +
      "bottom-line number on the income statement.",
    ro:
      "Ceea ce rămâne după deducerea tuturor cheltuielilor — " +
      "operaționale, amortizare, dobânzi și impozite — din venituri. " +
      "Linia de jos a contului de profit și pierdere.",
  },
  inlineFormula: "EBIT + Net Financial − Tax",
  plainEnglish: {
    en: "What's left for shareholders after every cost — operating, " +
        "interest, tax. Positive = the business earned money this period.",
    ro: "Ce rămâne pentru acționari după toate costurile — operaționale, " +
        "dobânzi, impozit. Pozitiv = afacerea a făcut bani în perioadă.",
  },
  // No interpretation — net_margin (Phase 4) carries the classifier.
  related: ["ebitda", "ebitda_margin", "revenue", "net_margin"],
  computation: (ctx, value) => {
    const m = ctx.metrics ?? {};
    // EBIT refused with EBITDA (one-EBITDA ruling): the build-up has no
    // first operand to show — no formula rather than "EBIT 0 + …".
    if (m.ebit === undefined) return null;
    return {
      result: { value, format: "currency", conceptKey: "net_income" },
      layout: "stacked",
      tokens: [
        {
          type: "value",
          value: m.ebit ?? 0,
          conceptKey: "ebit",
          label: "EBIT",
          format: "currency",
        },
        { type: "operator", op: "+" },
        {
          type: "value",
          value: m.netFinancialResult ?? 0,
          conceptKey: "net_financial_result",
          label: "Net Financial",
          format: "currency",
        },
        { type: "operator", op: "−" },
        {
          type: "value",
          value: m.incomeTax ?? 0,
          conceptKey: "income_tax",
          label: "Tax",
          format: "currency",
        },
      ],
    };
  },
};

// ─── gross_margin ─────────────────────────────────────────────────────────
// Sits between Revenue and EBITDA conceptually. Has its own classifier
// because the band is well-defined per sector. Industry variance is wider
// than EBITDA margin so Phase 1's baseline benchmark is wider.
const gross_margin: Concept = {
  key: "gross_margin",
  name: {
    en: "Gross Margin",
    ro: "Marja brută",
  },
  category: "Profitability",
  shortDefinition: {
    en:
      "What share of revenue is left after subtracting the direct cost " +
      "of goods sold — raw materials, direct labor, and merchandise. " +
      "Indicates pricing power and unit economics.",
    ro:
      "Cât din venituri rămâne după scăderea costului direct al " +
      "bunurilor vândute — materii prime, manoperă directă și " +
      "mărfuri. Indică puterea de preț și economia per unitate.",
  },
  inlineFormula: "(Revenue − COGS) ÷ Revenue × 100",
  benchmark: GROSS_MARGIN_BASELINE_BENCHMARK,
  interpretation: {
    getSentiment: (value, ctx) => {
      const median = ctx?.benchmark?.median ?? GROSS_MARGIN_BASELINE_BENCHMARK.median;
      if (value > median * 1.15) return "positive";
      if (value < median * 0.65) return "negative";
      return "neutral";
    },
    getNarrative: (value, ctx) => {
      const median = ctx?.benchmark?.median ?? GROSS_MARGIN_BASELINE_BENCHMARK.median;
      const diff = (value - median) / median;
      if (diff > 0.15) {
        return "Above industry median — pricing power or favorable mix is a real strength.";
      }
      if (diff < -0.35) {
        return "Materially below median — investigate input costs, pricing, or product mix.";
      }
      return "In line with industry typical for your sector.";
    },
  },
  related: ["ebitda_margin", "revenue", "ebitda", "operating_leverage"],
  computation: (ctx, value) => {
    const m = ctx.metrics ?? {};
    const revenue = m.revenue ?? 0;
    const grossProfit = m.grossProfit ?? (revenue > 0 ? revenue * value : 0);
    const cogs = m.cogs ?? (revenue - grossProfit);
    return {
      result: { value, format: "percentage", conceptKey: "gross_margin" },
      layout: "fraction",
      tokens: [
        { type: "group_open" },
        {
          type: "value",
          value: revenue,
          conceptKey: "revenue",
          label: "Revenue",
          format: "currency",
        },
        { type: "operator", op: "−" },
        {
          type: "value",
          value: cogs,
          conceptKey: "cogs",
          label: "COGS",
          format: "currency",
        },
        { type: "group_close" },
        { type: "operator", op: "÷" },
        {
          type: "value",
          value: revenue,
          conceptKey: "revenue",
          label: "Revenue",
          format: "currency",
        },
      ],
    };
  },
};

/** The 5-concept seed registry. Phase 1's `index.ts` (built next session)
 *  will import this and expose `lookupConcept(key) → Concept | undefined`.
 *  Phase 4 expansion adds more files (profitability.ts, liquidity.ts, etc.)
 *  and the index.ts merges them all. */
export const SEED_CONCEPTS: Readonly<Record<string, Concept>> = {
  [ebitda.key]: ebitda,
  [ebitda_margin.key]: ebitda_margin,
  [revenue.key]: revenue,
  [net_income.key]: net_income,
  [gross_margin.key]: gross_margin,
};

// Re-export individuals so Phase 1 can import them directly if it wants
// to test against a known shape without going through SEED_CONCEPTS.
export { ebitda, ebitda_margin, revenue, net_income, gross_margin };
