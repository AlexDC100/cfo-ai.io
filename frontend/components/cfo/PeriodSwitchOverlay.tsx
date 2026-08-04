// Fullscreen month-switch overlay.
//
// Mounted ONCE at the app root (App.tsx), alongside LanguageSwitchOverlay and
// following the same shape: a scrim + brand-accent spinner rendered into
// document.body via a portal, so it covers every surface regardless of which
// route or panel is open.
//
// Trigger: `startPeriodSwitch(label)` from `@/lib/periodSwitch` — called by the
// sidebar month stepper before it rewrites `?period=<id>`. Switching the active period re-scopes
// every tab at once (statements, ratios, products, valuation), so without a
// cover the page repaints piecemeal as each query settles.
//
// Dismissal is DATA-DRIVEN, not a fixed timer: the overlay lifts once the
// query layer goes quiet (`useIsFetching() === 0`) — but never before
// MIN_HOLD_MS, which both avoids a sub-perceptual flash and gives React time
// to render the new period and kick its queries off (checking `isFetching`
// on the same tick as the event would always read 0 and close instantly).
// MAX_HOLD_MS is the escape hatch: a stalled or failing request must never
// trap the user behind a permanent scrim.
//
// Note a cache hit is the common case — with the app's 30-minute staleTime,
// stepping back to a month viewed earlier in the session fires no request at
// all, so the overlay shows for MIN_HOLD_MS and lifts. That's the intended
// behavior: brief, deliberate, never a fake wait.

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import { useIsFetching } from "@tanstack/react-query";
import { PERIOD_SWITCH_EVENT, type PeriodSwitchDetail } from "@/lib/periodSwitch";

const MIN_HOLD_MS = 450;
const MAX_HOLD_MS = 10000;
const FADE_MS = 200;

type Phase = "hidden" | "entering" | "visible" | "exiting";

export function PeriodSwitchOverlay() {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>("hidden");
  const [label, setLabel] = useState<string | null>(null);
  const [kind, setKind] = useState<PeriodSwitchDetail["kind"]>("period");
  // Gates dismissal: false until MIN_HOLD_MS has elapsed, so an empty
  // isFetching count in the first frames can't close the overlay early.
  const [armed, setArmed] = useState(false);
  const isFetching = useIsFetching();

  const timers = useRef<number[]>([]);
  const raf = useRef<number[]>([]);
  const clearAll = useCallback(() => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
    raf.current.forEach((r) => cancelAnimationFrame(r));
    raf.current = [];
  }, []);

  const close = useCallback(() => {
    clearAll();
    setPhase("exiting");
    timers.current.push(window.setTimeout(() => setPhase("hidden"), FADE_MS));
  }, [clearAll]);

  useEffect(() => {
    const onStart = (e: Event) => {
      clearAll();
      const detail = (e as CustomEvent<PeriodSwitchDetail>).detail;
      setLabel(detail?.label ?? null);
      setKind(detail?.kind ?? "period");
      setArmed(false);
      // Mount at opacity 0, then flip to 1 on a later frame — a same-frame
      // 0 → 1 change is batched by the browser and skips the transition.
      setPhase("entering");
      raf.current.push(
        requestAnimationFrame(() => {
          raf.current.push(requestAnimationFrame(() => setPhase("visible")));
        }),
      );
      timers.current.push(
        window.setTimeout(() => setArmed(true), MIN_HOLD_MS),
        window.setTimeout(close, MAX_HOLD_MS),
      );
    };
    window.addEventListener(PERIOD_SWITCH_EVENT, onStart);
    return () => {
      window.removeEventListener(PERIOD_SWITCH_EVENT, onStart);
      clearAll();
    };
  }, [clearAll, close]);

  // Data-driven dismissal — the new month's queries have all settled.
  useEffect(() => {
    if (armed && isFetching === 0 && (phase === "visible" || phase === "entering")) {
      close();
    }
  }, [armed, isFetching, phase, close]);

  if (phase === "hidden") return null;

  return createPortal(
    <div
      role="status"
      aria-live="polite"
      aria-label={kind === "workspace" ? t("scan.switchingWorkspace") : t("scan.switchingMonth")}
      data-testid="period-switch-overlay"
      className="fixed inset-0 z-[10000] flex flex-col items-center justify-center gap-4 bg-black/80 backdrop-blur-xl transition-opacity"
      style={{ opacity: phase === "visible" ? 1 : 0, transitionDuration: `${FADE_MS}ms` }}
    >
      <div className="h-12 w-12 rounded-full border-4 border-brand border-t-transparent animate-spin" />
      {label && (
        <span className="font-mono text-[11.5px] uppercase tracking-[0.16em] text-white/70">
          {label}
        </span>
      )}
      <span className="sr-only">
        {t("scan.loadingWhat", { what: label ?? (kind === "workspace" ? t("scan.selectedWorkspace") : t("scan.selectedMonth")) })}
      </span>
    </div>,
    document.body,
  );
}
