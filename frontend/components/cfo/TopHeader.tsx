// Fixed top header — Apple-slim bar (2026-08-04 redesign, per operator).
//
//   ┌──────────────────────────────────────────────────────────────────┐
//   │ ☰ ◇  ‹ DEC 2025 ›                 [Ask CFO AI] RON▾  🔔  ⓤ      │
//   └──────────────────────────────────────────────────────────────────┘
//
// 56px tall, frosted blur at the top of the page, near-solid once the
// page scrolls (150ms fade). Contents, exactly:
//   LEFT  — mobile hamburger · logo · period breadcrumb with prev/next
//   RIGHT — ONE primary accent button (Ask CFO AI) · compact currency
//           dropdown (active code only) · notifications bell · avatar
// Everything else that used to live here moved out: the workspace name
// (sidebar owns workspace identity), "Learn · <mode>" (now inside the
// avatar menu), the language toggle (language now changes ONLY in
// Settings), and the always-on backend dot (renders only when the engine
// is actually unreachable — a green dot was permanent chrome).

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Menu, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Logo } from "./Logo";
import { AccountMenu } from "./AccountMenu";
import { BackendStatusIndicator } from "./BackendStatusIndicator";
import { NotificationsMenu } from "./NotificationsMenu";
import { CurrencyMenu } from "./CurrencyMenu";
import { useBackendStatus } from "@/lib/useBackendStatus";
import { useAuth } from "@/lib/auth";

interface Props {
  onOpenAi: () => void;
  /** Mobile-only: opens the sidebar as a slide-over drawer. */
  onOpenSidebar: () => void;
  /** Click the account avatar → open the Command Center (instead of the
   *  legacy dropdown). */
  onOpenAccount?: () => void;
}

/** True once the page has scrolled past the hairline threshold — drives
 *  the frosted→solid background fade. */
function useScrolled(threshold = 8): boolean {
  const [scrolled, setScrolled] = useState(
    typeof window !== "undefined" && window.scrollY > threshold,
  );
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > threshold);
    // Capture-phase on document so scrolls are caught regardless of which
    // element actually scrolls (window on most pages, inner containers on
    // /chat) — a plain window listener missed programmatic scrolls in
    // some environments.
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    onScroll();
    return () => document.removeEventListener("scroll", onScroll, { capture: true });
  }, [threshold]);
  return scrolled;
}

export function TopHeader({ onOpenAi, onOpenSidebar, onOpenAccount }: Props) {
  const { t } = useTranslation();
  const { status, user } = useAuth();
  const navigate = useNavigate();
  const scrolled = useScrolled();
  // Engine status is diagnostic chrome — surface it only when something
  // is actually wrong. A permanently-green dot is noise.
  const backend = useBackendStatus();

  const signedIn = status === "signed_in" && !!user;

  return (
    <header
      // `inset-x-0` pins the bar to the scrollport's edges; the `after:`
      // strip bleeds the background over the scrollbar gutter (see the
      // pre-redesign header for the full rationale — behavior kept).
      className={`
        fixed top-0 inset-x-0 z-40 h-14
        backdrop-blur-[18px]
        border-b border-rule-soft
        transition-colors duration-150
        ${scrolled ? "bg-[hsl(var(--bg)/0.92)]" : "bg-[hsl(var(--bg)/0.66)]"}
        after:content-[''] after:pointer-events-none
        after:absolute after:top-0 after:bottom-[-1px] after:left-full after:w-6
        after:bg-inherit after:backdrop-blur-[18px]
        after:border-b after:border-rule-soft
      `}
      style={{
        paddingLeft: "env(safe-area-inset-left)",
        paddingRight: "env(safe-area-inset-right)",
        paddingTop: "env(safe-area-inset-top)",
      }}
    >
      <div className="h-full px-3 sm:px-5 flex items-center gap-1.5 sm:gap-2">
        {/* Mobile hamburger — 44px touch target per Apple HIG */}
        <button
          onClick={onOpenSidebar}
          aria-label={t("topbar.openNav")}
          className="lg:hidden inline-flex items-center justify-center h-11 w-11 -ml-2 rounded-md text-ink-soft hover:text-ink hover:bg-bg-2 active:bg-bg-2/60 transition-colors duration-150"
        >
          <Menu size={20} strokeWidth={1.75} />
        </button>

        {/* Icon-only mark below `sm` — the wordmark + breadcrumb + right
            cluster don't all fit in 375px; the mark alone keeps the brand
            without costing the period context. */}
        <button
          onClick={() => navigate("/dashboard")}
          className="flex items-center gap-2.5 shrink-0 mr-1"
          aria-label={t("topbar.goToDashboard")}
        >
          <span className="sm:hidden inline-flex"><Logo size={24} iconOnly /></span>
          <span className="hidden sm:inline-flex"><Logo size={24} compact /></span>
        </button>

        {/* Period breadcrumb REMOVED (2026-08-04 per operator, mobile
            screenshot with a corrupt "MAR. 5309" period): the header
            carries no period context at all now. Month navigation lives
            in the sidebar rail; the PeriodBreadcrumb component stays
            available for reuse if this is ever reversed. */}

        {/* Engine-down indicator only. */}
        {backend === "disconnected" && <BackendStatusIndicator />}

        <div className="flex-1" />

        {/* THE primary action — desktop only since the native-mobile pass:
            the phone header is hamburger · logo · currency · avatar, nothing
            else. Ask CFO AI stays one tap away in the nav sheet + sidebar. */}
        {signedIn && (
          <button
            type="button"
            onClick={onOpenAi}
            data-testid="topheader-ask-cfo-ai"
            aria-label={t("topbar.askCfoAi")}
            className="
              hidden sm:inline-flex items-center justify-center gap-1.5
              h-9 px-4 rounded-full
              bg-brand text-paper text-[12.5px] font-semibold
              hover:bg-brand-d active:scale-[0.98]
              shadow-[0_6px_16px_-8px_rgba(92,211,197,0.7)]
              transition-[background-color,transform] duration-150
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40
            "
          >
            <Sparkles size={14} strokeWidth={2} />
            <span>{t("topbar.askCfoAi")}</span>
          </button>
        )}

        {/* Compact currency dropdown — active code only. */}
        {signedIn && <CurrencyMenu />}

        {/* Notifications bell — desktop only (native-mobile pass: on
            phones the bell lives inside the nav sheet; the header keeps
            just currency + avatar on the right). */}
        {signedIn && (
          <div className="hidden sm:inline-flex">
            <NotificationsMenu />
          </div>
        )}

        {/* Avatar — the account menu now also hosts the Learning-mode
            picker (moved out of the bar 2026-08-04). */}
        {signedIn ? (
          <AccountMenu onOpen={onOpenAccount} />
        ) : (
          <button
            onClick={() => navigate("/login")}
            className="ml-1 inline-flex items-center h-9 px-3 rounded-md font-mono text-[11.5px] uppercase tracking-[0.14em] text-ink-soft hover:text-ink hover:bg-bg-2 transition-colors duration-150"
          >
            {t("topbar.signIn")}
          </button>
        )}
      </div>
    </header>
  );
}
