#!/usr/bin/env node
/**
 * G-P5 — THE PDF RENDERER IS WIRED, AND IT IS NOT REACHABLE.
 *
 * `services/pdf/render.mjs` loads CALLER-SUPPLIED HTML into a browser.
 * That is an SSRF and local-file-read primitive by construction, and
 * `scripts/check_report_pdf.mjs` G11 proves the renderer itself closes
 * it. This gate proves the OTHER half — the half a Chromium test can
 * never see — which is that the container running that renderer is not
 * addressable from the public internet, and that the engine route in
 * front of it is actually mounted.
 *
 * Both facts live in files, not in a running process, so they are read
 * out of the files. That is the only form of this assertion that can run
 * on a laptop with no Docker daemon, and it is the form that catches the
 * change that would actually cause the incident: someone adding
 * `scandia_default` to the sidecar's network list, or a `ports:` mapping
 * "just to curl it", in a diff nobody reads closely.
 *
 * WHAT IT REDS ON, once the wiring is correct (TC-11):
 *   W1  the pdf service disappears from `docker-compose.yml`
 *   W2  the pdf service joins `scandia_default` — the network the public
 *       ingress `scandia-caddy` lives in and resolves Docker DNS on
 *   W3  the pdf service publishes a host port (`ports:`), which would
 *       put :8081 on the VPS's public interface
 *   W4  the two containers stop being handed the SAME token expression,
 *       so the engine and the sidecar could hold different secrets and
 *       every render would 401
 *   W5  `_report_pdf.build_router()` stops being mounted in `server.py`,
 *       which is the state this gate was written to end — the route
 *       existed, was tested, and was reachable by nobody
 *   W6  a route in `_report_pdf.py` stops calling `_guard_configured()`,
 *       i.e. stops failing closed when `PDF_SERVICE_TOKEN` is unset
 *   W7  `render.mjs` stops loading the document with `setContent` — i.e.
 *       gives the page a real URL, and therefore an origin that can read
 *       the directory it sits in
 *
 * WHAT IT CANNOT SEE:
 *   · the RUNNING stack. A compose file that says `default` and a daemon
 *     that has the container attached to something else disagree only at
 *     run time; the probe for that is in the deploy runbook
 *     (`docker inspect cfo-ai-pdf --format '{{json .NetworkSettings.Networks}}'`)
 *     and an operator runs it once after the first `up -d`.
 *   · `docker-compose.override.yml`, which is gitignored and local-only.
 *     A developer CAN publish the port on their own machine; that file
 *     never reaches the VPS.
 *   · whether `PDF_SERVICE_TOKEN` is actually SET. It is a secret; it is
 *     not in this repo and must not be. Unset is a safe state — both
 *     sides 503 — which is exactly why W6 is here instead.
 *
 * Run: `node scripts/check_pdf_wiring.mjs`
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// fileURLToPath, not URL.pathname — the repo path contains spaces.
const ROOT = fileURLToPath(new URL("..", import.meta.url));

const failures = [];
const notes = [];
function check(id, ok, message) {
  (ok ? notes : failures).push(`  ${ok ? "ok  " : "FAIL"} ${id}  ${message}`);
}

const compose = readFileSync(join(ROOT, "docker-compose.yml"), "utf-8");
const server = readFileSync(join(ROOT, "src/engine/api/server.py"), "utf-8");
const routeModule = readFileSync(join(ROOT, "src/engine/api/_report_pdf.py"), "utf-8");

// ── the compose block ─────────────────────────────────────────────────
//
// Read by INDENTATION rather than with a YAML parser: adding a parser
// dependency to assert six lines is a worse trade than the twenty lines
// below, and the shape being asserted (two-space service keys under
// `services:`) is fixed by the file's own style. If the file is ever
// re-indented, W1 reds rather than passing over an empty block — the
// failure is visible, which is the property that matters.

function serviceBlock(name) {
  const start = compose.indexOf(`\n  ${name}:\n`);
  if (start < 0) return null;
  const rest = compose.slice(start + 1);
  const lines = rest.split("\n");
  const out = [lines[0]];
  for (const line of lines.slice(1)) {
    // A new service starts at exactly two spaces of indent; a blank line
    // inside a block is not the end of it.
    if (/^ {2}\S/.test(line)) break;
    if (/^\S/.test(line) && line.trim() !== "") break;
    out.push(line);
  }
  return out.join("\n");
}

const pdf = serviceBlock("pdf");
const backend = serviceBlock("backend");

check("W1", pdf !== null, pdf === null
  ? "docker-compose.yml declares no `pdf` service — the renderer is not deployed"
  : "docker-compose.yml declares the `pdf` service");

if (pdf !== null) {
  // The networks list, as WRITTEN. Comments are stripped first: this
  // file's own header explains at length why the sidecar must not join
  // `scandia_default`, and matching that prose would make the gate green
  // on a file that says the right thing and does the wrong one.
  const withoutComments = pdf.replace(/^\s*#.*$/gm, "");
  const netBlock = /\n\s*networks:\s*\n((?:\s*(?:#[^\n]*|-\s*\S+)\s*\n)*)/.exec(withoutComments);
  const nets = netBlock === null
    ? []
    : [...netBlock[1].matchAll(/-\s*([A-Za-z0-9_.-]+)/g)].map((m) => m[1]);
  check(
    "W2",
    nets.length > 0 && !nets.includes("scandia_default"),
    nets.length === 0
      ? "the pdf service declares NO networks — compose would attach it to `default`, " +
        "which happens to be right, but by accident rather than by statement"
      : `pdf networks = [${nets.join(", ")}]` +
        (nets.includes("scandia_default")
          ? " — scandia_default is where the PUBLIC INGRESS lives; a browser-execution "
            + "service on it is one Caddy matcher from the internet"
          : " (scandia-caddy cannot resolve it)"),
  );

  const ports = /\n\s*ports:\s*\n/.test(withoutComments);
  check(
    "W3",
    !ports,
    ports
      ? "the pdf service publishes a HOST PORT — :8081 is on the VPS's public interface"
      : "the pdf service publishes no host port (`expose:` only, container-to-container)",
  );

  // Both containers must be handed the SAME expression, so one .env line
  // feeds both. Two different defaults is a 401 on every render, and the
  // symptom (`the PDF renderer refused the document`) points at the
  // wrong container.
  const tokenIn = (block) => {
    const m = /PDF_SERVICE_TOKEN:\s*(\S+)/.exec((block ?? "").replace(/^\s*#.*$/gm, ""));
    return m === null ? null : m[1];
  };
  const a = tokenIn(backend);
  const b = tokenIn(pdf);
  check(
    "W4",
    a !== null && a === b,
    a === null || b === null
      ? `PDF_SERVICE_TOKEN is passed to backend=${JSON.stringify(a)} pdf=${JSON.stringify(b)} — both must get it`
      : `both containers read PDF_SERVICE_TOKEN from ${a}`,
  );
}

// ── the mount ─────────────────────────────────────────────────────────
//
// The state this gate was written to end: `_report_pdf.py` existed, had
// its own 31-assertion test file, and was mounted in nothing — so every
// one of its routes was a 404 and the product had no PDF at all. An
// import alone is not a mount; both lines are asserted.
const imported = /from \._report_pdf import build_router as (\w+)/.exec(server);
const mounted = imported !== null && new RegExp(`app\\.include_router\\(${imported[1]}\\(\\)\\)`).test(server);
check(
  "W5",
  mounted,
  mounted
    ? `server.py mounts _report_pdf.build_router() as ${imported[1]}()`
    : imported === null
      ? "server.py does not import _report_pdf.build_router — /api/report/pdf is a 404"
      : `server.py imports ${imported[1]} but never calls app.include_router(${imported[1]}())`,
);

// ── fail closed ───────────────────────────────────────────────────────
//
// Every route function in the module must call `_guard_configured()`.
// Counted against the route DECORATORS rather than a fixed number, so
// adding a fourth route without the guard reds instead of inheriting a
// stale count.
const routeCount = (routeModule.match(/@router\.(get|post|put|patch|delete)\(/g) ?? []).length;
const guardCount = (routeModule.match(/_guard_configured\(\)/g) ?? []).length - 1; // minus the def
check(
  "W6",
  routeCount > 0 && guardCount >= routeCount,
  `${guardCount} _guard_configured() calls for ${routeCount} routes` +
    (guardCount >= routeCount
      ? " — every route fails closed when PDF_SERVICE_TOKEN is unset"
      : " — a route renders (or polls) without the shared secret configured"),
);

// ── the document has no origin ────────────────────────────────────────
//
// `renderPdf` must load the caller's HTML with `page.setContent`, which
// leaves the page on `about:blank`: no origin, so no relative reference
// can resolve to anything on disk. The moment it NAVIGATES instead —
// writing the document to a temp file and `goto`-ing it, which is the
// natural refactor the day someone wants `@page` rules resolved against
// a real URL — the page's origin becomes that directory and every
// sibling of the document is readable by a `<iframe src="./x">` the
// caller wrote.
//
// This is asserted HERE, on the source, and not in
// `check_report_pdf.mjs` G11, because G11 cannot see it: measured
// 2026-09-08 by planting exactly that refactor (goto a temp file, plus
// `route()` letting `file:` through), G11 stayed GREEN — the renderer
// wrote the document into a directory of its own choosing, which held
// nothing but the document, so there was no neighbour for the hostile
// page to read and the gate's canary was in a directory the page could
// not reach. The leak is real (a sibling in THAT directory would be
// readable); the black-box gate simply cannot place a canary there.
// One assertion at the source is what covers it.
const renderer = readFileSync(join(ROOT, "services/pdf/render.mjs"), "utf-8")
  // Comments talk at length about `goto`, `file://` and origins; matching
  // them would make this gate green on prose.
  .replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const usesSetContent = /page\.setContent\s*\(/.test(renderer);
const navigates = /page\.goto\s*\(/.test(renderer);
check(
  "W7",
  usesSetContent && !navigates,
  !usesSetContent
    ? "render.mjs no longer calls page.setContent — if it navigates instead, the document has an "
      + "origin and can read the directory it was written into"
    : navigates
      ? "render.mjs calls page.goto — the rendered document has a real origin, and every file "
        + "beside it on disk is readable by markup the caller supplied"
      : "render.mjs loads the document with setContent and never navigates (origin: about:blank)",
);

// ── report ────────────────────────────────────────────────────────────

process.stdout.write("PDF WIRING GATE\n");
process.stdout.write("=".repeat(62) + "\n");
process.stdout.write(
  `GATE-WORK pdf-wiring units=${notes.length + failures.length} floor=7 label=wiring-and-reachability\n`,
);
for (const line of notes) process.stdout.write(line + "\n");
for (const line of failures) process.stdout.write(line + "\n");
process.stdout.write("-".repeat(62) + "\n");
if (failures.length > 0) {
  process.stdout.write(`FAIL — ${failures.length} of ${notes.length + failures.length}\n`);
  process.exit(1);
}
process.stdout.write(`PASS — ${notes.length} assertions\n`);
