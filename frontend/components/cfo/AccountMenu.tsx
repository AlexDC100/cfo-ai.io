// AccountMenu.tsx — top-right avatar dropdown for signed-in users.
//
// Spec §10 + §11 contract:
//   · 320–360px wide dark-glass panel
//   · Header: name + email
//   · Status chip: plan name + price
//   · Usage preview: "Documents this month · 4 / 15" + progress bar
//   · Profile section: Me
//   · Actions: Billing, Settings, Theme toggle
//   · Sign out — THE single source of truth in the app
//
// Sign-out: this is now the ONLY sign-out in the authed surface. The
// previous Sidebar System-group sign-out was removed in the same phase
// to keep the "exactly one sign-out" rule (gap from the cleanup brief +
// the menu-cleanliness E2E). Tests assert `data-testid="account-menu-sign-out"`
// appears exactly once.
//
// COMPOSITION
//   · `AccountMenu` (default export, used in TopHeader) — wires Radix
//     DropdownMenu + the auth/plan/theme hooks + handlers, then renders
//     `AccountMenuContent` inside DropdownMenuContent.
//   · `AccountMenuContent` (named export, used by tests) — pure
//     props-driven rendering. Lets the test render the panel without
//     depending on Radix portal mounting under jsdom.

import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Check,
  CircleUser,
  CreditCard,
  LogOut,
  Settings as SettingsIcon,
  Sparkles,
  User as UserIcon,
  type LucideIcon,
} from "lucide-react";
// `Plus` (Add workspace) + `ShieldCheck` (Privacy) imports dropped —
// both rows were removed from the dropdown. Re-add if either row is
// ever restored.

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { formatEur } from "@/lib/pricingConfig";
import { usePlanState, type PlanState } from "@/lib/planState";
import { formatTokens, tokenUsage } from "@/lib/tokenUsage";
import { useLearningMode, type LearningMode } from "@/stores/learningMode";
import { useTheme, type Theme } from "@/theme";
// QUICK SETTINGS (2026-08-30 Capsule directive): the display-currency
// selector and the Simple|Pro dial moved OUT of the header and land
// here. Both are self-contained (their own stores), so they need no
// prop threading — they simply mount inside the menu.
import { CurrencyToggle } from "./CurrencyToggle";
import { ModeSwitch } from "@/components/instrument/shell/ModeSwitch";
// THE BELL'S FOLD (2026-08-30, Part E): below `lg` the header drops the
// notifications bell to hold its 3-control budget, so the avatar becomes
// its home — the panel gets the row, the trigger gets the count.
import { NotificationsMenu } from "./NotificationsMenu";
import { fetchAlerts, type AlertSeverity } from "@/lib/supabase";
import "./headerI18n";

// ─────────────────────────────────────────────────────────────────────
// The fold's two small hooks
// ─────────────────────────────────────────────────────────────────────

/** Tailwind's `lg` breakpoint, as a hook. Drives WHERE the bell lives —
 *  the CSS classes decide what paints, this decides whether we spend a
 *  request on the badge count at all. */
function useBelowLg(): boolean {
  const [below, setBelow] = useState(
    () => typeof window !== "undefined" && window.innerWidth < 1024,
  );
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia("(max-width: 1023.98px)");
    const onChange = () => setBelow(window.innerWidth < 1024);
    mql.addEventListener("change", onChange);
    onChange();
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return below;
}

/** Severities that earn the badge. MIRRORS NotificationsMenu's `BADGED`
 *  ladder deliberately — the avatar badge must never disagree with the
 *  bell it replaces. The constant is not exported from there; when this
 *  and that file next move together, export it and delete this copy
 *  (recorded as a cross-lane item in design_review/header/GATES.md).
 *  This is NOT a second alert engine: it reads the same persisted
 *  org-scoped rows through the same `fetchAlerts` gateway. */
const BADGED_SEVERITIES: AlertSeverity[] = ["critical", "high", "medium"];

/** Unread count for the avatar badge. Fetches ONLY when `enabled` — at
 *  `lg` and up the bell is mounted and already owns this read, so the
 *  fold costs no duplicate request at any width. */
function useAlertBadgeCount(enabled: boolean): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!enabled) {
      setCount(0);
      return;
    }
    let live = true;
    void fetchAlerts()
      .then((rows) => {
        if (live) setCount(rows.filter((a) => BADGED_SEVERITIES.includes(a.severity)).length);
      })
      .catch(() => {
        // Honest-absent: a failed read shows NO badge rather than a
        // fabricated zero-that-looks-like-a-verdict. Same posture as
        // usePlanState.
        if (live) setCount(0);
      });
    return () => {
      live = false;
    };
  }, [enabled]);
  return count;
}

/** The count bubble painted on the avatar. `lg:hidden` — at desktop the
 *  bell carries its own badge and this would be the duplicate. */
function AvatarBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      aria-hidden
      data-testid="account-menu-badge"
      className="
        lg:hidden absolute -top-0.5 -right-0.5
        min-w-[15px] h-[15px] px-1
        inline-flex items-center justify-center rounded-full
        bg-red-600 text-white text-[9.5px] font-semibold leading-none tabular-nums
        ring-2 ring-bg
      "
    >
      {count > 9 ? "9+" : count}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Public component — wires hooks + DropdownMenu, used in TopHeader.
// ─────────────────────────────────────────────────────────────────────

export function AccountMenu({ onOpen }: { onOpen?: () => void } = {}) {
  const { user, displayName, initials, signOut } = useAuth();
  const { state, refresh: refreshPlan } = usePlanState();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { t } = useTranslation();
  // Learning mode lives here since the 2026-08-04 header redesign — the
  // "Learn · <mode>" pill left the bar; the avatar menu is its home now.
  const { mode: learningMode, setMode: setLearningMode } = useLearningMode();
  // Theme choice restored 2026-08-12 (operator request) — dark stays the
  // default, but Light/Dark/System is pickable again. next-themes owns
  // persistence; ThemePrefSync mirrors it to user_prefs.theme.
  const { theme, setTheme, mounted: themeMounted } = useTheme();
  const [open, setOpen] = useState(false);
  // The bell's fold — see the hooks above. Hooks must run before the
  // early return below, so they sit here unconditionally.
  const belowLg = useBelowLg();
  const alertCount = useAlertBadgeCount(belowLg && !!user);

  if (!user) return null;

  const accountAria =
    belowLg && alertCount > 0
      ? t("header.account.withAlerts", {
          name: displayName ?? user.email,
          count: alertCount,
        })
      : `Account menu · ${displayName ?? user.email}`;

  // When an `onOpen` handler is supplied, the avatar becomes a plain button
  // that runs it (the top bar wires this to open the Command Center — the
  // single account surface: profile, plan, settings, log out). The legacy
  // dropdown below is skipped entirely in that mode.
  if (onOpen) {
    return (
      <button
        type="button"
        aria-label={accountAria}
        title={displayName ?? user.email ?? "Account"}
        data-testid="account-menu-trigger"
        onClick={onOpen}
        className="
          relative ml-1 inline-flex items-center justify-center
          h-9 w-9 rounded-full
          bg-brand text-paper
          text-[12px] font-semibold tracking-tight
          hover:bg-brand-d
          transition-colors
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40
        "
      >
        {initials ?? <UserIcon size={14} strokeWidth={1.75} />}
        <AvatarBadge count={alertCount} />
      </button>
    );
  }

  async function handleSignOut() {
    setOpen(false);
    const { error } = await signOut();
    toast({
      title: error ? t("account.signOutFailed") : t("account.signedOut"),
      description: error?.message,
      variant: error ? "destructive" : undefined,
    });
    if (!error) navigate("/", { replace: true });
  }

  // Refetch plan state every time the dropdown opens. AccountMenu lives
  // in TopHeader and stays mounted for the whole session, so the single
  // mount-time fetch in usePlanState would otherwise leave docs_used /
  // chat_used_today stale after an upload or an Ask CFO AI message.
  // PlanUsageCard doesn't need this because Settings remounts on nav.
  // Honest-absent semantics from usePlanState (state stays null while
  // loading, becomes null on error) are preserved — we never fabricate.
  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (nextOpen) void refreshPlan();
  }

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        {/* May 2026 — simplified to a clean initials circle (no trailing
         *  name text). Matches the reference layout: just the avatar
         *  bubble; the "Ask CFO AI" pill sits immediately to the left
         *  of it in TopHeader. `displayName` still drives the dropdown
         *  contents (the inner menu shows the full name + email); the
         *  trigger itself stays compact. */}
        <button
          type="button"
          aria-label={accountAria}
          title={displayName ?? user.email ?? "Account"}
          data-testid="account-menu-trigger"
          className="
            relative ml-1 inline-flex items-center justify-center
            h-9 w-9 rounded-full
            bg-brand text-paper
            text-[12px] font-semibold tracking-tight
            hover:bg-brand-d
            transition-colors
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40
          "
        >
          {initials ?? <UserIcon size={14} strokeWidth={1.75} />}
          <AvatarBadge count={alertCount} />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        sideOffset={8}
        className="
          w-[340px] p-0 rounded-[22px]
          bg-surface/95 backdrop-blur-xl
          border border-rule-strong/80
          shadow-[0_24px_60px_-20px_rgba(0,0,0,0.45)]
        "
      >
        <AccountMenuContent
          name={displayName ?? t("account.fallbackName")}
          email={user.email ?? null}
          plan={state}
          learningMode={learningMode}
          onSetLearningMode={setLearningMode}
          theme={themeMounted ? theme ?? "dark" : undefined}
          onSetTheme={setTheme}
          onNavigateSettings={() => {
            setOpen(false);
            navigate("/settings");
          }}
          onNavigateBilling={() => {
            setOpen(false);
            navigate("/pricing");
          }}
          onSignOut={() => void handleSignOut()}
          // Below `lg` the header has no bell — this row is its home.
          // Passed as a slot so AccountMenuContent stays pure/props-only
          // and its existing bare-render tests keep working.
          notificationsSlot={<NotificationsMenu variant="row" />}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Content component — pure, props-only. Exported for tests.
// ─────────────────────────────────────────────────────────────────────

export interface AccountMenuContentProps {
  name: string;
  email: string | null;
  plan: PlanState | null;
  /** Learning-mode picker (2026-08-04 — moved here from the header's
   *  "Learn · <mode>" pill). Optional so existing tests that render the
   *  panel without learning props keep passing. */
  learningMode?: LearningMode;
  onSetLearningMode?: (mode: LearningMode) => void;
  /** Theme picker (2026-08-12 — restored after the dark-only period).
   *  Optional for the same reason as the learning props: tests render
   *  the panel bare. `theme` is undefined until next-themes has mounted
   *  (avoids a hydration flicker on the active pill). */
  theme?: Theme;
  onSetTheme?: (t: Theme) => void;
  onNavigateSettings: () => void;
  onNavigateBilling: () => void;
  onSignOut: () => void;
  /** THE BELL'S FOLD (2026-08-30, Part E). Rendered `lg:hidden`: at
   *  desktop the header still carries the bell, below `lg` this row is
   *  the only home. Optional so bare-render tests stay unchanged. */
  notificationsSlot?: ReactNode;
}

export function AccountMenuContent({
  name,
  email,
  plan,
  learningMode,
  onSetLearningMode,
  theme,
  onSetTheme,
  onNavigateSettings,
  onNavigateBilling,
  onSignOut,
  notificationsSlot,
}: AccountMenuContentProps) {
  const { t } = useTranslation();
  return (
    <div data-testid="account-menu" className="w-full">
      {/* ── Header: name + email ─────────────────────────────── */}
      <header className="px-4 pt-4 pb-3">
        <div
          data-testid="account-menu-name"
          className="text-[14px] font-medium text-ink leading-tight truncate"
        >
          {name}
        </div>
        {email && (
          <div
            data-testid="account-menu-email"
            className="text-[12px] text-ink-soft leading-snug truncate"
          >
            {email}
          </div>
        )}
      </header>

      {/* ── Plan status chip + usage preview ─────────────────── */}
      {plan && (
        <section
          data-testid="account-menu-status"
          className="px-4 pb-3 border-t border-rule/60 pt-3"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="inline-flex items-center gap-2 min-w-0">
              <span
                aria-hidden
                className="inline-block h-2 w-2 rounded-full bg-brand"
              />
              <span
                data-testid="account-menu-plan-name"
                className="text-[13px] font-medium text-ink truncate"
              >
                {plan.plan_display_name}
              </span>
            </div>
            <div
              data-testid="account-menu-plan-price"
              className="text-[12.5px] text-ink-soft tabular-nums shrink-0"
            >
              {plan.plan_recurring
                ? `${formatEur(plan.plan_price_eur)} ${t("pricing.perMonthShort")}`
                : plan.plan_price_eur > 0
                ? `${formatEur(plan.plan_price_eur)} ${t("pricing.oneTime")}`
                : t("account.free")}
            </div>
          </div>

          {/* Usage preview — token budget (Claude-style, 2026-07-24):
              chats + document analyses spend from one token allowance.
              Derived from the backend's metered counters via
              lib/tokenUsage. */}
          {(() => {
            const tokens = tokenUsage(plan);
            return (
              <div className="mt-3" data-testid="account-menu-usage">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[11.5px] text-ink-soft">
                    {t("account.tokensThisPeriod")}
                  </span>
                  <span
                    data-testid="account-menu-usage-count"
                    className="text-[11.5px] font-medium text-ink tabular-nums"
                  >
                    {tokens.allowance == null
                      ? t("account.tokensUsed", { tokens: formatTokens(tokens.spent) })
                      : `${formatTokens(tokens.spent)} / ${formatTokens(tokens.allowance)}`}
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
                      aria-label={t("account.tokensThisPeriod")}
                    />
                  </div>
                )}
              </div>
            );
          })()}
        </section>
      )}

      {/* ── Profile section ──────────────────────────────────── */}
      {/* "Add workspace (Coming soon)" row removed per operator
          directive — see comment block below the menu. */}
      <section className="px-2 py-2 border-t border-rule/60">
        <SectionHeader label={t("account.profile")} />
        <Row
          icon={CircleUser}
          label={t("account.me")}
          sublabel={name}
          onClick={onNavigateSettings}
          testId="account-menu-me"
        />
      </section>

      {/* ── Notifications (below lg — the bell's fold, 2026-08-30) ──
          The avatar's badge mirrors this row's count; the row opens the
          same dialog the header bell opens at desktop widths. */}
      {notificationsSlot && (
        <section
          className="lg:hidden px-2 py-2 border-t border-rule/60"
          data-testid="account-menu-notifications"
        >
          {notificationsSlot}
        </section>
      )}

      {/* ── Learning mode (2026-08-04 — from the header's Learn pill) ── */}
      {learningMode && onSetLearningMode && (
        <section
          className="px-2 py-2 border-t border-rule/60"
          data-testid="account-menu-learning"
        >
          <SectionHeader label={t("account.learning")} />
          <div role="radiogroup" aria-label={t("account.learning")} className="flex gap-1 px-1">
            {(["guided", "subtle", "off"] as const).map((m) => {
              const active = learningMode === m;
              return (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => onSetLearningMode(m)}
                  data-testid={`account-menu-learning-${m}`}
                  className={`
                    flex-1 inline-flex items-center justify-center gap-1.5
                    h-9 rounded-lg text-[12px] font-medium
                    transition-colors duration-150
                    ${active
                      ? "bg-brand/[0.1] text-brand-d border border-brand/30"
                      : "text-ink-soft hover:text-ink hover:bg-bg-2/70 border border-transparent"}
                  `}
                >
                  {active && <Check size={12} strokeWidth={2.5} />}
                  {t(`account.learning_${m}`)}
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* ── View mode (moved from the header, 2026-08-30) ── */}
      <section className="px-2 py-2 border-t border-rule/60" data-testid="account-menu-viewmode">
        <SectionHeader label={t("modes.switch.label")} />
        <div className="px-1">
          <ModeSwitch className="w-full justify-center" />
        </div>
      </section>

      {/* ── Display currency (moved from the header, 2026-08-30) ── */}
      <section className="px-2 py-2 border-t border-rule/60" data-testid="account-menu-currency">
        <SectionHeader label={t("settings.currency", "Display currency")} />
        <div className="px-1">
          <CurrencyToggle />
        </div>
      </section>

      {/* ── Theme (2026-08-12 — restored; dark-only pin removed) ── */}
      {theme && onSetTheme && (
        <section
          className="px-2 py-2 border-t border-rule/60"
          data-testid="account-menu-theme"
        >
          <SectionHeader label={t("account.theme")} />
          <div role="radiogroup" aria-label={t("account.theme")} className="flex gap-1 px-1">
            {(["dark", "light", "system"] as const).map((m) => {
              const active = theme === m;
              return (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => onSetTheme(m)}
                  data-testid={`account-menu-theme-${m}`}
                  className={`
                    flex-1 inline-flex items-center justify-center gap-1.5
                    h-9 rounded-lg text-[12px] font-medium
                    transition-colors duration-150
                    ${active
                      ? "bg-brand/[0.1] text-brand-d border border-brand/30"
                      : "text-ink-soft hover:text-ink hover:bg-bg-2/70 border border-transparent"}
                  `}
                >
                  {active && <Check size={12} strokeWidth={2.5} />}
                  {t(`account.theme_${m}`)}
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* ── Main actions ─────────────────────────────────────── */}
      {/* "Privacy (Coming soon)" row removed per operator directive —
          see comment block below the menu. */}
      <section className="px-2 py-2 border-t border-rule/60">
        <Row
          icon={CreditCard}
          label={t("account.billing")}
          onClick={onNavigateBilling}
          testId="account-menu-billing"
        />
        <Row
          icon={SettingsIcon}
          label={t("account.settings")}
          onClick={onNavigateSettings}
          testId="account-menu-settings"
        />
      </section>

      {/* ── Sign out (THE single source of truth) ─────────────── */}
      <section className="px-2 py-2 border-t border-rule/60">
        <Row
          icon={LogOut}
          label={t("account.signOut")}
          onClick={onSignOut}
          testId="account-menu-sign-out"
          destructive
        />
      </section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Internal building blocks
// ─────────────────────────────────────────────────────────────────────

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="px-2 pb-1.5 pt-1 text-[10px] uppercase tracking-[0.1em] text-ink-mute font-medium">
      {label}
    </div>
  );
}

function Row({
  icon: Icon,
  label,
  sublabel,
  onClick,
  disabled,
  comingSoon,
  destructive,
  testId,
}: {
  icon: LucideIcon;
  label: string;
  sublabel?: string;
  onClick?: () => void;
  disabled?: boolean;
  comingSoon?: boolean;
  destructive?: boolean;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className={`
        w-full inline-flex items-center gap-3 px-2.5 py-2.5 sm:py-2 min-h-[44px] sm:min-h-0 rounded-lg
        text-left text-[13px]
        ${disabled
          ? "text-ink-mute cursor-not-allowed"
          : destructive
          ? "text-ink hover:bg-red-500/10 hover:text-red-700 active:bg-red-500/15 transition-colors"
          : "text-ink hover:bg-bg-2/60 active:bg-bg-2/80 transition-colors"}
      `}
    >
      <Icon size={14} strokeWidth={1.75} className="shrink-0" />
      <span className="flex-1 min-w-0 truncate">{label}</span>
      {sublabel && (
        <span className="text-[11.5px] text-ink-mute truncate max-w-[120px]">
          {sublabel}
        </span>
      )}
      {comingSoon && (
        <span
          data-testid={`${testId}-coming-soon`}
          className="inline-flex items-center gap-1 rounded-full bg-bg-2 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.06em] text-ink-mute"
        >
          <Sparkles size={9} strokeWidth={2} />
          Soon
        </span>
      )}
    </button>
  );
}
