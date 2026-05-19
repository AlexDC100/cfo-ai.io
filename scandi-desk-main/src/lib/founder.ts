// Founder-cohort tracking. Reads the public view `founder_cohort_public`
// which exposes `cap`, `signups_count`, `seats_left` to both anon and
// authenticated users (no RLS dance — the view is granted SELECT to anon).
//
// When seats_left hits 0, the Pricing page hides the Founding Member card
// and the /api/checkout/start endpoint returns 409 for plan='founder'.

import { useQuery } from "@tanstack/react-query";
import { getSupabase } from "@/lib/supabase";

export interface FounderCohort {
  cap: number;
  signups_count: number;
  seats_left: number;
}

export const FOUNDER_DEFAULT: FounderCohort = { cap: 500, signups_count: 0, seats_left: 500 };

async function fetchFounderCohort(): Promise<FounderCohort> {
  const supabase = getSupabase();
  if (!supabase) return FOUNDER_DEFAULT;
  const { data, error } = await supabase
    .from("founder_cohort_public")
    .select("cap, signups_count, seats_left")
    .single();
  if (error || !data) return FOUNDER_DEFAULT;
  return {
    cap: Number(data.cap ?? 500),
    signups_count: Number(data.signups_count ?? 0),
    seats_left: Number(data.seats_left ?? 500),
  };
}

/** Live seats-remaining counter for the Founding Member card.
 *  Refetches every 60 seconds so visible counter stays current without
 *  hammering the DB. Cached for 30s. */
export function useFounderCohort(): FounderCohort {
  const { data } = useQuery({
    queryKey: ["founder-cohort"],
    queryFn: fetchFounderCohort,
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,
  });
  return data ?? FOUNDER_DEFAULT;
}
