// AppLoader — the fullscreen loading screen shown while the app resolves the
// session and the active workspace.
//
// Those two fetches gate every authed route, and until they land there is
// nothing meaningful to paint. The guard used to hold the space with a bare
// `min-h-screen bg-bg` div, so a refresh (or a cold visit to a workspace URL)
// showed an empty page for as long as the round-trips took — indistinguishable
// from a broken build or a hung request. This says "loading", on brand
// (2026-07-26 per operator).
//
// `ContentLoader` (below) is the same treatment scoped to the content region,
// for when the shell is already up but a page's data hasn't landed.
//
// Deliberately quiet: the mark, a slim indeterminate bar, one line of copy.
// No percentage (we can't know one) and no spinner-in-the-middle-of-nowhere.

import { Logo } from "./Logo";

/** Mark + indeterminate bar + caption. Shared by both loaders. */
function LoaderBody({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-5 px-6">
      <Logo size={40} />

      {/* Indeterminate track — a brand sliver sweeping a rule-colored rail.
          The sliver carries a STATIC brand gradient and exactly one
          animation (its travel). Layering the app's `ask-ai-anim-fill` here
          would have set a second `animation` shorthand on the same element,
          and the later rule simply wins — one of the two effects would have
          silently not run. */}
      <div
        className="relative h-[3px] w-[180px] overflow-hidden rounded-full bg-rule/60"
        aria-hidden
      >
        <div className="absolute inset-y-0 w-1/3 rounded-full bg-gradient-to-r from-brand/30 via-brand to-brand/30 app-loader-sweep" />
      </div>

      <p className="text-[12.5px] text-ink-mute text-center max-w-[280px] leading-relaxed">
        {label}
      </p>
    </div>
  );
}

interface Props {
  /** Optional line under the bar — say what's being waited on. */
  label?: string;
}

export function AppLoader({ label = "Loading your workspace…" }: Props) {
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-bg"
      role="status"
      aria-live="polite"
      data-testid="app-loader"
    >
      <LoaderBody label={label} />
    </div>
  );
}

interface ContentLoaderProps extends Props {
  /** Matches AppShell's `<main>` left padding so the overlay starts exactly at
   *  the content edge and never covers the nav rail. */
  sidebarCollapsed?: boolean;
}

/**
 * Covers the CONTENT REGION only — under the top header, right of the sidebar
 * — while a page's data is still resolving (2026-07-26 per operator).
 *
 * The problem it solves: pages render immediately with whatever the period
 * payload says right now, which for an in-flight fetch is the empty shape. So
 * a tab would paint its "no data" layout for a frame or two and then swap to
 * the real numbers — reading as a flicker, or worse, as a momentary claim that
 * the user has no data. Holding the region until the payload lands makes the
 * transition a single paint.
 *
 * Header and sidebar stay live on purpose: navigation and the workspace
 * switcher remain usable while content loads.
 */
export function ContentLoader({
  label = "Loading…",
  sidebarCollapsed = false,
}: ContentLoaderProps) {
  return (
    <div
      // top-16 == the fixed header's 64px. Left inset only at `lg`, where the
      // rail actually occupies space (below that it's a drawer over content).
      // z-30 sits above page content but below the header (z-40) and the
      // slide-over panels, so those stay interactive.
      className={`fixed top-14 right-0 bottom-0 left-0 z-30 grid place-items-center bg-bg transition-[left] duration-200 ease-out ${
        sidebarCollapsed ? "lg:left-[80px]" : "lg:left-[268px]"
      }`}
      role="status"
      aria-live="polite"
      data-testid="content-loader"
    >
      <LoaderBody label={label} />
    </div>
  );
}
