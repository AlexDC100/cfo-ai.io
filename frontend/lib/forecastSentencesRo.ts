// THE ENGINE'S SENTENCES THAT CARRY FIGURES, in Romanian
// (forecast-scenarios-live, RO + EN).
//
// The forecast engine explains every driver, refusal and convention in an
// English sentence it composes from the book's own figures ("days sales
// outstanding = 37.56333 days = trade receivables net 42,578,040.60 /
// revenue ..."). On a Romanian page those sentences were printed in English.
// This module re-says them in Romanian — and nothing else.
//
// HOW IT STAYS HONEST
//   · Every rule is one of the engine's own sentence templates, anchored at
//     both ends (^…$). A sentence no rule matches in full is NOT translated:
//     the caller prints the engine's English words, unchanged.
//   · THE DIGIT LAW. The Romanian text of a rule carries no digit of its own:
//     every digit in the output is one the engine served, in the order-free
//     multiset of digit runs the English sentence carries. A figure is
//     re-written in the Romanian convention (413,727,560.16 -> 413.727.560,16:
//     the two separators swap, the digits do not move) and years, dates, CAEN
//     codes and account numbers are copied as served. `translateServedRo`
//     checks the law on EVERY call and refuses (returns null, so the English
//     is printed) when a rendering breaks it — a rule can mistranslate words,
//     never a number. Nothing here reads, computes, rounds or formats a value.
//   · The committed inventory of every sentence the engine serves on the four
//     corpus books (tests/engine/fixtures/forecast/served_sentences.json,
//     pinned to the real route by tests/engine/test_forecast_served_sentences.py)
//     is translated in full by frontend/lib/__tests__/forecastSentencesRo.test.ts:
//     an engine that rewords a sentence reds there first.
//
// Pool names, driver names and size bands come from the locale bundle
// (forecast.pool.*, forecast.driver.*, forecast.growth.band.*), so the
// names a sentence uses are the names the page's own tables use.

import type { TFunction } from "i18next";

/** A figure as the engine prints it: optional sign, digits with thousands
 *  commas, optional decimals. */
const N = "-?\\d[\\d,]*(?:\\.\\d+)?";
const DATE = "\\d{4}-\\d{2}-\\d{2}";
const PERIOD = "FY\\d{4}|\\d{4}-\\d{2}";
const POOL =
  "cost_of_sales|personnel|energy_utilities|rent_insurance|transport_logistics|third_party_services|other_operating|materials_non_inventory|unallocated_operating";

/** The digit runs of a text, order-free. The law compares these. */
export function digitRuns(text: string): string[] {
  return (text.match(/\d+/g) ?? []).slice().sort();
}

/** An engine figure in the Romanian convention: the thousands and decimal
 *  separators swap places. Digits and sign are untouched. */
function roNumber(value: string): string {
  return value.replace(/[,.]/g, (c) => (c === "," ? "." : ","));
}

interface Ctx {
  readonly t: TFunction;
  /** a served figure, Romanian separators */
  n(value: string): string;
  /** a cost pool's Romanian name */
  pool(key: string): string;
  /** a driver's Romanian name, from its served id or its served label */
  driver(idOrLabel: string): string;
  /** a size band, as the growth card names it */
  band(key: string): string;
  /** a served source line (inflation anchor, sector dataset) */
  source(text: string): string;
  /** an embedded engine sentence; throws when it does not translate */
  sub(text: string): string;
}

class NoRule extends Error {}

type Rule = { readonly id: string; readonly re: RegExp; readonly ro: (m: string[], c: Ctx) => string };

function rule(id: string, pattern: string, ro: (m: string[], c: Ctx) => string): Rule {
  return { id, re: new RegExp(`^${pattern}$`), ro };
}

/** Fixed sentences (no figure in them). */
const FIXED: Record<string, string> = {
  // conventions
  "days in a year for every rate-to-period conversion":
    "zilele unui an, pentru fiecare conversie a unei rate la o perioadă",
  "a scheduled draw lands in the first period of its plan year and a scheduled repayment in the last, so a year of interest is charged on what was drawn and none is saved on what is repaid":
    "o tragere programată cade în prima perioadă a anului ei de plan, iar o rambursare programată în ultima, așa că pe ce s-a tras se plătește un an întreg de dobândă și pe ce se rambursează nu se economisește nimic",
  "balance-sheet lines this model does not drive are HELD at their opening balance: they neither grow with the business nor decay. Nothing in a single trial balance implies a rate at which they move, and inventing one would move a total no assumption stated.":
    "liniile de bilanț pe care acest model nu le conduce sunt MENȚINUTE la soldul de deschidere: nici nu cresc odată cu afacerea, nici nu scad. Nimic dintr-o singură balanță nu arată ritmul în care s-ar mișca, iar a inventa unul ar mișca un total fără nicio ipoteză declarată.",
  "interest is charged and paid in the period it accrues, on the balance at the START of that period — which is what lets the funding line be sized in one pass instead of by an iterative solve whose convergence tolerance would leave a residual in a balance sheet required to close exactly.":
    "dobânda se calculează și se plătește în perioada în care se acumulează, pe soldul de la ÎNCEPUTUL acelei perioade — de aceea linia de finanțare poate fi dimensionată dintr-o singură trecere, nu printr-un calcul iterativ a cărui toleranță de convergență ar lăsa un rest într-un bilanț care trebuie să se închidă exact.",
  "income tax accrues on the year-to-date pre-tax result of each plan year: a period is charged the tax on the result so far this year less the tax already charged earlier in the same year, so a loss period reverses tax charged before it and the year as a whole is charged the tax on the year's own result. Tax is settled in cash in the period it accrues; the tax payable balance is held at its opening amount, so the plan shows no tax-timing benefit.":
    "impozitul pe profit se calculează pe rezultatul înainte de impozitare cumulat de la începutul fiecărui an de plan: o perioadă primește impozitul pe rezultatul de până atunci din acel an, minus impozitul deja înregistrat mai devreme în același an, așa că o perioadă cu pierdere inversează impozitul de dinainte, iar anul întreg este impozitat pe propriul rezultat. Impozitul se plătește în perioada în care se înregistrează; soldul impozitului de plată rămâne la valoarea de deschidere, așa că planul nu arată niciun avantaj din decalajul plății.",
  "a loss is not carried across plan years: a plan year whose pre-tax result is negative is charged no tax and shields no later year's profit. This is a model convention held until a sourced carry-forward rule is packed, not a statement of Romanian law.":
    "o pierdere nu se reportează între anii de plan: un an cu rezultat înainte de impozitare negativ nu plătește impozit și nu protejează profitul niciunui an următor. Este o convenție a modelului, păstrată până când o regulă de reportare cu sursă este încărcată, nu o afirmație despre legea română.",
  "a working-capital balance leaves the level the base plan gives it one day of flow per elapsed day, over its own days on hand, so a change in sales or terms reaches cash across that window and never in one month. Annual periods land on the new level":
    "un sold de capital de lucru pleacă de la nivelul pe care i-l dă planul de bază cu o zi de flux pentru fiecare zi scursă, pe durata propriilor zile de rotație, așa că o schimbare a vânzărilor sau a termenelor ajunge în numerar pe toată acea fereastră și niciodată într-o singură lună. Perioadele anuale ajung direct la noul nivel",
  // driver bases and inert sentences
  "no index move is assumed, so the anchor level holds":
    "nu se presupune nicio mișcare a indicelui, așa că nivelul de pornire se menține",
  "no declared distribution, so none is projected":
    "nu este declarată nicio distribuire de dividende, așa că nu se proiectează niciuna",
  "distributions are not measurable from closing balances":
    "distribuirile de dividende nu se pot măsura din soldurile de închidere",
  "the cash floor below which the funding line draws; nil means the plan may run the account down to nothing but never below it":
    "pragul de numerar sub care se trage pe linia de finanțare; zero înseamnă că planul poate consuma contul până la zero, dar niciodată sub",
  "no capitalised-intangible programme is observable in a trial balance":
    "într-o balanță nu se vede niciun program de imobilizări necorporale capitalizate",
  "this plan carries no debt balance, so the debt rate charges nothing":
    "acest plan nu are sold de datorii, așa că rata datoriilor nu generează nicio dobândă",
  "no funding draw in this plan, so the revolver rate charges nothing":
    "planul nu trage pe linia de finanțare, așa că rata ei nu generează nicio dobândă",
  "this book shows no positive pre-tax result to imply an effective rate":
    "această balanță nu arată un rezultat pozitiv înainte de impozitare din care să reiasă o cotă efectivă",
  "the pool is a net credit": "grupul are sold net creditor",
  "nil pool": "grupul este zero",
  // fallback steps
  "no sector source loaded": "nu este încărcată nicio sursă sectorială",
  "prior periods are not read in this build": "perioadele anterioare nu sunt citite în această versiune",
  "no comparable prior year of this book is loaded in this workspace":
    "niciun an anterior comparabil al acestei balanțe nu este încărcat în acest spațiu de lucru",
  "this workspace carries no CAEN code, so no sector can be looked up":
    "acest spațiu de lucru nu are cod CAEN, așa că niciun sector nu poate fi căutat",
  "this book reports no positive turnover, so no size band can be chosen":
    "această balanță nu raportează o cifră de afaceri pozitivă, așa că nu se poate alege nicio clasă de mărime",
  "this company's CAEN class and division are not in the sourced sector dataset":
    "clasa și diviziunea CAEN ale companiei nu se află în setul de date sectoriale cu sursă",
  "the sector cell holds too few filers to publish a median growth":
    "celula sectorului are prea puține firme raportoare ca să publice o creștere mediană",
  "the sector median stands on fewer filers than this lane's floor":
    "mediana sectorului se sprijină pe mai puține firme raportoare decât pragul acestei prognoze",
  "the sourced sector dataset publishes no turnover growth for this cell":
    "setul de date sectoriale cu sursă nu publică o creștere a cifrei de afaceri pentru această celulă",
  // runway and refusals
  "this plan year is served only up to the period the funding line could not be priced in, so its total is not served":
    "acest an de plan este servit doar până la perioada în care linia de finanțare nu a putut fi prețuită, așa că totalul lui nu este servit",
  // history
  "the period end is not a date this reader can parse":
    "sfârșitul perioadei nu este o dată pe care acest cititor o poate interpreta",
  "this period is not readable in this workspace": "această perioadă nu poate fi citită în acest spațiu de lucru",
  "a nearer comparable period is held": "este încărcată o perioadă comparabilă mai apropiată",
};

/** The ratio table's denominator parts, as the engine names them. */
const OPERAND_RO: Record<string, string> = {
  "cost of goods sold": "costul bunurilor vândute",
  "operating expenses": "cheltuieli de exploatare",
  "depreciation amortization": "amortizare",
};

const UNPRICEABLE =
  "no borrowing rate is measurable from this book \\(it carries no interest expense, or no interest-bearing debt at the opening date\\), so the funding line CANNOT be priced\\. A plan that draws the line is refused rather than charged (" +
  N +
  ")%; supply revolver_rate to price it";

const SECTOR_TAIL =
  "(CAEN \\d+ .+) \\((class|division)\\), size band ([a-z0-9_]+), (" +
  N +
  ")% over (\\d+) filers, (\\d{4}) to (\\d{4}) \\((.+)\\)";

const RULES: readonly Rule[] = [
  // ── revenue growth: book, sector, sector offered, macro ──────────────
  rule(
    "growth.book",
    `this book's own turnover: (${N}) in (${DATE}) against (${N}) in (${DATE}), a growth of (${N})% carried forward at constant real volume`,
    (m, c) =>
      `cifra de afaceri proprie a acestei balanțe: ${c.n(m[1])} la ${m[2]}, față de ${c.n(m[3])} la ${m[4]}, o variație de ${c.n(m[5])}%, extinsă mai departe la volum real constant`,
  ),
  rule(
    "growth.sector",
    `no comparable book history is loaded, so revenue grows at the median net turnover growth of this company's sector: ${SECTOR_TAIL}`,
    (m, c) =>
      `nicio istorie comparabilă a balanței nu este încărcată, așa că veniturile cresc cu mediana creșterii cifrei de afaceri nete din sectorul companiei: ${sectorTail(m, c)}`,
  ),
  rule(
    "growth.sector_offer",
    `the median net turnover growth of this company's sector, offered beside this book's own history: ${SECTOR_TAIL}`,
    (m, c) =>
      `mediana creșterii cifrei de afaceri nete din sectorul companiei, oferită alături de istoria proprie a balanței: ${sectorTail(m, c)}`,
  ),
  rule(
    "growth.macro",
    `no comparable book history is loaded, so revenue grows at the inflation anchor of (${N})% for jurisdiction ([A-Z]{2}) \\((.+), stated as of (${DATE})\\): a nominal continuation at constant real volume`,
    (m, c) =>
      `nicio istorie comparabilă a balanței nu este încărcată, așa că veniturile cresc cu ancora de inflație de ${c.n(m[1])}% pentru jurisdicția ${m[2]} (${c.source(m[3])}, la data de ${m[4]}): o continuare nominală la volum real constant`,
  ),
  rule(
    "inflation",
    `fixed costs follow the inflation anchor of (${N})% for jurisdiction ([A-Z]{2}) \\((.+), stated as of (${DATE})\\)`,
    (m, c) =>
      `costurile fixe urmează ancora de inflație de ${c.n(m[1])}% pentru jurisdicția ${m[2]} (${c.source(m[3])}, la data de ${m[4]})`,
  ),
  // ── cost pools ───────────────────────────────────────────────────────
  rule(
    "pool.index_neutral",
    `(${POOL}): no index move is assumed, so the anchor level holds`,
    (m, c) => `${c.pool(m[1])}: ${FIXED["no index move is assumed, so the anchor level holds"]}`,
  ),
  rule(
    "pool.cogs_variable",
    `cost_of_sales: cost of sales follows volume in full: its fixed share is nil by convention, and only a behaviour override moves it \\(anchor base (${N})\\)`,
    (m, c) =>
      `${c.pool("cost_of_sales")}: costul vânzărilor urmează integral volumul: partea lui fixă este zero prin convenție și doar o schimbare de comportament o mișcă (baza de pornire ${c.n(m[1])})`,
  ),
  rule(
    "pool.classification",
    `(${POOL}): fixed share by the convention classification of this pool's account prefixes by the nature of the cost \\(fixed-classified (${N}) of the pool\\) \\(anchor base (${N})\\)`,
    (m, c) =>
      `${c.pool(m[1])}: partea fixă, după clasificarea convențională a prefixelor de cont ale grupului după natura costului (clasificat fix: ${c.n(m[2])} din grup) (baza de pornire ${c.n(m[3])})`,
  ),
  rule(
    "pool.larger_than_revenue",
    `(${POOL}): this cost pool is larger than revenue, so it cannot move with sales volume \\(anchor base (${N})\\)`,
    (m, c) =>
      `${c.pool(m[1])}: acest grup de costuri este mai mare decât veniturile, așa că nu se poate mișca odată cu volumul vânzărilor (baza de pornire ${c.n(m[2])})`,
  ),
  rule(
    "pool.net_credit",
    `(${POOL}): this cost pool is a net credit on this book, so it follows sales volume in full \\(anchor base (${N})\\)`,
    (m, c) =>
      `${c.pool(m[1])}: acest grup de costuri are sold net creditor în această balanță, așa că urmează integral volumul vânzărilor (baza de pornire ${c.n(m[2])})`,
  ),
  rule(
    "pool.nil",
    `(${POOL}): this cost pool is nil on this book \\(anchor base (${N})\\)`,
    (m, c) => `${c.pool(m[1])}: acest grup de costuri este zero în această balanță (baza de pornire ${c.n(m[2])})`,
  ),
  rule(
    "pool.unallocated",
    `unallocated_operating: the residual operating cost under no pooled prefix \\((${N})\\) follows the amount-weighted fixed share of the pooled operating costs \\(anchor base (${N})\\)`,
    (m, c) =>
      `${c.pool("unallocated_operating")}: costul de exploatare rămas în afara prefixelor grupate (${c.n(m[1])}) urmează partea fixă, ponderată cu sumele, a costurilor de exploatare grupate (baza de pornire ${c.n(m[2])})`,
  ),
  rule(
    "pool.variable_base_rejected",
    `(packs/forecast/cost_behaviour\\.yaml#[a-z_]+): variable base (${N}) exceeds (${N}) of revenue (${N})`,
    (m, c) =>
      `${m[1]}: baza variabilă ${c.n(m[2])} depășește de ${c.n(m[3])} ori veniturile de ${c.n(m[4])}`,
  ),
  // ── rates on debt and the funding line ───────────────────────────────
  rule(
    "rate.borrowing",
    `annual rate = interest expense (${N}) / interest-bearing debt at the closing date (${N})`,
    (m, c) =>
      `rata anuală = cheltuiala cu dobânzile ${c.n(m[1])} / datoriile purtătoare de dobândă la data închiderii ${c.n(m[2])}`,
  ),
  rule(
    "rate.revolver_priced",
    "the funding line is priced at this book's own borrowing rate: (.+)",
    (m, c) => `linia de finanțare este prețuită la rata de îndatorare proprie a acestei balanțe: ${c.sub(m[1])}`,
  ),
  rule(
    "rate.revolver_unpriceable",
    UNPRICEABLE,
    (m, c) =>
      `nicio rată de îndatorare nu se poate măsura din această balanță (nu are cheltuieli cu dobânzi sau nu are datorii purtătoare de dobândă la data de deschidere), așa că linia de finanțare NU POATE fi prețuită. Un plan care trage pe linie este refuzat, nu taxat cu ${c.n(m[1])}%; introdu revolver_rate ca s-o prețuiești`,
  ),
  rule(
    "refusal.funding_line_unpriceable",
    `the plan draws (${N}) on the funding line in (${PERIOD}) and this book cannot price it: (.+)`,
    (m, c) =>
      `planul trage ${c.n(m[1])} pe linia de finanțare în ${m[2]} și această balanță nu o poate prețui: ${c.sub(m[3])}`,
  ),
  rule(
    "rate.debt_absent",
    `this book carries no interest-bearing debt at the opening date, so no borrowing rate is observable in it\\. It is not taken to be (${N})%: a plan that draws debt would carry it free of charge for the whole horizon\\. Nothing is charged while the balance stays nil; supply interest_rate_debt to project a plan that borrows`,
    (m, c) =>
      `această balanță nu are datorii purtătoare de dobândă la data de deschidere, așa că nu se vede în ea nicio rată de îndatorare. Nu este luată ca ${c.n(m[1])}%: un plan care se împrumută ar purta datoria gratuit pe tot orizontul. Nu se calculează nimic cât timp soldul rămâne zero; introdu interest_rate_debt ca să proiectezi un plan care se împrumută`,
  ),
  // ── working capital days ─────────────────────────────────────────────
  rule(
    "days.dso",
    `days sales outstanding = (${N}) days = trade receivables net (${N}) / revenue (${N}) x (\\d+) days \\(forecast\\.dso\\)`,
    (m, c) =>
      `zile de încasare a creanțelor = ${c.n(m[1])} zile = creanțe comerciale nete ${c.n(m[2])} / venituri ${c.n(m[3])} x ${m[4]} zile (forecast.dso)`,
  ),
  rule(
    "days.dio",
    `days inventory outstanding, in days of cost of sales = (${N}) days = inventory net (${N}) / cost of sales (${N}) x (\\d+) days \\(forecast\\.dio_cogs\\)(\\. .+)?`,
    (m, c) =>
      `zile de stoc, în zile de cost al vânzărilor = ${c.n(m[1])} zile = stocuri nete ${c.n(m[2])} / costul vânzărilor ${c.n(m[3])} x ${m[4]} zile (forecast.dio_cogs)${m[5] ? `. ${c.sub(m[5].slice(2))}` : ""}`,
  ),
  rule(
    "days.dpo",
    `days payables outstanding, in days of cost of sales = (${N}) days = trade payables (${N}) / cost of sales (${N}) x (\\d+) days \\(forecast\\.dpo_cogs\\)(\\. .+)?`,
    (m, c) =>
      `zile de plată a furnizorilor, în zile de cost al vânzărilor = ${c.n(m[1])} zile = datorii comerciale ${c.n(m[2])} / costul vânzărilor ${c.n(m[3])} x ${m[4]} zile (forecast.dpo_cogs)${m[5] ? `. ${c.sub(m[5].slice(2))}` : ""}`,
  ),
  rule(
    "days.ratio_table_quote",
    `Beside it, the ratio table's (dio|dpo|dso) \\(engine\\.ratios\\.table\\) reads (${N}) days = ([a-z ]+) (${N}) x (${N}) days / total operating expense (${N}) \\(([a-z +]+)\\); that table divides by total operating expense, not cost of sales, so its value is quoted here and never served under this driver's name`,
    (m, c) =>
      `Alături, tabelul de indicatori citește ${m[1].toUpperCase()} (engine.ratios.table) = ${c.n(m[2])} zile = ${balanceRo(m[3])} ${c.n(m[4])} x ${c.n(m[5])} zile / total cheltuieli de exploatare ${c.n(m[6])} (${operandsRo(m[7])}); acel tabel împarte la totalul cheltuielilor de exploatare, nu la costul vânzărilor, așa că valoarea lui este doar citată aici și nu este servită niciodată sub numele acestui factor`,
  ),
  rule(
    "days.ratio_table_short",
    `Beside it, the ratio table's (dio|dpo|dso) \\(engine\\.ratios\\.table\\) reads (${N}) days`,
    (m, c) => `Alături, tabelul de indicatori citește ${m[1].toUpperCase()} (engine.ratios.table) = ${c.n(m[2])} zile`,
  ),
  rule(
    "days.not_measurable",
    `this book reports no (revenue|cost of sales), so (days sales outstanding|days inventory outstanding, in days of cost of sales|days payables outstanding, in days of cost of sales) cannot be measured; (trade receivables are|inventory is|trade payables are) HELD at (?:their|its) closing balance of (${N})`,
    (m, c) => {
      const flow = m[1] === "revenue" ? "venituri" : "cost al vânzărilor";
      const what =
        m[2] === "days sales outstanding"
          ? "zilele de încasare a creanțelor"
          : m[2].startsWith("days inventory")
            ? "zilele de stoc, în zile de cost al vânzărilor,"
            : "zilele de plată a furnizorilor, în zile de cost al vânzărilor,";
      const held =
        m[3] === "trade receivables are"
          ? "creanțele comerciale sunt MENȚINUTE"
          : m[3] === "inventory is"
            ? "stocurile sunt MENȚINUTE"
            : "datoriile comerciale sunt MENȚINUTE";
      return `această balanță nu raportează ${flow}, așa că ${what} nu se pot măsura; ${held} la soldul de închidere de ${c.n(m[4])}`;
    },
  ),
  rule(
    "days.not_measured_change",
    "(dso_days|dio_cogs_days|dpo_cogs_days) is not measured on this book, so a change in days has nothing to add to; set it instead",
    (m, c) =>
      `„${c.driver(m[1])}” nu este măsurat în această balanță, așa că o schimbare în zile nu are la ce să se adauge; stabilește direct valoarea`,
  ),
  // ── capex, depreciation ──────────────────────────────────────────────
  rule(
    "capex.maintenance",
    `maintenance-capital convention: capital expenditure replaces the depreciation charge of (${N}), carried as a share of revenue\\. A trial balance discloses no investment plan, so this is a convention, not a measurement of intent`,
    (m, c) =>
      `convenția investițiilor de întreținere: investițiile înlocuiesc cheltuiala cu amortizarea, de ${c.n(m[1])}, și sunt exprimate ca pondere în venituri. O balanță nu arată niciun plan de investiții, așa că aceasta este o convenție, nu o măsurare a intenției`,
  ),
  rule(
    "depreciation.closing_nbv",
    `annual depreciation rate = charge (${N}) / closing net book value of property, plant, equipment and intangibles (${N})\\. The CLOSING base is used because this book carries no prior period from which an opening base could be taken, which overstates the rate on a growing asset base\\.`,
    (m, c) =>
      `rata anuală de amortizare = cheltuiala ${c.n(m[1])} / valoarea netă contabilă de închidere a imobilizărilor corporale și necorporale ${c.n(m[2])}. Se folosește baza de ÎNCHIDERE pentru că această balanță nu are o perioadă anterioară din care să se ia baza de deschidere, ceea ce supraestimează rata când activele cresc.`,
  ),
  // ── tax ──────────────────────────────────────────────────────────────
  rule(
    "tax.absent_charge",
    `this book reproduces the (${N}) it filed in account (\\d+) from a pre-tax result of (${N}), but it books no profit-tax charge: (its statement carries no profit-tax row|its statement rows were not supplied, so no profit-tax row can be shown)\\. The (${N}) on its tax line is an absent charge, not a measured rate of nil, and a plan taxed at nothing in every year would be the most favourable reading of a figure that is not there`,
    (m, c) =>
      `această balanță reproduce suma de ${c.n(m[1])} raportată în contul ${m[2]} dintr-un rezultat înainte de impozitare de ${c.n(m[3])}, dar nu înregistrează nicio cheltuială cu impozitul pe profit: ${
        m[4].startsWith("its statement carries")
          ? "situația ei nu are niciun rând de impozit pe profit"
          : "rândurile situației nu au fost furnizate, așa că nu se poate arăta niciun rând de impozit pe profit"
      }. Valoarea ${c.n(m[5])} de pe linia impozitului este o cheltuială absentă, nu o cotă zero măsurată, iar un plan fără impozit în fiecare an ar fi citirea cea mai favorabilă a unei cifre care nu există`,
  ),
  rule(
    "tax.gap",
    `this book's reconstructed result of (${N}) \\(pre-tax (${N}) less tax (${N})\\) does not reach the (${N}) it filed in account (\\d+), and (${N}) of that distance is not attributable to any line on this statement\\. An effective rate of (${N})% read off two figures inside that build-up would be measured ACROSS the gap rather than from the company`,
    (m, c) =>
      `rezultatul reconstituit al acestei balanțe, de ${c.n(m[1])} (înainte de impozitare ${c.n(m[2])} minus impozit ${c.n(m[3])}), nu ajunge la suma de ${c.n(m[4])} raportată în contul ${m[5]}, iar ${c.n(m[6])} din această diferență nu se pot atribui niciunei linii din situație. O cotă efectivă de ${c.n(m[7])}% citită din două cifre ale acestei reconstituiri ar fi măsurată PESTE diferență, nu din companie`,
  ),
  rule(
    "tax.stock_variation",
    `this book's result before the stock variation, (${N}) \\(pre-tax (${N}) less tax (${N})\\), does not reach the (${N}) it filed in account (\\d+); the (${N}) between them is the stock variation \\((\\d+), Variația stocurilor de produse\\), which this closed trial balance states only as account (\\d+) less every other line\\. An effective rate of (${N})% read off the build-up before it would be measured ACROSS that derived figure rather than from the company`,
    (m, c) =>
      `rezultatul acestei balanțe înainte de variația stocurilor, de ${c.n(m[1])} (înainte de impozitare ${c.n(m[2])} minus impozit ${c.n(m[3])}), nu ajunge la suma de ${c.n(m[4])} raportată în contul ${m[5]}; cei ${c.n(m[6])} dintre ele sunt variația stocurilor de produse (${m[7]}), pe care această balanță închisă o arată doar ca soldul contului ${m[8]} minus toate celelalte linii. O cotă efectivă de ${c.n(m[9])}% citită din reconstituirea dinaintea ei ar fi măsurată PESTE această cifră derivată, nu din companie`,
  ),
  rule(
    "tax.no_net_income",
    `this book reports a positive pre-tax result of (${N}) but does not carry both an income-tax charge and the net income filed in account (\\d+), so there is nothing to check an effective rate against`,
    (m, c) =>
      `această balanță raportează un rezultat pozitiv înainte de impozitare de ${c.n(m[1])}, dar nu are atât cheltuiala cu impozitul pe profit, cât și rezultatul net raportat în contul ${m[2]}, așa că o cotă efectivă nu are cu ce să fie verificată`,
  ),
  rule(
    "tax.statutory",
    `(.+), so the statutory profit-tax rate of (${N})% for jurisdiction ([A-Z]{2}) \\((.+)\\) is used instead`,
    (m, c) =>
      `${c.sub(m[1])}, așa că se folosește cota legală a impozitului pe profit de ${c.n(m[2])}% pentru jurisdicția ${m[3]} (${m[4]})`,
  ),
  rule(
    "tax.measured",
    `effective rate implied by this book = tax (${N}) / pre-tax result (${N})\\. The rate is measured rather than defaulted because spending it on this book's own pre-tax result reproduces this book's own net income of (${N}), leaving nothing unexplained against account (\\d+)(, and the charge it measures is nil: no profit tax is projected, and loss carry-forward is not modelled either way)?`,
    (m, c) =>
      `cota efectivă care reiese din această balanță = impozit ${c.n(m[1])} / rezultat înainte de impozitare ${c.n(m[2])}. Cota este măsurată, nu presupusă, pentru că aplicată rezultatului înainte de impozitare al balanței reproduce rezultatul ei net de ${c.n(m[3])}, fără nimic neexplicat față de contul ${m[4]}${
        m[5] ? ", iar cheltuiala măsurată este zero: nu se proiectează impozit pe profit, iar reportarea pierderilor nu este modelată în niciun sens" : ""
      }`,
  ),
  // ── income and expense held at the book's own amount ────────────────
  rule(
    "ooi.held",
    `other operating income held at this book's own amount of (${N}): it scales with neither volume, growth nor inflation, and is spread across each plan year by days`,
    (m, c) =>
      `alte venituri din exploatare menținute la suma proprie a balanței, de ${c.n(m[1])}: nu variază nici cu volumul, nici cu creșterea, nici cu inflația și se repartizează pe fiecare an de plan după numărul de zile`,
  ),
  rule(
    "interest_income.carried",
    `interest income of (${N}) is carried at its own amount instead of as a rate: the only base this book offers is the closing cash balance of (${N}), which would imply (${N})% on cash and compound onto a projected balance the company never held\\. Supply interest_income_rate to price interest on projected cash instead — it replaces the carried amount\\.`,
    (m, c) =>
      `veniturile din dobânzi de ${c.n(m[1])} sunt păstrate la suma lor, nu ca rată: singura bază pe care o oferă balanța este numerarul de închidere de ${c.n(m[2])}, care ar însemna ${c.n(m[3])}% pe numerar și s-ar compune pe un sold proiectat pe care compania nu l-a avut niciodată. Introdu interest_income_rate ca să calculezi dobânda pe numerarul proiectat — înlocuiește suma păstrată.`,
  ),
  rule(
    "interest_income.annual",
    `interest income is carried at this book's own annual amount of (${N}), HELD flat rather than grown`,
    (m, c) =>
      `veniturile din dobânzi sunt păstrate la suma anuală proprie a balanței, de ${c.n(m[1])}, MENȚINUTĂ constantă, fără creștere`,
  ),
  rule(
    "fin_income.other",
    `financial income other than interest on cash = financial income (${N}) less interest income (${N}), HELD at that annual amount because nothing in a trial balance says foreign-exchange movement or income from holdings scales with trading`,
    (m, c) =>
      `venituri financiare în afara dobânzii la numerar = venituri financiare ${c.n(m[1])} minus venituri din dobânzi ${c.n(m[2])}, MENȚINUTE la această sumă anuală, pentru că nimic dintr-o balanță nu arată că diferențele de curs sau veniturile din participații cresc odată cu activitatea`,
  ),
  rule(
    "fin_expense.other",
    `financial expense other than interest on debt = total financial expense (${N}) less interest expense (${N}), HELD at that annual amount\\. Interest itself is not carried here — it is priced on the debt this model actually rolls forward`,
    (m, c) =>
      `cheltuieli financiare în afara dobânzii la datorii = total cheltuieli financiare ${c.n(m[1])} minus cheltuiala cu dobânzile ${c.n(m[2])}, MENȚINUTE la această sumă anuală. Dobânda însăși nu este păstrată aici — se calculează pe datoriile pe care modelul le poartă efectiv mai departe`,
  ),
  // ── inert drivers ────────────────────────────────────────────────────
  rule(
    "inert.moving",
    "moving ([a-z ._]+) changes no figure in this plan",
    (m, c) => `modificarea factorului „${c.driver(m[1])}” nu schimbă nicio cifră din acest plan`,
  ),
  // ── runway ───────────────────────────────────────────────────────────
  rule("runway.exact", `cash reaches the floor in (${PERIOD})`, (m) => `numerarul atinge pragul în ${m[1]}`),
  rule(
    "runway.annual_tail",
    "cash stays above the floor for every modelled month; the first shortfall falls in (FY\\d{4}), whose month is not modelled",
    (m) =>
      `numerarul rămâne peste prag în fiecare lună modelată; prima lipsă de numerar cade în ${m[1]}, a cărui lună nu este modelată`,
  ),
  // ── a source line served on its own (the growth card's macro line) ───
  rule("source.inflation_target", `(.+) — flat inflation target, (${N})% ±(${N})pp`, (m, c) => c.source(m[0])),
  // ── history candidates ───────────────────────────────────────────────
  rule(
    "history.span",
    `ends (${DATE}), the anchor ends (${DATE}): a turnover cannot be grown against a different span`,
    (m) => `se încheie la ${m[1]}, iar ancora la ${m[2]}: o cifră de afaceri nu poate crește față de o perioadă de altă lungime`,
  ),
  rule(
    "history.gap",
    "ends (\\d+) year\\(s\\) before the anchor: a single-year growth cannot be read across that gap",
    (m) => `se încheie cu ${m[1]} an(i) înaintea ancorei: o creștere pe un singur an nu se poate citi peste acest interval`,
  ),
];

function sectorTail(m: string[], c: Ctx): string {
  const level = m[2] === "class" ? "clasă" : "diviziune";
  return `${m[1]} (${level}), ${c.band(m[3])}, ${c.n(m[4])}% (firme raportoare: ${m[5]}), între ${m[6]} și ${m[7]} (${c.source(m[8])})`;
}

function balanceRo(name: string): string {
  const map: Record<string, string> = {
    inventory: "stocuri",
    "accounts payable": "datorii comerciale",
    "accounts receivable": "creanțe comerciale",
  };
  return map[name] ?? name;
}

function operandsRo(list: string): string {
  return list
    .split(" + ")
    .map((p) => OPERAND_RO[p] ?? p)
    .join(" + ");
}

/** Served source lines with an English phrase in them. Anything else is
 *  printed as served (a source is a citation, not a sentence). */
function sourceRo(text: string): string {
  let m = /^(.*) — flat inflation target, (-?\d[\d,]*(?:\.\d+)?)% ±(\d[\d,]*(?:\.\d+)?)pp$/.exec(text);
  if (m) return `${m[1]} — țintă de inflație fixă, ${roNumber(m[2])}% ±${roNumber(m[3])}pp`;
  m = /^(.*), published on (\S+), (FY\d{4}) and (FY\d{4}), (.+)$/.exec(text);
  if (m) return `${m[1]}, publicate pe ${m[2]}, ${m[3]} și ${m[4]}, ${m[5]}`;
  return text;
}

function context(t: TFunction): Ctx {
  const ctx: Ctx = {
    t,
    n: roNumber,
    pool: (key) => t(`forecast.pool.${key}`, { defaultValue: key }),
    driver: (idOrLabel) => driverLabelRo(t, idOrLabel.replace(/ /g, "_")),
    band: (key) => t(`forecast.growth.band.${key}`, { defaultValue: key }),
    source: sourceRo,
    sub: (text) => {
      const out = translateUnchecked(text, ctx);
      if (out === null) throw new NoRule(text);
      return out;
    },
  };
  return ctx;
}

/** A driver's name in the reader's language, from its served id
 *  (`pool_fixed_share.personnel`, `dso_days`, a convention id). */
export function driverLabelRo(t: TFunction, id: string): string {
  return driverName(t, id, id.replace(/_/g, " "));
}

/** The driver name the page prints, from the locale bundle: the pool
 *  families compose their pool's name; an id the bundle does not know keeps
 *  the served label. */
export function driverName(t: TFunction, id: string, served: string): string {
  const dot = id.indexOf(".");
  if (dot > 0) {
    const family = id.slice(0, dot);
    const pool = id.slice(dot + 1);
    if (family === "pool_fixed_share" || family === "pool_level") {
      return t(`forecast.driver.${family}`, {
        pool: t(`forecast.pool.${pool}`, { defaultValue: pool.replace(/_/g, " ") }),
        defaultValue: served,
      });
    }
    return served;
  }
  return t(`forecast.driver.${id}`, { defaultValue: served });
}

function translateUnchecked(text: string, ctx: Ctx): string | null {
  const trimmed = text.trim();
  const fixed = FIXED[trimmed];
  if (fixed !== undefined) return fixed;
  for (const r of RULES) {
    const m = r.re.exec(trimmed);
    if (!m) continue;
    try {
      return r.ro(Array.from(m, (g) => g ?? ""), ctx);
    } catch (e) {
      if (e instanceof NoRule) continue;
      throw e;
    }
  }
  return null;
}

/** The Romanian of one served engine sentence, or null when no rule says it
 *  in full or the rendering would break the DIGIT LAW (the caller then
 *  prints the served English). `t` must answer in Romanian. */
export function translateServedRo(t: TFunction, text: string): string | null {
  if (!text) return null;
  const out = translateUnchecked(text, context(t));
  if (out === null) return null;
  const a = digitRuns(text);
  const b = digitRuns(out);
  if (a.length !== b.length || a.some((run, i) => run !== b[i])) return null;
  return out;
}

/** For the gate: every rule id, and the fixed sentences, in order. */
export const RULE_IDS: readonly string[] = RULES.map((r) => r.id);
export const FIXED_SENTENCES: readonly string[] = Object.keys(FIXED);
