// PERIOD-ASSIGNMENT INTEGRITY — W1 at the wire (the frontend half of the
// gate battery; the engine half is tests/engine/test_period_integrity_gates.py,
// the law is written up in design_review/period/GATES.md).
//
// THE DEFECT THIS PINS SHUT
// ─────────────────────────
// `documents.period_end_hint` is a CONFIRMATION channel: it means "a
// human confirmed that THIS document belongs to THIS month". The
// engine's `stage_persist` ranks it ABOVE its own detection precisely
// because of that meaning. The workspace UI filled it with the DROP
// TARGET's date — a number read off a period row, never off the
// document — so the engine dutifully discarded correct detections. The
// 2026-08-30 production audit found every mismatched row carrying
// `hint == stored`: a 2025 Carniprod trial balance filed under 2017-12.
//
// The source-level law ("no uploadDocument call site may pass a period
// ROW's date into periodEndHint") is enforced once, by the scanner in
// tests/engine/test_period_integrity_gates.py, so it lands in the
// battery record. What is proven HERE is the thing a scanner cannot
// see: what the row that reaches `documents.insert()` actually contains
// — that an absent confirmation writes NOTHING (ABSENT != ZERO at the
// wire), that a real confirmation still travels, and that no ambient UI
// state can ride along on the insert.
//
// The Supabase SDK is mocked at the module boundary; lib/supabase.ts
// runs for real on top of it, so the row asserted below is the row
// production would send.

import { readFileSync } from "node:fs";
import path from "node:path";
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

function file(name = "Carniprod Trial Balance 2025.xlsx"): File {
  return new File(["cont;sold"], name, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

describe("W1 — the confirmation channel at the wire", () => {
  it("writes NOTHING when no human confirmed a month (ABSENT != ZERO)", async () => {
    // The reported case in miniature: a 2025 file uploaded with no
    // confirmation. The row must carry no hint at all, so the engine
    // reaches its own detection (filename → 2025-12-31) instead of
    // being overridden by a date nobody read off the document.
    const { error } = await uploadDocument(file(), { scope: "financial" });
    expect(error).toBeNull();
    expect(state.inserted).toHaveLength(1);
    expect("period_end_hint" in state.inserted[0]).toBe(false);
  });

  it("treats an explicit null the same as absent — never a placeholder date", async () => {
    const { error } = await uploadDocument(file(), {
      scope: "financial",
      periodEndHint: null,
    });
    expect(error).toBeNull();
    expect("period_end_hint" in state.inserted[0]).toBe(false);
  });

  it("still carries a date the human DID confirm — the channel is not disabled", async () => {
    // The fix is semantic, not a removal: a confirmed date must keep
    // travelling, or a human could no longer correct a document the
    // engine reads wrongly.
    const { error } = await uploadDocument(file(), {
      scope: "financial",
      periodEndHint: "2025-12-31",
    });
    expect(error).toBeNull();
    expect(state.inserted[0].period_end_hint).toBe("2025-12-31");
  });

  it("puts no other period-derived date on the insert row", async () => {
    // Ambient UI state — the open period, the drop target, the month in
    // the stepper — must not reach the row through some other column.
    // A key-set assertion catches a future 'helpful' addition that a
    // per-key check would miss.
    await uploadDocument(file(), { scope: "financial" });
    const keys = Object.keys(state.inserted[0]).sort();
    expect(keys).toEqual([
      "detected_type",
      "id",
      "mime_type",
      "org_id",
      "original_filename",
      "scope",
      "size_bytes",
      "status",
      "storage_path",
      "uploaded_by",
    ]);
  });

  it("never loses the upload to an unmigrated hint column", async () => {
    // The degrade path matters for W1: if a failed hint insert cost the
    // user their upload, the pressure would be to keep filling the
    // channel with something — anything — that always works.
    state.insertErrors = [
      { message: "Could not find the 'period_end_hint' column of 'documents'" },
      null,
    ];
    const { row, error } = await uploadDocument(file(), {
      scope: "financial",
      periodEndHint: "2025-12-31",
    });
    expect(error).toBeNull();
    expect(row).not.toBeNull();
    expect(state.inserted).toHaveLength(1);
    expect("period_end_hint" in state.inserted[0]).toBe(false);
  });
});

describe("W1 — UI state cannot ride along to the detection service", () => {
  // The engine's POST model is `extra="forbid"` (422 on an unknown key)
  // and GET has no such parameter, so this is belt-and-braces — but the
  // client is where a well-meaning "help the engine out" edit would be
  // made, and a 422 in production is a worse way to find out.
  const CLIENT = path.resolve(__dirname, "../periodDetect.ts");

  it("sends no open/active/target period key to /api/period/detect", () => {
    let source: string;
    try {
      source = readFileSync(CLIENT, "utf-8");
    } catch {
      // The detect client is Part C's file. Absent here means Part C
      // hasn't landed; the engine-side gates still hold the line.
      return;
    }
    const body = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/[^\n]*/g, "");
    for (const banned of [
      "open_period_end",
      "openPeriodEnd",
      "active_period_end",
      "activePeriodEnd",
      "target_period_end",
      "targetPeriodEnd",
    ]) {
      expect(
        body.includes(banned),
        `periodDetect.ts references ${banned} — the period a document belongs ` +
          `to must be read off the DOCUMENT, never off whatever the UI has open.`,
      ).toBe(false);
    }
  });
});
