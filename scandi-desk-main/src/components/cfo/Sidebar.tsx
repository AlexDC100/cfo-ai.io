// Persistent left sidebar — clean workflow nav only.
//
// 240px wide on lg+, hidden on smaller screens (mobile gets the same
// content via a slide-over drawer triggered by the TopHeader hamburger).
//
// Workflow routes are grouped into Intelligence / Analysis / System.
// The System group at the bottom holds non-route entries too — today
// that's Settings (link) and Command Center (action button). Command
// Center previously opened from the top-right header (⋯) — the
// relocation moved it here so the rail is the one home for navigation
// AND in-place control surfaces.
//
// Footer icons: theme toggle + collapse toggle.
//
// Keeping the surface narrow makes navigation feel calm and product-led
// rather than admin-led.

import { ReactNode, useEffect, useState } from "react";
import { NavLink, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useTheme } from "next-themes";
import { motion } from "framer-motion";
import { usePrefetchPeriod, useActivePeriod } from "@/lib/activePeriod";
import { springSnappy } from "@/lib/motion";
import { DECISIONS_ALERTS_ENABLED } from "@/config/features";
import {
  LayoutDashboard,
  ClipboardCheck,
  PackageSearch,
  Bell,
  Settings as SettingsIcon,
  Sun,
  Moon,
  BarChart3,
  Boxes,
  Receipt,
  Sparkles,
  PanelLeftClose,
  PanelLeftOpen,
  MoreHorizontal,
  // LogOut import dropped — sign-out moved to AccountMenu. Re-add if
  // the sidebar row is ever restored (see comment near the System group).
  type LucideIcon,
} from "lucide-react";
import {
  type FeatureKey,
  type FeatureStatus,
  useFeatures,
} from "@/lib/features";

interface Props {
  onSettings: () => void;
  /** Open the Command Center drawer. Wired from AppShell — Command
   *  Center used to live in the top-right header menu and is now
   *  invoked from the System group of the sidebar, directly below
   *  Settings. Pure relocation; the drawer state still lives in
   *  AppShell so the same panel renders. */
  onOpenCommandCenter?: () => void;
  /** Sign the user out. THE ONLY sign-out invocation in the app.
   *  Lives below Command Center in the System group, per the
   *  operator's "single, simple sign-out" directive. AppShell wires
   *  this to `useAuth().signOut()` + a toast + navigate to /login. */
  onSignOut?: () => Promise<void> | void;
  /** Drawer mode — closes the slide-over after a click on mobile. */
  inDrawer?: boolean;
  onItemClick?: () => void;
}

// Sidebar items grouped by purpose. This replaces the previous flat
// 5-item rail with three semantic groups (Intelligence / Analysis /
// Workspace) so the nav scans as a "AI finance command rail" rather
// than a generic page list. Decisions & Alerts remain in the source
// list and are filtered out by the DECISIONS_ALERTS_ENABLED flag —
// flipping it back to true restores them in their original group
// without any other change.
interface WorkflowItem {
  to: string;
  labelKey: string;
  icon: LucideIcon;
  testId: string;
  group: "intelligence" | "analysis" | "workspace";
  /** When set, the item is gated on the feature registry. If the
   *  feature is `hidden` or unknown, the item does not render. If it's
   *  `coming_soon`, the item renders disabled with a soft "Soon" hint. */
  featureKey?: FeatureKey;
}

// App-shell cleanup §2/§3 — Inventory and Invoices stay registry-gated
// (they only appear when their backend is wired). Products is restored
// as an unconditional Analysis entry per the user's directive: the SKU
// page is a working surface and must always be reachable from the rail.
// Reports was removed — it overlapped the per-period analysis workflow
// the dashboard already exposes; keeping it as a top-level item created
// menu repetition without unique value.
const WORKFLOW_ALL: WorkflowItem[] = [
  // Intelligence — overview + open-domain Q&A. Dashboard is the
  // financial command-center; chat is the universal CFO assistant.
  { to: "/dashboard",  labelKey: "sidebar.dashboard",  icon: LayoutDashboard, testId: "sidebar-dashboard",  group: "intelligence" },
  { to: "/chat",       labelKey: "sidebar.chat",       icon: Sparkles,        testId: "sidebar-chat",       group: "intelligence" },
  // Analysis — datasets + comparative lenses + actionable lists.
  { to: "/benchmark",  labelKey: "sidebar.benchmark",  icon: BarChart3,       testId: "sidebar-benchmark",  group: "analysis" },
  { to: "/products",   labelKey: "sidebar.products",   icon: PackageSearch,   testId: "sidebar-products",   group: "analysis" },
  { to: "/inventory",  labelKey: "sidebar.inventory",  icon: Boxes,           testId: "sidebar-inventory",  group: "analysis", featureKey: "inventory" },
  { to: "/invoices",   labelKey: "sidebar.invoices",   icon: Receipt,         testId: "sidebar-invoices",   group: "analysis", featureKey: "invoices" },
  { to: "/decisions",  labelKey: "sidebar.decisions",  icon: ClipboardCheck,  testId: "sidebar-decisions",  group: "analysis" },
  { to: "/alerts",     labelKey: "sidebar.alerts",     icon: Bell,            testId: "sidebar-alerts",     group: "analysis" },
  // Workspace / System — account / settings.
  // Upload Center was removed: every analysis surface already exposes
  // an upload affordance (Dashboard empty-state, Replace dropdown,
  // Command Center → Data) so a separate sidebar item was a duplicate.
  { to: "/settings",   labelKey: "sidebar.settings",   icon: SettingsIcon,    testId: "sidebar-settings",   group: "workspace" },
];

/** Apply build-time + registry-time gating. `hidden` / missing registry
 *  entries → drop. `coming_soon` → drop from sidebar per spec §2 (only
 *  surfaced in Command Center → Data). `active` → keep. */
function filterByRegistry(items: WorkflowItem[], status: (k: FeatureKey) => FeatureStatus | undefined): WorkflowItem[] {
  return items.filter((item) => {
    // Build-time guard for Decisions / Alerts (legacy flag).
    if (!DECISIONS_ALERTS_ENABLED && (item.to === "/decisions" || item.to === "/alerts")) {
      return false;
    }
    // Registry guard for everything that opts in via `featureKey`.
    if (item.featureKey) {
      const s = status(item.featureKey);
      // Hide inactive Inventory / Invoices from the sidebar entirely
      // per the cleanup brief; they appear in Command Center → Data
      // with a Coming soon badge so users see the roadmap there.
      if (s !== "active") return false;
    }
    return true;
  });
}

const GROUP_LABELS: Record<WorkflowItem["group"], string> = {
  intelligence: "Intelligence",
  analysis: "Analysis",
  workspace: "System",
};

const GROUP_ORDER: WorkflowItem["group"][] = ["intelligence", "analysis", "workspace"];

// Collapsed-rail persistence — surviving a page reload feels native.
const SIDEBAR_COLLAPSED_KEY = "cfo-ai-sidebar-collapsed-v1";

export function Sidebar({
  onSettings: _onSettings,
  onOpenCommandCenter,
  onSignOut,
  inDrawer = false,
  onItemClick,
}: Props) {
  const { t } = useTranslation();
  const period = useActivePeriod();

  // Collapsed-rail mode (lg+ only). Persists across reloads. In drawer
  // mode (mobile slide-over) the user already has explicit close so
  // collapse doesn't apply there — always expanded.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try { return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1"; }
    catch { return false; }
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0"); }
    catch { /* private mode — fail soft */ }
    // Fire a custom event so AppShell's main-content padding follows
    // the rail width in the same tick (localStorage's `storage` event
    // doesn't fire for same-tab writes).
    try { window.dispatchEvent(new Event("cfo-ai-sidebar-collapsed")); }
    catch { /* SSR / older browsers */ }
  }, [collapsed]);

  const effectivelyCollapsed = !inDrawer && collapsed;
  const widthClass = effectivelyCollapsed ? "w-[68px]" : "w-[244px]";

  // Resolve registry-driven gating at render time so a feature flip
  // (e.g., `inventory` going active) updates the rail without a remount.
  const { features } = useFeatures();
  const workflow = filterByRegistry(WORKFLOW_ALL, (k) => features[k]?.status);

  // Group the visible nav items.
  const groups = GROUP_ORDER.map((g) => ({
    key: g,
    label: GROUP_LABELS[g],
    items: workflow.filter((w) => w.group === g),
  })).filter((g) => g.items.length > 0);

  return (
    <aside
      className={`
        ${inDrawer ? "" : "hidden lg:flex fixed left-0 top-16 bottom-0 z-30"}
        ${inDrawer ? "w-full" : widthClass}
        bg-bg-2/40 backdrop-blur-md
        border-r border-rule
        flex flex-col
        transition-[width] duration-200 ease-out
      `}
      data-collapsed={effectivelyCollapsed ? "true" : "false"}
    >
      {/* Workspace identity — visible when expanded. Three-line stack:
          product · workspace · active period. Replaces the previous
          empty top space. */}
      {!effectivelyCollapsed && (
        <WorkspaceIdentity
          companyName={period.statements?.companyName ?? null}
          periodLabel={period.label}
        />
      )}

      <nav className="flex-1 overflow-y-auto px-2.5 py-3 space-y-3">
        {groups.map((g) => (
          <Section
            key={g.key}
            label={g.label}
            collapsed={effectivelyCollapsed}
          >
            {g.items.map(({ to, labelKey, icon: Icon, testId }) => (
              <SidebarLink
                key={to}
                to={to}
                testId={testId}
                onClick={onItemClick}
                icon={Icon}
                label={t(labelKey)}
                collapsed={effectivelyCollapsed}
              />
            ))}
            {/* System group — append the Command Center action directly
                below Settings. This is a relocation of the top-right
                header trigger; the drawer state still lives in
                AppShell so opening from here renders the same panel
                with the same period-grounded context. Only mounts
                in the `workspace` group (the System rail), and only
                when a callback was supplied. */}
            {g.key === "workspace" && onOpenCommandCenter && (
              <SidebarAction
                icon={MoreHorizontal}
                label="Command Center"
                testId="sidebar-command-center"
                onClick={() => {
                  onOpenCommandCenter();
                  onItemClick?.();
                }}
                collapsed={effectivelyCollapsed}
              />
            )}
            {/* Sign-out moved (May 2026 redesign) — it now lives in the
                top-right <AccountMenu/> (data-testid="account-menu-sign-out")
                as the THE single sign-out in the app. The Sidebar System
                group no longer renders a sign-out row, the Command Center
                Account tab no longer renders one either, and the avatar
                dropdown is the only invocation path. The `onSignOut`
                prop stays on the Sidebar interface for revert (one-line
                JSX restore) but is now unused at runtime. */}
          </Section>
        ))}
      </nav>

      {/* Footer — collapse toggle (lg+), theme switch, disclaimer. */}
      <div className={`${effectivelyCollapsed ? "px-2" : "px-3"} pt-2 pb-3 border-t border-rule`}>
        <div className={`flex items-center ${effectivelyCollapsed ? "justify-center" : "justify-between"} gap-1 mb-2`}>
          <ThemeIconButton />
          {!inDrawer && (
            <button
              type="button"
              onClick={() => setCollapsed((v) => !v)}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              data-testid="sidebar-collapse-toggle"
              className="
                inline-flex items-center justify-center h-9 w-9 rounded-lg
                text-ink-mute hover:text-ink hover:bg-bg-2/70
                transition-colors
              "
            >
              {collapsed
                ? <PanelLeftOpen size={15} strokeWidth={1.75} />
                : <PanelLeftClose size={15} strokeWidth={1.75} />}
            </button>
          )}
        </div>
        {!effectivelyCollapsed && (
          <p className="px-1 text-[10.5px] text-ink-mute leading-snug">
            {t("sidebar.footer_note")}
          </p>
        )}
      </div>
    </aside>
  );
}

// ─── Workspace identity ──────────────────────────────────────────
// Three-line header at the top of the expanded sidebar. Surfaces the
// product mark, the active workspace/company name, and the active
// period — answering "where am I, in which company, on which year"
// without needing to look up at the page header.

function WorkspaceIdentity({
  companyName,
  periodLabel,
}: {
  companyName: string | null;
  periodLabel: string | null;
}) {
  return (
    <div className="px-3 pt-4 pb-3 border-b border-rule/60">
      <div className="flex items-center gap-2 mb-2.5">
        <span className="inline-flex items-center justify-center h-6 w-6 rounded-md bg-gradient-to-br from-brand to-brand-d text-white shadow-[0_4px_12px_-4px_rgba(45,191,179,0.55)]">
          <Sparkles size={11} strokeWidth={2.25} />
        </span>
        <span className="text-[12px] font-semibold tracking-[0.02em] text-ink">CFO AI</span>
      </div>
      <div className="text-[11.5px] font-medium text-ink truncate">
        {companyName ?? "No workspace loaded"}
      </div>
      <div className="text-[10.5px] text-ink-mute truncate mt-px">
        {periodLabel ?? "—"}
      </div>
    </div>
  );
}

// Sidebar navigation must preserve the active period across pages — the
// architectural rule from Phase G: every page reads the same period via
// `?period=<id>` in the URL. Stripping it on every nav click would force
// each page back into its empty state. So we read the current period
// param and re-attach it to every workflow link.
function SidebarLink({
  to,
  testId,
  onClick,
  icon: Icon,
  label,
  collapsed = false,
}: {
  to: string;
  testId: string;
  onClick?: () => void;
  icon: LucideIcon;
  label: string;
  collapsed?: boolean;
}) {
  const [params] = useSearchParams();
  const period = params.get("period");
  const href = period ? `${to}?period=${encodeURIComponent(period)}` : to;
  const prefetchPeriod = usePrefetchPeriod();
  const onHover = period ? () => prefetchPeriod(period) : undefined;
  return (
    <NavLink
      to={href}
      data-testid={testId}
      onClick={onClick}
      onMouseEnter={onHover}
      onFocus={onHover}
      // Tooltip-via-title for collapsed-rail mode. Real Radix tooltip
      // would be heavier than this needs to be; the native title is
      // discoverable, keyboard-accessible, and AT-friendly.
      title={collapsed ? label : undefined}
      // Active match keys off the pathname only — query param
      // differences (?period=eei vs none) don't affect the highlight.
      end={false}
      className={({ isActive }) =>
        `group relative flex items-center ${collapsed ? "justify-center px-0 py-2.5" : "gap-3 px-2.5 py-2"} rounded-lg text-[13px] transition-all duration-150 ${
          isActive
            ? "text-ink font-medium [&>svg]:text-brand-d"
            : "text-ink-soft hover:text-ink hover:bg-bg-2/70 [&>svg]:text-ink-mute hover:[&>svg]:text-ink-soft"
        }`
      }
    >
      {({ isActive }) => (
        <>
          {/* Active state — three layered cues, spring-animated across
           *  the rail via shared layoutIds:
           *    1. soft gradient fill (brand-tint → transparent)
           *    2. thin left accent bar in brand color
           *    3. subtle outer glow (only when expanded — collapsed rail
           *       keeps the visual quiet so the icon does the work) */}
          {isActive && (
            <motion.div
              layoutId="sidebar-active-pill"
              transition={springSnappy}
              className="
                absolute inset-0 rounded-lg
                bg-gradient-to-r from-brand-tint via-brand-tint/60 to-transparent
                ring-1 ring-inset ring-brand/15
              "
              aria-hidden
            />
          )}
          {isActive && (
            <motion.span
              layoutId="sidebar-active-bar"
              transition={springSnappy}
              className="absolute left-0 top-1.5 bottom-1.5 w-[2.5px] rounded-r bg-brand-d shadow-[0_0_10px_rgba(45,191,179,0.45)]"
              aria-hidden
            />
          )}
          <Icon
            size={collapsed ? 16 : 15}
            strokeWidth={1.75}
            className="relative z-10 transition-transform group-hover:scale-[1.04]"
          />
          {!collapsed && <span className="relative z-10 truncate">{label}</span>}
        </>
      )}
    </NavLink>
  );
}

/**
 * SidebarAction — non-route entry that shares SidebarLink's visual
 * shape but renders a `<button>` and fires an onClick callback. Used
 * for items that open in-place panels (drawers, dialogs) rather than
 * navigating to a new URL. Today's only caller is the System group's
 * Command Center entry (relocated from the top-right header menu).
 *
 * Deliberately mirrors SidebarLink's resting-state styling so the rail
 * reads as one consistent list of items. No `isActive` highlight —
 * actions don't have a current/inactive state.
 */
function SidebarAction({
  icon: Icon,
  label,
  testId,
  onClick,
  collapsed = false,
}: {
  icon: LucideIcon;
  label: string;
  testId: string;
  onClick: () => void;
  collapsed?: boolean;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      title={collapsed ? label : undefined}
      className={
        "group relative w-full text-left flex items-center rounded-lg text-[13px] " +
        "text-ink-soft hover:text-ink hover:bg-bg-2/70 " +
        "[&>svg]:text-ink-mute hover:[&>svg]:text-ink-soft " +
        "transition-all duration-150 " +
        (collapsed ? "justify-center px-0 py-2.5" : "gap-3 px-2.5 py-2")
      }
    >
      <Icon
        size={collapsed ? 16 : 15}
        strokeWidth={1.75}
        className="relative z-10 transition-transform group-hover:scale-[1.04]"
      />
      {!collapsed && <span className="relative z-10 truncate">{label}</span>}
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
      {!collapsed ? (
        <div className="px-2.5 mb-1 text-[9.5px] uppercase tracking-[0.16em] text-ink-mute font-semibold">
          {label}
        </div>
      ) : (
        // In collapsed mode, group headers become a thin divider so the
        // rail still reads as grouped without spilling text into a
        // 68px column.
        <div className="mx-2 my-2 h-px bg-rule/40" aria-hidden />
      )}
      <div className="space-y-px">{children}</div>
    </div>
  );
}

function ThemeIconButton() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Default Sun during SSR / pre-hydration so first paint matches dark default.
  const isDark = !mounted || resolvedTheme !== "light";
  const Icon = isDark ? Sun : Moon;
  const label = isDark ? "Switch to light theme" : "Switch to dark theme";

  return (
    <button
      onClick={() => setTheme(isDark ? "light" : "dark")}
      title={label}
      aria-label={label}
      className="
        inline-flex items-center justify-center
        h-9 w-9 rounded-lg
        text-ink-soft hover:text-ink hover:bg-bg-2
        transition-colors
      "
    >
      <Icon size={15} strokeWidth={1.75} />
    </button>
  );
}
