// Lightweight name-only identity for v2 multi-user awareness.
// Captured on first visit, persisted in localStorage, and posted to the
// backend so every team member can see who else has used the platform.

import { useSyncExternalStore } from "react";

const KEY = "aicfo.user.v1";
const SEEN_KEY = "aicfo.usersSeen.v1";

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? "";

export interface UserIdentity {
  name: string;
  initial: string;
  setAt: string;       // ISO
}

const listeners = new Set<() => void>();
function emit() { listeners.forEach((l) => l()); }

let cached: UserIdentity | null = null;
let cachedRaw: string | null = null;

function read(): UserIdentity | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) {
      if (cachedRaw !== null) { cached = null; cachedRaw = null; }
      return null;
    }
    if (raw === cachedRaw && cached) return cached;
    cachedRaw = raw;
    cached = JSON.parse(raw) as UserIdentity;
    return cached;
  } catch {
    return null;
  }
}

/** Tell the backend "this person is active right now". Used both on
 *  identity-set and on a periodic heartbeat. Network failures are silent
 *  — the frontend keeps working with localStorage-only state. */
function trackToBackend(name: string): void {
  const url = `${API_URL}/api/sessions/track`;
  // fire-and-forget; never block UI on this
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
    keepalive: true,
  }).catch(() => { /* offline / 4xx — silent */ });
}

export function setUserName(name: string): UserIdentity {
  const trimmed = name.trim().slice(0, 32);
  const id: UserIdentity = {
    name: trimmed,
    initial: trimmed.charAt(0).toUpperCase() || "?",
    setAt: new Date().toISOString(),
  };
  localStorage.setItem(KEY, JSON.stringify(id));
  // Local roster (kept as a fallback when offline)
  try {
    const seenRaw = localStorage.getItem(SEEN_KEY);
    const seen: { name: string; lastSeen: string }[] = seenRaw ? JSON.parse(seenRaw) : [];
    const idx = seen.findIndex((u) => u.name === trimmed);
    const entry = { name: trimmed, lastSeen: id.setAt };
    if (idx >= 0) seen[idx] = entry;
    else seen.push(entry);
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen.slice(-10)));
  } catch { /* ignore */ }
  cached = id; cachedRaw = localStorage.getItem(KEY);
  emit();
  // Push to backend so other users will see this person in their roster.
  if (trimmed) trackToBackend(trimmed);
  return id;
}

export function clearUser() {
  localStorage.removeItem(KEY);
  cached = null; cachedRaw = null;
  emit();
}

/** Heartbeat — re-track on app load (and periodically) so last_seen stays
 *  fresh for users who keep the tab open without interacting. */
export function heartbeatIfIdentified(): void {
  const id = read();
  if (id?.name) trackToBackend(id.name);
}

export interface SeenUser { name: string; lastSeen: string }
export function readSeenUsers(): SeenUser[] {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    return raw ? (JSON.parse(raw) as SeenUser[]) : [];
  } catch { return []; }
}

// ─────── Cross-user session list (fetched from backend) ───────

export interface RemoteSession {
  id: number;
  name: string;
  ip: string | null;
  user_agent: string | null;
  first_seen: string;
  last_seen: string;
  visit_count: number;
}

export async function fetchSessions(limit = 50): Promise<RemoteSession[]> {
  try {
    const res = await fetch(`${API_URL}/api/sessions?limit=${limit}`);
    if (!res.ok) return [];
    const body = await res.json();
    return body.sessions ?? [];
  } catch {
    return [];
  }
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) emit();
  };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(cb); window.removeEventListener("storage", onStorage); };
}

export function useUser(): UserIdentity | null {
  return useSyncExternalStore(subscribe, read, () => null);
}

/** Synchronous accessor for non-component code (e.g. activity log writers). */
export function getCurrentUserName(): string {
  return read()?.name ?? "anonymous";
}
