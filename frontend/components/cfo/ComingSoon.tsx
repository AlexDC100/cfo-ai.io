// ComingSoon — wraps a surface that isn't ready yet.
//
// The wrapped content stays MOUNTED and visible (blurred, dimmed, inert) so
// the user can see the shape of what's coming, rather than a feature quietly
// vanishing from the page. Everything inside is pointer-events-none and
// aria-hidden, so nothing can be clicked, tabbed into or announced.
//
// Used for surfaces that are built but not wired end-to-end — the budget
// upload zone and the industry-benchmark panel (2026-07-26 per operator).

import type { ReactNode } from "react";

export function ComingSoon({
  children,
  label = "Coming soon",
  note,
  testid = "coming-soon",
}: {
  children: ReactNode;
  /** Pill text. */
  label?: string;
  /** One line under the pill explaining what will land here. */
  note?: string;
  testid?: string;
}) {
  return (
    <div className="relative" data-testid={testid}>
      <div
        aria-hidden
        // `inert` removes the wrapped content from the tab order — without it
        // the aria-hidden subtree still contains focusable controls, which is
        // an axe serious (aria-hidden-focus). React 18 has no first-class
        // `inert` prop, so it's spread as a raw attribute (present = inert).
        {...({ inert: "" } as Record<string, string>)}
        className="blur-[3px] opacity-45 pointer-events-none select-none"
      >
        {children}
      </div>

      <div className="absolute inset-0 grid place-items-center p-4">
        <div className="flex flex-col items-center gap-2 text-center rounded-2xl border border-brand/40 bg-surface/85 backdrop-blur-sm px-5 py-4 shadow-[0_18px_40px_-28px_rgba(0,0,0,0.45)]">
          <span className="inline-flex items-center h-6 px-2.5 rounded-full ask-ai-anim-fill [animation-duration:10s] border border-brand/40 text-[10.5px] uppercase tracking-[0.1em] font-semibold text-ink">
            {label}
          </span>
          {note && (
            <p className="text-[12px] text-ink-soft leading-relaxed max-w-[340px]">
              {note}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
