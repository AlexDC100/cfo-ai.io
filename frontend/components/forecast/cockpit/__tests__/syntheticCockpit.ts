// A SYNTHETIC cockpit answer — the hermetic double of POST
// /api/forecast/{id}/cockpit (`forecast_cockpit/1`, engine.forecast.cockpit)
// for the page's tests.
//
// Every name and every figure here is invented ("Exemplu Alimentar SRL", round
// synthetic amounts): no client book, name or figure is committed (the repo is
// public). The SHAPE is the engine's payload as lib/forecastCockpit.ts reads
// it, so a test that passes over this passes over the contract, and a contract
// change reds here first.
//
// `seed` shifts every amount so two different requests answer two different,
// recognisable projections (the latest-response-wins and F4 tests read which
// answer is on screen from the painted figures). This file is a TEST DOUBLE:
// the arithmetic in it builds invented numbers and is outside the cockpit's
// no-math rule by construction (__tests__ is not on its roster).

export const SYNTH_COMPANY = "Exemplu Alimentar SRL";
export const SYNTH_BASE = "FY2025";
export const SYNTH_YEARS = ["FY2026", "FY2027", "FY2028", "FY2029", "FY2030"] as const;
const MONTHS = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"];

export interface SynthOptions {
  caseId?: string;
  /** The plan needs a funding line (the pesimist double). */
  funding?: boolean;
  dscrBelow?: boolean;
  dscrNotApplicable?: boolean;
  /** Levers the request moved: id → exact decimal. */
  levers?: Record<string, string>;
  seed?: number;
  /** A case saved by the reader, by name ("saved:<id>" requests). */
  savedName?: string;
  /** Served DEFAULTS that differ from the invented ones — a measured value
   *  with more decimals than the lever's step (the engine serves a measured
   *  growth with six decimals, a DSO with five), the class the lever-scale
   *  gate holds. */
  defaults?: Record<string, string>;
}

type Json = Record<string, unknown>;

const RO_MONTHS = ["ianuarie", "februarie", "martie", "aprilie", "mai", "iunie", "iulie", "august", "septembrie", "octombrie", "noiembrie", "decembrie"];
const EN_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The engine's money display (packs/forecast/cockpit.yaml#money_display):
 *  millions with one decimal, thousands below. */
function money(minor: number): Json {
  const units = minor / 100;
  const one = (v: number, lang: "ro" | "en") => {
    const s = Math.abs(v).toFixed(1);
    const [w, f] = s.split(".");
    const g = w.replace(/\B(?=(\d{3})+(?!\d))/g, lang === "ro" ? "." : ",");
    return `${v < 0 ? "−" : ""}${g}${lang === "ro" ? "," : "."}${f}`;
  };
  if (Math.abs(units) >= 1_000_000) {
    return { ro: `${one(units / 1_000_000, "ro")} mil. lei`, en: `RON ${one(units / 1_000_000, "en")}M` };
  }
  return { ro: `${one(units / 1000, "ro")} mii lei`, en: `RON ${one(units / 1000, "en")}k` };
}
const pct = (d: string): Json => {
  const v = (Number(d) * 100).toFixed(1);
  return { ro: `${v.replace(".", ",")}%`, en: `${v}%` };
};
const days = (d: string): Json => {
  const v = Number(d).toFixed(1);
  return { ro: v.replace(".", ","), en: v };
};
const month = (label: string): Json => {
  const [y, m] = label.split("-");
  return { ro: `${RO_MONTHS[Number(m) - 1]} ${y}`, en: `${EN_MONTHS[Number(m) - 1]} ${y}` };
};

const fig = (minor: number): Json => ({ kind: "projected", amount_minor: minor });

interface LeverDef {
  id: string;
  group: "primary" | "more";
  unit: "pct" | "days";
  shape: "per_year" | "scalar";
  range: [string, string, string];
  /** The lever's FIXED slider scale (packs/forecast/cockpit.yaml#levers[].range.decimals). */
  decimals: number;
  value: string | null;
  label: [string, string];
  basis: [string, string];
  inert?: [string, string];
  measured?: boolean;
}

const LEVERS: LeverDef[] = [
  { id: "revenue_growth", group: "primary", unit: "pct", shape: "per_year", range: ["-0.30", "0.30", "0.001"], decimals: 3, value: "0.031",
    label: ["Creștere venituri/an", "Revenue growth / year"],
    basis: ["istoric 3,1% (2024→2025, sintetic) · mediana sectorului 4,4% (sintetic)", "history 3.1% (2024→2025, synthetic) · sector median 4.4% (synthetic)"] },
  { id: "inflation", group: "primary", unit: "pct", shape: "per_year", range: ["0", "0.15", "0.001"], decimals: 3, value: "0.025",
    label: ["Inflație/an", "Inflation / year"],
    basis: ["ancora BNR 2,5% (serie sintetică, confirmată 2026-09-08)", "BNR anchor 2.5% (synthetic series, confirmed 2026-09-08)"] },
  { id: "raw_material_price", group: "primary", unit: "pct", shape: "scalar", range: ["-0.30", "0.50", "0.01"], decimals: 2, value: "0",
    label: ["Preț materie primă (față de 2025)", "Raw-material price (vs 2025)"],
    basis: ["materia primă e 40,0% din costul vânzărilor (601+602, sintetic)", "raw materials are 40.0% of cost of sales (601+602, synthetic)"] },
  { id: "wage_growth", group: "primary", unit: "pct", shape: "per_year", range: ["0", "0.20", "0.001"], decimals: 3, value: "0.025",
    label: ["Creștere salarii/an (incl. salariul minim)", "Wage growth / year (incl. minimum wage)"],
    basis: ["urmează inflația până la setare (salariul minim, sintetic)", "follows inflation until set (minimum wage, synthetic)"] },
  { id: "energy_price", group: "more", unit: "pct", shape: "scalar", range: ["-0.50", "1.00", "0.01"], decimals: 2, value: "0",
    label: ["Preț energie (față de 2025)", "Energy price (vs 2025)"],
    basis: ["energia 605: 2,0 mil. lei în 2025 (sintetic)", "energy 605: RON 2.0M in 2025 (synthetic)"] },
  { id: "eur_ron", group: "more", unit: "pct", shape: "scalar", range: ["-0.20", "0.30", "0.005"], decimals: 3, value: null, measured: false,
    label: ["Curs EUR/RON pe inputuri importate (față de 2025)", "EUR/RON on imported inputs (vs 2025)"],
    basis: ["balanța nu separă achizițiile pe monede: nu se poate măsura", "the trial balance does not split purchases by currency: not measurable"],
    inert: ["nu are efect până nu setezi ponderea inputurilor importate", "has no effect until you set the imported share"] },
  { id: "imported_share", group: "more", unit: "pct", shape: "scalar", range: ["0", "1", "0.01"], decimals: 2, value: "0",
    label: ["Pondere inputuri importate în costul vânzărilor", "Imported share of cost of sales"],
    basis: ["declarat de tine; balanța nu o măsoară", "stated by you; the book does not measure it"] },
  { id: "dso_days", group: "more", unit: "days", shape: "per_year", range: ["0", "365", "1"], decimals: 0, value: "45",
    label: ["Zile încasare clienți (DSO)", "Days sales outstanding (DSO)"],
    basis: ["măsurat din balanță: 45,0 zile (sintetic)", "measured on the book: 45.0 days (synthetic)"] },
  { id: "dio_days", group: "more", unit: "days", shape: "per_year", range: ["0", "365", "1"], decimals: 0, value: "52",
    label: ["Zile stoc (DIO)", "Days inventory (DIO)"],
    basis: ["măsurat din balanță: 52,0 zile (sintetic)", "measured on the book: 52.0 days (synthetic)"] },
  { id: "capex", group: "more", unit: "pct", shape: "per_year", range: ["0", "0.30", "0.001"], decimals: 3, value: "0.03",
    label: ["Investiții (% din venituri)", "Capital expenditure (% of revenue)"],
    basis: ["media balanței (sintetic)", "the book's average (synthetic)"] },
  { id: "interest_rate", group: "more", unit: "pct", shape: "per_year", range: ["0.01", "0.25", "0.0005"], decimals: 4, value: "0.055",
    label: ["Rata dobânzii", "Interest rate"],
    basis: ["dobânzi / datorii purtătoare de dobândă: 5,5% (sintetic)", "interest / interest-bearing debt: 5.5% (synthetic)"] },
];

const CASES: Array<{ id: string; label: [string, string]; basis: [string, string]; levers: Record<string, string[]> }> = [
  { id: "base", label: ["Bază", "Base"], basis: ["prognoza motorului (sintetic)", "the engine's forecast (synthetic)"], levers: {} },
  { id: "optimist", label: ["Optimist", "Optimist"], basis: ["veniturile cresc cu 4,4% (mediana sectorului, sintetic)", "revenue grows at 4.4% (sector median, synthetic)"],
    levers: { revenue_growth: ["0.044", "0.044", "0.044", "0.044", "0.044"], inflation: ["0.015", "0.015", "0.015", "0.015", "0.015"] } },
  { id: "pesimist", label: ["Pesimist", "Pessimist"], basis: ["inflația pe traiectoria BNR (sintetic); materia primă +12,0%", "inflation on the BNR path (synthetic); raw materials +12.0%"],
    levers: { inflation: ["0.045", "0.035", "0.03", "0.03", "0.03"], raw_material_price: ["0.12"] } },
];

export function syntheticCockpit(opts: SynthOptions = {}): Json {
  const caseId = opts.caseId ?? "base";
  const saved = caseId.startsWith("saved:");
  const engineCase = CASES.find((c) => c.id === caseId);
  const seed = opts.seed ?? 0;
  const funding = opts.funding ?? false;
  const shift = seed * 100_000;
  const moved = opts.levers ?? {};

  const ebitdaYear = (i: number) => 1_200_000_000 + i * 130_000_000 + shift;
  const cashYear = (i: number) => (funding && i >= 0 ? 0 : 400_000_000 + i * 900_000_000 + shift);

  const chartEbitda: Json[] = [{ period: SYNTH_BASE, kind: "actual", amount_minor: 1_150_000_000 }];
  SYNTH_YEARS.forEach((y, i) => chartEbitda.push({ period: y, kind: "projected", amount_minor: ebitdaYear(i) }));
  const chartCash: Json[] = [
    { period: SYNTH_BASE, kind: "actual", granularity: "annual", cash_minor: 300_000_000, funding_line_minor: 0, cash_before_funding_minor: 300_000_000, gap: false },
  ];
  MONTHS.forEach((m, k) => {
    const draw = funding && k >= 9;
    const cash = draw ? 0 : 320_000_000 + k * 5_000_000 + shift;
    chartCash.push({
      period: `2026-${m}`, kind: "projected", granularity: "monthly", cash_minor: cash,
      funding_line_minor: draw ? 1_800_000_000 : 0,
      cash_before_funding_minor: draw ? -1_800_000_000 : cash, gap: draw,
    });
  });
  SYNTH_YEARS.slice(1).forEach((y, j) => {
    const i = j + 1;
    const cash = cashYear(i);
    chartCash.push({
      period: y, kind: "projected", granularity: "annual", cash_minor: cash,
      funding_line_minor: funding ? 1_500_000_000 : 0,
      cash_before_funding_minor: funding ? -1_500_000_000 : cash, gap: funding,
    });
  });

  const row = (line: string, ro: string, en: string, fn: (i: number) => number, y0: number | null): Json => ({
    line,
    label: { ro, en },
    values: SYNTH_YEARS.map((y, i) => ({ period: y, kind: "projected", amount_minor: fn(i) })),
    ...(y0 === null ? {} : { year0: { kind: "actual", amount_minor: y0, period: SYNTH_BASE } }),
  });
  const statements = {
    years: [SYNTH_BASE, ...SYNTH_YEARS],
    pl: [
      row("pl.revenue", "Venituri", "Revenue", (i) => 10_000_000_000 + i * 300_000_000 + shift, 9_700_000_000),
      {
        ...row("pl.cost_of_sales", "Costul vânzărilor", "Cost of sales", (i) => -(6_000_000_000 + i * 150_000_000), null),
        // the engine's refusal for a year-0 line the book does not split
        year0: {
          kind: "actual",
          refused: {
            code: "year0_not_split",
            text: { ro: "anul realizat nu separă această linie", en: "the actual year does not split this line" },
          },
          period: SYNTH_BASE,
        },
      },
      row("pl.ebitda", "EBITDA", "EBITDA", ebitdaYear, 1_150_000_000),
      row("pl.interest_expense_debt", "Dobânzi la datorii", "Interest on debt", () => -50_000_000, null),
      row("pl.interest_expense_funding_line", "Dobânda liniei de credit", "Interest on the credit line", () => (funding ? -2_469_120 : 0), null),
      row("pl.net_income", "Profit net", "Net income", (i) => 700_000_000 + i * 90_000_000 + shift, 690_000_000),
    ],
    bs: [
      row("bs.cash", "Numerar", "Cash", cashYear, 300_000_000),
      row("bs.revolver", "Linie de credit", "Credit line", () => (funding ? 1_500_000_000 : 0), 0),
      row("bs_totals.assets", "Total active", "Total assets", (i) => 6_000_000_000 + i * 700_000_000, 5_600_000_000),
    ],
    cf: [
      row("cf.cash_from_operating", "Numerar din exploatare", "Cash from operating", (i) => 1_000_000_000 + i * 100_000_000, null),
      row("cf.closing_cash", "Numerar la sfârșit", "Closing cash", cashYear, null),
    ],
  };

  const levers = LEVERS.map((l) => {
    const caseValues = engineCase?.levers[l.id];
    const served = opts.defaults?.[l.id] ?? l.value;
    let value: string | string[] | null = served;
    let origin = "default";
    if (caseValues) {
      value = caseValues.length === 1 || new Set(caseValues).size === 1 ? caseValues[0] : caseValues;
      origin = "case";
    }
    if (moved[l.id] !== undefined) {
      value = moved[l.id];
      origin = "user";
    }
    const first = Array.isArray(value) ? value[0] : value;
    const display = first === null ? null : l.unit === "days" ? days(first) : pct(first);
    return {
      id: l.id, group: l.group, unit: l.unit, shape: l.shape,
      label: { ro: l.label[0], en: l.label[1] },
      value, default: served, is_default: origin === "default", origin,
      display,
      range: { min: l.range[0], max: l.range[1], step: l.range[2] },
      decimals: l.decimals,
      basis: { ro: l.basis[0], en: l.basis[1] },
      source: {}, measured: l.measured !== false, follows: l.id === "wage_growth" ? "inflation" : null,
      inert: l.inert ? { ro: l.inert[0], en: l.inert[1] } : null, locked: null,
      engine_drivers: [l.id],
    };
  });

  const dscr = opts.dscrNotApplicable
    ? { period: "FY2026", status: "not_applicable", numerator: fig(1_200_000_000), denominator: fig(0), threshold: "1.25", threshold_band: "healthy",
        formula: { ro: "EBITDA / (dobânzi + datorii pe termen scurt)", en: "EBITDA / (interest + short-term debt)" } }
    : {
        period: "FY2026", kind: "projected", value_micros: opts.dscrBelow ? 980_000 : 2_100_000,
        numerator: fig(1_200_000_000), denominator: fig(opts.dscrBelow ? 1_224_489_796 : 571_428_571),
        threshold: "1.25", threshold_band: "healthy",
        status: opts.dscrBelow ? "below" : "above", colour: opts.dscrBelow ? "red" : "green",
        formula: { ro: "EBITDA / (dobânzi + datorii pe termen scurt)", en: "EBITDA / (interest + short-term debt)" },
        display: opts.dscrBelow
          ? { ro: { value: "0,98×", threshold: "1,25×" }, en: { value: "0.98×", threshold: "1.25×" } }
          : { ro: { value: "2,10×", threshold: "1,25×" }, en: { value: "2.10×", threshold: "1.25×" } },
      };

  const ebitdaFinal = ebitdaYear(4);
  const fcf = 4_500_000_000 + shift;
  const cash = funding
    ? {
        kind: "funding_need", figure: fig(1_800_000_000), first_period: "2026-10", first_granularity: "monthly", peak_period: "2026-10",
        funding_interest: fig(12_345_600),
        display: {
          ro: { amount: (money(1_800_000_000) as { ro: string }).ro, when: (month("2026-10") as { ro: string }).ro, interest: (money(12_345_600) as { ro: string }).ro },
          en: { amount: (money(1_800_000_000) as { en: string }).en, when: (month("2026-10") as { en: string }).en, interest: (money(12_345_600) as { en: string }).en },
        },
      }
    : {
        kind: "min_cash", figure: fig(310_000_000 + shift), period: "2026-03",
        granularity_note: { ro: "la închiderile de perioadă", en: "at period closes" },
        display: {
          ro: { amount: (money(310_000_000 + shift) as { ro: string }).ro, when: (month("2026-03") as { ro: string }).ro },
          en: { amount: (money(310_000_000 + shift) as { en: string }).en, when: (month("2026-03") as { en: string }).en },
        },
      };

  const caseLabel = saved ? { ro: opts.savedName ?? "caz salvat", en: opts.savedName ?? "saved case" } : { ro: engineCase?.label[0] ?? caseId, en: engineCase?.label[1] ?? caseId };
  const inSentence = saved ? `„${opts.savedName}”` : caseId === "pesimist" ? "pesimist" : caseId === "optimist" ? "optimist" : "de bază";
  const inSentenceEn = saved ? `“${opts.savedName}”` : caseId === "pesimist" ? "pessimist" : caseId === "optimist" ? "optimist" : "base";
  const cashRo = funding
    ? `ai nevoie de o linie de credit de până la 18,0 mil. lei începând din octombrie 2026`
    : `numerarul nu scade sub zero, cu un minim de ${(money(310_000_000 + shift) as { ro: string }).ro} în martie 2026`;
  const cashEn = funding
    ? `you need a credit line of up to RON 18.0M starting in October 2026`
    : `cash never goes below zero, with a low of ${(money(310_000_000 + shift) as { en: string }).en} in March 2026`;
  const dscrRo = opts.dscrBelow ? "DSCR scade sub pragul băncii: 0,98× în 2026 față de 1,25×" : "DSCR rămâne peste pragul băncii: 2,10× în 2026 față de 1,25×";
  const dscrEn = opts.dscrBelow ? "DSCR falls below the bank's threshold: 0.98× in 2026 against 1.25×" : "DSCR stays above the bank's threshold: 2.10× in 2026 against 1.25×";

  const step = (id: string, ro: string, en: string, v: number, subtotal = false, total = false) => ({ id, label: { ro, en }, subtotal, total, figure: fig(v) });
  const bridge = (window: string, period: string) => ({
    window, period, sums_exactly: true, closing_cash_base: fig(4_000_000_000), closing_cash_case: fig(3_650_000_000),
    steps: [
      step("revenue", "Venituri", "Revenue", -2_000_000_000),
      step("costs", "Costuri", "Costs", 1_100_000_000),
      step("ebitda", "EBITDA", "EBITDA", -900_000_000, true),
      step("working_capital", "Capital de lucru", "Working capital", -300_000_000),
      step("capex", "Investiții", "Capital expenditure", 50_000_000),
      step("interest_tax", "Dobânzi și impozit", "Interest and tax", 100_000_000),
      step("dividends", "Dividende", "Dividends", 0),
      step("debt", "Datorii și linia de credit", "Debt and the credit line", 700_000_000),
      step("cash", "Numerar la sfârșit", "Closing cash", -350_000_000, false, true),
    ],
  });
  const base = caseId === "base" && Object.keys(moved).length === 0;

  return {
    kind: "projection",
    cockpit_version: "forecast_cockpit/1",
    currency: "RON",
    company_name: null,
    base_period: {
      period_end: "2025-12-31", label: SYNTH_BASE,
      figures: {
        revenue: { kind: "actual", amount_minor: 9_700_000_000 }, ebitda: { kind: "actual", amount_minor: 1_150_000_000 },
        net_income: { kind: "actual", amount_minor: 690_000_000 }, cash: { kind: "actual", amount_minor: 300_000_000 },
        total_assets: { kind: "actual", amount_minor: 5_600_000_000 }, equity: { kind: "actual", amount_minor: 3_000_000_000 },
        ebitda_margin_ppm: 118_557,
      },
    },
    horizon: { total_years: 5, monthly_months: 12, years: [...SYNTH_YEARS] },
    case: { id: caseId, name: saved ? opts.savedName ?? null : null, label: caseLabel, modified: Object.keys(moved).length > 0 },
    numbers: {
      ebitda_final_year: {
        period: "FY2030", figure: fig(ebitdaFinal), margin_ppm: 152_000, margin_year0_ppm: 118_557, margin_change_ppm: 33_443,
        display: {
          ro: { amount: (money(ebitdaFinal) as { ro: string }).ro, margin: "15,2%", margin_year0: "11,9%" },
          en: { amount: (money(ebitdaFinal) as { en: string }).en, margin: "15.2%", margin_year0: "11.9%" },
        },
      },
      cumulative_fcf: {
        from: "FY2026", to: "FY2030", figure: fig(fcf),
        formula: { ro: "numerar din exploatare + numerar din investiții, cumulat", en: "operating cash + investing cash, cumulative" },
        display: money(fcf),
      },
      cash,
      dscr_year_one: dscr,
    },
    sentence: {
      template: ["frame"], facts: {},
      ro: `În scenariul ${inSentence}, ${cashRo}; ${dscrRo}; EBITDA ajunge la ${(money(ebitdaFinal) as { ro: string }).ro} în 2030, cu o marjă de 15,2% față de 11,9% azi.`,
      en: `In the ${inSentenceEn} case, ${cashEn}; ${dscrEn}; EBITDA reaches ${(money(ebitdaFinal) as { en: string }).en} in 2030, a margin of 15.2% against 11.9% today.`,
    },
    chart: { ebitda: chartEbitda, cash: chartCash, funding_gap: funding },
    levers,
    cases: CASES.map((c) => ({ id: c.id, label: { ro: c.label[0], en: c.label[1] }, basis: { ro: c.basis[0], en: c.basis[1] }, levers: c.levers })),
    bridge: base
      ? { year_one: { ...bridge("year_one", "2026-12"), steps: bridge("year_one", "2026-12").steps.map((s) => ({ ...s, figure: fig(0) })) },
          horizon: { ...bridge("horizon", "FY2030"), steps: bridge("horizon", "FY2030").steps.map((s) => ({ ...s, figure: fig(0) })) } }
      : { year_one: bridge("year_one", "2026-12"), horizon: bridge("horizon", "FY2030") },
    statements,
    dscr_by_year: [],
    engine_request: { overrides: {}, shocks: [] },
    conventions: [
      { id: "held_at_opening_balance", sentence: "balance-sheet lines this model does not drive are HELD at their opening balance [engine_default]" },
    ],
    funding_line: { rate_basis: "the funding line is priced at this book's own borrowing rate", floor_minor: 0, priced_at: "book", reference: null },
    cost_behaviour: [
      { pool: "personnel", label: { ro: "Personal", en: "Personnel" }, base_minor: 1_500_000_000, fixed_share_ppm: 800_000, tier: "convention", rule_id: "x",
        sentence: "personnel: fixed share by the convention classification (synthetic)" },
    ],
    not_modelled: [{ id: "headcount", sentence: "headcount is not served: a trial balance carries the personnel cost and not the number of people" }],
    pins: { pack_id: "forecast-cockpit", cockpit_pack: "sha256:synthetic", body_hash: `sha256:synthetic-${caseId}-${seed}` },
    period_id: "p-synth",
    recompute_ms: 42,
  };
}

/** The double of POST .../cockpit/export: the engine's export document built
 *  FROM a cockpit answer (engine.forecast.cockpit.export_document). */
export function syntheticExport(cockpit: Json): Json {
  const levers = (cockpit.levers as Json[]).map((l) => ({
    id: l.id, label: l.label, value: l.value, display: l.display, origin: l.origin,
    origin_label: { default: { ro: "implicit", en: "default" }, case: { ro: "din scenariu", en: "from the case" }, user: { ro: "setat de utilizator", en: "set by the user" } }[l.origin as string],
    basis: l.basis, measured: l.measured, inert: l.inert, locked: l.locked,
  }));
  const kase = cockpit.case as Json;
  const served = (cockpit.cases as Json[]).find((c) => c.id === kase.id);
  return {
    document: {
      kind: "bank_forecast", title: { ro: "Prognoză financiară pentru bancă", en: "Financial forecast for the bank" },
      company_name: cockpit.company_name, currency: cockpit.currency, period_id: cockpit.period_id,
      base_period: cockpit.base_period, horizon: cockpit.horizon, case: kase, sentence: cockpit.sentence,
      projected_note: { ro: "Toate cifrele marcate ◇ sunt proiectate de motor.", en: "Every figure marked ◇ is projected by the engine." },
      sections: {
        numbers: { ro: "Cele patru cifre", en: "The four numbers" }, chart: { ro: "EBITDA și numerar", en: "EBITDA and cash" },
        statements: { ro: "Situații proiectate", en: "Projected statements" }, bridge: { ro: "Punte față de scenariul de bază", en: "Bridge from the base case" },
        levers: { ro: "Pârghii și baza lor", en: "Levers and their basis" }, cost_behaviour: { ro: "Costuri fixe și variabile", en: "Fixed and variable costs" },
        conventions: { ro: "Convenții ale modelului", en: "Model conventions" }, not_modelled: { ro: "Ce nu modelează această prognoză", en: "What this forecast does not model" },
        sources: { ro: "Surse externe", en: "External sources" },
      },
      pins: cockpit.pins,
    },
    cockpit,
    assumptions_page: {
      title: { ro: "Ipoteze", en: "Assumptions" },
      case: { id: kase.id, label: kase.label, basis: served ? served.basis : null },
      levers,
      dscr: { formula: { ro: "EBITDA / (dobânzi + datorii pe termen scurt)", en: "EBITDA / (interest + short-term debt)" }, threshold: "1.25", threshold_band: "healthy" },
      funding_line: cockpit.funding_line,
      cost_behaviour: cockpit.cost_behaviour,
      conventions: cockpit.conventions,
      not_modelled: cockpit.not_modelled,
      sources: [{ series_id: "ro.bnr.synthetic", source: "BNR (synthetic series)", source_url: null, kind: "macro" }],
    },
  };
}
