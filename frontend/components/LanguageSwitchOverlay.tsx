// Fullscreen language-switch overlay.
//
// Mounted ONCE at the app root (App.tsx), so it covers every surface — the
// dark marketing landing and the themed app alike. It listens to the
// language-switch bus in i18n/index.ts: whenever a user picks a new language
// (landing header, sidebar Globe, header LanguageToggle, Settings), the whole
// screen is covered by a scrim with a brand-accent spinner while the UI
// re-renders in the new language, then fades away.
//
// The actual i18next switch is near-instant (locale bundles ship in the main
// chunk), so the overlay holds for a short minimum duration — long enough to
// read as a deliberate transition, short enough not to feel like loading.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { onLanguageSwitchStart } from "@/i18n";

const HOLD_MS = 900;
const FADE_MS = 250;

type Phase = "hidden" | "entering" | "visible" | "exiting";

export function LanguageSwitchOverlay() {
  const [phase, setPhase] = useState<Phase>("hidden");
  const timers = useRef<number[]>([]);
  const raf = useRef<number[]>([]);

  useEffect(() => {
    const clearAll = () => {
      timers.current.forEach((t) => window.clearTimeout(t));
      timers.current = [];
      raf.current.forEach((r) => cancelAnimationFrame(r));
      raf.current = [];
    };
    const off = onLanguageSwitchStart(() => {
      clearAll();
      // Mount at opacity 0 first, then flip to opacity 1 a couple of frames
      // later — a same-frame opacity:0 → opacity:1 change gets batched by
      // the browser with no visible transition, so the fade-in needs to
      // start on a fresh paint.
      setPhase("entering");
      raf.current.push(requestAnimationFrame(() => {
        raf.current.push(requestAnimationFrame(() => setPhase("visible")));
      }));
      timers.current.push(
        window.setTimeout(() => setPhase("exiting"), HOLD_MS),
        window.setTimeout(() => setPhase("hidden"), HOLD_MS + FADE_MS),
      );
    });
    return () => { off(); clearAll(); };
  }, []);

  if (phase === "hidden") return null;

  return createPortal(
    <div
      role="status"
      aria-live="polite"
      aria-label="Switching language"
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/80 backdrop-blur-xl transition-opacity"
      style={{ opacity: phase === "visible" ? 1 : 0, transitionDuration: `${FADE_MS}ms` }}
    >
      <div className="h-12 w-12 rounded-full border-4 border-brand border-t-transparent animate-spin" />
      <span className="sr-only">Switching language…</span>
    </div>,
    document.body,
  );
}
