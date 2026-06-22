// F5.0 Step 4 (CFO AI Learn) — Valuation page guide.
//
// Walks the user through the Core EBITDA → EBITDA multiple → Equity bridge.
// Selectors hook into data-guide markers on EbitdaMultiplePrimaryCard.

import type { GuideStep } from "./PageGuideOverlay";

export const VALUATION_GUIDE: GuideStep[] = [
  {
    eyebrow: "1 of 5",
    title: "What this page values",
    body: (
      <>
        This is the market view of the business. We turn the steady
        earnings (Core EBITDA) into a price a buyer or lender would pay,
        then bridge to what shareholders would take home after debt.
      </>
    ),
  },
  {
    selector: '[data-testid="ebitda-multiple-primary"]',
    eyebrow: "2 of 5",
    title: "EBITDA multiple — the primary method",
    body: (
      <>
        The peer multiple a buyer applies to your earnings. The default
        is the industry-benchmark median; the slider lets you stress-test.
        Tap the multiple to learn what drives it.
      </>
    ),
  },
  {
    selector: '[data-testid="ebitda-multiple-equity"]',
    eyebrow: "3 of 5",
    title: "Equity value — what shareholders get",
    body: (
      <>
        Enterprise value minus net debt. This is the cheque size to
        shareholders if the business sold at this multiple today.
        Tap to see the bridge.
      </>
    ),
  },
  {
    selector: '[data-testid="ebitda-multiple-ev"]',
    eyebrow: "4 of 5",
    title: "Enterprise value — the whole company",
    body: (
      <>
        Core EBITDA × multiple. The total price including debt — what a
        strategic acquirer pays before settling the balance sheet.
      </>
    ),
  },
  {
    eyebrow: "5 of 5",
    title: "Cross-checks live below",
    body: (
      <>
        DCF, WACC build-up, and Graham appear in the Cross-checks panel
        below. They exist to validate (or challenge) this primary number.
        Tap any value at any level to drill into its inputs.
      </>
    ),
  },
];
