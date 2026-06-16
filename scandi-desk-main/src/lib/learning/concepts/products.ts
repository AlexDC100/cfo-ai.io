// F5.0 Phase 8 — Products / SKU economics concepts.
//
// Ten concepts that explain the SKU-level economics surfaced by the
// engine (real margin, capital-cost-on-inventory, allocated SG&A,
// classification bucket) plus the Products KPI strip counts. Each
// renders Layer 2 popover content authored from the engine's actual
// per-SKU compute path — no fabrication.
//
// Anchor: `engine/api/sku_classifier.py::compute_real_margin` is the
// upstream source. The Drawer's `deriveBreakdown()` mirrors it on the
// FE for display only; nothing here re-derives anything.

import type { Concept } from "./_schema";

const real_margin: Concept = {
  key: "real_margin",
  name: { en: "Real Margin (SKU)", ro: "Marja reală (SKU)" },
  category: "Profitability",
  shortDefinition: {
    en: "What's left of the gross margin after deducting the SKU's share " +
        "of SG&A and the capital cost of inventory tied up to sell it. " +
        "This is the number that decides whether a SKU is creating or " +
        "destroying value.",
    ro: "Cât rămâne din marja brută după ce scădem cota SG&A a SKU-ului " +
        "și costul capitalului blocat în stoc. Acest număr decide dacă " +
        "SKU-ul creează sau distruge valoare.",
  },
  plainEnglish: {
    en: "How much money this product actually makes the business after " +
        "you also pay for the office, the warehouse, and the cash stuck " +
        "in inventory. Positive = the SKU pulls its weight. Negative = " +
        "you're paying customers to take it.",
    ro: "Câți bani aduce produsul după ce plătești și biroul, depozitul " +
        "și cash-ul blocat în stoc. Pozitiv = SKU-ul se susține. " +
        "Negativ = practic plătești clientul să-l ia.",
  },
  inlineFormula: "Gross Margin − Allocated SG&A − Capital Cost",
  related: ["gross_margin", "allocated_sga", "capital_cost_on_inventory", "sku_classification"],
  interpretation: {
    getSentiment: (v) => (v > 0 ? "positive" : v < 0 ? "negative" : "neutral"),
    getNarrative: (v) =>
      v > 0
        ? "Real margin is positive — the SKU is profitable end-to-end."
        : v < 0
          ? "Real margin is negative — gross profit is being eaten by SG&A and capital cost."
          : "Real margin is at break-even.",
  },
  sourceTrace: () => ({
    sourceType: "calculated",
    derivedFrom:
      "engine/api/sku_classifier.py::compute_real_margin — Gross Margin − Allocated SG&A − Capital Cost. " +
      "SG&A is allocated by revenue share. Capital cost = inventory_value × 6.5% × (DIO / 365).",
    confidence: 0.9,
  }),
};

const allocated_sga: Concept = {
  key: "allocated_sga",
  name: { en: "Allocated SG&A", ro: "SG&A alocat" },
  category: "Profitability",
  shortDefinition: {
    en: "Share of company-wide selling, general, and administrative " +
        "expense charged to this SKU. The engine allocates SG&A " +
        "proportionally to each SKU's NIV — bigger revenue, bigger SG&A " +
        "weight. Not a cash outflow you'll see on the invoice; an " +
        "internal cost-of-doing-business charge.",
    ro: "Cota din cheltuielile generale și administrative (SG&A) " +
        "atribuită acestui SKU. Motorul alocă SG&A proporțional cu " +
        "NIV-ul fiecărui SKU.",
  },
  plainEnglish: {
    en: "What you'd pay for sales people, office, marketing, and admin " +
        "if you only had this one product. It's a fair-share charge — " +
        "products that bring in more revenue carry more of the overhead.",
    ro: "Cât ai plăti pentru vânzători, birou, marketing și admin dacă " +
        "ai avea doar acest produs. E o cotă echitabilă din costuri.",
  },
  inlineFormula: "SG&A_total × (SKU_NIV / Total NIV)",
  related: ["real_margin", "gross_margin", "niv_revenue"],
  sourceTrace: () => ({
    sourceType: "calculated",
    derivedFrom:
      "Engine derives SG&A from the operating expense buckets in the P&L and allocates " +
      "by NIV revenue share. The drawer's `deriveBreakdown()` reconstructs it as " +
      "Gross Margin − Real Margin − Capital Cost when DIO is available; otherwise " +
      "it surfaces an em-dash rather than mislabeling capital cost as SG&A.",
    confidence: 0.75,
  }),
};

const capital_cost_on_inventory: Concept = {
  key: "capital_cost_on_inventory",
  name: { en: "Capital Cost on Inventory", ro: "Costul capitalului pe stoc" },
  category: "Inventory",
  shortDefinition: {
    en: "The opportunity cost of money tied up in this SKU's inventory. " +
        "Computed as 6.5% annual cost-of-capital applied to average " +
        "inventory value × (DIO / 365). A slow-moving SKU with a long " +
        "DIO pays more capital cost than a fast-moving one.",
    ro: "Costul de oportunitate al banilor blocați în stocul acestui SKU. " +
        "Calculat ca 6.5% pe an aplicat la valoarea medie a stocului " +
        "× (DIO / 365).",
  },
  plainEnglish: {
    en: "Imagine your cash sitting in a warehouse instead of in the bank. " +
        "That cash isn't earning interest — that lost interest is the " +
        "capital cost. The longer the SKU sits unsold, the more it costs you.",
    ro: "Imaginează cash-ul stând în depozit în loc de bancă. Acel cash " +
        "nu produce dobândă — dobânda pierdută e costul capitalului. Cu cât " +
        "stă mai mult, cu atât te costă mai mult.",
  },
  inlineFormula: "Inventory Value × 6.5% × (DIO ÷ 365)",
  related: ["real_margin", "dio_days", "inventory"],
  sourceTrace: () => ({
    sourceType: "calculated",
    derivedFrom:
      "Engine compute path: inventory_value_krn × 0.065 × (days_inventory_on_hand / 365). " +
      "Cost-of-capital rate is the standard Romanian SME WACC anchor used across the engine " +
      "(see _ro_coa.py). DIO comes from the parser's Analysis-sheet DIO column or the operator " +
      "category targets (LEGUME=60, JELEURI=180) when the source value is missing.",
    confidence: 0.85,
  }),
};

const niv_revenue: Concept = {
  key: "niv_revenue",
  name: { en: "NIV Revenue", ro: "Venit NIV" },
  category: "Profitability",
  shortDefinition: {
    en: "Net Invoice Value revenue — the SKU's revenue after commercial " +
        "discounts, returns, and rebates. Closer to the cash the business " +
        "actually collects than gross sales would suggest. The engine " +
        "uses NIV as the universal SKU revenue measure.",
    ro: "Net Invoice Value — venitul SKU-ului după reduceri comerciale, " +
        "retururi și rabaturi. Mai aproape de cash-ul efectiv colectat " +
        "decât vânzările brute.",
  },
  plainEnglish: {
    en: "The actual money you collected for this product, after taking " +
        "off all the discounts, returns, and end-of-quarter rebates. " +
        "The trustworthy revenue number.",
    ro: "Banii efectiv colectați pentru produs, după ce ai scos reducerile, " +
        "retururile și rabaturile. Cifra de venit pe care te poți baza.",
  },
  related: ["revenue", "gross_margin", "absolute_profit"],
  sourceTrace: () => ({
    sourceType: "inventory",
    skuId: "<per-row>",
    label: "Per-SKU NIV from invoice data",
    confidence: 0.95,
  }),
};

const absolute_profit_sku: Concept = {
  key: "absolute_profit_sku",
  name: { en: "Absolute Profit (SKU)", ro: "Profit absolut (SKU)" },
  category: "Profitability",
  shortDefinition: {
    en: "Gross margin in money terms — NIV revenue minus the SKU's direct " +
        "cost of goods sold. Not yet net of SG&A or capital cost. Use as " +
        "the cash-contribution view; pair with real_margin for the " +
        "value-creation view.",
    ro: "Marja brută în bani — venit NIV minus costul direct al " +
        "produselor vândute. Nu este net de SG&A sau cost de capital.",
  },
  plainEnglish: {
    en: "How many lei this product brought in after paying for what's in " +
        "the box. Doesn't account for office, sales, warehouse — that " +
        "happens in Real Margin.",
    ro: "Câți lei a adus produsul după ce ai plătit ce e în cutie. Nu " +
        "include birou, vânzări, depozit — alea sunt în Marja reală.",
  },
  inlineFormula: "NIV Revenue − COGS (direct)",
  related: ["gross_margin", "niv_revenue", "real_margin"],
  sourceTrace: () => ({
    sourceType: "inventory",
    skuId: "<per-row>",
    label: "Per-SKU gross margin from invoice data",
    confidence: 0.9,
  }),
};

const category_share: Concept = {
  key: "category_share",
  name: { en: "Category Share", ro: "Cota în categorie" },
  category: "Inventory",
  shortDefinition: {
    en: "This SKU's NIV revenue divided by the total NIV revenue of its " +
        "category. Higher share = the SKU is a category anchor; lower share " +
        "= long-tail. Used by the engine to spot category cannibalization " +
        "and to gate the ANCHOR classification.",
    ro: "Venitul NIV al acestui SKU împărțit la venitul NIV total al " +
        "categoriei. Cota mare = SKU-ul e ancora categoriei; mică = long-tail.",
  },
  plainEnglish: {
    en: "How big a slice of its category this product is. 50% means half " +
        "the category's sales come from this one SKU — losing it would " +
        "hurt a lot. 1% means barely registers in the category.",
    ro: "Cât de mare e felia produsului din categoria lui. 50% = jumătate " +
        "din vânzările categoriei vin de la acest SKU. 1% = abia se vede.",
  },
  inlineFormula: "SKU NIV ÷ Category NIV total",
  related: ["niv_revenue", "sku_classification"],
  sourceTrace: () => ({
    sourceType: "calculated",
    derivedFrom:
      "FE computes from the loaded sku_aggregates rows: niv_krn ÷ Σ(niv_krn where category = SKU.category).",
    confidence: 1.0,
  }),
};

const sku_classification: Concept = {
  key: "sku_classification",
  name: { en: "SKU Classification", ro: "Clasificare SKU" },
  category: "Inventory",
  shortDefinition: {
    en: "The engine's verdict on the SKU's economic role: ANCHOR (category " +
        "anchor, defend), SCALE (grow), KEEP (steady contributor), WATCH " +
        "(margin warning), WIND DOWN (negative real margin, plan exit), " +
        "ELIMINATE (clear loss, drop now). Driven by the decision-rules " +
        "engine — preset thresholds + operator overrides.",
    ro: "Verdictul motorului asupra rolului economic al SKU-ului: ANCHOR, " +
        "SCALE, KEEP, WATCH, WIND DOWN, ELIMINATE. Driverat de motorul de " +
        "reguli de decizie — praguri preset + override-uri operator.",
  },
  plainEnglish: {
    en: "What the system thinks you should DO with this product: " +
        "defend it, push it, hold it, watch it, wind it down, or kill it. " +
        "You can override the verdict in the drawer with one click.",
    ro: "Ce crede sistemul că ar trebui să FACI cu produsul: să-l aperi, " +
        "să-l împingi, să-l păstrezi, să-l urmărești, să-l închizi sau să-l " +
        "elimini. Poți schimba verdictul în drawer cu un click.",
  },
  related: ["real_margin", "category_share"],
  sourceTrace: () => ({
    sourceType: "calculated",
    derivedFrom:
      "decisionRulesStore + computeFinalBucket — applies the active preset's threshold rules " +
      "to (real_margin_pct, gm_pct, dio, category_share) per SKU. Overridable per-row by the " +
      "operator via the drawer Approve/Override actions; the override is persisted to " +
      "sku_aggregates.user_override and surfaces as a second badge.",
    confidence: 1.0,
  }),
};

const protect_bucket_count: Concept = {
  key: "protect_bucket_count",
  name: { en: "Protect Bucket Count", ro: "SKU-uri de protejat" },
  category: "Inventory",
  shortDefinition: {
    en: "Count of SKUs the decision rules tag as 'Protect' — strong real " +
        "margin AND material category share. These are the SKUs whose " +
        "loss would dent the P&L; treat as defensible assets, not " +
        "rationalization targets.",
    ro: "Numărul de SKU-uri etichetate de regulile de decizie ca " +
        "'Protect' — marjă reală puternică ȘI cotă semnificativă în " +
        "categorie. SKU-urile ale căror pierdere ar afecta P&L.",
  },
  plainEnglish: {
    en: "How many products earn the 'don't touch' label. These are your " +
        "winners — strong economics and meaningful category presence. " +
        "Keep marketing, supply, and pricing stable.",
    ro: "Câte produse au eticheta 'nu te atinge'. Sunt câștigătorii — " +
        "economic puternice și prezență semnificativă.",
  },
  related: ["sku_classification", "watch_bucket_count", "wind_down_bucket_count"],
  sourceTrace: () => ({
    sourceType: "calculated",
    derivedFrom:
      "counts3.protect — derived live by computeFinalBucket over the loaded SKU set with the " +
      "active decision-rule preset's thresholds (Decision Rules modal).",
    confidence: 1.0,
  }),
};

const watch_bucket_count: Concept = {
  key: "watch_bucket_count",
  name: { en: "Watch Bucket Count", ro: "SKU-uri de urmărit" },
  category: "Inventory",
  shortDefinition: {
    en: "Count of SKUs the decision rules tag as 'Watch' — marginal " +
        "real margin, fragile DIO, or low category share. Not failing yet, " +
        "but close enough that one bad quarter pushes them into Wind Down. " +
        "Review the rationale per-SKU; many WATCHes are addressable.",
    ro: "Numărul de SKU-uri etichetate 'Watch' — marjă reală marginală, " +
        "DIO fragil, sau cotă mică în categorie. Nu sunt eșec încă, dar " +
        "aproape.",
  },
  plainEnglish: {
    en: "Products on amber. They're not dying yet, but the numbers are " +
        "soft. Look at each one — a price adjustment or a re-supply tweak " +
        "often rescues them.",
    ro: "Produse pe galben. Nu mor încă, dar cifrele sunt slabe. Uită-te " +
        "la fiecare — o ajustare de preț sau livrare le salvează adesea.",
  },
  related: ["sku_classification", "protect_bucket_count", "wind_down_bucket_count"],
  sourceTrace: () => ({
    sourceType: "calculated",
    derivedFrom: "counts3.watch — same derivation path as protect_bucket_count.",
    confidence: 1.0,
  }),
};

const wind_down_bucket_count: Concept = {
  key: "wind_down_bucket_count",
  name: { en: "Wind Down Bucket Count", ro: "SKU-uri de închis" },
  category: "Inventory",
  shortDefinition: {
    en: "Count of SKUs the decision rules tag as 'Wind Down' — real " +
        "margin negative AND no offsetting category-anchor benefit. These " +
        "SKUs are net consumers of capital; the engine recommends planned " +
        "exit unless the operator marks them strategic via override.",
    ro: "Numărul de SKU-uri etichetate 'Wind Down' — marjă reală " +
        "negativă ȘI fără beneficiu compensator de ancoră în categorie. " +
        "SKU-uri consumatoare nete de capital.",
  },
  plainEnglish: {
    en: "Products that are losing you money on the way through the system " +
        "and aren't justifying that loss by anchoring their category. The " +
        "system's vote: plan their exit. You can override per-SKU if there's " +
        "a strategic reason to keep them.",
    ro: "Produse care îți consumă bani și nici nu justifică pierderea " +
        "prin rolul lor de ancoră. Recomandarea sistemului: planifică " +
        "ieșirea. Poți schimba decizia per SKU.",
  },
  related: ["sku_classification", "protect_bucket_count", "watch_bucket_count"],
  sourceTrace: () => ({
    sourceType: "calculated",
    derivedFrom: "counts3.wind_down — same derivation path as protect_bucket_count.",
    confidence: 1.0,
  }),
};

export const PRODUCTS_CONCEPTS: Concept[] = [
  real_margin,
  allocated_sga,
  capital_cost_on_inventory,
  niv_revenue,
  absolute_profit_sku,
  category_share,
  sku_classification,
  protect_bucket_count,
  watch_bucket_count,
  wind_down_bucket_count,
];
