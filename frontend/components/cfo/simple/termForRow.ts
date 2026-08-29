// THE DIAL — statement-row → glossary-id mapping (Simple mode).
//
// The statement builders mark rows with stable Traceable bucket keys and
// RAS account codes; this module maps the OBVIOUS ones onto glossary ids
// so Simple mode can wrap their labels in <Term> (dotted ink underline +
// plain-language tooltip). Anything not listed here renders verbatim with
// no affordance — never a dead underline (the <Term> contract).
//
// Deliberately small: only rows whose meaning the 20-entry dictionary
// actually covers. Do NOT guess ids — an unknown id in <Term> is safe
// (renders verbatim), but a WRONG id attaches the wrong explanation.

const BUCKET_TERM: Record<string, string> = {
  revenue: "revenue",
  netIncomeOperational: "net_profit",
  netIncome: "net_profit",
  currentYearNetProfit: "net_profit",
  depreciationAmortization: "depreciation",
  accountsReceivable: "receivables",
  accountsPayable: "payables",
  totalEquity: "equity",
};

const ACCOUNT_TERM: Record<string, string> = {
  "6811": "depreciation",
  "4111": "receivables",
  "401": "payables",
  "301": "inventory",
  "345": "inventory",
  "371": "inventory",
};

/** Glossary id for a statement row, from its bucket first (stable), then
 *  its RAS account code. Null when the dictionary has nothing for it. */
export function termForRow(
  bucket?: string | null,
  accountCode?: string | null,
): string | null {
  if (bucket && BUCKET_TERM[bucket]) return BUCKET_TERM[bucket];
  if (accountCode && ACCOUNT_TERM[accountCode]) return ACCOUNT_TERM[accountCode];
  return null;
}
