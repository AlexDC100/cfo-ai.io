// Public Company Intelligence redesign (2026-08-04) — `pci` i18n bundle.
//
// The locale files (i18n/locales/{en,ro}.json) are owned by another
// workstream during the redesign sprint, so the new strings register HERE
// at module load via addResourceBundle with overwrite=false — the same
// pattern as components/dashboard/metricsV2I18n.ts. The identical content
// also lives in the scratchpad fragment (i18n-fragments/pciv2.json); once
// that is merged into the locale files this registration becomes a
// harmless no-op (existing keys win).
//
// Romanian register: informal tu-form, full diacritics, natural finance
// vocabulary ("Creștere", "Îndatorare", "Randament dividend").

import i18n from "@/i18n";

export const pciEn = {
  header: {
    eyebrow: "Public Company Intelligence",
    titlePre: "Search listed companies and add them as ",
    titleGrad: "benchmark peers",
    // PART E (2026-08-30) — `subtitle` is GONE from this bundle on
    // purpose. The page lede is now `pcm.lede` in marketI18n.ts, which
    // is the only place it can be edited and actually land: the locale
    // files own `pci.*`, and addResourceBundle(overwrite=false) cannot
    // displace a key they already carry. `pci.header.subtitle` still
    // exists in en.json / ro.json carrying the retired Bucharest-only
    // sentence — nothing renders it (grep: zero call sites). Removing it
    // from the locale files is a cross-lane cleanup, flagged in the wave
    // report, because those files are owned by the i18n workstream.
    tabOverview: "Overview",
    tabRisk: "Risk Radar",
    tabMap: "Geographic Map",
    tabUnavailable: "{{label}} is currently unavailable",
    tabsAria: "Public Companies sections",
  },
  rail: {
    title: "Peers for your company",
    subtitle:
      "BVB-listed companies from the same sector as {{name}} — one click adds them next to your own books.",
    add: "Add as peer",
    inPeers: "Peer",
    added: "{{ticker}} added as a benchmark peer.",
    removed: "{{ticker}} removed from peers.",
  },
  pulse: {
    market: "BVB market today: median {{value}}",
    // Split variant — same meaning as `market`, but the figure renders
    // beside the label through <Amount> instead of interpolated text.
    marketLead: "BVB market today · median",
    n: "n={{n}}",
    topMover: "Top mover",
    insight: "{{sector}} leads today: {{ticker}} {{change}}",
  },
  search: {
    placeholder: "Search Romanian companies",
    clear: "Clear search",
    yourPeers: "Your peers",
    removePeer: "Remove {{ticker}} from peers",
    noMatch:
      "No BVB-listed company matches “{{query}}”. Try the ticker (e.g. TLV, SNP, H2O) or part of the company name.",
  },
  filters: {
    title: "Filter the universe",
    searchPillDesc: "Companies matching your search — click to clear",
    gainers: "Top gainers",
    gainersWhy: "Largest day-over-day price gains among live-quoted companies",
    losers: "Top losers",
    losersWhy: "Largest day-over-day price drops among live-quoted companies",
    value: "Value plays",
    valueWhy: "P/E below 15 and profitable — priced cheaply next to earnings",
    distressed: "Distressed",
    distressedWhy: "Negative EBITDA margin — operating losses, refinancing pressure",
    quality: "Quality",
    qualityWhy: "EBITDA margin over 25%, net margin over 12%, ROE over 20%",
  },
  card: {
    pending: "Processing",
    pendingNote: "Statutory figures are being loaded",
    mktCap: "Mkt cap",
    select: "Select {{ticker}} for comparison",
    rank: "#{{rank}} of {{n}} in group",
    metric: {
      ebitdaMargin: "EBITDA margin",
      netMargin: "Net margin",
      dividendYield: "Dividend yield",
      roe: "ROE",
      evToEbitda: "EV/EBITDA",
      peRatio: "P/E",
    },
    why: {
      ebitdaMargin:
        "Operating profitability before depreciation — pricing power and cost control.",
      netMargin: "How much of every leu of revenue survives to the bottom line.",
      dividendYield: "Cash returned to shareholders, relative to the share price.",
      roe: "How hard shareholders' equity is working.",
      evToEbitda: "The cheapest operating-earnings multiple in the group.",
      peRatio: "Price paid per leu of net profit — lower reads cheaper.",
    },
  },
  grid: {
    range: "{{from}}–{{to}} of {{total}}",
    prev: "Previous companies",
    next: "Next companies",
  },
  bench: {
    title: "Benchmarking",
    subtitle:
      "Median and 25th/75th percentiles computed per group — BVB names are never blended with global ones. Click a tile for the per-company breakdown.",
    groupBvb: "Peers BVB",
    groupGlobal: "Global",
    n: "n={{n}}",
    median: "Median",
    leader: "Leader",
    laggard: "Laggard",
    drillTitle: "{{metric}} — {{group}}",
    you: "Your company",
    noOverlay: "Your loaded period does not carry this metric, so no overlay is shown.",
    close: "Close breakdown",
    metric: {
      growth: "Revenue growth",
      growthShort: "Growth",
      ebitda: "EBITDA margin",
      ebitdaShort: "EBITDA",
      leverage: "Debt / EBITDA",
      leverageShort: "Leverage",
      fcf: "FCF yield",
      fcfShort: "FCF",
      evEbitda: "Valuation multiple",
      evEbitdaShort: "EV/EBITDA",
      dividend: "Dividend yield",
      dividendShort: "Dividend",
    },
  },
  compare: {
    selected: "{{n}} selected for comparison",
    cta: "Compare",
    clear: "Clear",
    title: "Side-by-side comparison",
    subtitle: "Figures as loaded on this page — statutory FY figures plus live prices.",
    includeYou: "Include your company",
    limit: "You can compare at most 3 companies.",
    row: {
      revenue: "Revenue",
      mktCap: "Market cap",
      price: "Price · day",
      ebitdaMargin: "EBITDA margin",
      netMargin: "Net margin",
      leverage: "Net debt / EBITDA",
      debtToEquity: "Debt / Equity",
      pe: "P/E",
      evEbitda: "EV/EBITDA",
      dividend: "Dividend yield",
    },
  },
  footer: {
    loading: "Loading sources…",
    demo: "Source: bundled sample data — the live market feed isn't configured on this deployment, so every figure on this page is illustrative.",
    sources:
      "Sources: Bursa de Valori București reference data plus issuer disclosures and ANAF statutory filings for {{bvb}} BVB listings. Fundamentals are end-of-day; prices refresh every 5 minutes.",
  },
};

export const pciRo = {
  header: {
    eyebrow: "Inteligență companii listate",
    titlePre: "Caută companii listate și adaugă-le ca ",
    titleGrad: "peers de benchmark",
    // subtitle: see the EN note above — the lede lives in `pcm.lede`.
    tabOverview: "Prezentare",
    tabRisk: "Radar de risc",
    tabMap: "Hartă geografică",
    tabUnavailable: "{{label}} nu este disponibil momentan",
    tabsAria: "Secțiunile paginii de companii listate",
  },
  rail: {
    title: "Peers pentru compania ta",
    subtitle:
      "Companii listate la BVB din același sector ca {{name}} — un click și apar lângă cifrele tale.",
    add: "Adaugă ca peer",
    inPeers: "Peer",
    added: "{{ticker}} a fost adăugat ca peer de benchmark.",
    removed: "{{ticker}} a fost scos din peers.",
  },
  pulse: {
    market: "Piața BVB azi: mediană {{value}}",
    marketLead: "Piața BVB azi · mediană",
    n: "n={{n}}",
    topMover: "Mișcarea zilei",
    insight: "{{sector}} conduce azi: {{ticker}} {{change}}",
  },
  search: {
    placeholder: "Caută companii românești",
    clear: "Șterge căutarea",
    yourPeers: "Peers aleși",
    removePeer: "Scoate {{ticker}} din peers",
    noMatch:
      "Nicio companie listată la BVB nu se potrivește cu „{{query}}”. Încearcă simbolul (ex. TLV, SNP, H2O) sau o parte din numele companiei.",
  },
  filters: {
    title: "Filtrează universul",
    searchPillDesc: "Companiile care se potrivesc căutării — apasă pentru a o șterge",
    gainers: "Creșterile zilei",
    gainersWhy: "Cele mai mari creșteri de preț de la o zi la alta, dintre companiile cotate live",
    losers: "Scăderile zilei",
    losersWhy: "Cele mai mari scăderi de preț de la o zi la alta, dintre companiile cotate live",
    value: "Evaluări atractive",
    valueWhy: "P/E sub 15 și profitabile — ieftine raportat la câștiguri",
    distressed: "În dificultate",
    distressedWhy: "Marjă EBITDA negativă — pierderi operaționale, presiune de refinanțare",
    quality: "Calitate",
    qualityWhy: "Marjă EBITDA peste 25%, marjă netă peste 12%, ROE peste 20%",
  },
  card: {
    pending: "În curs de procesare",
    pendingNote: "Cifrele statutare se încarcă",
    mktCap: "Cap. piață",
    select: "Selectează {{ticker}} pentru comparație",
    rank: "#{{rank}} din {{n}} în grup",
    metric: {
      ebitdaMargin: "Marjă EBITDA",
      netMargin: "Marjă netă",
      dividendYield: "Randament dividend",
      roe: "ROE",
      evToEbitda: "EV/EBITDA",
      peRatio: "P/E",
    },
    why: {
      ebitdaMargin:
        "Profitabilitate operațională înainte de amortizare — putere de preț și control al costurilor.",
      netMargin: "Cât din fiecare leu de venit ajunge la rezultatul net.",
      dividendYield: "Numerar întors acționarilor, raportat la prețul acțiunii.",
      roe: "Cât de eficient lucrează capitalul propriu al acționarilor.",
      evToEbitda: "Cel mai ieftin multiplu al profitului operațional din grup.",
      peRatio: "Prețul plătit pe un leu de profit net — mai mic înseamnă mai ieftin.",
    },
  },
  grid: {
    range: "{{from}}–{{to}} din {{total}}",
    prev: "Companiile anterioare",
    next: "Companiile următoare",
  },
  bench: {
    title: "Benchmarking",
    subtitle:
      "Mediană și percentilele 25/75 calculate pe fiecare grup — companiile BVB nu se amestecă niciodată cu cele globale. Apasă pe un card pentru detalierea pe companii.",
    groupBvb: "Peers BVB",
    groupGlobal: "Global",
    n: "n={{n}}",
    median: "Mediană",
    leader: "Lider",
    laggard: "Codaș",
    drillTitle: "{{metric}} — {{group}}",
    you: "Compania ta",
    noOverlay: "Perioada încărcată nu are această valoare, așa că nu se afișează suprapunerea.",
    close: "Închide detalierea",
    metric: {
      growth: "Creștere venituri",
      growthShort: "Creștere",
      ebitda: "Marjă EBITDA",
      ebitdaShort: "EBITDA",
      leverage: "Îndatorare (Datorie/EBITDA)",
      leverageShort: "Îndatorare",
      fcf: "Randament FCF",
      fcfShort: "FCF",
      evEbitda: "Multiplu de evaluare",
      evEbitdaShort: "EV/EBITDA",
      dividend: "Randament dividend",
      dividendShort: "Dividend",
    },
  },
  compare: {
    selected: "{{n}} selectate pentru comparație",
    cta: "Compară",
    clear: "Golește",
    title: "Comparație față în față",
    subtitle: "Cifrele așa cum sunt încărcate pe această pagină — valori statutare anuale plus prețuri live.",
    includeYou: "Include compania ta",
    limit: "Poți compara cel mult 3 companii.",
    row: {
      revenue: "Venituri",
      mktCap: "Capitalizare",
      price: "Preț · azi",
      ebitdaMargin: "Marjă EBITDA",
      netMargin: "Marjă netă",
      leverage: "Datorie netă / EBITDA",
      debtToEquity: "Datorii / Capitaluri",
      pe: "P/E",
      evEbitda: "EV/EBITDA",
      dividend: "Randament dividend",
    },
  },
  footer: {
    loading: "Se încarcă sursele…",
    demo: "Sursă: date demonstrative incluse în aplicație — fluxul de piață live nu este configurat pe această instalare, deci toate cifrele de pe pagină sunt ilustrative.",
    sources:
      "Surse: date de referință Bursa de Valori București plus raportările emitenților și bilanțurile statutare ANAF pentru {{bvb}} companii listate la BVB. Fundamentele sunt la închiderea zilei; prețurile se actualizează la 5 minute.",
  },
};

// Register under the app's single "translation" namespace. deep=true so the
// bundle merges alongside existing top-level keys; overwrite=false so any
// `pci` keys already merged into the locale files always win.
i18n.addResourceBundle("en", "translation", { pci: pciEn }, true, false);
i18n.addResourceBundle("ro", "translation", { pci: pciRo }, true, false);
