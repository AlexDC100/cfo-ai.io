// "Known issues in this report" — the words, in both languages, for the
// /sample page AND the sample report (HTML + PDF).
//
// WHY THIS EXISTS (2026-10-02). The public sample is the product's real
// output for a fictional book, and it exposed three defects of the engine
// that are fixed in the engine's own releases, not here:
//   · the cash flow is estimated (the engine does not read the prior
//     period yet) and, for this book, the estimate contradicts the ledgers;
//   · one finding quotes a quick ratio on a different definition from the
//     ratio table, under the label "as reported";
//   · the asset-age finding's bases include land, construction in progress
//     and intangible assets.
// The owner's rule: nothing known-false is published unflagged. So the page
// and the report both OPEN with this box.
//
// NO FIGURE IS TYPED HERE. Every number is a field of
// public/sample/known_issues_fy2025.json — written by
// scripts/build_public_sample.py (`known_issues`): the engine's figures
// with the pointers they were read from, and the ledger's, which are sums
// over named accounts of the published trial balance. Gate `public-sample`
// S11 re-reads the published workbook and repeats those sums. The
// templates below carry `{tokens}` only; an unknown token throws.
//
// AN ISSUE LEAVES BY ITSELF: the generator lists an issue only while the
// engine's figure differs from the ledger's, and this module renders the
// issues it is given — an id it has no words for throws, so a new issue
// cannot be published without a sentence.
//
// DEPENDENCY-FREE on purpose (no i18n instance, no browser): the report
// builder loads it under Node.

export type KnownIssueLang = "en" | "ro";

export interface CashFlowIssue {
  id: "cash_flow_estimated";
  engine: {
    is_approximated: boolean;
    net_change_in_cash: number;
    cash_from_investing: number;
    cash_from_financing: number;
    cash_from_operating: number;
    implied_opening_cash: number;
  };
  ledger: {
    cash_opening: number;
    cash_closing: number;
    cash_movement: number;
    fixed_asset_additions_ex_vat: number;
    paid_to_fixed_asset_suppliers: number;
    loans_drawn: number;
    loans_repaid: number;
    lease_repaid: number;
    credit_line_change: number;
    dividends: number;
    interest: number;
    financing: number;
  };
}

export interface QuickRatioIssue {
  id: "quick_ratio_two_definitions";
  finding_title: string;
  finding_measure_label: string;
  ratio_table: { value: number; cash: number; trade_receivables: number; current_liabilities: number };
  finding: { value: number; current_assets: number; inventory: number; current_liabilities: number };
}

export interface AssetAgeIssue {
  id: "asset_age_bases";
  finding_title: string;
  engine: {
    depreciated_share: number;
    remaining_book_life_years: number;
    net_book_value: number;
    gross_ppe: number;
    annual_charge: number;
  };
  ledger: {
    depreciable_tangible_gross: number;
    accumulated_depreciation: number;
    remaining_net_book_value: number;
    annual_depreciation_charge: number;
    depreciated_share: number;
    remaining_life_years: number;
    land: number;
    construction_in_progress: number;
    intangibles_net: number;
  };
}

export type KnownIssue = CashFlowIssue | QuickRatioIssue | AssetAgeIssue;

export interface KnownIssuesText {
  lang: KnownIssueLang;
  title: string;
  lede: string;
  items: Array<{ id: KnownIssue["id"]; title: string; body: string }>;
  closing: string;
}

const LOCALE: Record<KnownIssueLang, string> = { en: "en-US", ro: "ro-RO" };

/** "118,524.00 RON" / "118.524,00 RON" — the code after the figure, the
 *  reader's number format (CLAUDE.md §26); a negative as Intl prints it,
 *  the same string the /sample page's money printer gives. */
function money(value: number, lang: KnownIssueLang): string {
  const figure = new Intl.NumberFormat(LOCALE[lang], {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
  return `${figure}\u00a0RON`;
}

function decimal(value: number, places: number, lang: KnownIssueLang): string {
  return new Intl.NumberFormat(LOCALE[lang], {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  }).format(value);
}

const percent = (share: number, lang: KnownIssueLang): string => `${decimal(share * 100, 1, lang)}%`;
const multiple = (value: number, places: number, lang: KnownIssueLang): string =>
  `${decimal(value, places, lang)}×`;

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_whole, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`known-issues template has no value for {${key}}`);
    return value;
  });
}

interface IssueWords {
  title: string;
  body: string;
}

const WORDS: Record<
  KnownIssueLang,
  {
    title: string;
    /** {n} */
    lede: string;
    closing: string;
    issues: Record<KnownIssue["id"], IssueWords>;
  }
> = {
  en: {
    title: "Known issues in this report",
    lede:
      "This report is the product's real output for the fictional book, and it is wrong or misleading in the places listed here. Each is an open defect of the engine, not of the sample. The correct figures are sums over named accounts of the published trial balance, computed by the script that builds this sample and repeated by a release gate — none is typed.",
    closing:
      "The sample is regenerated when each fix ships; an issue leaves this list when the engine's figure equals the ledger's.",
    issues: {
      cash_flow_estimated: {
        title: "The cash flow is an estimate, and for this book the estimate contradicts the ledgers",
        body:
          "The engine does not read the prior period yet, so it estimates the cash-flow statement from the year-end balances alone. " +
          "Net change in cash: the report prints {engine_net}; on the two trial balances cash went from {cash_opening} to {cash_closing}, a movement of {cash_movement} (the report's figure implies an opening balance of {implied_opening}). " +
          "Investing: the report prints {engine_investing}; the ledger shows {additions} of fixed-asset additions excluding VAT, and {paid_fixed} paid to fixed-asset suppliers. " +
          "Financing: the report prints {engine_financing}; the ledger shows loans drawn {loans_drawn}, loans repaid {loans_repaid}, lease repayments {lease_repaid}, the credit line moving by {credit_line}, dividends {dividends} and interest {interest} — {ledger_financing} in all. " +
          "Read every cash-flow line of this report, the cash walk, and the Piotroski test that rests on operating cash flow ({engine_operating} here) as an estimate that does not tie to the ledgers.",
      },
      quick_ratio_two_definitions: {
        title: "One finding quotes a quick ratio on a different definition from the ratio table",
        body:
          "The ratio table prints a quick ratio of {table_q}: cash plus trade receivables ({cash} + {receivables}) over current liabilities ({liabilities}), which is {table_precise}. " +
          "The finding \"{finding_title}\" prints \"{measure_label} {finding_q}\": that figure is current assets less inventory ({current_assets} − {inventory}) over the same liabilities, which is {finding_precise}. " +
          "The ratio table's {table_q} is the quick ratio this report reports; the finding's row is on another definition and should not be labelled \"as reported\".",
      },
      asset_age_bases: {
        title: "The asset-age finding counts land, construction in progress and intangible assets",
        body:
          "The finding \"{finding_title}\" says {engine_share} of gross PP&E is depreciated and that a net book value of {engine_nbv} carries {engine_years} years of life at an annual charge of {engine_charge}. " +
          "Those bases include land ({land}, never depreciated), construction in progress ({in_progress}, not yet depreciated) and intangible assets ({intangibles} net). " +
          "On depreciable tangible assets alone — buildings, equipment, vehicles and furniture, {gross} gross — {ledger_share} is depreciated, and the remaining {ledger_nbv} carries {ledger_years} years at the year's depreciation charge of {ledger_charge}.",
      },
    },
  },
  ro: {
    title: "Probleme cunoscute în acest raport",
    lede:
      "Acest raport este rezultatul real al produsului pentru balanța fictivă și este greșit sau înșelător în locurile enumerate aici. Fiecare este un defect deschis al motorului, nu al exemplului. Cifrele corecte sunt sume pe conturi numite din balanța de verificare publicată, calculate de scriptul care construiește acest exemplu și repetate de o verificare de lansare — niciuna nu este tastată.",
    closing:
      "Exemplul este regenerat când este livrată fiecare corecție; o problemă dispare din această listă când cifra motorului este egală cu cea din balanță.",
    issues: {
      cash_flow_estimated: {
        title: "Fluxul de numerar este o estimare, iar pentru această balanță estimarea contrazice registrele",
        body:
          "Motorul nu citește încă perioada anterioară, deci estimează situația fluxurilor de numerar doar din soldurile de la sfârșitul anului. " +
          "Variația netă a numerarului: raportul afișează {engine_net}; în cele două balanțe numerarul a trecut de la {cash_opening} la {cash_closing}, o mișcare de {cash_movement} (cifra din raport presupune un sold inițial de {implied_opening}). " +
          "Investiții: raportul afișează {engine_investing}; registrul arată intrări de imobilizări de {additions} fără TVA și {paid_fixed} plătiți furnizorilor de imobilizări. " +
          "Finanțare: raportul afișează {engine_financing}; registrul arată credite trase {loans_drawn}, credite rambursate {loans_repaid}, rate de leasing {lease_repaid}, linia de credit modificată cu {credit_line}, dividende {dividends} și dobânzi {interest} — în total {ledger_financing}. " +
          "Citește fiecare linie de flux de numerar din acest raport, graficul numerarului și testul Piotroski care se sprijină pe fluxul operațional ({engine_operating} aici) ca pe o estimare care nu se leagă de registre.",
      },
      quick_ratio_two_definitions: {
        title: "O constatare citează o lichiditate imediată pe altă definiție decât tabelul de indicatori",
        body:
          "Tabelul de indicatori afișează o lichiditate imediată (quick ratio) de {table_q}: numerar plus creanțe comerciale ({cash} + {receivables}) împărțit la datoriile curente ({liabilities}), adică {table_precise}. " +
          "Constatarea „{finding_title}” afișează „{measure_label} {finding_q}”: cifra aceea este activele curente minus stocurile ({current_assets} − {inventory}) împărțit la aceleași datorii, adică {finding_precise}. " +
          "Valoarea {table_q} din tabelul de indicatori este lichiditatea imediată pe care o raportează acest raport; rândul din constatare este pe altă definiție și nu ar trebui etichetat „as reported”.",
      },
      asset_age_bases: {
        title: "Constatarea despre vârsta activelor include terenuri, imobilizări în curs și imobilizări necorporale",
        body:
          "Constatarea „{finding_title}” spune că {engine_share} din imobilizările corporale brute sunt amortizate și că o valoare netă contabilă de {engine_nbv} mai are {engine_years} ani de viață la o cheltuială anuală de {engine_charge}. " +
          "Aceste baze includ terenuri ({land}, care nu se amortizează), imobilizări corporale în curs ({in_progress}, încă neamortizate) și imobilizări necorporale ({intangibles} net). " +
          "Doar pe imobilizările corporale amortizabile — construcții, echipamente, mijloace de transport și mobilier, {gross} brut — sunt amortizate {ledger_share}, iar restul de {ledger_nbv} mai are {ledger_years} ani la amortizarea anului, de {ledger_charge}.",
      },
    },
  },
};

function valuesOf(issue: KnownIssue, lang: KnownIssueLang): Record<string, string> {
  if (issue.id === "cash_flow_estimated") {
    const { engine, ledger } = issue;
    return {
      engine_net: money(engine.net_change_in_cash, lang),
      engine_investing: money(engine.cash_from_investing, lang),
      engine_financing: money(engine.cash_from_financing, lang),
      engine_operating: money(engine.cash_from_operating, lang),
      implied_opening: money(engine.implied_opening_cash, lang),
      cash_opening: money(ledger.cash_opening, lang),
      cash_closing: money(ledger.cash_closing, lang),
      cash_movement: money(ledger.cash_movement, lang),
      additions: money(ledger.fixed_asset_additions_ex_vat, lang),
      paid_fixed: money(ledger.paid_to_fixed_asset_suppliers, lang),
      loans_drawn: money(ledger.loans_drawn, lang),
      loans_repaid: money(ledger.loans_repaid, lang),
      lease_repaid: money(ledger.lease_repaid, lang),
      credit_line: money(ledger.credit_line_change, lang),
      dividends: money(ledger.dividends, lang),
      interest: money(ledger.interest, lang),
      ledger_financing: money(ledger.financing, lang),
    };
  }
  if (issue.id === "quick_ratio_two_definitions") {
    const { ratio_table: table, finding } = issue;
    return {
      finding_title: issue.finding_title,
      measure_label: issue.finding_measure_label,
      table_q: multiple(table.value, 2, lang),
      table_precise: multiple(table.value, 4, lang),
      finding_q: multiple(finding.value, 2, lang),
      finding_precise: multiple(finding.value, 4, lang),
      cash: money(table.cash, lang),
      receivables: money(table.trade_receivables, lang),
      liabilities: money(table.current_liabilities, lang),
      current_assets: money(finding.current_assets, lang),
      inventory: money(finding.inventory, lang),
    };
  }
  if (issue.id === "asset_age_bases") {
    const { engine, ledger } = issue;
    return {
      finding_title: issue.finding_title,
      engine_share: percent(engine.depreciated_share, lang),
      engine_nbv: money(engine.net_book_value, lang),
      engine_years: decimal(engine.remaining_book_life_years, 1, lang),
      engine_charge: money(engine.annual_charge, lang),
      land: money(ledger.land, lang),
      in_progress: money(ledger.construction_in_progress, lang),
      intangibles: money(ledger.intangibles_net, lang),
      gross: money(ledger.depreciable_tangible_gross, lang),
      ledger_share: percent(ledger.depreciated_share, lang),
      ledger_nbv: money(ledger.remaining_net_book_value, lang),
      ledger_years: decimal(ledger.remaining_life_years, 1, lang),
      ledger_charge: money(ledger.annual_depreciation_charge, lang),
    };
  }
  throw new Error(`no words for the known issue "${(issue as { id: string }).id}"`);
}

/** The box, in one language. `issues` is `known_issues` of
 *  frontend/data/publicSample.json (the page) or `issues` of
 *  public/sample/known_issues_fy2025.json (the report) — the same list. */
export function knownIssuesText(issues: readonly KnownIssue[], lang: KnownIssueLang): KnownIssuesText {
  const words = WORDS[lang];
  return {
    lang,
    title: words.title,
    lede: words.lede,
    items: issues.map((issue) => {
      const own = words.issues[issue.id];
      if (!own) throw new Error(`no words for the known issue "${issue.id}"`);
      return { id: issue.id, title: own.title, body: fill(own.body, valuesOf(issue, lang)) };
    }),
    closing: words.closing,
  };
}

/** The cover's one line: how many issues, and where they are listed. */
export function knownIssuesCoverLine(count: number): string {
  if (count === 0) return "";
  const en = count === 1 ? "1 known issue in this report" : `${count} known issues in this report`;
  const ro = count === 1 ? "1 problemă cunoscută în acest raport" : `${count} probleme cunoscute în acest raport`;
  return `${en}, listed before the executive summary · ${ro}, listate înaintea rezumatului`;
}
