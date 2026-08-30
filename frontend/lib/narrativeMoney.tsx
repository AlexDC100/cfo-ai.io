// narrativeMoney — ONE CURRENCY PER RENDERED CLAIM, structurally.
//
// ── The defect this exists to make impossible ───────────────────────────
//
// The Critical-461 note rendered, in production:
//
//   "Account 461 (Debitori diverși) holds RON 7,692,203 — 19.6% of total
//    assets 7.467.122,25 €"
//
// A native RON figure beside a display-converted EUR figure inside ONE
// claim. The 19.6% was correct and native-native; the harm was that the
// sentence made a correct ratio look like cross-currency arithmetic and
// left the reader no way to verify it.
//
// The cause is a rendering-boundary mismatch, not a maths bug. An alert
// body is AUTHORED as a plain string in the source currency. At render
// time some of its figures pass through a converting renderer and some do
// not; whichever miss keep their source magnitude AND their source label.
//
// `linkifyAlertBody` contained that (c05eab2) by routing every recognised
// cited money fact through the currency path. But recognition there is a
// GUESS over rendered text: a regex that requires comma grouping (so a
// ro-RO `toLocaleString()` string never matches), refuses a leading "-"
// (so every negative money fact — losses, outflows, negative equity — is
// permanently unconvertible), and treats "anything >= 1000" as money.
//
// ── What this module does instead ───────────────────────────────────────
//
// The engine, the only layer that actually knows which of its facts are
// money, now emits a TEMPLATE that names the fact rather than a formatted
// number, plus a declared unit per fact:
//
//   body_template : "…holds {{money:intercompany_loans}} — 19.6% of total
//                    assets {{money:total_assets}}."
//   fact_units    : { intercompany_loans: "money", total_assets: "money",
//                     pct_of_assets: "percent" }
//
// See `src/engine/api/_ratio_units.py`. Rendering resolves every named
// fact through the SAME money path, so a claim cannot straddle the
// conversion boundary any more. Four rules hold this up:
//
//   1. NAMED, NOT GUESSED. Only facts the template names are money. A
//      number the template did not name is left as literal text — we
//      cannot assert it is money, and guessing a currency onto it is the
//      same class of error.
//   2. ALL OR NOTHING. If any named fact is absent, the template is
//      refused whole and the stored plain text renders instead. ABSENT !=
//      ZERO, and a half-resolved sentence is exactly the mixed claim we
//      are removing. (The engine guarantees `render_native(template) ===
//      body` byte-for-byte, so the fallback is never a downgrade in
//      accuracy — only in display currency.)
//   3. NEVER CONVERT A RATIO. Percentages, multiples, day counts and
//      scores are dimensionless: they render natively, always.
//   4. NO RATE, NO SILENCE. When a rate is missing the figure renders in
//      its NATIVE currency with an explicit label plus a short note. It
//      is never quietly mixed in beside converted siblings.
//
// Legacy rows (written before templates) have no `template`; they fall
// back to `linkifyAlertBody`, which keeps the c05eab2 behaviour intact.

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import "@/lib/narrativeMoneyI18n";
import { formatMoneyFrom } from "@/lib/money";
import type { Currency, Rates } from "@/lib/rates";
import { useCurrency } from "@/stores/currency";
import { TraceableNumber } from "@/components/cfo/TraceableNumber";
import { FACT_TO_SOURCE, linkifyAlertBody } from "@/lib/linkifyAlertBody";
import type { TraceableSource } from "@/lib/traceableSource";

/** Unit vocabulary, mirroring `engine/api/_ratio_units.py`. `unknown` is a
 *  refusal, never a default — an undeclared fact is not assumed to be
 *  money. */
export type NarrativeUnit =
  | "money"
  | "ratio"
  | "percent"
  | "days"
  | "count"
  | "score"
  | "unknown";

export type NarrativeFacts = Record<string, number> | null | undefined;
export type NarrativeUnits = Record<string, string> | null | undefined;

/** A resolved template. `text` parts are inert; `money` parts are the
 *  only ones that touch the conversion path. */
export type NarrativePart =
  | { kind: "text"; value: string }
  | {
      kind: "money";
      fact: string;
      /** Source-currency amount, with `|abs` already applied so the part
       *  carries the sign the sentence was written around. */
      value: number;
      decimals: number;
      /** Where a click on this figure navigates, when the fact maps to a
       *  statement row. Clickability and currency are independent: a fact
       *  with nowhere to jump to still renders through the money path.
       *  Conflating the two is what produced the 461 note. */
      source?: TraceableSource;
    };

const PLACEHOLDER_RX =
  /\{\{(money|fact|ratio|percent|days|count|score):([A-Za-z0-9_]+)((?:\|[a-z0-9]+)*)\}\}/g;

const DIMENSIONLESS: NarrativeUnit[] = ["ratio", "percent", "days", "count", "score"];

function unitFor(
  token: string,
  fact: string,
  factUnits: NarrativeUnits,
): NarrativeUnit {
  if (token !== "fact") return token as NarrativeUnit;
  const declared = factUnits?.[fact];
  if (declared === "money") return "money";
  if (declared && (DIMENSIONLESS as string[]).includes(declared)) {
    return declared as NarrativeUnit;
  }
  return "unknown";
}

/** Trim a dimensionless value for prose: honour an explicit `dN`, else
 *  print it as it is. We never invent precision on a ratio. */
function formatDimensionless(
  value: number,
  unit: NarrativeUnit,
  decimals: number | null,
): string {
  const n = decimals === null ? String(value) : value.toFixed(decimals);
  return unit === "percent" ? `${n}%` : n;
}

/**
 * Resolve a template into parts, or `null` to mean "refuse — render the
 * stored plain text instead".
 *
 * Refusals (all of them deliberate, none of them recoverable by guessing):
 *   · no template, or no facts at all
 *   · a named fact is absent or not a finite number
 *   · a `{{fact:…}}` whose unit was never declared
 */
export function parseNarrativeTemplate(
  template: string | null | undefined,
  facts: NarrativeFacts,
  factUnits?: NarrativeUnits,
): NarrativePart[] | null {
  if (!template) return null;
  if (!facts || Object.keys(facts).length === 0) return null;

  const parts: NarrativePart[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const rx = new RegExp(PLACEHOLDER_RX.source, "g");

  while ((match = rx.exec(template)) !== null) {
    const [full, token, fact, rawOpts] = match;
    const raw = facts[fact];
    if (typeof raw !== "number" || !Number.isFinite(raw)) return null;

    const unit = unitFor(token, fact, factUnits);
    if (unit === "unknown") return null;

    const opts = rawOpts ? rawOpts.split("|").filter(Boolean) : [];
    const decOpt = opts.find((o) => /^d\d+$/.test(o));
    const decimals = decOpt ? Number(decOpt.slice(1)) : null;

    if (match.index > lastIndex) {
      parts.push({ kind: "text", value: template.slice(lastIndex, match.index) });
    }

    if (unit === "money") {
      parts.push({
        kind: "money",
        fact,
        value: opts.includes("abs") ? Math.abs(raw) : raw,
        decimals: decimals ?? 0,
        source: FACT_TO_SOURCE[fact],
      });
    } else {
      // Dimensionless: never converted, never labelled with a currency.
      parts.push({ kind: "text", value: formatDimensionless(raw, unit, decimals) });
    }
    lastIndex = match.index + full.length;
  }

  if (parts.length === 0) return null;
  if (lastIndex < template.length) {
    parts.push({ kind: "text", value: template.slice(lastIndex) });
  }
  return parts;
}

export interface MoneyDisplay {
  /** What the reader sees. */
  text: string;
  /** False when no usable rate exists — `text` is then NATIVE and
   *  labelled, and the caller must say so. */
  convertible: boolean;
  /** Hover copy: the native value and the rate it was displayed at. */
  provenance: string;
  /** Currency `text` is denominated in. */
  currency: Currency;
}

function rateBetween(
  source: Currency,
  display: Currency,
  rates: Rates | null | undefined,
): number | null {
  if (!rates) return null;
  const src = rates[source];
  const dst = rates[display];
  if (typeof src !== "number" || !Number.isFinite(src) || src === 0) return null;
  if (typeof dst !== "number" || !Number.isFinite(dst)) return null;
  // Rates are EUR-base (X units per 1 EUR). "1 <display> = N <source>".
  return src / dst;
}

function trimRate(n: number): string {
  return String(Number(n.toFixed(4)));
}

/**
 * Format one money figure for display, and state where the number came
 * from. Pure: every input is explicit so this is testable without React.
 *
 * Missing rate → NATIVE with its own currency label. Never a silent mix,
 * never a dropped label, never a zero.
 */
export function resolveMoneyDisplay(
  value: number,
  sourceCurrency: Currency,
  displayCurrency: Currency,
  rates: Rates | null | undefined,
  asOf?: string | null,
  /** Decimals for the DISPLAYED figure — the engine's rules print whole
   *  units, so a templatized body passes 0 and the sentence reads as
   *  authored. The provenance is unaffected. */
  fractionDigits = 2,
): MoneyDisplay {
  // The provenance always quotes the EXACT cited fact, at full precision —
  // the prose may round to whole units, but "where did this come from" is
  // answered with the number the engine actually holds.
  const native = formatMoneyFrom(value, sourceCurrency, sourceCurrency, rates ?? ({} as Rates), {
    fractionDigits: 2,
  });

  if (sourceCurrency === displayCurrency) {
    return {
      text: native,
      convertible: true,
      provenance: i18n.t("nm.nativeOnly", { native }),
      currency: sourceCurrency,
    };
  }

  const rate = rateBetween(sourceCurrency, displayCurrency, rates);
  if (rate === null) {
    return {
      text: native,
      convertible: false,
      provenance: i18n.t("nm.noRate", {
        source: sourceCurrency,
        display: displayCurrency,
      }),
      currency: sourceCurrency,
    };
  }

  const key = asOf ? "nm.provenanceDated" : "nm.provenance";
  return {
    text: formatMoneyFrom(value, sourceCurrency, displayCurrency, rates as Rates, {
      fractionDigits,
    }),
    convertible: true,
    provenance: i18n.t(key, {
      native,
      display: displayCurrency,
      source: sourceCurrency,
      rate: trimRate(rate),
      asOf: asOf ?? "",
    }),
    currency: displayCurrency,
  };
}

interface NarrativeTextProps {
  /** The stored plain-text body/title. Always required — it is the
   *  fallback, and for legacy rows it is the only thing there is. */
  text: string | null | undefined;
  /** Engine-emitted template naming facts instead of digits. */
  template?: string | null;
  facts?: NarrativeFacts;
  factUnits?: NarrativeUnits;
  /** Currency the facts are denominated in (the period's own). */
  sourceCurrency?: Currency;
  className?: string;
}

/**
 * Render a narrative claim with every money figure on ONE side of the
 * conversion boundary.
 *
 * With a template: figures resolve from named facts.
 * Without one (or with an incomplete one): the stored plain text renders
 * through `linkifyAlertBody`, preserving today's behaviour for rows
 * written before templates existed.
 */
export function NarrativeText({
  text,
  template,
  facts,
  factUnits,
  sourceCurrency = "RON",
  className,
}: NarrativeTextProps): ReactNode {
  const { display, rates } = useCurrency();
  // Subscribed, not read once: a language switch must re-render the
  // provenance copy computed below, which reads the i18n singleton.
  const { t } = useTranslation();
  const parts = parseNarrativeTemplate(template, facts, factUnits);

  if (!parts) {
    // Legacy row, or a template we refuse to half-render.
    return linkifyAlertBody(text ?? "", facts);
  }

  let anyNative = false;
  const nodes = parts.map((part, i) => {
    if (part.kind === "text") return <span key={i}>{part.value}</span>;

    const resolved = resolveMoneyDisplay(
      part.value,
      sourceCurrency,
      display,
      rates?.rates,
      rates?.as_of,
      part.decimals,
    );
    if (!resolved.convertible) anyNative = true;

    return (
      <span
        key={i}
        data-narrative-money={part.fact}
        data-narrative-currency={resolved.currency}
        title={resolved.provenance}
        className={
          resolved.convertible
            ? "text-ink font-medium"
            : "text-ink font-medium underline decoration-dotted underline-offset-2"
        }
      >
        {part.source ? (
          <TraceableNumber
            value={part.value}
            format="currency"
            source={part.source}
            sourceCurrency={sourceCurrency}
          >
            {resolved.text}
          </TraceableNumber>
        ) : (
          resolved.text
        )}
      </span>
    );
  });

  return (
    <span className={className}>
      {nodes}
      {anyNative && (
        <span className="text-ink-mute">
          {" "}
          {t("nm.noRateNote", { source: sourceCurrency, display })}
        </span>
      )}
    </span>
  );
}

/**
 * Format one entry of a `facts_cited` map for the "Facts backing this
 * alert" expander, BY ITS DECLARED UNIT.
 *
 * What this replaces, live on two surfaces today:
 *
 *     typeof v === "number" && Math.abs(v) > 1 ? fmt(v) : String(v)
 *
 * That guess currency-formats and FX-converts every fact over 1, so
 * `debt_to_ebitda: 8.5` renders as "€1.62" and `threshold: 12.0` as
 * "€2.29" — a conversion participating in a ratio, in the one panel a
 * reader opens precisely to check the arithmetic.
 *
 * Declared money converts. Declared anything-else never does. An
 * UNDECLARED fact keeps the legacy guess: rows written before units
 * shipped must not regress on their money figures, and they become exact
 * on the next pipeline run. That fallback is a bridge, not a rule.
 */
export function formatCitedFact(
  name: string,
  value: unknown,
  factUnits: NarrativeUnits,
  formatMoney: (v: number) => string,
): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return String(value);
  const declared = factUnits?.[name];
  if (declared === "money") return formatMoney(value);
  if (declared) return String(value);
  return Math.abs(value) > 1 ? formatMoney(value) : String(value);
}
