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
//
// i18n (2026-08-04): defs carry icons + i18n base keys only; the visible
// title/prompt strings resolve through t() in useIndustryPrompts so they
// follow the active language — the same pattern as useWorkspacePrompts /
// useGeneralPrompts in CFOEmptyState.tsx. Prompt TEXT deliberately ships
// in the user's active language (the model answers in the language it is
// asked in). A few entries reuse the identical general-set strings
// (chatX.prompts.gen.*) rather than duplicating them.

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
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

/** def.k is the i18n BASE key — `${k}.title` / `${k}.prompt` resolve the
 *  visible strings in the active language. */
interface PromptDef {
  icon: LucideIcon;
  k: string;
}

const I = "chatX.prompts.ind";
const G = "chatX.prompts.gen";

const INDUSTRY_PROMPT_DEFS: Record<string, PromptDef[]> = {
  real_estate: [
    { icon: Building2,    k: `${I}.real_estate.capRates` },
    { icon: Calculator,   k: `${I}.real_estate.dscr` },
    { icon: Scale,        k: `${I}.real_estate.navCascade` },
    { icon: Percent,      k: `${I}.real_estate.vacancy` },
    { icon: AlertTriangle, k: `${I}.real_estate.refi` },
    { icon: FileText,     k: `${I}.real_estate.wault` },
    { icon: LineChart,    k: `${I}.real_estate.rateHedging` },
    { icon: HelpCircle,   k: `${G}.lenderBrief` },
  ],
  real_estate_residential: [
    { icon: Building2,    k: `${I}.real_estate_residential.occupancy` },
    { icon: FileText,     k: `${I}.real_estate_residential.rentRoll` },
    { icon: Percent,      k: `${I}.real_estate_residential.yieldOnCost` },
    { icon: Calculator,   k: `${I}.real_estate_residential.debtSizing` },
    { icon: Wallet,       k: `${I}.real_estate_residential.opexRatios` },
    { icon: TrendingUp,   k: `${I}.real_estate_residential.exitCap` },
    { icon: ShieldAlert,  k: `${I}.real_estate_residential.regRisk` },
    { icon: HelpCircle,   k: `${I}.real_estate_residential.portfolioVsSingle` },
  ],
  saas: [
    { icon: Repeat,       k: `${I}.saas.arr` },
    { icon: BarChart3,    k: `${I}.saas.ruleOf40` },
    { icon: Calculator,   k: `${I}.saas.cacPayback` },
    { icon: Wallet,       k: `${I}.saas.burnMultiple` },
    { icon: Percent,      k: `${I}.saas.grossMargin` },
    { icon: LineChart,    k: `${I}.saas.churnCohorts` },
    { icon: FileText,     k: `${I}.saas.deferredRevenue` },
    { icon: TrendingUp,   k: `${I}.saas.multiples` },
  ],
  fmcg: [
    { icon: Timer,        k: `${I}.fmcg.ccc` },
    { icon: Package,      k: `${I}.fmcg.inventoryTurns` },
    { icon: Percent,      k: `${I}.fmcg.tradeDiscounts` },
    { icon: GitCompare,   k: `${I}.fmcg.marginVsPeers` },
    { icon: Banknote,     k: `${I}.fmcg.retailerTerms` },
    { icon: AlertTriangle, k: `${I}.fmcg.privateLabel` },
    { icon: LineChart,    k: `${I}.fmcg.fxImports` },
    { icon: HelpCircle,   k: `${G}.distress` },
  ],
  manufacturing: [
    { icon: Wrench,       k: `${I}.manufacturing.fixedCostLeverage` },
    { icon: Calculator,   k: `${I}.manufacturing.capexVsDepreciation` },
    { icon: LineChart,    k: `${I}.manufacturing.energyHedging` },
    { icon: TrendingUp,   k: `${I}.manufacturing.evEbitda` },
    { icon: Timer,        k: `${I}.manufacturing.workingCapital` },
    { icon: GitCompare,   k: `${I}.manufacturing.makeVsBuy` },
    { icon: FileText,     k: `${I}.manufacturing.ras` },
    { icon: ShieldAlert,  k: `${I}.manufacturing.customerConcentration` },
  ],
  retail_ecom: [
    { icon: Package,      k: `${I}.retail_ecom.inventoryMarkdowns` },
    { icon: Calculator,   k: `${I}.retail_ecom.contributionPerOrder` },
    { icon: Repeat,       k: `${I}.retail_ecom.repeatCohorts` },
    { icon: Timer,        k: `${I}.retail_ecom.seasonalWc` },
    { icon: Percent,      k: `${I}.retail_ecom.returns` },
    { icon: GitCompare,   k: `${I}.retail_ecom.storeVsOnline` },
    { icon: Banknote,     k: `${I}.retail_ecom.cashConversion` },
    { icon: AlertTriangle, k: `${I}.retail_ecom.distress` },
  ],
  professional_services: [
    { icon: Users,        k: `${I}.professional_services.utilization` },
    { icon: Calculator,   k: `${I}.professional_services.leverageModel` },
    { icon: FileText,     k: `${I}.professional_services.wip` },
    { icon: Percent,      k: `${I}.professional_services.pricingModels` },
    { icon: BarChart3,    k: `${I}.professional_services.revenuePerFte` },
    { icon: LineChart,    k: `${I}.professional_services.projectProfitability` },
    { icon: TrendingUp,   k: `${I}.professional_services.valuation` },
    { icon: HelpCircle,   k: `${I}.professional_services.partnerComp` },
  ],
  construction: [
    { icon: FileText,     k: `${I}.construction.poc` },
    { icon: Timer,        k: `${I}.construction.wipSchedule` },
    { icon: Banknote,     k: `${I}.construction.retention` },
    { icon: AlertTriangle, k: `${I}.construction.marginErosion` },
    { icon: Scale,        k: `${I}.construction.bonding` },
    { icon: GitCompare,   k: `${I}.construction.claims` },
    { icon: BarChart3,    k: `${I}.construction.backlog` },
    { icon: ShieldAlert,  k: `${I}.construction.subcontractorRisk` },
  ],
  healthcare: [
    { icon: Users,        k: `${I}.healthcare.payerMix` },
    { icon: Calculator,   k: `${I}.healthcare.unitEconomics` },
    { icon: Wrench,       k: `${I}.healthcare.equipmentCapex` },
    { icon: Percent,      k: `${I}.healthcare.staffCostRatio` },
    { icon: Banknote,     k: `${I}.healthcare.insurerReceivables` },
    { icon: TrendingUp,   k: `${I}.healthcare.expansion` },
    { icon: ShieldAlert,  k: `${I}.healthcare.regulatory` },
    { icon: LineChart,    k: `${I}.healthcare.fixedCostLeverage` },
  ],
  logistics: [
    { icon: Truck,        k: `${I}.logistics.routeEconomics` },
    { icon: Calculator,   k: `${I}.logistics.fleetCapex` },
    { icon: Percent,      k: `${I}.logistics.fuelSurcharge` },
    { icon: BarChart3,    k: `${I}.logistics.loadFactor` },
    { icon: Users,        k: `${I}.logistics.driverCosts` },
    { icon: GitCompare,   k: `${I}.logistics.contractVsSpot` },
    { icon: TrendingUp,   k: `${I}.logistics.valuation` },
    { icon: Timer,        k: `${I}.logistics.workingCapital` },
  ],
  agriculture: [
    { icon: CloudSun,     k: `${I}.agriculture.seasonality` },
    { icon: Banknote,     k: `${I}.agriculture.subsidies` },
    { icon: Package,      k: `${I}.agriculture.cropInventory` },
    { icon: LineChart,    k: `${I}.agriculture.grainHedging` },
    { icon: Scale,        k: `${I}.agriculture.landLeaseVsOwn` },
    { icon: AlertTriangle, k: `${I}.agriculture.weatherRisk` },
    { icon: TrendingUp,   k: `${I}.agriculture.euFunds` },
    { icon: Timer,        k: `${I}.agriculture.storage` },
  ],
};

/** Industry-tailored prompt set for the given org industry_key, resolved
 *  in the active language, or null when the key is unknown / "other" —
 *  callers fall back to GENERAL_PROMPTS. */
export function useIndustryPrompts(
  industryKey: string | null | undefined,
): SuggestedPrompt[] | null {
  const { t } = useTranslation();
  return useMemo(() => {
    const defs = industryKey ? INDUSTRY_PROMPT_DEFS[industryKey] : undefined;
    if (!defs) return null;
    return defs.map((d) => ({
      icon: d.icon,
      title: t(`${d.k}.title`),
      prompt: t(`${d.k}.prompt`),
    }));
  }, [industryKey, t]);
}
