// THE INSTRUMENT — the command deck header (Part C · Part E).
//
//   ≥1024   ┌──────────────────────────────────────────────────────────┐
//           │ ◇        [ ● CFO · Dec 2025          🔍 ⌘K ]      🔔 ⓤ  │
//           └──────────────────────────────────────────────────────────┘
//   <1024   ┌──────────────────────────────────────────────────────────┐
//           │ ☰        [ ● CFO · Dec 2025               🔍 ]        ⓤ  │
//           └──────────────────────────────────────────────────────────┘
//
// THE LAW (2026-08-30, owner directive, Part E): the desktop header holds
// EXACTLY FOUR interactive elements — brand mark · THE CAPSULE ·
// notifications · avatar. Below `lg` it holds EXACTLY THREE: the nav
// hamburger takes the left slot (the brand mark is `lg:flex` — two
// left-hand controls on the narrowest screen was the duplication), and
// the bell folds into the avatar, whose badge mirrors the unread count.
// No text labels outside the Capsule.
//
// What left the header, and where it went:
//   · "Balanced · machine-computed" TEXT  -> the Capsule's 7px status
//     dot; the full sentence rides aria-label/title and the unchanged
//     receipt sheet, so no trust information was lost — only its width.
//   · "Ask CFO AI" button -> the sidebar's accent row + ⌘J + the palette.
//   · Currency (EUR/RON)  -> avatar quick-settings + Settings.
//   · Simple|Pro dial     -> avatar quick-settings + Settings + the ⌘K
//     palette action (see MODE_PALETTE_ACTION in ModeSwitch.tsx). It was
//     briefly restored to the bar on 2026-08-30 and is out again under
//     Part E: it is the one control here that is NOT needed on every
//     screen of every session, and it was the fifth element. A one-time
//     coach mark (below) tells returning users where it went.
//   · Bell (<1024 only)   -> the avatar menu's Notifications row, with
//     the unread count mirrored onto the avatar itself.
// The Capsule opens the ⌘K palette, which already carries recent
// periods, workspace switching and the actions those controls used to
// occupy header space for.
//
// 56px, hairline bottom rule. SOLID at rest; translucency + blur appear
// only once content actually scrolls beneath.

import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
// Sparkles, not Search: the same glyph the surface this trigger
// opens uses for its ask affordance. A magnifier promised a
// different product from the one behind the button.
import { Menu, Sparkles, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Logo } from "./Logo";
import { AccountMenu } from "./AccountMenu";
import { BackendStatusIndicator } from "./BackendStatusIndicator";
import { NotificationsMenu } from "./NotificationsMenu";
import { useViewModeSync } from "@/components/instrument/shell/ModeSwitch";
import { TrustChip } from "@/components/instrument/shell/TrustChip";
import { useCapsuleLabel } from "@/components/instrument/shell/ContextObject";
import { modKeyLabel } from "@/components/instrument/shell/shellI18n";
import "@/components/instrument/shell/shellI18n";
import "./headerI18n";
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

// ─────────────────────────────────────────────────────────────────────
// THE RELOCATION COACH MARK
//
// One-time, Escape-dismissible, never re-shown once dismissed (gate H6
// arms itself on it). Deliberately narrow in who sees it:
//
//   · it is PORTALED TO <body>, never rendered inside <header> — a hint
//     about a control is not a header control, and the H1 census must
//     not have to special-case it away. Wrapper is pointer-events-none;
//     only the card itself takes clicks, at z-30 (under the header's
//     z-40 and under every Radix portal), so it cannot swallow a click
//     meant for the avatar menu it points at.
//   · IT IS ANCHORED TO THE AVATAR IT IS ABOUT (craft pass). It used to
//     be `right-3 top-[60px]` — a fixed offset from the viewport corner,
//     which is not the same place as the control, and on a wide screen
//     with a scrollbar gutter or a safe-area inset it drifts further.
//     The r0 capture is the proof: a 264px card floating in empty space
//     at the top-right with nothing tying it to anything, reading as a
//     toast that had lost its stack. It now MEASURES
//     `account-menu-trigger` and centres itself under that box, clamped
//     into the viewport, with a caret pointing at it — the same
//     shared-element logic `capsuleMorph.anchoredLeft` uses for the
//     overlay, for the same reason.
//
//     LEARNED THE HARD WAY, one lane over: an anchor that is written,
//     exported and unit-tested but NEVER CALLED measures nothing and
//     fails silently (`capsuleMorph`'s header). So the measurement runs
//     on a layout effect keyed on the NODE — set through a callback ref
//     that stores STATE — not on a boolean that flips a commit before
//     the node exists, and `data-anchored="true"` is written only on the
//     frame a real box was read, so a gate can assert the anchor RAN.
//   · it arms ONLY for a user who actually holds an explicit view-mode
//     choice (`cfo-view-mode-v1` present) — i.e. someone who used the
//     dial while it was in the bar and would otherwise find it gone.
//     A first-run user never operated it and is not told about a
//     control they never touched.
// ─────────────────────────────────────────────────────────────────────

const COACH_KEY = "cfo:header-mode-coachmark-v1";
const VIEW_MODE_KEY = "cfo-view-mode-v1";

function coachShouldArm(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (window.localStorage.getItem(COACH_KEY)) return false;
    return window.localStorage.getItem(VIEW_MODE_KEY) != null;
  } catch {
    // Storage blocked — we cannot know whether it was dismissed, and a
    // hint that re-shows forever is worse than no hint.
    return false;
  }
}

/** The control the hint is ABOUT. Read, never written. */
const COACH_ANCHOR_SELECTOR = '[data-testid="account-menu-trigger"]';

/** Keep the card on screen with a margin, whatever the anchor's centre
 *  asks for. Same shape as `capsuleMorph.anchoredLeft`, and separate
 *  from the DOM read for the same reason: the arithmetic is assertable
 *  without a browser. */
export function coachAnchoredLeft(
  anchorX: number,
  anchorW: number,
  cardW: number,
  viewportW: number,
  margin = 12,
): number {
  const centre = anchorX + anchorW / 2;
  const max = Math.max(margin, viewportW - cardW - margin);
  return Math.round(Math.min(Math.max(centre - cardW / 2, margin), max));
}

const COACH_CARD_W = 264;

function ModeCoachMark() {
  const { t } = useTranslation();
  const [open, setOpen] = useState<boolean>(coachShouldArm);
  // STATE, not a ref: the card mounts through a portal, so a layout
  // effect keyed on `open` alone would run against a null node and never
  // run again. See the header.
  const [card, setCard] = useState<HTMLElement | null>(null);
  const [anchor, setAnchor] = useState<{ left: number; top: number; caret: number } | null>(
    null,
  );

  const dismiss = useCallback(() => {
    setOpen(false);
    try {
      window.localStorage.setItem(COACH_KEY, "dismissed");
    } catch {
      /* storage blocked — the mark is gone for this session regardless */
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    // Opening the account menu IS the acknowledgement — the hint points
    // there, so reaching it retires the hint.
    const onPointerDown = (e: Event) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest?.('[data-testid="account-menu-trigger"]')) dismiss();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open, dismiss]);

  useLayoutEffect(() => {
    if (!open || !card || typeof document === "undefined") return;
    const place = () => {
      const el = document.querySelector(COACH_ANCHOR_SELECTOR);
      if (!el) return;                        // no anchor: keep the fallback
      const r = el.getBoundingClientRect();
      if (!(r.width > 0) || !(r.height > 0)) return;
      const w = card.offsetWidth || COACH_CARD_W;
      const left = coachAnchoredLeft(r.left, r.width, w, window.innerWidth);
      setAnchor({
        left,
        top: Math.round(r.bottom + 10),
        // Where the caret sits INSIDE the card, so it points at the
        // avatar's centre even after the clamp moved the card.
        caret: Math.round(Math.min(Math.max(r.left + r.width / 2 - left, 14), w - 14)),
      });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, card]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="pointer-events-none fixed inset-0 z-30"
      data-coachmark="header-mode"
      data-testid="header-coach-mark"
    >
      <div
        ref={setCard}
        role="status"
        aria-label={t("header.coach.aria")}
        data-testid="header-coach-mark-card"
        data-anchored={anchor ? "true" : undefined}
        style={anchor ? { left: anchor.left, top: anchor.top, right: "auto" } : undefined}
        className={`
          pointer-events-auto absolute w-[264px]
          rounded-[14px] border border-rule-strong bg-surface p-3
          shadow-xl
          ${anchor ? "" : "right-3 top-[60px]"}
        `}
      >
        {/* THE CARET. The card and the avatar are now one object: a
            rotated 8px square straddling the card's top edge, sitting at
            the anchor's centre even when the clamp has moved the card.
            Without it the card is still in the right PLACE and still
            reads as detached — proximity is not attachment. */}
        {anchor && (
          <span
            aria-hidden
            data-testid="header-coach-mark-caret"
            style={{ left: anchor.caret }}
            className="
              absolute -top-[5px] -ml-[5px] h-[9px] w-[9px] rotate-45
              border-l border-t border-rule-strong bg-surface
            "
          />
        )}
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-medium text-ink">
              {t("header.coach.title")}
            </div>
            <p className="mt-1 text-[12px] leading-snug text-ink-soft">
              {t("header.coach.body")}
            </p>
          </div>
          <button
            type="button"
            onClick={dismiss}
            aria-label={t("header.coach.dismiss")}
            data-testid="header-coach-mark-dismiss"
            className="
              -mr-1 -mt-1 inline-flex h-7 w-7 shrink-0 items-center justify-center
              rounded-sm text-ink-mute transition-colors duration-micro
              hover:bg-bg-2 hover:text-ink
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
            "
          >
            <X size={14} strokeWidth={1.75} />
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
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
  // The Simple|Pro dial lives in the avatar menu, whose content only
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
        {/* LEFT SLOT — exactly ONE control at any width.
            <lg: the nav hamburger (44px touch target per Apple HIG).
            ≥lg: the brand mark (the rail is already pinned open, so a
            hamburger would open nothing). Rendering both below lg was
            two left-hand "go somewhere" controls competing on the
            narrowest screen; the drawer carries the product identity
            there, and /dashboard stays 2 interactions away through it. */}
        <button
          onClick={onOpenSidebar}
          data-testid="header-nav-toggle"
          aria-label={t("topbar.openNav")}
          className="lg:hidden inline-flex items-center justify-center h-11 w-11 -ml-2 rounded-sm text-ink-soft hover:text-ink hover:bg-bg-2 active:bg-bg-2/70 transition-colors duration-micro"
        >
          <Menu size={20} strokeWidth={1.75} />
        </button>

        <button
          onClick={() => navigate("/dashboard")}
          data-testid="header-brand"
          className="hidden lg:flex items-center shrink-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t("topbar.goToDashboard")}
        >
          <Logo size={24} iconOnly />
        </button>

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
              {/* K1-d. The accessible name must carry the SAME verb the
                  surface does. This said "Search" while the overlay it opens
                  says "Ask" — a screen-reader user and a sighted user were
                  told the same button does two different things. */}
              <button
                type="button"
                data-testid="header-command-bar"
                onClick={onOpenPalette}
                className="
                  flex flex-1 items-center gap-2 min-w-0 h-full rounded-full
                  text-left focus-visible:outline-none
                  focus-visible:ring-2 focus-visible:ring-ring
                "
                aria-label={t("header.capsule.aria")}
                title={`${t("header.capsule.title")} (${mod}K)`}
              >
                <span className="flex-1 truncate text-[12.5px] text-ink-soft group-hover:text-ink">
                  {capsuleLabel}
                </span>
                <Sparkles size={13} strokeWidth={1.75} className="shrink-0 text-ink-mute" />
                <kbd className="hidden sm:inline shrink-0 rounded-sm border border-rule bg-bg px-1.5 py-px font-mono text-[10px] text-ink-soft">
                  {mod}K
                </kbd>
              </button>
            </div>
          )}
        </div>

        {/* RIGHT CLUSTER */}

        {/* Engine-down indicator only. It is a <span>, not a control —
            it spends no budget. */}
        {backend === "disconnected" && <BackendStatusIndicator />}

        {/* Notifications bell — ≥lg only. Below that it folds into the
            avatar menu's Notifications row and the avatar's own badge
            (see AccountMenu), which is what keeps the count visible
            without a fourth control on a phone-width bar. */}
        {signedIn && (
          <div className="hidden lg:inline-flex">
            <NotificationsMenu />
          </div>
        )}

        {/* Avatar — the account menu hosts the Simple|Pro dial, display
            currency, Learning mode, Theme, Billing, Settings, sign-out,
            and (below lg) Notifications. */}
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

      {/* Portaled to <body> — outside <header>, so it never enters the
          H1 census. */}
      {signedIn && <ModeCoachMark />}
    </header>
  );
}
