// GATE (2026-09-20 P0): a FAILED upload never takes over a surface, and the
// refusal path never depends on a lazily fetched chunk.
//
// Scope printed by the last test: every .ts/.tsx under frontend/ (tests and
// node_modules excluded). Fails on: `failed` classified as a takeover; a
// day-old failed entry restored; any dynamic import of lib/uploadRefusals; the
// dashboard feeding the scan view from anything but `takeover`.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { splitSurfaceUpload, type UploadDoc } from "@/lib/uploadStore";

const doc = (over: Partial<UploadDoc>): UploadDoc => ({
  docId: "d1", filename: "tb.xlsx", status: "queued", surface: "dashboard",
  startedAt: 1, updatedAt: 1, error: null, periodId: null, ...over,
});

describe("splitSurfaceUpload", () => {
  it("failed is a banner, never a takeover", () => {
    const failed = doc({ status: "failed", error: "boom" });
    expect(splitSurfaceUpload(failed, "dashboard")).toEqual({ takeover: null, failed });
  });
  it("every non-failed status is a takeover on its own surface only", () => {
    for (const status of ["queued", "extracting", "mapping", "computing", "narrating", "analyzed"] as const) {
      const d = doc({ status });
      expect(splitSurfaceUpload(d, "dashboard")).toEqual({ takeover: d, failed: null });
      expect(splitSurfaceUpload(d, "products")).toEqual({ takeover: null, failed: null });
    }
  });
  it("nothing in the store → nothing on the surface", () => {
    expect(splitSurfaceUpload(null, "dashboard")).toEqual({ takeover: null, failed: null });
  });
});

describe("persisted failed entries", () => {
  beforeEach(() => { localStorage.clear(); vi.resetModules(); });
  const persist = (ageMs: number) => localStorage.setItem("cfo-upload-current", JSON.stringify(
    doc({ status: "failed", error: "boom", startedAt: Date.now() - ageMs, updatedAt: Date.now() - ageMs })));

  it("a fresh failure is restored (so its banner and actions show)", async () => {
    persist(60_000);
    const { readUploadStore } = await import("@/lib/uploadStore");
    expect(readUploadStore().current?.status).toBe("failed");
  });
  it("a failure older than a day is dropped", async () => {
    persist(25 * 60 * 60 * 1000);
    const { readUploadStore } = await import("@/lib/uploadStore");
    expect(readUploadStore().current).toBeNull();
  });
});

describe("source contracts", () => {
  const ROOT = resolve(__dirname, "../..");
  const files: string[] = [];
  (function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "__tests__" || name === "dist") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name)) files.push(p);
    }
  })(ROOT);

  it("lib/uploadRefusals is never imported dynamically", () => {
    const offenders = files.filter((f) => /import\(\s*["']@\/lib\/uploadRefusals["']\s*\)/.test(readFileSync(f, "utf8")));
    console.info(`[gate] scanned ${files.length} source files for a lazy uploadRefusals import`);
    expect(files.length).toBeGreaterThan(300);
    expect(offenders).toEqual([]);
    expect(readFileSync(join(ROOT, "lib/supabase.ts"), "utf8"))
      .toMatch(/^import \{[^}]*parseUploadRefusal[^}]*\} from "@\/lib\/uploadRefusals";$/m);
  });

  it("the dashboard's scan view is fed by `takeover` only, and the failed banner is mounted", () => {
    const src = readFileSync(join(ROOT, "pages/cfo/FinancialStatements.tsx"), "utf8");
    expect(src).toMatch(/const \{ takeover: uploadInFlight, failed: failedUpload \} = splitSurfaceUpload\(_upload, "dashboard"\);/);
    expect(src).toMatch(/\{failedUpload && \(\s*<FailedUploadBanner/);
  });
});
