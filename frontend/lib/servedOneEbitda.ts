// THE ONE EBITDA, AS THE ENGINE SERVES IT — the frontend's one reading of it.
//
// OWNER RULING (2026-09-26). Account 711 ("Variația stocurilor de produse")
// goes INSIDE EBITDA and the operating result, with its sign, presented next
// to cost of sales — never as revenue, never inside cifra de afaceri. 72x
// (own work capitalised) the same way: operating, inside EBITDA, outside
// turnover. Margins and growth divide by net turnover (70x − 709). One
// definition everywhere, with the reconciliation line shown.
//
// WHERE THE FIGURES COME FROM. The engine's one assembly
// (`country_packs/ro_romania/chart_of_accounts.assemble_statements`) serves,
// on `statements.assembled_pl`:
//   · `turnover` (= `revenue`), `ebitda`, `ebit` / `operating_result`,
//     `pretax` — the one definition, or None with `ebitda_refusal` beside
//     them when the stock variation could not be measured;
//   · `inventory_variation` — net 711 {value | refusal, provenance, the
//     engine's RO name, English gloss and provenance sentence};
//   · `capitalized_own_work` — net 72x, the same shape;
//   · `ebitda_before_stock_variation` — the ONLY served figure allowed to
//     differ from `ebitda`, for the reconciliation line;
//   · `ebitda_reconciliation` — the A5 chain (turnover → … → account 121)
//     and the one-line bridge, every value signed as its effect on the
//     result, every label in both languages.
//
// RULINGS R2 / R3 (owner, 2026-09-28; packs/ro/pl_definition.yaml). The
// provision charges 6812 / 6814 AND their reversals 7812 / 7814 are OUTSIDE
// EBITDA; their net is its own line between EBITDA and the operating result
// (`net_provisions` {value = charges − reversals, charges, reversals, the
// engine's label}), so EBIT = EBITDA − D&A − net provisions and D&A
// (`depreciation`) no longer holds the ruled charges. Net turnover holds
// 7411 (operating subsidies related to turnover, F20 rd. 05). The chain's
// net-provisions line and the bridge's `after_ebitda` part carry it.
//
// THIS MODULE READS THOSE AND DERIVES NOTHING. A refused figure stays null
// with its typed reason — never 0, never another definition. The labels are
// the engine's; the only words typed here are the two sentences for "the
// engine served no such figure", which is a statement about the payload,
// not about the company.

/** A sentence in both UI languages. */
export interface Bilingual {
  readonly ro: string;
  readonly en: string;
}

/** A figure the engine refused, with its typed reason. */
export interface ServedRefusal {
  readonly code: string;
  readonly text: Bilingual;
}

/** Net 711 or net 72x, as `stock_variation.decide` served it. */
export interface ServedComponent {
  readonly key: "inventory_variation" | "capitalized_own_work";
  /** null = REFUSED (then `refusal` is set). */
  readonly value: number | null;
  readonly refusal: ServedRefusal | null;
  /** e.g. `account_121_bridge`, `711_net_movement`, `no_711_activity`. */
  readonly provenance: string | null;
  /** The owner's Romanian name, verbatim ("Variația stocurilor de produse"). */
  readonly nameRo: string | null;
  /** The engine's English gloss for the English UI (CLAUDE.md §11: the
   *  Romanian name stays, the English explains it). */
  readonly glossEn: string | null;
  /** The engine's provenance sentence, per language. */
  readonly provenanceLabel: Bilingual | null;
  readonly accounts: string;
  /** On a closed book the 711 line is derived from account 121: said. */
  readonly identityNote: Bilingual | null;
  /** 711 and 72x both active on a closed book: the split assumption. */
  readonly splitAssumption: Bilingual | null;
  /** The trial balance's state as `stock_variation.decide` read it
   *  ("closed" | "open" | "mixed"), when served. On a CLOSED book an
   *  account-711 row holds the production stocked in the period (its
   *  credit turnover), not the variation. */
  readonly bookState: string | null;
}

/** One line of the served reconciliation chain (design A5). */
export interface ServedReconLine {
  readonly key: string;
  readonly label: Bilingual;
  readonly accounts: string | null;
  /** The accounts in the English UI, where the engine words them apart
   *  ("fără" / "excl."); else `accounts`. */
  readonly accountsEn: string | null;
  /** Signed as its effect on the result; null = refused / not anchored. */
  readonly value: number | null;
  readonly subtotal: boolean;
  readonly refusal: ServedRefusal | null;
  readonly provenance: string | null;
  readonly provenanceLabel: Bilingual | null;
  /** `account_121` only: "anchored" | "not_anchored". */
  readonly status: string | null;
}

export interface ServedBridgePart {
  readonly key: string;
  readonly label: Bilingual;
  readonly value: number | null;
}

/** Net provisions (R2, 2026-09-28): the ruled charges (6812, 6814) less the
 *  ruled reversals (7812, 7814), OUTSIDE EBITDA, as the engine served them. */
export interface ServedNetProvisions {
  /** Signed as a CHARGE (charges − reversals): positive lowers the
   *  operating result, negative (a net release) raises it. */
  readonly value: number;
  readonly charges: number;
  readonly reversals: number;
  /** The account prefixes the engine read ("6812", "6814" / "7812", "7814"). */
  readonly chargePrefixes: readonly string[];
  readonly reversalPrefixes: readonly string[];
  /** "Provizioane și ajustări nete (6812 + 6814 − 7812 − 7814)" — the
   *  engine's name with its accounts, rendered from its pack. */
  readonly label: Bilingual;
  /** The name alone (a statement row carries the accounts in its chip). */
  readonly name: Bilingual;
  readonly accounts: string;
}

export interface ServedReconciliation {
  readonly definition: string | null;
  readonly lines: readonly ServedReconLine[];
  readonly bridge: {
    readonly parts: readonly ServedBridgePart[];
    /** Lines the one-line bridge carries AFTER EBITDA, outside it — net
     *  provisions (R2, 2026-09-28). The parts above still sum to EBITDA. */
    readonly afterEbitda: readonly ServedBridgePart[];
    readonly refusal: ServedRefusal | null;
  };
  readonly identityWith121: boolean;
  readonly identityNote: Bilingual | null;
  readonly splitAssumption: Bilingual | null;
}

export interface ServedOneEbitda {
  /** `assembled_pl.ebitda_definition` — the revision every figure is on. */
  readonly definition: string | null;
  /** Cifra de afaceri netă (70x − 709) — every margin's denominator. */
  readonly turnover: number | null;
  /** null = REFUSED; `refusal` then says why. */
  readonly ebitda: number | null;
  readonly ebit: number | null;
  readonly pretax: number | null;
  /** Non-null exactly when `ebitda` is null. */
  readonly refusal: ServedRefusal | null;
  readonly ebitdaBeforeStockVariation: number | null;
  readonly inventoryVariation: ServedComponent | null;
  readonly capitalizedOwnWork: ServedComponent | null;
  readonly reconciliation: ServedReconciliation | null;
  /** Net provisions, outside EBITDA (R2) — null on a block assembled before
   *  the ruling (its D&A still held the charges, its EBITDA the reversals). */
  readonly netProvisions: ServedNetProvisions | null;
  /** Account 121 (as filed) when anchored, else the engine's build-up. */
  readonly netIncomeStatutory: number | null;
  /** Core EBITDA = EBITDA − 758 − the 781 reversals still inside EBITDA,
   *  on the one EBITDA. */
  readonly coreEbitda: number | null;
  readonly otherIncome758: number | null;
  /** The 781 reversals INSIDE EBITDA (the ruled 7812 / 7814 are outside it
   *  since R2 — they are not stripped twice). */
  readonly reversals781: number | null;
}

/** The payload carries an `assembled_pl` block but no EBITDA in it. */
export const NOT_SERVED: ServedRefusal = {
  code: "ebitda_not_served",
  text: {
    ro: "motorul nu a servit EBITDA pentru această perioadă",
    en: "the engine served no EBITDA for this period",
  },
};

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

const finite = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

function bilingual(ro: unknown, en: unknown): Bilingual | null {
  const r = str(ro);
  const e = str(en);
  return r && e ? { ro: r, en: e } : null;
}

/** `{code, text_ro, text_en}` as `stock_variation._refusal` writes it. */
export function readRefusal(v: unknown): ServedRefusal | null {
  if (!isRec(v)) return null;
  const code = str(v.code);
  const text = bilingual(v.text_ro, v.text_en);
  return code && text ? { code, text } : null;
}

function readComponent(v: unknown, key: ServedComponent["key"]): ServedComponent | null {
  if (!isRec(v)) return null;
  const value = finite(v.value);
  const refusal = readRefusal(v.refusal);
  // A block with neither a value nor a refusal is not one the engine writes.
  if (value === null && refusal === null) return null;
  return {
    key,
    value,
    refusal: value === null ? refusal : null,
    provenance: str(v.provenance),
    nameRo: str(v.line_name_ro),
    glossEn: str(v.gloss_en),
    provenanceLabel: bilingual(v.label_ro, v.label_en),
    accounts: str(v.accounts) ?? (key === "inventory_variation" ? "711" : "72x"),
    identityNote: bilingual(v.identity_note_ro, v.identity_note_en),
    splitAssumption: bilingual(v.split_assumption_ro, v.split_assumption_en),
    bookState: str(v.book_state),
  };
}

function readReconciliation(v: unknown): ServedReconciliation | null {
  if (!isRec(v) || !Array.isArray(v.lines)) return null;
  const lines: ServedReconLine[] = [];
  for (const raw of v.lines) {
    if (!isRec(raw)) continue;
    const key = str(raw.key);
    const label = bilingual(raw.label_ro, raw.label_en);
    if (!key || !label) continue;
    lines.push({
      key,
      label,
      accounts: str(raw.accounts),
      accountsEn: str(raw.accounts_en),
      value: finite(raw.value),
      subtotal: raw.subtotal === true,
      refusal: readRefusal(raw.refusal),
      provenance: str(raw.provenance),
      provenanceLabel: bilingual(raw.provenance_label_ro, raw.provenance_label_en),
      status: str(raw.status),
    });
  }
  const bridgeRaw = isRec(v.bridge) ? v.bridge : {};
  const readParts = (raws: unknown): ServedBridgePart[] => {
    const out: ServedBridgePart[] = [];
    for (const raw of Array.isArray(raws) ? raws : []) {
      if (!isRec(raw)) continue;
      const key = str(raw.key);
      const label = bilingual(raw.label_ro, raw.label_en);
      if (key && label) out.push({ key, label, value: finite(raw.value) });
    }
    return out;
  };
  return {
    definition: str(v.definition),
    lines,
    bridge: {
      parts: readParts(bridgeRaw.parts),
      afterEbitda: readParts(bridgeRaw.after_ebitda),
      refusal: readRefusal(bridgeRaw.refusal),
    },
    identityWith121: v.identity_with_121 === true,
    identityNote: bilingual(v.identity_note_ro, v.identity_note_en),
    splitAssumption: bilingual(v.split_assumption_ro, v.split_assumption_en),
  };
}

/**
 * The served one-EBITDA reading of an `assembled_pl` block.
 *
 * `null` when there is NO block — a payload the engine did not assemble
 * (the fictional demo company, a public-company adapter). A block that IS
 * there but carries no EBITDA reads as refused (`NOT_SERVED`), never as a
 * derivation: a period the engine assembled has its EBITDA from the engine
 * or not at all.
 */
/**
 * TOTAL EQUITY SHORT BY A REFUSED YEAR'S RESULT — the engine's completeness
 * refusal beside total equity (`assembled_bs.total_equity_refusal`, critic
 * 2026-09-27): no account 121, net 711 refused, and a sheet that does not
 * balance without the year's result. The figure beside it is what the
 * equity rows sum to — short by the missing result — so no surface may
 * divide it (equity ratio, debt / equity, ROE), print it as book equity
 * (the NAV floor) or judge it (the covenant floor). Accepts the statements
 * payload or its `assembled_bs` block itself.
 */
export function equityRefusalOf(statementsOrBs: unknown): ServedRefusal | null {
  if (!isRec(statementsOrBs)) return null;
  const bs = isRec(statementsOrBs.assembled_bs) ? statementsOrBs.assembled_bs : statementsOrBs;
  return readRefusal(bs.total_equity_refusal);
}

/**
 * THE NET RESULT REFUSED — no account 121 and a refused net 711
 * (`assembled_pl.net_income_refusal`): the build-up lacks the unmeasured
 * variation, so no net result is served and nothing built on it (the cash
 * flow walk from it, FCF, the DCF, Graham, net margin, ROE, ROA).
 */
export function netIncomeRefusalOf(statements: unknown): ServedRefusal | null {
  if (!isRec(statements) || !isRec(statements.assembled_pl)) return null;
  return readRefusal(statements.assembled_pl.net_income_refusal);
}

/** Metric rows the engine refuses when the NET RESULT is refused
 *  (`credit_model.NET_RESULT_REFUSED_METRICS`, the same names). */
export const NET_RESULT_REFUSED_METRICS: readonly string[] = [
  "net_income", "net_income_operational", "net_income_statutory",
  "net_margin", "roa", "roe", "free_cash_flow",
];

/** Metric rows the engine refuses when TOTAL EQUITY excludes that refused
 *  result (`credit_model.EQUITY_INCOMPLETE_METRICS`, the same names). */
export const EQUITY_INCOMPLETE_METRICS: readonly string[] = [
  "total_equity", "equity_ratio", "debt_to_equity", "lt_debt_to_equity",
];

/** The served net-provisions block (R2, 2026-09-28), or null when the block
 *  predates the ruling / is not an engine block. */
export function readNetProvisions(assembledPl: unknown): ServedNetProvisions | null {
  if (!isRec(assembledPl) || !isRec(assembledPl.net_provisions)) return null;
  const np = assembledPl.net_provisions;
  const value = finite(np.value);
  const charges = isRec(np.charges) ? finite(np.charges.value) : null;
  const reversals = isRec(np.reversals) ? finite(np.reversals.value) : null;
  const label = bilingual(np.label_ro, np.label_en);
  const name = bilingual(np.name_ro, np.name_en) ?? label;
  if (value === null || charges === null || reversals === null || !label || !name) return null;
  const prefixes = (v: unknown): string[] =>
    isRec(v) && Array.isArray(v.prefixes) ? v.prefixes.filter((p): p is string => typeof p === "string") : [];
  return {
    value,
    charges,
    reversals,
    chargePrefixes: prefixes(np.charges),
    reversalPrefixes: prefixes(np.reversals),
    label,
    name,
    accounts: str(np.accounts) ?? "",
  };
}

/** The net-provisions accounts written as the arithmetic of the figure's
 *  EFFECT on the result — reversals less charges, "7812 + 7814 − 6812 −
 *  6814" — from the prefixes the engine served.
 *
 *  The engine's own `accounts` ("6812 + 6814 − 7812 − 7814") is the CHARGE
 *  arithmetic: it belongs beside the charge figure (the P&L row, the bridge
 *  after EBITDA). A surface that prints net provisions as its effect — a
 *  chain that sums to the operating result, every cost in it negative —
 *  printed that charge arithmetic over the opposite figure (review
 *  2026-10-01: agras "6812 + 6814 − 7812 − 7814 … −131,394.66", which the
 *  label itself evaluates to +131,394.66). Under this string the label's
 *  arithmetic IS the printed figure. Codes only — no figure is built here.
 *  Null when the engine served no prefixes. */
export function netProvisionsEffectAccounts(np: ServedNetProvisions): string | null {
  const minus = "−";
  const parts: string[] = [];
  np.reversalPrefixes.forEach((p, i) => parts.push(i === 0 ? p : `+ ${p}`));
  np.chargePrefixes.forEach((p) => parts.push(parts.length === 0 ? `${minus}${p}` : `${minus} ${p}`));
  return parts.length > 0 ? parts.join(" ") : null;
}

/** THE ROW'S LABEL WHERE IT PRINTS ITS EFFECT — the engine's name and, in
 *  brackets, the effect's arithmetic: "Net provisions and impairment
 *  adjustments (7812 + 7814 − 6812 − 6814)". ONE composition for every
 *  surface that prints net provisions effect-signed in a column that sums to
 *  the operating result (the printed report and the workbook through
 *  `printedPl`, /report §2's table): the engine's own `label` carries the
 *  CHARGE arithmetic and must never stand beside the effect (review
 *  2026-10-02: /report §2 printed agras "… (6812 + 6814 − 7812 − 7814)
 *  −131,395", a label that evaluates to +131,394.66). Without served
 *  prefixes the name stands alone — never the charge arithmetic. */
export function netProvisionsEffectLabel(np: ServedNetProvisions, lang: "ro" | "en"): string {
  const effect = netProvisionsEffectAccounts(np);
  const name = lang === "ro" ? np.name.ro : np.name.en;
  return effect ? `${name} (${effect})` : name;
}

export function readServedOneEbitda(assembledPl: unknown): ServedOneEbitda | null {
  if (!isRec(assembledPl)) return null;
  const apl = assembledPl;
  const inventoryVariation = readComponent(apl.inventory_variation, "inventory_variation");
  const capitalizedOwnWork = readComponent(apl.capitalized_own_work, "capitalized_own_work");
  const ebitda = finite(apl.ebitda);
  const refusal =
    ebitda !== null
      ? null
      : readRefusal(apl.ebitda_refusal) ?? inventoryVariation?.refusal ?? NOT_SERVED;
  // EBIT / PBT: refused with EBITDA (the same reason); a figure the block
  // does not carry at all is not served — never EBITDA minus a D&A here.
  const ebit = ebitda === null ? null : finite(apl.ebit) ?? finite(apl.operating_result);
  const pretax = ebitda === null ? null : finite(apl.pretax);
  return {
    definition: str(apl.ebitda_definition),
    turnover: finite(apl.turnover) ?? finite(apl.revenue),
    ebitda,
    ebit,
    pretax,
    refusal,
    ebitdaBeforeStockVariation: finite(apl.ebitda_before_stock_variation),
    inventoryVariation,
    capitalizedOwnWork,
    reconciliation: readReconciliation(apl.ebitda_reconciliation),
    netProvisions: readNetProvisions(apl),
    netIncomeStatutory: finite(apl.net_income_statutory),
    coreEbitda: ebitda === null ? null : finite(apl.core_ebitda),
    otherIncome758: finite(apl.other_income_758),
    reversals781: finite(apl.other_income_781_reversals),
  };
}

/** The block a `Statements` payload serves, when it serves one. */
export function assembledPlOf(statements: unknown): unknown {
  return isRec(statements) ? statements.assembled_pl : undefined;
}

/** The reader's language half of a bilingual sentence ("ro*" → RO). */
export function pickLang(b: Bilingual, lang: string | null | undefined): string {
  return (lang ?? "").toLowerCase().startsWith("ro") ? b.ro : b.en;
}

/** A served line the P&L prints as a row: present when it moved the
 *  period (|value| of half a cent or more) or when the engine refused it
 *  (the refusal must be visible). An exact served zero is left to the
 *  reconciliation line, which always states it. */
export function componentShown(c: ServedComponent | null | undefined): c is ServedComponent {
  if (!c) return false;
  if (c.value === null) return c.refusal !== null;
  return Math.abs(c.value) >= 0.005;
}

/** The reconciliation line by key, when the engine served one. */
export function reconLine(
  r: ServedReconciliation | null | undefined,
  key: string,
): ServedReconLine | null {
  return r?.lines.find((l) => l.key === key) ?? null;
}

// ────────────────────────────────────────────────────────────────────────
// THE P&L LEVELS OF A PAYLOAD — one reading for every browser consumer.
//
// `deriveTotals`, `computeRatios`, the exports, the learning metrics and
// the no-envelope credit model used to rebuild EBITDA / EBIT / PBT / gross
// profit from the `incomeStatement` buckets. On an engine period that is a
// SECOND EBITDA: the buckets carry neither the measured net 711 nor the
// net 72x, so the rebuilt figure is exactly `ebitda_before_stock_variation`
// — agras 10,776,378.24 against the served 11,848,065.27, the developer
// −29,038,838.12 against +550,976.12. This reader gives every one of them
// the SERVED levels when the engine assembled the period, and refuses them
// (null + the engine's typed reason) when the engine refused EBITDA.
//
// A payload the engine did not assemble (the fictional demo company, a
// public-company adapter) keeps its arithmetic — on the SAME definition
// (72x inside, 711 inside) — and refuses when its income statement shows
// 711 activity it could not measure.
// ────────────────────────────────────────────────────────────────────────

/** A payload the engine did not assemble, whose income statement says it
 *  HAS 711 activity (the gross memo): the variation is not measured, so
 *  EBITDA is not known on the one definition. */
export const STOCK_VARIATION_NOT_MEASURED: ServedRefusal = {
  code: "stock_variation_not_measured",
  text: {
    ro: "variația stocurilor de produse (711) nu a fost măsurată pentru aceste date",
    en: "the stock variation (711) was not measured for this data",
  },
};

/** The served block carries EBITDA but not this level (an older capture). */
function levelNotServed(ro: string, en: string, code: string): ServedRefusal {
  return {
    code,
    text: {
      ro: `motorul nu a servit ${ro} pentru această perioadă`,
      en: `the engine served no ${en} for this period`,
    },
  };
}

/** The income-statement buckets a payload carries (the legacy mirror). */
export interface PlBuckets {
  revenue?: number;
  costOfGoodsSold?: number;
  operatingExpenses?: number;
  otherIncome?: number;
  depreciationAmortization?: number;
  interestExpense?: number;
  financialIncome?: number;
  financialExpense?: number;
  taxExpense?: number;
  inventoryVariationMemo?: number;
  capitalizedOwnWork?: number;
}

export interface PlLevels {
  /** "served": the engine assembled this period — every level below is
   *  its figure; "payload": no assembled block (demo, public company). */
  readonly source: "served" | "payload";
  /** `assembled_pl.ebitda_definition`, when served. */
  readonly definition: string | null;
  /** Cifra de afaceri netă (70x − 709). */
  readonly turnover: number;
  readonly grossProfit: number | null;
  readonly ebitda: number | null;
  readonly ebit: number | null;
  readonly pbt: number | null;
  /** pretax − tax: the result BUILT from the accounts. Account 121 is
   *  `assembled_pl.net_income_statutory`, read by its own consumers. */
  readonly netIncome: number | null;
  readonly netFinancialResult: number;
  /** Non-null exactly when `ebitda` is null. */
  readonly refusal: ServedRefusal | null;
  readonly grossProfitRefusal: ServedRefusal | null;
  readonly ebitRefusal: ServedRefusal | null;
  readonly pbtRefusal: ServedRefusal | null;
  /** Net 711 / net 72x as served (null when refused or not served). */
  readonly inventoryVariation: number | null;
  readonly capitalizedOwnWork: number | null;
  /** EBITDA − net 711 − net 72x, as served — the reconciliation line only. */
  readonly ebitdaBeforeStockVariation: number | null;
}

const bucket = (v: number | undefined): number =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;

/**
 * The P&L levels of a payload: the engine's when it assembled the period,
 * else the payload's own arithmetic on the one definition.
 */
export function plLevelsOf(s: {
  assembled_pl?: unknown;
  incomeStatement?: PlBuckets | null;
}): PlLevels {
  const is: PlBuckets = s.incomeStatement ?? {};
  const served = readServedOneEbitda(s.assembled_pl);
  const finIn = bucket(is.financialIncome);
  const finEx = bucket(is.financialExpense);
  const interest = bucket(is.interestExpense);
  if (served) {
    const apl = s.assembled_pl as Rec;
    const tax = finite(apl.tax) ?? bucket(is.taxExpense);
    const ebitda = served.ebitda;
    const refused = ebitda === null;
    const grossProfit = refused ? null : finite(apl.gross_profit);
    const ebit = served.ebit;
    const pbt = served.pretax;
    return {
      source: "served",
      definition: served.definition,
      turnover: served.turnover ?? bucket(is.revenue),
      grossProfit,
      ebitda,
      ebit,
      pbt,
      netIncome: pbt === null ? null : pbt - tax,
      netFinancialResult: finite(apl.net_financial_result) ?? finIn - interest - finEx,
      refusal: served.refusal,
      grossProfitRefusal:
        grossProfit !== null ? null : served.refusal ?? levelNotServed("marja brută", "gross profit", "gross_profit_not_served"),
      ebitRefusal:
        ebit !== null ? null : served.refusal ?? levelNotServed("rezultatul din exploatare", "operating result", "operating_result_not_served"),
      pbtRefusal:
        pbt !== null ? null : served.refusal ?? levelNotServed("profitul înainte de impozit", "profit before tax", "pretax_not_served"),
      inventoryVariation: served.inventoryVariation?.value ?? null,
      capitalizedOwnWork: served.capitalizedOwnWork?.value ?? null,
      ebitdaBeforeStockVariation: served.ebitdaBeforeStockVariation,
    };
  }
  const turnover = bucket(is.revenue);
  const has711 = Math.abs(bucket(is.inventoryVariationMemo)) >= 0.005;
  const capitalized = bucket(is.capitalizedOwnWork);
  const netFinancialResult = finIn - interest - finEx;
  if (has711) {
    const r = STOCK_VARIATION_NOT_MEASURED;
    return {
      source: "payload",
      definition: null,
      turnover,
      grossProfit: null,
      ebitda: null,
      ebit: null,
      pbt: null,
      netIncome: null,
      netFinancialResult,
      refusal: r,
      grossProfitRefusal: r,
      ebitRefusal: r,
      pbtRefusal: r,
      inventoryVariation: null,
      capitalizedOwnWork: capitalized,
      ebitdaBeforeStockVariation:
        turnover - bucket(is.costOfGoodsSold) - bucket(is.operatingExpenses) + bucket(is.otherIncome),
    };
  }
  const grossProfit = turnover - bucket(is.costOfGoodsSold);
  const ebitda = grossProfit - bucket(is.operatingExpenses) + bucket(is.otherIncome) + capitalized;
  const ebit = ebitda - bucket(is.depreciationAmortization);
  const pbt = ebit + netFinancialResult;
  return {
    source: "payload",
    definition: null,
    turnover,
    grossProfit,
    ebitda,
    ebit,
    pbt,
    netIncome: pbt - bucket(is.taxExpense),
    netFinancialResult,
    refusal: null,
    grossProfitRefusal: null,
    ebitRefusal: null,
    pbtRefusal: null,
    inventoryVariation: 0,
    capitalizedOwnWork: capitalized,
    ebitdaBeforeStockVariation: ebitda - capitalized,
  };
}

/** Two P&L blocks on the SAME EBITDA definition (a prior column may only
 *  sit beside the current one when they are). Payloads the engine did not
 *  assemble carry no definition and pair with each other. */
export function sameEbitdaDefinition(a: PlLevels, b: PlLevels): boolean {
  return a.definition === b.definition;
}
