// SAVED SCENARIOS — per company, in org_prefs.prefs.scenarios
// (forecast-scenarios-live; owner gate F6).
//
// No DDL is possible, so a saved scenario lives in the company's own prefs
// bag (`org_prefs.prefs`, one row per organization, RLS `is_member_of`)
// under the key "scenarios", written through the existing `set_org_pref`
// RPC. What is saved is the REQUEST, never a figure: the template id and the
// reader's lever overrides. Opening a saved scenario sends that request to
// the engine again (POST /api/forecast/{id}/scenario), so a saved scenario
// always paints what the engine serves today.
//
// THE COMPANY IS NAMED ON EVERY CALL. This module does not use prefs.ts's
// "active workspace" write path (`setPref("org", …)` writes to whichever org
// was hydrated last): a save lands in exactly the org the page is showing,
// and every read filters by it too. Each entry also carries its org id, and
// an entry that names another company is never listed — so a Scandia
// scenario cannot show on Agras even if a bag were ever written wrongly.
//
// `set_org_pref` merges at the top-level key, so the list is read fresh
// immediately before each write and merged by id. Two tabs saving in the
// same instant can still race on the whole list (the RPC has no per-element
// merge); the loser's entry is missing, never corrupted.

import { getSupabase } from "@/lib/supabase";

export const SCENARIOS_PREF_KEY = "scenarios";

export interface SavedScenario {
  readonly id: string;
  readonly name: string;
  /** The company the scenario belongs to (organizations.id). */
  readonly orgId: string;
  readonly templateId: string;
  /** The reader's lever overrides, exact decimal strings (the wire form). */
  readonly overrides: Record<string, { values: (string | null)[] }>;
  /** The period it was saved on, for the reader's reference only. */
  readonly periodId: string | null;
  readonly periodLabel: string | null;
  readonly savedAt: string;
}

function isOverrides(v: unknown): v is SavedScenario["overrides"] {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every(
    (o) =>
      !!o &&
      typeof o === "object" &&
      Array.isArray((o as { values?: unknown }).values) &&
      ((o as { values: unknown[] }).values).every((x) => x === null || typeof x === "string"),
  );
}

/** The entries of one company's bag that are well formed AND name that
 *  company. Anything else is dropped from the list, never "repaired". */
export function scenariosOfCompany(raw: unknown, orgId: string): SavedScenario[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedScenario[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const r = e as Record<string, unknown>;
    if (
      typeof r.id !== "string" ||
      typeof r.name !== "string" ||
      r.orgId !== orgId ||
      typeof r.templateId !== "string" ||
      !isOverrides(r.overrides) ||
      typeof r.savedAt !== "string"
    ) {
      continue;
    }
    out.push({
      id: r.id,
      name: r.name,
      orgId,
      templateId: r.templateId,
      overrides: r.overrides,
      periodId: typeof r.periodId === "string" ? r.periodId : null,
      periodLabel: typeof r.periodLabel === "string" ? r.periodLabel : null,
      savedAt: r.savedAt,
    });
  }
  return out;
}

async function readBag(orgId: string): Promise<unknown> {
  const client = getSupabase();
  if (!client) throw new Error("saved scenarios need a signed-in session");
  const { data, error } = await client
    .from("org_prefs")
    .select("prefs")
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const prefs = (data?.prefs ?? {}) as Record<string, unknown>;
  return prefs[SCENARIOS_PREF_KEY];
}

async function writeList(orgId: string, list: SavedScenario[]): Promise<void> {
  const client = getSupabase();
  if (!client) throw new Error("saved scenarios need a signed-in session");
  const { error } = await client.rpc("set_org_pref", {
    p_org_id: orgId,
    p_key: SCENARIOS_PREF_KEY,
    p_value: list,
  });
  if (error) throw new Error(error.message);
}

/** The saved scenarios of ONE company, newest first. */
export async function loadSavedScenarios(orgId: string): Promise<SavedScenario[]> {
  return scenariosOfCompany(await readBag(orgId), orgId).sort((a, b) =>
    b.savedAt.localeCompare(a.savedAt),
  );
}

function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `sc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Save a scenario to the named company; returns that company's list. */
export async function saveScenario(
  orgId: string,
  input: Omit<SavedScenario, "id" | "orgId" | "savedAt">,
): Promise<SavedScenario[]> {
  const current = scenariosOfCompany(await readBag(orgId), orgId);
  const entry: SavedScenario = {
    ...input,
    id: newId(),
    orgId,
    savedAt: new Date().toISOString(),
  };
  const next = [entry, ...current];
  await writeList(orgId, next);
  return next;
}

/** Remove one saved scenario of the named company. */
export async function deleteSavedScenario(orgId: string, id: string): Promise<SavedScenario[]> {
  const next = scenariosOfCompany(await readBag(orgId), orgId).filter((s) => s.id !== id);
  await writeList(orgId, next);
  return next;
}
