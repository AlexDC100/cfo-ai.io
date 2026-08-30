// THE INSTRUMENT — the command deck header (Part C).
//
//   ┌──────────────────────────────────────────────────────────────────┐
//   │ ☰ ◇        [ ● CFO · Dec 2025            🔍 ⌘K ]        🔔 ⓤ    │
//   └──────────────────────────────────────────────────────────────────┘
//
// THE LAW (2026-08-30, owner directive): the desktop header holds
// EXACTLY FOUR interactive elements — brand mark · THE CAPSULE ·
// notifications · avatar. No text labels outside the Capsule.
//
// What left the header, and where it went:
//   · "Balanced · machine-computed" TEXT  -> the Capsule's 7px status
//     dot; the full sentence rides aria-label/title and the unchanged
//     receipt sheet, so no trust information was lost — only its width.
//   · "Ask CFO AI" button -> the sidebar's accent row + ⌘J + the palette.
//   · Currency (EUR/RON)  -> avatar quick-settings + Settings.
//   · Simple|Pro dial     -> avatar quick-settings.
// The Capsule itself opens the ⌘K palette, which already carries recent
// periods, workspace switching and the actions those controls used to
// occupy header space for.
//
// 56px, hairline bottom rule. SOLID at rest; translucency + blur appear
// only once content actually scrolls beneath.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Menu, Search } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Logo } from "./Logo";
import { AccountMenu } from "./AccountMenu";
import { BackendStatusIndicator } from "./BackendStatusIndicator";
import { NotificationsMenu } from "./NotificationsMenu";
import { ModeSwitch, useViewModeSync } from "@/components/instrument/shell/ModeSwitch";
import { TrustChip } from "@/components/instrument/shell/TrustChip";
import { useCapsuleLabel } from "@/components/instrument/shell/ContextObject";
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

// onOpenAi stays in Props (AppShell still passes it) but is no longer
// destructured: Ask CFO AI left the header for the sidebar + ⌘J + the
// palette, so the header no longer owns that entry point.
export function TopHeader({ onOpenSidebar, onOpenPalette, onOpenAccount }: Props) {
  const { t } = useTranslation();
  const { status, user } = useAuth();
  const navigate = useNavigate();
  const scrolled = useScrolled();
  // Engine status is diagnostic chrome — surface it only when something
  // is actually wrong. A permanently-green dot is noise.
  const backend = useBackendStatus();
  // The Simple|Pro dial moved into the avatar menu, whose content only
  // mounts while open — so its cross-device sync is seated here, where
  // it is always mounted on every authed screen.
  useViewModeSync();
  const capsuleLabel = useCapsuleLabel();

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

        {/* THE DIAL — Simple | Pro. Restored to the header by owner
            directive (2026-08-30): it had been relocated to the avatar
            menu under the 4-element law, and the owner wanted it back
            in sight ("it was a nice touch"). It ALSO stays in the
            avatar menu + Settings, which is what keeps it reachable on
            phones where this instance is hidden. The header budget is
            therefore 5, not 4 — recorded as an owner amendment in
            design_review/header/GATES.md rather than silently bent. */}
        {signedIn && (
          <div className="hidden md:block shrink-0 ml-1">
            <ModeSwitch />
          </div>
        )}

        {/* ── THE CAPSULE ────────────────────────────────────────────
            One pill: status dot · workspace · period · search · ⌘K.
            The pill opens the palette; the dot opens the trust receipt
            (kept as its own control so the verdict stays one tap away —
            the spec's "view receipt" row lives in the palette's context
            zone, and this is the same destination, closer). */}
        <div className="flex-1 flex justify-center px-2 min-w-0">
          {signedIn && (
            <div
              data-testid="header-capsule"
              className="
                group flex h-9 w-full max-w-[560px] items-center gap-2
                rounded-full border border-rule bg-bg-2/60 pl-3 pr-2
                transition-colors duration-micro
                focus-within:border-brand/40 hover:bg-bg-2
              "
            >
              {/* Trust verdict — dot only. Renders nothing when the
                  active period carries no canonical envelope. */}
              <TrustChip variant="dot" />

              {/* Workspace · period. Formatted labels only — the
                  ?period UUID never reaches the DOM (D11). */}
              <button
                type="button"
                data-testid="header-command-bar"
                onClick={onOpenPalette}
                className="
                  flex flex-1 items-center gap-2 min-w-0 h-full rounded-full
                  text-left focus-visible:outline-none
                  focus-visible:ring-2 focus-visible:ring-ring
                "
                aria-label={t("common.search")}
                title={`${t("common.search")} (${mod}K)`}
              >
                <span className="flex-1 truncate text-[12.5px] text-ink-soft group-hover:text-ink">
                  {capsuleLabel}
                </span>
                <Search size={13} strokeWidth={1.75} className="shrink-0 text-ink-mute" />
                <kbd className="hidden sm:inline shrink-0 rounded-sm border border-rule bg-bg px-1.5 py-px font-mono text-[10px] text-ink-soft">
                  {mod}K
                </kbd>
              </button>
            </div>
          )}
        </div>

        {/* RIGHT CLUSTER */}

        {/* Engine-down indicator only. */}
        {backend === "disconnected" && <BackendStatusIndicator />}

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
