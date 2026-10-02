// Custom solutions — bespoke workspaces built on top of CFO AI for one client
// (the first: AutoMasters). Access is per ACCOUNT, granted by an operator on
// the Admin page (`/admin`); see supabase/schema_phase_custom_solutions.sql
// and src/engine/api/_custom_solutions.py.
//
//   · useMySolutions()   — the solutions the signed-in account may open,
//                          read straight from Supabase (RLS: own grants).
//   · usePlatformAdmin() — whether this account is an operator (engine).
//   · adminApi           — list / link / unlink, operator only (engine).

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CarFront, type LucideIcon } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { engineCall } from "@/lib/cfoApi";
import { getSupabase } from "@/lib/supabase";

export interface SolutionDef {
  key: string;
  /** Product name — not translated. */
  name: string;
  /** Where the solution lives in the app. */
  path: string;
  icon: LucideIcon;
}

/** Solutions this build knows how to render. A grant for a key that is not
 *  listed here is ignored (a newer database talking to an older frontend). */
export const SOLUTIONS: SolutionDef[] = [
  { key: "automasters", name: "AutoMasters", path: "/solutions/automasters", icon: CarFront },
];

export const SOLUTION_BY_KEY: Record<string, SolutionDef> = Object.fromEntries(
  SOLUTIONS.map((s) => [s.key, s]),
);

async function fetchMyGrants(): Promise<string[]> {
  const sb = getSupabase();
  if (!sb) return [];
  const { data, error } = await sb.from("custom_solution_grants").select("solution_key");
  // A missing table (migration not applied yet) or a network failure means
  // "no solutions", never an error screen on every page.
  if (error || !Array.isArray(data)) return [];
  return data.map((r: { solution_key: string }) => r.solution_key);
}

export function useMySolutions(): { solutions: SolutionDef[]; loading: boolean; has: (key: string) => boolean } {
  const { user } = useAuth();
  const uid = user?.id ?? null;
  const q = useQuery({
    queryKey: ["custom-solutions", "mine", uid],
    queryFn: fetchMyGrants,
    enabled: !!uid,
    staleTime: 60_000,
  });
  const keys = new Set(q.data ?? []);
  return {
    solutions: SOLUTIONS.filter((s) => keys.has(s.key)),
    loading: !!uid && q.isLoading,
    has: (key: string) => keys.has(key),
  };
}

export function usePlatformAdmin(): { isAdmin: boolean; loading: boolean } {
  const { user } = useAuth();
  const uid = user?.id ?? null;
  const q = useQuery({
    queryKey: ["custom-solutions", "is-admin", uid],
    queryFn: async () => {
      try {
        const r = await engineCall<{ is_admin: boolean }>("/api/admin/me");
        return r.is_admin === true;
      } catch {
        return false;
      }
    },
    enabled: !!uid,
    staleTime: 5 * 60_000,
  });
  return { isAdmin: q.data === true, loading: !!uid && q.isLoading };
}

// ── Admin ───────────────────────────────────────────────────────────────

export interface LinkedAccount {
  user_id: string;
  email: string;
  granted_at: string | null;
  granted_by_email: string | null;
  note: string | null;
}

export interface AdminSolution {
  key: string;
  name: string;
  description: string | null;
  accounts: LinkedAccount[];
}

export const adminApi = {
  list: () => engineCall<{ solutions: AdminSolution[] }>("/api/admin/custom-solutions"),
  link: (key: string, email: string, note?: string) =>
    engineCall<{ ok: boolean; solutions: AdminSolution[] }>(
      `/api/admin/custom-solutions/${encodeURIComponent(key)}/grants`,
      { method: "POST", body: JSON.stringify({ email, note: note || null }) },
    ),
  unlink: (key: string, userId: string) =>
    engineCall<{ ok: boolean; solutions: AdminSolution[] }>(
      `/api/admin/custom-solutions/${encodeURIComponent(key)}/grants/${encodeURIComponent(userId)}`,
      { method: "DELETE" },
    ),
};

/** After a link / unlink: the operator may have linked their own account. */
export function useInvalidateSolutions() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["custom-solutions"] });
}
