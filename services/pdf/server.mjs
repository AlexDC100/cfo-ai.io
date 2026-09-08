// THE PDF SIDECAR — `cfo-ai-pdf`, an internal-only HTTP service.
//
// ── WHY A SEPARATE CONTAINER AND NOT THE ENGINE IMAGE ─────────────────
//
// Three measured reasons, in the order they matter:
//
//  1. THE ENGINE IMAGE IS UNDER A HASH-LOCKED SUPPLY-CHAIN CONTRACT.
//     `Dockerfile` installs with `pip install --require-hashes -r
//     requirements-lock.txt`, and `scripts/check_supply_chain.py` C3
//     fails the build on ANY pip invocation naming a package outside
//     that lock. Playwright does not fit through that door twice over:
//     the Python package would have to be added to the lock, and then
//     `playwright install` downloads a ~190 MB browser tarball from a
//     CDN at build time with no hash pip ever sees. Putting Chromium in
//     the engine image means either weakening C3 or lying to it.
//  2. EVERY ENGINE DEPLOY REBUILDS THAT IMAGE. CLAUDE.md §14 requires
//     `docker compose build backend` for any engine source change — a
//     one-line fix included. Adding a 350 MB browser layer taxes every
//     one of those deploys forever, to serve a feature that changes
//     rarely.
//  3. BLAST RADIUS. Chromium peaks at several hundred MB of RSS per
//     render. The backend is the hot path for upload and analysis and
//     carries the stack's healthcheck; a runaway render should not be
//     able to OOM the thing that reads trial balances.
//
// The frontend container was considered and rejected: `cfo-ai-frontend`
// is `nginx:1.27-alpine` serving a static Vite build. It has no Node
// runtime at all at run time, and Playwright's Chromium does not run on
// musl. Turning a static file server into a Node application server to
// host this is a much bigger change than adding one small container.
//
// ── WHERE IT SITS ─────────────────────────────────────────────────────
//
// On the compose `default` network ONLY — deliberately NOT on
// `scandia_default`, which is where `scandia-caddy` (the public
// ingress) can reach. Nothing outside the stack can address this
// service. The engine calls it; the browser never does.
//
// ── AUTH: FAIL CLOSED ─────────────────────────────────────────────────
//
// `PDF_SERVICE_TOKEN` unset ⇒ every route except `/health` answers 503,
// following the rule CLAUDE.md §22 locked for the cron routes after the
// renewal-reminder endpoint was found skipping its bearer check when the
// token was missing. An unauthenticated renderer is a free CPU-and-
// memory amplifier for anyone who reaches the network it is on.

import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

import { renderReport, closeBrowser } from "./render.mjs";

const PORT = Number(process.env.PDF_PORT ?? 8081);
const TOKEN = process.env.PDF_SERVICE_TOKEN ?? "";
/** Simultaneous renders. Each is a browser context worth of memory. */
const CONCURRENCY = Math.max(1, Number(process.env.PDF_CONCURRENCY ?? 2));
/** Bytes. The real Agras export is 193,634 — this is ~40× headroom, and
 *  small enough that a body cap is a cap and not a formality. */
const MAX_BODY = Number(process.env.PDF_MAX_BODY ?? 8 * 1024 * 1024);
/** How long a finished PDF stays collectable. A tab that never comes
 *  back must not pin a megabyte forever. */
const JOB_TTL_MS = Number(process.env.PDF_JOB_TTL_MS ?? 10 * 60 * 1000);
/** Hard ceiling on retained jobs, oldest evicted first — a TTL alone is
 *  not a bound when the arrival rate is the attacker's choice. */
const MAX_JOBS = Number(process.env.PDF_MAX_JOBS ?? 64);

// ── THE JOB TABLE ─────────────────────────────────────────────────────
//
// In memory, on purpose. A rendered PDF is derived data with a ten-
// minute life; persisting it would put a customer's full financial
// statements on a disk that nothing else in this stack encrypts or
// backs up, to save a re-render that costs 300 ms.

/** @type {Map<string, {state: string, created: number, filename: string|null,
 *  bytes: Buffer|null, pages: number|null, error: string|null, progress: string}>} */
const jobs = new Map();

let active = 0;
/** @type {Array<() => void>} */
const waiting = [];

function evictExpired(now = Date.now()) {
  for (const [id, job] of jobs) {
    if (now - job.created > JOB_TTL_MS) jobs.delete(id);
  }
  while (jobs.size > MAX_JOBS) {
    const oldest = jobs.keys().next();
    if (oldest.done) break;
    jobs.delete(oldest.value);
  }
}

/**
 * The state a caller polls.
 *
 * `progress` is a SENTENCE, not a percentage. A percentage on a job with
 * two real steps would be invented — the honest thing to show a user
 * waiting is what the service is actually doing. `queued` additionally
 * reports its position, which is the only number here that is measured
 * rather than guessed.
 */
function publicJob(id, job) {
  return {
    jobId: id,
    state: job.state,
    progress: job.progress,
    filename: job.filename,
    pages: job.pages,
    bytes: job.bytes === null ? null : job.bytes.length,
    error: job.error,
  };
}

async function acquire() {
  if (active < CONCURRENCY) {
    active += 1;
    return;
  }
  await new Promise((resolve) => waiting.push(resolve));
  active += 1;
}

function release() {
  active -= 1;
  const next = waiting.shift();
  if (next !== undefined) next();
}

async function runJob(id, html, meta) {
  const job = jobs.get(id);
  if (job === undefined) return;
  await acquire();
  try {
    const current = jobs.get(id);
    if (current === undefined) return; // evicted while queued
    current.state = "rendering";
    current.progress = "Laying the document out on A4 and paginating it";
    const { bytes, pages, filename } = await renderReport(html, meta);
    const done = jobs.get(id);
    if (done === undefined) return;
    done.state = "done";
    done.progress = `Ready — ${pages} page${pages === 1 ? "" : "s"}`;
    done.bytes = bytes;
    done.pages = pages;
    done.filename = filename;
  } catch (err) {
    const failed = jobs.get(id);
    if (failed !== undefined) {
      failed.state = "failed";
      // The message, never the stack: a stack trace names absolute
      // container paths and is read by whoever asked for the PDF.
      failed.error = err instanceof Error ? err.message : String(err);
      failed.progress = "Failed";
    }
  } finally {
    release();
  }
}

// ── HTTP ──────────────────────────────────────────────────────────────

function send(res, status, body, headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": Buffer.isBuffer(body) ? "application/pdf" : "application/json",
    "content-length": payload.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(payload);
}

/**
 * Constant-time bearer comparison.
 *
 * `a === b` on a secret leaks its length and its matching prefix through
 * timing. The lengths are compared first because `timingSafeEqual`
 * throws on a length mismatch — that comparison is not constant-time,
 * and it does not need to be: the token's LENGTH is not the secret.
 */
function authorised(req) {
  const header = req.headers.authorization ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(presented);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    /** @type {Buffer[]} */
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function handler(req, res) {
  const url = new URL(req.url ?? "/", "http://pdf.internal");
  const path = url.pathname;

  if (path === "/health") {
    // Says whether it is CONFIGURED, so an operator can tell a missing
    // token from a crashed process without reading logs.
    send(res, 200, { status: "ok", configured: TOKEN !== "", active, queued: waiting.length });
    return;
  }

  if (TOKEN === "") {
    send(res, 503, {
      error: "PDF_SERVICE_TOKEN is not set; this service refuses to render unauthenticated",
    });
    return;
  }
  if (!authorised(req)) {
    send(res, 401, { error: "bearer token missing or wrong" });
    return;
  }

  evictExpired();

  if (req.method === "POST" && path === "/render") {
    readBody(req)
      .then((raw) => {
        /** @type {{html?: unknown, company?: unknown, period?: unknown}} */
        let body;
        try {
          body = JSON.parse(raw.toString("utf-8"));
        } catch {
          send(res, 400, { error: "body is not JSON" });
          return;
        }
        if (typeof body.html !== "string" || body.html.trim() === "") {
          send(res, 422, { error: "html is required and must be a non-empty string" });
          return;
        }
        const id = randomUUID();
        jobs.set(id, {
          state: "queued",
          created: Date.now(),
          filename: null,
          bytes: null,
          pages: null,
          error: null,
          progress:
            waiting.length === 0 && active < CONCURRENCY
              ? "Starting the renderer"
              : `Waiting for a renderer — ${waiting.length + 1} ahead`,
        });
        void runJob(id, body.html, {
          company: typeof body.company === "string" ? body.company : "",
          period: typeof body.period === "string" ? body.period : "",
        });
        send(res, 202, publicJob(id, jobs.get(id)));
      })
      .catch((err) => {
        send(res, err.status ?? 400, { error: err.message ?? "bad request" });
      });
    return;
  }

  const statusMatch = /^\/jobs\/([0-9a-f-]{36})$/.exec(path);
  if (req.method === "GET" && statusMatch !== null) {
    const job = jobs.get(statusMatch[1]);
    if (job === undefined) {
      send(res, 404, { error: "no such job — it may have expired" });
      return;
    }
    send(res, 200, publicJob(statusMatch[1], job));
    return;
  }

  const fileMatch = /^\/jobs\/([0-9a-f-]{36})\/pdf$/.exec(path);
  if (req.method === "GET" && fileMatch !== null) {
    const job = jobs.get(fileMatch[1]);
    if (job === undefined) {
      send(res, 404, { error: "no such job — it may have expired" });
      return;
    }
    if (job.state !== "done" || job.bytes === null) {
      send(res, 409, { error: `job is ${job.state}, not done`, state: job.state });
      return;
    }
    // `filename` is `^[A-Za-z0-9_]+\.pdf$` by construction and re-asserted
    // in `render.mjs`, so the quoted header parameter cannot be escaped.
    send(res, 200, job.bytes, {
      "content-disposition": `attachment; filename="${job.filename}"`,
    });
    return;
  }

  send(res, 404, { error: "no such route" });
}

// Only listen when run as a program, so a test can import `handler`.
//
// `pathToFileURL`, NOT `file://${process.argv[1]}`. The obvious spelling
// compares an already-encoded `import.meta.url`
// (`file:///Users/…/folder%20claude%20Scandia%20copy/…`) against a raw
// path containing spaces, so it is FALSE on any checkout whose path has
// a space — and this repository's does. Measured: the service started,
// printed nothing, listened on nothing, and exited 0. A container that
// exits cleanly and serves nothing is the worst kind of failure.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const server = createServer(handler);
  server.listen(PORT, () => {
    process.stdout.write(
      `cfo-ai-pdf listening on :${PORT} (configured=${TOKEN !== ""}, concurrency=${CONCURRENCY})\n`,
    );
  });
  const shutdown = () => {
    server.close(() => {
      void closeBrowser().then(() => process.exit(0));
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
