// GATE (2026-09-20, measured on production): a page with its OWN fetch to an
// org-resolving engine route sent Authorization without X-Org-Id. The engine
// fell back to the caller's oldest workspace and answered 403 "Period belongs
// to a different organization" — Benchmark was dead on every workspace but the
// user's first.
//
// Scope (printed): every .ts/.tsx under frontend/ except tests and cfoApi.ts
// (whose call() chokepoint attaches the header itself). Fails on: a raw
// fetch( to /api/benchmarks, /api/industry, /api/forecast, /api/radar or a
// sector-benchmark path in a file that does not build its headers with
// authOrgHeaders; the helper no longer attaching X-Org-Id.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const ROOT = resolve(__dirname, "../..");
// A file is in scope when it NAMES a path in an org-resolving family and does
// its own fetch — not only when the path sits inside the fetch template. The
// first version of this gate missed lib/industryApi.ts, whose request() helper
// builds `${API_URL}${path}`: the picker's detect and save calls 403'd in
// production on the very workspace the benchmark fix had just repaired.
// `/api/period/{id}/sector-benchmark` resolves the org the same way and was
// outside every family above, so the rule had no gate on the sourced sector
// benchmark's own fetch. The wider `/api/period` family is NOT in scope yet:
// ten further files name it and would need auditing one by one.
const FAMILY_PATH = /\/api\/(benchmarks|industry|forecast|radar)\b|\/sector-benchmark\b/;
const OWN_FETCH = /\bfetch\(/;
const FAMILIES = { test: (src: string) => FAMILY_PATH.test(src.replace(/^\s*\/\/.*$/gm, "")) && OWN_FETCH.test(src) };

function sources(): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "__tests__" || name === "dist") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name) && !p.endsWith(join("lib", "cfoApi.ts"))) out.push(p);
    }
  })(ROOT);
  return out;
}

describe("org-scoped raw fetches", () => {
  it("every raw fetch to an org-resolving route family builds its headers with authOrgHeaders", () => {
    const files = sources();
    const hits = files.filter((f) => FAMILIES.test(readFileSync(f, "utf8")));
    const offenders = hits.filter((f) => !/authOrgHeaders\(/.test(readFileSync(f, "utf8")));
    console.info(`[gate] ${files.length} files scanned, ${hits.length} with a raw fetch to an org-resolving family`);
    expect(files.length).toBeGreaterThan(300);
    expect(hits.length).toBeGreaterThanOrEqual(5); // non-vacuity: three benchmark callers, the industry client, the sector benchmark
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });

  it("the helper sends the bearer AND the active workspace", async () => {
    vi.resetModules();
    vi.doMock("@/lib/supabase", () => ({
      getSupabase: () => ({ auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) } }),
      currentOrgId: async () => "e23280a9-3f16-4564-b0a7-3f528863c29f",
    }));
    const { authOrgHeaders } = await import("@/lib/apiHeaders");
    expect(await authOrgHeaders()).toEqual({ Authorization: "Bearer tok", "X-Org-Id": "e23280a9-3f16-4564-b0a7-3f528863c29f" });
    vi.doUnmock("@/lib/supabase");
  });

  it("signed out → null, never a half-built header set", async () => {
    vi.resetModules();
    vi.doMock("@/lib/supabase", () => ({
      getSupabase: () => ({ auth: { getSession: async () => ({ data: { session: null } }) } }),
      currentOrgId: async () => "x",
    }));
    const { authOrgHeaders } = await import("@/lib/apiHeaders");
    expect(await authOrgHeaders()).toBeNull();
    vi.doUnmock("@/lib/supabase");
  });
});
