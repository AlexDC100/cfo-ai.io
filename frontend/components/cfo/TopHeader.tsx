// THE INSTRUMENT — the command deck header (Part C).
//
//   ┌──────────────────────────────────────────────────────────────────────┐
//   │ ☰ ◇  [CFO · Dec 2025 ▾]      [ Search or press ⌘K ]   ●Balanced ✦ RON▾ 🔔 ⓤ │
//   └──────────────────────────────────────────────────────────────────────┘
//
// 56px, hairline bottom rule. SOLID at rest; translucency + blur appear
// only once content actually scrolls beneath. Contents:
//   LEFT   — mobile hamburger · brand mark · ContextObject (workspace ·
//            period chip → switcher popover; the ?period UUID never shows)
//   CENTER — command bar placeholder opening the ⌘K palette
//   RIGHT  — TrustChip (served balance verdict → receipt) · engine-down
//            dot (only when down) · Ask CFO AI icon (⌘J; the big pill
//            moved into the palette) · currency · bell · avatar

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Menu, Search, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Logo } from "./Logo";
import { AccountMenu } from "./AccountMenu";
import { BackendStatusIndicator } from "./BackendStatusIndicator";
import { NotificationsMenu } from "./NotificationsMenu";
import { CurrencyMenu } from "./CurrencyMenu";
import { ContextObject } from "@/components/instrument/shell/ContextObject";
import { ModeSwitch } from "@/components/instrument/shell/ModeSwitch";
import { TrustChip } from "@/components/instrument/shell/TrustChip";
import { modKeyLabel } from "@/components/instrument/shell/shellI18n";
import "@/components/instrument/shell/shellI18n";
import { useBackendStatus } from "@/lib/useBackendStatus";
import { useAuth } from "@/lib/auth";

interface Props {
  onOpenAi: () => void;
  /** Mobile-only: opens the sidebar as a slide-over drawer. */
  onOpenSidebar: () => void;
  /** Open the ⌘K command palette. */
  onOpenPalette?: () => void;
  /** Click the account avatar → open the Command Center (instead of the
   *  legacy dropdown). */
  onOpenAccount?: () => void;
}

/** True once the page has scrolled past the hairline threshold — drives
 *  the solid→translucent switch (blur only when content is beneath). */
function useScrolled(threshold = 8): boolean {
  const [scrolled, setScrolled] = useState(
    typeof window !== "undefined" && window.scrollY > threshold,
  );
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > threshold);
    // Capture-phase on document so scrolls are caught regardless of which
    // element actually scrolls (window on most pages, inner containers on
    // /chat).
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    onScroll();
    return () => document.removeEventListener("scroll", onScroll, { capture: true });
  }, [threshold]);
  return scrolled;
}

export function TopHeader({ onOpenAi, onOpenSidebar, onOpenPalette, onOpenAccount }: Props) {
  const { t } = useTranslation();
  const { status, user } = useAuth();
  const navigate = useNavigate();
  const scrolled = useScrolled();
  // Engine status is diagnostic chrome — surface it only when something
  // is actually wrong. A permanently-green dot is noise.
  const backend = useBackendStatus();

  const signedIn = status === "signed_in" && !!user;
  const mod = modKeyLabel();

  return (
    <header
      // `inset-x-0` pins the bar to the scrollport's edges; the `after:`
      // strip bleeds the background over the scrollbar gutter. Solid at
      // rest — the blur class only mounts once content scrolls beneath,
      // so nothing shimmers on a still page.
      className={`
        fixed top-0 inset-x-0 z-40 h-14
        border-b border-rule-soft
        transition-colors duration-overlay
        ${scrolled ? "bg-[hsl(var(--bg)/0.85)] backdrop-blur-md" : "bg-bg"}
        after:content-[''] after:pointer-events-none
        after:absolute after:top-0 after:bottom-[-1px] after:left-full after:w-6
        after:bg-inherit
        after:border-b after:border-rule-soft
      `}
      style={{
        paddingLeft: "env(safe-area-inset-left)",
        paddingRight: "env(safe-area-inset-right)",
        paddingTop: "env(safe-area-inset-top)",
      }}
    >
      <div className="h-full px-3 sm:px-4 flex items-center gap-1.5 sm:gap-2">
        {/* Mobile hamburger — 44px touch target per Apple HIG */}
        <button
          onClick={onOpenSidebar}
          aria-label={t("topbar.openNav")}
          className="lg:hidden inline-flex items-center justify-center h-11 w-11 -ml-2 rounded-sm text-ink-soft hover:text-ink hover:bg-bg-2 active:bg-bg-2/70 transition-colors duration-micro"
        >
          <Menu size={20} strokeWidth={1.75} />
        </button>

        {/* Compact brand mark. Icon-only below `sm`. */}
        <button
          onClick={() => navigate("/dashboard")}
          className="flex items-center shrink-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t("topbar.goToDashboard")}
        >
          <span className="sm:hidden inline-flex"><Logo size={24} iconOnly /></span>
          <span className="hidden sm:inline-flex"><Logo size={24} iconOnly /></span>
        </button>

        {/* THE CONTEXT OBJECT — "Workspace · Period", opens the switcher.
            Hidden on phones (the drawer's account row + workspace hub own
            identity there); the popover is a desktop affordance. */}
        {signedIn && (
          <div className="hidden sm:block ml-1 min-w-0">
            <ContextObject />
          </div>
        )}

        {/* THE DIAL — Simple | Pro. Presentation only; the lib persists
            the choice. Desktop affordance like the ContextObject beside it
            (phones switch modes from Settings > Appearance). */}
        {signedIn && (
          <div className="hidden sm:block shrink-0 ml-1">
            <ModeSwitch />
          </div>
        )}

        {/* CENTER — command bar placeholder for the ⌘K palette. */}
        <div className="flex-1 flex justify-center px-2 min-w-0">
          {signedIn && onOpenPalette && (
            <button
              type="button"
              data-testid="header-command-bar"
              onClick={onOpenPalette}
              className="
                hidden md:flex h-8 w-full max-w-[400px] items-center gap-2
                rounded-sm border border-rule bg-bg-2/60 px-3
                text-[12.5px] text-ink-soft
                hover:bg-bg-2 hover:text-ink
                transition-colors duration-micro
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
              "
            >
              <Search size={13} strokeWidth={1.75} className="shrink-0" />
              <span className="flex-1 truncate text-left">
                {t("shell.palette.hint", { mod })}
              </span>
              <kbd className="shrink-0 rounded-sm border border-rule bg-bg px-1.5 py-px font-mono text-[10px] text-ink-soft">
                {mod}K
              </kbd>
            </button>
          )}
        </div>

        {/* RIGHT CLUSTER */}

        {/* Trust — the served balance verdict for the active period.
            Renders nothing without a canonical envelope (no fake trust). */}
        {signedIn && (
          <div className="hidden md:block shrink-0">
            <TrustChip />
          </div>
        )}

        {/* Engine-down indicator only. */}
        {backend === "disconnected" && <BackendStatusIndicator />}

        {/* Mobile: the palette is still one tap away. */}
        {signedIn && onOpenPalette && (
          <button
            type="button"
            onClick={onOpenPalette}
            aria-label={t("common.search")}
            className="md:hidden inline-flex items-center justify-center h-9 w-9 rounded-sm text-ink-soft hover:text-ink hover:bg-bg-2 transition-colors duration-micro"
          >
            <Search size={16} strokeWidth={1.75} />
          </button>
        )}

        {/* Ask CFO AI — quiet icon entry (the pill moved into the palette;
            ⌘J is the fast path). Keeps the testid and aria-label. */}
        {signedIn && (
          <button
            type="button"
            onClick={onOpenAi}
            data-testid="topheader-ask-cfo-ai"
            aria-label={t("topbar.askCfoAi")}
            title={`${t("topbar.askCfoAi")} (${mod}J)`}
            className="
              hidden sm:inline-flex items-center gap-1.5 h-8 px-3
              rounded-md bg-brand text-paper text-[12.5px] font-semibold
              hover:bg-brand-dark
              transition-colors duration-micro
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1
            "
          >
            <Sparkles size={14} strokeWidth={2} />
            {/* Labeled, not icon-only: the subtle glyph was invisible to
                the operator ("main function, hard to see", 2026-08-29). */}
            <span className="hidden md:inline">{t("topbar.askCfoAi")}</span>
          </button>
        )}

        {/* Compact currency dropdown — active code only. */}
        {signedIn && <CurrencyMenu />}

        {/* Notifications bell — desktop only (on phones the bell lives
            inside the nav sheet). */}
        {signedIn && (
          <div className="hidden sm:inline-flex">
            <NotificationsMenu />
          </div>
        )}

        {/* Avatar — the account menu hosts Learning mode, Billing,
            Settings and sign-out. */}
        {signedIn ? (
          <AccountMenu onOpen={onOpenAccount} />
        ) : (
          <button
            onClick={() => navigate("/login")}
            className="ml-1 inline-flex items-center h-9 px-3 rounded-sm font-mono text-[11.5px] uppercase tracking-[0.14em] text-ink-soft hover:text-ink hover:bg-bg-2 transition-colors duration-micro"
          >
            {t("topbar.signIn")}
          </button>
        )}
      </div>
    </header>
  );
}
