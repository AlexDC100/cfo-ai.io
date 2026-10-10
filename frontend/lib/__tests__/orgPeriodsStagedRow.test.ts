// GATE rerun-refusal-surfaces (F5): A RE-RUN'S STAGED ROW IS NEVER A PERIOD
// IN THE WORKSPACE TAB.
//
// "Re-run analysis" persists under a STAGED row beside the file's month
// (engine gate rerun-data-loss): a `financial_periods` row that names NO
// source document and carries a marker in its envelope. The Workspace tab
// reads `financial_periods` DIRECTLY (under the reader's own row-level
// security — no engine in between), so the engine's guards do not cover it:
// unfiltered, the month showed a second, empty card while a re-run was going
// and for as long as a dead run's row was left.
//
// WHAT IS REAL: `fetchWorkspacePeriodsDirect` and `isStagedRerunRow`. The
// Supabase client is a recording fake of the query builder (what was
// selected, on which table) answering with rows shaped as PostgREST answers
// that select.
//
// Fails on: the staged row listed as a period; an EMPTY CONTAINER (no
// source, no marker — a period a user made) dropped with it; a period that
// names its document dropped because something in its envelope looks like a
// marker; the select no longer asking for the source or the marker (the
// filter would then drop nothing — or everything); the WHOLE envelope
// selected to find the marker (it is ~200 KB per period).
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const state = {
    periods: [] as Record<string, unknown>[],
    documents: [] as Record<string, unknown>[],
    selects: [] as { table: string; select: string }[],
  };
  const query = (table: string) => {
    const q: Record<string, unknown> = {};
    for (const op of ["eq", "in", "is", "order"]) q[op] = () => q;
    q.select = (columns: string) => {
      state.selects.push({ table, select: columns });
      return q;
    };
    // The builder is awaited: PostgREST's answer for the table.
    q.then = (resolve: (v: unknown) => unknown) =>
      resolve({ data: table === "financial_periods" ? state.periods : state.documents, error: null });
    return q;
  };
  return { state, client: { from: (table: string) => query(table) } };
});

vi.mock("@/lib/supabase", () => ({ getSupabase: () => fake.client }));

import { WORKSPACE_PERIODS_SELECT, fetchWorkspacePeriodsDirect, isStagedRerunRow } from "@/lib/orgPeriods";

const ORG = "0d0c0000-0000-4000-8000-00000000000a";
const MONTH = "0d0c0000-0000-4000-8000-0000000000b1";      // the month's own row
const STAGED = "0d0c0000-0000-4000-8000-0000000057a6";     // the re-run's staged row
const EMPTY = "0d0c0000-0000-4000-8000-0000000000e0";      // a container a user made, no file yet
const DOC = "0d0c0000-0000-4000-8000-0000000000d1";

/** The marker as the engine writes it (src/engine/api/_staged_rerun.py). */
const MARKER = { document_id: DOC, served_period_id: MONTH, staged_at: "2026-10-04T10:00:00+00:00" };

const row = (id: string, more: Record<string, unknown>) => ({
  id,
  period_start: "2025-12-31",
  period_end: "2025-12-31",
  currency: "RON",
  created_at: "2026-10-01T10:00:00+00:00",
  source_document_id: null,
  staged_rerun: null,
  ...more,
});

beforeEach(() => {
  fake.state.selects.length = 0;
  fake.state.documents = [
    { id: DOC, original_filename: "balanta.xlsx", display_name: null, status: "analyzed", period_id: MONTH,
      created_at: "2026-10-01T10:00:00+00:00", scope: "financial" },
  ];
  fake.state.periods = [
    row(STAGED, { staged_rerun: MARKER, created_at: "2026-10-04T10:00:00+00:00" }),
    row(MONTH, { source_document_id: DOC }),
    row(EMPTY, { period_start: "2025-11-30", period_end: "2025-11-30" }),
  ];
});

describe("F5 — the Workspace tab's own read of financial_periods", () => {
  it("drops the staged row and keeps the month and the empty container", async () => {
    const payload = await fetchWorkspacePeriodsDirect(ORG);
    expect(payload?.periods.map((p) => p.period_id)).toEqual([MONTH, EMPTY]);
    expect(payload?.periods[0].documents.map((d) => d.id)).toEqual([DOC]);
    expect(payload?.periods[1].documents).toEqual([]);
  });

  it("with the re-run committed (its takeover began) the staged row is still not a period", async () => {
    fake.state.periods[0] = row(STAGED, {
      staged_rerun: { ...MARKER, takeover_began_at: "2026-10-04T10:01:00+00:00", keep_briefing_reason: null, emptied: [] },
    });
    expect((await fetchWorkspacePeriodsDirect(ORG))?.periods.map((p) => p.period_id)).toEqual([MONTH, EMPTY]);
  });

  it("asks PostgREST for the source and the marker alone — never the envelope", async () => {
    await fetchWorkspacePeriodsDirect(ORG);
    const periodSelects = fake.state.selects.filter((s) => s.table === "financial_periods");
    expect(periodSelects).toHaveLength(1);
    const terms = periodSelects[0].select.split(",").map((t) => t.trim());
    expect(terms).toContain("source_document_id");
    // the alias the engine selects too (pipeline: _staged_rerun.MARKER_SELECT)
    expect(terms).toContain("staged_rerun:assembled_canonical_v1->staged_rerun");
    expect(terms).not.toContain("assembled_canonical_v1");
    expect(terms).not.toContain("*");
    expect(periodSelects[0].select).toBe(WORKSPACE_PERIODS_SELECT);
  });

  it("the staged row's documents are not asked for (it has none: a document is never pinned to it)", async () => {
    const seen: unknown[] = [];
    const client = fake.client as unknown as { from: (t: string) => Record<string, unknown> };
    const realFrom = client.from;
    client.from = (table: string) => {
      const q = realFrom(table);
      const realIn = q.in as (c: string, v: unknown) => unknown;
      q.in = (column: string, values: unknown) => {
        seen.push([table, column, values]);
        return realIn(column, values);
      };
      return q;
    };
    try {
      await fetchWorkspacePeriodsDirect(ORG);
    } finally {
      client.from = realFrom;
    }
    expect(seen).toEqual([["documents", "period_id", [MONTH, EMPTY]]]);
  });
});

describe("F5 — what a staged row is", () => {
  it("no source AND a marker object — nothing else", () => {
    expect(isStagedRerunRow(row(STAGED, { staged_rerun: MARKER }))).toBe(true);
    const periods: Record<string, unknown>[] = [
      row(MONTH, { source_document_id: DOC }),                            // the month
      row(MONTH, { source_document_id: DOC, staged_rerun: MARKER }),      // names its document: never staged
      row(EMPTY, {}),                                                     // an empty container
      row(EMPTY, { staged_rerun: undefined }),
      row(EMPTY, { staged_rerun: "staged" }),                             // not a marker object
      row(EMPTY, { staged_rerun: [MARKER] }),
      row(EMPTY, { staged_rerun: 1 }),
    ];
    for (const p of periods) expect(isStagedRerunRow(p), JSON.stringify(p)).toBe(false);
  });
});
