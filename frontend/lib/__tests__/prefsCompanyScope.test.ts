// prefs — a company preference belongs to the company it was written for.
//
// Live walkthrough, 2026-09-26: a comparison period chosen on Scandia's
// dashboard came back on EEI's ("No comparison: period '<Scandia id>' is not
// in this workspace"). Two ways the preference layer itself carried a company
// write into another company:
//
//   1. OVERLAY — an unconfirmed write (the RPC in flight, or failed) was kept
//      under its bag key alone and overlaid onto whichever company's bag was
//      read NEXT: after the switch, EEI "had" Scandia's choice.
//   2. RPC TARGET — the write read the active company when the RPC fired,
//      after `await getSession()`; a switch landing in between sent Scandia's
//      value into EEI's org_prefs, where every device then adopted it.
//
// Fails on: another company's pending write shadowing a freshly read bag; the
// RPC naming any company but the one active when the value was set.
import { beforeEach, describe, expect, it, vi } from "vitest";

// Server state: each company's bag. The RPC never resolves — the window
// between the click and the server confirming is exactly when both leaks lived.
const bags: Record<string, Record<string, unknown>> = {};
const rpc = vi.fn((_fn: string, _params: Record<string, unknown>) => new Promise(() => {}));

vi.mock("@/lib/supabase", () => ({
  getSupabase: () => ({
    auth: { getSession: async () => ({ data: { session: { user: { id: "u1" } } } }) },
    from: () => ({
      select: () => ({
        eq: (_col: string, orgId: string) => ({
          maybeSingle: async () => ({ data: { prefs: { ...(bags[orgId] ?? {}) } }, error: null }),
        }),
      }),
    }),
    rpc,
  }),
}));

const { setPref, getRemotePref, hydrateOrgPrefs, prefsOrgId, resetPrefs } = await import("@/lib/prefs");

const SCANDIA = "org-scandia";
const EEI = "org-eei";
const SCANDIA_CHOICE = { priorPeriodId: "period-scandia-2024", columns: { prior: true, delta: true, deltaPct: true, share: true } };

describe("prefs — a company write stays with its company", () => {
  beforeEach(() => {
    resetPrefs();
    rpc.mockClear();
    for (const k of Object.keys(bags)) delete bags[k];
    bags[SCANDIA] = {};
    bags[EEI] = {};
  });

  it("an unconfirmed Scandia write is never read as EEI's", async () => {
    await hydrateOrgPrefs(SCANDIA);
    setPref("org", "comparatives_view", SCANDIA_CHOICE);
    expect(getRemotePref("org", "comparatives_view")).toEqual(SCANDIA_CHOICE);

    // The switch: EEI's bag is read while Scandia's write is still in flight.
    await hydrateOrgPrefs(EEI);
    expect(getRemotePref("org", "comparatives_view"), "Scandia's choice overlaid onto EEI's bag").toBeUndefined();
    expect(prefsOrgId()).toBe(EEI);

    // Back on Scandia, the unconfirmed write still wins over a stale read.
    await hydrateOrgPrefs(SCANDIA);
    expect(getRemotePref("org", "comparatives_view")).toEqual(SCANDIA_CHOICE);
  });

  it("the write is sent for the company it was made on, even when the switch lands first", async () => {
    await hydrateOrgPrefs(SCANDIA);
    setPref("org", "comparatives_view", SCANDIA_CHOICE);
    // activateWorkspace → hydrateOrgPrefs(EEI) re-points the bag synchronously,
    // before the write's session read resolves.
    const switching = hydrateOrgPrefs(EEI);
    await switching;
    await new Promise((r) => setTimeout(r, 0));
    const sent = rpc.mock.calls.filter(([fn]) => fn === "set_org_pref");
    expect(sent.length).toBe(1);
    expect(sent[0][1], "Scandia's choice was sent to EEI").toMatchObject({ p_org_id: SCANDIA, p_key: "comparatives_view" });
  });

  it("a write before any company bag is read is not attributed to the company read later", async () => {
    setPref("org", "comparatives_view", SCANDIA_CHOICE);
    await hydrateOrgPrefs(EEI);
    expect(getRemotePref("org", "comparatives_view")).toBeUndefined();
    expect(rpc.mock.calls.filter(([fn]) => fn === "set_org_pref")).toEqual([]);
  });

  it("personal preferences are unchanged: one person, every company", async () => {
    await hydrateOrgPrefs(SCANDIA);
    setPref("user", "theme", "dark");
    await hydrateOrgPrefs(EEI);
    expect(getRemotePref("user", "theme")).toBe("dark");
  });
});
