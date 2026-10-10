// profileSave — the signed-in user's name on their own `profiles` row.
//
// UPDATE, never upsert. `profiles` carries an own-row SELECT policy and an
// own-row UPDATE policy and NO insert policy (supabase/schema.sql; the same
// two in production, read from the catalog 2026-10-04). An upsert is an
// INSERT … ON CONFLICT DO UPDATE: row level security checks the INSERT half
// first and refuses it, even when the row exists — so Settings answered
// "Couldn't save profile" to every save while the name went only to the
// auth metadata. The row itself is created by the signup trigger; a browser
// has no way to create one, and does not need one.
//
// `.select("id")` returns the rows the UPDATE touched, which is how a save
// that landed is told from one that matched nothing (an UPDATE that matches
// no row is not an error).
import type { SupabaseClient } from "@supabase/supabase-js";

export interface ProfileSaveResult {
  /** The database's refusal, or null. */
  error: { message: string } | null;
  /** True when the user's own row was updated. False with no error means
   *  there is no row to update (the name still lives in the auth metadata). */
  rowUpdated: boolean;
}

export async function saveProfileName(
  sb: Pick<SupabaseClient, "from">,
  userId: string,
  fullName: string,
): Promise<ProfileSaveResult> {
  const { data, error } = await sb
    .from("profiles")
    .update({ full_name: fullName })
    .eq("id", userId)
    .select("id");
  if (error) return { error: { message: error.message }, rowUpdated: false };
  return { error: null, rowUpdated: Array.isArray(data) && data.length > 0 };
}
