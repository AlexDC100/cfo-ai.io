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
}

/** One line of the served reconciliation chain (design A5). */
export interface ServedReconLine {
  readonly key: string;
  readonly label: Bilingual;
  readonly accounts: string | null;
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

export interface ServedReconciliation {
  readonly definition: string | null;
  readonly lines: readonly ServedReconLine[];
  readonly bridge: {
    readonly parts: readonly ServedBridgePart[];
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
  /** Account 121 (as filed) when anchored, else the engine's build-up. */
  readonly netIncomeStatutory: number | null;
  /** Core EBITDA = EBITDA − 758 − 781 reversals, on the one EBITDA. */
  readonly coreEbitda: number | null;
  readonly otherIncome758: number | null;
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
      value: finite(raw.value),
      subtotal: raw.subtotal === true,
      refusal: readRefusal(raw.refusal),
      provenance: str(raw.provenance),
      provenanceLabel: bilingual(raw.provenance_label_ro, raw.provenance_label_en),
      status: str(raw.status),
    });
  }
  const bridgeRaw = isRec(v.bridge) ? v.bridge : {};
  const parts: ServedBridgePart[] = [];
  for (const raw of Array.isArray(bridgeRaw.parts) ? bridgeRaw.parts : []) {
    if (!isRec(raw)) continue;
    const key = str(raw.key);
    const label = bilingual(raw.label_ro, raw.label_en);
    if (key && label) parts.push({ key, label, value: finite(raw.value) });
  }
  return {
    definition: str(v.definition),
    lines,
    bridge: { parts, refusal: readRefusal(bridgeRaw.refusal) },
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
