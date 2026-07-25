// industryPrompts — industry-tailored "Suggested questions" for the Ask
// CFO AI empty state.
//
// The generic GENERAL_PROMPTS set (CFOEmptyState.tsx) is the fallback;
// when the active workspace has an `organizations.industry_key` (the
// coarse org-profile bucket picked at onboarding — see
// OrgIndustryPills.tsx for the canonical catalog), the empty state swaps
// in the matching set below so the starters speak the company's own
// language: cap rates for a property vehicle, ARR for a SaaS, WIP for a
// construction firm.
//
// Keys MUST mirror ORG_INDUSTRIES in OrgIndustryPills.tsx. `other` (and
// any unknown key) intentionally has no entry — callers fall back to
// GENERAL_PROMPTS.

import {
  AlertTriangle,
  Banknote,
  BarChart3,
  Building2,
  Calculator,
  CloudSun,
  FileText,
  GitCompare,
  HelpCircle,
  LineChart,
  Package,
  Percent,
  Repeat,
  Scale,
  ShieldAlert,
  Timer,
  Truck,
  TrendingUp,
  Users,
  Wallet,
  Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface SuggestedPrompt {
  icon: LucideIcon;
  title: string;
  prompt: string;
}

const INDUSTRY_PROMPTS: Record<string, SuggestedPrompt[]> = {
  real_estate: [
    { icon: Building2,    title: "Cap rates vs DCF",            prompt: "When valuing a commercial property vehicle, when should I lean on cap-rate valuation vs a full DCF, and how do the two reconcile?" },
    { icon: Calculator,   title: "DSCR for a property loan",     prompt: "Walk me through how a lender computes DSCR and ICR for a commercial real-estate loan, and what covenant levels are typical." },
    { icon: Scale,        title: "NAV cascade explained",        prompt: "Explain the NAV cascade for a single-asset property company: book NAV, adjusted NAV, EPRA NNNAV, and liquidation NAV." },
    { icon: Percent,      title: "Vacancy sensitivity",          prompt: "How do I stress-test NOI and debt service against vacancy and rent-indexation scenarios for an office/retail asset?" },
    { icon: AlertTriangle, title: "Refinancing wall",            prompt: "My property loan matures in 2 years. What should I prepare now to de-risk the refinancing, and what will lenders scrutinise?" },
    { icon: FileText,     title: "WAULT and lease quality",      prompt: "What is WAULT and how do lease length, break options, and tenant covenant strength drive a property's value?" },
    { icon: LineChart,    title: "Interest-rate hedging",        prompt: "Should a leveraged property vehicle hedge floating-rate debt? Compare caps, swaps, and staying unhedged." },
    { icon: HelpCircle,   title: "3-question lender brief",      prompt: "Help me draft a 3-question lender brief for a real-estate single-asset vehicle." },
  ],
  real_estate_residential: [
    { icon: Building2,    title: "Occupancy economics",          prompt: "How do occupancy, tenant churn, and re-letting downtime flow through to NOI in a residential rental portfolio?" },
    { icon: FileText,     title: "Reading a rent roll",          prompt: "What should a CFO look for when auditing a residential rent roll — red flags, concentration, arrears patterns?" },
    { icon: Percent,      title: "Yield on cost vs market yield", prompt: "Explain yield-on-cost vs market yield for a build-to-rent project, and when a development stops making sense." },
    { icon: Calculator,   title: "Debt sizing for BTR",          prompt: "How do lenders size debt for residential rental assets, and why is leverage typically lower than commercial?" },
    { icon: Wallet,       title: "Opex ratios",                  prompt: "What operating-expense ratio is normal for residential rental, and which cost lines usually hide inefficiency?" },
    { icon: TrendingUp,   title: "Exit cap assumptions",         prompt: "How sensitive is my exit value to the assumed exit cap rate, and how should I pick a defensible one?" },
    { icon: ShieldAlert,  title: "Regulatory risk",              prompt: "What regulatory and rent-control risks should a residential landlord monitor, and how do they affect valuation?" },
    { icon: HelpCircle,   title: "Portfolio vs single asset",    prompt: "When does it make sense to hold residential units in one vehicle vs splitting into separate SPVs?" },
  ],
  saas: [
    { icon: Repeat,       title: "ARR, NRR, and GRR",            prompt: "Define ARR, NRR, and GRR precisely, and tell me which one investors weight most and why." },
    { icon: BarChart3,    title: "Rule of 40",                   prompt: "Explain the Rule of 40 for SaaS, how to compute it from my P&L, and what a miss actually signals." },
    { icon: Calculator,   title: "CAC payback",                  prompt: "Walk me through CAC payback and LTV/CAC — what inputs do I need and what thresholds are healthy for B2B SaaS?" },
    { icon: Wallet,       title: "Burn multiple",                prompt: "What is the burn multiple, how do I compute it, and what does 'good' look like at my stage?" },
    { icon: Percent,      title: "SaaS gross margin",            prompt: "What belongs in SaaS cost of revenue, and what gross-margin range do buyers expect at scale?" },
    { icon: LineChart,    title: "Churn cohorts",                prompt: "How should I build a cohort retention analysis, and what churn patterns most damage valuation?" },
    { icon: FileText,     title: "Deferred revenue",             prompt: "Explain deferred revenue and billings vs revenue for annual-prepay SaaS contracts — what does a CFO need to get right?" },
    { icon: TrendingUp,   title: "SaaS valuation multiples",     prompt: "How are B2B SaaS companies valued today — revenue multiples vs EBITDA, and what drives the spread?" },
  ],
  fmcg: [
    { icon: Timer,        title: "Cash conversion cycle",        prompt: "Walk me through the cash conversion cycle for an FMCG distributor and what each component (DSO, DIO, DPO) actually measures." },
    { icon: Package,      title: "Inventory turns",              prompt: "What inventory turnover is healthy in food & beverage distribution, and how do I spot slow-moving stock early?" },
    { icon: Percent,      title: "Trade discounts & promos",     prompt: "How should trade discounts, promotions, and retailer bonuses be accounted for, and how do they distort gross margin?" },
    { icon: GitCompare,   title: "Margin structure vs peers",    prompt: "Break down a typical FMCG distribution P&L as % of revenue and tell me where mine could deviate from peers." },
    { icon: Banknote,     title: "Retailer payment terms",       prompt: "Large retail chains pay me in 60–90 days. What financing options exist for this receivables gap and what do they cost?" },
    { icon: AlertTriangle, title: "Private-label pressure",      prompt: "How does private-label growth threaten a branded FMCG portfolio, and what levers protect margin?" },
    { icon: LineChart,    title: "FX on imports",                prompt: "A chunk of my COGS is EUR-denominated imports. How should I think about FX hedging as a RON-revenue business?" },
    { icon: HelpCircle,   title: "Distress signals",             prompt: "What are the early distress signals a CFO should watch for in a working-capital-heavy business?" },
  ],
  manufacturing: [
    { icon: Wrench,       title: "Fixed-cost leverage",          prompt: "Explain operating leverage in a manufacturer: how utilization swings flow through to EBITDA, and how I find my break-even volume." },
    { icon: Calculator,   title: "Capex vs depreciation",        prompt: "My accumulated depreciation is high relative to gross PP&E. How do I size a modernization capex plan and fund it?" },
    { icon: LineChart,    title: "Energy cost hedging",          prompt: "Energy is a major cost line. What hedging and contracting strategies should a mid-size manufacturer consider?" },
    { icon: TrendingUp,   title: "EV/EBITDA for industrials",    prompt: "What EV/EBITDA range applies to industrial manufacturers in Romania, and what pushes a company to the top of it?" },
    { icon: Timer,        title: "Working capital in production", prompt: "How do raw materials, WIP, and finished goods each tie up cash, and where do manufacturers usually over-invest?" },
    { icon: GitCompare,   title: "Make vs buy",                  prompt: "Give me a CFO framework for make-vs-buy decisions, including the fixed-cost and quality dimensions people miss." },
    { icon: FileText,     title: "Read a RAS trial balance",     prompt: "How do I read a Romanian RAS trial balance? Walk me through classes 1–7." },
    { icon: ShieldAlert,  title: "Customer concentration",       prompt: "A few B2B customers dominate my revenue. How do I quantify concentration risk and what mitigations matter to lenders?" },
  ],
  retail_ecom: [
    { icon: Package,      title: "Inventory turn & markdowns",   prompt: "How do inventory turnover and markdown discipline drive retail profitability, and what metrics should I track weekly?" },
    { icon: Calculator,   title: "Contribution per order",       prompt: "Build me a contribution-margin-per-order model for e-commerce: what belongs in it and what's a healthy target?" },
    { icon: Repeat,       title: "Repeat rate & cohorts",        prompt: "How do repeat-purchase rate and cohort LTV change what I can afford to spend on acquisition?" },
    { icon: Timer,        title: "Seasonal working capital",     prompt: "How should a seasonal retailer plan working-capital financing around inventory build-up before peak season?" },
    { icon: Percent,      title: "Returns accounting",           prompt: "How should product returns be accounted for, and at what return rate does a category stop being viable?" },
    { icon: GitCompare,   title: "Store vs online P&L",          prompt: "How do I split a P&L between physical stores and online so channel profitability is honest — including shared costs?" },
    { icon: Banknote,     title: "Cash conversion",              prompt: "Walk me through the cash conversion cycle for retail and how negative working capital can fund growth." },
    { icon: AlertTriangle, title: "Distress signals",            prompt: "What are the early distress signals a CFO should watch for in a retail business?" },
  ],
  professional_services: [
    { icon: Users,        title: "Utilization & realization",    prompt: "Define utilization and realization rates for a services firm and show how small drops compound into margin erosion." },
    { icon: Calculator,   title: "Billable leverage model",      prompt: "Explain the leverage model (partner : senior : junior ratios) and how it drives profitability in professional services." },
    { icon: FileText,     title: "WIP and unbilled AR",          prompt: "How should I manage and account for work-in-progress and unbilled receivables, and when do they become a red flag?" },
    { icon: Percent,      title: "Pricing models",               prompt: "Compare hourly billing, fixed fee, and value pricing from a CFO's margin-risk perspective." },
    { icon: BarChart3,    title: "Revenue per FTE",              prompt: "What revenue-per-FTE and profit-per-partner benchmarks apply to professional-services firms, and how do I improve mine?" },
    { icon: LineChart,    title: "Project profitability",        prompt: "Design a simple project-profitability report that catches scope creep and under-recovery early." },
    { icon: TrendingUp,   title: "Valuing a services firm",      prompt: "How are professional-services firms valued, and why do people-dependent businesses trade at a discount?" },
    { icon: HelpCircle,   title: "Partner comp vs EBITDA",       prompt: "How should partner compensation be normalized when presenting EBITDA to a buyer or lender?" },
  ],
  construction: [
    { icon: FileText,     title: "Percentage of completion",     prompt: "Explain percentage-of-completion revenue recognition for construction contracts and where it typically goes wrong." },
    { icon: Timer,        title: "WIP schedule",                 prompt: "Walk me through reading a WIP schedule: over/under-billings, estimated costs to complete, and fade analysis." },
    { icon: Banknote,     title: "Retention & milestones",       prompt: "How do milestone billing and retention clauses shape construction cash flow, and how do I finance the gaps?" },
    { icon: AlertTriangle, title: "Project margin erosion",      prompt: "What early indicators show a project's margin is eroding, and what should trigger a re-forecast?" },
    { icon: Scale,        title: "Bonding & guarantees",         prompt: "Explain performance bonds and bank guarantees: how they're sized, what they cost, and how they constrain capacity." },
    { icon: GitCompare,   title: "Claims & variations",          prompt: "How should variations and claims be valued and recognized — and when is claimed revenue too aggressive?" },
    { icon: BarChart3,    title: "Backlog quality",              prompt: "How do I assess backlog quality — signed vs framework vs pipeline — when forecasting next year's revenue?" },
    { icon: ShieldAlert,  title: "Subcontractor risk",           prompt: "What subcontractor financial-health checks should a main contractor run, and what happens when one fails mid-project?" },
  ],
  healthcare: [
    { icon: Users,        title: "Payer mix",                    prompt: "Explain payer mix for a clinic (CNAS vs private vs out-of-pocket) and how it drives margin and receivables risk." },
    { icon: Calculator,   title: "Per-visit unit economics",     prompt: "Build per-visit unit economics for a clinic: revenue, direct cost, contribution, and physician capacity." },
    { icon: Wrench,       title: "Equipment capex",              prompt: "How should I evaluate a major medical-equipment purchase — utilization thresholds, financing options, payback?" },
    { icon: Percent,      title: "Staff cost ratio",             prompt: "What staff-cost-to-revenue ratio is sustainable in healthcare services, and how do I benchmark clinician productivity?" },
    { icon: Banknote,     title: "Insurer receivables",          prompt: "Receivables from insurers and CNAS settle slowly. How do I manage and finance this working-capital drag?" },
    { icon: TrendingUp,   title: "Clinic expansion math",        prompt: "Give me a framework for deciding whether to open a second location: fixed-cost step-ups, ramp curves, cannibalization." },
    { icon: ShieldAlert,  title: "Regulatory exposure",          prompt: "What regulatory and reimbursement-change risks should a healthcare CFO stress-test in the plan?" },
    { icon: LineChart,    title: "Fixed-cost leverage",          prompt: "Healthcare has high fixed costs. How do volume swings flow through to EBITDA and what's my break-even patient volume?" },
  ],
  logistics: [
    { icon: Truck,        title: "Route economics",              prompt: "Break down per-route economics for a transport company: what belongs in the contribution margin per kilometre?" },
    { icon: Calculator,   title: "Fleet capex & residuals",      prompt: "How should I plan fleet renewal — lease vs buy, residual-value risk, and the cost of running trucks too long?" },
    { icon: Percent,      title: "Fuel surcharge mechanisms",    prompt: "Explain fuel surcharge clauses and how to protect margin when diesel prices spike." },
    { icon: BarChart3,    title: "Load factor",                  prompt: "How do load factor and empty-kilometre share drive profitability, and what's realistic to target?" },
    { icon: Users,        title: "Driver cost inflation",        prompt: "Driver wages keep rising. How do I model this into pricing and when does a route stop being viable?" },
    { icon: GitCompare,   title: "Contract vs spot mix",         prompt: "What's the right balance between contracted volumes and spot-market freight from a risk-return perspective?" },
    { icon: TrendingUp,   title: "Valuing a transport firm",     prompt: "What EV/EBITDA multiples apply to logistics and transport companies, and how does fleet age affect the price?" },
    { icon: Timer,        title: "Working capital in freight",   prompt: "Shippers pay late, drivers and fuel are paid now. How do I size and finance this working-capital gap?" },
  ],
  agriculture: [
    { icon: CloudSun,     title: "Seasonality & cash flow",      prompt: "Map a typical crop-year cash-flow curve and tell me how to size the seasonal credit line correctly." },
    { icon: Banknote,     title: "APIA subsidies",               prompt: "How should APIA and EU subsidies be accounted for and forecast, and how much should the plan depend on them?" },
    { icon: Package,      title: "Crop inventory valuation",     prompt: "How is harvested crop inventory valued under RAS, and when should I sell vs store — what's the carry math?" },
    { icon: LineChart,    title: "Grain price hedging",          prompt: "What hedging instruments exist for grain prices, and how would a mid-size farm actually use them?" },
    { icon: Scale,        title: "Land: lease vs own",           prompt: "Compare leasing vs buying farmland from a returns and balance-sheet perspective." },
    { icon: AlertTriangle, title: "Weather & yield risk",        prompt: "How do I quantify weather and yield risk in the financial plan, and what insurance is worth buying?" },
    { icon: TrendingUp,   title: "EU funds for agriculture",     prompt: "What EU funding programs can finance farm equipment and storage, and how does co-financing affect my leverage?" },
    { icon: Timer,        title: "Storage economics",            prompt: "Does investing in my own storage capacity pay off? Walk me through the capex-vs-carry decision." },
  ],
};

/** Industry-tailored prompt set for the given org industry_key, or null
 *  when the key is unknown / "other" — callers fall back to
 *  GENERAL_PROMPTS. */
export function promptsForIndustry(
  industryKey: string | null | undefined,
): SuggestedPrompt[] | null {
  if (!industryKey) return null;
  return INDUSTRY_PROMPTS[industryKey] ?? null;
}
