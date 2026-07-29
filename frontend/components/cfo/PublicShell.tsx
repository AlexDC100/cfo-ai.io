// PublicShell — minimal chrome for routes that anonymous visitors can reach
// without signing in. Used by /public-companies so the "no signup · 10s"
// landing-page promise is literally true: the visitor clicks a ticker
// chip, lands here, sees the snapshot. No sidebar, no app navigation —
// just a slim header with Sign in / Get started CTAs in case they want
// to convert to the full product.
//
// Why not just reuse AppShell? AppShell is built around the authenticated
// product surface: persistent left sidebar full of `/dashboard`, `/products`,
// `/decisions` etc. links, an organisation switcher, an account menu with
// sign-out. Showing all of that to an unauthenticated visitor is both
// confusing (they can't click those links) and noisy (the sidebar would
// dominate the page they came to see). PublicShell strips it down to the
// product's brand + the two conversion CTAs.
//
// Authenticated visitors who land on /public-companies still get the full
// AppShell — the page picks the shell at render time based on
// `useAuth().isAuthenticated`. See `PublicCompanyIntelligence.tsx`.

import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { Logo } from "@/components/cfo/Logo";

interface Props {
  children: React.ReactNode;
}

export function PublicShell({ children }: Props) {
  return (
    <div className="min-h-screen bg-bg text-ink">
      <header
        data-testid="public-shell-header"
        className="
          sticky top-0 z-40
          bg-[hsl(var(--bg)/0.72)] backdrop-blur-[18px]
          border-b border-rule-soft
        "
      >
        <div className="mx-auto max-w-[1280px] px-5 sm:px-8 h-16 flex items-center gap-6">
          {/* Brand — links back to landing so the visitor can always exit. */}
          <Link to="/" className="flex items-center gap-3 shrink-0">
            <Logo size={26} compact />
            <span className="hidden sm:inline-flex font-mono text-[10.5px] uppercase tracking-[0.18em] text-ink-soft pl-3 border-l border-rule h-6 items-center">
              Financial Intelligence
            </span>
          </Link>

          <div className="flex-1" />

          <Link
            to="/login"
            className="
              hidden sm:inline-flex items-center
              font-mono text-[11.5px] uppercase tracking-[0.14em]
              text-ink-soft hover:text-ink transition-colors
            "
          >
            Sign in
          </Link>

          <Link
            to="/signup?plan=trial"
            data-testid="public-shell-get-started"
            className="
              inline-flex items-center gap-1.5
              h-9 px-4 rounded-full
              bg-gradient-cfo text-white
              text-[13px] font-medium
              shadow-1 hover:shadow-2
              transition-shadow
            "
          >
            Get started — free
            <ArrowRight size={13} strokeWidth={2.25} />
          </Link>
        </div>
      </header>

      <main>{children}</main>
    </div>
  );
}
