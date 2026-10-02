// THE ONE CHECK of the net-provisions row, shared by every law that reads a
// surface printing it (owner ruling R2, 2026-09-28; coordinator ruling D2,
// 2026-10-02): ANY ACCOUNT ARITHMETIC IN THE ROW'S FULL TEXT EVALUATES TO THE
// FIGURE THE ROW PRINTS.
//
// The engine serves net provisions as a CHARGE under the arithmetic "6812 +
// 6814 − 7812 − 7814". A surface may print the charge (the P&L tab's row, its
// compare cells, the bridge after EBITDA) or the EFFECT on the result (a
// column that sums to the operating result: the reconciliation chain,
// /report §2, the printed report, the workbook) — but then the arithmetic it
// states must be the effect's, "7812 + 7814 − 6812 − 6814". Three review
// rounds each found a surface printing one figure under the other's
// arithmetic, and one printing BOTH arithmetics on one row; each earlier law
// read one named element (`[data-recon-accounts]`) and so stayed green while
// the label beside it said the opposite. This reads the WHOLE text.
//
// Test-only: nothing here formats or computes a figure a reader sees.

const MINUS = "−";

type Rec = Record<string, unknown>;

/** Every account-arithmetic expression in `text`: two or more 4-digit
 *  account prefixes joined by "+" / "−" (an optional leading "−"). A code
 *  list ("68x excl. 6812, 6814") is not arithmetic and is not matched. */
export function arithmeticsIn(text: string): string[] {
  const rx = /(?:−\s*)?\d{4}(?:\s*[+−]\s*\d{4})+/g;
  return (text.match(rx) ?? []).map((m) => m.trim());
}

/** The served by-account amounts of a `net_provisions/1` block. */
function amountsOf(block: Rec): Map<string, number> {
  const out = new Map<string, number>();
  for (const side of ["charges", "reversals"] as const) {
    const by = (((block[side] as Rec) ?? {}).by_account ?? {}) as Record<string, number>;
    for (const [acct, v] of Object.entries(by)) out.set(acct, v);
  }
  return out;
}

/** Evaluate "a + b − c − d" over account prefixes, each replaced by the sum
 *  of the served by-account amounts under it, to the cent. Throws on a token
 *  that is neither an operator nor a prefix. */
export function evaluateArithmetic(expr: string, block: Rec): number {
  const amounts = amountsOf(block);
  const tokens = expr.replace(/−/g, " − ").replace(/\+/g, " + ").trim().split(/\s+/);
  let sign = 1;
  let total = 0;
  for (const tok of tokens) {
    if (tok === "+") { sign = 1; continue; }
    if (tok === MINUS) { sign = -1; continue; }
    if (!/^\d{3,6}$/.test(tok)) throw new Error(`"${tok}" in "${expr}" is not an account prefix`);
    let sum = 0;
    for (const [acct, v] of amounts) if (acct.startsWith(tok)) sum += v;
    total += sign * sum;
  }
  return Math.round(total * 100) / 100;
}

/** The sign a printed figure leads with: −1 for "−" (or an ASCII "-"), else
 *  +1. A zero prints no sign and reads +1. */
export function printedSign(text: string | null | undefined): 1 | -1 {
  const t = (text ?? "").trim();
  return t.startsWith(MINUS) || t.startsWith("-") ? -1 : 1;
}

export interface RowReading {
  /** Where the row was read (for the failure message). */
  surface: string;
  /** The row's FULL text — name, gloss, chips, everything but the figure. */
  text: string;
  /** The figure the row prints, exact (from the value the surface carries). */
  value: number;
  /** The figure as printed, when the surface prints a string. */
  printed?: string | null;
}

/** The law. Returns the problems found (empty = the row is consistent):
 *  every arithmetic in the text evaluates to the printed figure; the printed
 *  string's sign is the figure's; and — `expectArithmetic` — the row states
 *  at least one arithmetic at all (non-vacuity for surfaces that must). */
export function rowProblems(row: RowReading, block: Rec, expectArithmetic = true): string[] {
  const problems: string[] = [];
  const found = arithmeticsIn(row.text);
  if (expectArithmetic && found.length === 0) {
    problems.push(`${row.surface}: the row states no account arithmetic — "${row.text}"`);
  }
  for (const expr of found) {
    const evaluated = evaluateArithmetic(expr, block);
    if (Math.abs(evaluated - row.value) >= 0.005) {
      problems.push(
        `${row.surface}: "${expr}" evaluates to ${evaluated}, the row prints ${row.value} — "${row.text}"`,
      );
    }
  }
  if (row.printed != null && Math.abs(row.value) >= 0.005 && printedSign(row.printed) !== Math.sign(row.value)) {
    problems.push(`${row.surface}: printed "${row.printed}" for a figure of ${row.value}`);
  }
  return problems;
}
