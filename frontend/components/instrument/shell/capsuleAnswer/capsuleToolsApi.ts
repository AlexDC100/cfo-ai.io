// THE CAPSULE — the read-only tool client.
//
// One function, one endpoint family: `POST /api/capsule/tools/{name}`.
// The engine side (`engine/api/_capsule_tools.py`) refuses anything that
// is not an allowlisted, read-only tool BEFORE it looks the name up, so
// this client cannot reach a write path even if it were asked to. There
// is no PUT, no PATCH, no DELETE anywhere in this module — the absence
// is the guarantee, not a check.
//
// The auth headers mirror `lib/cfoApi.ts`'s `callUrl`: the Supabase JWT
// so the engine can scope reads to the caller's memberships, and
// `X-Org-Id` so a multi-workspace user's question is answered about the
// company they actually have open. `currentOrgId()` is used rather than
// the bare localStorage cache for the reason cfoApi documents: on a cold
// device the cache is empty and the request would silently be answered
// about the user's OLDEST workspace.
//
// This is a separate ~40 lines rather than a new `cfoApi` method on
// purpose — `cfoApi.ts` is a shared file and this lane owns none of it.
// Flagged as a cross-lane note: if the header logic there changes, this
// wants the same change.

import { CfoApiError } from "@/lib/cfoApi";

import type { CapsuleToolPayload } from "./capsuleAnswerTypes";
import type { CapsulePlanStep, ToolTransport } from "./capsuleRetrieval";

const API_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";

async function authHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  try {
    const { getSupabase } = await import("@/lib/supabase");
    const sb = getSupabase();
    if (!sb) return headers;
    const { data } = await sb.auth.getSession();
    const token = data.session?.access_token;
    if (token) headers.Authorization = `Bearer ${token}`;
    if (data.session?.user?.id) {
      const { currentOrgId } = await import("@/lib/supabase");
      const orgId = await currentOrgId();
      if (orgId) headers["X-Org-Id"] = orgId;
    }
  } catch {
    /* supabase not loaded — the engine will 401 and the turn degrades */
  }
  return headers;
}

/** The live transport. Errors are thrown as `CfoApiError` so
 *  `aiDegraded.classifyAiFailure` maps them onto one calm state and the
 *  raw body never reaches the DOM. */
export function engineToolTransport(): ToolTransport {
  return async function call(
    step: CapsulePlanStep,
    signal?: AbortSignal,
  ): Promise<CapsuleToolPayload> {
    const res = await fetch(
      `${API_URL}/api/capsule/tools/${encodeURIComponent(step.tool)}`,
      {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({ args: step.args, period: step.period ?? undefined }),
        signal,
      },
    );
    if (!res.ok) {
      let detail: unknown = `${res.status} ${res.statusText}`;
      try {
        const body = await res.json();
        if (body?.detail !== undefined) detail = body.detail;
      } catch {
        /* leave the status line */
      }
      throw new CfoApiError(
        typeof detail === "string" ? detail : `${res.status} ${res.statusText}`,
        res.status,
        detail,
      );
    }
    return (await res.json()) as CapsuleToolPayload;
  };
}
