// AccountChip — shared presentation helpers for the statement views
// (PLStatementView / BSStatementView / CashFlowStatementView).
//
// 2026-08-04 tables redesign:
//   · <AccountChip code="706" /> renders a RAS account code as a small
//     muted mono chip AFTER the human label — a non-accountant's eye
//     skips it, an accountant still sees it. One helper, all three views.
//   · splitAccountParen() peels a trailing "(706/704/707)"-style code
//     list off labels that arrive as combined strings from the lib
//     builders (which we deliberately do NOT change). Only pure code
//     lists are split — parenthesized prose ("(208 net of 2808)") is
//     left in the label untouched.
//   · <StatementCurrencyChip /> names the SOURCE currency of a
//     statement's figures in the header, so a converted display
//     currency never leaves the underlying denomination ambiguous.
//
// Presentation only — no numbers are computed or re-formatted here.

import { useTranslation } from "react-i18next";

/** Small muted mono chip for a RAS account code (e.g. "706", "60x",
 *  "6811", "ct. 121", "281x/29x"). Renders nothing without a code. */
export function AccountChip({ code }: { code?: string | null }) {
  if (!code) return null;
  return (
    <span
      className="acct-chip ml-1.5 inline-flex items-center whitespace-nowrap rounded bg-bg-2 px-[5px] py-px align-baseline font-mono text-[10px] font-medium leading-[13px] tracking-[0.02em] text-ink-mute transition-colors duration-150 motion-reduce:transition-none"
      data-testid="account-chip"
    >
      {code}
    </span>
  );
}

// A "pure code list": one or more account codes ("706", "60x", "ct. 121",
// "4118-491") joined by / , + or whitespace — and nothing else. Prose
// inside the parens ("combined", "net of", "incl. …") fails the test and
// the label is returned untouched.
const CODE_TOKEN = String.raw`(?:ct\.?\s*)?\d{2,4}x?`;
const CODE_LIST_RE = new RegExp(
  `^${CODE_TOKEN}(?:\\s*[\\/,+\\-–]\\s*${CODE_TOKEN})*$`,
  "i",
);

/** Split a trailing parenthesized account-code list off a combined label.
 *  "Other operating income (758)"  → { text: "Other operating income", code: "758" }
 *  "Cost of goods sold (601/602/607)" → { text: "Cost of goods sold", code: "601/602/607" }
 *  "Intangibles (208 net of 2808)" → { text: <unchanged>, code: undefined } */
export function splitAccountParen(label: string): { text: string; code?: string } {
  const m = /^(.*\S)\s*\(([^()]+)\)\s*$/.exec(label);
  if (m && CODE_LIST_RE.test(m[2].trim())) {
    return { text: m[1], code: m[2].trim() };
  }
  return { text: label };
}

/** Header chip naming the SOURCE currency of the statement's figures
 *  (typically RON). The display-currency toggle may convert what is
 *  rendered; this chip pins down what the underlying data is
 *  denominated in. */
export function StatementCurrencyChip({ currency }: { currency: string }) {
  const { t } = useTranslation();
  if (!currency) return null;
  return (
    <span
      className="inline-flex items-center whitespace-nowrap rounded-full border border-rule bg-bg-2 px-2 py-[2px] font-mono text-[10px] font-medium uppercase not-italic tracking-[0.08em] text-ink-mute"
      title={t("tablesV2.sourceCurrencyTooltip", "Source currency of the underlying figures")}
      data-testid="stmt-source-currency"
    >
      {currency}
    </span>
  );
}
