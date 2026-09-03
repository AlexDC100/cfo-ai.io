// Cold-boot workspace resolution — the "false zero" lock.
//
// The defect these tests reproduce (measured live 2026-09-01, recorded in
// design_review/capsule-craft/GATES-period.md §1): on the FIRST page load of
// a fresh browser context the app finishes boot with NO active workspace.
//
// Mechanism, in order:
//   1. PUBLIC_TEST_MODE's AuthProvider reports `signed_in` SYNCHRONOUSLY
//      (synthetic identity) while the real Supabase session arrives async
//      from GET /api/test-mode/session.
//   2. useActiveOrg().load() therefore runs while `auth.getSession()` still
//      has no user, and fetchOrgsForUser() reports `{orgs: [], error:false}`
//      — an empty list that is NOT a true zero, never having called
//      list_workspaces at all.
//   3. shouldEnsureDefaultWorkspace(false, 0) is true, so ensure-default
//      creates a workspace on that false zero (8,498 junk "Test workspace"
//      rows in the project as of 2026-09-01).
//   4. The false zero is memoised in the module-global cachedOrgListPromise
//      and every OTHER mounted useActiveOrg() instance awaits the same
//      promise. Only the one that wins `ensuredDefaultFor` re-fetches; the
//      losers commit `all: []` (org === null) and, because the empty list is
//      classed as trusted, resolveActive() CLEARS the remembered active org.
//   5. load()'s deps are [status, userId] — both stable — so nothing re-runs
//      once the session lands. The page stays workspace-less until reload.
//
// Downstream: usePeriodStepper's direct feed is `enabled: !!org?.id`, so the
// merged period list stays empty and every surface reading it renders as if
// the workspace had no periods.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act } from "@testing-library/react";
import { useEffect } from "react";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const SEEDED_ORG_ID = "00000000-0000-4000-8000-000000000002";

type AuthShape = { status: string; user: { id: string } | null };

// Mutable per-test state the mocked modules read.
let authState: AuthShape;
let sessionUser: { id: string } | null;
let rpcCalls: string[];
let listWorkspacesRows: Array<Record<string, unknown>>;
let createdCount: number;

function seededOrg(id: string, name: string) {
  return {
    id,
    name,
    industry_key: "food_manufacturing",
    industry_display_name: "Food manufacturing",
    default_currency: "RON",
    role: "owner",
    archived_at: null,
    purge_after: null,
    created_at: "2026-01-01T00:00:00Z",
  };
}

// A supabase-js double covering exactly the surface lib/org.ts touches.
function makeClient() {
  return {
    auth: {
      getSession: async () => ({
        data: { session: sessionUser ? { user: sessionUser } : null },
      }),
      onAuthStateChange: () => ({
        data: { subscription: { unsubscribe: () => {} } },
      }),
    },
    rpc: async (name: string, _args?: unknown) => {
      rpcCalls.push(name);
      if (!sessionUser) {
        // RLS: an anon call can neither list nor create.
        return { data: null, error: { message: "JWT missing" } };
      }
      if (name === "list_workspaces") return { data: listWorkspacesRows, error: null };
      if (name === "create_workspace") {
        createdCount += 1;
        const id = `created-${createdCount}`;
        listWorkspacesRows = [...listWorkspacesRows, seededOrg(id, "Test workspace")];
        return { data: id, error: null };
      }
      return { data: null, error: null };
    },
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
      }),
      upsert: async () => ({ error: null }),
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
  };
}

let client: ReturnType<typeof makeClient>;

vi.mock("@/lib/supabase", () => ({
  getSupabase: () => client,
  supabaseEnabled: true,
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => authState }));
vi.mock("@/lib/prefs", () => ({
  hydrateOrgPrefs: vi.fn(),
  hydrateUserPrefs: vi.fn(),
  resetPrefs: vi.fn(),
}));
vi.mock("@/lib/dataPresence", () => ({ clearDataPresence: vi.fn() }));
vi.mock("@/lib/clearWorkspaceData", () => ({ clearWorkspaceScopedData: vi.fn() }));
vi.mock("@/lib/queryClient", () => ({ queryClient: { clear: vi.fn() } }));
vi.mock("@/lib/workspaceName", () => ({ writeWorkspaceName: vi.fn() }));

/** Let every pending microtask + awaited promise chain settle. Rounds are
 *  real-time so they cover org.ts's bounded session wait (SESSION_POLL_MS). */
async function settle(rounds = 12) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 25));
    });
  }
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  client = makeClient();
  rpcCalls = [];
  createdCount = 0;
  sessionUser = null;
  listWorkspacesRows = [seededOrg(SEEDED_ORG_ID, "Test workspace")];
  authState = { status: "signed_in", user: { id: USER_ID } };
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Mount N useActiveOrg() consumers the way the real shell does (AuthGuard,
 * AppShell/usePeriodStepper, useEnsureCurrentPeriod, the chat store …) and
 * report each instance's state to the caller.
 */
async function mountConsumers(count: number) {
  const { useActiveOrg } = await import("@/lib/org");
  const states: Array<{ org: unknown; orgs: unknown[]; loading: boolean }> = [];

  function Consumer({ idx }: { idx: number }) {
    const state = useActiveOrg();
    useEffect(() => {
      states[idx] = { org: state.org, orgs: state.orgs, loading: state.loading };
    });
    return null;
  }

  function Shell() {
    return (
      <>
        {Array.from({ length: count }, (_, i) => (
          <Consumer key={i} idx={i} />
        ))}
      </>
    );
  }

  await act(async () => {
    render(<Shell />);
  });
  return states;
}

describe("cold boot — session arrives AFTER the app reports signed_in", () => {
  it("never treats 'no session yet' as a zero-workspace account", async () => {
    // The test-mode ordering: signed_in now, session in ~170ms.
    setTimeout(() => {
      sessionUser = { id: USER_ID };
    }, 20);

    const states = await mountConsumers(3);
    await settle();

    expect(
      rpcCalls.filter((c) => c === "create_workspace"),
      "ensure-default must not fire before the session lands",
    ).toHaveLength(0);
    expect(createdCount, "no junk workspace may be created on a cold boot").toBe(0);
    // …and the list must actually have been asked for.
    expect(rpcCalls).toContain("list_workspaces");

    // Every mounted consumer resolves the SAME real workspace.
    for (const [i, s] of states.entries()) {
      expect((s.org as { id: string } | null)?.id, `consumer ${i} has no org`).toBe(
        SEEDED_ORG_ID,
      );
    }
  });

  it("resolves the workspace on the FIRST page load — no reload required", async () => {
    setTimeout(() => {
      sessionUser = { id: USER_ID };
    }, 20);

    const states = await mountConsumers(2);
    await settle(40); // stand in for the measured "20 further seconds"

    expect((states[0].org as { id: string } | null)?.id).toBe(SEEDED_ORG_ID);
    expect(states[0].loading).toBe(false);
  });

  it("keeps the remembered active workspace instead of clearing it", async () => {
    const { setActiveOrgId } = await import("@/lib/activeOrg");
    setActiveOrgId(USER_ID, SEEDED_ORG_ID);
    setTimeout(() => {
      sessionUser = { id: USER_ID };
    }, 20);

    await mountConsumers(3);
    await settle();

    const { getActiveOrgId } = await import("@/lib/activeOrg");
    expect(getActiveOrgId(USER_ID)).toBe(SEEDED_ORG_ID);
  });
});

describe("a genuinely empty account still gets its default workspace", () => {
  it("creates exactly one workspace on a TRUE zero, and every consumer sees it", async () => {
    sessionUser = { id: USER_ID }; // session present from the first read
    listWorkspacesRows = [];

    const states = await mountConsumers(3);
    await settle();

    expect(createdCount, "exactly one workspace for a true zero").toBe(1);
    // Only one instance wins ensureDefaultWorkspace's per-user guard; the
    // others must still end up holding the workspace it created.
    for (const [i, s] of states.entries()) {
      expect((s.org as { name: string } | null)?.name, `consumer ${i}`).toBe(
        "Test workspace",
      );
    }
  });
});

describe("a session that never arrives is a retry state, not a zero", () => {
  it("surfaces loadError and creates nothing when the session never lands", async () => {
    // sessionUser stays null for the whole window.
    const { useActiveOrg } = await import("@/lib/org");
    let last: { org: unknown; loadError: boolean; loading: boolean } | null = null;

    function Consumer() {
      const s = useActiveOrg();
      useEffect(() => {
        last = { org: s.org, loadError: s.loadError, loading: s.loading };
      });
      return null;
    }

    vi.useFakeTimers();
    await act(async () => {
      render(<Consumer />);
    });
    // Burn through the bounded session wait.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    vi.useRealTimers();
    await settle();

    expect(createdCount, "never auto-create without a session").toBe(0);
    expect(rpcCalls).not.toContain("create_workspace");
    expect(last!.loadError, "the UI must offer retry, not the create wizard").toBe(true);
    expect(last!.loading).toBe(false);
    expect(last!.org).toBeNull();
  });
});

describe("PUBLIC_TEST_MODE ordering", () => {
  it("awaits the shared session bootstrap before reading the workspace list", async () => {
    const order: string[] = [];
    vi.doMock("@/lib/testMode", () => ({
      isPublicTestMode: true,
      TEST_USER_ID: USER_ID,
      TEST_ORG_ID: SEEDED_ORG_ID,
      TEST_WORKSPACE_LABEL: "Test workspace",
      TEST_USER_EMAIL: "test@cfo-ai.io",
      TEST_DISPLAY_NAME: "Test visitor",
    }));
    vi.doMock("@/lib/testModeSession", () => ({
      ensureTestModeSession: async () => {
        order.push("ensureTestModeSession");
        await new Promise((r) => setTimeout(r, 30));
        sessionUser = { id: USER_ID }; // what setSession() does
        return true;
      },
      resetTestModeSession: () => {},
    }));

    const { useActiveOrg } = await import("@/lib/org");
    let last: { org: unknown } | null = null;
    function Consumer() {
      const s = useActiveOrg();
      useEffect(() => {
        last = { org: s.org };
      });
      return null;
    }
    await act(async () => {
      render(<Consumer />);
    });
    await settle();

    expect(order, "the bootstrap must be awaited, not raced").toEqual([
      "ensureTestModeSession",
    ]);
    expect(createdCount, "no junk 'Test workspace' clone").toBe(0);
    expect((last!.org as { id: string } | null)?.id).toBe(SEEDED_ORG_ID);
  });
});
