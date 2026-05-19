// linkifyAlertBody — turns recognised RON figures in an alert body
// string into clickable <TraceableNumber> elements.
//
// Engine-emitted alerts carry a `facts_cited: Record<string, number>`
// map alongside the human body text (e.g. `{ bank_debt: 14083316,
// statutory_ebitda: 2127404 }`). Where the alert body string mentions
// "RON 14,083,316" we recognise it as `bank_debt` and route a click on
// it to the BS row that carries that bucket. Where the fact name has
// no known bucket mapping (e.g. `affiliate_dependency_pct`), we leave
// the figure as inert text — no broken links, no surprises.
//
// Split into a pure parser (`parseLinkifiedBody`) + a thin React
// renderer (`linkifyAlertBody`). The parser returns a structured
// AST that's trivial to unit-test without a JSX runtime; the renderer
// walks the AST and emits inert text + <TraceableNumber> nodes.

import type { ReactNode } from "react";
import { TraceableNumber } from "@/components/cfo/TraceableNumber";
import type { TraceableSource } from "@/lib/traceableSource";

/** Maps an engine fact-name (e.g. "bank_debt") to a TraceableSource
 *  (statement + bucket) so a click on that value navigates to the
 *  correct BS / PL / CF row.
 *
 *  When a fact name has no entry here, the figure renders as plain
 *  text — no broken link risk. Adding a new mapping is a one-line
 *  change. */
export const FACT_TO_SOURCE: Record<string, TraceableSource> = {
  // Balance Sheet (Phase B targets — all wired)
  cash:                       { statement: "bs", bucket: "cash",                   hint: "Cash & equivalents (5121 + 5124 + 5311)" },
  accounts_receivable:        { statement: "bs", bucket: "accountsReceivable",     hint: "Trade receivables (4111)" },
  trade_receivables:          { statement: "bs", bucket: "accountsReceivable",     hint: "Trade receivables (4111)" },
  inventory:                  { statement: "bs", bucket: "inventory",              hint: "Inventory total" },
  total_current_assets:       { statement: "bs", bucket: "totalCurrentAssets",     hint: "Total current — BS section subtotal" },
  total_assets:               { statement: "bs", bucket: "totalAssets",            hint: "Total assets — BS grand total" },
  accounts_payable:           { statement: "bs", bucket: "accountsPayable",        hint: "Trade payables (401)" },
  short_term_debt:            { statement: "bs", bucket: "shortTermDebt",          hint: "Short-term bank credit (519)" },
  current_liabilities:        { statement: "bs", bucket: "totalCurrentLiabilities", hint: "Total current liabilities" },
  total_current_liabilities:  { statement: "bs", bucket: "totalCurrentLiabilities", hint: "Total current liabilities" },
  long_term_debt:             { statement: "bs", bucket: "longTermDebt",           hint: "LT bank loans (1621)" },
  lt_debt:                    { statement: "bs", bucket: "longTermDebt",           hint: "LT bank loans (1621)" },
  bank_debt:                  { statement: "bs", bucket: "longTermDebt",           hint: "Bank debt = LT bank loans (1621) + ST bank credit (519)" },
  total_debt:                 { statement: "bs", bucket: "longTermDebt",           hint: "Total debt = LT + ST" },
  total_equity:               { statement: "bs", bucket: "totalEquity",            hint: "Total equity — BS section subtotal" },
  equity:                     { statement: "bs", bucket: "totalEquity",            hint: "Total equity — BS section subtotal" },
  current_year_net_profit:    { statement: "bs", bucket: "currentYearNetProfit",   hint: "Current year net profit (121)" },

  // P&L (Phase C — PLStatementView wires data-traceable-target on
  // the EBITDA boxed line + section subtotals)
  revenue:                    { statement: "pl", bucket: "revenue",                hint: "Total operating revenue — P&L subtotal" },
  operating_revenue:          { statement: "pl", bucket: "revenue",                hint: "Total operating revenue — P&L subtotal" },
  ebitda:                     { statement: "pl", bucket: "ebitda",                 hint: "EBITDA — P&L (boxed)" },
  statutory_ebitda:           { statement: "pl", bucket: "ebitda",                 hint: "EBITDA — P&L (boxed)" },
  core_ebitda:                { statement: "pl", bucket: "ebitda",                 hint: "EBITDA — P&L (boxed)" },
  ebit:                       { statement: "pl", bucket: "ebit",                   hint: "EBIT — P&L subtotal" },
  net_income:                 { statement: "pl", bucket: "netIncomeOperational",   hint: "Net profit — operational" },
  net_profit:                 { statement: "pl", bucket: "netIncomeOperational",   hint: "Net profit — operational" },
  depreciation:               { statement: "pl", bucket: "depreciationAmortization", hint: "Depreciation & amortization (6811/6812)" },
  interest_expense:           { statement: "pl", bucket: "interestExpense",        hint: "Interest expense (666)" },
};

/** AST node emitted by `parseLinkifiedBody`. Either inert text or a
 *  resolved number + the TraceableSource it links to. */
export type LinkifiedPart =
  | { kind: "text"; value: string }
  | { kind: "link"; value: number; source: TraceableSource };

/** Pure parser: scans the body, matches RON figures against facts_cited
 *  within 0.5% tolerance, and emits a flat array of inert-text and
 *  link parts. Unit-testable without React.
 *
 *  Returns the body as a single text part when there are no matches —
 *  the renderer treats that as a fast path and emits the original
 *  string unchanged. */
export function parseLinkifiedBody(
  body: string,
  factsCited: Record<string, number> | null | undefined,
): LinkifiedPart[] {
  if (!factsCited || Object.keys(factsCited).length === 0) {
    return [{ kind: "text", value: body }];
  }

  // Build a value → fact-name lookup. Multiple facts can share a
  // value; first-wins in iteration order.
  const valueToFact = new Map<number, string>();
  for (const [name, value] of Object.entries(factsCited)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      const rounded = Math.round(value);
      if (!valueToFact.has(rounded)) valueToFact.set(rounded, name);
    }
  }

  // Matches: "RON 14,083,316" / "14,083,316 RON" / "RON 14,083,316.45"
  const RX = /(?:RON\s+)?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s+RON)?/g;

  const out: LinkifiedPart[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = RX.exec(body)) !== null) {
    const fullMatch = match[0];
    const numStr = match[1];
    const parsed = parseFloat(numStr.replace(/,/g, ""));

    if (!Number.isFinite(parsed) || parsed < 1000) {
      // Skip tiny numbers — likely percentages, dates, etc.
      continue;
    }

    // Match against facts_cited within 0.5% tolerance.
    let matchedFact: string | null = null;
    for (const [factValue, factName] of valueToFact) {
      const delta = Math.abs(factValue - parsed);
      const tol = Math.max(1, parsed * 0.005);
      if (delta < tol) {
        matchedFact = factName;
        break;
      }
    }

    const source: TraceableSource | undefined = matchedFact
      ? FACT_TO_SOURCE[matchedFact]
      : undefined;

    if (!source) {
      // No bucket mapping → leave as plain text. (The match still
      // advances lastIndex via the regex's exec, so surrounding
      // text is preserved when we flush at end-of-loop or end-of-body.)
      continue;
    }

    // Emit inert text before this match, then the link.
    // Decide whether "RON " prefix or " RON" suffix belongs to the
    // inert text on either side.
    let preEnd = match.index;
    let postStart = match.index + fullMatch.length;
    if (fullMatch.startsWith("RON ")) {
      preEnd = match.index + 4; // keep "RON " in the inert prefix
    } else if (fullMatch.endsWith(" RON")) {
      postStart = match.index + fullMatch.length - 4; // " RON" goes into post
    }
    if (preEnd > lastIndex) {
      out.push({ kind: "text", value: body.slice(lastIndex, preEnd) });
    }
    out.push({ kind: "link", value: parsed, source });
    lastIndex = postStart;
  }

  if (lastIndex < body.length) {
    out.push({ kind: "text", value: body.slice(lastIndex) });
  }

  if (out.length === 0) {
    // No matches at all — return single text part for the fast path.
    return [{ kind: "text", value: body }];
  }
  return out;
}

/** React renderer: parses the body, then emits inert text + clickable
 *  TraceableNumber elements. When the parser returns a single text
 *  part (no matches) we emit the string directly — zero React
 *  overhead for the common case. */
export function linkifyAlertBody(
  body: string,
  factsCited: Record<string, number> | null | undefined,
): ReactNode {
  const parts = parseLinkifiedBody(body, factsCited);
  if (parts.length === 1 && parts[0].kind === "text") return parts[0].value;

  return (
    <>
      {parts.map((part, i) =>
        part.kind === "text" ? (
          <span key={i}>{part.value}</span>
        ) : (
          <TraceableNumber
            key={i}
            value={part.value}
            format="currency"
            source={part.source}
            className="text-ink font-medium"
          />
        ),
      )}
    </>
  );
}
