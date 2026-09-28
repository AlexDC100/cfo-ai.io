/**
 * C9 — ONE METRIC NAME, ONE FORMULA, ACROSS EVERY SURFACE.
 *
 * ── WHAT HAPPENED ───────────────────────────────────────────────────────
 *
 * The dashboard P&L and the Forecast stated two EBITDAs for the same
 * period. On Scandia: 42,797,225.01 against 54,443,833.33 — every EBITDA
 * ratio 27% apart, on one screen, for one company.
 *
 * The engine has ONE definition. Since the owner's ruling of 2026-09-26 it
 * is `revenue − cogs − opex + other_operating_income + net 711 + net 72x`
 * (the stock variation — "Variația stocurilor de produse" — and own work
 * capitalised inside, 767 financial), to the cent on every corpus book;
 * `ebitda_before_stock_variation` is the same build-up without the two
 * components, and is the ONLY served figure allowed to differ from it. The
 * P&L tab used to derive its own EBITDA from the lines it had; it now prints
 * the served one, and a refused one as refused.
 *
 * On the retail book the old derivations differed in SIGN from the engine
 * (+220,162.84 against −506,705.80). A verdict built on one is the opposite
 * of a verdict built on the other.
 *
 * The existing one-concept-one-value gates check WITHIN a document. This
 * one checks ACROSS surfaces, which is where it went wrong.
 *
 * ── WHAT IT REDS ON (TC-11) ─────────────────────────────────────────────
 *   · the frontend deriving EBITDA when the engine served one, or when it
 *     REFUSED one (a refused EBITDA stays refused);
 *   · the payload-only derivation drifting from the engine's formula;
 *   · the engine's EBITDA leaving out the stock variation or own work
 *     capitalised again (the bridge books tell the two apart).
 * ── WHAT IT CANNOT SEE ──────────────────────────────────────────────────
 *   · whether the served figure is right: that is net-711-rule's job.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildPLStatementFromAggregates, EBITDA_COMPOSITION_NOTE } from "@/lib/buildPlStatement";
import { NOT_SERVED } from "@/lib/servedOneEbitda";
import type { Statements } from "@/lib/financialReport";

const REPO = resolve(__dirname, "../../..");
const BOOKS = ["agras", "carniprod", "retail"] as const;

function capture(name: string) {
  return JSON.parse(
    readFileSync(resolve(REPO, `tests/engine/fixtures/firm/saga_10_col_${name}.json`), "utf-8"),
  ) as { statements: Record<string, Record<string, number>> };
}

type ServedPl = Record<string, number> & {
  inventory_variation: { value: number | null };
  capitalized_own_work: { value: number | null };
};

describe("C9 — one EBITDA", () => {
  it("the engine's own definition: the build-up plus net 711 plus net 72x", () => {
    // The measurement the rest of this file stands on. RED ON: the engine
    // changing its composition without this file being reread.
    for (const name of BOOKS) {
      const pl = capture(name).statements.assembled_pl as unknown as ServedPl;
      const before =
        (pl.revenue ?? 0) - (pl.cogs ?? 0) - (pl.opex_excluding_cogs_and_da ?? 0) +
        (pl.other_operating_income ?? 0);
      expect(Math.abs(pl.ebitda_before_stock_variation - before), `${name}: the build-up`).toBeLessThan(0.02);
      const derived = before + (pl.inventory_variation.value ?? 0) + (pl.capitalized_own_work.value ?? 0);
      expect(
        Math.abs((pl.ebitda ?? 0) - derived),
        `${name}: assembled_pl.ebitda is ${pl.ebitda}, and the build-up + 711 + 72x is ${derived}`,
      ).toBeLessThan(0.02);
    }
  });

  it("the build-up and EBITDA differ by exactly the stock variation and own work capitalised", () => {
    // Not a curiosity — on the two bridge books it is the whole reason a
    // derivation from the lines cannot stand in for the served figure.
    for (const name of BOOKS) {
      const pl = capture(name).statements.assembled_pl as unknown as ServedPl;
      const gap = pl.ebitda - pl.ebitda_before_stock_variation;
      const components = (pl.inventory_variation.value ?? 0) + (pl.capitalized_own_work.value ?? 0);
      expect(Math.abs(gap - components), `${name}: gap ${gap}, 711 + 72x ${components}`).toBeLessThan(0.02);
      if (name === "retail") expect(gap, "retail posts no 711").toBe(0);
      else expect(Math.abs(gap), `${name}: a bridge book whose 711 moves EBITDA`).toBeGreaterThan(100_000);
    }
  });

  it("the statement builder renders the SERVED figure, not its own", () => {
    for (const name of BOOKS) {
      const fx = capture(name);
      const served = fx.statements.assembled_pl.ebitda as number;
      const built = buildPLStatementFromAggregates(fx.statements as unknown as Statements);
      expect(
        built.ebitda,
        `${name}: the P&L renders ${built.ebitda}; the engine serves ${served}. ` +
          `Two EBITDAs for one period is what this gate exists to stop.`,
      ).toBe(served);
    }
  });

  it("an engine payload whose block carries no EBITDA is refused, never derived", () => {
    const fx = capture("retail");
    const statements = {
      ...fx.statements,
      assembled_pl: { ...fx.statements.assembled_pl, ebitda: undefined, ebitda_refusal: undefined },
    } as unknown as Statements;
    const built = buildPLStatementFromAggregates(statements);
    expect(built.ebitda).toBeNull();
    expect(built.ebitdaRefusal).toEqual(NOT_SERVED);
  });

  it("a payload the engine did not assemble is built on the engine's formula, so it cannot drift", () => {
    const fx = capture("retail");
    const pl = fx.statements.assembled_pl as unknown as ServedPl;
    const statements = {
      ...fx.statements,
      assembled_pl: undefined,
      incomeStatement: {
        revenue: pl.revenue,
        costOfGoodsSold: pl.cogs,
        operatingExpenses: pl.opex_excluding_cogs_and_da,
        otherIncome: pl.other_operating_income,
        depreciationAmortization: pl.depreciation,
        capitalizedOwnWork: pl.capitalized_own_work.value,
      },
    } as unknown as Statements;
    const built = buildPLStatementFromAggregates(statements);
    // retail posts no 711, so the formula without it IS the engine's.
    expect(Math.abs((built.ebitda as number) - pl.ebitda)).toBeLessThan(0.02);
  });

  it("what EBITDA includes is stated, not left to the reader to infer", () => {
    expect(EBITDA_COMPOSITION_NOTE).toMatch(/other operating income/i);
    expect(EBITDA_COMPOSITION_NOTE).toMatch(/758/);
    expect(EBITDA_COMPOSITION_NOTE).toMatch(/711/);
    expect(EBITDA_COMPOSITION_NOTE).toMatch(/72x/);
    expect(EBITDA_COMPOSITION_NOTE).toMatch(/767 is financial/);
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
