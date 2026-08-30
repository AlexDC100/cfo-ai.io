// PUBLIC-COMPANY ADAPTER — ABSENT IS NOT ZERO (TSC burn-down, TIER 1).
//
// `publicCompanyAdapters.ts` read three fields off `PublicCompanyPeriod
// ["headline"]` that the engine does not put there:
// `total_liabilities`, `investing_cash_flow`, `financing_cash_flow`.
// 14 of the 101 baselined type errors were TS2339 saying exactly that, and
// every read went through `?? 0`, so the missing fact was rendered as the
// number zero.
//
// The fixture is REAL ENGINE OUTPUT (TC-1): both periods were produced by
// `engine.public.normalizer.normalize()` from Apple's filed FY2024/FY2023
// figures, so §1 can prove the omission against the actual emitter rather
// than against a hand-written mock that would just agree with whatever the
// test author believed.
//
// Two different remedies, because the two cases differ:
//   · total_liabilities IS recoverable — A − E is exact, so it is derived
//     and the balance sheet foots again.
//   · investing/financing cash flow are NOT recoverable, so they are
//     surfaced as unavailable instead of as 0.00.

import { describe, it, expect } from "vitest";

import { buildPublicStatements } from "@/lib/publicCompanyAdapters";
import type { PublicCompanyEnvelope } from "@/lib/publicCompanyApi";
import envelopeJson from "./fixtures/publicCompany/aapl_envelope.json";

const RAW = envelopeJson as unknown as PublicCompanyEnvelope & {
  _filed_reference: {
    fy2024: {
      total_liabilities: number;
      investing_cash_flow: number;
      financing_cash_flow: number;
    };
    fy2023: { total_liabilities: number };
  };
};
const FILED = RAW._filed_reference;

const built = buildPublicStatements(RAW);
if (!built) throw new Error("fixture has no periods — the suite cannot run");
const { bs, cf, statements, current } = built;

describe("publicCompanyAdapters — absent is not zero", () => {
  // ── §1 DISCOVERY CANARY ────────────────────────────────────────────
  // If a later engine version DOES start emitting these keys, the
  // derivation below becomes unnecessary and this fails loudly, instead
  // of the suite quietly continuing to test a workaround for a bug that
  // no longer exists.
  describe("§1 the engine really omits these headline keys", () => {
    it("headline carries exactly the ten keys the normalizer builds", () => {
      expect(Object.keys(current.headline).sort()).toEqual([
        "cash", "ebit", "ebitda", "free_cash_flow", "net_income",
        "operating_cash_flow", "revenue", "total_assets", "total_debt",
        "total_equity",
      ]);
    });

    it("total_liabilities / investing_cash_flow / financing_cash_flow are absent", () => {
      const h = current.headline as unknown as Record<string, unknown>;
      for (const k of ["total_liabilities", "investing_cash_flow", "financing_cash_flow"]) {
        expect(k in h, `${k} unexpectedly present in headline`).toBe(false);
      }
      // …while the filed statement definitely has them, so "absent" is an
      // emitter gap, not a company that has no liabilities.
      expect(FILED.fy2024.total_liabilities).toBeGreaterThan(0);
    });
  });

  // ── §2 TOTAL LIABILITIES: DERIVED, AND EXACT ───────────────────────
  describe("§2 the balance sheet foots again", () => {
    it("recovers filed total liabilities exactly from A − E", () => {
      // Not an approximation — the identity is exact to the dollar.
      const closing = bs.totalEquityLiab.closing - (current.headline.total_equity ?? 0);
      expect(closing).toBeCloseTo(FILED.fy2024.total_liabilities, 2);
    });

    it("balanceCheck is ~0 (it was off by the entire liability stack)", () => {
      // Pre-fix this equalled total_assets − total_equity ≈ $308bn.
      expect(Math.abs(bs.balanceCheck)).toBeLessThan(1);
    });

    it("total non-current liabilities is not negative", () => {
      // Pre-fix: 0 − short-term debt, i.e. a negative liability subtotal.
      const nonCurrent = bs.equityLiabSections.find(
        (s) => s.header === "NON-CURRENT LIABILITIES",
      );
      expect(nonCurrent).toBeTruthy();
      expect(nonCurrent!.subtotalClosing).toBeGreaterThan(0);
    });

    it("the prior period is derived too, so deltas are real", () => {
      const openingLiab = bs.totalEquityLiab.opening
        - (RAW.periods[1].headline.total_equity ?? 0);
      expect(openingLiab).toBeCloseTo(FILED.fy2023.total_liabilities, 2);
      expect(bs.totalEquityLiab.delta).not.toBe(0);
    });

    it("current liabilities feeding computeRatios are no longer understated", () => {
      // This is the ratio-poisoning path: otherCurrentLiabilities was 0,
      // which inflated current ratio / quick ratio / debt-to-assets.
      const b = statements.balanceSheet as unknown as Record<string, number>;
      const liabilityish = Object.entries(b)
        .filter(([k]) => /liab/i.test(k))
        .reduce((s, [, v]) => s + (typeof v === "number" ? v : 0), 0);
      expect(liabilityish).toBeGreaterThan(0);
    });
  });

  // ── §3 CASH FLOW: UNAVAILABLE, NOT ZERO ────────────────────────────
  describe("§3 unrecoverable flows are disclosed, not invented", () => {
    it("does not claim an exact statement it cannot produce", () => {
      // Pre-fix: isApproximated:false + drift:0 + two 0.00 sections — a
      // fabricated clean reconciliation.
      expect(cf.isApproximated).toBe(true);
      expect(cf.approximationNotes.length).toBeGreaterThan(0);
      expect(cf.approximationNotes.join(" ")).toMatch(/investing and financing/i);
    });

    it("publishes no investing line it has no number for", () => {
      // Neither `cfi_capex` (not among the emitted leaves) nor the
      // investing total is available, so there is nothing honest to show.
      expect(cf.investing.items).toEqual([]);
    });

    it("netChangeInCash is not presented as if the legs were known", () => {
      // It must NOT equal OCF-alone-dressed-up-as-a-total.
      const ocf = current.headline.operating_cash_flow ?? 0;
      expect(ocf).toBeGreaterThan(0);
      expect(cf.reconciliation.netChangeInCash).not.toBe(ocf);
    });

    it("operating cash flow — which IS emitted — still passes through exact", () => {
      expect(cf.operating.cashFromOperating).toBe(current.headline.operating_cash_flow);
    });
  });
});
