// A shipped surface must never call an endpoint the backend walls.
//
// WHY THIS EXISTS (2026-09-09, operator hit it in production):
// The workspace onboarding wizard's step-3 dropzone posted to
// /api/upload-excel. On 2026-09-05 that endpoint was walled behind
// LEGACY_SKU_AI_ENABLED, because an anonymous POST reached an Anthropic
// completion with no bearer, no rate limit and no usage gate. Walling it was
// right. What was wrong: server.py's own justification asserted "UploadDialog
// (the only caller of /api/upload-excel) is mounted nowhere" — and BOTH halves
// were false. Workspace.tsx was a second caller, and it was mounted in the
// primary onboarding flow. Every new workspace ended on a bare "Upload failed
// 404". Nothing failed until a human tried it.
//
// The wall list is READ FROM THE PYTHON SOURCE, not restated here. That is the
// point: if someone walls a new surface tomorrow while a frontend caller still
// exists, this reds on the wall's own terms rather than on a copy of it that
// has quietly gone stale.
//
// WHAT IT REDS ON, with the defect repaired (TC-11):
//   · a new frontend call site for /api/upload-excel or /api/analyze
//   · a new path added to _is_legacy_sku_ai() that some surface already calls
//   · the wall-parsing itself breaking (server.py refactored past recognition)
//     — which fails loudly rather than silently passing on an empty list
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO = join(__dirname, "..", "..", "..");
const SERVER_PY = join(REPO, "src", "engine", "api", "server.py");
const FRONTEND = join(REPO, "frontend");

/** The literal paths `_is_legacy_sku_ai()` walls, parsed from server.py. */
function walledLiteralPaths(): string[] {
  const src = readFileSync(SERVER_PY, "utf-8");
  const fn = src.match(/def _is_legacy_sku_ai\([^)]*\):[^\n]*\n((?:\s+.*\n)+?)\n/);
  if (!fn) throw new Error("could not find _is_legacy_sku_ai() in server.py");
  const paths = [...fn[1].matchAll(/"(\/api\/[^"]+)"/g)].map((m) => m[1]);
  if (!paths.length) throw new Error("parsed _is_legacy_sku_ai() but found no /api/ paths");
  return paths;
}

/** Every frontend source file, excluding tests and generated locales. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "__tests__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) acc.push(full);
  }
  return acc;
}

/** Strip // and /* *​/ comments so a path named in prose is not a "caller". */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("no shipped surface calls a walled endpoint", () => {
  const walled = walledLiteralPaths();

  it("parses the wall list out of server.py", () => {
    // Non-vacuity (TC-3): if this ever came back empty the suite below would
    // pass by checking nothing at all.
    expect(walled.length).toBeGreaterThan(0);
    expect(walled).toContain("/api/upload-excel");
  });

  it.each(walled)("nothing in frontend/ fetches %s", (path) => {
    const offenders: string[] = [];
    for (const file of sourceFiles(FRONTEND)) {
      const code = stripComments(readFileSync(file, "utf-8"));
      if (code.includes(path)) offenders.push(relative(REPO, file));
    }
    expect(
      offenders,
      `${path} is walled by _is_legacy_sku_ai() in src/engine/api/server.py, so ` +
        `these files reach a JSON 404 in production:\n  ${offenders.join("\n  ")}\n` +
        `Route them through the financial pipeline (uploadDocument + enqueue, ` +
        `see Workspace.tsx routeToFinancialPipeline) or the modern SKU scope ` +
        `(uploadDocument({scope:"sku"}), see Products.tsx).`,
    ).toEqual([]);
  });
});
