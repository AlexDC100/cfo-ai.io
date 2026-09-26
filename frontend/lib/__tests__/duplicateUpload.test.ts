// G3 (frontend half) — the same file twice is not stored, not analysed and
// not counted; the user sees "Already uploaded — open it".
//
// MEASURED IN PRODUCTION (2026-09-21): the EEI balance went into one company
// 13 times. The browser's only guard was a window.confirm whose OK button
// uploaded the copy anyway. uploadDocument now asks the engine
// (POST /api/documents/duplicate-check, scoped by X-Org-Id) BEFORE a byte is
// written to storage.
//
// The Supabase SDK is mocked at the module boundary; lib/supabase.ts runs for
// real on top of it, so what reaches storage / the insert is what production
// would send.
//
// WHAT THESE RED ON: a duplicate answer that still uploads to storage or
// inserts a row; a duplicate reported as an error; the check sent without
// the file's SHA-256 or without the active company; an unreachable check
// blocking the upload; a 202 "duplicate" from /api/pipeline/run read as
// "queued"; the EN/RO message drifting from the owner's wording.
import { createHash } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setActiveOrgId } from "@/lib/activeOrg";
import en from "@/i18n/locales/en.json";
import ro from "@/i18n/locales/ro.json";

type Row = Record<string, unknown>;

const state = {
  uploads: [] as string[],
  inserted: [] as Row[],
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
        upload: async (path: string) => {
          state.uploads.push(path);
          return { error: null };
        },
        remove: async () => ({ data: null, error: null }),
      }),
    },
    from: (_table: string) => ({
      insert: (row: Row) => ({
        select: () => ({
          single: async () => {
            state.inserted.push(row);
            return { data: { ...row }, error: null };
          },
        }),
      }),
    }),
  }),
}));

let sb: typeof import("@/lib/supabase");
const ORG = "e23280a9-3f16-4564-b0a7-3f528863c29f";

beforeAll(async () => {
  vi.stubEnv("VITE_SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("VITE_SUPABASE_ANON_KEY", "test-anon-key");
  vi.stubEnv("VITE_API_URL", "https://engine.test");
  setActiveOrgId("u1", ORG);
  sb = await import("@/lib/supabase");
});

afterEach(() => {
  state.uploads = [];
  state.inserted = [];
  vi.unstubAllGlobals();
});

const BYTES = "cont;sold\n401;1200";

function file(): File {
  return new File([BYTES], "Balanta Scandia Food_31.12.2025 LV.xls", {
    type: "application/vnd.ms-excel",
  });
}

// The engine's hash of the same bytes (`_doc_dedupe.sha256_hex`), computed
// independently of the code under test.
const BYTES_SHA256 = createHash("sha256").update(BYTES, "utf8").digest("hex");

describe("uploadDocument — duplicate check before storage", () => {
  it("a duplicate is not stored and not inserted, and is not an error", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        duplicate: true, existing_document_id: "orig-1", period_id: "period-1",
        original_filename: "Balanta Scandia Food_31.12.2025 LV.xls", status: "analyzed",
      }), { status: 200 });
    }));
    const f = file();
    const res = await sb.uploadDocument(f, { scope: "financial", periodEndHint: "2025-12-31" });
    expect(res.row).toBeNull();
    expect(res.error).toBeNull();
    expect(res.duplicate).toEqual({
      existingDocumentId: "orig-1", periodId: "period-1",
      originalFilename: "Balanta Scandia Food_31.12.2025 LV.xls",
    });
    expect(state.uploads).toEqual([]);
    expect(state.inserted).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://engine.test/api/documents/duplicate-check");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["X-Org-Id"]).toBe(ORG);
    expect(headers.Authorization).toBe("Bearer jwt");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      content_hash: BYTES_SHA256, period_end_hint: "2025-12-31", scope: "financial",
    });
  });

  it("a Products (SKU) upload asks about SKU copies only — the SCOPE clause", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ duplicate: false }), { status: 200 });
    }));
    await sb.uploadDocument(file(), { scope: "sku" });
    expect(JSON.parse(String(calls[0].init.body)).scope).toBe("sku");
  });

  it("not a duplicate → the upload proceeds and the row carries the same hash", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ duplicate: false }), { status: 200 })));
    const f = file();
    const res = await sb.uploadDocument(f, { scope: "financial" });
    expect(res.duplicate ?? null).toBeNull();
    expect(res.row).not.toBeNull();
    expect(state.uploads).toHaveLength(1);
    expect(state.inserted[0].content_hash).toBe(BYTES_SHA256);
  });

  it("an unreachable check never blocks the upload (the server repeats it)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const res = await sb.uploadDocument(file(), { scope: "financial" });
    expect(res.row).not.toBeNull();
    expect(state.uploads).toHaveLength(1);
  });
});

describe("enqueuePipeline — a server-side duplicate is its own outcome", () => {
  it("202 {status: duplicate} is 'duplicate', never 'queued'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      document_id: "copy-1", status: "duplicate", existing_document_id: "orig-1", period_id: null,
    }), { status: 202 })));
    expect(await sb.enqueuePipeline("copy-1")).toEqual({
      kind: "duplicate", existingDocumentId: "orig-1", periodId: null,
    });
  });

  it("202 {status: queued} stays queued", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      document_id: "doc-1", status: "queued",
    }), { status: 202 })));
    expect(await sb.enqueuePipeline("doc-1")).toEqual({ kind: "queued" });
  });
});

describe("the message is the owner's wording, in both languages", () => {
  it("EN / RO", () => {
    expect(en.upload.alreadyUploaded).toBe("Already uploaded — open it");
    expect(ro.upload.alreadyUploaded).toBe("Deja încărcat — deschide");
    expect(en.upload.openExisting && ro.upload.openExisting).toBeTruthy();
    expect(en.upload.alreadyUploadedBody && ro.upload.alreadyUploadedBody).toBeTruthy();
  });
});
