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
import { Menu, Sparkles } from "lucide-react";
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
  // which carries THE single sign-out. The "Ask CFO AI" pill is restored
  // here per the operator's directive (May 2026 follow-up): it sits
  // immediately to the left of the avatar, matching the reference image
  // (an "Ask AI" pill + a small AC initials circle). Clicking it fires
  // the same OPEN_ASK_CFO_AI_EVENT path that AppShell wires today.
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
              inline-flex items-center gap-1.5
              h-9 px-3 rounded-full
              bg-brand-tint text-brand-d
              hover:bg-brand-tint/80
              text-[12.5px] font-medium
              transition-colors
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40
            "
          >
            <Sparkles size={13} strokeWidth={1.75} />
            <span className="hidden sm:inline">Ask CFO AI</span>
          </button>
        )}

        {/* Account menu — single source of truth for sign-out (May 2026
            redesign). The trigger is a compact initials circle (no
            trailing name text); the full name + email live inside the
            dropdown. Unauthed visitors still see a plain "Sign in"
            link below. */}
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
