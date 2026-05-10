// Persistent left sidebar — clean workflow nav only.
//
// 240px wide on lg+, hidden on smaller screens (mobile gets the same
// content via a slide-over drawer triggered by the TopHeader hamburger).
//
// Five workflow routes only — every other admin/management action lives
// inside the Command Center (the ⋮ icon in the top header) and is
// reachable from the icon shortcuts in the sidebar footer:
//
//   ● ☼ light/dark   ↑ upload data   ⚙ settings
//
// Keeping the surface narrow makes navigation feel calm and product-led
// rather than admin-led.

import { ReactNode, useEffect, useState } from "react";
import { NavLink, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useTheme } from "next-themes";
import {
  LayoutDashboard,
  Wallet,
  TrendingUp,
  ClipboardCheck,
  PackageSearch,
  Bell,
  Settings as SettingsIcon,
  Sun,
  Moon,
  type LucideIcon,
} from "lucide-react";

interface Props {
  onSettings: () => void;
  /** Drawer mode — closes the slide-over after a click on mobile. */
  inDrawer?: boolean;
  onItemClick?: () => void;
}

// Locked sidebar order — UNIFY prompt: Financial Statements merged into
// Dashboard. Seven items. Labels come from i18n so a German user sees
// "Übersicht" / "Liquidität" / "Gewinn" etc.; the to/icon/testId stay
// stable so deep links + tests keep working across languages.
interface WorkflowItem { to: string; labelKey: string; icon: LucideIcon; testId: string }
const WORKFLOW: WorkflowItem[] = [
  { to: "/dashboard", labelKey: "sidebar.dashboard", icon: LayoutDashboard, testId: "sidebar-dashboard" },
  { to: "/cash",      labelKey: "sidebar.cash",      icon: Wallet,          testId: "sidebar-cash" },
  { to: "/profit",    labelKey: "sidebar.profit",    icon: TrendingUp,      testId: "sidebar-profit" },
  { to: "/products",  labelKey: "sidebar.products",  icon: PackageSearch,   testId: "sidebar-products" },
  { to: "/decisions", labelKey: "sidebar.decisions", icon: ClipboardCheck,  testId: "sidebar-decisions" },
  { to: "/alerts",    labelKey: "sidebar.alerts",    icon: Bell,            testId: "sidebar-alerts" },
  { to: "/settings",  labelKey: "sidebar.settings",  icon: SettingsIcon,    testId: "sidebar-settings" },
];

export function Sidebar({
  onSettings: _onSettings,
  inDrawer = false,
  onItemClick,
}: Props) {
  const { t } = useTranslation();
  return (
    <aside
      className={`
        ${inDrawer ? "" : "hidden lg:block fixed left-0 top-16 bottom-0 z-30"}
        w-[240px]
        bg-bg-2/40
        border-r border-rule
        flex flex-col
      `}
    >
      <nav className="flex-1 overflow-y-auto px-3 py-5">
        <Section label={t("sidebar.workflow")}>
          {WORKFLOW.map(({ to, labelKey, icon: Icon, testId }) => (
            <SidebarLink key={to} to={to} testId={testId} onClick={onItemClick} icon={Icon} label={t(labelKey)} />
          ))}
        </Section>
      </nav>

      {/* Footer — theme toggle + AI disclosure. Upload entry points live on
          Dashboard (empty-state zone + Replace dropdown). The sidebar
          previously had an "Upload data" icon here; removed in the upload
          consolidation pass — duplicating an action that's already
          contextually surfaced on the page the user is on creates noise. */}
      <div className="px-3 pt-3 pb-4 border-t border-rule">
        <div className="flex items-center gap-1 mb-3">
          <ThemeIconButton />
        </div>
        <p className="px-2 text-[10.5px] text-ink-mute leading-snug">
          {t("sidebar.footer_note")}
        </p>
      </div>
    </aside>
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
}: {
  to: string;
  testId: string;
  onClick?: () => void;
  icon: LucideIcon;
  label: string;
}) {
  const [params] = useSearchParams();
  const period = params.get("period");
  const href = period ? `${to}?period=${encodeURIComponent(period)}` : to;
  return (
    <NavLink
      to={href}
      data-testid={testId}
      onClick={onClick}
      // Active match keys off the pathname only — query param differences
      // (?period=eei vs none) shouldn't affect the highlight.
      end={false}
      className={({ isActive }) =>
        `flex items-center gap-3 rounded-xl px-3 py-2 text-[13.5px] transition-colors ${
          isActive
            ? "bg-brand-tint text-ink font-medium [&>svg]:text-brand-d"
            : "text-ink-soft hover:text-ink hover:bg-bg-2 [&>svg]:text-ink-mute"
        }`
      }
    >
      <Icon size={15} strokeWidth={1.75} />
      {label}
    </NavLink>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="px-3 mb-1.5 text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium">
        {label}
      </div>
      <div className="space-y-0.5">{children}</div>
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
