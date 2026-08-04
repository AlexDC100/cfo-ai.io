// Metrics redesign (2026-08-04) — `metricsV2` string catalog (data only).
//
// Kept import-free so tooling (the i18n fragment generator) can load it
// without pulling the app's i18n bootstrap. The runtime registration and
// helpers live in ./metricsV2I18n.ts; the mergeable locale fragment
// (scratchpad i18n-fragments/metricsv2.json) is generated FROM this file,
// so the two can never drift.

export const metricsV2En = {
  title: "Metrics",
  addMetric: "Add metric",
  done: "Done",
  reset: "Reset",
  cardLimitReached: "Card limit reached (20)",
  emptyTitle: "Your dashboard is empty. Add the metrics you want to track.",
  pickerTitle: "Add a metric",
  searchPlaceholder: "Search metrics…",
  noMatch: 'No metrics match "{{query}}"',
  allAdded: "Every available metric is already on your dashboard.",
  aboutMetric: "About this metric",
  dragToReorder: "Drag to reorder",
  removeCard: "Remove card",
  tapToResize: "Tap the card to change its size",
  menu: {
    open: "Card options",
    rearrange: "Rearrange",
    size: "Size",
    sizeSm: "Small",
    sizeMd: "Medium",
    sizeLg: "Large",
    remove: "Remove",
  },
  category: {
    profitability: "Profitability",
    liquidity: "Liquidity",
    working_capital: "Working capital",
    leverage_solvency: "Leverage & solvency",
    coverage: "Coverage",
    efficiency: "Efficiency",
    valuation: "Valuation",
    cash_flow: "Cash flow",
    risk_credit: "Risk & credit",
    romanian_ras: "Romanian RAS",
    benchmark: "Benchmark",
    inventory: "Inventory",
    public_company: "Public company",
    source_account: "Source account",
  },
  count: {
    open_risks: "Risks",
    open_opportunities: "Opportunities",
  },
  concepts: {
    revenue: "Everything you billed customers this period, before costs.",
    operating_revenue:
      "All income from the day-to-day business, including other operating income.",
    net_turnover: "Sales of goods and services, net of discounts given.",
    cogs: "What the goods you sold cost you to buy or make.",
    gross_profit: "Sales minus the direct cost of what you sold.",
    operating_expenses:
      "Everything running the business costs — salaries, rent, services, materials.",
    opex: "Everything running the business costs — salaries, rent, services, materials.",
    ebit: "Profit from operations, before interest and tax.",
    ebitda:
      "Operating profit before interest, tax and depreciation — a proxy for cash generated.",
    depreciation_amortization:
      "The yearly wear-and-tear cost of equipment and other long-lived assets.",
    depreciation:
      "The yearly wear-and-tear cost of equipment and other long-lived assets.",
    net_financial_result:
      "Financial income minus financial costs — interest, FX and the like.",
    income_tax: "Tax owed on this period's profit.",
    net_profit:
      "What's left after every cost, interest and tax — the bottom line.",
    net_income:
      "What's left after every cost, interest and tax — the bottom line.",
    total_assets: "Everything the company owns, valued in money.",
    current_assets:
      "Assets that turn into cash within a year — stock, receivables, cash.",
    cash: "Money available right now in bank accounts and petty cash.",
    inventory:
      "Stock waiting to be sold — raw materials, work in progress, finished goods.",
    receivables: "Money customers owe you for what you've already delivered.",
    ppe: "Long-life physical assets — land, buildings, machines, vehicles.",
    current_liabilities:
      "Bills due within a year — suppliers, salaries, taxes, short-term loans.",
    accounts_payable:
      "Money you owe suppliers for what you've already received.",
    short_term_debt: "Bank borrowings due within the next 12 months.",
    long_term_debt: "Bank loans and leases due after more than a year.",
    total_debt:
      "All the money borrowed from banks and lenders, short and long term.",
    shareholders_equity:
      "The owners' stake — what remains after all debts are paid.",
    total_equity:
      "The owners' stake — what remains after all debts are paid.",
    operating_cash_flow:
      "Cash the day-to-day business actually generated this period.",
    capex: "Cash spent on equipment, buildings and other long-term assets.",
    free_cash_flow:
      "Cash left after operations and investment — free to repay debt or pay dividends.",
    enterprise_value: "What the whole business is worth, debt included.",
    equity_value: "What the owners' share of the business is worth.",
    ebitda_margin:
      "EBITDA as a share of sales — how profitable the operations are.",
    ebit_margin: "Operating profit as a share of sales.",
    net_margin: "How much of each sale ends up as final profit.",
    gross_margin:
      "What's left of sales after direct costs, as a percentage.",
    gross_margin_ratio:
      "What's left of sales after direct costs, as a percentage.",
    current_ratio:
      "Can short-term assets cover short-term bills? Above 1 means yes.",
    quick_ratio:
      "Like the current ratio, but without counting stock you'd first have to sell.",
    cash_ratio:
      "How much of the short-term bills you could pay with cash on hand today.",
    net_debt_ebitda:
      "Roughly how many years of EBITDA it would take to repay net debt.",
    debt_to_equity:
      "How much debt the company uses for every leu of owners' money.",
    equity_ratio: "The share of assets financed by owners rather than debt.",
    debt_to_assets: "The share of assets financed with borrowed money.",
    roe: "Profit earned for every leu the owners have invested.",
    roa: "How efficiently the company's assets generate profit.",
    ev_ebitda_multiple:
      "The valuation multiple: business value divided by EBITDA.",
    open_risks:
      "Findings flagged critical or high in this period's analysis.",
    open_opportunities:
      "Improvement ideas surfaced by this period's analysis.",
  },
} as const;

export const metricsV2Ro = {
  title: "Indicatori",
  addMetric: "Adaugă indicator",
  done: "Gata",
  reset: "Resetează",
  cardLimitReached: "Ai atins limita de carduri (20)",
  emptyTitle:
    "Tabloul tău de bord e gol. Adaugă indicatorii pe care vrei să îi urmărești.",
  pickerTitle: "Adaugă un indicator",
  searchPlaceholder: "Caută indicatori…",
  noMatch: "Niciun indicator nu se potrivește cu „{{query}}”",
  allAdded: "Toți indicatorii disponibili sunt deja pe tabloul tău de bord.",
  aboutMetric: "Despre acest indicator",
  dragToReorder: "Trage pentru a rearanja",
  removeCard: "Elimină cardul",
  tapToResize: "Apasă pe card pentru a-i schimba dimensiunea",
  menu: {
    open: "Opțiuni card",
    rearrange: "Rearanjează",
    size: "Dimensiune",
    sizeSm: "Mic",
    sizeMd: "Mediu",
    sizeLg: "Mare",
    remove: "Elimină",
  },
  category: {
    profitability: "Profitabilitate",
    liquidity: "Lichiditate",
    working_capital: "Capital de lucru",
    leverage_solvency: "Îndatorare și solvabilitate",
    coverage: "Acoperire",
    efficiency: "Eficiență",
    valuation: "Evaluare",
    cash_flow: "Flux de numerar",
    risk_credit: "Risc și credit",
    romanian_ras: "RAS România",
    benchmark: "Comparație cu industria",
    inventory: "Stocuri",
    public_company: "Companii listate",
    source_account: "Cont sursă",
  },
  count: {
    open_risks: "Riscuri",
    open_opportunities: "Oportunități",
  },
  concepts: {
    revenue: "Tot ce ai facturat clienților în această perioadă, înainte de costuri.",
    operating_revenue:
      "Toate veniturile din activitatea de zi cu zi, inclusiv alte venituri din exploatare.",
    net_turnover: "Vânzările de bunuri și servicii, după reducerile acordate.",
    cogs: "Cât te-au costat bunurile pe care le-ai vândut.",
    gross_profit: "Vânzările minus costul direct al celor vândute.",
    operating_expenses:
      "Tot ce te costă funcționarea afacerii — salarii, chirie, servicii, materiale.",
    opex: "Tot ce te costă funcționarea afacerii — salarii, chirie, servicii, materiale.",
    ebit: "Profitul din operațiuni, înainte de dobânzi și impozite.",
    ebitda:
      "Profitul operațional înainte de dobânzi, impozite și amortizare — aproximează numerarul generat.",
    depreciation_amortization:
      "Costul anual al uzurii echipamentelor și celorlalte active pe termen lung.",
    depreciation:
      "Costul anual al uzurii echipamentelor și celorlalte active pe termen lung.",
    net_financial_result:
      "Veniturile financiare minus costurile financiare — dobânzi, diferențe de curs.",
    income_tax: "Impozitul datorat pe profitul perioadei.",
    net_profit:
      "Ce rămâne după toate costurile, dobânzile și impozitele — linia de jos.",
    net_income:
      "Ce rămâne după toate costurile, dobânzile și impozitele — linia de jos.",
    total_assets: "Tot ce deține compania, exprimat în bani.",
    current_assets:
      "Active care devin numerar într-un an — stocuri, creanțe, numerar.",
    cash: "Banii disponibili acum în conturi bancare și casierie.",
    inventory:
      "Stocuri care așteaptă să fie vândute — materii prime, producție în curs, produse finite.",
    receivables: "Banii pe care ți-i datorează clienții pentru ce ai livrat deja.",
    ppe: "Active fizice pe termen lung — terenuri, clădiri, utilaje, vehicule.",
    current_liabilities:
      "Datorii scadente într-un an — furnizori, salarii, taxe, credite pe termen scurt.",
    accounts_payable:
      "Banii pe care îi datorezi furnizorilor pentru ce ai primit deja.",
    short_term_debt: "Împrumuturi bancare scadente în următoarele 12 luni.",
    long_term_debt: "Credite și leasinguri scadente peste mai mult de un an.",
    total_debt:
      "Toți banii împrumutați de la bănci și creditori, pe termen scurt și lung.",
    shareholders_equity:
      "Partea acționarilor — ce rămâne după plata tuturor datoriilor.",
    total_equity:
      "Partea acționarilor — ce rămâne după plata tuturor datoriilor.",
    operating_cash_flow:
      "Numerarul generat efectiv de activitatea curentă în această perioadă.",
    capex:
      "Banii cheltuiți pe echipamente, clădiri și alte active pe termen lung.",
    free_cash_flow:
      "Numerarul rămas după operațiuni și investiții — liber pentru datorii sau dividende.",
    enterprise_value: "Cât valorează întreaga afacere, incluzând datoriile.",
    equity_value: "Cât valorează partea acționarilor din afacere.",
    ebitda_margin:
      "EBITDA ca procent din vânzări — cât de profitabile sunt operațiunile.",
    ebit_margin: "Profitul operațional ca procent din vânzări.",
    net_margin: "Cât din fiecare vânzare ajunge profit final.",
    gross_margin:
      "Ce rămâne din vânzări după costurile directe, ca procent.",
    gross_margin_ratio:
      "Ce rămâne din vânzări după costurile directe, ca procent.",
    current_ratio:
      "Acoperă activele pe termen scurt datoriile pe termen scurt? Peste 1 înseamnă da.",
    quick_ratio:
      "Ca rata curentă, dar fără stocurile pe care ar trebui întâi să le vinzi.",
    cash_ratio:
      "Cât din datoriile pe termen scurt ai putea plăti azi din numerar.",
    net_debt_ebitda:
      "Aproximativ în câți ani de EBITDA ai rambursa datoria netă.",
    debt_to_equity:
      "Câtă datorie folosește compania pentru fiecare leu al acționarilor.",
    equity_ratio:
      "Cât din active este finanțat de acționari, nu din datorii.",
    debt_to_assets: "Cât din active este finanțat din bani împrumutați.",
    roe: "Profitul obținut pentru fiecare leu investit de acționari.",
    roa: "Cât de eficient generează activele companiei profit.",
    ev_ebitda_multiple:
      "Multiplul de evaluare: valoarea afacerii împărțită la EBITDA.",
    open_risks:
      "Constatări marcate drept critice sau ridicate în analiza perioadei.",
    open_opportunities:
      "Idei de îmbunătățire identificate în analiza perioadei.",
  },
} as const;

