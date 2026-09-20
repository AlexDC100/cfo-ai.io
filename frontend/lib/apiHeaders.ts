// apiHeaders.ts — the two headers every workspace-scoped engine request needs.
//
// `cfoApi.call()` has attached X-Org-Id since the multi-workspace milestone,
// but pages with their OWN fetch (the Benchmark report, the peer comparison,
// the public-records benchmark) sent Authorization only. The engine then
// falls back to the caller's OLDEST workspace, finds the period belongs to a
// different one, and answers 403 "Period belongs to a different organization"
// — so Benchmark was broken for every user whose active workspace is not their
// first (measured on production 2026-09-20, on the owner's demo workspace).
//
// X-Org-Id is a selector, never a grant: the engine validates membership.
// Gate: lib/__tests__/orgScopedFetch.test.ts reds on any raw fetch to an
// org-resolving route family that does not go through this helper.
import { currentOrgId, getSupabase } from "@/lib/supabase";

export async function authOrgHeaders(
  extra: Record<string, string> = {},
): Promise<Record<string, string> | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  const headers: Record<string, string> = { ...extra, Authorization: `Bearer ${token}` };
  try {
    const orgId = await currentOrgId();
    if (orgId) headers["X-Org-Id"] = orgId;
  } catch { /* unresolved workspace — the engine falls back and validates */ }
  return headers;
}
