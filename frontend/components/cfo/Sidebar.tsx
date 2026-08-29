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

import { ReactNode, useEffect, useState } from "react";
import { NavLink, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { usePrefetchPeriod } from "@/lib/activePeriod";
import { useChatReplyPending } from "@/lib/chatPendingStore";
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
  Loader2,
  Moon,
  Sun,
  User as UserIcon,
  type LucideIcon,
} from "lucide-react";
import { NotificationsMenu } from "./NotificationsMenu";
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
// else loaded (2026-07-26 per operator).
const ALWAYS_ENABLED = new Set(["/workspace", "/settings", "/", "/chat"]);

// ── The shared nav model (rail + command palette) ──────────────────────

export type ShellNavGroup = "overview" | "analyze" | "explore" | "ask";

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
  { to: "/chat",       labelKey: "sidebar.chat",       icon: Sparkles,        testId: "sidebar-chat",       group: "ask", shortcutKey: "J" },
];

export const SHELL_GROUP_ORDER: ShellNavGroup[] = ["overview", "analyze", "explore", "ask"];

export const SHELL_GROUP_LABEL_KEYS: Record<ShellNavGroup, string> = {
  overview: "shell.nav.overview",
  analyze: "shell.nav.analyze",
  explore: "shell.nav.explore",
  ask: "shell.nav.ask",
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

export function Sidebar({
  onSettings: _onSettings,
  onSignOut,
  inDrawer = false,
  onItemClick,
  onOpenAccount,
  noWorkspace = false,
}: Props) {
  const { t } = useTranslation();
  const { user, displayName, initials } = useAuth();
  const { resolvedTheme, setTheme, mounted: themeMounted } = useTheme();
  // In-flight work surfaces on the item that owns it: a chat reply spins
  // the Ask CFO AI item, a running analysis spins Dashboard or Products.
  const chatReplyPending = useChatReplyPending();
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
        ${inDrawer ? "w-full" : `hidden lg:flex fixed left-0 top-14 bottom-0 z-30 border-r border-rule ${widthClass}`}
        bg-bg
        flex flex-col
        overflow-hidden
        transition-[width] duration-overlay ease-out
      `}
      data-collapsed={effectivelyCollapsed ? "true" : "false"}
    >
      <nav className={`flex-1 overflow-y-auto overflow-x-hidden py-4 space-y-4 ${inDrawer ? "drawer-stagger" : ""}`}>
        {/* Currency — DRAWER ONLY (2026-08-18, native-shell pass): inside
            the shell the TopHeader (and its CurrencyMenu) isn't rendered,
            so the burger menu carries the display-currency toggle. */}
        {inDrawer && user && (
          <div className="flex items-center justify-between gap-3 px-6">
            <span className="text-[13px] text-ink-soft">{t("settings.currency", "Currency")}</span>
            <CurrencyToggle />
          </div>
        )}
        {groups.map((g) => (
          <Section key={g.key} label={g.label} collapsed={effectivelyCollapsed}>
            {g.items.map(({ to, labelKey, icon: Icon, testId, end, shortcutKey }) => (
              <SidebarLink
                key={to}
                to={to}
                testId={testId}
                onClick={onItemClick}
                icon={Icon}
                label={t(labelKey)}
                collapsed={effectivelyCollapsed}
                end={end}
                disabled={noWorkspace && !ALWAYS_ENABLED.has(to)}
                shortcutKey={shortcutKey}
                trailing={
                  to === "/chat" && chatReplyPending ? (
                    <Loader2
                      size={13}
                      strokeWidth={2}
                      className="animate-spin text-brand-dark"
                      aria-label="CFO AI is thinking"
                    />
                  ) : (to === "/dashboard" && dashboardUploadActive) ||
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
      </nav>

      {/* Account row — DRAWER ONLY (2026-08-18, native-shell pass): inside
          the shell there is no TopHeader avatar, so the credentials row is
          the account entry point; it opens the Command Center account
          surface via `onOpenAccount`. */}
      {inDrawer && user && (
        <div className="px-3 pt-2 pb-2 border-t border-rule">
          <button
            type="button"
            data-testid="sidebar-account"
            onClick={() => onOpenAccount?.()}
            className="
              w-full flex items-center gap-3 px-3 min-h-[52px]
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
        </div>
      )}

      {/* Footer — desktop rail: Settings · theme (Paper/Terminal) ·
          collapse. Drawer: notifications row only (the phone header has
          no bell slot; Settings is reachable via the account row). */}
      <div
        className="pt-2 pb-3 border-t border-rule space-y-0.5"
        style={inDrawer ? { paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" } : undefined}
      >
        {inDrawer && <div className="px-3"><NotificationsMenu variant="row" /></div>}
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
            <SidebarAction
              icon={isTerminal ? Sun : Moon}
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
            <kbd className="ml-auto shrink-0 rounded-sm border border-rule bg-bg-2 px-1 py-px font-mono text-[10px] text-ink-mute opacity-0 transition-opacity duration-micro group-hover:opacity-100 group-focus-visible:opacity-100">
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
          <span className="shrink-0 whitespace-nowrap text-[10px] uppercase tracking-[0.16em] text-ink-mute font-medium">
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
