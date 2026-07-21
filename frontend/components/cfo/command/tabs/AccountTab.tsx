// AccountTab.tsx — Account block at the top of the Command Center.
//
// Layout (per the operator's directive):
//   · Profile header   — avatar (initials) + name + email (opens /settings)
//   · Plan + usage      — plan name / price + "Documents this month · N / M"
//                         (mirrors the top-right AccountMenu dropdown)
//   · Settings · Log out — two quick-action buttons
//
// The Workspace (StateCard) + Data sections render BELOW this block, wired
// in CommandCenter.tsx.
//
// Sign-out note: the top-right <AccountMenu/> still hosts a sign-out
// (`data-testid="account-menu-sign-out"`). The "Log out" button here is a
// second entry point added on request — labelled "Log out" (not "Sign out")
// and using its own testid so it stays distinct.

import { LogOut, Settings, User } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { planUsagePct, usePlanState } from "@/lib/planState";

interface Props {
  /** Close the Command Center after launching an action. */
  onClose: () => void;
}

export function AccountTab({ onClose }: Props) {
  const navigate = useNavigate();
  const { user, displayName, initials, signOut } = useAuth();
  const { state: plan } = usePlanState();
  const { toast } = useToast();

  function launch(fn: () => void) {
    onClose();
    setTimeout(fn, 220);
  }

  async function handleSignOut() {
    onClose();
    const { error } = await signOut();
    toast({
      title: error ? "Couldn't sign out" : "Signed out",
      description: error?.message,
      variant: error ? "destructive" : undefined,
    });
    if (!error) navigate("/", { replace: true });
  }

  return (
    <>
      {/* Profile header — avatar (initials) + name, email beneath. The whole
          block opens /settings (Manage profile). */}
      <button
        type="button"
        onClick={() => launch(() => navigate("/settings"))}
        data-testid="cmd-account-profile"
        className="w-full flex items-center gap-3 pl-1 pr-10 py-1.5 text-left rounded-xl hover:bg-bg-2/50 transition-colors"
      >
        <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand text-paper text-[14px] font-semibold tracking-tight">
          {initials ?? <User size={18} strokeWidth={1.75} />}
        </span>
        <span className="min-w-0">
          <span className="block text-[15px] font-semibold text-ink leading-tight truncate">
            {displayName ?? user?.email ?? "Account"}
          </span>
          {user?.email && (
            <span className="block text-[12.5px] text-ink-mute leading-snug truncate">
              {user.email}
            </span>
          )}
        </span>
      </button>

      {/* Plan status + usage — copied from the top-right account-menu
          dropdown (plan name / price + documents-this-month progress). */}
      {plan && (
        <div
          data-testid="cmd-account-plan"
          className="mt-3"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="inline-flex items-center gap-2 min-w-0 flex-wrap">
              <span aria-hidden className="relative inline-flex h-2 w-2 shrink-0">
                <span className="absolute inline-flex h-full w-full rounded-full bg-brand opacity-75 animate-ping" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-brand" />
              </span>
              <span className="text-[13px] font-medium text-ink truncate">
                {plan.plan_display_name} plan
              </span>
              <span aria-hidden className="text-ink-mute">·</span>
              <button
                type="button"
                onClick={() => launch(() => navigate("/settings"))}
                data-testid="cmd-account-change-plan"
                className="text-[12px] text-ink-mute hover:text-ink underline-offset-2 hover:underline transition-colors"
              >
                Change in Settings
              </button>
            </div>
          </div>

          <div className="mt-0.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[11.5px] text-ink-soft">Usage</span>
              <span className="text-[11.5px] font-medium text-ink-soft tabular-nums">
                {planUsagePct(plan.docs_used, plan.included_docs)}%
              </span>
            </div>
            <div className="mt-1.5 h-1.5 rounded-full bg-rule overflow-hidden">
              <div
                className={`h-full rounded-full transition-[width] ${
                  plan.docs_used >= plan.included_docs ? "bg-[#5CD3C5]" : "bg-brand"
                }`}
                style={{
                  width: `${planUsagePct(plan.docs_used, plan.included_docs)}%`,
                }}
                role="progressbar"
                aria-valuenow={plan.docs_used}
                aria-valuemax={plan.included_docs}
                aria-label="Documents this month"
              />
            </div>
          </div>
        </div>
      )}

      {/* Settings · Log out */}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => launch(() => navigate("/settings"))}
          data-testid="cmd-account-settings"
          className="inline-flex items-center justify-center gap-1.5 h-9 rounded-lg border border-rule bg-surface text-[13px] font-medium text-ink hover:bg-bg-2/60 hover:border-rule-strong transition-colors"
        >
          <Settings size={14} strokeWidth={1.75} />
          Settings
        </button>
        <button
          type="button"
          onClick={() => void handleSignOut()}
          data-testid="cmd-account-logout"
          className="inline-flex items-center justify-center gap-1.5 h-9 rounded-lg border border-rule bg-surface text-[13px] font-medium text-ink hover:bg-red-500/10 hover:text-red-700 hover:border-red-500/30 transition-colors"
        >
          <LogOut size={14} strokeWidth={1.75} />
          Log out
        </button>
      </div>
    </>
  );
}
