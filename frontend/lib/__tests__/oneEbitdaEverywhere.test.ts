/**
 * C9 — ONE METRIC NAME, ONE FORMULA, ACROSS EVERY SURFACE.
 *
 * ── WHAT HAPPENED ───────────────────────────────────────────────────────
 *
 * The dashboard P&L and the Forecast stated two EBITDAs for the same
 * period. On Scandia: 42,797,225.01 against 54,443,833.33 — every EBITDA
 * ratio 27% apart, on one screen, for one company.
 *
 * The engine has ONE definition. `assembled_pl.ebitda` equals
 * `revenue − cogs − opex + other_operating_income` to the cent on every
 * corpus book, and the forecast's `PlHistory` reads that key. The
 * frontend derived its own from `total_operating_revenue`, which EXCLUDES
 * account 758.
 *
 * On the retail book the two definitions differ in SIGN: the engine
 * serves +220,162.84 and the old derivation gives −506,705.80. A verdict
 * built on one is the opposite of a verdict built on the other.
 *
 * The existing one-concept-one-value gates check WITHIN a document. This
 * one checks ACROSS surfaces, which is where it went wrong.
 *
 * ── WHAT IT REDS ON (TC-11) ─────────────────────────────────────────────
 *   · the frontend deriving EBITDA when the engine served one;
 *   · the fallback derivation drifting from the engine's formula;
 *   · `total_operating_revenue` being used as an EBITDA base again.
 * ── WHAT IT CANNOT SEE ──────────────────────────────────────────────────
 *   · whether the definition is the RIGHT one. That is a judgement about
 *     account 758's recurrence, deliberately deferred; the earnings-
 *     quality detector already surfaces non-trading income inside EBITDA.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildPLStatementFromAggregates, EBITDA_COMPOSITION_NOTE } from "@/lib/buildPlStatement";
import type { Statements } from "@/lib/financialReport";

const REPO = resolve(__dirname, "../../..");
const BOOKS = ["agras", "carniprod", "retail"] as const;

function capture(name: string) {
  return JSON.parse(
    readFileSync(resolve(REPO, `tests/engine/fixtures/firm/saga_10_col_${name}.json`), "utf-8"),
  ) as { statements: Record<string, Record<string, number>> };
}

describe("C9 — one EBITDA", () => {
  it("the engine's own definition includes other operating income", () => {
    // The measurement the rest of this file stands on. RED ON: the engine
    // changing its composition without this file being reread.
    for (const name of BOOKS) {
      const pl = capture(name).statements.assembled_pl;
      const derived =
        (pl.revenue ?? 0) - (pl.cogs ?? 0) - (pl.opex_excluding_cogs_and_da ?? 0) +
        (pl.other_operating_income ?? 0);
      expect(
        Math.abs((pl.ebitda ?? 0) - derived),
        `${name}: assembled_pl.ebitda is ${pl.ebitda}, and ` +
          `revenue − cogs − opex + other_operating_income is ${derived}`,
      ).toBeLessThan(0.02);
    }
  });

  it("the two definitions differ in SIGN on a real book", () => {
    // Not a curiosity — it is why this cannot be left to "close enough".
    const pl = capture("retail").statements.assembled_pl;
    const withoutOther =
      (pl.revenue ?? 0) - (pl.cogs ?? 0) - (pl.opex_excluding_cogs_and_da ?? 0);
    expect(pl.ebitda).toBeGreaterThan(0);
    expect(withoutOther).toBeLessThan(0);
  });

  it("the statement builder renders the SERVED figure, not its own", () => {
    for (const name of BOOKS) {
      const fx = capture(name);
      const served = fx.statements.assembled_pl.ebitda as number;
      const statements = {
        ...fx.statements,
        incomeStatement: {
          revenue: fx.statements.assembled_pl.revenue,
          costOfGoodsSold: fx.statements.assembled_pl.cogs,
          operatingExpenses: fx.statements.assembled_pl.opex_excluding_cogs_and_da,
          otherIncome: fx.statements.assembled_pl.other_operating_income,
          depreciationAmortization: fx.statements.assembled_pl.depreciation,
          ebitda: served,
        },
      } as unknown as Statements;
      const built = buildPLStatementFromAggregates(statements, undefined, served);
      expect(
        Math.abs(built.ebitda - served),
        `${name}: the P&L renders ${built.ebitda}; the engine serves ${served}. ` +
          `Two EBITDAs for one period is what this gate exists to stop.`,
      ).toBeLessThan(0.02);
    }
  });

  it("the fallback derivation uses the engine's formula, so it cannot drift", () => {
    // With NO served figure, the builder must still land on the engine's
    // number — otherwise a payload missing the key silently reintroduces
    // the divergence.
    const fx = capture("retail");
    const served = fx.statements.assembled_pl.ebitda as number;
    const statements = {
      ...fx.statements,
      incomeStatement: {
        revenue: fx.statements.assembled_pl.revenue,
        costOfGoodsSold: fx.statements.assembled_pl.cogs,
        operatingExpenses: fx.statements.assembled_pl.opex_excluding_cogs_and_da,
        otherIncome: fx.statements.assembled_pl.other_operating_income,
        depreciationAmortization: fx.statements.assembled_pl.depreciation,
      },
    } as unknown as Statements;
    const built = buildPLStatementFromAggregates(statements, undefined, null);
    expect(Math.abs(built.ebitda - served)).toBeLessThan(0.02);
  });

  it("what EBITDA includes is stated, not left to the reader to infer", () => {
    expect(EBITDA_COMPOSITION_NOTE).toMatch(/other operating income/i);
    expect(EBITDA_COMPOSITION_NOTE).toMatch(/758/);
  });

  it("the comment that stated the opposite of the engine is gone", () => {
    const src = readFileSync(resolve(REPO, "frontend/lib/buildPlStatement.ts"), "utf-8");
    expect(
      src.includes("EBITDA downstream uses this exact figure"),
      "the comment justified a derivation that disagreed with the engine on " +
        "every book; leaving it would tell the next reader the defect is the rule",
    ).toBe(false);
  });
});
