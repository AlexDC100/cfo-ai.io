// F6.0.4 (2026-06-20) — Dashboard config persistence.
//
// PERSISTENCE STRATEGY — localStorage-primary, backend-progressive.
//
// The F6.0.4 spec calls for backend per-user storage so a user's layout
// follows them across devices. The right end-state. BUT shipping a
// backend-only persistence path right now is blocked:
//   · Bug #4 (Supabase PostgREST cache persistent staleness) is pending
//     operator-side (24-48h SLA). A freshly-created `dashboard_configs`
//     table would hit exactly that failure mode — PostgREST returns 400
//     for the new table until the cache reloads.
//   · The schema migration + Dashboard "Reload schema cache" click are
//     operator-only actions (§14 + F3.24 Lock #15 discipline). The agent
//     cannot run them.
//
// So this module is BACKEND-READY but LOCALSTORAGE-PRIMARY:
//   · Writes go to localStorage immediately (never lose config — spec
//     anti-pattern #3) AND fire-and-forget to the backend.
//   · Reads try the backend first; on any non-200 (table missing, Bug #4
//     400, offline) they fall back to localStorage.
//   · When the backend GET first succeeds, `syncSource` flips to
//     "account" and the UI shows "Synced to your account" instead of
//     "Synced to this device". Zero FE change needed when the operator
//     runs the migration + Bug #4 clears — the path lights up on its own.
//
// The backend endpoint + migration ship as committed artifacts
// (src/engine/api/_dashboard.py + supabase/schema_phase_dashboard_config.sql)
// for the operator to deploy when Bug #4 is resolved.

import { getSupabase } from "@/lib/supabase";
import type { DashboardCard, DashboardConfig } from "@/types/dashboard";

const LS_KEY = "cfo:dashboard-config:v1";

const API_URL =
  (import.meta.env?.VITE_API_URL as string | undefined) ??
  "https://cfo-ai.io";

export type SyncSource = "device" | "account";

// ── localStorage ────────────────────────────────────────────────────

export function readLocalConfig(): DashboardConfig | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DashboardConfig;
    if (!parsed || !Array.isArray(parsed.cards)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeLocalConfig(cards: DashboardCard[]): void {
  try {
    const payload: DashboardConfig = {
      cards,
      // Stamp lazily — the store passes an ISO string; keep this pure of
      // Date by reading what the caller stored. We accept a timestamp via
      // the cards already carrying order; updatedAt is informational only.
      updatedAt: new Date().toISOString(),
    };
    localStorage.setItem(LS_KEY, JSON.stringify(payload));
  } catch {
    // Quota / private mode — silent; in-memory state still holds.
  }
}

// ── Backend (progressive enhancement) ───────────────────────────────

async function authToken(): Promise<string | null> {
  const sb = getSupabase();
  if (!sb) return null;
  try {
    const { data } = await sb.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

/** Try to load config from the backend. Returns null on ANY failure
 *  (no session, table missing, Bug #4 400, network) — caller falls back
 *  to localStorage. Never throws. */
export async function fetchRemoteConfig(): Promise<DashboardConfig | null> {
  const token = await authToken();
  if (!token) return null;
  try {
    const r = await fetch(`${API_URL}/api/dashboard/config`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { cards?: DashboardCard[] } | null;
    if (!j || !Array.isArray(j.cards)) return null;
    return { cards: j.cards, updatedAt: new Date().toISOString() };
  } catch {
    return null;
  }
}

/** Fire-and-forget backend persist. Returns true if the write was
 *  accepted (200), false otherwise. Never throws — localStorage already
 *  holds the authoritative copy for this device. */
export async function persistRemoteConfig(
  cards: DashboardCard[],
): Promise<boolean> {
  const token = await authToken();
  if (!token) return false;
  try {
    const r = await fetch(`${API_URL}/api/dashboard/config`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ cards }),
    });
    return r.ok;
  } catch {
    return false;
  }
}
