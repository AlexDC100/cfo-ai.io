// THE BOOKS THE THREE A8 SURFACE GATES READ (one-ebitda, turnover-
// denominator, refusal-carries) — real engine output only.
//
//   · the four firm books, captured through the real write path and
//     `GET /api/period` (tests/engine/fixtures/firm/saga_10_col_*.json,
//     composed by exportBooks.statementsFor exactly as production serves
//     them), with their served metric rows;
//   · the seven CONSTRUCTED books of net-711-rule, sent through the real
//     write seam and route (fixtures/oneEbitda/constructed_books.json,
//     held live by tests/engine/test_one_ebitda_fe_books.py): the bridge,
//     no 711 postings with a 121 remainder, 72x beside a bridge (total
//     operating revenue ≠ turnover), an open book, and the three REFUSALS
//     (account 121 absent; its opening not cleared; 121 dropped from an
//     export, so total equity is short by the refused result).
//
// Every surface is fed the SAME payload the page is fed; nothing here
// computes an expected figure from the statements the code under test
// reads — the expectation is the served `assembled_pl` field itself.

import type { PeriodLineItem, PeriodMetric } from "@/lib/activePeriod";
import type { Statements } from "@/lib/financialReport";

import constructed from "./fixtures/oneEbitda/constructed_books.json";
import { BOOKS as FIRM, metricsFor, statementsFor, type Book } from "./exportBooks";

export interface SurfaceBook {
  name: string;
  statements: Statements;
  lineItems: PeriodLineItem[];
  /** Served metric rows by name (firm books); {} on the constructed books. */
  metrics: Record<string, number | null>;
  /** The served block, for the expectations. */
  apl: Record<string, unknown>;
}

type Body = { statements: Statements; line_items: PeriodLineItem[]; credit?: unknown };
const CONSTRUCTED = constructed as unknown as Record<string, Body>;

export const CONSTRUCTED_NAMES = Object.keys(CONSTRUCTED).sort();
export const REFUSED_NAMES = ["g6_uncleared", "unanchored", "unanchored_unbalanced"] as const;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export function firmBook(name: Book): SurfaceBook {
  const s = statementsFor(name) as Statements;
  return {
    name,
    statements: s,
    lineItems: [],
    metrics: metricsFor(name),
    apl: (s.assembled_pl ?? {}) as Record<string, unknown>,
  };
}

/** The served credit envelope (`assembled_metrics.credit`) of a
 *  constructed book, as the route served it. */
export function constructedCredit(name: string): unknown {
  return clone(CONSTRUCTED[name].credit ?? null);
}

export function constructedBook(name: string): SurfaceBook {
  const b = clone(CONSTRUCTED[name]);
  return {
    name,
    statements: b.statements,
    lineItems: b.line_items,
    metrics: {},
    apl: (b.statements.assembled_pl ?? {}) as Record<string, unknown>,
  };
}

/** Every book, firm first. */
export function allBooks(): SurfaceBook[] {
  return [...FIRM.map((b) => firmBook(b)), ...CONSTRUCTED_NAMES.map((n) => constructedBook(n))];
}

/** The books whose EBITDA the engine SERVED (not refused). */
export function servedBooks(): SurfaceBook[] {
  return allBooks().filter((b) => typeof b.apl.ebitda === "number");
}

export function refusedBooks(): SurfaceBook[] {
  return REFUSED_NAMES.map((n) => constructedBook(n));
}

export const metricRows = (m: Record<string, number | null>): PeriodMetric[] =>
  Object.entries(m).map(([name, value]) => ({ name, value, unit: null, direction: null }));

export const num = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`not a served number: ${String(v)}`);
  return v;
};

/** The served refusal of EBITDA on a refused book. */
export function servedRefusal(b: SurfaceBook): { code: string; text_en: string; text_ro: string } {
  const r = b.apl.ebitda_refusal as { code: string; text_en: string; text_ro: string } | undefined;
  if (!r) throw new Error(`${b.name} serves no ebitda_refusal`);
  return r;
}

/** The same book attached to itself as its prior period (a like-for-like
 *  pair on one definition: every bridge step 0, every level equal). */
export function pairedWithItself(b: SurfaceBook): Statements {
  const s = clone(b.statements);
  return {
    ...s,
    prior: {
      periodLabel: `${s.periodLabel} (prior)`,
      balanceSheet: s.balanceSheet,
      incomeStatement: s.incomeStatement,
      assembled_pl: s.assembled_pl,
    },
  };
}
