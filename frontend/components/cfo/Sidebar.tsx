// THE INSTRUMENT — the left rail (Part D of the command deck).
//
// Expanded 232px / collapsed 64px icon rail, persisted, ⌘. toggles.
// Flush to the viewport's left edge under the 56px header, separated by a
// hairline rule — no floating card, no resting shadow, no blur.
//
// Groups: OVERVIEW (Dashboard, Workspaces) / ANALYZE (Scenarios, Benchmark,
// Products, Variance + registry-gated extras) / EXPLORE (Public Companies) /
// ASK (CFO AI, ⌘J). Active = 2px accent rule on the row's left edge + ink
// text; hover = quiet fill. Section labels 10px caps muted.
//
// Footer (desktop rail): Settings · theme toggle (Paper/Terminal) ·
// collapse. The Disclaimer row LEFT the nav — it becomes a Settings link
// owned by the settings lane.
//
// The nav model (SHELL_NAV_ALL / useShellNav) is exported so the command
// palette renders the exact same destinations — one list, two surfaces.
//
// Mobile drawer behaviors preserved EXACTLY: currency row (drawer-only),
// account row (drawer-only, opens the Command Center account surface),
// notifications row in the footer, 44px touch targets, drawer-stagger.

import React, { ReactNode, useEffect, useState } from "react";
import { NavLink, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { usePrefetchPeriod } from "@/lib/activePeriod";
import { useChatReplyPending } from "@/lib/chatPendingStore";
import { useChatStore } from "@/components/cfo/chat/useChatStore";
import { isInFlight, useUploadStore } from "@/lib/uploadStore";
import { DECISIONS_ALERTS_ENABLED } from "@/config/features";
import {
  LayoutDashboard,
  ClipboardCheck,
  PackageSearch,
  Bell,
  Settings as SettingsIcon,
  BarChart3,
  Boxes,
  Receipt,
  Scale,
  Sparkles,
  SlidersHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Globe,
  Building2,
  ChevronDown,
  Loader2,
  LogIn,
  MessageSquareText,
  Monitor,
  Moon,
  SunMedium,
  User as UserIcon,
  X,
  type LucideIcon,
  RotateCcw,
} from "lucide-react";
import { NotificationsMenu } from "./NotificationsMenu";
import { ThemePicker } from "./ThemePicker";
import { tapHandlers } from "@/lib/tapHandlers";
import { onboardingReplayAvailable, openOnboarding } from "@/lib/onboarding";
import { Mark } from "./Mark";
import { nativeShellVersion } from "@/lib/nativeShell";
import { CurrencyToggle } from "./CurrencyToggle";
import { useAuth } from "@/lib/auth";
import { useTheme } from "@/theme";
import { confirmLeaveUnsaved } from "@/lib/unsavedGuard";
import { modKeyLabel } from "@/components/instrument/shell/shellI18n";
import "@/components/instrument/shell/shellI18n";
import {
  type FeatureKey,
  type FeatureStatus,
  useFeatures,
} from "@/lib/features";

interface Props {
  onSettings: () => void;
  /** Open the Command Center drawer. Kept on the interface (AppShell wires
   *  it) so a rail trigger is a one-line restore; unused at runtime. */
  onOpenCommandCenter?: () => void;
  /** Sign out. Kept on the interface for the same one-line-restore reason;
   *  the single live sign-out is in <AccountMenu/>. */
  onSignOut?: () => Promise<void> | void;
  /** Drawer mode — closes the slide-over after a click on mobile. */
  inDrawer?: boolean;
  onItemClick?: () => void;
  /** Drawer: rendered first inside the nav scroller (pull-to-refresh). */
  navTop?: ReactNode;
  /** Drawer mode only — opens the account surface (Command Center).
   *  Inside the native mobile shell the TopHeader isn't rendered, so the
   *  drawer's credentials row is the account entry point (2026-08-18). */
  onOpenAccount?: () => void;
  /** No workspace yet — every destination that needs workspace data is
   *  disabled; only ALWAYS_ENABLED routes stay live. */
  noWorkspace?: boolean;
}

// Routes that stay clickable even with no workspace — the ones that DON'T
// depend on loaded workspace data. `/chat` is dual-mode (open-domain with
// no workspace) and runs on a Supabase Edge Function, so it needs nothing
// else loaded (2026-07-26 per operator). `/dashboard` joined with guest
// mode (2026-09-04): it's the app's landing surface and renders its own
// upload hero with no workspace — a guest standing ON the dashboard must
// not see its tab greyed out.
// `/public-companies` is the auth-optional public markets hub — no workspace
// data involved at all.
const ALWAYS_ENABLED = new Set([
  "/workspace",
  "/settings",
  "/",
  "/dashboard",
  "/chat",
  "/public-companies",
]);

// ── The shared nav model (rail + command palette) ──────────────────────

export type ShellNavGroup = "overview" | "analyze" | "explore";

export interface ShellNavItem {
  to: string;
  labelKey: string;
  icon: LucideIcon;
  testId: string;
  group: ShellNavGroup;
  /** Registry gate — `hidden`/unknown drops the item, `coming_soon` too. */
  featureKey?: FeatureKey;
  /** NavLink exact match, for paths that prefix other paths. */
  end?: boolean;
  /** Keyboard shortcut hint, shown on hover ("⌘J"). Display only. */
  shortcutKey?: string;
}

// ANALYZE keeps the operator's order (2026-08-28): Scenarios leads,
// Benchmark second, then Products and Variance. Decisions/Alerts stay
// behind DECISIONS_ALERTS_ENABLED; Inventory/Invoices behind the registry.
export const SHELL_NAV_ALL: ShellNavItem[] = [
  { to: "/dashboard",  labelKey: "sidebar.dashboard",  icon: LayoutDashboard, testId: "sidebar-dashboard",  group: "overview", end: true },
  // Ask CFO AI — listed here for the ⌘K palette; the rail renders it as the
  // one accent-filled promoted button at the top (restored 2026-09-06 per
  // operator after a 2026-09-04 stint as a plain tab row), so the grouped
  // loop below filters it out and it never renders twice.
  { to: "/chat",       labelKey: "sidebar.chat",       icon: Sparkles,        testId: "sidebar-chat",       group: "overview", shortcutKey: "J" },
  { to: "/workspace",  labelKey: "sidebar.workspaces", icon: Building2,       testId: "sidebar-workspaces", group: "overview" },
  { to: "/dashboard/scenarios", labelKey: "sidebar.scenarios", icon: SlidersHorizontal, testId: "sidebar-scenarios", group: "analyze" },
  { to: "/benchmark",  labelKey: "sidebar.benchmark",  icon: BarChart3,       testId: "sidebar-benchmark",  group: "analyze" },
  { to: "/products",   labelKey: "sidebar.products",   icon: PackageSearch,   testId: "sidebar-products",   group: "analyze" },
  { to: "/dashboard/variance", labelKey: "sidebar.variance", icon: Scale, testId: "sidebar-variance", group: "analyze" },
  { to: "/inventory",  labelKey: "sidebar.inventory",  icon: Boxes,           testId: "sidebar-inventory",  group: "analyze", featureKey: "inventory" },
  { to: "/invoices",   labelKey: "sidebar.invoices",   icon: Receipt,         testId: "sidebar-invoices",   group: "analyze", featureKey: "invoices" },
  { to: "/decisions",  labelKey: "sidebar.decisions",  icon: ClipboardCheck,  testId: "sidebar-decisions",  group: "analyze" },
  { to: "/alerts",     labelKey: "sidebar.alerts",     icon: Bell,            testId: "sidebar-alerts",     group: "analyze" },
  { to: "/public-companies", labelKey: "sidebar.publicCompanies", icon: Globe, testId: "sidebar-public-companies", group: "explore" },
];

export const SHELL_GROUP_ORDER: ShellNavGroup[] = ["overview", "analyze", "explore"];

export const SHELL_GROUP_LABEL_KEYS: Record<ShellNavGroup, string> = {
  overview: "shell.nav.overview",
  analyze: "shell.nav.analyze",
  explore: "shell.nav.explore",
};

function filterByRegistry(
  items: ShellNavItem[],
  status: (k: FeatureKey) => FeatureStatus | undefined,
): ShellNavItem[] {
  return items.filter((item) => {
    if (!DECISIONS_ALERTS_ENABLED && (item.to === "/decisions" || item.to === "/alerts")) {
      return false;
    }
    if (item.featureKey) {
      const s = status(item.featureKey);
      if (s !== "active") return false;
    }
    return true;
  });
}

export interface ShellNavGroupResolved {
  key: ShellNavGroup;
  label: string;
  items: ShellNavItem[];
}

/** Registry-filtered, grouped, label-resolved nav — one hook shared by the
 *  rail and the command palette so the two can never disagree. */
export function useShellNav(): ShellNavGroupResolved[] {
  const { t } = useTranslation();
  const { features } = useFeatures();
  const visible = filterByRegistry(SHELL_NAV_ALL, (k) => features[k]?.status);
  return SHELL_GROUP_ORDER.map((g) => ({
    key: g,
    label: t(SHELL_GROUP_LABEL_KEYS[g]),
    items: visible.filter((w) => w.group === g),
  })).filter((g) => g.items.length > 0);
}

// Collapsed-rail persistence + the global toggle event (⌘. in AppShell,
// palette action). Only the DESKTOP rail instance listens — the drawer
// instance must not, or the two mounted Sidebars would cancel each other.
export const SIDEBAR_COLLAPSED_KEY = "cfo-ai-sidebar-collapsed-v1";
export const SIDEBAR_TOGGLE_EVENT = "cfo-ai-sidebar-toggle";
// Drawer conversations-dropdown open/closed (device-local UI state).
const SIDEBAR_CONVOS_OPEN_KEY = "cfo-ai-sidebar-convos-open-v1";

// Version shown under the app name at the top of the drawer: the native
// app's own version inside the shell, else the web build's package.json
// version (a Vite `define`; absent under vitest, hence the typeof guard).
const APP_VERSION: string =
  nativeShellVersion() ??
  (typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev");

export function Sidebar({
  onSettings: _onSettings,
  onSignOut,
  inDrawer = false,
  onItemClick,
  navTop,
  onOpenAccount,
  noWorkspace = false,
}: Props) {
  const { t } = useTranslation();
  const { user, displayName, initials } = useAuth();
  const { theme, resolvedTheme, setTheme, mounted: themeMounted } = useTheme();
  // In-flight work surfaces on the item that owns it: a chat reply spins
  // the Ask CFO AI item, a running analysis spins Dashboard or Products.
  const chatReplyPending = useChatReplyPending();
  const navigate = useNavigate();
  const location = useLocation();
  // The promoted Ask button builds its own href (it renders outside
  // SidebarLink), so it needs the period param at this level too.
  const period = new URLSearchParams(location.search).get("period");
  const askHref = period ? `/chat?period=${encodeURIComponent(period)}` : "/chat";
  // Programmatic navigation (conversations, sign-in): close the drawer
  // (onItemClick) and go. A slow tab shows its loader in the content area
  // (App.tsx ContentFallback) — the drawer never waits (2026-09-08).
  const go = (href: string) => {
    onItemClick?.();
    navigate(href);
  };
  const onLinkClick = (e: React.MouseEvent) => {
    if (!confirmLeaveUnsaved()) { e.preventDefault(); return; }
    onItemClick?.();
  };
  // Drawer-only conversations dropdown under the Ask CFO AI row (2026-09-04
  // per operator). Same module store the chat page/panel mount, so the list
  // is always in step with them. Open state persists across sessions.
  const chat = useChatStore();
  const [convosOpen, setConvosOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try { return window.localStorage.getItem(SIDEBAR_CONVOS_OPEN_KEY) !== "0"; }
    catch { return true; }
  });
  const toggleConvos = () => {
    setConvosOpen((v) => {
      try { window.localStorage.setItem(SIDEBAR_CONVOS_OPEN_KEY, v ? "0" : "1"); }
      catch { /* private mode — fail soft */ }
      return !v;
    });
  };
  const upload = useUploadStore();
  const uploadActive = !!upload.current && isInFlight(upload.current.status);
  const dashboardUploadActive = uploadActive && upload.current?.surface !== "products";
  const productsUploadActive = uploadActive && upload.current?.surface === "products";

  // Collapsed-rail mode (lg+ only). Persists across reloads. In drawer
  // mode collapse doesn't apply — always expanded.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try { return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1"; }
    catch { return false; }
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0"); }
    catch { /* private mode — fail soft */ }
    // Custom event so AppShell's main-content padding follows the rail
    // width in the same tick (`storage` doesn't fire for same-tab writes).
    try { window.dispatchEvent(new Event("cfo-ai-sidebar-collapsed")); }
    catch { /* SSR / older browsers */ }
  }, [collapsed]);

  // Global toggle (⌘. / palette). Desktop rail instance only — see above.
  useEffect(() => {
    if (inDrawer || typeof window === "undefined") return undefined;
    const onToggle = () => setCollapsed((v) => !v);
    window.addEventListener(SIDEBAR_TOGGLE_EVENT, onToggle);
    return () => window.removeEventListener(SIDEBAR_TOGGLE_EVENT, onToggle);
  }, [inDrawer]);

  const effectivelyCollapsed = !inDrawer && collapsed;
  // 64px collapsed: items keep pl-6 (24px) so the 16px icon's center sits
  // at 32px — dead center — and never moves while the width animates.
  // Keep widths in sync with AppShell's lg:pl-[64px]/lg:pl-[232px].
  const widthClass = effectivelyCollapsed ? "w-[64px]" : "w-[232px]";

  const groups = useShellNav();

  const isTerminal = resolvedTheme === "dark";

  return (
    <aside
      className={`
        ${inDrawer ? "w-full flex-1 min-h-0" : `hidden lg:flex fixed left-0 top-14 bottom-0 z-30 border-r border-rule ${widthClass}`}
        bg-bg
        flex flex-col
        overflow-hidden
        transition-[width] duration-overlay ease-out
      `}
      data-collapsed={effectivelyCollapsed ? "true" : "false"}
    >
      {/* App identity — DRAWER ONLY: mark + wordmark with the app version
          beneath, and the close (X). Inside the native shell there is no
          TopHeader, so this is the one place the app names itself; the
          version is the native app's there, the web build's in a mobile
          browser. A fixed HEADER (2026-09-09 per operator): only the nav
          below scrolls, between this and the pinned footer. */}
        {inDrawer && (
          <div className="shrink-0 pl-6 pr-3 pt-1" data-testid="sidebar-app-identity">
            {/* Wordmark with the version tucked under the text, and a close
                (X) button on the right; a hairline that fades out to the
                right closes the block (2026-09-08 per operator). */}
            <div className="flex items-start justify-between gap-3">
              {/* Composed from the Mark + text (not <Logo/>) so the version can
                  sit tight under the wordmark: Logo centres its text inside
                  the mark's full height, which left a visible gap. */}
              <div className="flex min-w-0 items-center gap-2.5 select-none text-ink">
                <Mark size={36} />
                <div className="min-w-0 leading-none">
                  <div className="text-[20px] font-bold tracking-[-0.005em]">
                    CFO <span className="text-brand font-medium">AI</span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-ink-mute" data-testid="sidebar-app-version">
                    {t("sidebar.version", { v: APP_VERSION })}
                  </div>
                </div>
              </div>
              <div className="-mt-1 flex shrink-0 items-center">
                <button
                  type="button"
                  data-testid="sidebar-close"
                  aria-label={t("common.close")}
                  onClick={onItemClick}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-md text-ink-soft hover:text-ink hover:bg-bg-2 active:bg-bg-2/70 transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X size={18} strokeWidth={1.75} />
                </button>
              </div>
            </div>
            {/* Same rule as the footer's (border-t border-rule, full width). */}
            <div aria-hidden className="mt-3 -ml-6 -mr-3 border-t border-rule" />
          </div>
        )}
      {/* Drawer: the ONE scroller, between the fixed header and footer
          (2026-09-09 per operator). The desktop rail keeps its own. */}
      <nav
        className={`flex-1 min-h-0 overflow-x-hidden space-y-4 ${inDrawer ? "pt-3 pb-4 overflow-y-auto overscroll-contain drawer-stagger" : "py-4 overflow-y-auto"}`}
        {...(inDrawer ? { "data-drawer-scroller": "" } : {})}
      >
        {inDrawer && navTop}
        {/* Currency — DRAWER ONLY (2026-08-18, native-shell pass): inside
            the shell the TopHeader (and its CurrencyMenu) isn't rendered,
            so the burger menu carries the display-currency toggle. */}
        {inDrawer && user && (
          <div className="flex items-center justify-between gap-3 px-6">
            <span className="text-[13px] text-ink-soft">{t("settings.currency", "Currency")}</span>
            <CurrencyToggle />
          </div>
        )}
        {/* Ask CFO AI — the product's headline capability, promoted to
            the TOP of the rail as the one accent-filled button (operator
            directive 2026-08-29, restored 2026-09-06 after a stint as a
            plain tab row). It stays in SHELL_NAV_ALL for the ⌘K palette;
            the grouped loop below filters it out so it never renders
            twice. */}
        <div className={effectivelyCollapsed ? "px-2 pb-1" : "px-3 pb-1"}>
          <NavLink
            to={askHref}
            data-testid="sidebar-chat"
            onClick={onLinkClick}
            {...(inDrawer ? tapHandlers(() => { if (confirmLeaveUnsaved()) go(askHref); }) : {})}
            title={effectivelyCollapsed ? t("sidebar.chat") : undefined}
            className={({ isActive }) =>
              `group flex items-center justify-center gap-2 rounded-md min-h-[44px] sm:min-h-0 sm:h-9 text-[13px] font-semibold transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ${
                isActive
                  ? "bg-brand-dark text-paper"
                  : "bg-brand text-paper hover:bg-brand-dark"
              }`
            }
          >
            {chatReplyPending ? (
              <Loader2 size={15} strokeWidth={2} className="animate-spin shrink-0"
                       aria-label="CFO AI is thinking" />
            ) : (
              <Sparkles size={15} strokeWidth={2} className="shrink-0" />
            )}
            <span
              className={`whitespace-nowrap overflow-hidden transition-opacity duration-overlay ${
                effectivelyCollapsed ? "hidden" : "opacity-100"
              }`}
            >
              {t("sidebar.chat")}
            </span>
            {!effectivelyCollapsed && (
              <kbd className="ml-1 hidden sm:inline text-[10px] font-mono font-normal opacity-70 group-hover:opacity-100">
                ⌘J
              </kbd>
            )}
          </NavLink>
        </div>
        {/* Conversations dropdown — DRAWER ONLY (2026-09-04 per operator):
            the user's chats nest under the Ask CFO AI button behind a
            minimize/maximize chevron. Tapping one selects it in the shared
            store and opens /chat. */}
        {inDrawer && chat.conversations.length > 0 && (
          <div className="px-3 pb-1">
            <button
              type="button"
              data-testid="sidebar-conversations-toggle"
              aria-expanded={convosOpen}
              onClick={toggleConvos}
              className="w-full flex items-center gap-2 min-h-[36px] px-3 text-[11px] uppercase tracking-[0.12em] text-ink-mute hover:text-ink-soft transition-colors duration-micro"
            >
              <span>{t("sidebar.conversations")}</span>
              <ChevronDown
                size={13}
                strokeWidth={1.75}
                className={`shrink-0 transition-transform duration-micro ${convosOpen ? "" : "-rotate-90"}`}
              />
            </button>
            {/* No inner scroller (2026-09-08 per operator): the list grows
                with its items and the whole drawer scrolls. */}
            {convosOpen && (
              <div data-testid="sidebar-conversations">
                {chat.conversations.map((c) => {
                  const selected = c.id === chat.currentId && location.pathname === "/chat";
                  return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => {
                      chat.select(c.id);
                      go(askHref);
                    }}
                    {...tapHandlers(() => {
                      chat.select(c.id);
                      go(askHref);
                    })}
                    className={`w-full flex items-center gap-2 min-h-[40px] px-3 rounded-sm text-left text-[12.5px] transition-colors duration-micro ${
                      selected
                        ? "text-ink font-medium bg-bg-2"
                        : "text-ink-soft hover:text-ink hover:bg-bg-2"
                    }`}
                  >
                    <MessageSquareText size={13} strokeWidth={1.75} className="shrink-0 text-ink-mute" />
                    {/* Selected title scrolls when it overflows (2026-09-08
                        per operator); the others keep the ellipsis. */}
                    {selected ? (
                      <span className="min-w-0 flex-1 marquee-active"><span>{c.title}</span></span>
                    ) : (
                      <span className="truncate">{c.title}</span>
                    )}
                  </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {groups.map((g) => (
          <Section key={g.key} label={g.label} collapsed={effectivelyCollapsed}>
            {g.items
              .filter((item) => item.to !== "/chat")
              .map(({ to, labelKey, icon: Icon, testId, end, shortcutKey }) => (
                <SidebarLink
                  key={to}
                  to={to}
                  testId={testId}
                  onClick={onItemClick}
                  onTap={inDrawer ? (href) => { if (confirmLeaveUnsaved()) go(href); } : undefined}
                  icon={Icon}
                  label={t(labelKey)}
                  collapsed={effectivelyCollapsed}
                  end={end}
                  disabled={noWorkspace && !ALWAYS_ENABLED.has(to)}
                  shortcutKey={shortcutKey}
                  trailing={
                    (to === "/dashboard" && dashboardUploadActive) ||
                    (to === "/products" && productsUploadActive) ? (
                      <Loader2
                        size={13}
                        strokeWidth={2}
                        className="animate-spin text-brand-dark"
                        aria-label="Analyzing your document"
                      />
                    ) : undefined
                  }
                />
              ))}
          </Section>
        ))}
        {/* Dev — DRAWER, DEV BUILDS ONLY (2026-09-09 per operator): a
            section under Explore holding the onboarding replay; never in
            a production bundle. */}
        {inDrawer && onboardingReplayAvailable && (
          <Section label={t("sidebar.groupDev")}>
            <button
              type="button"
              data-testid="sidebar-replay-onboarding"
              onClick={() => { onItemClick?.(); openOnboarding(); }}
              {...tapHandlers(() => { onItemClick?.(); openOnboarding(); })}
              className="relative flex w-full items-center min-h-[44px] sm:min-h-0 sm:h-9 gap-3 pl-6 pr-3 text-[13px] text-ink-soft hover:text-ink hover:bg-bg-2 transition-colors duration-micro"
            >
              <RotateCcw size={16} strokeWidth={1.75} className="shrink-0" />
              <span className="truncate">{t("sidebar.replayOnboarding")}</span>
            </button>
          </Section>
        )}
      </nav>

      {/* Account row — DRAWER ONLY (2026-08-18, native-shell pass): inside
          the shell there is no TopHeader avatar, so the credentials row is
          the account entry point; it opens the Command Center account
          surface via `onOpenAccount`. */}
      {inDrawer && user && (
        <div
          // Pinned to the BOTTOM of the drawer: the nav above is the only
          // scroller, so this never moves (2026-09-09 per operator).
          className="shrink-0 px-3 pt-2 border-t border-rule flex items-center gap-1 bg-bg"
          // Carries the home-indicator inset itself (the sheet has none), so
          // the row sits flush with the bottom edge.
          style={{ paddingBottom: "max(0.25rem, calc(env(safe-area-inset-bottom) - 0.75rem))" }}
        >
          <button
            type="button"
            data-testid="sidebar-account"
            onClick={() => onOpenAccount?.()}
            {...tapHandlers(() => onOpenAccount?.())}
            className="
              min-w-0 flex-1 flex items-center gap-3 px-3 min-h-[52px]
              rounded-sm text-left
              hover:bg-bg-2 active:bg-bg-2/70 transition-colors duration-micro
            "
          >
            <span
              aria-hidden
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand text-paper text-[11.5px] font-semibold tracking-tight"
            >
              {initials ?? <UserIcon size={14} strokeWidth={1.75} />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium text-ink truncate">
                {displayName ?? "Account"}
              </span>
              {user.email && (
                <span className="block text-[11px] text-ink-soft truncate">
                  {user.email}
                </span>
              )}
            </span>
          </button>
          {/* Notifications bell (2026-09-08 per operator): icon only, to the
              right of the credentials — it needs a signed-in inbox, which
              this row already guarantees. */}
          <NotificationsMenu />
        </div>
      )}

      {/* Footer — desktop rail: Settings · theme (Paper/Terminal) ·
          collapse. Drawer: Sign in / theme (the bell sits beside the account
          row above; Settings is reachable via the account row). */}
      {!(inDrawer && user) && (
      <div
        // Drawer: the footer — Sign in / theme — is pinned to the BOTTOM;
        // the nav above is the only scroller (2026-09-09 per operator).
        // Not rendered in the signed-in drawer: it has no visible rows there
        // (theme picker + Sign in are guest-only) and the account row above
        // is pinned to the bottom instead.
        className={`shrink-0 pt-2 pb-3 border-t border-rule space-y-0.5 ${inDrawer ? "bg-bg" : ""}`}
        // Drawer: carries the home-indicator inset itself (the sheet has
        // none) so the footer sits flush with the bottom edge.
        style={inDrawer ? { paddingBottom: "max(0.5rem, calc(env(safe-area-inset-bottom) - 0.25rem))" } : undefined}
      >
        {/* Drawer order (2026-09-08 per operator): divider · theme picker ·
            Sign in last, at the very bottom. */}
        {/* Guest theme picker (2026-09-04 per operator): System · Light ·
            Dark as three explicit buttons — guests have no account menu (the
            signed-in home of the three-way switcher), so the sidebar carries
            it. Signed-in users keep their existing controls. */}
        {!user && (
          <div className={effectivelyCollapsed ? "px-2 pb-1" : "px-3 pb-1"}>
            <ThemePicker collapsed={effectivelyCollapsed} testIdPrefix="sidebar-theme" />
          </div>
        )}
        {/* Guest mode (2026-09-04 per operator): the rail's one accent
            button is Sign in, pinned to the footer. Signed-in users never
            see it. Carries the same sanitized `next` contract Login.tsx
            reads, so the visitor returns to the page they were browsing. */}
        {!user && (
          <div className={effectivelyCollapsed ? "px-2 pb-1" : "px-3 pb-1"}>
            <button
              type="button"
              data-testid="sidebar-sign-in"
              title={effectivelyCollapsed ? t("topbar.signIn") : undefined}
              onClick={() => {
                const next = encodeURIComponent(location.pathname + location.search);
                go(`/login?next=${next}`);
              }}
              {...(inDrawer ? tapHandlers(() => go(`/login?next=${encodeURIComponent(location.pathname + location.search)}`)) : {})}
              className="w-full flex items-center justify-center gap-2 rounded-md min-h-[44px] sm:min-h-0 sm:h-9 text-[13px] font-semibold bg-brand text-paper hover:bg-brand-dark transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            >
              <LogIn size={15} strokeWidth={2} className="shrink-0" />
              <span
                className={`whitespace-nowrap overflow-hidden ${
                  effectivelyCollapsed ? "hidden" : ""
                }`}
              >
                {t("topbar.signIn")}
              </span>
            </button>
          </div>
        )}
        {!inDrawer && (
          <>
            <SidebarLink
              to="/settings"
              testId="sidebar-settings"
              icon={SettingsIcon}
              label={t("sidebar.settings")}
              collapsed={effectivelyCollapsed}
              disabled={noWorkspace && !ALWAYS_ENABLED.has("/settings")}
            />
            {/* Signed-in keeps the one-tap Paper/Terminal flip; guests get
                the three-way picker above instead. */}
            {user && (
              <SidebarAction
                icon={isTerminal ? SunMedium : Moon}
                label={
                  themeMounted
                    ? isTerminal
                      ? t("shell.theme.toPaper")
                      : t("shell.theme.toTerminal")
                    : t("shell.theme.label")
                }
                testId="sidebar-theme-toggle"
                onClick={() => setTheme(isTerminal ? "light" : "dark")}
                collapsed={effectivelyCollapsed}
              />
            )}
            <SidebarAction
              icon={collapsed ? PanelLeftOpen : PanelLeftClose}
              label={collapsed ? t("sidebar.expand") : t("sidebar.collapse")}
              title={`${collapsed ? t("sidebar.expand") : t("sidebar.collapse")} (${modKeyLabel()}.)`}
              testId="sidebar-collapse-toggle"
              onClick={() => setCollapsed((v) => !v)}
              collapsed={effectivelyCollapsed}
            />
          </>
        )}
      </div>
      )}
    </aside>
  );
}

// Sidebar navigation must preserve the active period across pages — every
// page reads the same period via `?period=<id>` in the URL, so each link
// re-attaches the current param.
function SidebarLink({
  to,
  testId,
  onClick,
  onTap,
  icon: Icon,
  label,
  collapsed = false,
  end = false,
  trailing,
  disabled = false,
  shortcutKey,
}: {
  to: string;
  testId: string;
  onClick?: () => void;
  /** Drawer: navigate on touch release (see tapHandlers). */
  onTap?: (href: string) => void;
  icon: LucideIcon;
  label: string;
  collapsed?: boolean;
  end?: boolean;
  /** Right-aligned status affordance (e.g. the chat thinking spinner). */
  trailing?: ReactNode;
  /** Render greyed-out and non-navigating (no workspace loaded yet). */
  disabled?: boolean;
  /** Hover-revealed shortcut hint key ("J" renders as ⌘J / Ctrl+J). */
  shortcutKey?: string;
}) {
  const [params] = useSearchParams();
  const period = params.get("period");
  const href = period ? `${to}?period=${encodeURIComponent(period)}` : to;
  const prefetchPeriod = usePrefetchPeriod();
  const onHover = period ? () => prefetchPeriod(period) : undefined;

  if (disabled) {
    return (
      <div
        data-testid={testId}
        aria-disabled="true"
        title={collapsed ? label : "Create a workspace first"}
        className="relative flex items-center min-h-[44px] sm:min-h-0 sm:h-9 gap-3 pl-6 pr-3 text-[13px] text-ink-soft opacity-40 cursor-not-allowed select-none"
      >
        <Icon size={16} strokeWidth={1.75} className="shrink-0" />
        <span
          className={`whitespace-nowrap overflow-hidden transition-opacity duration-overlay ${
            collapsed ? "opacity-0" : "opacity-100"
          }`}
        >
          {label}
        </span>
      </div>
    );
  }

  return (
    <NavLink
      to={href}
      data-testid={testId}
      onClick={(e) => {
        // Leaving a page with unapplied edits warns first (lib/unsavedGuard).
        if (!confirmLeaveUnsaved()) { e.preventDefault(); return; }
        onClick?.();
      }}
      onMouseEnter={onHover}
      onFocus={onHover}
      {...(onTap ? tapHandlers(() => onTap(href)) : {})}
      // Native title as the collapsed-rail tooltip — discoverable,
      // keyboard-accessible, AT-friendly, zero extra weight.
      title={collapsed ? label : undefined}
      end={end}
      className={({ isActive }) =>
        // Full-bleed rows; pl-6 keeps the icon center on the rail's 32px
        // line in BOTH modes so nothing shifts while the width animates.
        // Active is the 2px accent rule on the LEFT edge + ink text — no
        // pill, no fill. Hover is a quiet fill.
        `group relative flex items-center min-h-[44px] sm:min-h-0 sm:h-9 gap-3 pl-6 pr-3 text-[13px] transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
          isActive
            ? "text-ink font-medium"
            : "text-ink-soft hover:text-ink hover:bg-bg-2 active:bg-bg-2/70"
        }`
      }
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <span
              aria-hidden
              className="absolute inset-y-1 left-0 w-[2px] bg-brand"
            />
          )}
          <Icon size={16} strokeWidth={1.75} className="shrink-0" />
          {/* Label stays MOUNTED in both modes and crossfades — an instant
              unmount makes the collapse feel choppy; the aside's
              overflow-hidden clips it while the width animates. */}
          <span
            className={`whitespace-nowrap overflow-hidden transition-opacity duration-overlay ${
              collapsed ? "opacity-0" : "opacity-100"
            }`}
          >
            {label}
          </span>
          {!collapsed && (trailing ? (
            <span className="ml-auto shrink-0 inline-flex items-center">
              {trailing}
            </span>
          ) : shortcutKey ? (
            <kbd className="ml-auto shrink-0 rounded-sm border border-rule bg-bg-2 px-1 py-px font-mono text-[10px] text-ink-soft opacity-0 transition-opacity duration-micro group-hover:opacity-100 group-focus-visible:opacity-100">
              {modKeyLabel()}{shortcutKey}
            </kbd>
          ) : null)}
        </>
      )}
    </NavLink>
  );
}

/**
 * SidebarAction — non-route row sharing SidebarLink's geometry but firing
 * an onClick (theme toggle, collapse). No active state — actions don't
 * have one.
 */
function SidebarAction({
  icon: Icon,
  label,
  testId,
  onClick,
  collapsed = false,
  title,
}: {
  icon: LucideIcon;
  label: string;
  testId: string;
  onClick: () => void;
  collapsed?: boolean;
  /** Native-tooltip override (defaults to `label` when collapsed). */
  title?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      title={title ?? (collapsed ? label : undefined)}
      className="
        relative w-full text-left flex items-center
        min-h-[44px] sm:min-h-0 sm:h-9 gap-3 pl-6 pr-3
        text-[13px]
        text-ink-soft hover:text-ink hover:bg-bg-2 active:bg-bg-2/70
        transition-colors duration-micro
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring
      "
    >
      <Icon size={16} strokeWidth={1.75} className="shrink-0" />
      <span
        className={`whitespace-nowrap overflow-hidden transition-opacity duration-overlay ${
          collapsed ? "opacity-0" : "opacity-100"
        }`}
      >
        {label}
      </span>
    </button>
  );
}

function Section({
  label, children, collapsed = false,
}: {
  label: string;
  children: ReactNode;
  collapsed?: boolean;
}) {
  return (
    <div>
      {/* One FIXED-HEIGHT header row in both rail modes, crossfading
          between the 10px caps label (expanded) and a plain hairline
          (collapsed) so the collapse never jumps. */}
      <div className="relative h-[14px] mb-1">
        <div
          aria-hidden={collapsed}
          className={`absolute inset-y-0 left-6 right-3 flex items-center transition-opacity duration-overlay ${
            collapsed ? "opacity-0" : "opacity-100"
          }`}
        >
          {/* D1 axe: ink-mute is ~3.4:1 on Paper at this size — ink-soft
              keeps the quiet caps look while clearing WCAG AA 4.5:1. */}
          <span className="shrink-0 whitespace-nowrap text-[10px] uppercase tracking-[0.16em] text-ink-soft font-medium">
            {label}
          </span>
        </div>
        <div
          aria-hidden
          className={`absolute left-3 right-3 top-1/2 h-px bg-rule transition-opacity duration-overlay ${
            collapsed ? "opacity-100" : "opacity-0"
          }`}
        />
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}
