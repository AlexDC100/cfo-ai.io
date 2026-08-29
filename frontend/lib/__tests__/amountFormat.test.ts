// Gate D9 — number conformance. Every A1 presentation rule as a table.
import { describe, expect, it } from "vitest";

import {
  AMOUNT_MISSING,
  MAGNITUDE_M,
  MAGNITUDE_UNIT,
  formatAmount,
  formatExact,
  formatMultiple,
  formatPercentDelta,
  pickMagnitude,
} from "../amountFormat";

const NNBSP = " ";

describe("magnitude groups", () => {
  it("one member ≥ 1M pulls the WHOLE group onto the M scale", () => {
    const mag = pickMagnitude([15_100_000, 41_944.6, null]);
    expect(mag).toBe(MAGNITUDE_M);
    // The mixed-format row is impossible by construction:
    expect(formatAmount(15_100_000, { locale: "ro", currency: "€", magnitude: mag })).toBe(
      `15,1${NNBSP}M€`,
    );
    expect(formatAmount(41_944.6, { locale: "ro", currency: "€", magnitude: mag })).toBe(
      `0,0${NNBSP}M€`,
    );
  });

  it("small groups stay at unit scale", () => {
    expect(pickMagnitude([12, 400, 8_000])).toBe(MAGNITUDE_UNIT);
  });

  it("absent members never poison the scale", () => {
    expect(pickMagnitude([null, undefined, NaN as unknown as number])).toBe(MAGNITUDE_UNIT);
  });
});

describe("locale", () => {
  it("ro groups with dots, decimals with comma", () => {
    expect(formatAmount(1_234_567.8, { locale: "ro", fractionDigits: 1 })).toBe("1.234.567,8");
  });
  it("en groups with commas, decimals with dot", () => {
    expect(formatAmount(1_234_567.8, { locale: "en", fractionDigits: 1 })).toBe("1,234,567.8");
  });
});

describe("accounting negatives", () => {
  it("money negatives wrap the whole figure, unit included", () => {
    expect(
      formatAmount(-15_100_000, { locale: "ro", currency: "€", magnitude: MAGNITUDE_M }),
    ).toBe(`(15,1${NNBSP}M€)`);
  });
  it("non-money negatives use a true minus, not a hyphen", () => {
    expect(formatAmount(-3.2, { locale: "en", fractionDigits: 1 })).toBe("−3.2");
  });
});

describe("percentage sanity", () => {
  it("ordinary deltas render as signed percent", () => {
    const r = formatPercentDelta(0.124, { locale: "en" });
    expect(r?.display).toBe("+12.4%");
    expect(r?.asMultiplier).toBe(false);
  });
  it("the ↓10834.3% class renders as a signed multiplier with exact % preserved", () => {
    const r = formatPercentDelta(-108.343, { locale: "en" });
    expect(r?.display).toBe("−108×");
    expect(r?.asMultiplier).toBe(true);
    expect(r?.exactPercent).toBe("−10,834.3%");
  });
  it("999% is the last percent; 1000% is a multiplier", () => {
    expect(formatPercentDelta(9.99)?.asMultiplier).toBe(false);
    expect(formatPercentDelta(10.0)?.asMultiplier).toBe(true);
  });
});

describe("capped multiples", () => {
  it("a capped value renders ≥cap, never a bare >", () => {
    const r = formatMultiple(142.7, { locale: "en", cap: 99 });
    expect(r?.display).toBe("≥99×");
    expect(r?.capped).toBe(true);
    expect(r?.exact).toBe("142.70×");
  });
  it("under the cap renders exactly", () => {
    expect(formatMultiple(1.52, { locale: "en", cap: 99 })?.display).toBe("1.52×");
  });
});

describe("absent vs zero", () => {
  it("absent renders the em-dash", () => {
    expect(formatAmount(null)).toBe(AMOUNT_MISSING);
    expect(formatAmount(undefined)).toBe(AMOUNT_MISSING);
    expect(formatAmount(NaN)).toBe(AMOUNT_MISSING);
    expect(formatPercentDelta(null)).toBeNull();
    expect(formatMultiple(undefined)).toBeNull();
  });
  it("zero is a real figure, never an em-dash", () => {
    expect(formatAmount(0, { locale: "en" })).toBe("0");
  });
});

describe("tooltip exactness", () => {
  it("formatExact always renders the unscaled figure", () => {
    expect(formatExact(15_100_000, { locale: "en", currency: "€" })).toBe(
      `15,100,000${NNBSP}€`,
    );
  });
});
