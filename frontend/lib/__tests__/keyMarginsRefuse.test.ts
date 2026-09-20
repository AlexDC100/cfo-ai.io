// GATE (2026-09-21): a margin the payload cannot support REFUSES; it never
// prints 0.00%.
//
// Measured during the demo-path figure sweep: `canonicalMargins` is a memo
// that always returns an OBJECT whose fields may be null, so the ternary
// `cm ? [canonical] : [arithmetic]` ALWAYS took the canonical branch and the
// documented arithmetic fallback was dead code. The real fallback was `?? 0`.
// With the engine rows absent the P&L tab printed "EBITDA margin 0.00% / Net
// margin 0.00%" — and after the net-profit card was repaired it printed
// "Net profit 7,533,676" directly beside "Net margin 0.00%".
//
// Fails on: either margin rendering 0 when its engine row is absent AND its
// operands are missing; the per-margin fallback being collapsed back to a
// per-object ternary; formatPercent rendering a refusal as a number.
import { describe, expect, it } from "vitest";

import { buildPLStatement } from "@/lib/buildPlStatement";
import { formatPercent } from "@/lib/formatRon";

const REVENUE = 84_000_000;
const EBITDA = 5_400_000;

const li = (code: string, bucket: string, amount: number) => ({
  statement: "PL" as const, bucket, ro_account_code: code, amount,
});

function build(canonicalMargins: { ebitdaMargin: number | null; netMargin: number | null } | null,
               opts: { revenue?: number } = {}) {
  const revenue = opts.revenue ?? REVENUE;
  const lineItems = revenue > 0
    ? [li("706", "revenue", revenue), li("641", "opex", revenue - EBITDA)]
    : [li("641", "opex", 1_000)];   // a book with costs and NO revenue line at all
  return buildPLStatement({
    lineItems, entity: "Gate SRL", period: "FY2025", currency: "RON", canonicalMargins,
  } as never);
}

const margin = (s: ReturnType<typeof build>, label: string) =>
  s.keyMargins.find((m) => m.label.startsWith(label));

describe("key margins", () => {
  it("prints the engine's margin when the engine carries one", () => {
    const s = build({ ebitdaMargin: 0.0643, netMargin: 0.0144 });
    expect(margin(s, "EBITDA")!.value).toBeCloseTo(0.0643, 6);
    expect(margin(s, "Net")!.value).toBeCloseTo(0.0144, 6);
  });

  it("falls back PER MARGIN, not per object — one absent row does not blank the other", () => {
    const s = build({ ebitdaMargin: null, netMargin: 0.0144 });
    expect(margin(s, "Net")!.value).toBeCloseTo(0.0144, 6);
    const ebitda = margin(s, "EBITDA")!.value;
    expect(ebitda).not.toBe(0);
    expect(ebitda === null || Number.isFinite(ebitda)).toBe(true);
  });

  it("REFUSES rather than printing zero when neither the row nor the operands exist", () => {
    const s = build({ ebitdaMargin: null, netMargin: null }, { revenue: 0 });
    for (const label of ["EBITDA", "Net"]) {
      const v = margin(s, label)!.value;
      expect(v, `${label} margin must refuse, not claim zero`).toBeNull();
      expect(formatPercent(v)).toBe("—");
    }
  });

  it("a refusal renders as an em dash, and a real zero still renders as 0.0%", () => {
    expect(formatPercent(null)).toBe("—");
    expect(formatPercent(undefined)).toBe("—");
    expect(formatPercent(0)).toBe("0.0%");
    expect(formatPercent(NaN)).toBe("—");
  });
});
