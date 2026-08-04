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
    ctaStart: string; ctaSignIn: string;
    checks: string[];
    mockNote: string;
    /** Title line of the fake browser chrome on the hero mock. */
    mockTitle: string;
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
    ctaStart: "Get started", ctaSignIn: "Sign in",
    checks: ["30-day trial", "RAS / EU filings supported", "Cancel anytime"],
    mockNote: "Illustrative dashboard. AI-assisted analysis — final decisions remain with your management team.",
    mockTitle: "cfo-ai · today's briefing · 06:14",
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
    ctaStart: "Începe", ctaSignIn: "Autentificare",
    checks: ["Probă de 30 de zile", "Suport RAS / raportări UE", "Anulezi oricând"],
    mockNote: "Dashboard ilustrativ. Analiză asistată de AI — deciziile finale rămân la echipa ta de management.",
    mockTitle: "cfo-ai · briefingul de azi · 06:14",
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

export const LANDING_STRINGS: Record<string, LandingStrings> = { en, ro };

export function landingStringsFor(langCode: string): LandingStrings {
  return LANDING_STRINGS[langCode] ?? en;
}
