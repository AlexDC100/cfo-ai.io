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

import { useNavigate } from "react-router-dom";
import { Menu } from "lucide-react";
import { Logo } from "./Logo";
import { AccountMenu } from "./AccountMenu";
import { useAuth } from "@/lib/auth";

interface Props {
  onOpenAi: () => void;
  /** Mobile-only: opens the sidebar as a slide-over drawer. */
  onOpenSidebar: () => void;
}

export function TopHeader({ onOpenAi, onOpenSidebar }: Props) {
  // May 2026 redesign — the inline dropdown was replaced by <AccountMenu/>
  // which carries the THE single sign-out (sign-out moved here from the
  // Sidebar System group). The `onOpenAi` prop is unused at runtime today
  // (the TopHeader Ask CFO AI pill was removed earlier per directive) but
  // kept on the interface so a future re-introduction is a one-line JSX
  // restore, not a propagating type change.
  void onOpenAi;
  const { status, user, workspaceLabel } = useAuth();
  const navigate = useNavigate();

  return (
    <header
      className="
        fixed top-0 inset-x-0 z-40 h-16
        bg-[hsl(var(--surface)/0.86)]
        backdrop-blur-md
        border-b border-rule
      "
    >
      <div className="h-full px-4 sm:px-6 flex items-center gap-3">
        {/* Mobile hamburger */}
        <button
          onClick={onOpenSidebar}
          aria-label="Open navigation"
          className="lg:hidden inline-flex items-center justify-center h-9 w-9 rounded-md text-ink-soft hover:text-ink hover:bg-bg-2 transition-colors"
        >
          <Menu size={17} strokeWidth={1.75} />
        </button>

        {/* Brand + workspace label */}
        <button
          onClick={() => navigate("/dashboard")}
          className="flex items-center gap-3 shrink-0"
          aria-label="Go to dashboard"
        >
          <Logo size={26} compact />
        </button>
        <div className="hidden sm:flex items-center gap-2.5 pl-3 border-l border-rule h-7">
          <span className="text-[11px] uppercase tracking-[0.14em] text-ink-mute font-medium truncate max-w-[180px]">
            {workspaceLabel ?? "Financial Intelligence"}
          </span>
        </div>

        <div className="flex-1" />

        {/* Ask CFO AI pill removed from TopHeader per the operator's
            directive. The contextual launchers remain:
              · Command Center → Workspace tab → Quick actions
              · In-page chips (e.g. /benchmark, /financials) that fire
                the OPEN_ASK_CFO_AI_EVENT and AppShell catches it
              · The /chat page is still reachable directly
            The `onOpenAi` prop is kept on TopHeader so future reverts
            are a one-line JSX restore. AppShell still passes a real
            handler today. */}

        {/* Bell removed per the operator's directive. The previous
            implementation was a visible-but-dead control (no onClick,
            no popover, no badge) — a trust killer for a CFO product.
            A real Notification Center is a future scoped task. Until
            then, no bell at all is better than a placebo bell.
            See diagnostics-trail / the header-cleanup brief. */}

        {/* Command Center trigger was removed from the top-right header.
            It now lives in the sidebar's System group, directly below
            Settings (`data-testid="sidebar-command-center"`). Single
            entry point per the relocation directive. */}

        {/* Account menu — single source of truth for sign-out (May 2026
            redesign). All the prior inline dropdown items moved into
            <AccountMenu/> together with the plan status chip, usage
            preview, theme toggle, and a Privacy entry marked
            "Coming soon" until a Privacy route ships. Unauthed visitors
            still see a plain "Sign in" link below. */}
        {status === "signed_in" && user ? (
          <AccountMenu />
        ) : (
          <button
            onClick={() => navigate("/login")}
            className="ml-1 inline-flex items-center h-9 px-3 rounded-md text-[13px] font-medium text-ink-soft hover:text-ink hover:bg-bg-2 transition-colors"
          >
            Sign in
          </button>
        )}
      </div>
    </header>
  );
}
