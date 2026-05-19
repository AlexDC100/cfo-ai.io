// useHighlightFromUrl — target-side hook.
//
// Lives inside each statement view (Balance Sheet, P&L, Cash Flow). On
// mount AND whenever the URL `?highlight=...` param changes, scrolls
// the matching `[data-traceable-target="<bucket>"]` row into view and
// pulses it with a brief amber-glow animation. Then strips the
// highlight param from the URL so a refresh doesn't re-pulse.
//
// Contract for the rendering page:
//   1. Call `useHighlightFromUrl()` once at the top of the page.
//   2. On every numeric row that can be the target of a TraceableNumber,
//      add `data-traceable-target="<bucket>"` (string from BSBucket /
//      PLBucket / CFBucket enums in traceableSource.ts).
//   3. Style: the hook applies the class `traceable-pulse` for ~1500ms
//      via CSS animation defined in traceablePulse.css.
//
// This file is intentionally tiny and side-effect-only; it returns
// nothing. Multiple calls within the same page are safe (idempotent
// against the URL param).

import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { HIGHLIGHT_PARAM, TRACEABLE_TARGET_ATTR } from "@/lib/traceableSource";

/** Pulse duration MUST match the CSS animation duration in
 *  `traceablePulse.css` (.traceable-pulse animation length). */
const PULSE_MS = 1500;

export function useHighlightFromUrl() {
  const [searchParams, setSearchParams] = useSearchParams();
  const highlight = searchParams.get(HIGHLIGHT_PARAM);

  useEffect(() => {
    if (!highlight) return;

    // Target rows may render asynchronously (period fetch then table
    // mount). Retry up to ~1s before giving up — covers slow connections
    // without leaving a stale ?highlight= in the URL forever.
    let attempts = 0;
    let timeoutId: number | undefined;
    let pulseTimeoutId: number | undefined;

    const tryScroll = () => {
      const selector = `[${TRACEABLE_TARGET_ATTR}="${cssEscape(highlight)}"]`;
      const el = document.querySelector<HTMLElement>(selector);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("traceable-pulse");
        pulseTimeoutId = window.setTimeout(() => {
          el.classList.remove("traceable-pulse");
        }, PULSE_MS);
        // Strip the highlight param so refreshing the page doesn't
        // re-pulse. Leave every other param (period, tab) intact.
        const next = new URLSearchParams(searchParams);
        next.delete(HIGHLIGHT_PARAM);
        setSearchParams(next, { replace: true });
        return;
      }
      if (attempts < 10) {
        attempts += 1;
        timeoutId = window.setTimeout(tryScroll, 100);
      }
      // Silent give-up after 1s: row genuinely doesn't exist on this
      // page. We do NOT alert the user — the most likely cause is a
      // stale shared link, and a missing pulse is preferable to a
      // dismissable error toast.
    };

    timeoutId = window.setTimeout(tryScroll, 50);

    return () => {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      if (pulseTimeoutId !== undefined) window.clearTimeout(pulseTimeoutId);
    };
    // searchParams identity changes on every push — depend on the
    // primitive `highlight` instead so we don't trigger the effect
    // on unrelated nav events.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlight]);
}

/** Light CSS.escape polyfill — bucket keys are camelCase identifiers
 *  so .escape() is overkill, but defensive against future keys that
 *  include odd chars (e.g. a period from an account code). */
function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/(["'\\\n\r\f])/g, "\\$1");
}
