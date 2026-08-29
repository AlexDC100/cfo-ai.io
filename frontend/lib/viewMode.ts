// THE DIAL — two view modes over one data layer (Prompt 12, Part A).
//
// Modes are PRESENTATION ONLY. Same facts gateway, same snapshots, same
// trust states — a parity gate (M1) renders shared figures in both modes
// and asserts cent-identical values. Nothing here may branch on data.
//
// Default logic:
//   · explicit user choice (persisted per user via prefs) always wins;
//   · else role from the onboarding question: owner -> Simple,
//     accountant/CFO or analyst -> Pro;
//   · else Simple — the safer first impression for unknowns, and the
//     REQUIRED default for visitors arriving from public /companii
//     pages (they sign up with ft_cui attribution; see landedFromPublic).
//
// localStorage is the source of first paint (the house prefs contract);
// setPref mirrors to user_prefs so the choice follows the user.

import { useSyncExternalStore } from "react";

import { setPref } from "@/lib/prefs";

export type ViewMode = "simple" | "pro";
export type UserRole = "owner" | "accountant" | "analyst" | null;

const MODE_KEY = "cfo-view-mode-v1";
const ROLE_KEY = "cfo-user-role-v1";

type Listener = () => void;
const listeners = new Set<Listener>();

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — the session still works, unpersisted */
  }
}

/** True when this signup arrived from a public company page — the
 *  attribution lib stamps first-touch with utm_source=public_company.
 *  Those visitors default to Simple regardless of the skipped question. */
export function landedFromPublic(): boolean {
  try {
    const ft = localStorage.getItem("cfo-first-touch-v1") ?? "";
    return ft.includes("public_company");
  } catch {
    return false;
  }
}

export function getRole(): UserRole {
  const r = read(ROLE_KEY);
  return r === "owner" || r === "accountant" || r === "analyst" ? r : null;
}

export function setRole(role: Exclude<UserRole, null>): void {
  write(ROLE_KEY, role);
  setPref("user", "role", role);
  // The role implies a mode ONLY when the user has not chosen one.
  if (!read(MODE_KEY)) {
    notify();
  }
}

function defaultMode(): ViewMode {
  const role = getRole();
  if (role === "accountant" || role === "analyst") return "pro";
  // owner, unknown, or public-page inflow — story-first.
  return "simple";
}

export function getViewMode(): ViewMode {
  const stored = read(MODE_KEY);
  if (stored === "simple" || stored === "pro") return stored;
  return defaultMode();
}

export function setViewMode(mode: ViewMode): void {
  write(MODE_KEY, mode);
  setPref("user", "view_mode", mode);
  notify();
}

/** prefs.ts adoption hook — a remote value from another device. */
export function adoptRemoteViewMode(mode: string): void {
  if (mode !== "simple" && mode !== "pro") return;
  write(MODE_KEY, mode);
  notify();
}

function notify(): void {
  for (const l of listeners) l();
}

function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The one hook screens read. Re-renders on switch, same value across
 *  the tree within a render. */
export function useViewMode(): ViewMode {
  return useSyncExternalStore(subscribe, getViewMode, () => "simple" as ViewMode);
}

export function useIsSimple(): boolean {
  return useViewMode() === "simple";
}
