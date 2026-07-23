// OrgIndustryPills — the organization-level industry selector.
//
// One catalog, two surfaces: the /onboarding page (post-signup) and the
// workspace wizard's Name step (creating an additional SRL / restarting
// setup). Extracted so the two can't drift — the keys land in
// `organizations.industry_key` and drive industry-aware thresholds, so a
// fork here would mean the same company classified differently depending
// on which door it came in through.
//
// Not to be confused with `components/cfo/industry/` — that picker is the
// per-period CAEN benchmark classification. This one is the coarse
// org-profile bucket chosen by the user at setup.

import { Check } from "lucide-react";

export interface OrgIndustry {
  key: string;
  label: string;
  description: string;
}

export const ORG_INDUSTRIES: OrgIndustry[] = [
  { key: "real_estate", label: "Real estate · commercial property", description: "Office, retail, logistics — high leverage normal, NOI-driven" },
  { key: "real_estate_residential", label: "Real estate · residential rental", description: "Apartments, BTR — lower leverage, occupancy-sensitive" },
  { key: "saas", label: "B2B SaaS", description: "Recurring revenue, ARR/NRR-focused, rule-of-40" },
  { key: "fmcg", label: "FMCG · food & beverage distribution", description: "High inventory turn, thin margins, working-capital heavy" },
  { key: "manufacturing", label: "Manufacturing · industrial", description: "Capex-intensive, long cycles, fixed cost leverage" },
  { key: "retail_ecom", label: "Retail · e-commerce", description: "Inventory turn + AOV + repeat-rate driven" },
  { key: "professional_services", label: "Professional services", description: "Utilization, billable hours, low capex" },
  { key: "construction", label: "Construction", description: "Project-based, WIP-heavy, milestone billing" },
  { key: "healthcare", label: "Healthcare · clinics", description: "Regulated, payer-mix sensitive, high fixed cost" },
  { key: "logistics", label: "Logistics · transport", description: "Fleet capex, fuel-margin sensitive, route economics" },
  { key: "agriculture", label: "Agriculture", description: "Seasonal, weather-exposed, subsidy-aware" },
  { key: "other", label: "Other", description: "Generic SME thresholds — refine later" },
];

/** Display label for a stored industry_key; falls back to the raw key. */
export function orgIndustryLabel(key: string): string {
  return ORG_INDUSTRIES.find((i) => i.key === key)?.label ?? key;
}

export function OrgIndustryPills({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (key: string) => void;
}) {
  return (
    <div className="grid sm:grid-cols-2 gap-2" role="radiogroup" aria-label="Industry">
      {ORG_INDUSTRIES.map((i) => {
        const active = value === i.key;
        return (
          <button
            key={i.key}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(i.key)}
            data-testid={`industry-pill-${i.key}`}
            className={`text-left rounded-xl border px-3.5 py-3 transition-colors ${
              active
                ? "border-brand bg-brand/10 text-ink"
                : "border-rule bg-bg-2/40 hover:border-rule-strong hover:bg-bg-2/70"
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="text-[13px] font-medium">{i.label}</div>
              {active && <Check size={14} className="text-brand mt-0.5" strokeWidth={2.25} />}
            </div>
            <div className="text-[11.5px] text-ink-soft mt-0.5 leading-snug">
              {i.description}
            </div>
          </button>
        );
      })}
    </div>
  );
}
