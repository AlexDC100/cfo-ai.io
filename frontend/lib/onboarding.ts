// First-run onboarding (2026-09-09, design "First Run Onboarding" 1b).
//
// Four instruction slides then a sign-in / explore choice, rendered by
// components/cfo/onboarding/OnboardingFlow.tsx as a full-screen overlay.
// Plays once, on the very first launch of the native shell (a browser
// visit lands on the marketing site instead); the "seen" flag lives in
// localStorage, which the shell's WebView keeps across launches.
//
// Dev builds add a "Replay onboarding" row to the drawer so the sequence
// can be watched again without clearing storage.

import { isNativeShell, nativeSheetKind } from "@/lib/nativeShell";

const SEEN_KEY = "cfo:onboarding-seen:v1";

export function hasSeenOnboarding(): boolean {
  try {
    return window.localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    // Storage unavailable — never trap the user in an intro that cannot
    // be dismissed for good.
    return true;
  }
}

export function markOnboardingSeen(): void {
  try {
    window.localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* ignore */
  }
}

/** First launch of the MAIN shell WebView (never inside a native sheet). */
export function shouldAutoPlayOnboarding(): boolean {
  return isNativeShell() && nativeSheetKind() === null && !hasSeenOnboarding();
}

/** The drawer's replay row exists in dev builds only. */
export const onboardingReplayAvailable: boolean = import.meta.env.DEV;

// Decided at module load so the overlay is in the very first paint —
// a mount-time effect would flash the dashboard behind it for a frame.
let open = typeof window !== "undefined" && shouldAutoPlayOnboarding();
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

export function subscribeOnboarding(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getOnboardingOpen(): boolean {
  return open;
}

export function openOnboarding(): void {
  if (open) return;
  open = true;
  emit();
}

export function closeOnboarding(): void {
  if (!open) return;
  open = false;
  emit();
}
