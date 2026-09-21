// SAVED FORECAST CASES — the reader's own lever sets, per company, in
// org_prefs.prefs.forecast_cases (owner gate F6).
//
// The cockpit's case switch offers the engine's cases (Bază · Optimist ·
// Pesimist) and the reader's own. What is saved is a LEVER SET, never a
// figure: every lever the case the reader started from sets (as the engine
// served it) plus every slider they moved, as exact decimal strings (one, or
// one per plan year). Opening a saved case sends `case_id: "saved:<id>"`; the
// ENGINE reads this very entry from the company's own prefs row
// (engine.forecast.cockpit.saved_case_levers, packs/forecast/cockpit.yaml
// #saved_cases) and computes it — so a saved case always paints what the
// engine serves today, and can never carry a number the engine did not
// produce.
//
// THE COMPANY IS NAMED ON EVERY CALL, exactly as `lib/savedScenarios.ts` does
// it (same RLS'd bag, same `set_org_pref` RPC): a save lands in the company the
// page is showing, every read filters by it, and each entry carries its org id
// — an entry naming another company is never listed, so a case saved on one
// company cannot show on another even if a bag were ever written wrongly.
//
// A separate key from the Scenarios page's saved scenarios: a scenario is a
// template plus per-year overrides, a cockpit case is a case plus slider
// positions, and one list holding both would have each page offering the
// other's entries it cannot open.

import { getSupabase } from "@/lib/supabase";

export const FORECAST_CASES_PREF_KEY = "forecast_cases";

/** A decimal the engine accepts back exactly: optional sign, digits, optional
 *  fraction. Anything else is not a lever position and the entry is dropped. */
const EXACT_DECIMAL = /^-?\d+(\.\d+)?$/;

export interface SavedForecastCase {
  readonly id: string;
  readonly name: string;
  /** The company the case belongs to (organizations.id). */
  readonly orgId: string;
  /** The engine case the reader started from (for their reference; the
   *  lever set below is complete without it). */
  readonly caseId: string;
  /** Lever id → exact decimal in the lever's own unit, or one per plan year. */
  readonly levers: Readonly<Record<string, string | readonly string[]>>;
  /** The period it was saved on, for the reader's reference only. */
  readonly periodLabel: string | null;
  readonly savedAt: string;
}

const isDecimal = (x: unknown): x is string => typeof x === "string" && EXACT_DECIMAL.test(x);

function isLevers(v: unknown): v is Record<string, string | string[]> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every(
    (x) => isDecimal(x) || (Array.isArray(x) && x.length > 0 && x.every(isDecimal)),
  );
}

/** The entries of one company's bag that are well formed AND name that
 *  company. Anything else is dropped from the list, never "repaired". */
export function forecastCasesOfCompany(raw: unknown, orgId: string): SavedForecastCase[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedForecastCase[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const r = e as Record<string, unknown>;
    if (
      typeof r.id !== "string" ||
      typeof r.name !== "string" ||
      r.name.trim() === "" ||
      r.orgId !== orgId ||
      !isLevers(r.levers) ||
      typeof r.savedAt !== "string"
    ) {
      continue;
    }
    out.push({
      id: r.id,
      name: r.name,
      orgId,
      caseId: typeof r.caseId === "string" ? r.caseId : "",
      levers: { ...r.levers },
      periodLabel: typeof r.periodLabel === "string" ? r.periodLabel : null,
      savedAt: r.savedAt,
    });
  }
  return out;
}

async function readBag(orgId: string): Promise<unknown> {
  const client = getSupabase();
  if (!client) throw new Error("saved cases need a signed-in session");
  const { data, error } = await client
    .from("org_prefs")
    .select("prefs")
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const prefs = (data?.prefs ?? {}) as Record<string, unknown>;
  return prefs[FORECAST_CASES_PREF_KEY];
}

async function writeList(orgId: string, list: SavedForecastCase[]): Promise<void> {
  const client = getSupabase();
  if (!client) throw new Error("saved cases need a signed-in session");
  const { error } = await client.rpc("set_org_pref", {
    p_org_id: orgId,
    p_key: FORECAST_CASES_PREF_KEY,
    p_value: list,
  });
  if (error) throw new Error(error.message);
}

/** The saved cases of ONE company, oldest first (the order they were made,
 *  which is the order they sit in the case switch). */
export async function loadForecastCases(orgId: string): Promise<SavedForecastCase[]> {
  return forecastCasesOfCompany(await readBag(orgId), orgId).sort((a, b) =>
    a.savedAt.localeCompare(b.savedAt),
  );
}

function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `fc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Save a case to the named company; returns that company's list. The list
 *  is read fresh immediately before the write and merged by id. */
export async function saveForecastCase(
  orgId: string,
  input: Omit<SavedForecastCase, "id" | "orgId" | "savedAt">,
): Promise<SavedForecastCase[]> {
  const current = forecastCasesOfCompany(await readBag(orgId), orgId);
  const entry: SavedForecastCase = {
    ...input,
    id: newId(),
    orgId,
    savedAt: new Date().toISOString(),
  };
  const next = [...current, entry];
  await writeList(orgId, next);
  return next;
}

/** Remove one saved case of the named company. */
export async function deleteForecastCase(orgId: string, id: string): Promise<SavedForecastCase[]> {
  const next = forecastCasesOfCompany(await readBag(orgId), orgId).filter((c) => c.id !== id);
  await writeList(orgId, next);
  return next;
}
