// AI LANE — jurisdiction_hint travels on the upload call (mirrors the
// period_end_hint pattern in lib/supabase.ts exactly): included on the
// documents insert only when the user picked a country, absent on
// Auto-detect, and gracefully dropped (retry without the column) when the
// jurisdiction_hint migration hasn't been applied yet.
//
// The Supabase SDK is mocked at the module boundary; lib/supabase.ts runs
// for real on top of it, so the row that reaches `.insert()` is the row
// production would send.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setActiveOrgId } from "@/lib/activeOrg";

type Row = Record<string, unknown>;

const state = {
  inserted: [] as Row[],
  /** Errors to serve for the next insert calls, in order (null = success). */
  insertErrors: [] as ({ message: string } | null)[],
};

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      getSession: async () => ({
        data: { session: { user: { id: "u1" }, access_token: "jwt" } },
      }),
    },
    storage: {
      from: () => ({
        upload: async () => ({ error: null }),
        remove: async () => ({ data: null, error: null }),
      }),
    },
    from: (_table: string) => ({
      // Content-hash dedupe SELECT chain — throwing is the sanctioned
      // shortcut: uploadDocument wraps the whole dedupe in try/catch and
      // proceeds without it ("dedupe skipped").
      select: () => {
        throw new Error("dedupe select not mocked");
      },
      insert: (row: Row) => ({
        select: () => ({
          single: async () => {
            const err = state.insertErrors.shift() ?? null;
            if (err) return { data: null, error: err };
            state.inserted.push(row);
            return { data: { ...row }, error: null };
          },
        }),
      }),
    }),
  }),
}));

let uploadDocument: typeof import("@/lib/supabase").uploadDocument;

beforeAll(async () => {
  // Env must exist BEFORE lib/supabase.ts is imported — its client is
  // created at module load. stubEnv + dynamic import keeps the order.
  vi.stubEnv("VITE_SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("VITE_SUPABASE_ANON_KEY", "test-anon-key");
  setActiveOrgId("u1", "org-1");
  ({ uploadDocument } = await import("@/lib/supabase"));
});

afterEach(() => {
  state.inserted = [];
  state.insertErrors = [];
});

function file(name = "balanta_dec_2025.xlsx"): File {
  return new File(["cont;sold"], name, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

describe("uploadDocument — jurisdiction_hint travel", () => {
  it("includes jurisdiction_hint on the documents insert when a country was chosen", async () => {
    const { row, error } = await uploadDocument(file(), {
      scope: "financial",
      periodEndHint: "2025-12-31",
      jurisdictionHint: "HU",
    });
    expect(error).toBeNull();
    expect(row).not.toBeNull();
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0].jurisdiction_hint).toBe("HU");
    // …and rides ALONGSIDE the existing period hint, same shape.
    expect(state.inserted[0].period_end_hint).toBe("2025-12-31");
    expect(state.inserted[0].scope).toBe("financial");
  });

  it("omits the column entirely on Auto-detect (null hint)", async () => {
    const { error } = await uploadDocument(file(), {
      scope: "financial",
      jurisdictionHint: null,
    });
    expect(error).toBeNull();
    expect(state.inserted).toHaveLength(1);
    expect("jurisdiction_hint" in state.inserted[0]).toBe(false);
  });

  it("gracefully degrades when the jurisdiction_hint column isn't migrated — retries without it", async () => {
    state.insertErrors = [
      { message: "Could not find the 'jurisdiction_hint' column of 'documents'" },
      null,
    ];
    const { row, error } = await uploadDocument(file(), {
      scope: "financial",
      jurisdictionHint: "RO",
    });
    expect(error).toBeNull();
    expect(row).not.toBeNull();
    // The retry row landed without the unmigrated column — the upload
    // itself is never lost to a missing hint column.
    expect(state.inserted).toHaveLength(1);
    expect("jurisdiction_hint" in state.inserted[0]).toBe(false);
  });
});
