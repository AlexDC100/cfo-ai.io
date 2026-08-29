// Plain-language layer — the dictionary IS data (Prompt 12, Part B).
//
// Every financial term the UI renders can carry a 1–2 sentence plain
// explanation and a dual label: Simple mode leads with the plain name
// ("Profit before financing & depreciation (EBITDA)"), Pro leads with
// the term ("EBITDA") and keeps the explanation one tap away.
//
// NO MODEL CALL AT RUNTIME — this is reviewed copy, EN + RO, shipped
// with the bundle. Gate M2 fails CI when a <Term> id lacks either
// language or a Simple label. RO register is informal tu-form, matching
// the app's ro.json.

export interface GlossaryEntry {
  /** Pro-mode label — the term itself. */
  term: { en: string; ro: string };
  /** Simple-mode label — plain words first, term in parentheses. */
  simple: { en: string; ro: string };
  /** 1–2 sentences, plain language. No nested jargon. */
  plain: { en: string; ro: string };
}

export const GLOSSARY: Record<string, GlossaryEntry> = {
  ebitda: {
    term: { en: "EBITDA", ro: "EBITDA" },
    simple: {
      en: "Profit before financing & depreciation (EBITDA)",
      ro: "Profit înainte de finanțare și amortizare (EBITDA)",
    },
    plain: {
      en: "What the business earns from its day-to-day work, before loan costs, taxes and the accounting wear-and-tear on equipment. A rough proxy for the cash the operations generate.",
      ro: "Ce câștigă afacerea din activitatea de zi cu zi, înainte de costul creditelor, impozite și uzura contabilă a echipamentelor. O aproximare a numerarului generat de operațiuni.",
    },
  },
  net_debt: {
    term: { en: "Net debt", ro: "Datorie netă" },
    simple: { en: "What you'd still owe (net debt)", ro: "Cât ai mai datora (datorie netă)" },
    plain: {
      en: "All borrowings minus the cash you hold. It's what would remain to repay if you used every leu in the bank today.",
      ro: "Toate împrumuturile minus numerarul disponibil. Cât ar rămâne de plătit dacă ai folosi azi toți banii din bancă.",
    },
  },
  working_capital: {
    term: { en: "Working capital", ro: "Capital de lucru" },
    simple: { en: "Money tied up in running the business (working capital)", ro: "Bani blocați în funcționarea afacerii (capital de lucru)" },
    plain: {
      en: "The money locked in day-to-day operations: stock on shelves and unpaid customer invoices, minus what you owe suppliers. More tied up means less cash free.",
      ro: "Banii blocați în operațiunile curente: stocuri și facturi neîncasate de la clienți, minus ce datorezi furnizorilor. Cu cât e mai mult blocat, cu atât ai mai puțin numerar liber.",
    },
  },
  dso: {
    term: { en: "DSO", ro: "DSO" },
    simple: { en: "Days until customers pay (DSO)", ro: "Zile până încasezi de la clienți (DSO)" },
    plain: {
      en: "How many days, on average, customers take to pay you. Lower is better — your money comes back sooner.",
      ro: "Câte zile durează, în medie, până când clienții te plătesc. Mai puțin e mai bine — banii se întorc mai repede.",
    },
  },
  covenant: {
    term: { en: "Covenant", ro: "Covenant" },
    simple: { en: "Bank loan condition (covenant)", ro: "Condiție din contractul de credit (covenant)" },
    plain: {
      en: "A promise in a loan contract — for example, keeping debt below a set multiple of earnings. Breaking one can let the bank demand repayment or renegotiate terms.",
      ro: "O promisiune din contractul de credit — de exemplu, să ții datoria sub un anumit multiplu al profitului. Încălcarea ei poate permite băncii să ceară rambursarea sau să renegocieze condițiile.",
    },
  },
  leverage: {
    term: { en: "Leverage", ro: "Grad de îndatorare" },
    simple: { en: "How much you rely on debt (leverage)", ro: "Cât te bazezi pe datorii (grad de îndatorare)" },
    plain: {
      en: "How much of the business is financed with borrowed money versus its own earnings. Higher leverage amplifies both good and bad years.",
      ro: "Cât din afacere e finanțat din bani împrumutați față de câștigurile proprii. O îndatorare mare amplifică și anii buni, și pe cei slabi.",
    },
  },
  margin: {
    term: { en: "Margin", ro: "Marjă" },
    simple: { en: "What's left from each leu of sales (margin)", ro: "Ce rămâne din fiecare leu vândut (marjă)" },
    plain: {
      en: "Out of every 100 lei you invoice, how many stay as profit after costs. A 10% margin means 10 lei kept per 100 invoiced.",
      ro: "Din fiecare 100 de lei facturați, câți rămân profit după costuri. O marjă de 10% înseamnă 10 lei păstrați la fiecare 100 facturați.",
    },
  },
  liquidity: {
    term: { en: "Liquidity", ro: "Lichiditate" },
    simple: { en: "Ability to pay near-term bills (liquidity)", ro: "Capacitatea de a plăti facturile apropiate (lichiditate)" },
    plain: {
      en: "Whether you can cover the bills due soon with the cash and near-cash you have. Tight liquidity means normal payments start depending on new money arriving in time.",
      ro: "Dacă poți acoperi facturile scadente curând din numerarul și activele ușor de transformat în bani. O lichiditate strânsă înseamnă că plățile obișnuite depind de încasări venite la timp.",
    },
  },
  dscr: {
    term: { en: "DSCR", ro: "DSCR" },
    simple: { en: "Earnings vs loan payments (DSCR)", ro: "Câștiguri față de ratele la credite (DSCR)" },
    plain: {
      en: "How many times your earnings cover the year's loan payments (interest plus principal). Below 1× means the business alone doesn't cover its debt service.",
      ro: "De câte ori câștigurile acoperă ratele anuale la credite (dobândă plus principal). Sub 1× înseamnă că afacerea singură nu-și acoperă serviciul datoriei.",
    },
  },
  current_ratio: {
    term: { en: "Current ratio", ro: "Lichiditate curentă" },
    simple: { en: "Near-term assets vs near-term bills (current ratio)", ro: "Active pe termen scurt față de datorii pe termen scurt (lichiditate curentă)" },
    plain: {
      en: "Everything you could turn into cash within a year, divided by everything due within a year. Above 1× means the near-term position is covered on paper.",
      ro: "Tot ce ai putea transforma în bani într-un an, împărțit la tot ce ai de plătit într-un an. Peste 1× înseamnă că poziția pe termen scurt e acoperită pe hârtie.",
    },
  },
  equity: {
    term: { en: "Equity", ro: "Capitaluri proprii" },
    simple: { en: "The owners' share of the business (equity)", ro: "Partea proprietarilor din afacere (capitaluri proprii)" },
    plain: {
      en: "What would belong to the owners if every asset were sold and every debt repaid. It grows with retained profit and shrinks with losses or dividends.",
      ro: "Ce ar rămâne proprietarilor dacă toate activele s-ar vinde și toate datoriile s-ar plăti. Crește cu profitul reținut și scade cu pierderile sau dividendele.",
    },
  },
  cash_flow: {
    term: { en: "Cash flow", ro: "Flux de numerar" },
    simple: { en: "Money actually moving in and out (cash flow)", ro: "Banii care chiar intră și ies (flux de numerar)" },
    plain: {
      en: "The money that actually entered and left your accounts — as opposed to profit, which counts invoices even before they're paid.",
      ro: "Banii care chiar au intrat și au ieșit din conturi — spre deosebire de profit, care numără facturile chiar înainte să fie plătite.",
    },
  },
  depreciation: {
    term: { en: "Depreciation", ro: "Amortizare" },
    simple: { en: "Accounting wear-and-tear (depreciation)", ro: "Uzura contabilă (amortizare)" },
    plain: {
      en: "Spreading the cost of equipment or buildings over the years they're used, instead of all at once. It reduces profit but takes no cash out of the bank.",
      ro: "Împărțirea costului echipamentelor sau clădirilor pe anii în care sunt folosite, nu dintr-o dată. Reduce profitul, dar nu scoate bani din bancă.",
    },
  },
  receivables: {
    term: { en: "Receivables", ro: "Creanțe" },
    simple: { en: "Invoices customers haven't paid yet (receivables)", ro: "Facturi neîncasate de la clienți (creanțe)" },
    plain: {
      en: "Money customers owe you for work already invoiced. It's yours on paper, but you can't spend it until it's collected.",
      ro: "Bani pe care clienții ți-i datorează pentru facturi deja emise. Sunt ai tăi pe hârtie, dar nu-i poți cheltui până nu-i încasezi.",
    },
  },
  payables: {
    term: { en: "Payables", ro: "Datorii către furnizori" },
    simple: { en: "Bills you haven't paid yet (payables)", ro: "Facturi neplătite încă (datorii către furnizori)" },
    plain: {
      en: "What you owe suppliers for goods and services already received. Paying later keeps cash in hand — within the agreed terms.",
      ro: "Ce datorezi furnizorilor pentru bunuri și servicii deja primite. Plata mai târzie păstrează numerarul — în limita termenelor agreate.",
    },
  },
  inventory: {
    term: { en: "Inventory", ro: "Stocuri" },
    simple: { en: "Goods waiting to be sold (inventory)", ro: "Marfă care așteaptă să fie vândută (stocuri)" },
    plain: {
      en: "Raw materials, work in progress and finished goods you hold. It's money on shelves — valuable, but not spendable until sold.",
      ro: "Materii prime, producție în curs și marfă finită. Sunt bani pe raft — valoroși, dar necheltuibili până la vânzare.",
    },
  },
  gross_margin: {
    term: { en: "Gross margin", ro: "Marjă brută" },
    simple: { en: "Sales minus direct costs (gross margin)", ro: "Vânzări minus costuri directe (marjă brută)" },
    plain: {
      en: "What's left from sales after the direct cost of what you sold — before rent, salaries and overheads. It shows whether the product itself makes money.",
      ro: "Ce rămâne din vânzări după costul direct al mărfii vândute — înainte de chirie, salarii și cheltuieli generale. Arată dacă produsul în sine aduce bani.",
    },
  },
  net_margin: {
    term: { en: "Net margin", ro: "Marjă netă" },
    simple: { en: "Final profit per leu of sales (net margin)", ro: "Profitul final la fiecare leu vândut (marjă netă)" },
    plain: {
      en: "Out of every 100 lei invoiced, what stays as profit after ALL costs, including taxes and interest. The bottom line as a percentage.",
      ro: "Din fiecare 100 de lei facturați, ce rămâne profit după TOATE costurile, inclusiv impozite și dobânzi. Linia de jos, ca procent.",
    },
  },
  credit_class: {
    term: { en: "Credit class", ro: "Clasă de credit" },
    simple: { en: "How lenders would grade you (credit class)", ro: "Cum te-ar nota creditorii (clasă de credit)" },
    plain: {
      en: "A letter grade summarising how safely the business could carry debt, the way a bank would size you up. A is strong; C means lenders would see real risk.",
      ro: "O notă-literă care rezumă cât de sigur poate duce afacerea datorii, așa cum te-ar evalua o bancă. A e solid; C înseamnă risc real în ochii creditorilor.",
    },
  },
  valuation: {
    term: { en: "Valuation", ro: "Evaluare" },
    simple: { en: "What the business might be worth (valuation)", ro: "Cât ar putea valora afacerea (evaluare)" },
    plain: {
      en: "An estimate of the company's worth, usually a multiple of its earnings compared with similar businesses. A range, not a promise.",
      ro: "O estimare a valorii companiei, de regulă un multiplu al câștigurilor, comparat cu afaceri similare. Un interval, nu o promisiune.",
    },
  },
  revenue: {
    term: { en: "Revenue", ro: "Cifră de afaceri" },
    simple: { en: "Total sales (revenue)", ro: "Vânzări totale (cifră de afaceri)" },
    plain: {
      en: "Everything you invoiced in the period, before any costs. The top line.",
      ro: "Tot ce ai facturat în perioadă, înainte de orice costuri. Linia de sus.",
    },
  },
  net_profit: {
    term: { en: "Net profit", ro: "Profit net" },
    simple: { en: "What's truly left (net profit)", ro: "Ce rămâne cu adevărat (profit net)" },
    plain: {
      en: "The money left after every cost, tax and interest payment. The figure that builds equity or pays dividends.",
      ro: "Banii rămași după toate costurile, impozitele și dobânzile. Cifra care crește capitalurile proprii sau plătește dividende.",
    },
  },
};

export type GlossaryId = keyof typeof GLOSSARY;

/** Simple-mode leading label; Pro-mode leading label. */
export function labelFor(id: string, mode: "simple" | "pro", lang: string): string {
  const e = GLOSSARY[id];
  if (!e) return id;
  const l = lang.startsWith("ro") ? "ro" : "en";
  return mode === "simple" ? e.simple[l] : e.term[l];
}

export function plainFor(id: string, lang: string): string | null {
  const e = GLOSSARY[id];
  if (!e) return null;
  return lang.startsWith("ro") ? e.plain.ro : e.plain.en;
}
