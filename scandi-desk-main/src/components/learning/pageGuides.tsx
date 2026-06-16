// F5.0 Step 4 (CFO AI Learn) — Page guides for every major analyst surface.
//
// Each export is an array of GuideStep objects passed to <GuideMeButton>.
// The eyebrow / title / body shape is intentionally simple — one short
// thought per step. Selectors hook into data-guide markers on the
// relevant page components.

import type { GuideStep } from "./PageGuideOverlay";

// ─── P&L ──────────────────────────────────────────────────────────────

export const PL_GUIDE: GuideStep[] = [
  {
    eyebrow: "1 of 5",
    title: "What this page tells you",
    body: (
      <>
        The Profit & Loss is the <strong>movie</strong> of your company
        for the period. It walks from total revenue down to net profit,
        line by line. Each line shows where money came in or went out.
      </>
    ),
  },
  {
    eyebrow: "2 of 5",
    title: "Top — revenue & costs of sales",
    selector: '[data-guide="pl-revenue"]',
    body: (
      <>
        Revenue is what you billed customers. Subtract the direct cost
        of producing those sales (601 raw materials, 602 consumables,
        607 cost of merchandise) and you get the gross result.
      </>
    ),
  },
  {
    eyebrow: "3 of 5",
    title: "Middle — operating expenses & EBITDA",
    selector: '[data-guide="pl-ebitda"]',
    body: (
      <>
        Subtract personnel, rent, utilities, marketing — everything to
        keep the business running — and you arrive at <strong>EBITDA</strong>,
        the cleanest read on operating earnings. Tap any line to see its
        source accounts.
      </>
    ),
  },
  {
    eyebrow: "4 of 5",
    title: "Bottom — interest, tax, net profit",
    selector: '[data-guide="pl-net-profit"]',
    body: (
      <>
        Take EBIT, subtract net interest expense and income tax — what's
        left is net profit. The number that flows to retained earnings
        on the balance sheet.
      </>
    ),
  },
  {
    eyebrow: "5 of 5",
    title: "Click any number to trace it",
    body: (
      <>
        Every underlined value drills back to the source RAS accounts in
        your trial balance. EBITDA → EBIT + D&A → Revenue − COGS − OpEx
        → individual accounts.
      </>
    ),
  },
];

// ─── Cash Flow ───────────────────────────────────────────────────────

export const CF_GUIDE: GuideStep[] = [
  {
    eyebrow: "1 of 5",
    title: "Profit vs cash",
    body: (
      <>
        The P&L tells you if you're profitable. The Cash Flow tells you if
        you're <strong>actually generating cash</strong>. They often
        disagree — that gap is what this statement explains.
      </>
    ),
  },
  {
    eyebrow: "2 of 5",
    title: "Operating activities",
    selector: '[data-guide="cf-operating"]',
    body: (
      <>
        Start with net profit, add back non-cash items (depreciation),
        and adjust for the working-capital movement (receivables,
        inventory, payables). What's left is cash from operations.
      </>
    ),
  },
  {
    eyebrow: "3 of 5",
    title: "Investing activities",
    selector: '[data-guide="cf-investing"]',
    body: (
      <>
        Cash spent on long-life assets — equipment, buildings, CIP. Almost
        always negative for a growing business; positive can mean you sold
        something material.
      </>
    ),
  },
  {
    eyebrow: "4 of 5",
    title: "Financing activities",
    selector: '[data-guide="cf-financing"]',
    body: (
      <>
        New debt drawn, repayments, dividends paid, equity issued. Tells
        you how the gap between operating cash and investing need was
        funded.
      </>
    ),
  },
  {
    eyebrow: "5 of 5",
    title: "Reconciliation",
    body: (
      <>
        Opening cash + the three sections should reconcile to closing cash
        on the balance sheet within RON 1. If there's drift, the engine
        flags it — and tells you why.
      </>
    ),
  },
];

// ─── Ratios ──────────────────────────────────────────────────────────

export const RATIOS_GUIDE: GuideStep[] = [
  {
    eyebrow: "1 of 5",
    title: "Why ratios matter",
    body: (
      <>
        Absolute numbers — RON 220M revenue — tell you nothing without
        context. Ratios scale by revenue, equity, or assets so you can
        compare across time and against peers.
      </>
    ),
  },
  {
    eyebrow: "2 of 5",
    title: "Profitability",
    selector: '[data-guide="ratios-profitability"]',
    body: (
      <>
        EBITDA margin, net margin, ROE, ROIC. The "is this business
        making money efficiently" check. Tap any tile to see the formula,
        the inputs, and your position vs industry P25–P75.
      </>
    ),
  },
  {
    eyebrow: "3 of 5",
    title: "Liquidity & leverage",
    selector: '[data-guide="ratios-leverage"]',
    body: (
      <>
        Current ratio, cash ratio, Debt/EBITDA, interest coverage. The
        "can this business meet its obligations in the next 12 months"
        check. The single most important number for any lender.
      </>
    ),
  },
  {
    eyebrow: "4 of 5",
    title: "Efficiency",
    selector: '[data-guide="ratios-efficiency"]',
    body: (
      <>
        DIO, DSO, DPO, CCC, asset turnover. How fast does cash cycle
        through the business? Low CCC = capital-efficient. High CCC =
        cash is trapped in inventory or receivables.
      </>
    ),
  },
  {
    eyebrow: "5 of 5",
    title: "Bankruptcy risk",
    selector: '[data-guide="ratios-risk"]',
    body: (
      <>
        Altman Z″ for emerging markets. Above 2.6 = safe. 1.10–2.60 =
        grey zone. Below 1.10 = distress probability is elevated. Tap to
        see the four-component breakdown.
      </>
    ),
  },
];

// ─── Recommendations ─────────────────────────────────────────────────

export const RECOMMENDATIONS_GUIDE: GuideStep[] = [
  {
    eyebrow: "1 of 4",
    title: "What you're looking at",
    body: (
      <>
        Each card is a specific, prioritised action — not generic advice.
        Cards fire only when a real threshold triggers (e.g. cash ratio
        below 0.10, D/E above 1.5).
      </>
    ),
  },
  {
    eyebrow: "2 of 4",
    title: "Severity tags",
    body: (
      <>
        Critical (red) → solvency-relevant, act this quarter. High (amber)
        → working-capital pressure, act this month. Medium (blue) →
        optimisation opportunities.
      </>
    ),
  },
  {
    eyebrow: "3 of 4",
    title: "Why / Action / Impact",
    body: (
      <>
        Every card shows the finding that triggered it (Why), the concrete
        steps (Action), and the quantified outcome in RON (Impact).
        Nothing vague.
      </>
    ),
  },
  {
    eyebrow: "4 of 4",
    title: "Tap to drill",
    body: (
      <>
        Estimated impact is a learnable number — tap to see how it was
        calculated. The Ask CFO AI footer lets you discuss any specific
        recommendation with your current data preloaded.
      </>
    ),
  },
];

// ─── Risks & Credit ──────────────────────────────────────────────────

export const RISK_GUIDE: GuideStep[] = [
  {
    eyebrow: "1 of 4",
    title: "The composite credit score",
    body: (
      <>
        A 0–100 score blending Altman Z″, profitability, leverage, coverage,
        and liquidity into one rating. Maps to letter grades from AAA to D
        the way a bank would price the company.
      </>
    ),
  },
  {
    eyebrow: "2 of 4",
    title: "Altman Z″ — the emerging markets variant",
    body: (
      <>
        Four ratios (working-capital, retained-earnings, EBIT, equity)
        weighted into a single distress predictor. Tap the X1–X4 rows to
        see each component's contribution.
      </>
    ),
  },
  {
    eyebrow: "3 of 4",
    title: "The risk inventory",
    body: (
      <>
        Specific concerns the engine identified — affiliate dependency,
        customer concentration, asset maturity, etc. Sorted by severity.
        Each links to its source metric on the dashboard.
      </>
    ),
  },
  {
    eyebrow: "4 of 4",
    title: "What good looks like",
    body: (
      <>
        Composite 70+ = investment-grade equivalent. 55–70 = speculative
        strong (most healthy SMEs). Below 55 = lender attention required.
        Tap any score to see how it was calculated.
      </>
    ),
  },
];

// ─── Benchmark ───────────────────────────────────────────────────────

export const BENCHMARK_GUIDE: GuideStep[] = [
  {
    eyebrow: "1 of 4",
    title: "How you compare",
    body: (
      <>
        Every metric is plotted against your industry's P25, median, and
        P75 — the actual band of peers, not a synthetic target. Tap any
        gap to see the financial impact of closing it.
      </>
    ),
  },
  {
    eyebrow: "2 of 4",
    title: "Gap formula",
    body: (
      <>
        Your value minus the peer benchmark. Multiplied by your revenue or
        relevant driver to put a RON number on what closing the gap is
        worth. No hand-waving.
      </>
    ),
  },
  {
    eyebrow: "3 of 4",
    title: "Real peer table",
    body: (
      <>
        Named comparable companies from BVB filings + Romanian extracts.
        Your row is highlighted; other rows are live drill-downs to their
        individual public records.
      </>
    ),
  },
  {
    eyebrow: "4 of 4",
    title: "Closing the gap",
    body: (
      <>
        The financial-impact column tells you what each percentage-point
        improvement would be worth this period. Tap any number to ask CFO
        AI exactly which levers move it.
      </>
    ),
  },
];

// ─── Public Companies ────────────────────────────────────────────────

export const PUBLIC_COMPANIES_GUIDE: GuideStep[] = [
  {
    eyebrow: "1 of 4",
    title: "How this hub works",
    body: (
      <>
        Live financial data on 200 public companies — sourced from Nasdaq
        Data Link's SHARADAR + SEP datasets. Every metric is tappable and
        traces back to the upstream record.
      </>
    ),
  },
  {
    eyebrow: "2 of 4",
    title: "Market cap & EV",
    body: (
      <>
        Market cap = share price × shares outstanding. Enterprise value
        adds debt and subtracts cash — the full company-takeover number.
        Tap each to see the bridge.
      </>
    ),
  },
  {
    eyebrow: "3 of 4",
    title: "Multiples",
    body: (
      <>
        P/E = market cap ÷ net income. EV/EBITDA = enterprise value ÷
        EBITDA. FCF yield = free cash flow ÷ market cap. Tap each to
        compare to the industry band.
      </>
    ),
  },
  {
    eyebrow: "4 of 4",
    title: "Add as a peer",
    body: (
      <>
        Want to benchmark your private company against a public peer?
        Click "Add as peer" — the public company's numbers stream into
        your Benchmark Report.
      </>
    ),
  },
];

// ─── Products / SKU ──────────────────────────────────────────────────

export const PRODUCTS_GUIDE: GuideStep[] = [
  {
    eyebrow: "1 of 4",
    title: "SKU-level economics",
    body: (
      <>
        Every product line gets its own P&L. Revenue, gross margin, cost
        of capital tied up in inventory — so you can see which SKUs are
        actually profitable after carry costs.
      </>
    ),
  },
  {
    eyebrow: "2 of 4",
    title: "Decision buckets",
    body: (
      <>
        Protect, Watch, Wind-down. Each SKU lands in one of three buckets
        based on margin, velocity, and capital tied up. The rules are
        editable in the Decision Rules modal.
      </>
    ),
  },
  {
    eyebrow: "3 of 4",
    title: "DIO & cash trapped",
    body: (
      <>
        Days Inventory Outstanding × daily COGS = how much cash is sitting
        in each SKU's stock. High DIO + thin margin = the cash-burner
        pattern.
      </>
    ),
  },
  {
    eyebrow: "4 of 4",
    title: "Tap any row to drill",
    body: (
      <>
        Click any SKU to open its detail drawer. Margin, DIO, capital
        cost, signal — all learnable, all traceable to source. Ask CFO AI
        about any specific product line.
      </>
    ),
  },
];

// ─── Multi-year history ──────────────────────────────────────────────

export const MULTIYEAR_GUIDE: GuideStep[] = [
  {
    eyebrow: "1 of 3",
    title: "The long view",
    body: (
      <>
        Up to 10 years of public records pulled from listafirme.ro,
        termene.ro, and firme.info. Lets you see whether this year is a
        trend or a blip.
      </>
    ),
  },
  {
    eyebrow: "2 of 3",
    title: "What to look at first",
    body: (
      <>
        Revenue CAGR, profitability streaks, headcount growth, debt
        evolution. The Insights box below summarises what the data says
        in plain English.
      </>
    ),
  },
  {
    eyebrow: "3 of 3",
    title: "Limitations",
    body: (
      <>
        Public records are aggregate-only — no per-account drill-down.
        For full traceability you need the trial balance uploaded on the
        main analyst surface.
      </>
    ),
  },
];

// ─── Comprehensive Report ────────────────────────────────────────────

export const COMPREHENSIVE_GUIDE: GuideStep[] = [
  {
    eyebrow: "1 of 3",
    title: "Investor-grade memo",
    body: (
      <>
        Eight sections built end-to-end: Overview, P&L, Balance Sheet,
        Cash Flow, Ratios, Valuation, Risk & Credit, Recommendations.
        Same data as the dashboard, structured as a board read.
      </>
    ),
  },
  {
    eyebrow: "2 of 3",
    title: "Reconciliation",
    body: (
      <>
        Every section ties back to the underlying trial balance. The
        reconciliation footers tell you whether reconstructed values
        match the engine's canonical numbers (target: ≤ 0.5% drift).
      </>
    ),
  },
  {
    eyebrow: "3 of 3",
    title: "Export & share",
    body: (
      <>
        Print to PDF for board packets or investor decks — currency is
        threaded through the WeasyPrint render so you can output in RON,
        EUR, or USD without re-running anything.
      </>
    ),
  },
];
