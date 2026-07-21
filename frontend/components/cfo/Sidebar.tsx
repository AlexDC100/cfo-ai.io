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

import { ReactNode, useEffect, useRef, useState } from "react";
import { NavLink, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useTheme } from "next-themes";
import { usePrefetchPeriod, useActivePeriod } from "@/lib/activePeriod";
import { useWorkspaceName } from "@/lib/workspaceName";
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
  SlidersHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Globe,
  // LogOut import dropped — sign-out moved to AccountMenu. Re-add if
  // the sidebar row is ever restored (see comment near the System group).
  type LucideIcon,
} from "lucide-react";
import { SUPPORTED_LANGUAGES, pickLanguageWithProfileSync } from "@/i18n";
import { useAuth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { IconButton } from "@/components/ui/IconButton";
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
  /** Exact-match the active highlight (NavLink `end`). Required for any item
   *  whose path is a prefix of another item's — e.g. `/dashboard` must NOT
   *  light up on `/dashboard/scenarios`. */
  end?: boolean;
}

// App-shell cleanup §2/§3 — Inventory and Invoices stay registry-gated
// (they only appear when their backend is wired). Products is restored
// as an unconditional Analysis entry per the user's directive: the SKU
// page is a working surface and must always be reachable from the rail.
// Reports was removed — it overlapped the per-period analysis workflow
// the dashboard already exposes; keeping it as a top-level item created
// menu repetition without unique value.
const WORKFLOW_ALL: WorkflowItem[] = [
  // Intelligence — overview + open-domain Q&A. Dashboard is the financial
  // command-center; chat is the universal CFO assistant. The Workspace hub
  // (/workspace) is no longer a rail item — it's reached via the "No workspace
  // loaded" affordance in the WorkspaceIdentity header instead.
  { to: "/dashboard",  labelKey: "sidebar.dashboard",  icon: LayoutDashboard, testId: "sidebar-dashboard",  group: "intelligence", end: true },
  { to: "/chat",       labelKey: "sidebar.chat",       icon: Sparkles,        testId: "sidebar-chat",       group: "intelligence" },
  // Public Company Intelligence — first-class module, sits in Intelligence
  // group right next to Dashboard + Ask CFO AI. Lands on the hub page
  // (/public-companies) which hosts the search panel, watchlist,
  // benchmarking + AI interpretation panels.
  { to: "/public-companies", labelKey: "sidebar.publicCompanies", icon: Globe, testId: "sidebar-public-companies", group: "intelligence" },
  // Analysis — datasets + comparative lenses + actionable lists.
  { to: "/benchmark",  labelKey: "sidebar.benchmark",  icon: BarChart3,       testId: "sidebar-benchmark",  group: "analysis" },
  { to: "/products",   labelKey: "sidebar.products",   icon: PackageSearch,   testId: "sidebar-products",   group: "analysis" },
  // F6.0.5 — Scenario planning / what-if. Always reachable (no registry gate).
  { to: "/dashboard/scenarios", labelKey: "sidebar.scenarios", icon: SlidersHorizontal, testId: "sidebar-scenarios", group: "analysis" },
  // F6.0.1b — Budget vs Actual vs Last-Year variance is NOT a standalone nav
  // item: it lives on the dashboard. Upload a budget deck on /dashboard and you
  // land on the report; while a budget is loaded the dashboard shows a "Budget
  // vs Actual" link back to it (see FinancialStatements.tsx). The /dashboard/
  // variance route stays registered (App.tsx) — only the rail entry was removed
  // to avoid a redundant, usually-empty link in the Analysis group.
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
  // onOpenCommandCenter intentionally NOT destructured — the sidebar's
  // Command Center button was removed. It stays on Props so AppShell can
  // keep passing it and a restore is one line.
  onSignOut,
  inDrawer = false,
  onItemClick,
}: Props) {
  const { t } = useTranslation();
  const period = useActivePeriod();
  const workspaceName = useWorkspaceName();

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
        ${inDrawer ? "" : "hidden lg:flex fixed left-3 top-[76px] bottom-3 z-30 rounded-2xl border border-rule shadow-2"}
        ${inDrawer ? "w-full border-r border-rule" : widthClass}
        bg-bg-2/40 backdrop-blur-md
        flex flex-col
        transition-[width] duration-200 ease-out
      `}
      data-collapsed={effectivelyCollapsed ? "true" : "false"}
    >
      {/* Workspace identity — visible when expanded. Product mark +
          active workspace (company) + loaded period. Sits above the
          nav; hidden in the collapsed 68px rail so the icon column
          stays uncluttered. */}
      {!effectivelyCollapsed && (
        <WorkspaceIdentity
          // Prefer the loaded period's company; fall back to the selected
          // workspace name (mirrored into useWorkspaceName by the workspaces
          // store) so the rail shows the chosen workspace even before a
          // trial-balance period is loaded — instead of "No workspace loaded".
          companyName={period.statements?.companyName ?? (workspaceName || null)}
          periodLabel={period.label}
          onNavigate={onItemClick}
        />
      )}

      <nav className="flex-1 overflow-y-auto px-2.5 py-3 space-y-3">
        {groups.map((g) => (
          <Section
            key={g.key}
            label={g.label}
            collapsed={effectivelyCollapsed}
          >
            {g.items.map(({ to, labelKey, icon: Icon, testId, end }) => (
              <SidebarLink
                key={to}
                to={to}
                testId={testId}
                onClick={onItemClick}
                icon={Icon}
                label={t(labelKey)}
                collapsed={effectivelyCollapsed}
                end={end}
              />
            ))}
            {/* Command Center action removed from the sidebar per the
                operator's directive. The drawer still opens from the
                top-right account avatar (AppShell wires that trigger);
                `onOpenCommandCenter` stays on the Sidebar interface for a
                one-line JSX restore if it's ever wanted back here. */}
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

      {/* Footer — theme switch, language, collapse toggle (lg+), disclaimer.
       *  All three buttons go through the shared `IconButton` primitive so
       *  box dimensions, icon size, hover/active/focus behavior are
       *  identical. Single flex container with `gap-1` owns the spacing
       *  — no per-button margin/padding overrides. */}
      <div className={`${effectivelyCollapsed ? "px-2" : "px-3"} pt-2 pb-3 border-t border-rule`}>
        <div className={`flex items-center ${effectivelyCollapsed ? "justify-center" : "justify-start"} gap-1 mb-2`}>
          <ThemeIconButton />
          <LanguageIconButton />
          {!inDrawer && (
            <IconButton
              size="sm"
              icon={collapsed ? <PanelLeftOpen strokeWidth={1.75} /> : <PanelLeftClose strokeWidth={1.75} />}
              label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              data-testid="sidebar-collapse-toggle"
              onClick={() => setCollapsed((v) => !v)}
            />
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

// Workspace identity header — product mark + the currently loaded
// workspace (company) + active period. Rendered at the top of the
// expanded rail. Values come from useActivePeriod(); when nothing is
// loaded it reads "No workspace loaded / —".
function WorkspaceIdentity({
  companyName,
  periodLabel,
  onNavigate,
}: {
  companyName: string | null;
  periodLabel: string | null;
  /** Close the mobile drawer after navigating (shared with SidebarLink). */
  onNavigate?: () => void;
}) {
  return (
    <div className="px-3 pt-4 pb-3 border-b border-rule/60">
      {/* The identity block IS the entry point to the Workspace hub
          (/workspace) — the only one since the rail item was removed. It shows
          the selected workspace (company + period) when one is loaded and
          "No workspace loaded" otherwise, and carries the selected-tab styling
          (brand border + tint) when the user is on /workspace. */}
      <NavLink
        to="/workspace"
        onClick={onNavigate}
        data-testid="sidebar-no-workspace"
        className={({ isActive }) =>
          `block rounded-lg border px-2 py-1 transition-colors ${
            isActive
              ? "border-brand/40 bg-brand/10"
              : "border-transparent hover:bg-bg-2/70"
          }`
        }
      >
        {companyName ? (
          <>
            <div className="text-[11.5px] font-medium text-ink truncate text-center">
              {companyName}
            </div>
            {periodLabel && (
              <div className="text-[10.5px] text-ink-mute truncate mt-px text-center">
                {periodLabel}
              </div>
            )}
          </>
        ) : (
          <span className="block text-[11.5px] font-medium text-ink-mute/60 text-center">
            No workspace loaded
          </span>
        )}
      </NavLink>
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
  end = false,
}: {
  to: string;
  testId: string;
  onClick?: () => void;
  icon: LucideIcon;
  label: string;
  collapsed?: boolean;
  end?: boolean;
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
      // `end` exact-matches so a parent path (e.g. /dashboard) doesn't stay
      // highlighted on nested routes (e.g. /dashboard/scenarios).
      end={end}
      className={({ isActive }) =>
        `group relative flex items-center min-h-[44px] sm:min-h-0 ${collapsed ? "justify-center px-0 py-2.5" : "gap-3 px-2.5 py-2.5 sm:py-2"} rounded-lg border text-[13px] transition-all duration-150 ${
          isActive
            ? "ask-ai-anim-fill [animation-duration:10s] text-ink font-medium border-brand/40"
            : "border-transparent text-ink-soft hover:text-ink hover:bg-bg-2/70 active:bg-bg-2/50"
        }`
      }
    >
      {() => (
        <>
          {/* Active row uses the same treatment as the "Ask CFO AI" pill —
           *  `ask-ai-anim-fill` (animated teal gradient) + a static brand
           *  border. A transparent border on the resting state keeps the 1px
           *  from shifting layout. */}
          <Icon
            size={collapsed ? 16 : 15}
            strokeWidth={1.75}
            className="relative z-10"
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
        "group relative w-full text-left flex items-center min-h-[44px] sm:min-h-0 rounded-lg text-[13px] " +
        "text-ink-soft hover:text-ink hover:bg-bg-2/70 active:bg-bg-2/50 " +
        "[&>svg]:text-ink-mute hover:[&>svg]:text-ink-soft " +
        "transition-all duration-150 " +
        (collapsed ? "justify-center px-0 py-2.5" : "gap-3 px-2.5 py-2.5 sm:py-2")
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
    <IconButton
      size="sm"
      icon={<Icon strokeWidth={1.75} />}
      label={label}
      onClick={() => setTheme(isDark ? "light" : "dark")}
    />
  );
}

/**
 * FE-FIX-4 — Sidebar language selector.
 *
 * The i18n machinery already exists (react-i18next + LanguageDetector +
 * useLanguage() priority chain + Settings → Language page), but the user
 * had no globally-visible language switcher. This sits next to the theme
 * toggle in the sidebar footer, opens a small popover, persists via
 * setLanguage() → localStorage → i18n.changeLanguage(). Active language
 * gets a check mark; popover dismisses on outside click.
 *
 * The popover also sets <html lang=...> so screen readers + the browser
 * surface the language correctly. Done inside `setLanguage()` already?
 * It is — i18next's languageChanged event fires LanguageSync, which
 * persists. The <html lang> attribute is set in main.tsx on language
 * changes. So this button is just a UI surface — all the state plumbing
 * already exists.
 */
function LanguageIconButton() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const active = i18n.language?.split("-")[0] ?? "en";
  const label = t("sidebar.language_label", "Change language");

  function handlePick(code: string) {
    // Fix 3 — perf: close the popover SYNCHRONOUSLY before kicking off
    // the network-bound profile sync. Awaiting two Supabase round-trips
    // before closing left the popover open for ~400-800ms on prod, which
    // read as button lag. The local i18next change inside
    // pickLanguageWithProfileSync is itself synchronous; only the
    // Supabase profile + auth.updateUser calls are async. We fire-and-
    // forget those — the priority chain in useLanguage.ts already gets
    // the right answer from the in-flight i18next change + localStorage
    // write, so the UI re-renders immediately. The profile mirror
    // happens in the background to make the choice survive a cache
    // clear / new-device sign-in.
    //
    // Mirrors Settings → Language card semantics (profile + auth metadata)
    // so useLanguage()'s priority chain treats this as the canonical
    // preference. Without the profile sync the click would silently
    // revert: LanguageSync re-reads profileLang on every render and
    // pushes it back into i18next, overriding the localStorage write.
    setOpen(false);
    const sb = getSupabase();
    void pickLanguageWithProfileSync(code, user ?? null, sb);
  }

  return (
    // `<span>` (inline-block in the flex parent) rather than `<div>` so
    // the popover anchor doesn't introduce a baseline shift relative to
    // the sibling icon buttons. The button itself goes through the same
    // `IconButton` primitive as the other two footer icons.
    <span ref={containerRef} className="relative inline-flex">
      <IconButton
        size="sm"
        icon={<Globe strokeWidth={1.75} />}
        label={label}
        active={open}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="sidebar-language-button"
        onClick={() => setOpen((v) => !v)}
      />
      {open && (
        <div
          role="menu"
          data-testid="sidebar-language-popover"
          className="
            absolute bottom-full left-0 mb-2 min-w-[160px] z-50
            rounded-lg border border-rule bg-surface shadow-lg
            py-1
          "
        >
          {SUPPORTED_LANGUAGES.map((lng) => {
            const isActive = lng.code === active;
            return (
              <button
                key={lng.code}
                type="button"
                role="menuitemradio"
                aria-checked={isActive}
                onClick={() => handlePick(lng.code)}
                className={`
                  w-full text-left px-3 py-1.5 text-[12.5px]
                  hover:bg-bg-2 transition-colors
                  flex items-center gap-2
                  ${isActive ? "text-ink font-medium" : "text-ink-soft"}
                `}
              >
                <span className="text-[14px] leading-none">{lng.flag}</span>
                <span className="flex-1">{lng.label}</span>
                {isActive && <span aria-hidden className="text-brand">✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}
