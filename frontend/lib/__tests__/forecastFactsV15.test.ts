/**
 * THE v1.5 BLOCKS — `strip`, `series`, `summary`, `client`, `history` and the
 * levers — read back off the REAL served bytes.
 *
 * These five blocks have been on the wire since fp1.2 and no reader read them.
 * That is why the page had no executive strip, no charts and no levers while
 * the engine was already serving every figure all three need: the gap was in
 * the reader, not the engine. This file is the gate that the reader now reads
 * them, and that it reads them as the SAME union the statement table paints.
 *
 * WHAT IT REDS ON (TC-11)
 *   · a strip or series amount arriving as a bare number rather than a
 *     `ProjectedResult` — i.e. anything that could be painted without the
 *     projected marker;
 *   · a standing engine refusal (`strip.first_breach_period`, `strip.dcf_ev`)
 *     read as a figure, or as a zero;
 *   · a lever's value going back on the wire as anything but the EXACT decimal
 *     the engine served — the engine refuses "1e-1" and anything inexact at
 *     the driver's own scale, so a float round trip is a 422 in waiting;
 *   · the debounce being a page constant instead of the pack's `debounce_ms`;
 *   · `series(key)` inventing points for a key this build does not serve.
 *
 * WHAT IT CANNOT SEE
 *   · what the page paints (`forecastPage.test.tsx` and the chart tests own
 *     that), and whether the numbers are a good forecast (the engine's own
 *     suite owns that).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, it, expect } from "vitest";

import {
  exactDecimal,
  isProjectedFigure,
  isProjectionRefusal,
  readProjection,
  unwrapProjected,
} from "@/lib/forecastFacts";

const REPO = resolve(__dirname, "../../..");
const SERVED = "tests/engine/fixtures/forecast/fp1_2_agras_served.json";
const raw = JSON.parse(readFileSync(resolve(REPO, SERVED), "utf8")) as Record<
  string,
  any
>;
const view = readProjection(raw)!;

describe("the executive strip", () => {
  it("reads the three served figures, each as a projected figure with a basis", () => {
    for (const slot of [
      view.strip.closingCash,
      view.strip.cumulativeFcf,
      view.strip.peakFundingGap,
    ]) {
      expect(isProjectedFigure(slot.result)).toBe(true);
      if (!isProjectedFigure(slot.result)) return;
      expect(slot.result.basis.length).toBeGreaterThan(0);
    }
  });

  it("each strip figure IS the served amount, to the minor unit", () => {
    const pairs: Array<[typeof view.strip.closingCash, number]> = [
      [view.strip.closingCash, raw.strip.closing_cash.amount_minor],
      [view.strip.cumulativeFcf, raw.strip.cumulative_fcf.amount_minor],
      [view.strip.peakFundingGap, raw.strip.peak_funding_gap.amount.amount_minor],
    ];
    for (const [slot, served] of pairs) {
      if (!isProjectedFigure(slot.result)) throw new Error("not served");
      const minor = unwrapProjected(slot.result, "base", (v) => v);
      expect(minor).toBe(served);
    }
  });

  it("the two slots this build does not serve are REFUSALS carrying the engine's words", () => {
    for (const slot of [view.strip.firstBreachPeriod, view.strip.dcfEv]) {
      expect(isProjectionRefusal(slot.result)).toBe(true);
      if (!isProjectionRefusal(slot.result)) return;
      // The engine's own sentence. "none in horizon" would be an absent read
      // as a negative — a covenant the engine holds no input for.
      expect(slot.result.detail).toBe("this is not served in this build");
    }
  });

  it("a peak funding gap of zero carries a null period, and that is an answer", () => {
    expect(raw.strip.peak_funding_gap.period).toBeNull();
    expect(view.strip.peakFundingGap.period).toBeNull();
    expect(isProjectedFigure(view.strip.peakFundingGap.result)).toBe(true);
  });
});

describe("the chart series", () => {
  it("serves every key the engine serves, and only those", () => {
    expect(view.seriesKeys()).toEqual(Object.keys(raw.series).sort());
  });

  it("a key this build does not serve is EMPTY, never a line at zero", () => {
    // `dscr` lands with B8. A chart drawn flat along the axis would be the
    // page stating a ratio the engine refused to state.
    expect(view.seriesKeys()).not.toContain("dscr");
    expect(view.series("dscr")).toEqual([]);
  });

  it("every point is a ProjectedResult on the engine's own period", () => {
    for (const key of view.seriesKeys()) {
      const points = view.series(key);
      expect(points.length).toBe(raw.series[key].length);
      points.forEach((p, i) => {
        expect(p.period).toBe(raw.series[key][i].period);
        const served = raw.series[key][i];
        if (served.refused) {
          expect(isProjectionRefusal(p.result)).toBe(true);
        } else {
          expect(isProjectedFigure(p.result)).toBe(true);
          if (!isProjectedFigure(p.result)) return;
          expect(unwrapProjected(p.result, "base", (v) => v)).toBe(
            served.amount_minor,
          );
        }
      });
    }
  });

  it("capex and depreciation arrive with the sign the engine gave them", () => {
    // Both are NEGATIVE on the wire. Flipping one so a bar chart reads nicely
    // is a display-side sign change on a projected figure.
    for (const key of ["capex", "depreciation"]) {
      const first = view.series(key)[0];
      if (!isProjectedFigure(first.result)) throw new Error("not served");
      expect(unwrapProjected(first.result, "base", (v) => v)).toBe(
        raw.series[key][0].amount_minor,
      );
    }
  });
});

describe("the summary", () => {
  it("the trough is the engine's period and the engine's amount", () => {
    expect(view.summary.cashTrough.period).toBe(raw.summary.cash_trough.period);
    if (!isProjectedFigure(view.summary.cashTrough.result)) {
      throw new Error("not served");
    }
    expect(
      unwrapProjected(view.summary.cashTrough.result, "base", (v) => v),
    ).toBe(raw.summary.cash_trough.amount.amount_minor);
  });

  it("the shaded band is the SERVED span, not one derived here", () => {
    expect(view.summary.fundingGapPeriods).toEqual(
      raw.summary.funding_gap_periods,
    );
  });

  it("carries the runway and funding-rate sentences verbatim", () => {
    expect(view.summary.runwaySentence).toBe(raw.summary.runway.sentence.text);
    expect(view.summary.fundingRateSentence).toBe(
      raw.summary.funding_rate_basis.sentence.text,
    );
  });
});

describe("the client block", () => {
  it("the debounce is the pack's, not a page constant", () => {
    expect(view.client.debounceMs).toBe(raw.client.debounce_ms);
    expect(view.client.analysisDebounceMs).toBe(raw.client.analysis_debounce_ms);
  });

  it("the levers the engine does not serve are SERVED as a list with sentences", () => {
    expect(view.client.unserved.map((u) => u.key)).toEqual(
      raw.client.unserved.map((u: any) => u.key),
    );
    for (const row of view.client.unserved) {
      expect(row.sentence.length).toBeGreaterThan(0);
    }
  });
});

describe("the levers", () => {
  it("declares one per driver, in driver_order", () => {
    expect(view.levers.map((l) => l.key)).toEqual(raw.driver_order);
  });

  it("a value goes back on the wire as the EXACT decimal the engine served", () => {
    // 28045424 micro-days is "28.045424". `(v / 1e6).toString()` is an
    // IEEE-754 result being asked to round trip through a contract that
    // forbids floats, and the engine answers 422 `not_exact`.
    const dso = view.lever("dso_days")!;
    expect(dso.scale).toBe(1_000_000);
    expect(dso.valueTexts[0]).toBe(
      exactDecimal(raw.drivers.dso_days.values[0], 1_000_000),
    );
    expect(dso.valueTexts[0]).toMatch(/^-?\d+(\.\d+)?$/);
    expect(exactDecimal(28045424, 1_000_000)).toBe("28.045424");
    expect(exactDecimal(25000, 1_000_000)).toBe("0.025");
    expect(exactDecimal(0, 1_000_000)).toBe("0");
    expect(exactDecimal(-30477, 1_000_000)).toBe("-0.030477");
    // money_minor is a scale of 100: 12,000,000.00 is "12000000".
    expect(exactDecimal(1_200_000_000, 100)).toBe("12000000");
  });

  it("carries the bounds and the step the engine states, as strings", () => {
    const growth = view.lever("revenue_growth")!;
    expect(growth.bounds.minText).toBe(raw.drivers.revenue_growth.bounds.min);
    expect(growth.bounds.maxText).toBe(raw.drivers.revenue_growth.bounds.max);
    expect(growth.stepText).toBe(raw.drivers.revenue_growth.reach_step);
    expect(growth.shape).toBe("per_year");
    expect(growth.values.length).toBe(raw.drivers.revenue_growth.values.length);
  });

  it("carries the tier and the ladder that produced it", () => {
    const growth = view.lever("revenue_growth")!;
    expect(growth.basis.tier).toBe(raw.drivers.revenue_growth.basis.tier);
    expect(growth.basis.sentence).toBe(
      raw.drivers.revenue_growth.basis.sentence.text,
    );
    // With no prior in this book the book rung is ABSENT and says so. The
    // page renders that, not a fabricated [book] chip.
    expect(growth.basis.fallbackSteps.map((s) => s.tier)).toContain("book");
    expect(growth.basis.bookInputs).toEqual([]);
  });

  it("a book-measured lever carries the facts it was measured from", () => {
    const dso = view.lever("dso_days")!;
    expect(dso.basis.tier).toBe("book");
    expect(dso.basis.bookInputs.length).toBe(2);
    expect(dso.basis.bookInputs[0].fact).toBe(
      raw.drivers.dso_days.basis.book.inputs[0].fact,
    );
    expect(dso.basis.bookPeriodsUsed).toEqual(
      raw.drivers.dso_days.basis.book.periods_used,
    );
  });

  it("the alternatives are what reset-to-book resets TO, with their own sentence", () => {
    const growth = view.lever("revenue_growth")!;
    const macro = growth.alternatives.find((a) => a.tier === "macro")!;
    expect(macro.values[0]).toBe(
      exactDecimal(raw.drivers.revenue_growth.alternatives.macro.values[0], 1e6),
    );
    expect(macro.sentence.length).toBeGreaterThan(0);
    expect(growth.alternatives.find((a) => a.tier === "sector")).toBeUndefined();
  });
});

describe("the history block", () => {
  it("reads all three buckets", () => {
    expect(view.history.held.map((h) => h.periodId)).toEqual(
      raw.history.held.map((h: any) => h.period_id ?? ""),
    );
    expect(view.history.excluded.length).toBe(raw.history.excluded.length);
    expect(view.history.eligible.length).toBe(raw.history.eligible.length);
  });

  it("an excluded candidate keeps the engine's reason", () => {
    const rows = [
      { period_id: "p-2", period_end: "2024-06-30", reason: { code: "interim", text: "an interim period" } },
    ];
    const other = readProjection({
      ...raw,
      history: { held: [], eligible: [], excluded: rows },
    })!;
    expect(other.history.excluded[0].label).toBe("2024-06-30");
    expect(other.history.excluded[0].sentence).toBe("an interim period");
  });
});
