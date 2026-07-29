// prefs — a local write must survive a stale server read.
//
// Operator-reported 2026-07-26: the RON/EUR/USD toggle snapped back to RON a
// moment after clicking. Cause: `useActiveOrg` is mounted by many components
// and every mount re-runs hydrateOrgPrefs(). One firing between the click and
// the set_org_pref round-trip re-read the OLD currency, and usePrefSync
// "adopted" it — reverting the user. Same outcome, permanently, if the RPC
// itself fails (migration not applied / offline / RLS).

import { describe, it, expect, beforeEach, vi } from "vitest";

// The RPC never resolves in this suite: that models the window between the
// click and the server confirming — exactly when the revert used to happen.
const rpc = vi.fn(() => new Promise(() => {}));
const maybeSingle = vi.fn(async () => ({ data: { prefs: { currency_display: "RON" } }, error: null }));

vi.mock("@/lib/supabase", () => ({
  getSupabase: () => ({
    auth: { getSession: async () => ({ data: { session: { user: { id: "u1" } } } }) },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
    rpc,
  }),
}));

const { setPref, getRemotePref, hydrateOrgPrefs, resetPrefs } = await import("@/lib/prefs");

describe("prefs — local write precedence", () => {
  beforeEach(() => {
    resetPrefs();
    rpc.mockClear();
  });

  it("keeps the just-written value when hydration re-reads the old one", async () => {
    // Server currently says RON.
    await hydrateOrgPrefs("org-1");
    expect(getRemotePref("org", "currency_display")).toBe("RON");

    // User picks EUR. The RPC is in flight (never resolves here).
    setPref("org", "currency_display", "EUR");
    expect(getRemotePref("org", "currency_display")).toBe("EUR");

    // A sibling useActiveOrg mount re-hydrates mid-flight and reads stale RON.
    await hydrateOrgPrefs("org-1");

    // Before the fix this returned "RON" and usePrefSync reverted the toggle.
    expect(getRemotePref("org", "currency_display")).toBe("EUR");
  });

  it("does not leak a pending write across sign-out", async () => {
    await hydrateOrgPrefs("org-1");
    setPref("org", "currency_display", "USD");
    expect(getRemotePref("org", "currency_display")).toBe("USD");

    resetPrefs();
    await hydrateOrgPrefs("org-1");
    expect(getRemotePref("org", "currency_display")).toBe("RON");
  });
});
