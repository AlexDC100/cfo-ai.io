// REPORTING METRICS — CASH FLOW WAS NEVER POPULATED (TSC burn-down, TIER 1).
//
// `buildReportingMetricsSnapshot` read `statements.cashFlow`, a property
// that does not exist on `Statements`. One baselined TS2339 said so, and
// the consequence was that all seven cash-flow metrics came back
// `undefined` forever:
//
//   · the learning surface's entire "Cash Flow" category had no numbers;
//   · `CascadeState` IS `ReportingMetrics`, so the scenario engine's capex
//     lever adjusted `num(undefined) === 0` and could never move anything.
//
// The fix reads the canonical `assembled_cf` view — the same one the Cash
// Flow tab renders — rather than `deriveCashFlow()`, which is an
// approximation and would have produced a second, disagreeing set of
// numbers on a different screen.
//
// The fixture is REAL ENGINE OUTPUT (TC-1): Carniprod FY2025 captured
// through the real `/api/period` composition.

import { describe, it, expect } from "vitest";

import { buildReportingMetricsSnapshot } from "@/lib/learning/buildReportingMetrics";
import type { Statements } from "@/lib/financialReport";
import realPeriod from "./fixtures/capsuleTier0/period_carniprod_fy2025.json";

const PERIOD = realPeriod as unknown as Record<string, unknown>;
const ACF = PERIOD.assembled_cf as Record<string, number>;

/** The fixture is the `statements` blob itself. */
const STATEMENTS = PERIOD as unknown as Statements;

describe("buildReportingMetricsSnapshot — cash flow", () => {
  // ── §1 DISCOVERY CANARY ────────────────────────────────────────────
  // The suite means nothing if the fixture has no canonical CF view, and
  // it must not silently pass by asserting `undefined === undefined`.
  describe("§1 the fixture really carries a canonical CF view", () => {
    it("assembled_cf is present with the fields this code reads", () => {
      expect(ACF).toBeTruthy();
      for (const k of [
        "cash_from_operating", "cash_from_investing", "cash_from_financing",
        "net_change_in_cash", "closing_cash_actual", "capex_total",
      ]) {
        expect(typeof ACF[k], `${k} missing from assembled_cf`).toBe("number");
      }
    });

    it("`cashFlow` — the property the old code read — is absent", () => {
      expect("cashFlow" in PERIOD).toBe(false);
    });

    it("the view's own signs satisfy CFO + CFI + CFF = net change", () => {
      // This is what licenses reading CFI/CFF straight through: the
      // concept `net_change_in_cash` declares exactly this identity, so
      // the view is already outflow-negative as the concept expects. If a
      // future engine flips a sign, this fails here rather than showing a
      // wrong cash bridge in the learning surface.
      const sum = ACF.cash_from_operating + ACF.cash_from_investing
        + ACF.cash_from_financing;
      expect(sum).toBeCloseTo(ACF.net_change_in_cash, 2);
    });
  });

  // ── §2 THE METRICS ARE ACTUALLY POPULATED NOW ──────────────────────
  describe("§2 the seven metrics are populated from the canonical view", () => {
    const m = buildReportingMetricsSnapshot(STATEMENTS);

    it("none of them is undefined any more", () => {
      for (const k of [
        "operatingCashFlow", "capex", "investingCashFlow",
        "financingCashFlow", "netChangeInCash", "openingCash", "closingCash",
      ] as const) {
        expect(m[k], `${k} still undefined`).not.toBeUndefined();
        expect(Number.isFinite(m[k] as number), `${k} not finite`).toBe(true);
      }
    });

    it("each value equals the canonical view, not a re-derivation", () => {
      expect(m.operatingCashFlow).toBe(ACF.cash_from_operating);
      expect(m.investingCashFlow).toBe(ACF.cash_from_investing);
      expect(m.financingCashFlow).toBe(ACF.cash_from_financing);
      expect(m.netChangeInCash).toBe(ACF.net_change_in_cash);
      expect(m.closingCash).toBe(ACF.closing_cash_actual);
    });

    it("opening cash bridges to closing", () => {
      expect((m.openingCash as number) + (m.netChangeInCash as number))
        .toBeCloseTo(m.closingCash as number, 2);
    });

    it("capex is a positive magnitude (fcf = cfo − capex convention)", () => {
      expect(ACF.capex_total).toBeLessThanOrEqual(0);   // emitted as outflow
      expect(m.capex as number).toBeGreaterThan(0);
      expect(m.capex).toBe(Math.abs(ACF.capex_total));
    });

    it("the learning CFO+CFI+CFF token row now reconciles", () => {
      // `net_change_in_cash`'s concept renders exactly these three tokens.
      const sum = (m.operatingCashFlow as number)
        + (m.investingCashFlow as number)
        + (m.financingCashFlow as number);
      expect(sum).toBeCloseTo(m.netChangeInCash as number, 2);
    });
  });

  // ── §3 ABSENT STAYS ABSENT ─────────────────────────────────────────
  describe("§3 a missing view does not become zero", () => {
    it("no assembled_cf → the metrics are undefined, never 0", () => {
      const stripped = { ...PERIOD };
      delete (stripped as Record<string, unknown>).assembled_cf;
      const m = buildReportingMetricsSnapshot(stripped as unknown as Statements);
      for (const k of [
        "operatingCashFlow", "capex", "investingCashFlow",
        "financingCashFlow", "netChangeInCash", "openingCash", "closingCash",
      ] as const) {
        expect(m[k], `${k} should be absent, not zero`).toBeUndefined();
      }
    });

    it("null statements still returns a structurally consistent object", () => {
      expect(buildReportingMetricsSnapshot(null)).toEqual({});
    });
  });
});
