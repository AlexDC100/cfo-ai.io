// /onboarding — captures the industry of the user's organization so the
// pipeline can apply industry-aware thresholds and Opus 4.7 narrative.
//
// Reached automatically after signup (AuthCard → /onboarding) and from
// AuthGuard for any signed-in user whose org doesn't yet have an industry
// set. The user can't reach /dashboard or /upload until they've completed
// this step.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Building2, Loader2 } from "lucide-react";
import { Logo } from "@/components/cfo/Logo";
import { OrgIndustryPills, orgIndustryLabel } from "@/components/cfo/OrgIndustryPills";
import { ThemeToggle } from "@/components/cfo/ThemeToggle";
import { useAuth } from "@/lib/auth";
import { useActiveOrg, updateActiveOrg, refreshActiveOrg } from "@/lib/org";
import { useToast } from "@/hooks/use-toast";

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
      navigate("/dashboard", { replace: true });
    }
  }, [loading, org, navigate]);

  async function handleContinue() {
    if (!industryKey || !org) {
      toast({ title: "Pick an industry to continue", variant: "destructive" });
      return;
    }
    const display = orgIndustryLabel(industryKey);
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
    navigate("/dashboard", { replace: true });
  }

  return (
    <div className="min-h-screen bg-bg text-ink flex flex-col">
      <header
        className="px-4 sm:px-10 py-5 flex items-center justify-between gap-3"
        style={{ paddingTop: "max(1.25rem, env(safe-area-inset-top))" }}
      >
        <div className="flex items-center gap-3">
          <Logo size={26} compact />
          <span className="hidden sm:inline-flex text-[10.5px] uppercase tracking-[0.18em] text-ink-soft pl-3 border-l border-rule">
            Set up your workspace
          </span>
        </div>
        <ThemeToggle compact />
      </header>

      <main
        className="flex-1 flex items-center justify-center px-4 sm:px-5 py-8 sm:py-16"
        style={{ paddingBottom: "max(2rem, env(safe-area-inset-bottom) + 1rem)" }}
      >
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
              <OrgIndustryPills value={industryKey} onChange={setIndustryKey} />
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
