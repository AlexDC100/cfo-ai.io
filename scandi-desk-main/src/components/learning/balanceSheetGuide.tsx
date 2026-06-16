// F5.0 Step 4 (CFO AI Learn) — Balance Sheet flagship guide.
//
// The 5-step page tour the operator approved. Spotlight content is
// keyed off `data-guide="…"` attributes added inside BSStatementView.
// Steps are intentionally short — Apple Look Up density, not Bloomberg
// help-page density.

import type { GuideStep } from "./PageGuideOverlay";

export const BALANCE_SHEET_GUIDE: GuideStep[] = [
  {
    eyebrow: "1 of 5",
    title: "What this page means",
    body: (
      <>
        The Balance Sheet is the photograph of your company on the last
        day of the period. It shows{" "}
        <strong>what you own</strong> on the left side and{" "}
        <strong>how it's financed</strong> on the right side — those two
        totals always agree.
      </>
    ),
  },
  {
    selector: '[data-guide="bs-assets"]',
    eyebrow: "2 of 5",
    title: "Assets — what the business controls",
    body: (
      <>
        Cash, receivables, inventory, equipment, intangibles — everything
        the company can use to make money or sell. <strong>Tap any number</strong>{" "}
        to see how it was built and which trial-balance accounts roll up
        into it.
      </>
    ),
  },
  {
    selector: '[data-guide="bs-liabilities"]',
    eyebrow: "3 of 5",
    title: "Liabilities — what the business owes",
    body: (
      <>
        Suppliers, banks, the tax office, employees. Liabilities are the
        outside claims on your assets — they get paid before shareholders
        see anything.
      </>
    ),
  },
  {
    selector: '[data-guide="bs-equity"]',
    eyebrow: "4 of 5",
    title: "Equity — the shareholder cushion",
    body: (
      <>
        What's left for shareholders after every liability is paid:
        share capital plus all the profits the business has retained
        over its lifetime. Tap to see the source accounts
        (1012, 104, 117, 121 …).
      </>
    ),
  },
  {
    eyebrow: "5 of 5",
    title: "Click any number to learn it",
    body: (
      <>
        Every underlined value on this page is interactive. Click it to
        see the formula, the source accounts, the benchmark band, and
        what CFO AI thinks you should do next. <strong>Try Total Assets first</strong> —
        the recursion goes all the way back to your trial balance.
      </>
    ),
  },
];
