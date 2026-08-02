// Workspace-flow fix (2026-08-02) — unit locks for the workspace dead-end
// repairs. The heavy paths (RPC, Supabase session) are exercised by the E2E
// flow; these lock the pure decision logic so a refactor can't silently
// reintroduce the two bugs they encode:
//   1. auto-create fired on a FAILED list fetch (duplicate-workspace risk)
//   2. auto-create fired for archived-only users (racing their Restore)

import { describe, it, expect } from "vitest";
import {
  shouldEnsureDefaultWorkspace,
  activeWorkspaces,
  archivedWorkspaces,
  type Organization,
} from "@/lib/org";

function org(id: string, archived: boolean): Organization {
  return {
    id,
    name: id,
    industry_key: null,
    industry_display_name: null,
    default_currency: null,
    role: "owner",
    archived_at: archived ? "2026-08-01T00:00:00Z" : null,
    purge_after: archived ? "2026-08-31T00:00:00Z" : null,
    created_at: "2026-01-01T00:00:00Z",
  };
}

describe("shouldEnsureDefaultWorkspace", () => {
  it("creates on a TRUE zero (fetch ok, no orgs at all)", () => {
    expect(shouldEnsureDefaultWorkspace(false, 0)).toBe(true);
  });
  it("never creates on a fetch ERROR — the user may have workspaces", () => {
    expect(shouldEnsureDefaultWorkspace(true, 0)).toBe(false);
  });
  it("never creates when any org exists (live or archived)", () => {
    expect(shouldEnsureDefaultWorkspace(false, 1)).toBe(false);
    expect(shouldEnsureDefaultWorkspace(false, 3)).toBe(false);
  });
});

describe("workspace partition helpers", () => {
  const mixed = [org("a", false), org("b", true), org("c", false)];
  it("activeWorkspaces excludes archived", () => {
    expect(activeWorkspaces(mixed).map((o) => o.id)).toEqual(["a", "c"]);
  });
  it("archivedWorkspaces excludes live", () => {
    expect(archivedWorkspaces(mixed).map((o) => o.id)).toEqual(["b"]);
  });
  it("archived-only lists partition to zero live (the /workspace-redirect state)", () => {
    const archivedOnly = [org("x", true)];
    expect(activeWorkspaces(archivedOnly)).toHaveLength(0);
    expect(archivedWorkspaces(archivedOnly)).toHaveLength(1);
    // …and ensure-default must NOT fire for it (count includes archived).
    expect(shouldEnsureDefaultWorkspace(false, archivedOnly.length)).toBe(false);
  });
});
