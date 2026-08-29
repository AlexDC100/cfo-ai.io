// Deterministic jargon annotator for DATA-BORNE text (Simple mode).
//
// M3's static lint covers the strings WE ship; engine recommendation
// titles/rationales arrive at runtime carrying bare jargon ("Stand up
// monthly DSCR / Debt-EBITDA monitoring…"). This annotator wraps the
// FIRST occurrence of each glossary-known term in <Term> so a
// non-financial owner can tap it — and changes nothing else: unknown
// jargon stays verbatim (honest), casing and punctuation are preserved,
// and the output is pure presentation over the same string.
//
// Dictionary-driven, no model call. Matching is word-boundary and
// case-insensitive; multi-word phrases are matched before their
// substrings ("working capital" before "capital").

import { Fragment, ReactNode } from "react";

import { GLOSSARY } from "@/lib/glossary";
import { Term } from "@/components/instrument/Term";

/** Surface spellings -> glossary ids. Longest-first at build time so a
 *  phrase can never lose to its own substring. */
const SURFACE_FORMS: Array<[string, string]> = [
  ["working capital", "working_capital"],
  ["capital de lucru", "working_capital"],
  ["net debt", "net_debt"],
  ["datorie netă", "net_debt"],
  ["datoria netă", "net_debt"],
  ["gross margin", "gross_margin"],
  ["marjă brută", "gross_margin"],
  ["net margin", "net_margin"],
  ["marjă netă", "net_margin"],
  ["cash flow", "cash_flow"],
  ["flux de numerar", "cash_flow"],
  ["current ratio", "current_ratio"],
  ["lichiditate curentă", "current_ratio"],
  ["credit class", "credit_class"],
  ["clasă de credit", "credit_class"],
  ["net profit", "net_profit"],
  ["profit net", "net_profit"],
  ["covenants", "covenant"],
  ["covenant", "covenant"],
  ["leverage", "leverage"],
  ["îndatorare", "leverage"],
  ["liquidity", "liquidity"],
  ["lichiditate", "liquidity"],
  ["receivables", "receivables"],
  ["creanțe", "receivables"],
  ["payables", "payables"],
  ["inventory", "inventory"],
  ["stocuri", "inventory"],
  ["depreciation", "depreciation"],
  ["amortizare", "depreciation"],
  ["valuation", "valuation"],
  ["evaluare", "valuation"],
  ["equity", "equity"],
  ["EBITDA", "ebitda"],
  ["DSCR", "dscr"],
  ["DSO", "dso"],
  ["DIO", "dio"],
  ["DPO", "dpo"],
  ["capex", "capex"],
  ["margin", "margin"],
  ["marjă", "margin"],
  ["revenue", "revenue"],
].sort((a, b) => b[0].length - a[0].length);

// \b is ASCII-only — "netă" ends in a non-\w char, so a trailing \b
// can never match and every diacritic-final Romanian form silently
// fails. Unicode letter/number lookarounds are the real word boundary.
const PATTERN = new RegExp(
  "(?<![\\p{L}\\p{N}])(" +
    SURFACE_FORMS.map(([f]) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") +
    ")(?![\\p{L}\\p{N}])",
  "giu",
);

function idFor(surface: string): string | null {
  const lower = surface.toLowerCase();
  for (const [form, id] of SURFACE_FORMS) {
    if (form.toLowerCase() === lower) return GLOSSARY[id] ? id : null;
  }
  return null;
}

/** Wrap the first occurrence of each known term in <Term>, verbatim
 *  label. Absent/empty input -> empty output; unknown ids untouched. */
export function annotateTerms(text: string | null | undefined): ReactNode {
  if (!text) return null;
  const seen = new Set<string>();
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(PATTERN)) {
    const surface = m[0];
    const id = idFor(surface);
    const start = m.index ?? 0;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (start > last) out.push(<Fragment key={key++}>{text.slice(last, start)}</Fragment>);
    out.push(
      <Term key={key++} id={id}>
        {surface}
      </Term>,
    );
    last = start + surface.length;
  }
  if (last < text.length) out.push(<Fragment key={key++}>{text.slice(last)}</Fragment>);
  return out.length ? <>{out}</> : text;
}
