// creditRegime.ts — THE STOCK-BUILD CREDIT REGIME, as the engine serves it.
//
// Credit model revision 5 (owner ruling R1, 2026-09-28). A developer that
// capitalises its construction into stock posts it through 711, which the
// one EBITDA carries inside: accounting right, credit signal wrong. When the
// measured net 711 build reaches the pack's shares of net turnover and of
// total operating expense, the engine grades leverage, coverage and DSCR on
// the served cash from operations, Altman X3 on the operating result before
// the stock variation and own work, on the regime's weight table — and
// serves the regime beside the grade (`assembled_metrics.credit.regime`,
// `ratio_table.credit.regime`, the attention document's `credit_regime`).
//
// ONE AUTHORITY. This file READS the served block: the label, the trigger
// tests (each with the share the book reached and the pack share it was read
// against — printed as served, never re-divided), the cash basis and its
// status, the X3 basis and the finding (the owner's sentence, RO verbatim,
// and its EN equivalent, with the served figures). It computes nothing; a
// surface that prints the grade prints this ONCE (`CreditRegimeNote`).
// A block it cannot read is null — never a guessed regime.

import { formatMoneyFrom } from "./money";
import type { Currency, Rates } from "./rates";

export interface Bilingual {
  ro: string;
  en: string;
}

export type RegimeLang = "ro" | "en";

export interface CreditRegimeTest {
  key: string;
  basis: string;
  basisValue: number | null;
  /** net 711 ÷ the basis, as served (4 dp); null over a basis that is not
   *  positive. */
  share: number | null;
  /** The pack share, as served ("1.0", "0.10"). */
  atLeast: string;
  met: boolean;
  label: Bilingual;
}

export interface CreditRegimeFigure {
  key: string;
  /** Null when the figure is not measured (cash from operations while the
   *  cash flow is approximated) — its `status` says why. */
  value: number | null;
  unit: string | null;
  status: string;
  label: Bilingual;
}

export interface CreditRegime {
  code: string;
  label: Bilingual;
  net711: number | null;
  tests: CreditRegimeTest[];
  weightsWhy: Bilingual | null;
  weights: Record<string, number> | null;
  cash: {
    label: Bilingual;
    status: string;
    value: number | null;
    refusal: { code: string; text: Bilingual } | null;
  } | null;
  componentBases: Record<string, Bilingual>;
  altmanX3Label: Bilingual | null;
  finding: {
    code: string;
    severity: string;
    text: Bilingual;
    figures: CreditRegimeFigure[];
  } | null;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function bilingual(v: unknown): Bilingual | null {
  if (!isObj(v)) return null;
  const ro = v.ro;
  const en = v.en;
  return typeof ro === "string" && ro && typeof en === "string" && en ? { ro, en } : null;
}

/** The served regime block, typed — or null (the standard model, or a
 *  block this reader cannot read; never a guessed regime). */
export function readCreditRegime(raw: unknown): CreditRegime | null {
  if (!isObj(raw) || typeof raw.code !== "string" || !raw.code) return null;
  const label = bilingual(raw.label);
  if (!label) return null;
  const trigger = isObj(raw.trigger) ? raw.trigger : {};
  const tests: CreditRegimeTest[] = Array.isArray(trigger.tests)
    ? trigger.tests.flatMap((t): CreditRegimeTest[] => {
        if (!isObj(t) || typeof t.key !== "string") return [];
        const tl = bilingual(t.label);
        if (!tl) return [];
        return [{
          key: t.key,
          basis: typeof t.basis === "string" ? t.basis : "",
          basisValue: num(t.basis_value),
          share: num(t.share),
          atLeast: typeof t.at_least === "string" ? t.at_least : String(t.at_least ?? ""),
          met: t.met === true,
          label: tl,
        }];
      })
    : [];
  const cashRaw = isObj(raw.cash) ? raw.cash : null;
  const cashLabel = cashRaw ? bilingual(cashRaw.label) : null;
  const cashRef = cashRaw && isObj(cashRaw.refusal) ? cashRaw.refusal : null;
  const cashRefText =
    cashRef && typeof cashRef.text_ro === "string" && typeof cashRef.text_en === "string"
      ? { ro: cashRef.text_ro, en: cashRef.text_en }
      : null;
  const bases: Record<string, Bilingual> = {};
  if (isObj(raw.component_bases)) {
    for (const [k, v] of Object.entries(raw.component_bases)) {
      const b = bilingual(v);
      if (b) bases[k] = b;
    }
  }
  const weights: Record<string, number> = {};
  if (isObj(raw.weights)) {
    for (const [k, v] of Object.entries(raw.weights)) {
      const n = num(v);
      if (n !== null) weights[k] = n;
    }
  }
  const f = isObj(raw.finding) ? raw.finding : null;
  const fText = f ? bilingual(f.text) : null;
  const finding =
    f && fText && typeof f.code === "string"
      ? {
          code: f.code,
          severity: typeof f.severity === "string" ? f.severity : "",
          text: fText,
          figures: Array.isArray(f.figures)
            ? f.figures.flatMap((x): CreditRegimeFigure[] => {
                if (!isObj(x) || typeof x.key !== "string") return [];
                const fl = bilingual(x.label);
                if (!fl) return [];
                return [{
                  key: x.key,
                  value: num(x.value),
                  unit: typeof x.unit === "string" ? x.unit : null,
                  status: typeof x.status === "string" ? x.status : "",
                  label: fl,
                }];
              })
            : [],
        }
      : null;
  return {
    code: raw.code,
    label,
    net711: num(trigger.net_711),
    tests,
    weightsWhy: bilingual(raw.weights_why),
    weights: Object.keys(weights).length > 0 ? weights : null,
    cash: cashRaw && cashLabel
      ? {
          label: cashLabel,
          status: typeof cashRaw.status === "string" ? cashRaw.status : "",
          value: num(cashRaw.value),
          refusal: cashRefText && typeof cashRef?.code === "string" ? { code: cashRef.code, text: cashRefText } : null,
        }
      : null,
    componentBases: bases,
    altmanX3Label: isObj(raw.altman_x3) ? bilingual(raw.altman_x3.label) : null,
    finding,
  };
}

export function regimeLang(language: string | null | undefined): RegimeLang {
  return (language ?? "en").toLowerCase().startsWith("ro") ? "ro" : "en";
}

/** A served share (a fraction, 4 dp) as a percentage on the reader's
 *  locale, one decimal — the served figure times one hundred, printed. */
export function printShare(share: number | null, lang: RegimeLang): string | null {
  if (share === null) return null;
  return new Intl.NumberFormat(lang === "ro" ? "ro-RO" : "en-GB", {
    style: "percent",
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
  }).format(share);
}

/** The pack share as served ("1.0", "0.10") as a percentage. */
export function printAtLeast(atLeast: string, lang: RegimeLang): string {
  const v = Number(atLeast);
  if (!Number.isFinite(v)) return atLeast;
  return new Intl.NumberFormat(lang === "ro" ? "ro-RO" : "en-GB", {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(v);
}

/** The command bar's ONE regime line: the served label and the finding,
 *  with the finding's net 711 and net turnover figures printed by the
 *  caller's money printer (the bar prints in the currency the engine served
 *  the period in). An unmeasured figure prints its status word. */
export function regimeLine(
  regime: CreditRegime,
  lang: RegimeLang,
  print: (value: number) => string,
): string | null {
  if (!regime.finding) return null;
  const notMeasured = lang === "ro" ? "nemăsurat" : "not measured";
  const figs = regime.finding.figures
    .filter((f) => f.key === "net_711" || f.key === "net_turnover")
    .map((f) => `${f.label[lang]}: ${f.value === null ? notMeasured : print(f.value)}`);
  return `${regime.label[lang]}. ${regime.finding.text[lang]}${figs.length ? ` ${figs.join(" · ")}.` : ""}`;
}

/** A served regime amount printed in the currency it was SERVED in, with
 *  that currency's code (lib/money formatMoneyFrom, source = display — no
 *  rate is ever applied). */
export function printRegimeAmount(value: number, unit: string | null): string {
  const code = (unit || "RON").toUpperCase() as Currency;
  try {
    return formatMoneyFrom(value, code, code, {} as Rates);
  } catch {
    return `${value.toFixed(2)} ${code}`;
  }
}

/** The regime as the printed documents state it (the exported report, the
 *  workbook): the label, the finding and every finding figure, English — the
 *  documents' language — each figure in its served currency, an unmeasured
 *  one by its status. One sentence, never a second computation. */
export function regimeDocumentText(regime: CreditRegime): string {
  const f = regime.finding;
  const figs = (f?.figures ?? []).map(
    (x) => `${x.label.en}: ${x.value === null ? `not measured (${x.status})` : printRegimeAmount(x.value, x.unit)}`,
  );
  const cash = regime.cash?.refusal ? ` ${regime.cash.refusal.text.en}` : "";
  return `${regime.label.en}. ${f ? f.text.en : ""}${figs.length ? ` ${figs.join(" · ")}.` : ""}${cash}`.trim();
}
