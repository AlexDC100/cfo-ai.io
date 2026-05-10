// /onboarding — captures the industry of the user's organization so the
// pipeline can apply industry-aware thresholds and Opus 4.7 narrative.
//
// Reached automatically after signup (AuthCard → /onboarding) and from
// AuthGuard for any signed-in user whose org doesn't yet have an industry
// set. The user can't reach /dashboard or /upload until they've completed
// this step.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Building2, Check, Loader2 } from "lucide-react";
import { Logo } from "@/components/cfo/Logo";
import { ThemeToggle } from "@/components/cfo/ThemeToggle";
import { useAuth } from "@/lib/auth";
import { useActiveOrg, updateActiveOrg, refreshActiveOrg } from "@/lib/org";
import { useToast } from "@/hooks/use-toast";

const INDUSTRIES: Array<{ key: string; label: string; description: string }> = [
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

export default function Onboarding() {
  const navigate = useNavigate();
  const { status, displayName, companyName } = useAuth();
  const { org, loading } = useActiveOrg();
  const { toast } = useToast();
  const [industryKey, setIndustryKey] = useState<string | null>(null);
  const [orgName, setOrgName] = useState("");
  const [busy, setBusy] = useState(false);

  // Land non-signed-in users on /login. Already-onboarded users skip ahead.
  useEffect(() => {
    if (status === "signed_out") navigate("/login?next=/onboarding", { replace: true });
  }, [status, navigate]);

  useEffect(() => {
    if (org && !orgName) setOrgName(org.name);
    if (org?.industry_key) setIndustryKey(org.industry_key);
  }, [org, orgName]);

  // If org already has an industry, skip onboarding entirely.
  useEffect(() => {
    if (!loading && org && org.industry_key) {
      navigate("/upload", { replace: true });
    }
  }, [loading, org, navigate]);

  async function handleContinue() {
    if (!industryKey || !org) {
      toast({ title: "Pick an industry to continue", variant: "destructive" });
      return;
    }
    const display = INDUSTRIES.find((i) => i.key === industryKey)?.label ?? industryKey;
    setBusy(true);
    const ok = await updateActiveOrg({
      name: orgName || org.name,
      industry_key: industryKey,
      industry_display_name: display,
    });
    setBusy(false);
    if (!ok) {
      toast({ title: "Couldn't save", description: "Check your connection and try again.", variant: "destructive" });
      return;
    }
    await refreshActiveOrg();
    navigate("/upload", { replace: true });
  }

  return (
    <div className="min-h-screen bg-bg text-ink flex flex-col">
      <header className="px-6 sm:px-10 py-5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Logo size={26} compact />
          <span className="hidden sm:inline-flex text-[10.5px] uppercase tracking-[0.18em] text-ink-soft pl-3 border-l border-rule">
            Set up your workspace
          </span>
        </div>
        <ThemeToggle compact />
      </header>

      <main className="flex-1 flex items-center justify-center px-5 py-10 sm:py-16">
        <div className="w-full max-w-[640px]">
          <div className="mb-6">
            <div className="label-eyebrow">Step 1 of 2 · Industry</div>
            <h1 className="mt-2 font-serif text-[32px] sm:text-[40px] leading-[1.05] tracking-[-0.02em]">
              Welcome{displayName ? `, ${displayName.split(" ")[0]}` : ""}.
            </h1>
            <p className="mt-3 text-[14px] text-ink-soft max-w-[520px]">
              Pick the closest match to your company's industry. CFO AI applies
              industry-appropriate benchmarks — a 4× Debt/EBITDA is normal in real estate
              and alarming in B2B SaaS.
            </p>
          </div>

          <div className="rounded-3xl border border-rule bg-surface/80 backdrop-blur-xl p-6 sm:p-7 space-y-5">
            <label className="block">
              <div className="text-[11px] uppercase tracking-[0.08em] text-ink-mute mb-1.5">Company name</div>
              <div className="flex items-center gap-2 rounded-lg border border-rule bg-bg-2/40 px-3 h-11">
                <Building2 size={14} className="text-ink-mute" strokeWidth={1.75} />
                <input
                  className="flex-1 bg-transparent text-[14px] outline-none placeholder:text-ink-soft/70"
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                  placeholder={companyName ?? "Acme Romania SRL"}
                  autoComplete="organization"
                />
              </div>
            </label>

            <div>
              <div className="text-[11px] uppercase tracking-[0.08em] text-ink-mute mb-2">Industry</div>
              <div className="grid sm:grid-cols-2 gap-2" role="radiogroup" aria-label="Industry">
                {INDUSTRIES.map((i) => {
                  const active = industryKey === i.key;
                  return (
                    <button
                      key={i.key}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setIndustryKey(i.key)}
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
            </div>

            <div className="pt-2 flex items-center justify-end gap-2">
              <button
                type="button"
                disabled={busy || !industryKey || !orgName.trim()}
                onClick={handleContinue}
                className="
                  inline-flex items-center justify-center gap-2 h-11 px-5 rounded-full
                  bg-brand text-paper text-[13.5px] font-medium
                  hover:bg-brand-d transition-colors
                  disabled:opacity-50
                "
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : null}
                Continue to upload
              </button>
            </div>
          </div>

          <p className="mt-4 text-[11.5px] text-ink-mute text-center">
            You can change this later from Settings · Workspace.
          </p>
        </div>
      </main>
    </div>
  );
}
