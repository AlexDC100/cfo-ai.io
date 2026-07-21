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
import { DocumentChip } from "./DocumentChip";
import { CurrencyToggle } from "./CurrencyToggle";
import { LanguageToggle } from "./LanguageToggle";
import { LearningHubMenu } from "@/components/learning/LearningHubMenu";
import { useAuth } from "@/lib/auth";
import { useWorkspaceName } from "@/lib/workspaceName";

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
  const navigate = useNavigate();

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
        <div className="hidden sm:flex items-center gap-2.5 pl-3 border-l border-rule h-[22px]">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute truncate max-w-[180px]">
            {workspaceName || workspaceLabel || "Financial Intelligence"}
          </span>
        </div>

        <div className="flex-1" />

        {/* Active-document chip — visible across all pages so the user
            always knows which document is being analysed / has been
            analysed. Reads from the global uploadStore so the chip
            survives navigation and page refresh. Renders nothing when
            no upload is in flight. */}
        {status === "signed_in" && user && <DocumentChip />}

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
