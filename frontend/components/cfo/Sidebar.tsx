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

import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { NavLink, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { usePrefetchPeriod, useActivePeriod } from "@/lib/activePeriod";
import { useWorkspaceName } from "@/lib/workspaceName";
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
  Home,
  // LogOut import dropped — sign-out moved to AccountMenu. Re-add if
  // the sidebar row is ever restored (see comment near the System group).
  Building2,
  ChevronLeft,
  ChevronRight,
  Info,
  Loader2,
  type LucideIcon,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import {
  currentMonthEnd,
  fetchWorkspacePeriodsDirect,
  formatPeriodMonth,
  useOrgPeriods,
  type OrgPeriod,
} from "@/lib/orgPeriods";
import { useActiveOrg } from "@/lib/org";
import { startPeriodSwitch } from "@/lib/periodSwitch";
import { blockedByScan } from "@/lib/scanGuard";
import { confirmLeaveUnsaved } from "@/lib/unsavedGuard";
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
  /** No workspace yet — every destination that needs workspace data is
   *  disabled; only the routes in ALWAYS_ENABLED (Workspaces, Settings,
   *  website), plus the collapse toggle + disclaimer, stay live. */
  noWorkspace?: boolean;
}

// Routes that stay clickable even with no workspace — the ones that DON'T
// depend on loaded workspace data (create/switch a workspace, app settings,
// back to the public site). Everything else is disabled until a workspace
// exists. The footer collapse toggle + disclaimer are SidebarActions, not in
// this list, and are never gated.
//
// `/chat` is in the list (2026-07-26 per operator) because Ask CFO AI is
// explicitly dual-mode: with a workspace it answers grounded in that company's
// numbers, and WITHOUT one it still answers open-domain finance, accounting
// and strategy questions — the chat shell has a "No workspace loaded —
// open-domain mode" state built for exactly this. Greying it out denied the
// one surface that works fine empty. It also runs on a Supabase Edge Function
// rather than the engine, so it needs nothing else loaded.
const ALWAYS_ENABLED = new Set(["/workspace", "/settings", "/", "/chat"]);

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
  // Workspaces leads the rail (2026-07-24) — with the WorkspaceIdentity
  // header gone, this is the primary way to see/switch the active
  // workspace, so it sits first.
  { to: "/workspace",  labelKey: "sidebar.workspaces", icon: Building2,       testId: "sidebar-workspaces", group: "intelligence" },
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
  // Budget vs Actual vs Last-Year variance — restored as a rail item (2026-07-25)
  // per operator directive; the /dashboard/variance route was already registered.
  { to: "/dashboard/variance", labelKey: "sidebar.variance", icon: Scale, testId: "sidebar-variance", group: "analysis" },
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
  // Landing website — back to the public marketing site. `end: true` so the
  // "/" route doesn't render as active on every other page.
  { to: "/",           labelKey: "sidebar.website",    icon: Home,            testId: "sidebar-website",    group: "workspace", end: true },
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
  noWorkspace = false,
}: Props) {
  const { t } = useTranslation();
  const period = useActivePeriod();
  const workspaceName = useWorkspaceName();
  // True while an Ask CFO AI reply is in flight anywhere in the app —
  // drives the thinking spinner on the chat rail item.
  const chatReplyPending = useChatReplyPending();
  // True while a document upload/analysis is running — drives the
  // spinner on the Dashboard rail item (replaces the header's
  // active-document chip, removed 2026-07-24).
  const upload = useUploadStore();
  const uploadActive = !!upload.current && isInFlight(upload.current.status);
  // Dashboard and Products are DIFFERENT pipelines — spin the rail item that
  // owns the in-flight upload, not always Dashboard.
  const dashboardUploadActive = uploadActive && upload.current?.surface !== "products";
  const productsUploadActive = uploadActive && upload.current?.surface === "products";

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

  // Disclaimer modal — opened from the footer's "Disclaimer" row.
  const [disclaimerOpen, setDisclaimerOpen] = useState(false);

  const effectivelyCollapsed = !inDrawer && collapsed;
  // Collapsed width = icon's left inset (nav px-2.5 + item px-2.5 = 20px)
  // + icon 16px + a MATCHING 20px on the right — so every icon sits dead
  // center with equal air on both sides, without ever moving during the
  // collapse animation. Keep in sync with AppShell's lg:pl-[80px] and
  // CouncilSphereHost's collapsed padding.
  const widthClass = effectivelyCollapsed ? "w-[56px]" : "w-[244px]";

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
        overflow-hidden
        transition-[width] duration-200 ease-out
      `}
      data-collapsed={effectivelyCollapsed ? "true" : "false"}
    >
      {/* WorkspaceIdentity header removed 2026-07-24 per operator
          directive — the active workspace now surfaces via the Command
          Center's Workspace quick action (and the "Workspaces" rail
          item below). */}
      {/* overflow-x-hidden — with labels now staying mounted in the
          collapsed rail (they fade, clipped by the aside), the nav's
          overflow-y-auto would otherwise compute overflow-x to auto and
          grow a horizontal scrollbar in the 55px rail. */}
      <nav className="flex-1 overflow-y-auto overflow-x-hidden px-2.5 py-3 space-y-3">
        {/* Month stepper — moved here from TopHeader (2026-07-26 per
            operator). Sits ABOVE the Intelligence divider so the active
            month reads as the context every nav item below is scoped to.
            Hidden in the collapsed rail: a month label has no icon-only
            form, and squeezing arrows into 56px would misread as nav. */}
        {!effectivelyCollapsed && <SidebarMonthStepper />}
        {groups.filter((g) => g.key !== "workspace").map((g) => (
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
                disabled={noWorkspace && !ALWAYS_ENABLED.has(to)}
                // In-flight work surfaces on the item that owns it: a
                // chat reply spins the Ask CFO AI item, a running
                // document analysis spins Dashboard — both visible from
                // any page.
                trailing={
                  to === "/chat" && chatReplyPending ? (
                    <Loader2
                      size={13}
                      strokeWidth={2}
                      className="animate-spin text-brand-d"
                      aria-label="CFO AI is thinking"
                    />
                  ) : (to === "/dashboard" && dashboardUploadActive) ||
                      (to === "/products" && productsUploadActive) ? (
                    <Loader2
                      size={13}
                      strokeWidth={2}
                      className="animate-spin text-brand-d"
                      aria-label="Analyzing your document"
                    />
                  ) : undefined
                }
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

      {/* System group (Settings / Website) — pinned to the rail's BOTTOM
          (2026-07-24), outside the scrolling nav, just above the footer. */}
      {groups.some((g) => g.key === "workspace") && (
        <div className="px-2.5 pb-2 pt-1">
          {groups.filter((g) => g.key === "workspace").map((g) => (
            <Section key={g.key} label={g.label} collapsed={effectivelyCollapsed}>
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
                  disabled={noWorkspace && !ALWAYS_ENABLED.has(to)}
                />
              ))}
            </Section>
          ))}
        </div>
      )}

      {/* Footer — theme switch, language, collapse toggle (lg+), disclaimer.
       *  All three buttons go through the shared `IconButton` primitive so
       *  box dimensions, icon size, hover/active/focus behavior are
       *  identical. Single flex container with `gap-1` owns the spacing
       *  — no per-button margin/padding overrides. */}
      {/* Footer — the collapse toggle and the disclaimer "i" STACKED as
          full-width rows (2026-07-24), icon left + label right, sharing
          the nav items' row geometry so their icons sit on the rail's
          28px center line. Theme/Language buttons removed earlier the
          same day — theme lives in the account menu / Command Center,
          language in Settings. */}
      <div className="px-2.5 pt-2 pb-3 border-t border-rule space-y-2">
        {!inDrawer && (
          <SidebarAction
            icon={collapsed ? PanelLeftOpen : PanelLeftClose}
            label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            testId="sidebar-collapse-toggle"
            onClick={() => setCollapsed((v) => !v)}
            collapsed={effectivelyCollapsed}
          />
        )}
        <SidebarAction
          icon={Info}
          label="Disclaimer"
          title={t("sidebar.footer_note")}
          testId="sidebar-footer-note"
          onClick={() => setDisclaimerOpen(true)}
          collapsed={effectivelyCollapsed}
        />
      </div>

      {/* Disclaimer modal — centered dialog with the full note. */}
      <Dialog open={disclaimerOpen} onOpenChange={setDisclaimerOpen}>
        <DialogContent className="max-w-[440px]" data-testid="sidebar-disclaimer-modal">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-[15px]">
              <Info size={15} strokeWidth={1.75} className="text-brand-d" />
              Disclaimer
            </DialogTitle>
            <DialogDescription className="pt-1 text-[13px] leading-relaxed text-ink-soft">
              {t("sidebar.footer_note")}
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
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
      {/* Identity is DISPLAY-ONLY since 2026-07-23 — navigation to the
          Workspace hub moved to the normal "Workspaces" rail item under
          Dashboard. This block just states which company + period is loaded. */}
      <div
        data-testid="sidebar-no-workspace"
        className="block rounded-lg px-2 py-1"
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
  end = false,
  trailing,
  disabled = false,
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
}) {
  const [params] = useSearchParams();
  const period = params.get("period");
  const href = period ? `${to}?period=${encodeURIComponent(period)}` : to;
  const prefetchPeriod = usePrefetchPeriod();
  const onHover = period ? () => prefetchPeriod(period) : undefined;

  // Disabled = same geometry as a resting link, but a non-interactive <div>:
  // dimmed, no pointer events, exposed as aria-disabled. Used when there's no
  // workspace yet so data-dependent destinations can't be opened.
  if (disabled) {
    return (
      <div
        data-testid={testId}
        aria-disabled="true"
        title={collapsed ? label : "Create a workspace first"}
        className="group relative flex items-center min-h-[44px] sm:min-h-0 sm:h-8 gap-3 px-[9px] rounded-lg border border-transparent text-[13px] text-ink-soft opacity-40 cursor-not-allowed select-none"
      >
        <Icon size={16} strokeWidth={1.75} className="relative z-10 shrink-0" />
        <span
          className={`relative z-10 whitespace-nowrap overflow-hidden transition-opacity duration-200 ${
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
        // Leaving a page with unapplied edits warns first (see
        // lib/unsavedGuard) — the settings tab reverts on unmount, and doing
        // that silently loses work the user thought was saved.
        if (!confirmLeaveUnsaved()) { e.preventDefault(); return; }
        onClick?.();
      }}
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
        // sm:h-8 — one fixed item height in BOTH rail modes; and one fixed
        // LAYOUT too: the collapsed rail keeps the exact same left padding
        // and alignment as expanded (no justify-center swap), so the icon
        // never moves an inch while the width animates — only the label
        // disappears. px-[9px] (not 10px): the 1px border pushes content
        // inward, so 9px inner padding puts icon centers on the SAME
        // 28px line as the borderless footer IconButtons. Mobile drawer
        // keeps the 44px touch target.
        `group relative flex items-center min-h-[44px] sm:min-h-0 sm:h-8 gap-3 px-[9px] rounded-lg border text-[13px] transition-all duration-150 ${
          isActive
            ? "ask-ai-anim-fill [animation:none] text-ink font-medium border-brand/40"
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
          {/* One constant icon size in BOTH rail modes — and shrink-0 so
              flex can NEVER compress the SVG while the rail's width
              animates (that compression is what read as the icons
              "getting smaller" during collapse). */}
          <Icon
            size={16}
            strokeWidth={1.75}
            className="relative z-10 shrink-0"
          />
          {/* Label stays MOUNTED in both modes and crossfades — an
              instant unmount is what made the collapse feel choppy.
              The aside's overflow-hidden clips it while the width
              animates; no ellipsis so the clip is clean. */}
          <span
            className={`relative z-10 whitespace-nowrap overflow-hidden transition-opacity duration-200 ${
              collapsed ? "opacity-0" : "opacity-100"
            }`}
          >
            {label}
          </span>
          {!collapsed && trailing && (
            <span className="relative z-10 ml-auto shrink-0 inline-flex items-center">
              {trailing}
            </span>
          )}
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
      // Mirrors SidebarLink's geometry exactly (fixed sm:h-8 height,
      // px-[9px] + transparent 1px border, mounted fading label) so
      // action rows sit on the same icon center line and transition as
      // smoothly as the nav links.
      className="
        group relative w-full text-left flex items-center
        min-h-[44px] sm:min-h-0 sm:h-8 gap-3 px-[9px]
        rounded-lg border border-transparent text-[13px]
        text-ink-soft hover:text-ink hover:bg-bg-2/70 active:bg-bg-2/50
        transition-all duration-150
      "
    >
      <Icon size={16} strokeWidth={1.75} className="relative z-10 shrink-0" />
      <span
        className={`relative z-10 whitespace-nowrap overflow-hidden transition-opacity duration-200 ${
          collapsed ? "opacity-0" : "opacity-100"
        }`}
      >
        {label}
      </span>
    </button>
  );
}

/**
 * Month stepper for the sidebar rail — prev/next arrows around the active
 * month, cycling this workspace's uploaded periods (newest-first).
 * `?period=<id>` is the app-wide active-period key, so stepping it re-scopes
 * every tab at once; startPeriodSwitch() covers the app while that happens.
 *
 * Relocated from TopHeader — same behavior, including the looping ends
 * (stepping back from the oldest month lands on the newest and vice versa).
 * With no period loaded it shows a "No period" placeholder in the same slot
 * (2026-07-26 per operator) — an empty gap read as a layout bug, and the
 * placeholder tells a fresh workspace what's missing.
 */
function SidebarMonthStepper() {
  const period = useActivePeriod();
  const [params, setParams] = useSearchParams();
  const { data: periodsData } = useOrgPeriods();
  // Empty periods too (2026-07-26 per operator) — the engine feed above only
  // knows analyzed periods, so a container created in the Workspace tab with
  // no file yet would be invisible here. Merge in the direct Supabase feed
  // (same ["org-periods", orgId] cache the Workspace tab populates, so a
  // just-created period appears without an extra request).
  const { org } = useActiveOrg();
  const { data: directData } = useQuery({
    queryKey: ["org-periods", org?.id],
    queryFn: () => fetchWorkspacePeriodsDirect(org!.id),
    enabled: !!org?.id,
    staleTime: 60_000,
  });
  const periods = useMemo<OrgPeriod[]>(() => {
    const engine = periodsData?.periods ?? [];
    const seen = new Set(engine.map((p) => p.period_id));
    const extras = (directData?.periods ?? []).filter((p) => !seen.has(p.period_id));
    return [...engine, ...extras].sort((a, b) =>
      (b.period_end ?? "").localeCompare(a.period_end ?? ""),
    );
  }, [periodsData, directData]);

  // `?period=<id>` is the app-wide SELECTION key, so it wins here (2026-07-26
  // per operator: the sidebar showed a different month than the selected
  // period). It used to be the other way around — the resolved analysis period
  // took precedence — which is wrong whenever the two disagree: selecting a
  // month with no analysis yet (an empty container, or one still processing)
  // leaves `useActivePeriod` pointing at the last month that DID resolve, so
  // the rail confidently displayed a month the user hadn't selected.
  // `useActivePeriod` stays as the fallback for a bare URL.
  const selectedId = params.get("period") ?? period.id ?? null;
  const listMatch = selectedId
    ? periods.find((p) => p.period_id === selectedId) ?? null
    : null;
  const selectedMonth = listMatch
    ? formatPeriodMonth(listMatch.period_end)
    // Not in the list (a sample/demo id, or the list hasn't loaded yet) — the
    // resolved period can still name it, but only when it IS the selected one.
    : selectedId && period.id === selectedId
      ? formatPeriodMonth(period.periodEnd)
      // A selected id we can't resolve names no month: better the
      // current-month fallback below than another period's date.
      : selectedId
        ? null
        : periods[0]
          ? formatPeriodMonth(periods[0].period_end)
          : null;
  const periodIdx = selectedId
    ? periods.findIndex((p) => p.period_id === selectedId)
    : -1;
  // Newest-first ordering: the OLDER month is further down the list.
  const olderPeriod = periodIdx >= 0 && periodIdx < periods.length - 1 ? periods[periodIdx + 1] : null;
  const newerPeriod = periodIdx > 0 ? periods[periodIdx - 1] : null;
  const prevTarget = olderPeriod ?? periods[0] ?? null;
  const nextTarget = newerPeriod ?? periods[periods.length - 1] ?? null;
  const showStepper = periods.length >= 2;

  // Nothing loaded yet — show the CURRENT month rather than "No period"
  // (2026-07-26 per operator). Every workspace keeps a permanent current-month
  // period, so this is the month the app is about to land on anyway; naming it
  // is both accurate and a better answer than a placeholder. Muted a step
  // further than a real selection so it still reads as "nothing loaded".
  if (!selectedMonth) {
    return (
      <div data-testid="sidebar-month-stepper" className="px-0.5">
        <div className="flex items-center gap-1">
          <span
            data-testid="sidebar-month-current-fallback"
            className="min-w-0 flex-1 text-center font-mono text-[11px] uppercase tracking-[0.14em] font-semibold text-ink-mute/70"
          >
            {formatPeriodMonth(currentMonthEnd())}
          </span>
        </div>
      </div>
    );
  }

  function goToPeriod(periodId: string) {
    // Not while an analysis is running — see lib/scanGuard.
    if (blockedByScan("period")) return;
    const target = periods.find((p) => p.period_id === periodId);
    startPeriodSwitch(formatPeriodMonth(target?.period_end) ?? undefined);
    const sp = new URLSearchParams(params);
    sp.set("period", periodId);
    // Replace, not push — month stepping is substitution; Back should leave
    // the page rather than replay every month stepped through.
    setParams(sp, { replace: true });
  }

  return (
    <div data-testid="sidebar-month-stepper" className="px-0.5">
      <div className="flex items-center gap-1">
        {showStepper && (
          <button
            type="button"
            onClick={() => prevTarget && goToPeriod(prevTarget.period_id)}
            aria-label="Previous month"
            title={`Previous month (${formatPeriodMonth(prevTarget?.period_end) ?? ""})`}
            data-testid="sidebar-prev-month"
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-mute hover:text-ink hover:bg-bg-2/70 transition-colors"
          >
            <ChevronLeft size={14} strokeWidth={2} />
          </button>
        )}
        <span className="min-w-0 flex-1 text-center font-mono text-[11px] uppercase tracking-[0.14em] font-semibold text-ink-soft truncate">
          {selectedMonth}
        </span>
        {showStepper && (
          <button
            type="button"
            onClick={() => nextTarget && goToPeriod(nextTarget.period_id)}
            aria-label="Next month"
            title={`Next month (${formatPeriodMonth(nextTarget?.period_end) ?? ""})`}
            data-testid="sidebar-next-month"
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-mute hover:text-ink hover:bg-bg-2/70 transition-colors"
          >
            <ChevronRight size={14} strokeWidth={2} />
          </button>
        )}
      </div>
    </div>
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
          between the expanded look (label + trailing hairline) and the
          collapsed look (plain divider). The old two-branch render
          swapped elements of different heights instantly, which is what
          made the collapse feel jumpy. */}
      <div className="relative h-[14px] mb-1">
        <div
          aria-hidden={collapsed}
          className={`absolute inset-y-0 left-2.5 right-2.5 flex items-center gap-2 transition-opacity duration-200 ${
            collapsed ? "opacity-0" : "opacity-100"
          }`}
        >
          <span className="shrink-0 whitespace-nowrap text-[9.5px] uppercase tracking-[0.16em] text-ink-mute font-semibold">
            {label}
          </span>
          <span aria-hidden className="h-px flex-1 bg-rule/60" />
        </div>
        <div
          aria-hidden
          className={`absolute left-2 right-2 top-1/2 h-px bg-rule/40 transition-opacity duration-200 ${
            collapsed ? "opacity-100" : "opacity-0"
          }`}
        />
      </div>
      <div className="space-y-2">{children}</div>
    </div>
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
