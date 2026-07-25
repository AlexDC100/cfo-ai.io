// Fixed top header — Vitalis-style enterprise navbar.
//
//   ┌────────────────────────────────────────────────────────────────────┐
//   │ ☰  CFO AI │ Demo workspace      Ask CFO AI · 🔔 · ⋮ · ⓤ Profile   │
//   └────────────────────────────────────────────────────────────────────┘
//
// 64px tall, semi-transparent white with thin warm border. Hamburger only
// appears on small viewports (sidebar collapses there). The workspace label
// shows the user's company name when signed in, or "Demo workspace" when in
// demo mode — replaces the static "Financial Intelligence" brand line.

import { useNavigate, useSearchParams } from "react-router-dom";
import { ChevronLeft, ChevronRight, Menu, Sparkles } from "lucide-react";
import { Logo } from "./Logo";
import { AccountMenu } from "./AccountMenu";
import { BackendStatusIndicator } from "./BackendStatusIndicator";
import { CurrencyToggle } from "./CurrencyToggle";
import { LanguageToggle } from "./LanguageToggle";
import { LearningHubMenu } from "@/components/learning/LearningHubMenu";
import { useAuth } from "@/lib/auth";
import { useWorkspaceName } from "@/lib/workspaceName";
import { useWorkspaces } from "@/lib/workspaces";
import { useActivePeriod } from "@/lib/activePeriod";
import { formatPeriodMonth, useOrgPeriods } from "@/lib/orgPeriods";

interface Props {
  onOpenAi: () => void;
  /** Mobile-only: opens the sidebar as a slide-over drawer. */
  onOpenSidebar: () => void;
  /** Click the account avatar → open the Command Center (instead of the
   *  legacy dropdown). */
  onOpenAccount?: () => void;
}

export function TopHeader({ onOpenAi, onOpenSidebar, onOpenAccount }: Props) {
  // May 2026 redesign — the inline dropdown was replaced by <AccountMenu/>
  // which carries THE single sign-out. The "Ask CFO AI" pill is restored
  // here per the operator's directive (May 2026 follow-up): it sits
  // immediately to the left of the avatar, matching the reference image
  // (an "Ask AI" pill + a small AC initials circle). Clicking it fires
  // the same OPEN_ASK_CFO_AI_EVENT path that AppShell wires today.
  const { status, user, workspaceLabel } = useAuth();
  // The tagline beside the logo reflects the workspace name the user set in
  // the Workspace onboarding. Falls back to the auth-derived workspace label,
  // then a neutral default.
  const workspaceName = useWorkspaceName();
  // When the user has no active workspace (e.g. right after deleting their
  // last one), the tagline shows a faded "No workspace selected" placeholder
  // instead of a stale name.
  const { currentId, loading: wsLoading } = useWorkspaces();
  const noWorkspace = status === "signed_in" && !wsLoading && !currentId;
  // Selected month — from the active period's closing date. The tagline
  // reads "[workspace] - [month]" so switching months (Workspace tab)
  // is always reflected up here.
  const period = useActivePeriod();
  // Only show the month once a REAL period is loaded (period.id present) —
  // without this a periodEnd that defaulted to today would surface the current
  // date in the tagline even when no period has been created yet.
  const selectedMonth = period.id ? formatPeriodMonth(period.periodEnd) : null;
  const navigate = useNavigate();

  // Month stepper — prev/next arrows beside the tagline cycle through this
  // workspace's uploaded periods (newest-first). `?period=<id>` is the app-wide
  // active-period key, so stepping it re-scopes every tab to that month.
  const [params, setParams] = useSearchParams();
  const { data: periodsData } = useOrgPeriods();
  const periods = periodsData?.periods ?? [];
  const currentPeriodId = period.id ?? params.get("period");
  const periodIdx = currentPeriodId
    ? periods.findIndex((p) => p.period_id === currentPeriodId)
    : -1;
  // Newest-first ordering: the OLDER month is further down the list (idx+1),
  // the NEWER month is above it (idx-1).
  const olderPeriod = periodIdx >= 0 && periodIdx < periods.length - 1 ? periods[periodIdx + 1] : null;
  const newerPeriod = periodIdx > 0 ? periods[periodIdx - 1] : null;
  // Looping stepper (2026-07-25): both arrows are ALWAYS active and wrap
  // around — stepping back from the oldest month lands on the newest, forward
  // from the newest lands on the oldest. Falls back to the list ends when the
  // current period isn't in the list (periodIdx === -1).
  const prevTarget = olderPeriod ?? periods[0] ?? null;
  const nextTarget = newerPeriod ?? periods[periods.length - 1] ?? null;
  const showMonthStepper = Boolean(selectedMonth) && periods.length >= 2;
  function goToPeriod(periodId: string) {
    const sp = new URLSearchParams(params);
    sp.set("period", periodId);
    // Replace, not push — month stepping is substitution, back should leave
    // the page rather than replay every month stepped through.
    setParams(sp, { replace: true });
  }

  return (
    <header
      // `inset-x-0` pins the bar to the scrollport's edges. On non-/chat
      // routes <html> reserves a scrollbar gutter (index.css) so tab switches
      // never flash a scrollbar — but that leaves an empty ~17px strip at the
      // right on short pages, and `right-0` stops at the gutter's inner edge,
      // reading as a gap in the bar. The `after:` strip bleeds the header's
      // background over that gutter to the true window edge (clipped past the
      // edge, so its width just needs to exceed any real scrollbar). Content
      // stays at the scrollport width, so nothing shifts.
      className="
        fixed top-0 inset-x-0 z-40 h-16
        bg-[hsl(var(--bg)/0.72)]
        backdrop-blur-[18px]
        border-b border-rule-soft
        after:content-[''] after:pointer-events-none
        after:absolute after:top-0 after:bottom-[-1px] after:left-full after:w-6
        after:bg-[hsl(var(--bg)/0.72)] after:backdrop-blur-[18px]
        after:border-b after:border-rule-soft
      "
      style={{
        paddingLeft: "env(safe-area-inset-left)",
        paddingRight: "env(safe-area-inset-right)",
        paddingTop: "env(safe-area-inset-top)",
      }}
    >
      <div className="h-full px-3 sm:px-6 flex items-center gap-2 sm:gap-3">
        {/* Mobile hamburger — 44px touch target per Apple HIG */}
        <button
          onClick={onOpenSidebar}
          aria-label="Open navigation"
          className="lg:hidden inline-flex items-center justify-center h-11 w-11 -ml-2 rounded-md text-ink-soft hover:text-ink hover:bg-bg-2 active:bg-bg-2/60 transition-colors"
        >
          <Menu size={20} strokeWidth={1.75} />
        </button>

        {/* Brand + workspace label — mirrors the landing-page header:
            logo + "CFO AI" wordmark (rendered by <Logo>) + a mono, uppercase,
            letter-spaced workspace tagline behind a hairline divider. */}
        <button
          onClick={() => navigate("/dashboard")}
          className="flex items-center gap-2.5 shrink-0"
          aria-label="Go to dashboard"
        >
          <Logo size={26} compact />
        </button>
        {/* Workspace tagline + hairline divider. Hidden entirely when the user
            has no workspace (nothing to name), so the header reads as just the
            CFO AI wordmark until they create one. */}
        {!noWorkspace && (
        <div className="hidden sm:flex items-center gap-1.5 pl-3 border-l border-rule h-[22px]">
          <span className="font-mono text-[11.5px] uppercase tracking-[0.14em] font-normal text-ink truncate max-w-[240px]">
            {workspaceName || workspaceLabel || "Financial Intelligence"}
          </span>
          {/* Selected month with its stepper. The BACK arrow (previous month)
              sits to the LEFT of the month text; the forward arrow to its
              right. Arrows only render when there's more than one month to
              step through. */}
          {selectedMonth && (
            <span className="inline-flex items-center gap-0.5">
              {showMonthStepper && (
                <button
                  type="button"
                  onClick={() => prevTarget && goToPeriod(prevTarget.period_id)}
                  aria-label="Previous month"
                  title={`Previous month (${formatPeriodMonth(prevTarget?.period_end) ?? ""})`}
                  data-testid="topbar-prev-month"
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-ink-mute hover:text-ink hover:bg-bg-2/70 transition-colors"
                >
                  <ChevronLeft size={14} strokeWidth={2} />
                </button>
              )}
              <span className="font-mono text-[11.5px] uppercase tracking-[0.14em] font-semibold text-ink-soft whitespace-nowrap">
                {selectedMonth}
              </span>
              {showMonthStepper && (
                <button
                  type="button"
                  onClick={() => nextTarget && goToPeriod(nextTarget.period_id)}
                  aria-label="Next month"
                  title={`Next month (${formatPeriodMonth(nextTarget?.period_end) ?? ""})`}
                  data-testid="topbar-next-month"
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-ink-mute hover:text-ink hover:bg-bg-2/70 transition-colors"
                >
                  <ChevronRight size={14} strokeWidth={2} />
                </button>
              )}
            </span>
          )}
        </div>
        )}

        {/* Backend connection dot — reflects the FastAPI engine's /health,
            not Supabase or Ask CFO AI chat (which runs independently). */}
        <BackendStatusIndicator />

        <div className="flex-1" />

        {/* The active-document chip (filename + stage) was removed from
            the header 2026-07-24 — in-flight analysis now surfaces as a
            spinner on the Dashboard sidebar item instead. */}

        {/* Ask CFO AI pill — restored May 2026 follow-up. Sits to the
            LEFT of the avatar, mirroring the reference image (pill →
            avatar circle). Uses the brand-tint pill styling so it reads
            as a primary action without dominating the header. Fires the
            same OPEN_ASK_CFO_AI_EVENT path that the in-page chips and
            Command Center use, so behavior is consistent across launch
            surfaces. Only rendered when the user is signed in — there's
            no AI to ask without an authenticated session. */}
        {status === "signed_in" && user && (
          <button
            type="button"
            onClick={onOpenAi}
            data-testid="topheader-ask-cfo-ai"
            aria-label="Ask CFO AI"
            className="
              ask-ai-anim-fill
              inline-flex items-center justify-center gap-1.5
              h-10 sm:h-9 min-w-[40px] sm:min-w-0 px-3.5 rounded-full
              border border-brand/40 text-ink
              hover:border-brand/60
              text-[12.5px] font-medium
              transition-colors
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40
            "
          >
            <Sparkles size={14} strokeWidth={1.75} />
            <span className="hidden sm:inline">Ask CFO AI</span>
          </button>
        )}

        {/* Account menu — single source of truth for sign-out (May 2026
            redesign). The trigger is a compact initials circle (no
            trailing name text); the full name + email live inside the
            dropdown. Unauthed visitors still see a plain "Sign in"
            link below. */}
        {/* LEARN-FIX-4 (2026-06-14) — Apple-2026 Learning hub menu.
            Replaces the standalone Glossary pill. Same Glossary action
            lives inside the dropdown alongside the Learning-mode picker
            (Guided / Subtle / Off), which used to be Settings-only. */}
        {status === "signed_in" && user && <LearningHubMenu />}

        {/* Currency display toggle — sits between Ask CFO AI + AccountMenu.
            Affects all <Money> + <MoneyValue> instances globally. Hidden
            for unauthed visitors (no analyst surfaces to convert). */}
        {status === "signed_in" && user && (
          <div className="hidden sm:inline-flex">
            <CurrencyToggle />
          </div>
        )}

        {/* Language toggle — compact dropdown next to CurrencyToggle.
            Sidebar's Globe popover stays as a secondary surface (and is
            the primary one on mobile where this hides via the same
            `hidden sm:inline-flex` pattern). pickLanguageWithProfileSync
            inside the toggle mirrors the choice to Supabase so the
            useLanguage() priority chain doesn't override the click. */}
        {status === "signed_in" && user && (
          <div className="hidden sm:inline-flex">
            <LanguageToggle />
          </div>
        )}

        {status === "signed_in" && user ? (
          <AccountMenu onOpen={onOpenAccount} />
        ) : (
          <button
            onClick={() => navigate("/login")}
            className="ml-1 inline-flex items-center h-9 px-3 rounded-md font-mono text-[11.5px] uppercase tracking-[0.14em] text-ink-soft hover:text-ink hover:bg-bg-2 transition-colors"
          >
            Sign in
          </button>
        )}
      </div>
    </header>
  );
}
