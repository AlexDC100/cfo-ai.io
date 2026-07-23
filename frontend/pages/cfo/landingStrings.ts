// Landing-page copy, per language.
//
// The landing renders from static HTML template strings (see Landing.tsx), so
// it can't use react-i18next keys inline the way app surfaces do. Instead the
// templates are functions of one typed strings object, and the language
// picker in the landing header swaps which dictionary is passed in.
//
// Scope note: the three LEGAL DOCUMENTS (privacy / cookies / terms) are
// deliberately NOT translated — legal text needs a lawyer, not a model. They
// render in English with a translated notice (legal.englishNote).
//
// Tokens: FAQ answers may contain {privacy} / {terms}; the consent body may
// contain {cookiePolicy}. Landing.tsx replaces them with localized in-page
// link buttons.

export interface LandingStrings {
  nav: { home: string; pricing: string; legal: string; contact: string; workspace: string; language: string };
  auth: { signIn: string; getStartedFree: string };
  menu: { openApp: string; settings: string; signOut: string };
  signout: { title: string; body: string; cancel: string; confirm: string };
  hero: {
    eyebrow: string;
    t1: string; thl: string; t2: string;
    body: string;
    ctaStart: string; ctaPricing: string;
    checks: string[];
    mockNote: string;
  };
  stats: { drift: string; ratios: string; peers: string; upload: string };
  modules: {
    eyebrow: string; t1: string; thl: string;
    cards: { kicker: string; title: string; body: string }[];
  };
  how: {
    eyebrow: string; t1: string; thl: string;
    steps: { title: string; body: string }[];
  };
  defensible: {
    eyebrow: string; title: string; body: string;
    bullets: { strong: string; rest: string }[];
    cardLabel: string; yourCo: string; cardNote: string;
  };
  audiences: {
    eyebrow: string; t1: string; thl: string;
    cards: { title: string; body: string }[];
  };
  faq: { eyebrow: string; title: string; items: { q: string; a: string }[] };
  cta: { t1: string; thl: string; body: string; start: string; signIn: string; goWorkspace: string };
  pricing: {
    eyebrow: string; t1: string; thl: string; subtitle: string; note: string; perMonth: string;
    solo: { name: string; yearly: string; blurb: string; cta: string; features: string[] };
    business: { badge: string; name: string; yearly: string; blurb: string; cta: string; lead: string[]; features: string[] };
    pro: { name: string; price: string; priceNote: string; blurb: string; cta: string; lead: string[]; features: string[] };
  };
  legal: {
    eyebrow: string; title: string; subtitle: string; englishNote: string;
    privacy: string; cookies: string; terms: string;
  };
  contact: {
    eyebrow: string; title: string; subtitle: string;
    phName: string; phEmail: string; phCompany: string; phMessage: string;
    invalid: string; error: string; sending: string; send: string;
    sentTitle: string; sentBody: string; note: string;
    sales: { kicker: string; blurb: string };
    support: { kicker: string; blurb: string };
    privacy: { kicker: string; blurb: string };
    office: string;
  };
  footer: {
    blurb: string;
    product: string; overview: string; how: string; trust: string; audiences: string; faq: string;
    legalCol: string; cookieSettings: string;
    contactCol: string; contactUs: string;
    rights: string; madeIn: string;
  };
  consent: {
    title: string; body: string;
    necessary: string; necessaryDesc: string; alwaysOn: string;
    analytics: string; analyticsDesc: string;
    marketing: string; marketingDesc: string;
    acceptAll: string; rejectAll: string; save: string; customise: string;
  };
}

const en: LandingStrings = {
  nav: { home: "Home", pricing: "Pricing", legal: "Legal", contact: "Contact", workspace: "Workspace", language: "Language" },
  auth: { signIn: "Sign in", getStartedFree: "Get started" },
  menu: { openApp: "Open the app", settings: "Settings", signOut: "Sign out" },
  signout: {
    title: "Sign out of CFO AI?",
    body: "You'll be signed out on this device. Your workspaces, documents and analyses stay exactly where you left them.",
    cancel: "Cancel", confirm: "Sign out",
  },
  hero: {
    eyebrow: "CFO AI · Built for private businesses",
    t1: "Turn a trial balance into a ", thl: "CFO-grade analysis", t2: " in 90 seconds.",
    body: "Upload your books. CFO AI reconstructs your P&L, balance sheet, cash flow, 100+ ratios, valuation and credit score — then benchmarks you against public companies your size, in your sector. Named comparisons, not vague industry averages.",
    ctaStart: "Start", ctaPricing: "See pricing",
    checks: ["30-day trial", "RAS / EU filings supported", "Cancel anytime"],
    mockNote: "Illustrative dashboard. AI-assisted analysis — final decisions remain with your management team.",
  },
  stats: { drift: "Balance-sheet drift", ratios: "Financial ratios", peers: "Public-company peers", upload: "Upload to report" },
  modules: {
    eyebrow: "Four flagship modules", t1: "One platform. ", thl: "Your books, or any public company.",
    cards: [
      { kicker: "Trial balance → board-ready report", title: "Financial Statement Intelligence", body: "Ministry-of-Finance filings, accountant exports, annual reports — from any European country. Auto-detected, normalized, ratioed, valued and explained." },
      { kicker: "BVB tickers → analysis", title: "Public Company Intelligence", body: "Every company listed on the Bucharest Stock Exchange — statutory financials from official ANAF filings plus live BVB prices. Same dashboard, ratios, valuation and CFO chat as your private books — add any as a benchmark peer." },
      { kicker: "ERP exports → cash forecast", title: "Invoice Intelligence", body: "Customer &amp; supplier concentration, margin by client, VAT reconciliation and payment timing — surfaced as dedicated tabs inside your statements." },
      { kicker: "Ask questions → grounded answers", title: "Ask CFO AI", body: "A financial copilot grounded in your numbers. Ask why margin moved, what a ratio means, or what to do next — with the reasoning and source lines shown." },
    ],
  },
  how: {
    eyebrow: "How it works", t1: "Three steps from spreadsheet to ", thl: "action plan.",
    steps: [
      { title: "Upload your books", body: "Trial balance, bilanț, P&amp;L or balance sheet — Excel, CSV, or PDF. Columns and RAS accounts are mapped automatically." },
      { title: "CFO AI computes the economics", body: "P&amp;L, balance sheet, cash flow, 100+ ratios, EBITDA variants, Altman Z, valuation and credit score — reconciled to your source to ≤1% drift." },
      { title: "You act with context", body: "Ranked, quantified recommendations plus named public-company peers — export to HTML, an 8-sheet Excel model, or a board summary." },
    ],
  },
  defensible: {
    eyebrow: "Defensible by design",
    title: "Numbers a lender, auditor or investor can trust.",
    body: "The RAS-compliant engine reconciles all eight calibration fixtures to ≤1% balance-sheet drift — five of eight to exactly 0.00% — and reproduces filed-P&amp;L EBITDA across three named variants (reported, strict, cash). When a source file has an imbalance, CFO AI surfaces it explicitly rather than smoothing it over.",
    bullets: [
      { strong: "Reproducible.", rest: "The same trial balance always produces the same output." },
      { strong: "Traceable.", rest: "Every number links back to the source line it came from." },
      { strong: "Honest about uncertainty.", rest: "Approximations are marked, never buried." },
    ],
    cardLabel: "Peer benchmark · EBITDA margin", yourCo: "Your Co.",
    cardNote: "You sit in the top quartile of your matched peer set on operating profitability.",
  },
  audiences: {
    eyebrow: "Who it's for", t1: "Built for whoever reads the ", thl: "numbers.",
    cards: [
      { title: "Founders &amp; owners", body: "Understand your own financials the way an analyst would — and see exactly where you stand against real peers." },
      { title: "Finance teams", body: "Turn a month-end trial balance into board-ready statements, ratios and a credit score without rebuilding a model." },
      { title: "Investors &amp; analysts", body: "Run due diligence on private targets and public comparables through the same engine, side by side." },
      { title: "Advisors &amp; accountants", body: "Deliver CFO-grade analyses across a portfolio of client companies — consistently, in minutes each." },
      { title: "Lenders", body: "Screen credit with Altman Z″, coverage ratios and covenant-ready strict EBITDA — with the source reconciliation shown." },
      { title: "Family offices", body: "Review multiple group entities and holdings on one consistent framework, including NAV for asset-heavy vehicles." },
    ],
  },
  faq: {
    eyebrow: "Questions", title: "Frequently asked",
    items: [
      { q: "What file formats can I upload?", a: "Trial balances (balanță de verificare), balance sheets, P&amp;L statements and annual reports as Excel, CSV or PDF. Exports from SAGA, WinMENTOR and standard Romanian and European accounting software are supported, with accounts mapped automatically." },
      { q: "How accurate is the analysis?", a: "On clean trial balances, the engine reconciles balance-sheet totals to within 1% drift across its eight calibration fixtures — five of eight to exactly 0.00%. It computes three named EBITDA variants that match byte-for-byte between the methodology layer and the code. It is a decision-support tool, not a substitute for professional judgement." },
      { q: "Is my financial data secure?", a: "Your data is stored on EU-region infrastructure with row-level security so only your account can access it. We never sell your data. See our {privacy} for the full detail on sub-processors and your rights under the GDPR." },
      { q: "Do you offer a free trial?", a: "Yes — every plan starts with a 30-day trial. Founding members pay just €1 for their first month. You can cancel any time before renewal." },
      { q: "Which countries and accounting standards are supported?", a: "The engine is calibrated for Romanian RAS (OMFP 1802) today, with a country-agnostic canonical schema designed to extend to other European charts of accounts. Public-company analysis covers every company listed on the Bucharest Stock Exchange, from official ANAF statutory filings and live BVB market data." },
      { q: "Is this financial or investment advice?", a: "No. CFO AI produces AI-assisted analysis and decision support. It is not financial, investment, legal, tax or accounting advice, and final decisions remain with you and your management team. See our {terms}." },
    ],
  },
  cta: {
    t1: "See your business the way a ", thl: "CFO would.",
    body: "Upload your first trial balance and get a full analysis in under five minutes. No credit card required.",
    start: "Get started", signIn: "Sign in", goWorkspace: "Go to workspace",
  },
  pricing: {
    eyebrow: "Pricing", t1: "Simple plans that ", thl: "scale with you.",
    subtitle: "Every plan starts with a 30-day trial. Founding members pay €1 for their first month. Cancel anytime.",
    note: "All prices exclude VAT where applicable. Overage documents are billed per-document and always confirmed before processing.",
    perMonth: "/mo",
    solo: {
      name: "Solo", yearly: "or €199 / year — save €41",
      blurb: "Individual investors, freelance analysts and founders doing personal due diligence.",
      cta: "Start Solo trial",
      features: ["1 company · 10 uploads / month", "P&amp;L, balance sheet &amp; cash flow", "Essential ratios &amp; EBITDA", "Altman Z bankruptcy screen", "30 Ask CFO AI messages / month", "12-month history · email support"],
    },
    business: {
      badge: "Most popular", name: "Business", yearly: "or €590 / year — save €118",
      blurb: "SMB owners, internal finance teams, real-estate holdings and family-group portfolios.",
      cta: "Start Business trial",
      lead: ["5 companies · 2 users · 25 uploads / month", "Everything in Solo, plus:"],
      features: ["Full 100+ ratio suite", "Altman Z + Piotroski F-score", "Valuation suite &amp; NAV cascade", "Industry benchmarks &amp; peer comparison", "Recommendations engine &amp; monthly reports", "100 AI messages/mo · share links · live chat"],
    },
    pro: {
      name: "Professional", price: "Custom", priceNote: "Contact sales — priced per contract",
      blurb: "Advisory firms, accountants, multi-entity holdings and M&amp;A boutiques managing 5+ companies.",
      cta: "Contact sales",
      lead: ["Up to 25 companies · 10 users", "Everything in Business, plus:"],
      features: ["Multi-entity consolidated view", "API access", "Dedicated onboarding", "Priority phone support · 4h SLA"],
    },
  },
  legal: {
    eyebrow: "Legal", title: "The fine print, in plain sight.",
    subtitle: "How CFO AI handles your data, and the terms that govern the service — all on one page.",
    englishNote: "",
    privacy: "Privacy Policy", cookies: "Cookie Policy", terms: "Terms of Service",
  },
  contact: {
    eyebrow: "Contact", title: "Talk to us.",
    subtitle: "Whether you're evaluating CFO AI for a portfolio of companies or just have a question — we'd like to hear from you.",
    phName: "Your name *", phEmail: "Email *", phCompany: "Company (optional)", phMessage: "How can we help? *",
    invalid: "Please fill in your name, a valid email and a message.",
    error: `Couldn't send your message. Please try again, or email <a href="mailto:support@cfo-ai.io">support@cfo-ai.io</a> directly.`,
    sending: "Sending…", send: "Send",
    sentTitle: "Message sent.", sentBody: "Thanks for reaching out — we'll get back to you within one business day.",
    note: "By sending, you agree we may email you back about your request. See our Privacy Policy.",
    sales: { kicker: "Sales &amp; Professional plan", blurb: "Custom limits, multi-entity and API access." },
    support: { kicker: "Support", blurb: "Help with your account, uploads or analyses." },
    privacy: { kicker: "Privacy &amp; data", blurb: "Exercise your GDPR rights or ask about data." },
    office: "Registered office",
  },
  footer: {
    blurb: "CFO-grade financial analysis and benchmarking for private businesses.",
    product: "Product", overview: "Overview", how: "How it works", trust: "Why trust it", audiences: "Who it's for", faq: "FAQ",
    legalCol: "Legal", cookieSettings: "Cookie settings",
    contactCol: "Contact", contactUs: "Contact us",
    rights: "© {year} CFO AI · [Company Legal Name]. All rights reserved.",
    madeIn: "Made in the EU · GDPR-compliant",
  },
  consent: {
    title: "We value your privacy",
    body: "We use strictly necessary cookies to run CFO AI, and — only with your consent — optional analytics and marketing cookies. You can accept all, reject optional ones, or choose. Read our {cookiePolicy}.",
    necessary: "Strictly necessary", necessaryDesc: "Required for sign-in, security and saving your choice.", alwaysOn: "Always on",
    analytics: "Analytics", analyticsDesc: "Helps us improve the product.",
    marketing: "Marketing", marketingDesc: "Measures campaigns and relevance.",
    acceptAll: "Accept all", rejectAll: "Reject optional", save: "Save choices", customise: "Customise",
  },
};

const ro: LandingStrings = {
  nav: { home: "Acasă", pricing: "Prețuri", legal: "Legal", contact: "Contact", workspace: "Spațiu de lucru", language: "Limbă" },
  auth: { signIn: "Autentificare", getStartedFree: "Începe" },
  menu: { openApp: "Deschide aplicația", settings: "Setări", signOut: "Deconectare" },
  signout: {
    title: "Te deconectezi de la CFO AI?",
    body: "Vei fi deconectat pe acest dispozitiv. Spațiile de lucru, documentele și analizele tale rămân exact unde le-ai lăsat.",
    cancel: "Anulează", confirm: "Deconectare",
  },
  hero: {
    eyebrow: "CFO AI · Creat pentru afaceri private",
    t1: "Transformă o balanță de verificare într-o ", thl: "analiză de nivel CFO", t2: " în 90 de secunde.",
    body: "Încarcă-ți contabilitatea. CFO AI reconstruiește P&L-ul, bilanțul, fluxul de numerar, peste 100 de indicatori, evaluarea și scorul de credit — apoi te compară cu companii publice de dimensiunea ta, din sectorul tău. Comparații nominale, nu medii vagi de industrie.",
    ctaStart: "Începe", ctaPricing: "Vezi prețurile",
    checks: ["Probă de 30 de zile", "Suport RAS / raportări UE", "Anulezi oricând"],
    mockNote: "Dashboard ilustrativ. Analiză asistată de AI — deciziile finale rămân la echipa ta de management.",
  },
  stats: { drift: "Abatere de bilanț", ratios: "Indicatori financiari", peers: "Companii publice comparabile", upload: "De la încărcare la raport" },
  modules: {
    eyebrow: "Patru module emblematice", t1: "O singură platformă. ", thl: "Contabilitatea ta sau orice companie publică.",
    cards: [
      { kicker: "Balanță de verificare → raport pentru board", title: "Financial Statement Intelligence", body: "Raportări la Ministerul de Finanțe, exporturi de la contabil, rapoarte anuale — din orice țară europeană. Detectate automat, normalizate, transformate în indicatori, evaluate și explicate." },
      { kicker: "Tickere BVB → analiză", title: "Public Company Intelligence", body: "Toate companiile listate la Bursa de Valori București — situații financiare statutare din raportările oficiale ANAF plus prețuri BVB în timp real. Același dashboard, aceiași indicatori, aceeași evaluare și același chat CFO ca pentru cifrele tale private — adaugă oricare drept reper de comparație." },
      { kicker: "Exporturi ERP → prognoză de numerar", title: "Invoice Intelligence", body: "Concentrarea clienților și furnizorilor, marja pe client, reconcilierea TVA și termenele de plată — afișate ca taburi dedicate în situațiile tale financiare." },
      { kicker: "Pui întrebări → răspunsuri fundamentate", title: "Ask CFO AI", body: "Un copilot financiar ancorat în cifrele tale. Întreabă de ce s-a mișcat marja, ce înseamnă un indicator sau ce urmează — cu raționamentul și liniile-sursă afișate." },
    ],
  },
  how: {
    eyebrow: "Cum funcționează", t1: "Trei pași de la foaia de calcul la ", thl: "planul de acțiune.",
    steps: [
      { title: "Încarcă-ți contabilitatea", body: "Balanță de verificare, bilanț sau P&amp;L — Excel, CSV sau PDF. Coloanele și conturile RAS sunt mapate automat." },
      { title: "CFO AI calculează economia afacerii", body: "P&amp;L, bilanț, cash flow, 100+ indicatori, variante de EBITDA, Altman Z, evaluare și scor de credit — reconciliate cu sursa până la o abatere de ≤1%." },
      { title: "Tu acționezi în cunoștință de cauză", body: "Recomandări ierarhizate și cuantificate plus companii publice comparabile, numite explicit — export în HTML, model Excel cu 8 foi sau rezumat pentru board." },
    ],
  },
  defensible: {
    eyebrow: "Defensibil prin design",
    title: "Cifre în care un creditor, auditor sau investitor poate avea încredere.",
    body: "Motorul conform RAS reconciliază toate cele opt cazuri de calibrare la o abatere de bilanț de ≤1% — cinci din opt exact la 0,00% — și reproduce EBITDA din P&amp;L-ul depus în trei variante numite (raportat, strict, cash). Când un fișier-sursă are un dezechilibru, CFO AI îl semnalează explicit în loc să-l netezească.",
    bullets: [
      { strong: "Reproductibil.", rest: "Aceeași balanță de verificare produce întotdeauna același rezultat." },
      { strong: "Trasabil.", rest: "Fiecare cifră trimite înapoi la linia-sursă din care provine." },
      { strong: "Onest cu incertitudinea.", rest: "Aproximările sunt marcate, niciodată ascunse." },
    ],
    cardLabel: "Benchmark comparabil · Marjă EBITDA", yourCo: "Compania ta",
    cardNote: "Te afli în quartila superioară a setului tău de companii comparabile la profitabilitatea operațională.",
  },
  audiences: {
    eyebrow: "Pentru cine este", t1: "Creat pentru oricine citește ", thl: "cifrele.",
    cards: [
      { title: "Fondatori &amp; proprietari", body: "Înțelege-ți propriile finanțe așa cum ar face-o un analist — și vezi exact unde te situezi față de companii comparabile reale." },
      { title: "Echipe financiare", body: "Transformă balanța de la închiderea lunii în situații pentru board, indicatori și un scor de credit, fără a reconstrui un model." },
      { title: "Investitori &amp; analiști", body: "Rulează due diligence pe ținte private și comparabile publice prin același motor, una lângă alta." },
      { title: "Consultanți &amp; contabili", body: "Livrează analize de nivel CFO pentru un portofoliu de clienți — consecvent, în câteva minute fiecare." },
      { title: "Creditori", body: "Evaluează riscul de credit cu Altman Z″, indicatori de acoperire și EBITDA strict pregătit pentru covenante — cu reconcilierea sursei afișată." },
      { title: "Family office-uri", body: "Analizează mai multe entități de grup și participații într-un cadru unic și consecvent, inclusiv NAV pentru vehicule cu active semnificative." },
    ],
  },
  faq: {
    eyebrow: "Întrebări", title: "Întrebări frecvente",
    items: [
      { q: "Ce formate de fișiere pot încărca?", a: "Balanțe de verificare, bilanțuri, conturi de profit și pierdere și rapoarte anuale în Excel, CSV sau PDF. Exporturile din SAGA, WinMENTOR și software-ul de contabilitate standard românesc și european sunt suportate, cu maparea automată a conturilor." },
      { q: "Cât de precisă este analiza?", a: "Pe balanțe curate, motorul reconciliază totalurile de bilanț la o abatere sub 1% pe cele opt cazuri de calibrare — cinci din opt exact la 0,00%. Calculează trei variante numite de EBITDA care corespund întocmai între metodologie și cod. Este un instrument de suport decizional, nu un substitut pentru judecata profesională." },
      { q: "Datele mele financiare sunt în siguranță?", a: "Datele tale sunt stocate pe infrastructură din regiunea UE, cu securitate la nivel de rând, astfel încât doar contul tău le poate accesa. Nu îți vindem niciodată datele. Vezi {privacy} pentru detalii complete despre subprocesatori și drepturile tale conform GDPR." },
      { q: "Oferiți o perioadă de probă gratuită?", a: "Da — fiecare plan începe cu o probă de 30 de zile. Membrii fondatori plătesc doar 1 € pentru prima lună. Poți anula oricând înainte de reînnoire." },
      { q: "Ce țări și standarde contabile sunt suportate?", a: "Motorul este calibrat astăzi pentru RAS românesc (OMFP 1802), cu o schemă canonică independentă de țară, proiectată să se extindă la alte planuri de conturi europene. Analiza companiilor publice acoperă toate companiile listate la Bursa de Valori București, pe baza raportărilor statutare oficiale ANAF și a datelor de piață BVB în timp real." },
      { q: "Aceasta este consultanță financiară sau de investiții?", a: "Nu. CFO AI produce analiză asistată de AI și suport decizional. Nu reprezintă consultanță financiară, de investiții, juridică, fiscală sau contabilă, iar deciziile finale rămân la tine și la echipa ta de management. Vezi {terms}." },
    ],
  },
  cta: {
    t1: "Vezi-ți afacerea așa cum ar vedea-o un ", thl: "CFO.",
    body: "Încarcă prima balanță de verificare și primești o analiză completă în mai puțin de cinci minute. Fără card de credit.",
    start: "Începe gratuit", signIn: "Autentificare", goWorkspace: "Mergi la spațiul de lucru",
  },
  pricing: {
    eyebrow: "Prețuri", t1: "Planuri simple care ", thl: "cresc odată cu tine.",
    subtitle: "Fiecare plan începe cu o probă de 30 de zile. Membrii fondatori plătesc 1 € pentru prima lună. Anulezi oricând.",
    note: "Toate prețurile nu includ TVA, acolo unde este cazul. Documentele peste limită se facturează per document și sunt întotdeauna confirmate înainte de procesare.",
    perMonth: "/lună",
    solo: {
      name: "Solo", yearly: "sau 199 € / an — economisești 41 €",
      blurb: "Investitori individuali, analiști freelance și fondatori care fac due diligence personal.",
      cta: "Începe proba Solo",
      features: ["1 companie · 10 încărcări / lună", "P&amp;L, bilanț &amp; cash flow", "Indicatori esențiali &amp; EBITDA", "Screening de faliment Altman Z", "30 de mesaje Ask CFO AI / lună", "Istoric de 12 luni · suport pe e-mail"],
    },
    business: {
      badge: "Cel mai popular", name: "Business", yearly: "sau 590 € / an — economisești 118 €",
      blurb: "Proprietari de IMM-uri, echipe financiare interne, holdinguri imobiliare și portofolii de grup familial.",
      cta: "Începe proba Business",
      lead: ["5 companii · 2 utilizatori · 25 de încărcări / lună", "Tot ce e în Solo, plus:"],
      features: ["Suita completă de 100+ indicatori", "Altman Z + scorul Piotroski F", "Suită de evaluare &amp; cascadă NAV", "Benchmark-uri de industrie &amp; comparație cu companii similare", "Motor de recomandări &amp; rapoarte lunare", "100 de mesaje AI/lună · linkuri de partajare · chat live"],
    },
    pro: {
      name: "Professional", price: "Personalizat", priceNote: "Contactează vânzările — preț per contract",
      blurb: "Firme de consultanță, contabili, holdinguri multi-entitate și butici de M&amp;A care gestionează 5+ companii.",
      cta: "Contactează vânzările",
      lead: ["Până la 25 de companii · 10 utilizatori", "Tot ce e în Business, plus:"],
      features: ["Vedere consolidată multi-entitate", "Acces API", "Onboarding dedicat", "Suport telefonic prioritar · SLA 4h"],
    },
  },
  legal: {
    eyebrow: "Legal", title: "Termenii, la vedere.",
    subtitle: "Cum gestionează CFO AI datele tale și termenii care guvernează serviciul — totul pe o singură pagină.",
    englishNote: "Documentele juridice de mai jos sunt furnizate în limba engleză.",
    privacy: "Politica de confidențialitate", cookies: "Politica de cookie-uri", terms: "Termenii serviciului",
  },
  contact: {
    eyebrow: "Contact", title: "Hai să vorbim.",
    subtitle: "Fie că evaluezi CFO AI pentru un portofoliu de companii, fie că ai doar o întrebare — ne-ar plăcea să te auzim.",
    phName: "Numele tău *", phEmail: "E-mail *", phCompany: "Compania (opțional)", phMessage: "Cu ce te putem ajuta? *",
    invalid: "Te rugăm să completezi numele, un e-mail valid și un mesaj.",
    error: `Mesajul nu a putut fi trimis. Încearcă din nou sau scrie-ne direct la <a href="mailto:support@cfo-ai.io">support@cfo-ai.io</a>.`,
    sending: "Se trimite…", send: "Trimite",
    sentTitle: "Mesaj trimis.", sentBody: "Mulțumim că ne-ai scris — revenim în cel mult o zi lucrătoare.",
    note: "Prin trimitere, ești de acord să te contactăm pe e-mail în legătură cu solicitarea ta. Vezi Politica de confidențialitate.",
    sales: { kicker: "Vânzări &amp; planul Professional", blurb: "Limite personalizate, multi-entitate și acces API." },
    support: { kicker: "Suport", blurb: "Ajutor cu contul, încărcările sau analizele tale." },
    privacy: { kicker: "Confidențialitate &amp; date", blurb: "Exercită-ți drepturile GDPR sau întreabă despre date." },
    office: "Sediu social",
  },
  footer: {
    blurb: "Analiză financiară de nivel CFO și benchmarking pentru afaceri private.",
    product: "Produs", overview: "Prezentare", how: "Cum funcționează", trust: "De ce e de încredere", audiences: "Pentru cine este", faq: "Întrebări frecvente",
    legalCol: "Legal", cookieSettings: "Setări cookie-uri",
    contactCol: "Contact", contactUs: "Contactează-ne",
    rights: "© {year} CFO AI · [Company Legal Name]. Toate drepturile rezervate.",
    madeIn: "Creat în UE · Conform GDPR",
  },
  consent: {
    title: "Îți respectăm confidențialitatea",
    body: "Folosim cookie-uri strict necesare pentru funcționarea CFO AI și — doar cu acordul tău — cookie-uri opționale de analiză și marketing. Poți accepta tot, respinge opționalele sau alege. Citește {cookiePolicy}.",
    necessary: "Strict necesare", necessaryDesc: "Necesare pentru autentificare, securitate și salvarea alegerii tale.", alwaysOn: "Mereu active",
    analytics: "Analiză", analyticsDesc: "Ne ajută să îmbunătățim produsul.",
    marketing: "Marketing", marketingDesc: "Măsoară campaniile și relevanța.",
    acceptAll: "Acceptă tot", rejectAll: "Respinge opționalele", save: "Salvează alegerile", customise: "Personalizează",
  },
};

const de: LandingStrings = {
  nav: { home: "Start", pricing: "Preise", legal: "Rechtliches", contact: "Kontakt", workspace: "Workspace", language: "Sprache" },
  auth: { signIn: "Anmelden", getStartedFree: "Starten" },
  menu: { openApp: "App öffnen", settings: "Einstellungen", signOut: "Abmelden" },
  signout: {
    title: "Von CFO AI abmelden?",
    body: "Du wirst auf diesem Gerät abgemeldet. Deine Workspaces, Dokumente und Analysen bleiben genau dort, wo du sie gelassen hast.",
    cancel: "Abbrechen", confirm: "Abmelden",
  },
  hero: {
    eyebrow: "CFO AI · Für Privatunternehmen gemacht",
    t1: "Verwandle eine Summen- und Saldenliste in eine ", thl: "Analyse auf CFO-Niveau", t2: " — in 90 Sekunden.",
    body: "Lade deine Buchhaltung hoch. CFO AI rekonstruiert GuV, Bilanz, Cashflow, über 100 Kennzahlen, Bewertung und Kredit-Score — und benchmarkt dich gegen börsennotierte Unternehmen deiner Größe in deiner Branche. Namentliche Vergleiche statt vager Branchendurchschnitte.",
    ctaStart: "Starten", ctaPricing: "Preise ansehen",
    checks: ["30 Tage testen", "RAS- / EU-Abschlüsse unterstützt", "Jederzeit kündbar"],
    mockNote: "Illustratives Dashboard. KI-gestützte Analyse — endgültige Entscheidungen trifft dein Management.",
  },
  stats: { drift: "Bilanzabweichung", ratios: "Finanzkennzahlen", peers: "Börsennotierte Peers", upload: "Vom Upload zum Report" },
  modules: {
    eyebrow: "Vier Flaggschiff-Module", t1: "Eine Plattform. ", thl: "Deine Bücher oder jedes börsennotierte Unternehmen.",
    cards: [
      { kicker: "Saldenliste → Board-fähiger Report", title: "Financial Statement Intelligence", body: "Abschlüsse vom Finanzministerium, Exporte vom Steuerberater, Jahresberichte — aus jedem europäischen Land. Automatisch erkannt, normalisiert, in Kennzahlen überführt, bewertet und erklärt." },
      { kicker: "BVB-Ticker → Analyse", title: "Public Company Intelligence", body: "Alle an der Bukarester Börse gelisteten Unternehmen — statutarische Abschlüsse aus offiziellen ANAF-Meldungen plus BVB-Kurse in Echtzeit. Dasselbe Dashboard, dieselben Kennzahlen, Bewertung und CFO-Chat wie für deine privaten Bücher — füge jedes als Vergleichsunternehmen hinzu." },
      { kicker: "ERP-Exporte → Cash-Prognose", title: "Invoice Intelligence", body: "Kunden- und Lieferantenkonzentration, Marge pro Kunde, USt-Abstimmung und Zahlungsziele — als eigene Tabs in deinen Abschlüssen." },
      { kicker: "Fragen stellen → fundierte Antworten", title: "Ask CFO AI", body: "Ein Finanz-Copilot, verankert in deinen Zahlen. Frag, warum sich die Marge bewegt hat, was eine Kennzahl bedeutet oder was als Nächstes zu tun ist — mit sichtbarer Begründung und Quellzeilen." },
    ],
  },
  how: {
    eyebrow: "So funktioniert es", t1: "Drei Schritte vom Spreadsheet zum ", thl: "Aktionsplan.",
    steps: [
      { title: "Lade deine Bücher hoch", body: "Saldenliste, Bilanz oder GuV — Excel, CSV oder PDF. Spalten und RAS-Konten werden automatisch zugeordnet." },
      { title: "CFO AI berechnet die Ökonomie", body: "GuV, Bilanz, Cashflow, 100+ Kennzahlen, EBITDA-Varianten, Altman Z, Bewertung und Kredit-Score — mit ≤1 % Abweichung zur Quelle abgestimmt." },
      { title: "Du handelst mit Kontext", body: "Priorisierte, quantifizierte Empfehlungen plus namentlich genannte börsennotierte Peers — Export als HTML, 8-Blatt-Excel-Modell oder Board-Zusammenfassung." },
    ],
  },
  defensible: {
    eyebrow: "Belastbar by Design",
    title: "Zahlen, denen Kreditgeber, Prüfer und Investoren vertrauen können.",
    body: "Die RAS-konforme Engine stimmt alle acht Kalibrierungsfälle auf ≤1 % Bilanzabweichung ab — fünf von acht exakt auf 0,00 % — und reproduziert das EBITDA der eingereichten GuV in drei benannten Varianten (berichtet, strikt, cash). Enthält eine Quelldatei ein Ungleichgewicht, weist CFO AI explizit darauf hin, statt es zu glätten.",
    bullets: [
      { strong: "Reproduzierbar.", rest: "Dieselbe Saldenliste liefert immer dasselbe Ergebnis." },
      { strong: "Nachvollziehbar.", rest: "Jede Zahl verweist auf die Quellzeile, aus der sie stammt." },
      { strong: "Ehrlich bei Unsicherheit.", rest: "Näherungen werden markiert, nie versteckt." },
    ],
    cardLabel: "Peer-Benchmark · EBITDA-Marge", yourCo: "Deine Firma",
    cardNote: "Bei der operativen Profitabilität liegst du im obersten Quartil deiner Vergleichsgruppe.",
  },
  audiences: {
    eyebrow: "Für wen es ist", t1: "Gebaut für alle, die die ", thl: "Zahlen lesen.",
    cards: [
      { title: "Gründer &amp; Inhaber", body: "Verstehe deine eigenen Finanzen wie ein Analyst — und sieh genau, wo du im Vergleich zu echten Peers stehst." },
      { title: "Finanzteams", body: "Verwandle die Saldenliste zum Monatsende in Board-fähige Abschlüsse, Kennzahlen und einen Kredit-Score — ohne ein Modell neu zu bauen." },
      { title: "Investoren &amp; Analysten", body: "Führe Due Diligence auf private Targets und börsennotierte Comparables über dieselbe Engine durch, Seite an Seite." },
      { title: "Berater &amp; Steuerberater", body: "Liefere Analysen auf CFO-Niveau über ein ganzes Mandantenportfolio — konsistent, in Minuten." },
      { title: "Kreditgeber", body: "Prüfe Kreditrisiken mit Altman Z″, Deckungskennzahlen und covenant-fähigem striktem EBITDA — inklusive sichtbarer Quellabstimmung." },
      { title: "Family Offices", body: "Betrachte mehrere Gruppengesellschaften und Beteiligungen in einem konsistenten Rahmen, inklusive NAV für asset-lastige Vehikel." },
    ],
  },
  faq: {
    eyebrow: "Fragen", title: "Häufig gestellt",
    items: [
      { q: "Welche Dateiformate kann ich hochladen?", a: "Saldenlisten, Bilanzen, GuV und Jahresberichte als Excel, CSV oder PDF. Exporte aus SAGA, WinMENTOR und gängiger rumänischer sowie europäischer Buchhaltungssoftware werden unterstützt; Konten werden automatisch zugeordnet." },
      { q: "Wie genau ist die Analyse?", a: "Bei sauberen Saldenlisten stimmt die Engine die Bilanzsummen über ihre acht Kalibrierungsfälle auf unter 1 % Abweichung ab — fünf von acht exakt auf 0,00 %. Sie berechnet drei benannte EBITDA-Varianten, die zwischen Methodik und Code exakt übereinstimmen. Sie ist ein Entscheidungsunterstützungs-Tool, kein Ersatz für professionelles Urteil." },
      { q: "Sind meine Finanzdaten sicher?", a: "Deine Daten liegen auf Infrastruktur in der EU-Region mit Row-Level-Security, sodass nur dein Konto darauf zugreifen kann. Wir verkaufen deine Daten niemals. Details zu Unterauftragsverarbeitern und deinen DSGVO-Rechten findest du in unserer {privacy}." },
      { q: "Gibt es eine kostenlose Testphase?", a: "Ja — jeder Plan startet mit einer 30-tägigen Testphase. Founding Members zahlen für den ersten Monat nur 1 €. Du kannst jederzeit vor der Verlängerung kündigen." },
      { q: "Welche Länder und Rechnungslegungsstandards werden unterstützt?", a: "Die Engine ist heute für das rumänische RAS (OMFP 1802) kalibriert, mit einem länderunabhängigen kanonischen Schema, das auf weitere europäische Kontenrahmen ausgelegt ist. Die Analyse börsennotierter Unternehmen deckt alle an der Bukarester Börse gelisteten Firmen ab — aus offiziellen statutarischen ANAF-Meldungen und BVB-Marktdaten in Echtzeit." },
      { q: "Ist das Finanz- oder Anlageberatung?", a: "Nein. CFO AI liefert KI-gestützte Analyse und Entscheidungsunterstützung. Es ist keine Finanz-, Anlage-, Rechts-, Steuer- oder Buchhaltungsberatung; endgültige Entscheidungen liegen bei dir und deinem Management. Siehe unsere {terms}." },
    ],
  },
  cta: {
    t1: "Sieh dein Unternehmen so, wie ein ", thl: "CFO es sähe.",
    body: "Lade deine erste Saldenliste hoch und erhalte in unter fünf Minuten eine vollständige Analyse. Keine Kreditkarte nötig.",
    start: "Jetzt starten", signIn: "Anmelden", goWorkspace: "Zum Workspace",
  },
  pricing: {
    eyebrow: "Preise", t1: "Einfache Pläne, die ", thl: "mit dir wachsen.",
    subtitle: "Jeder Plan startet mit einer 30-tägigen Testphase. Founding Members zahlen 1 € für den ersten Monat. Jederzeit kündbar.",
    note: "Alle Preise zzgl. USt., wo anwendbar. Zusätzliche Dokumente werden pro Dokument abgerechnet und immer vor der Verarbeitung bestätigt.",
    perMonth: "/Monat",
    solo: {
      name: "Solo", yearly: "oder 199 € / Jahr — spare 41 €",
      blurb: "Einzelinvestoren, freiberufliche Analysten und Gründer bei der persönlichen Due Diligence.",
      cta: "Solo testen",
      features: ["1 Unternehmen · 10 Uploads / Monat", "GuV, Bilanz &amp; Cashflow", "Kern-Kennzahlen &amp; EBITDA", "Altman-Z-Insolvenz-Screening", "30 Ask-CFO-AI-Nachrichten / Monat", "12 Monate Historie · E-Mail-Support"],
    },
    business: {
      badge: "Am beliebtesten", name: "Business", yearly: "oder 590 € / Jahr — spare 118 €",
      blurb: "KMU-Inhaber, interne Finanzteams, Immobilien-Holdings und Familienportfolios.",
      cta: "Business testen",
      lead: ["5 Unternehmen · 2 Nutzer · 25 Uploads / Monat", "Alles aus Solo, plus:"],
      features: ["Volle Suite mit 100+ Kennzahlen", "Altman Z + Piotroski F-Score", "Bewertungssuite &amp; NAV-Kaskade", "Branchen-Benchmarks &amp; Peer-Vergleich", "Empfehlungs-Engine &amp; Monatsreports", "100 KI-Nachrichten/Monat · Share-Links · Live-Chat"],
    },
    pro: {
      name: "Professional", price: "Individuell", priceNote: "Vertrieb kontaktieren — Preis pro Vertrag",
      blurb: "Beratungen, Steuerkanzleien, Multi-Entity-Holdings und M&amp;A-Boutiquen mit 5+ Unternehmen.",
      cta: "Vertrieb kontaktieren",
      lead: ["Bis zu 25 Unternehmen · 10 Nutzer", "Alles aus Business, plus:"],
      features: ["Konsolidierte Multi-Entity-Sicht", "API-Zugang", "Dediziertes Onboarding", "Priorisierter Telefonsupport · 4h-SLA"],
    },
  },
  legal: {
    eyebrow: "Rechtliches", title: "Das Kleingedruckte, gut sichtbar.",
    subtitle: "Wie CFO AI mit deinen Daten umgeht und welche Bedingungen den Dienst regeln — alles auf einer Seite.",
    englishNote: "Die folgenden Rechtsdokumente werden auf Englisch bereitgestellt.",
    privacy: "Datenschutzerklärung", cookies: "Cookie-Richtlinie", terms: "Nutzungsbedingungen",
  },
  contact: {
    eyebrow: "Kontakt", title: "Sprich mit uns.",
    subtitle: "Ob du CFO AI für ein Firmenportfolio evaluierst oder einfach eine Frage hast — wir freuen uns auf dich.",
    phName: "Dein Name *", phEmail: "E-Mail *", phCompany: "Unternehmen (optional)", phMessage: "Wie können wir helfen? *",
    invalid: "Bitte gib deinen Namen, eine gültige E-Mail und eine Nachricht an.",
    error: `Die Nachricht konnte nicht gesendet werden. Versuch es erneut oder schreib direkt an <a href="mailto:support@cfo-ai.io">support@cfo-ai.io</a>.`,
    sending: "Wird gesendet…", send: "Senden",
    sentTitle: "Nachricht gesendet.", sentBody: "Danke für deine Nachricht — wir melden uns innerhalb eines Werktags.",
    note: "Mit dem Senden erklärst du dich einverstanden, dass wir dir zu deiner Anfrage per E-Mail antworten. Siehe Datenschutzerklärung.",
    sales: { kicker: "Vertrieb &amp; Professional-Plan", blurb: "Individuelle Limits, Multi-Entity und API-Zugang." },
    support: { kicker: "Support", blurb: "Hilfe zu Konto, Uploads oder Analysen." },
    privacy: { kicker: "Datenschutz &amp; Daten", blurb: "DSGVO-Rechte ausüben oder Fragen zu Daten stellen." },
    office: "Eingetragener Sitz",
  },
  footer: {
    blurb: "Finanzanalyse und Benchmarking auf CFO-Niveau für Privatunternehmen.",
    product: "Produkt", overview: "Überblick", how: "So funktioniert es", trust: "Warum vertrauen", audiences: "Für wen es ist", faq: "FAQ",
    legalCol: "Rechtliches", cookieSettings: "Cookie-Einstellungen",
    contactCol: "Kontakt", contactUs: "Kontaktiere uns",
    rights: "© {year} CFO AI · [Company Legal Name]. Alle Rechte vorbehalten.",
    madeIn: "Made in the EU · DSGVO-konform",
  },
  consent: {
    title: "Wir respektieren deine Privatsphäre",
    body: "Wir verwenden zwingend erforderliche Cookies für den Betrieb von CFO AI und — nur mit deiner Einwilligung — optionale Analyse- und Marketing-Cookies. Du kannst alle akzeptieren, optionale ablehnen oder auswählen. Lies unsere {cookiePolicy}.",
    necessary: "Zwingend erforderlich", necessaryDesc: "Nötig für Anmeldung, Sicherheit und das Speichern deiner Auswahl.", alwaysOn: "Immer aktiv",
    analytics: "Analyse", analyticsDesc: "Hilft uns, das Produkt zu verbessern.",
    marketing: "Marketing", marketingDesc: "Misst Kampagnen und Relevanz.",
    acceptAll: "Alle akzeptieren", rejectAll: "Optionale ablehnen", save: "Auswahl speichern", customise: "Anpassen",
  },
};

const fr: LandingStrings = {
  nav: { home: "Accueil", pricing: "Tarifs", legal: "Légal", contact: "Contact", workspace: "Espace de travail", language: "Langue" },
  auth: { signIn: "Se connecter", getStartedFree: "Commencer" },
  menu: { openApp: "Ouvrir l'application", settings: "Paramètres", signOut: "Se déconnecter" },
  signout: {
    title: "Se déconnecter de CFO AI ?",
    body: "Vous serez déconnecté sur cet appareil. Vos espaces de travail, documents et analyses restent exactement là où vous les avez laissés.",
    cancel: "Annuler", confirm: "Se déconnecter",
  },
  hero: {
    eyebrow: "CFO AI · Conçu pour les entreprises privées",
    t1: "Transformez une balance comptable en ", thl: "analyse de niveau CFO", t2: " en 90 secondes.",
    body: "Importez votre comptabilité. CFO AI reconstruit votre compte de résultat, votre bilan, vos flux de trésorerie, plus de 100 ratios, votre valorisation et votre score de crédit — puis vous compare à des sociétés cotées de votre taille, dans votre secteur. Des comparaisons nominatives, pas de vagues moyennes sectorielles.",
    ctaStart: "Commencer", ctaPricing: "Voir les tarifs",
    checks: ["Essai de 30 jours", "Dépôts RAS / UE pris en charge", "Annulable à tout moment"],
    mockNote: "Tableau de bord illustratif. Analyse assistée par IA — les décisions finales restent celles de votre direction.",
  },
  stats: { drift: "Écart de bilan", ratios: "Ratios financiers", peers: "Sociétés cotées comparables", upload: "De l'import au rapport" },
  modules: {
    eyebrow: "Quatre modules phares", t1: "Une seule plateforme. ", thl: "Vos comptes, ou n'importe quelle société cotée.",
    cards: [
      { kicker: "Balance comptable → rapport pour le board", title: "Financial Statement Intelligence", body: "Dépôts au ministère des Finances, exports du comptable, rapports annuels — de n'importe quel pays européen. Détectés automatiquement, normalisés, convertis en ratios, valorisés et expliqués." },
      { kicker: "Tickers BVB → analyse", title: "Public Company Intelligence", body: "Toutes les sociétés cotées à la Bourse de Bucarest — états financiers statutaires issus des dépôts officiels ANAF plus cours BVB en direct. Même tableau de bord, mêmes ratios, même valorisation et même chat CFO que pour vos comptes privés — ajoutez-en comme référence de comparaison." },
      { kicker: "Exports ERP → prévision de trésorerie", title: "Invoice Intelligence", body: "Concentration clients et fournisseurs, marge par client, rapprochement TVA et délais de paiement — présentés dans des onglets dédiés au sein de vos états financiers." },
      { kicker: "Posez des questions → réponses fondées", title: "Ask CFO AI", body: "Un copilote financier ancré dans vos chiffres. Demandez pourquoi la marge a bougé, ce que signifie un ratio ou quoi faire ensuite — avec le raisonnement et les lignes sources affichés." },
    ],
  },
  how: {
    eyebrow: "Comment ça marche", t1: "Trois étapes du tableur au ", thl: "plan d'action.",
    steps: [
      { title: "Importez vos comptes", body: "Balance comptable, bilan ou compte de résultat — Excel, CSV ou PDF. Les colonnes et comptes RAS sont mappés automatiquement." },
      { title: "CFO AI calcule l'économie de l'entreprise", body: "Compte de résultat, bilan, flux de trésorerie, 100+ ratios, variantes d'EBITDA, Altman Z, valorisation et score de crédit — rapprochés de la source avec un écart ≤1 %." },
      { title: "Vous agissez en contexte", body: "Recommandations hiérarchisées et chiffrées, plus des sociétés cotées comparables nommées — export en HTML, modèle Excel de 8 feuilles ou synthèse pour le board." },
    ],
  },
  defensible: {
    eyebrow: "Défendable par conception",
    title: "Des chiffres auxquels un prêteur, un auditeur ou un investisseur peut se fier.",
    body: "Le moteur conforme RAS rapproche les huit cas de calibration avec un écart de bilan ≤1 % — cinq sur huit exactement à 0,00 % — et reproduit l'EBITDA du compte de résultat déposé en trois variantes nommées (publié, strict, cash). Quand un fichier source présente un déséquilibre, CFO AI le signale explicitement au lieu de le lisser.",
    bullets: [
      { strong: "Reproductible.", rest: "La même balance comptable produit toujours le même résultat." },
      { strong: "Traçable.", rest: "Chaque chiffre renvoie à la ligne source dont il provient." },
      { strong: "Honnête sur l'incertitude.", rest: "Les approximations sont signalées, jamais enfouies." },
    ],
    cardLabel: "Benchmark comparable · Marge EBITDA", yourCo: "Votre société",
    cardNote: "Vous vous situez dans le quartile supérieur de votre panel de comparables en rentabilité opérationnelle.",
  },
  audiences: {
    eyebrow: "Pour qui", t1: "Conçu pour tous ceux qui lisent les ", thl: "chiffres.",
    cards: [
      { title: "Fondateurs &amp; dirigeants", body: "Comprenez vos propres finances comme le ferait un analyste — et voyez exactement où vous vous situez face à de vrais comparables." },
      { title: "Équipes finance", body: "Transformez la balance de fin de mois en états financiers pour le board, ratios et score de crédit, sans reconstruire de modèle." },
      { title: "Investisseurs &amp; analystes", body: "Menez la due diligence sur des cibles privées et des comparables cotés via le même moteur, côte à côte." },
      { title: "Conseils &amp; experts-comptables", body: "Livrez des analyses de niveau CFO sur tout un portefeuille de clients — de façon cohérente, en quelques minutes chacune." },
      { title: "Prêteurs", body: "Évaluez le risque de crédit avec Altman Z″, les ratios de couverture et un EBITDA strict prêt pour les covenants — avec le rapprochement source affiché." },
      { title: "Family offices", body: "Passez en revue plusieurs entités de groupe et participations dans un cadre unique et cohérent, y compris la NAV pour les véhicules riches en actifs." },
    ],
  },
  faq: {
    eyebrow: "Questions", title: "Questions fréquentes",
    items: [
      { q: "Quels formats de fichiers puis-je importer ?", a: "Balances comptables, bilans, comptes de résultat et rapports annuels en Excel, CSV ou PDF. Les exports de SAGA, WinMENTOR et des logiciels comptables roumains et européens courants sont pris en charge, avec un mappage automatique des comptes." },
      { q: "Quelle est la précision de l'analyse ?", a: "Sur des balances propres, le moteur rapproche les totaux de bilan avec un écart inférieur à 1 % sur ses huit cas de calibration — cinq sur huit exactement à 0,00 %. Il calcule trois variantes nommées d'EBITDA qui correspondent parfaitement entre la méthodologie et le code. C'est un outil d'aide à la décision, pas un substitut au jugement professionnel." },
      { q: "Mes données financières sont-elles en sécurité ?", a: "Vos données sont stockées sur une infrastructure en région UE avec une sécurité au niveau des lignes, de sorte que seul votre compte peut y accéder. Nous ne vendons jamais vos données. Consultez notre {privacy} pour le détail des sous-traitants et de vos droits RGPD." },
      { q: "Proposez-vous un essai gratuit ?", a: "Oui — chaque offre commence par un essai de 30 jours. Les membres fondateurs ne paient que 1 € le premier mois. Vous pouvez annuler à tout moment avant le renouvellement." },
      { q: "Quels pays et normes comptables sont pris en charge ?", a: "Le moteur est aujourd'hui calibré pour le RAS roumain (OMFP 1802), avec un schéma canonique indépendant du pays, conçu pour s'étendre à d'autres plans comptables européens. L'analyse des sociétés cotées couvre toutes les entreprises cotées à la Bourse de Bucarest, à partir des dépôts statutaires officiels ANAF et des données de marché BVB en direct." },
      { q: "S'agit-il de conseil financier ou en investissement ?", a: "Non. CFO AI produit une analyse assistée par IA et une aide à la décision. Ce n'est pas du conseil financier, en investissement, juridique, fiscal ou comptable, et les décisions finales vous appartiennent, à vous et à votre direction. Consultez nos {terms}." },
    ],
  },
  cta: {
    t1: "Voyez votre entreprise comme la verrait un ", thl: "CFO.",
    body: "Importez votre première balance comptable et obtenez une analyse complète en moins de cinq minutes. Sans carte bancaire.",
    start: "Commencer", signIn: "Se connecter", goWorkspace: "Accéder à l'espace de travail",
  },
  pricing: {
    eyebrow: "Tarifs", t1: "Des offres simples qui ", thl: "grandissent avec vous.",
    subtitle: "Chaque offre commence par un essai de 30 jours. Les membres fondateurs paient 1 € le premier mois. Annulable à tout moment.",
    note: "Tous les prix s'entendent hors TVA le cas échéant. Les documents hors forfait sont facturés à l'unité et toujours confirmés avant traitement.",
    perMonth: "/mois",
    solo: {
      name: "Solo", yearly: "ou 199 € / an — économisez 41 €",
      blurb: "Investisseurs individuels, analystes indépendants et fondateurs menant leur propre due diligence.",
      cta: "Essayer Solo",
      features: ["1 société · 10 imports / mois", "Compte de résultat, bilan &amp; flux de trésorerie", "Ratios essentiels &amp; EBITDA", "Dépistage de faillite Altman Z", "30 messages Ask CFO AI / mois", "Historique de 12 mois · support par e-mail"],
    },
    business: {
      badge: "Le plus populaire", name: "Business", yearly: "ou 590 € / an — économisez 118 €",
      blurb: "Dirigeants de PME, équipes finance internes, holdings immobilières et portefeuilles familiaux.",
      cta: "Essayer Business",
      lead: ["5 sociétés · 2 utilisateurs · 25 imports / mois", "Tout Solo, plus :"],
      features: ["Suite complète de 100+ ratios", "Altman Z + score Piotroski F", "Suite de valorisation &amp; cascade NAV", "Benchmarks sectoriels &amp; comparaison de pairs", "Moteur de recommandations &amp; rapports mensuels", "100 messages IA/mois · liens de partage · chat en direct"],
    },
    pro: {
      name: "Professional", price: "Sur mesure", priceNote: "Contacter les ventes — tarif au contrat",
      blurb: "Cabinets de conseil, experts-comptables, holdings multi-entités et boutiques M&amp;A gérant 5+ sociétés.",
      cta: "Contacter les ventes",
      lead: ["Jusqu'à 25 sociétés · 10 utilisateurs", "Tout Business, plus :"],
      features: ["Vue consolidée multi-entités", "Accès API", "Onboarding dédié", "Support téléphonique prioritaire · SLA 4h"],
    },
  },
  legal: {
    eyebrow: "Légal", title: "Les petites lignes, en pleine lumière.",
    subtitle: "Comment CFO AI traite vos données et les conditions qui régissent le service — le tout sur une seule page.",
    englishNote: "Les documents juridiques ci-dessous sont fournis en anglais.",
    privacy: "Politique de confidentialité", cookies: "Politique de cookies", terms: "Conditions d'utilisation",
  },
  contact: {
    eyebrow: "Contact", title: "Parlons-en.",
    subtitle: "Que vous évaluiez CFO AI pour un portefeuille de sociétés ou que vous ayez simplement une question — nous serions ravis de vous lire.",
    phName: "Votre nom *", phEmail: "E-mail *", phCompany: "Société (facultatif)", phMessage: "Comment pouvons-nous aider ? *",
    invalid: "Veuillez renseigner votre nom, un e-mail valide et un message.",
    error: `Impossible d'envoyer votre message. Réessayez ou écrivez directement à <a href="mailto:support@cfo-ai.io">support@cfo-ai.io</a>.`,
    sending: "Envoi…", send: "Envoyer",
    sentTitle: "Message envoyé.", sentBody: "Merci de nous avoir contactés — nous revenons vers vous sous un jour ouvré.",
    note: "En envoyant, vous acceptez que nous vous répondions par e-mail au sujet de votre demande. Voir notre Politique de confidentialité.",
    sales: { kicker: "Ventes &amp; offre Professional", blurb: "Limites sur mesure, multi-entités et accès API." },
    support: { kicker: "Support", blurb: "Aide sur votre compte, vos imports ou vos analyses." },
    privacy: { kicker: "Confidentialité &amp; données", blurb: "Exercez vos droits RGPD ou posez vos questions sur les données." },
    office: "Siège social",
  },
  footer: {
    blurb: "Analyse financière de niveau CFO et benchmarking pour les entreprises privées.",
    product: "Produit", overview: "Aperçu", how: "Comment ça marche", trust: "Pourquoi s'y fier", audiences: "Pour qui", faq: "FAQ",
    legalCol: "Légal", cookieSettings: "Paramètres des cookies",
    contactCol: "Contact", contactUs: "Nous contacter",
    rights: "© {year} CFO AI · [Company Legal Name]. Tous droits réservés.",
    madeIn: "Conçu dans l'UE · Conforme RGPD",
  },
  consent: {
    title: "Nous respectons votre vie privée",
    body: "Nous utilisons des cookies strictement nécessaires au fonctionnement de CFO AI et — uniquement avec votre consentement — des cookies optionnels d'analyse et de marketing. Vous pouvez tout accepter, refuser les optionnels ou choisir. Lisez notre {cookiePolicy}.",
    necessary: "Strictement nécessaires", necessaryDesc: "Indispensables à la connexion, à la sécurité et à l'enregistrement de votre choix.", alwaysOn: "Toujours actifs",
    analytics: "Analyse", analyticsDesc: "Nous aide à améliorer le produit.",
    marketing: "Marketing", marketingDesc: "Mesure les campagnes et la pertinence.",
    acceptAll: "Tout accepter", rejectAll: "Refuser les optionnels", save: "Enregistrer mes choix", customise: "Personnaliser",
  },
};

const es: LandingStrings = {
  nav: { home: "Inicio", pricing: "Precios", legal: "Legal", contact: "Contacto", workspace: "Espacio de trabajo", language: "Idioma" },
  auth: { signIn: "Iniciar sesión", getStartedFree: "Empieza" },
  menu: { openApp: "Abrir la aplicación", settings: "Ajustes", signOut: "Cerrar sesión" },
  signout: {
    title: "¿Cerrar sesión en CFO AI?",
    body: "Se cerrará tu sesión en este dispositivo. Tus espacios de trabajo, documentos y análisis se quedan exactamente donde los dejaste.",
    cancel: "Cancelar", confirm: "Cerrar sesión",
  },
  hero: {
    eyebrow: "CFO AI · Creado para empresas privadas",
    t1: "Convierte un balance de comprobación en un ", thl: "análisis de nivel CFO", t2: " en 90 segundos.",
    body: "Sube tu contabilidad. CFO AI reconstruye tu cuenta de resultados, balance, flujo de caja, más de 100 ratios, valoración y puntuación crediticia — y te compara con empresas cotizadas de tu tamaño y de tu sector. Comparaciones con nombre propio, no vagas medias sectoriales.",
    ctaStart: "Empezar", ctaPricing: "Ver precios",
    checks: ["Prueba de 30 días", "Soporte para estados RAS / UE", "Cancela cuando quieras"],
    mockNote: "Panel ilustrativo. Análisis asistido por IA — las decisiones finales corresponden a tu equipo directivo.",
  },
  stats: { drift: "Desviación de balance", ratios: "Ratios financieros", peers: "Comparables cotizadas", upload: "De la carga al informe" },
  modules: {
    eyebrow: "Cuatro módulos insignia", t1: "Una sola plataforma. ", thl: "Tus cuentas o cualquier empresa cotizada.",
    cards: [
      { kicker: "Balance de comprobación → informe para el consejo", title: "Financial Statement Intelligence", body: "Presentaciones al Ministerio de Hacienda, exportaciones del contable, informes anuales — de cualquier país europeo. Detectados automáticamente, normalizados, convertidos en ratios, valorados y explicados." },
      { kicker: "Tickers de BVB → análisis", title: "Public Company Intelligence", body: "Todas las empresas cotizadas en la Bolsa de Bucarest — estados financieros estatutarios de las presentaciones oficiales ANAF más cotizaciones BVB en directo. El mismo panel, ratios, valoración y chat CFO que para tus cuentas privadas — añade cualquiera como comparable de referencia." },
      { kicker: "Exportaciones ERP → previsión de caja", title: "Invoice Intelligence", body: "Concentración de clientes y proveedores, margen por cliente, conciliación de IVA y plazos de pago — en pestañas dedicadas dentro de tus estados financieros." },
      { kicker: "Haz preguntas → respuestas fundamentadas", title: "Ask CFO AI", body: "Un copiloto financiero anclado en tus números. Pregunta por qué se movió el margen, qué significa un ratio o qué hacer a continuación — con el razonamiento y las líneas fuente a la vista." },
    ],
  },
  how: {
    eyebrow: "Cómo funciona", t1: "Tres pasos de la hoja de cálculo al ", thl: "plan de acción.",
    steps: [
      { title: "Sube tus cuentas", body: "Balance de comprobación, balance o cuenta de resultados — Excel, CSV o PDF. Las columnas y cuentas RAS se mapean automáticamente." },
      { title: "CFO AI calcula la economía del negocio", body: "Cuenta de resultados, balance, flujo de caja, 100+ ratios, variantes de EBITDA, Altman Z, valoración y puntuación crediticia — conciliados con la fuente hasta una desviación ≤1 %." },
      { title: "Tú actúas con contexto", body: "Recomendaciones priorizadas y cuantificadas, más comparables cotizadas con nombre propio — exporta a HTML, un modelo Excel de 8 hojas o un resumen para el consejo." },
    ],
  },
  defensible: {
    eyebrow: "Defendible por diseño",
    title: "Cifras en las que un prestamista, auditor o inversor puede confiar.",
    body: "El motor conforme a RAS concilia los ocho casos de calibración con una desviación de balance ≤1 % — cinco de ocho exactamente al 0,00 % — y reproduce el EBITDA de la cuenta de resultados presentada en tres variantes con nombre (reportado, estricto, caja). Cuando un archivo fuente presenta un descuadre, CFO AI lo señala explícitamente en lugar de suavizarlo.",
    bullets: [
      { strong: "Reproducible.", rest: "El mismo balance de comprobación produce siempre el mismo resultado." },
      { strong: "Trazable.", rest: "Cada cifra enlaza con la línea fuente de la que procede." },
      { strong: "Honesto con la incertidumbre.", rest: "Las aproximaciones se marcan, nunca se ocultan." },
    ],
    cardLabel: "Benchmark de comparables · Margen EBITDA", yourCo: "Tu empresa",
    cardNote: "Te sitúas en el cuartil superior de tu grupo de comparables en rentabilidad operativa.",
  },
  audiences: {
    eyebrow: "Para quién es", t1: "Creado para quien lee los ", thl: "números.",
    cards: [
      { title: "Fundadores &amp; propietarios", body: "Entiende tus propias finanzas como lo haría un analista — y ve exactamente dónde estás frente a comparables reales." },
      { title: "Equipos financieros", body: "Convierte el balance de cierre de mes en estados para el consejo, ratios y una puntuación crediticia sin reconstruir un modelo." },
      { title: "Inversores &amp; analistas", body: "Haz due diligence de objetivos privados y comparables cotizados con el mismo motor, lado a lado." },
      { title: "Asesores &amp; contables", body: "Entrega análisis de nivel CFO para toda una cartera de clientes — de forma consistente, en minutos cada uno." },
      { title: "Prestamistas", body: "Evalúa el crédito con Altman Z″, ratios de cobertura y EBITDA estricto listo para covenants — con la conciliación de la fuente a la vista." },
      { title: "Family offices", body: "Revisa varias entidades del grupo y participaciones con un marco único y coherente, incluida la NAV para vehículos intensivos en activos." },
    ],
  },
  faq: {
    eyebrow: "Preguntas", title: "Preguntas frecuentes",
    items: [
      { q: "¿Qué formatos de archivo puedo subir?", a: "Balances de comprobación, balances, cuentas de resultados e informes anuales en Excel, CSV o PDF. Se admiten exportaciones de SAGA, WinMENTOR y del software contable estándar rumano y europeo, con mapeo automático de cuentas." },
      { q: "¿Qué precisión tiene el análisis?", a: "Con balances limpios, el motor concilia los totales del balance con una desviación inferior al 1 % en sus ocho casos de calibración — cinco de ocho exactamente al 0,00 %. Calcula tres variantes de EBITDA con nombre que coinciden al detalle entre la metodología y el código. Es una herramienta de apoyo a la decisión, no un sustituto del juicio profesional." },
      { q: "¿Están seguros mis datos financieros?", a: "Tus datos se almacenan en infraestructura de la región UE con seguridad a nivel de fila, de modo que solo tu cuenta puede acceder a ellos. Nunca vendemos tus datos. Consulta nuestra {privacy} para el detalle de subencargados y tus derechos según el RGPD." },
      { q: "¿Ofrecéis una prueba gratuita?", a: "Sí — cada plan empieza con una prueba de 30 días. Los miembros fundadores pagan solo 1 € el primer mes. Puedes cancelar en cualquier momento antes de la renovación." },
      { q: "¿Qué países y normas contables se admiten?", a: "El motor está calibrado hoy para el RAS rumano (OMFP 1802), con un esquema canónico independiente del país, diseñado para extenderse a otros planes contables europeos. El análisis de cotizadas cubre todas las empresas cotizadas en la Bolsa de Bucarest, a partir de las presentaciones estatutarias oficiales de ANAF y datos de mercado BVB en directo." },
      { q: "¿Es esto asesoramiento financiero o de inversión?", a: "No. CFO AI produce análisis asistido por IA y apoyo a la decisión. No es asesoramiento financiero, de inversión, jurídico, fiscal ni contable, y las decisiones finales os corresponden a ti y a tu equipo directivo. Consulta nuestros {terms}." },
    ],
  },
  cta: {
    t1: "Ve tu negocio como lo vería un ", thl: "CFO.",
    body: "Sube tu primer balance de comprobación y obtén un análisis completo en menos de cinco minutos. Sin tarjeta de crédito.",
    start: "Empezar", signIn: "Iniciar sesión", goWorkspace: "Ir al espacio de trabajo",
  },
  pricing: {
    eyebrow: "Precios", t1: "Planes sencillos que ", thl: "crecen contigo.",
    subtitle: "Cada plan empieza con una prueba de 30 días. Los miembros fundadores pagan 1 € el primer mes. Cancela cuando quieras.",
    note: "Todos los precios excluyen IVA cuando aplique. Los documentos fuera de plan se facturan por documento y siempre se confirman antes de procesarse.",
    perMonth: "/mes",
    solo: {
      name: "Solo", yearly: "o 199 € / año — ahorra 41 €",
      blurb: "Inversores individuales, analistas freelance y fundadores haciendo su propia due diligence.",
      cta: "Probar Solo",
      features: ["1 empresa · 10 cargas / mes", "Cuenta de resultados, balance &amp; flujo de caja", "Ratios esenciales &amp; EBITDA", "Cribado de quiebra Altman Z", "30 mensajes de Ask CFO AI / mes", "Historial de 12 meses · soporte por correo"],
    },
    business: {
      badge: "El más popular", name: "Business", yearly: "o 590 € / año — ahorra 118 €",
      blurb: "Dueños de pymes, equipos financieros internos, holdings inmobiliarios y carteras de grupos familiares.",
      cta: "Probar Business",
      lead: ["5 empresas · 2 usuarios · 25 cargas / mes", "Todo lo de Solo, más:"],
      features: ["Suite completa de 100+ ratios", "Altman Z + puntuación Piotroski F", "Suite de valoración &amp; cascada NAV", "Benchmarks sectoriales &amp; comparación de pares", "Motor de recomendaciones &amp; informes mensuales", "100 mensajes de IA/mes · enlaces compartibles · chat en vivo"],
    },
    pro: {
      name: "Professional", price: "A medida", priceNote: "Contactar con ventas — precio por contrato",
      blurb: "Consultoras, contables, holdings multientidad y boutiques de M&amp;A que gestionan 5+ empresas.",
      cta: "Contactar con ventas",
      lead: ["Hasta 25 empresas · 10 usuarios", "Todo lo de Business, más:"],
      features: ["Vista consolidada multientidad", "Acceso a la API", "Onboarding dedicado", "Soporte telefónico prioritario · SLA de 4h"],
    },
  },
  legal: {
    eyebrow: "Legal", title: "La letra pequeña, a la vista.",
    subtitle: "Cómo trata CFO AI tus datos y los términos que rigen el servicio — todo en una sola página.",
    englishNote: "Los documentos legales siguientes se facilitan en inglés.",
    privacy: "Política de privacidad", cookies: "Política de cookies", terms: "Términos del servicio",
  },
  contact: {
    eyebrow: "Contacto", title: "Hablemos.",
    subtitle: "Tanto si evalúas CFO AI para una cartera de empresas como si solo tienes una pregunta — nos encantará leerte.",
    phName: "Tu nombre *", phEmail: "Correo electrónico *", phCompany: "Empresa (opcional)", phMessage: "¿En qué podemos ayudarte? *",
    invalid: "Por favor, indica tu nombre, un correo válido y un mensaje.",
    error: `No se pudo enviar tu mensaje. Inténtalo de nuevo o escribe directamente a <a href="mailto:support@cfo-ai.io">support@cfo-ai.io</a>.`,
    sending: "Enviando…", send: "Enviar",
    sentTitle: "Mensaje enviado.", sentBody: "Gracias por escribirnos — te responderemos en un día laborable.",
    note: "Al enviar, aceptas que te respondamos por correo sobre tu solicitud. Consulta nuestra Política de privacidad.",
    sales: { kicker: "Ventas &amp; plan Professional", blurb: "Límites a medida, multientidad y acceso a la API." },
    support: { kicker: "Soporte", blurb: "Ayuda con tu cuenta, tus cargas o tus análisis." },
    privacy: { kicker: "Privacidad &amp; datos", blurb: "Ejerce tus derechos RGPD o pregunta sobre los datos." },
    office: "Domicilio social",
  },
  footer: {
    blurb: "Análisis financiero de nivel CFO y benchmarking para empresas privadas.",
    product: "Producto", overview: "Visión general", how: "Cómo funciona", trust: "Por qué fiarse", audiences: "Para quién es", faq: "Preguntas frecuentes",
    legalCol: "Legal", cookieSettings: "Ajustes de cookies",
    contactCol: "Contacto", contactUs: "Contáctanos",
    rights: "© {year} CFO AI · [Company Legal Name]. Todos los derechos reservados.",
    madeIn: "Hecho en la UE · Conforme al RGPD",
  },
  consent: {
    title: "Valoramos tu privacidad",
    body: "Usamos cookies estrictamente necesarias para el funcionamiento de CFO AI y — solo con tu consentimiento — cookies opcionales de analítica y marketing. Puedes aceptarlas todas, rechazar las opcionales o elegir. Lee nuestra {cookiePolicy}.",
    necessary: "Estrictamente necesarias", necessaryDesc: "Imprescindibles para el inicio de sesión, la seguridad y guardar tu elección.", alwaysOn: "Siempre activas",
    analytics: "Analítica", analyticsDesc: "Nos ayuda a mejorar el producto.",
    marketing: "Marketing", marketingDesc: "Mide las campañas y su relevancia.",
    acceptAll: "Aceptar todas", rejectAll: "Rechazar opcionales", save: "Guardar elección", customise: "Personalizar",
  },
};

export const LANDING_STRINGS: Record<string, LandingStrings> = { en, ro, de, fr, es };

export function landingStringsFor(langCode: string): LandingStrings {
  return LANDING_STRINGS[langCode] ?? en;
}
