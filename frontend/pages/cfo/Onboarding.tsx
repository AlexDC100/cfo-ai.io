// /onboarding — THE DIAL's first-login question (Prompt 12, Part A).
//
// "What describes you best?" → I run a business / I'm an accountant or
// CFO / I'm an analyst or investor. An answer calls setRole(); the view
// mode FOLLOWS via lib/viewMode's default chain (owner → Simple,
// accountant/analyst → Pro) — nothing here sets a mode directly, so an
// explicit later choice from the header switcher always wins. Skip
// stores NO role: the account simply keeps the Simple default.
//
// Shown ONCE. The guard key `cfo-onboarding-role-asked-v1` is written on
// answer AND on skip (localStorage first, mirrored to user_prefs so a
// second device doesn't re-ask), and any later visit — deep link, old
// bookmark, the post-auth flows that funnel through here — redirects to
// /workspace exactly like the pre-DIAL hard redirect did.
//
// Routing decision (documented per the lane brief): from 2026-07-23 the
// App.tsx route was `<Navigate to="/workspace" replace />` — the old
// industry wizard died and /workspace took over first-run setup. That
// redirect now lives HERE as the already-asked branch, so every old deep
// link keeps landing where it did, while the signup flow (AuthCard's
// sign-up branch + AuthCallback's non-recovery confirmations) gains
// exactly one first-login stop before the /workspace wizard.
//
// Serif display is allowed on this file — it is a first-run surface,
// allowlisted in scripts/check_design_lint.mjs (SERIF_MARKETING).

import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { Briefcase, Calculator, LineChart, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Logo } from "@/components/cfo/Logo";
import { Panel } from "@/components/instrument/Panel";
import "@/components/instrument/shell/modeI18n";
import { getRemotePref, setPref } from "@/lib/prefs";
import { setRole, type UserRole } from "@/lib/viewMode";

/** Show-once guard. localStorage is the source of first paint; the pref
 *  mirror stops a second device from re-asking once prefs hydrate. */
export const ROLE_ASKED_KEY = "cfo-onboarding-role-asked-v1";
const ROLE_ASKED_PREF = "onboarding_role_asked";

export function roleQuestionAsked(): boolean {
  try {
    if (localStorage.getItem(ROLE_ASKED_KEY) === "1") return true;
  } catch {
    /* private mode — fall through to the remote mirror */
  }
  return getRemotePref<boolean>("user", ROLE_ASKED_PREF) === true;
}

function markRoleQuestionAsked(): void {
  try {
    localStorage.setItem(ROLE_ASKED_KEY, "1");
  } catch {
    /* private mode — the pref mirror still records it */
  }
  setPref("user", ROLE_ASKED_PREF, true);
}

interface RoleOption {
  role: Exclude<UserRole, null>;
  icon: LucideIcon;
  titleKey: string;
  descKey: string;
}

const ROLE_OPTIONS: RoleOption[] = [
  {
    role: "owner",
    icon: Briefcase,
    titleKey: "modes.onboarding.owner_title",
    descKey: "modes.onboarding.owner_desc",
  },
  {
    role: "accountant",
    icon: Calculator,
    titleKey: "modes.onboarding.accountant_title",
    descKey: "modes.onboarding.accountant_desc",
  },
  {
    role: "analyst",
    icon: LineChart,
    titleKey: "modes.onboarding.analyst_title",
    descKey: "modes.onboarding.analyst_desc",
  },
];

export default function Onboarding() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // Read the guard ONCE on mount. Answering marks the key and then
  // navigates; re-reading during that render would flip this component
  // into the redirect branch mid-click — same destination, but via a
  // jarring double transition.
  const [alreadyAsked] = useState(roleQuestionAsked);

  if (alreadyAsked) {
    return <Navigate to="/workspace" replace />;
  }

  function finish(role: Exclude<UserRole, null> | null): void {
    if (role) setRole(role);
    markRoleQuestionAsked();
    navigate("/workspace", { replace: true });
  }

  return (
    <div className="min-h-screen bg-bg text-ink flex flex-col">
      <header
        className="px-4 sm:px-10 py-5 flex items-center gap-3"
        style={{ paddingTop: "max(1.25rem, env(safe-area-inset-top))" }}
      >
        <Logo size={26} compact />
      </header>

      <main
        className="flex-1 flex items-center justify-center px-4 sm:px-5 py-8 sm:py-16"
        style={{ paddingBottom: "max(2rem, env(safe-area-inset-bottom) + 1rem)" }}
      >
        <div className="w-full max-w-[560px]">
          <div className="mb-7">
            <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-mute">
              {t("modes.onboarding.eyebrow")}
            </div>
            <h1 className="mt-2 font-serif text-[32px] sm:text-[40px] leading-[1.05] tracking-[-0.02em]">
              {t("modes.onboarding.title")}
            </h1>
            <p className="mt-3 text-[14px] text-ink-soft max-w-[480px]">
              {t("modes.onboarding.subtitle")}
            </p>
          </div>

          <div className="space-y-3">
            {ROLE_OPTIONS.map((o) => {
              const Icon = o.icon;
              return (
                <Panel
                  key={o.role}
                  className="transition-colors duration-micro hover:border-rule-strong"
                >
                  <button
                    type="button"
                    data-testid={`onboarding-role-${o.role}`}
                    onClick={() => finish(o.role)}
                    className="
                      flex w-full items-start gap-3.5 rounded-md px-5 py-4 text-left
                      hover:bg-bg-2/50 transition-colors duration-micro
                      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
                    "
                  >
                    <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-rule bg-bg-2 text-ink-soft">
                      <Icon size={15} strokeWidth={1.75} />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[14px] font-medium text-ink">
                        {t(o.titleKey)}
                      </span>
                      <span className="mt-0.5 block text-[12.5px] leading-snug text-ink-soft">
                        {t(o.descKey)}
                      </span>
                    </span>
                  </button>
                </Panel>
              );
            })}
          </div>

          <div className="mt-6 flex justify-center">
            <button
              type="button"
              data-testid="onboarding-skip"
              onClick={() => finish(null)}
              className="text-[12.5px] text-ink-soft hover:text-ink transition-colors duration-micro"
            >
              {t("modes.onboarding.skip")}
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
