// Google sign-UP with the company field (2026-09-09 per operator): the
// create-account form asks for the company before Google can be used;
// Google supplies the identity (name, email, avatar) and the company
// fills the rest. OAuth leaves the page, so the company is parked here
// and applied when the session comes back — the same pattern as
// lib/newsletterOptIn.ts.
//
// Applied to the account that was JUST created (auth.users.created_at
// within the last few minutes) so an existing user re-using the form
// never has their real profile or workspace overwritten.

import type { User } from "@supabase/supabase-js";

import { getSupabase } from "@/lib/supabase";
import { renameWorkspaceOrg } from "@/lib/org";

const KEY = "cfo-ai-oauth-profile-pending-v1";
const FRESH_ACCOUNT_MS = 10 * 60 * 1000;

export interface PendingOAuthProfile {
  companyName: string;
}

export function markPendingOAuthProfile(p: PendingOAuthProfile): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* private mode / quota — never blocks the sign-in */
  }
}

export function clearPendingOAuthProfile(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

function readPending(): PendingOAuthProfile | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<PendingOAuthProfile>;
    const company = (p.companyName ?? "").trim();
    return company ? { companyName: company } : null;
  } catch {
    return null;
  }
}

/** Apply a parked company to the freshly signed-in `user`. No-op when
 *  nothing is pending, so it is safe on every SIGNED_IN. */
export async function flushPendingOAuthProfile(user: User | null | undefined): Promise<void> {
  const pending = readPending();
  if (!pending || !user) return;
  // Consumed either way — a stale stash must not fire on a later login.
  clearPendingOAuthProfile();

  const createdAt = Date.parse(user.created_at ?? "");
  if (!Number.isFinite(createdAt) || Date.now() - createdAt > FRESH_ACCOUNT_MS) return;

  const supabase = getSupabase();
  if (!supabase) return;
  const company = pending.companyName;

  // 1. Identity metadata — what the app reads as the company name. The
  //    display name stays whatever Google provided.
  await supabase.auth.updateUser({ data: { company_name: company, pending_org_name: company } });
  // 2. The profile row the bootstrap trigger seeded from Google's data.
  await supabase.from("profiles").update({ company_name: company }).eq("id", user.id);
  // 3. The bootstrap workspace: named "<name>'s workspace" because Google
  //    carried no company. Rename only that default, never a real one.
  const { data } = await supabase.rpc("list_workspaces");
  const orgs = (Array.isArray(data) ? data : []) as Array<{ id?: string; name?: string }>;
  const bootstrap = orgs.find((o) => typeof o.name === "string" && /'s workspace$/i.test(o.name)) ?? orgs[0];
  if (bootstrap?.id) await renameWorkspaceOrg(bootstrap.id, company);
}
