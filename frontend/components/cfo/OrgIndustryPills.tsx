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
            // Selected card carries the animated teal gradient fill
            // (2026-07-26 per operator) — the same `.ask-ai-anim-fill`
            // treatment used by the Ask CFO AI pill and the Apply-changes
            // button, so "chosen" reads the same way across the app.
            //
            // Zoomed in (2026-07-26 per operator): --af-band widens the
            // gradient's stop spacing from the 100px default to 220px, so each
            // card shows ~two broad bands instead of a fine stripe pattern.
            // --af-shift MUST track it — the CSS contract is
            // shift = (4 × band) / cos(45°) = 4 × 220 × 1.414214 ≈ 1244.51px —
            // or the sweep's loop point stops matching and the gradient visibly
            // jumps once per cycle. Duration is up from 14s to keep the px/s
            // travel calm now that the pattern is 2.2× larger.
            className={`relative text-left rounded-xl border px-3.5 py-3 transition-colors ${
              active
                ? "ask-ai-anim-fill [--af-band:220px] [--af-shift:1244.51px] [animation-duration:20s] border-brand/50 text-ink"
                : "border-rule bg-bg-2/40 hover:border-rule-strong hover:bg-bg-2/70"
            }`}
          >
            {/* Selected marker — the same brand dot the workspace cards use
                (2026-07-26 per operator), replacing the checkmark so both
                selection surfaces read identically. Visual only: a colored
                circle says nothing aloud, and aria-checked already carries
                the state for screen readers. */}
            {active && (
              <span
                aria-hidden
                className="absolute right-3 top-3 h-2.5 w-2.5 rounded-full bg-brand shadow-[0_0_8px_rgba(92,211,197,0.6)]"
              />
            )}
            <div className="text-[13px] font-medium pr-6">{i.label}</div>
            <div className="text-[11.5px] text-ink-soft mt-0.5 leading-snug">
              {i.description}
            </div>
          </button>
        );
      })}
    </div>
  );
}
