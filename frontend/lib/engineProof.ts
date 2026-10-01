// engineProof — the ONE source of every accuracy number a public page prints.
//
// The landing said "eight calibration fixtures" in one sentence and "9 / 9"
// in the block beside it. Both were typed by hand, they counted different
// things, and neither carried a date. Nothing on a public page is typed any
// more: `scripts/build_engine_proof.py` RUNS the checks and writes
// `frontend/data/engineProof.json`; this module is the only reader, and the
// copy (landingStrings, the FAQ, the page meta) carries `{proof.…}` tokens
// that are filled from it.
//
// Three rules, each held by the gate `landing-proof`
// (lib/__tests__/landingProof.test.tsx):
//   · a printed accuracy number that is not in the JSON is a red;
//   · a digit typed into accuracy copy is a red — numbers arrive by token;
//   · a JSON measured on a different engine tree is a red (stale proof).
//
// Figures follow the reader's language (CLAUDE.md §26): "0.00 RON" in
// English, "0,00 RON" in Romanian — the ISO code after the figure, never
// "lei"; dates as "1 Oct 2026" / "1 oct. 2026".

import proofJson from "@/data/engineProof.json";
import coverageJson from "@/data/coverage.json";

export type ProofLang = "en" | "ro";

export type ProofCheckId =
  | "rerun_identical"
  | "balance_sheet_closes"
  | "net_income_equals_121"
  | "turnover_equals_filing"
  | "ebitda_variants_agree";

export interface ProofCheck {
  id: ProofCheckId;
  what_en: string;
  what_ro: string;
  how: string;
  subjects: number;
  subjects_kind: string;
  result: Record<string, number>;
  passed: boolean;
  measured_at: string;
}

export interface EngineProof {
  schema: string;
  measured_at: string;
  scope: string;
  real_books_total: number | null;
  engine: {
    parser_version: string;
    ebitda_definition: string;
    tree_roots: string[];
    tree_files: number;
    tree_sha256: string;
  };
  checks: ProofCheck[];
  formats: Record<string, number> | null;
  counts: { bvb_listings: number; bvb_listings_with_financials: number; how: string };
}

export const ENGINE_PROOF = proofJson as unknown as EngineProof;

/** The order the public pages print the checks in. */
export const PROOF_CHECK_ORDER: ProofCheckId[] = [
  "rerun_identical",
  "balance_sheet_closes",
  "net_income_equals_121",
  "turnover_equals_filing",
  "ebitda_variants_agree",
];

const langOf = (lang: string | null | undefined): ProofLang =>
  (lang ?? "").toLowerCase().startsWith("ro") ? "ro" : "en";

const localeOf = (lang: ProofLang): string => (lang === "ro" ? "ro-RO" : "en-US");

/** "1 Oct 2026" / "1 oct. 2026" — a date-only string, pinned to UTC so the
 *  day never slips in a timezone west of Greenwich. */
export function proofDate(iso: string, lang: string): string {
  const l = langOf(lang);
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(l === "ro" ? "ro-RO" : "en-GB", {
    day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
  }).format(d);
}

const int = (n: number, lang: ProofLang): string =>
  new Intl.NumberFormat(localeOf(lang), { maximumFractionDigits: 0 }).format(n);

/** A RON amount in the reader's language, code after the figure. */
const ron = (n: number, lang: ProofLang, digits: number): string =>
  `${new Intl.NumberFormat(localeOf(lang), {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  }).format(n)}\u00a0RON`;

const pct = (n: number, lang: ProofLang): string =>
  `${new Intl.NumberFormat(localeOf(lang), {
    minimumFractionDigits: 2, maximumFractionDigits: 4,
  }).format(n)}%`;

function checkById(id: ProofCheckId): ProofCheck {
  const c = ENGINE_PROOF.checks.find((x) => x.id === id);
  if (!c) throw new Error(`engineProof.json carries no check "${id}"`);
  return c;
}

function need(c: ProofCheck, key: string): number {
  const v = c.result[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`engineProof.json: ${c.id}.result.${key} is absent`);
  }
  return v;
}

interface CoverageRowLite {
  id: string;
  availability_en?: string;
  availability_ro?: string;
}

/** Every token the copy may use, formatted for `lang`. Built from the JSON
 *  on each call — there is no second place a number could come from. */
export function proofTokens(lang: string): Record<string, string> {
  const l = langOf(lang);
  const rerun = checkById("rerun_identical");
  const balance = checkById("balance_sheet_closes");
  const net = checkById("net_income_equals_121");
  const turnover = checkById("turnover_equals_filing");
  const ebitda = checkById("ebitda_variants_agree");

  const out: Record<string, string> = {
    "proof.date": proofDate(ENGINE_PROOF.measured_at, l),
    "proof.books": int(ENGINE_PROOF.real_books_total ?? 0, l),

    "rerun.books": int(need(rerun, "books_identical"), l),
    "rerun.subjects": int(rerun.subjects, l),
    "rerun.runs": int(need(rerun, "runs_per_book"), l),
    "replay.identical": int(need(rerun, "replay_cases_identical"), l),
    "replay.cases": int(need(rerun, "replay_cases"), l),
    "replay.real": int(need(rerun, "replay_cases_real_books"), l),
    "replay.constructed": int(need(rerun, "replay_cases_constructed"), l),

    "balance.exact": int(need(balance, "books_closing_exactly"), l),
    "balance.subjects": int(balance.subjects, l),
    "balance.surfaced": int(need(balance, "books_imbalance_surfaced"), l),
    "balance.zero": ron(need(balance, "exact_difference_ron"), l, 2),
    "drift.books": int(need(balance, "legacy_drift_books"), l),
    "drift.worst": pct(need(balance, "legacy_drift_worst_pct"), l),

    "net.equal": int(need(net, "books_equal_to_the_cent"), l),
    "net.subjects": int(net.subjects, l),

    "turnover.within": int(need(turnover, "books_within_tolerance"), l),
    "turnover.subjects": int(turnover.subjects, l),
    "turnover.tol": ron(need(turnover, "tolerance_ron"), l, 0),
    "turnover.unchecked": int(need(turnover, "books_not_checkable"), l),

    "ebitda.within": int(need(ebitda, "books_within_tolerance"), l),
    "ebitda.subjects": int(ebitda.subjects, l),
    "ebitda.tol": ron(need(ebitda, "tolerance_ron"), l, 0),
    "ebitda.variants": int(need(ebitda, "variants"), l),

    "bvb.listings": int(ENGINE_PROOF.counts.bvb_listings, l),
    "bvb.withFinancials": int(ENGINE_PROOF.counts.bvb_listings_with_financials, l),
  };
  for (const c of ENGINE_PROOF.checks) {
    out[`proof.date.${c.id}`] = proofDate(c.measured_at, l);
  }
  // Availability wording of a coverage row — coverage.json is the only
  // place it is written, so a plan bullet that mentions it reads it here.
  for (const row of (coverageJson as { rows: CoverageRowLite[] }).rows) {
    const text = l === "ro" ? row.availability_ro : row.availability_en;
    if (text) {
      out[`coverage.${row.id}.availability`] = text;
      out[`coverage.${row.id}.availability_lc`] = text.charAt(0).toLowerCase() + text.slice(1);
    }
  }
  return out;
}

/** A token is `{namespace.key}` — always dotted, so the landing's own
 *  `{privacy}` / `{terms}` / `{year}` placeholders are left alone. */
const TOKEN = /\{([a-z]+(?:\.[A-Za-z0-9_]+)+)\}/g;

/** True when `text` still carries a proof token. */
export function hasProofToken(text: string): boolean {
  TOKEN.lastIndex = 0;
  return TOKEN.test(text);
}

/** Fill every `{proof.…}` token in `text`. An unknown token THROWS: a typo
 *  must not reach a reader as "{rerun.boks}". */
export function fillProof(text: string, lang: string): string {
  if (!text.includes("{")) return text;
  const tokens = proofTokens(lang);
  return text.replace(TOKEN, (whole, key: string) => {
    const v = tokens[key];
    if (v === undefined) throw new Error(`unknown proof token ${whole}`);
    return v;
  });
}

/** Fill tokens through any JSON-like copy object, strings only. */
export function fillProofDeep<T>(value: T, lang: string): T {
  if (typeof value === "string") return fillProof(value, lang) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => fillProofDeep(v, lang)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = fillProofDeep(v, lang);
    }
    return out as T;
  }
  return value;
}

export interface ProofRow {
  id: ProofCheckId;
  /** "6 / 7" — books on which the check held, of the books examined. */
  value: string;
  /** What is checked, in the reader's language (from the JSON). */
  what: string;
  /** The date this check was measured, formatted. */
  measured: string;
  /** ISO date, for `<time datetime>`. */
  measuredIso: string;
}

/** The numerator each check's headline prints: the books on which the
 *  check held. Named per check, because each result block names it
 *  differently and a generic "first number" would be a guess. */
const HELD_KEY: Record<ProofCheckId, string> = {
  rerun_identical: "books_identical",
  balance_sheet_closes: "books_closing_exactly",
  net_income_equals_121: "books_equal_to_the_cent",
  turnover_equals_filing: "books_within_tolerance",
  ebitda_variants_agree: "books_within_tolerance",
};

export function proofRows(lang: string): ProofRow[] {
  const l = langOf(lang);
  return PROOF_CHECK_ORDER.map((id) => {
    const c = checkById(id);
    return {
      id,
      value: `${int(need(c, HELD_KEY[id]), l)} / ${int(c.subjects, l)}`,
      what: l === "ro" ? c.what_ro : c.what_en,
      measured: proofDate(c.measured_at, l),
      measuredIso: c.measured_at,
    };
  });
}
