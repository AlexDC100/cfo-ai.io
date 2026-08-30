// Global public markets — the `pcm` i18n bundle (EN + RO).
//
// Same registration pattern as pciI18n.ts: the locale files
// (i18n/locales/{en,ro}.json) are owned by another workstream, so these
// strings register at module load via addResourceBundle with
// overwrite=false — any `pcm` key already merged into a locale file wins.
//
// COPY DISCIPLINE FOR THIS SURFACE
// --------------------------------
// Every sentence here describes what the platform can do TODAY. A market
// with no feed says it has no feed and names the environment variable
// that activates it; it never says "no results", which would imply a
// search happened. A market whose feed exists but is not addressable by
// ticker says exactly that. No sentence promises a date.
//
// Romanian register: informal tu-form, full diacritics.

import i18n from "@/i18n";

export const pcmEn = {
  // ── PART E: the page lede ──
  //
  // THE AUTHORITY for this sentence. It deliberately does NOT live in
  // the `pci` bundle: `frontend/i18n/locales/{en,ro}.json` already own
  // `pci.header.subtitle`, and `addResourceBundle(..., overwrite=false)`
  // cannot displace a key the locale files already carry — so a "fix"
  // written there would register and then lose silently, leaving the old
  // Bucharest-only sentence on screen. A new key under a namespace the
  // locale files do not carry is the only edit that actually lands.
  //
  // The copy itself: Romania leads because it is the home market, and no
  // single foreign country is headlined. Romania's deterministic-grade
  // claim is NOT made here for every market — it lives on the Romania
  // surface, as `pcm.ro.grade`.
  lede:
    "Listed-company financials from Romania, the US, Europe, China and the UAE — from official filings, with market prices. Add any company as a benchmark peer and it sits next to your private books.",

  // ── market + region names ──
  // The registry's display_name is authoritative and English; these keys
  // exist so the RO locale can translate without the registry growing a
  // locale dimension. A market with no key falls back to display_name.
  market: {
    ro: "Romania",
    us: "United States",
    de: "Germany",
    uk: "United Kingdom",
    fr: "France",
    it: "Italy",
    es: "Spain",
    cn: "China",
    ae: "UAE",
  },
  region: {
    europe: "Europe",
    // Region overview: one compact row per country instead of five
    // near-identical full panels. r2 stacked all five and the page read
    // as one paragraph repeated — the statuses, which are the actual
    // information, were the hardest thing on it to see.
    overviewLede:
      "{{count}} markets, each with its own status. Pick a country to see exactly what it can serve today.",
  },
  tab: {
    all: "All",
    marketCount: "{{count}} markets",
    aria: "Market",
    countries: "Countries",
    allCountries: "All of Europe",
  },

  // ── status vocabulary ──
  status: {
    live: "Live",
    fundamentals_only: "Filings only",
    awaiting_provider: "Awaiting provider",
    liveWhy: "A ticker goes in and a deterministic figure comes out, with provenance on every number.",
    fundamentals_onlyWhy:
      "A real feed carries the figures, but there is no ticker-to-filing lookup for this market yet, so a company page cannot be opened by symbol.",
    awaiting_providerWhy:
      "No deterministic feed is wired for this market. Nothing is estimated to fill the gap.",
  },

  // ── the data-status line ──
  data: {
    label: "Data status",
    source: "Source",
    cadence: "Refresh",
    prices: "Prices",
    license: "Licence",
    holdings: "{{count}} companies cached",
    holdingsOne: "1 company cached",
    holdingsZero: "No companies cached yet",
    holdingsUnknown: "Cached holdings unknown — the market service did not answer",
    // The HOME market's spine-store count is structurally zero (PM7: it
    // is served by the Romanian storefront and this package never caches
    // a Romanian entity). Printing "no companies cached yet" beside 88
    // rendered Romanian companies is true about the store and false to
    // the reader — so the home market reports what serves it instead.
    holdingsHome: "Served by the Romanian storefront — the market store holds no Romanian entities by design",
    // One sentence, not two: when the registry itself is the bundled
    // copy, "holdings unknown" is a CONSEQUENCE of the same fact, and
    // printing both reads as two separate failures.
    bundled:
      "Registry read from the bundled copy — the market service did not answer, so cached holdings are unknown.",
    why: "Why this status",
    noSource: "No feed wired",
  },
  cadence: {
    on_filing: "On each new filing",
    annual_dataset: "Annual dataset",
    none: "Not refreshed — no feed",
  },
  priceSource: {
    none: "No price feed in this registry",
    licensed_provider_slot: "Licensed provider slot — no key configured, so no price is shown",
    homeNote:
      "Quotes on this page come from the Bucharest Stock Exchange feed that already serves Romania, not from the market registry.",
  },

  // ── Romania's own note (kept from the BVB surface) ──
  ro: {
    grade:
      "Romania is the deterministic home market: every figure is read from the official published filing, machine-verified, and reconciles to the statutory statement.",
  },

  // ── calm states ──
  awaiting: {
    title: "{{market}} is awaiting a data provider",
    lede: "There is no deterministic feed for this market today. Rather than show an estimate, this page shows the gap.",
    comingTitle: "What arrives when it is wired",
    comingPrices: "End-of-day prices with an explicit as-of stamp and delay label.",
    comingFundamentals:
      "Revenue, result, assets and equity read from the filing, each figure carrying its own source reference.",
    comingBenchmark: "Any company here becomes a benchmark peer beside your own books.",
    missingTitle: "What is missing",
    missingFeed: "No fundamentals feed is connected for {{market}}.",
    missingPrices: "No price licence is configured.",
    activateTitle: "How it activates",
    activateBody:
      "Set {{env}} in the engine environment and restart it. This surface reads the market registry, so the market flips to live with no code change here.",
    note: "{{note}}",
  },
  notAddressable: {
    title: "{{market}} filings are readable, but not by ticker yet",
    lede:
      "The filing repository for {{market}} is connected and the extractor runs on it — revenue, result, assets and equity come out of real filings. What is missing is the lookup that turns a ticker into the right filing, so a company cannot be opened by symbol here yet.",
    feed: "Feed",
    whatWorks: "What already works",
    whatWorksBody: "Figures extract from published {{source}} filings, with the filing reference attached to each one.",
    whatIsMissing: "What is missing",
    whatIsMissingBody: "Ticker to legal-entity to filing resolution. Without it, opening a company by symbol would mean guessing which filing to read.",
  },

  // ── live market lookup ──
  lookup: {
    title: "Open a {{market}} company",
    hint: "Enter a ticker — {{examples}}",
    placeholder: "Ticker",
    submit: "Open",
    searching: "Reading the market store…",
    emptyTitle: "Nothing cached for {{market}} yet",
    emptyBody:
      "The {{source}} path is live, but this page only reads what has already been ingested — it never calls the feed on a page view. Run the ingest job to populate it.",
    cachedNote: "{{count}} companies are cached and can be opened by ticker.",
  },

  // ── refusals, by machine code ──
  refusal: {
    title: "Not shown, and why",
    UNKNOWN_MARKET: "Unknown market",
    HOME_MARKET_SERVED_ELSEWHERE: "Served by the Romanian storefront",
    MARKET_NOT_ADDRESSABLE: "No ticker lookup for this market yet",
    MARKET_AWAITING_PROVIDER: "No feed wired for this market",
    NOT_CACHED: "Not cached yet",
    STORE_UNAVAILABLE: "Market store unreachable",
    STORE_READ_FAILED: "Market store could not be read",
    EMPTY_TICKER: "No ticker entered",
    TRANSPORT_FAILED: "The market service could not be reached",
  },

  // ── company documents ──
  doc: {
    figures: "Figures",
    asOf: "as of {{date}}",
    price: "Price",
    noPrice: "No price — {{reason}}",
    refusalsCount: "{{count}} figures refused rather than estimated",
    refusalsOne: "1 figure refused rather than estimated",
    filing: "Filing",
  },

  // ── company cards ──
  card: {
    marketAria: "Market",
    currencyAria: "Reporting currency",
    asOf: "as of {{date}}",
  },

  // ── cross-surface market filter ──
  filter: {
    label: "Market",
    all: "All markets",
    scope: "Showing {{shown}} of {{total}} companies · {{market}}",
    none: "No companies in this market are loaded on this page.",
  },
  map: {
    scopeTitle: "{{market}} is not on this map yet",
    scopeBody:
      "The choropleth plots Romanian county headquarters. {{market}} entities plot as soon as coordinates are carried in the payload; none are today, so nothing is drawn rather than placed at a guess.",
    mixed: "{{mapped}} of {{total}} companies in view have mapped coordinates.",
  },
  radar: {
    scopeNote:
      "Filtered to {{market}}. Category scores are computed across the whole universe and are not re-scored by this filter — only the company rows are narrowed.",
    empty: "No companies from {{market}} appear in this category.",
  },

  // ── ⌘K palette (descriptor exported from lib/marketApi.ts) ──
  command: {
    group: "Public markets",
    open: "Open public markets",
  },
};

export const pcmRo = {
  lede:
    "Cifre financiare ale companiilor listate din România, Statele Unite, Europa, China și Emiratele Arabe Unite — din raportări oficiale, cu prețuri de piață. Adaugă orice companie ca peer de benchmark și apare lângă cifrele tale private.",

  market: {
    ro: "România",
    us: "Statele Unite",
    de: "Germania",
    uk: "Regatul Unit",
    fr: "Franța",
    it: "Italia",
    es: "Spania",
    cn: "China",
    ae: "Emiratele Arabe Unite",
  },
  region: {
    europe: "Europa",
    overviewLede:
      "{{count}} piețe, fiecare cu starea ei. Alege o țară ca să vezi exact ce poate servi astăzi.",
  },
  tab: {
    all: "Toate",
    marketCount: "{{count}} piețe",
    aria: "Piață",
    countries: "Țări",
    allCountries: "Toată Europa",
  },

  status: {
    live: "Live",
    fundamentals_only: "Doar raportări",
    awaiting_provider: "Așteaptă furnizor",
    liveWhy: "Introduci simbolul și primești o cifră deterministă, cu proveniență pe fiecare număr.",
    fundamentals_onlyWhy:
      "Există un flux real cu cifrele, dar nu există încă o corespondență simbol-raportare pentru această piață, deci o companie nu poate fi deschisă după simbol.",
    awaiting_providerWhy:
      "Nu este conectat niciun flux determinist pentru această piață. Nimic nu este estimat ca să acopere lipsa.",
  },

  data: {
    label: "Starea datelor",
    source: "Sursă",
    cadence: "Actualizare",
    prices: "Prețuri",
    license: "Licență",
    holdings: "{{count}} companii în cache",
    holdingsOne: "1 companie în cache",
    holdingsZero: "Nicio companie în cache încă",
    holdingsUnknown: "Nu știm câte companii sunt în cache — serviciul de piețe nu a răspuns",
    holdingsHome: "Servită de vitrina românească — depozitul de piețe nu ține entități românești, prin proiectare",
    bundled:
      "Registrul este citit din copia inclusă în aplicație — serviciul de piețe nu a răspuns, deci nu știm câte companii sunt în cache.",
    why: "De ce această stare",
    noSource: "Niciun flux conectat",
  },
  cadence: {
    on_filing: "La fiecare raportare nouă",
    annual_dataset: "Set de date anual",
    none: "Nu se actualizează — niciun flux",
  },
  priceSource: {
    none: "Niciun flux de prețuri în acest registru",
    licensed_provider_slot: "Slot de furnizor licențiat — fără cheie configurată, deci nu se afișează niciun preț",
    homeNote:
      "Cotațiile de pe această pagină vin din fluxul Bursei de Valori București care servește deja România, nu din registrul de piețe.",
  },

  ro: {
    grade:
      "România este piața de bază deterministă: fiecare cifră este citită din raportarea oficială publicată, verificată mecanic și reconciliată cu situația statutară.",
  },

  awaiting: {
    title: "{{market}} așteaptă un furnizor de date",
    lede: "Astăzi nu există niciun flux determinist pentru această piață. În loc de o estimare, pagina arată lipsa.",
    comingTitle: "Ce apare când este conectat",
    comingPrices: "Prețuri de închidere cu dată explicită și etichetă de întârziere.",
    comingFundamentals:
      "Venituri, rezultat, active și capitaluri citite din raportare, fiecare cifră cu referința ei de sursă.",
    comingBenchmark: "Orice companie de aici devine peer de benchmark lângă cifrele tale.",
    missingTitle: "Ce lipsește",
    missingFeed: "Niciun flux de raportări conectat pentru {{market}}.",
    missingPrices: "Nicio licență de prețuri configurată.",
    activateTitle: "Cum se activează",
    activateBody:
      "Setează {{env}} în mediul motorului și repornește-l. Această pagină citește registrul de piețe, deci piața trece pe live fără nicio modificare de cod aici.",
    note: "{{note}}",
  },
  notAddressable: {
    title: "Raportările din {{market}} se pot citi, dar nu încă după simbol",
    lede:
      "Depozitul de raportări pentru {{market}} este conectat și extractorul rulează pe el — venituri, rezultat, active și capitaluri ies din raportări reale. Lipsește corespondența care transformă un simbol în raportarea potrivită, deci o companie nu poate fi deschisă după simbol aici.",
    feed: "Flux",
    whatWorks: "Ce funcționează deja",
    whatWorksBody: "Cifrele se extrag din raportările publicate {{source}}, fiecare cu referința raportării atașată.",
    whatIsMissing: "Ce lipsește",
    whatIsMissingBody: "Corespondența simbol → entitate juridică → raportare. Fără ea, deschiderea după simbol ar însemna să ghicim ce raportare citim.",
  },

  lookup: {
    title: "Deschide o companie din {{market}}",
    hint: "Scrie un simbol — {{examples}}",
    placeholder: "Simbol",
    submit: "Deschide",
    searching: "Se citește depozitul de piețe…",
    emptyTitle: "Nimic în cache pentru {{market}} încă",
    emptyBody:
      "Calea {{source}} este activă, dar pagina citește doar ce a fost deja preluat — nu apelează niciodată fluxul la afișarea paginii. Rulează procesul de preluare ca să o populezi.",
    cachedNote: "{{count}} companii sunt în cache și pot fi deschise după simbol.",
  },

  refusal: {
    title: "Ce nu se afișează și de ce",
    UNKNOWN_MARKET: "Piață necunoscută",
    HOME_MARKET_SERVED_ELSEWHERE: "Servită de vitrina românească",
    MARKET_NOT_ADDRESSABLE: "Nu există încă o căutare după simbol pentru această piață",
    MARKET_AWAITING_PROVIDER: "Niciun flux conectat pentru această piață",
    NOT_CACHED: "Încă nu este în cache",
    STORE_UNAVAILABLE: "Depozitul de piețe nu este accesibil",
    STORE_READ_FAILED: "Depozitul de piețe nu a putut fi citit",
    EMPTY_TICKER: "Niciun simbol introdus",
    TRANSPORT_FAILED: "Serviciul de piețe nu a putut fi contactat",
  },

  doc: {
    figures: "Cifre",
    asOf: "la {{date}}",
    price: "Preț",
    noPrice: "Fără preț — {{reason}}",
    refusalsCount: "{{count}} cifre refuzate în loc să fie estimate",
    refusalsOne: "1 cifră refuzată în loc să fie estimată",
    filing: "Raportare",
  },

  card: {
    marketAria: "Piață",
    currencyAria: "Moneda de raportare",
    asOf: "la {{date}}",
  },

  filter: {
    label: "Piață",
    all: "Toate piețele",
    scope: "Se afișează {{shown}} din {{total}} companii · {{market}}",
    none: "Nicio companie din această piață nu este încărcată pe pagină.",
  },
  map: {
    scopeTitle: "{{market}} nu este încă pe această hartă",
    scopeBody:
      "Harta colorează sediile pe județe din România. Entitățile din {{market}} apar imediat ce coordonatele sunt purtate în date; astăzi nu sunt, deci nu desenăm nimic în loc să le plasăm la ghici.",
    mixed: "{{mapped}} din {{total}} companii afișate au coordonate.",
  },
  radar: {
    scopeNote:
      "Filtrat pe {{market}}. Scorurile pe categorii sunt calculate pe tot universul și nu sunt recalculate de acest filtru — se restrâng doar rândurile cu companii.",
    empty: "Nicio companie din {{market}} nu apare în această categorie.",
  },

  command: {
    group: "Piețe listate",
    open: "Deschide piețele listate",
  },
};

i18n.addResourceBundle("en", "translation", { pcm: pcmEn }, true, false);
i18n.addResourceBundle("ro", "translation", { pcm: pcmRo }, true, false);
