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

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { LogOut, Settings, User } from "lucide-react";
import { ThemePicker } from "@/components/cfo/ThemePicker";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { isNativeShell, nativeSheetKind } from "@/lib/nativeShell";
import { useNavigate } from "react-router-dom";

import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { usePlanState } from "@/lib/planState";
import { formatTokens, tokenUsage } from "@/lib/tokenUsage";

interface Props {
  /** Close the Command Center after launching an action. */
  onClose: () => void;
}

export function AccountTab({ onClose }: Props) {
  const navigate = useNavigate();
  const { user, displayName, initials, signOut } = useAuth();
  const { t } = useTranslation();
  const { state: plan } = usePlanState();
  const { toast } = useToast();

  function launch(fn: () => void) {
    // Inside an iOS native sheet the page IS the sheet: closing first would
    // tear this WebView down before the deferred action ran (the Settings
    // button did nothing, 2026-09-08). Act now — the route watcher dismisses
    // the sheet and routes the main page.
    if (nativeSheetKind()) {
      fn();
      return;
    }
    onClose();
    setTimeout(fn, 220);
  }

  // Sign-out asks first (2026-09-08 per operator) — the confirm dialog below.
  const [confirmSignOut, setConfirmSignOut] = useState(false);

  async function handleSignOut() {
    setConfirmSignOut(false);
    // Sign out BEFORE closing: inside the iOS native sheet, closing tears
    // the sheet's WebView down, and a sign-out still in flight would be
    // lost — the main page then reloads still signed in.
    const { error } = await signOut();
    onClose();
    toast({
      title: error ? "Couldn't sign out" : "Signed out",
      description: error?.message,
      variant: error ? "destructive" : undefined,
    });
    // Inside the native shell stay IN the app, signed out (guest mode on the
    // dashboard) — "/" is the marketing site, which read as being thrown out
    // to the web version (2026-09-08 per operator). Browsers keep "/".
    if (!error) navigate(isNativeShell() ? "/dashboard" : "/", { replace: true });
  }

  return (
    <>
      {/* Profile header — avatar (initials) + name, email beneath.
          Display-only (2026-07-24; it used to be a button opening
          /settings — the Settings quick-action below covers that). */}
      <div
        data-testid="cmd-account-profile"
        className="w-full flex items-center gap-3 pl-1 pr-10 py-1.5 text-left rounded-xl"
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
      </div>

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
            </div>
          </div>

          {/* Token budget (Claude-style, 2026-07-24) — chats + document
              analyses spend from one allowance; see lib/tokenUsage. */}
          {(() => {
            const tokens = tokenUsage(plan);
            return (
              <div className="mt-0.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[11.5px] text-ink-soft">Tokens</span>
                  <span className="text-[11.5px] font-medium text-ink-soft tabular-nums">
                    {tokens.allowance == null
                      ? `${formatTokens(tokens.spent)} used`
                      : `${formatTokens(tokens.remaining ?? 0)} left of ${formatTokens(tokens.allowance)}`}
                  </span>
                </div>
                {tokens.allowance != null && (
                  <div className="mt-1.5 h-1.5 rounded-full bg-rule overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-[width] ${
                        tokens.remaining === 0 ? "bg-caution" : "bg-brand"
                      }`}
                      style={{ width: `${tokens.pct}%` }}
                      role="progressbar"
                      aria-valuenow={tokens.spent}
                      aria-valuemax={tokens.allowance}
                      aria-label="Tokens this period"
                    />
                  </div>
                )}
              </div>
            );
          })()}
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
          onClick={() => setConfirmSignOut(true)}
          data-testid="cmd-account-logout"
          className="inline-flex items-center justify-center gap-1.5 h-9 rounded-lg border border-rule bg-surface text-[13px] font-medium text-ink hover:bg-red-500/10 hover:text-red-700 hover:border-red-500/30 transition-colors"
        >
          <LogOut size={14} strokeWidth={1.75} />
          Log out
        </button>
      </div>
      {/* Theme (2026-09-08 per operator): the same System · Paper · Terminal
          picker guests get in the sidebar, here under Settings · Log out. */}
      {/* Same 36px height as the Settings · Log out buttons (h-9): 1px
          border + 34px segments. */}
      <div className="mt-5 mb-2.5 text-[11px] uppercase tracking-[0.08em] text-ink-mute font-semibold">
        {t("account.theme")}
      </div>
      <div className="rounded-lg border border-rule bg-surface overflow-hidden">
        <ThemePicker testIdPrefix="cmd-account-theme" buttonHeight={34} />
      </div>
      <AlertDialog open={confirmSignOut} onOpenChange={setConfirmSignOut}>
        {/* No panel of its own (2026-09-08 per operator): the backdrop blurs
            the sheet beneath until it is barely legible and the question
            floats on it. */}
        <AlertDialogContent
          data-testid="cmd-account-logout-confirm"
          overlayClassName="bg-bg/70 backdrop-blur-2xl"
          className="bg-transparent border-0 shadow-none"
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{t("account.signOutConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("account.signOutConfirmBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="cmd-account-logout-confirm-yes"
              onClick={() => void handleSignOut()}
            >
              {t("account.signOutConfirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
