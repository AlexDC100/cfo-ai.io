#!/usr/bin/env node
/**
 * TEST-ENV ISOLATION (PER-WORKTREE) — no test path may resolve a
 * non-sanctioned Supabase project, on ANY root a dev server can be served
 * from.
 *
 * ════════════════════════════════════════════════════════════════════════
 * THE INCIDENT THIS GATE EXISTS FOR
 * ════════════════════════════════════════════════════════════════════════
 * `.env` held the production Supabase URL and `.env.local` held
 * VITE_PUBLIC_TEST_MODE=1. Vite merges them, so the dev server ran in test
 * mode against production, and because test mode reports signed-in
 * synchronously while the real session arrives async, every cold boot took
 * the false-zero branch in lib/org.ts and created a real organisation.
 * 8,880 junk rows — 99.6% of that table. The cleanup that followed then
 * filtered `organizations` by NAME and took the sentinel org with it.
 *
 * ════════════════════════════════════════════════════════════════════════
 * WHY THIS WAS REWRITTEN (2026-09-06) — THE GATE WAS BLIND TO 8 ROOTS OF 9
 * ════════════════════════════════════════════════════════════════════════
 * The first version set `ROOT = process.cwd()` and read five fixed
 * filenames under it. It therefore judged exactly the worktree the battery
 * happened to launch it from. Measured on this machine:
 *
 *   · `git worktree list` returns NINE worktrees. Each is a complete Vite
 *     project root with its own vite.config.ts, its own `"dev": "vite"`,
 *     and its own potential `.env*`. Vite reads dotenv from ITS OWN root,
 *     so a server served from a sibling worktree was unexaminable.
 *   · Every worktree ships `.claude/launch.json` whose Vite entry is
 *     `npm --prefix <repo>/scandi-desk-main run dev`. That target is
 *     OUTSIDE every worktree, is gitignored, and its `.env` holds the
 *     PRODUCTION project. One VITE_PUBLIC_TEST_MODE=1 line there
 *     reconstitutes the incident with the battery green.
 *   · Vite's real load order for `--mode M` is
 *     `.env` → `.env.local` → `.env.M` → `.env.M.local`, and a mode file
 *     wins. A `--mode launchgate2` server was live on this machine against
 *     `.env.launchgate2`, a name the fixed five-name list could not
 *     express.
 *
 * So the gate now enumerates SURFACES — git worktrees, launch.json
 * targets, and the working directory of every listening process — and
 * resolves each surface at every mode its own filesystem implies, with a
 * live process's AMBIENT environment overlaid the way Vite overlays it.
 *
 * ════════════════════════════════════════════════════════════════════════
 * IT FAILS CLOSED. IT NEVER WARNS AND NEVER SKIPS.
 * ════════════════════════════════════════════════════════════════════════
 * The operator's requirement, verbatim: "the isolation gate must run per
 * worktree and fail closed when it can't tell which env a dev server
 * uses." Every branch below that ends in "I do not know" is a FAIL:
 *
 *   F1 worktree discovery dead — `git worktree list` throws, is missing,
 *      returns nothing, or does not contain this gate's own directory.
 *   F2 stale worktree registration — a listed worktree is not on disk.
 *   F3 launch.json unreadable, or a dev-server entry names a target
 *      directory that does not resolve.
 *   F4 an env file exists but cannot be read. Unreadable is NEVER absent.
 *   F5 a live listening server whose cwd, argv or ambient environment
 *      cannot be read. This is the requirement in its literal form.
 *   F6 the runtime discoverer itself is unavailable (no lsof, no /proc) —
 *      the gate would be blind to every running server by construction.
 *   F7 a surface that a dev server can be served from with NO env file at
 *      all: the Supabase URL then comes from whichever code fallback
 *      imports first, which is not a determination this gate can make.
 *
 * There is deliberately no environment-variable opt-out. A host that
 * cannot see its own processes cannot run this gate green.
 *
 * ════════════════════════════════════════════════════════════════════════
 * WORK IS COUNTED IN SURFACE x MODE RESOLUTIONS, NOT VARIABLES
 * ════════════════════════════════════════════════════════════════════════
 * The old count was the number of env variables read. Eight of nine
 * worktrees hold no dotenv, so that number is dominated entirely by the
 * one root that happens to have files — the census could lose every other
 * surface and the number would not move. A resolution count is
 * one-per-surface-per-mode, so losing a discoverer subtracts visibly.
 *
 * The aggregate floor (2, in run_battery.py) is a COLLAPSE detector, not a
 * ratchet: pinning it near today's ~22 would turn a legitimate
 * `git worktree prune` into a red battery. Richness of discovery is
 * asserted instead by PER-DISCOVERER invariants below, which are hard
 * failures independent of the floor — because an aggregate floor cannot
 * tell you that one of three discoverers died.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const TEST_MODE_FLAGS = [
  "VITE_PUBLIC_TEST_MODE",
  "PUBLIC_TEST_MODE",
  "VITE_TEST_USER_ID",
  "VITE_TEST_ORG_ID",
];
const URL_KEYS = ["VITE_SUPABASE_URL", "SUPABASE_URL"];

/** Ports a dev server plausibly binds. A listening process here is treated
 *  as a candidate even when its cwd is outside every known surface — that
 *  is the case where we least know what it is serving. */
const DEV_PORT_MIN = 3000;
const DEV_PORT_MAX = 5999;

const failures = [];
const notes = [];
const outOfScope = [];
function fail(code, ...lines) {
  failures.push({ code, lines });
}

// ── the sanctioned project ─────────────────────────────────────────────
function sanctionedUrl(gateRoot) {
  const p = path.join(gateRoot, "frontend/test/hermeticEnv.json");
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (e) {
    fail("F0", `manifest unreadable: ${p} — ${e.message}`);
    return null;
  }
  let url;
  try {
    url = JSON.parse(raw)?.env?.VITE_SUPABASE_URL ?? null;
  } catch (e) {
    fail("F0", `manifest is not JSON: ${p} — ${e.message}`);
    return null;
  }
  if (!url) fail("F0", `manifest declares no sanctioned VITE_SUPABASE_URL: ${p}`);
  return url;
}

// ── dotenv ─────────────────────────────────────────────────────────────
function parseDotenv(text) {
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"') && v.length > 1) ||
      (v.startsWith("'") && v.endsWith("'") && v.length > 1)
    ) {
      v = v.slice(1, -1);
    } else {
      v = v.split(" #")[0].trim();
    }
    out.set(m[1], v);
  }
  return out;
}

/** Read one env file. Absent → null. Present-but-unreadable → F4, never
 *  silently absent: an EACCES on a 0600 `.env` is exactly the state in
 *  which a clean verdict would be a lie. */
function readEnvFile(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null; // genuinely absent
  }
  if (!st.isFile()) {
    fail("F4", `${file} exists but is not a regular file`);
    return new Map();
  }
  try {
    return parseDotenv(fs.readFileSync(file, "utf8"));
  } catch (e) {
    fail("F4", `${file} exists but could not be read — ${e.message}`);
    return new Map();
  }
}

/** Every mode this surface's own filesystem implies, plus the two Vite
 *  always offers. A mode file the fixed five-name list could not express
 *  (`.env.launchgate2`) is discovered here rather than assumed away. */
function modesFor(dir) {
  const modes = new Set(["development", "production"]);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (e) {
    fail("F4", `surface directory unreadable: ${dir} — ${e.message}`);
    return [...modes];
  }
  for (const name of entries) {
    const m = /^\.env\.([A-Za-z0-9_-]+?)(\.local)?$/.exec(name);
    if (m && m[1] !== "local") modes.add(m[1]);
  }
  return [...modes];
}

/** Vite's merge order, lowest precedence first. */
function resolveMerged(dir, mode, ambient, ambientLabel) {
  const merged = new Map();
  // WHERE EACH VALUE CAME FROM. A verdict that names a violation without
  // naming its source sends the reader hunting through four files and a
  // process environment. The provenance map is what makes the FAIL text
  // actionable — and it is what distinguishes "your .env is wrong" from
  // "this particular running process was started with a stale export".
  const from = new Map();
  let sawAnyFile = false;
  for (const name of [".env", ".env.local", `.env.${mode}`, `.env.${mode}.local`]) {
    const m = readEnvFile(path.join(dir, name));
    if (m === null) continue;
    sawAnyFile = true;
    for (const [k, v] of m) {
      merged.set(k, v);
      from.set(k, name);
    }
  }
  // A live process's ambient environment overrides its files, the same way
  // Vite's own `process.env` does.
  if (ambient) {
    for (const [k, v] of ambient) {
      merged.set(k, v);
      from.set(k, ambientLabel ?? "ambient env");
    }
  }
  return { merged, from, sawAnyFile };
}

// ── discovery: git worktrees ───────────────────────────────────────────
function discoverWorktrees(gateRoot) {
  let out;
  try {
    out = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: gateRoot,
      encoding: "utf8",
      timeout: 30_000,
    });
  } catch (e) {
    fail("F1", `git worktree list failed — ${e.message}`);
    return [];
  }
  const paths = [...out.matchAll(/^worktree (.+)$/gm)].map((m) => m[1]);
  if (paths.length === 0) {
    fail("F1", "git worktree list returned zero worktrees");
    return [];
  }
  const alive = [];
  for (const p of paths) {
    if (!fs.existsSync(p)) {
      fail("F2", `worktree registered but absent on disk: ${p}`, "  run: git worktree prune");
      continue;
    }
    alive.push(fs.realpathSync(p));
  }
  return alive;
}

// ── discovery: launch.json targets ─────────────────────────────────────
function looksLikeDevServer(cfg) {
  const hay = [cfg.runtimeExecutable ?? "", ...(cfg.runtimeArgs ?? [])].join(" ");
  if (/vite|(^|\s)dev(\s|$)/i.test(hay)) return true;
  if (typeof cfg.port === "number" && cfg.port >= DEV_PORT_MIN && cfg.port <= DEV_PORT_MAX) return true;
  return /^https?:/.test(cfg.url ?? "");
}

function launchTargetDir(cfg, worktree) {
  if (cfg.cwd) return path.resolve(worktree, cfg.cwd);
  const args = cfg.runtimeArgs ?? [];
  for (const flag of ["--prefix", "-C", "--cwd"]) {
    const i = args.indexOf(flag);
    if (i >= 0 && args[i + 1]) return path.resolve(worktree, args[i + 1]);
  }
  return worktree;
}

function discoverLaunchTargets(worktrees) {
  const found = [];
  for (const wt of worktrees) {
    const p = path.join(wt, ".claude/launch.json");
    if (!fs.existsSync(p)) continue;
    let cfgs;
    try {
      cfgs = JSON.parse(fs.readFileSync(p, "utf8")).configurations ?? [];
    } catch (e) {
      fail("F3", `launch.json will not parse: ${p} — ${e.message}`);
      continue;
    }
    for (const cfg of cfgs) {
      if (!looksLikeDevServer(cfg)) continue;
      const dir = launchTargetDir(cfg, wt);
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        fail(
          "F3",
          `launch config "${cfg.name}" in ${p}`,
          `  names a target directory that does not resolve: ${dir}`,
          "  a dev server whose root is unknown has an undetermined env",
        );
        continue;
      }
      found.push({ dir: fs.realpathSync(dir), origin: `${p}#${cfg.name}` });
    }
  }
  return found;
}

// ── discovery: live listening processes ────────────────────────────────
function haveLsof() {
  try {
    execFileSync("which", ["lsof"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function discoverRuntime(surfaceDirs) {
  const procRoot = "/proc";
  const hasProc = fs.existsSync(path.join(procRoot, "self", "environ"));
  if (!haveLsof() && !hasProc) {
    fail(
      "F6",
      "no runtime discoverer available (neither lsof nor /proc)",
      "  this gate cannot see running dev servers on this host, which is the",
      "  state that let a test-mode server bind to a production project",
    );
    return [];
  }

  let raw = "";
  try {
    raw = execFileSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"], {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (e) {
    // lsof exits non-zero when nothing matches; that is not an error.
    raw = typeof e.stdout === "string" ? e.stdout : "";
  }

  const byPid = new Map();
  let pid = null;
  let cmd = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("p")) {
      pid = line.slice(1).trim();
      cmd = null;
      if (!byPid.has(pid)) byPid.set(pid, { pid, cmd: null, ports: new Set() });
    } else if (line.startsWith("c")) {
      cmd = line.slice(1).trim();
      if (pid && byPid.has(pid)) byPid.get(pid).cmd = cmd;
    } else if (line.startsWith("n") && pid) {
      const m = /:(\d+)$/.exec(line.slice(1).trim());
      if (m) byPid.get(pid).ports.add(Number(m[1]));
    }
  }

  const servers = [];
  for (const info of byPid.values()) {
    // A candidate is any listening process whose working directory lands
    // inside a known surface, OR that binds a dev-range port. NOT a
    // command-name allowlist: the engine on :8000 is `Python`, and a
    // name filter is exactly how a discoverer goes quietly blind.
    let cwd = null;
    try {
      const o = execFileSync("lsof", ["-a", "-p", info.pid, "-d", "cwd", "-Fn"], {
        encoding: "utf8",
        timeout: 15_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const m = /^n(.+)$/m.exec(o);
      if (m) cwd = m[1].trim();
    } catch {
      cwd = null;
    }

    // ── SCOPE, and why it is drawn at the working directory ───────────
    // A listening process is THIS repo's business when its cwd resolves
    // inside a discovered surface. A process whose cwd is readable and
    // lies outside every surface is someone else's server — macOS
    // ControlCenter binds :5000 and :7000, and an unrelated project was
    // serving :4333 on this machine while this was written. Failing on
    // those would make the gate permanently red on a developer laptop,
    // and a permanently red gate is one people learn to skip, which is
    // the failure this battery exists to prevent.
    //
    // A process whose cwd CANNOT be read is a different matter: it cannot
    // be ruled out, so it is a hard FAIL. That is the operator's
    // requirement in its literal form — not knowing is not passing.
    // Out-of-scope listeners are COUNTED AND PRINTED, never silently
    // dropped: a scope rule that hides its own exclusions is how a
    // discoverer goes quietly blind.
    if (!cwd) {
      fail(
        "F5",
        `listening pid ${info.pid} (${info.cmd ?? "?"}) on port(s) ${[...info.ports].join(",")}`,
        "  its working directory could not be read, so it cannot be placed",
        "  inside or outside this repo — which env it uses is unknown",
      );
      continue;
    }
    const inSurface = surfaceDirs.some((d) => cwd === d || cwd.startsWith(d + path.sep));
    if (!inSurface) {
      outOfScope.push(
        `pid ${info.pid} ${info.cmd ?? "?"} :${[...info.ports].join(",")} cwd=${cwd}`,
      );
      continue;
    }
    if (!fs.existsSync(cwd)) {
      fail("F5", `listening pid ${info.pid} has a working directory that no longer exists: ${cwd}`);
      continue;
    }

    // argv → --mode
    let mode = "development";
    let argv = "";
    try {
      argv = execFileSync("ps", ["-o", "command=", "-p", info.pid], {
        encoding: "utf8",
        timeout: 15_000,
      }).trim();
    } catch {
      argv = "";
    }
    if (!argv) {
      fail("F5", `listening pid ${info.pid} — argv unreadable, so its --mode is unknown`);
      continue;
    }
    const mm = /--mode[= ]([A-Za-z0-9_-]+)/.exec(argv);
    if (mm) mode = mm[1];

    // ambient environment — it OVERRIDES the files, so not reading it is
    // not knowing which env the server uses.
    let ambient = null;
    if (hasProc) {
      try {
        ambient = new Map(
          fs
            .readFileSync(path.join(procRoot, info.pid, "environ"), "utf8")
            .split("\0")
            .filter(Boolean)
            .map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]),
        );
      } catch {
        ambient = null;
      }
    } else {
      try {
        const blob = execFileSync("ps", ["-Eww", "-p", info.pid], {
          encoding: "utf8",
          timeout: 15_000,
        });
        const tokens = blob.split(/\s+/).filter((t) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
        ambient = new Map(tokens.map((t) => [t.slice(0, t.indexOf("=")), t.slice(t.indexOf("=") + 1)]));
        if (tokens.length === 0) ambient = null;
      } catch {
        ambient = null;
      }
    }
    if (ambient === null) {
      fail(
        "F5",
        `listening pid ${info.pid} (${info.cmd ?? "?"}) cwd ${cwd}`,
        "  its ambient environment could not be read; an ambient",
        "  VITE_PUBLIC_TEST_MODE=1 would be invisible to this gate",
      );
      continue;
    }

    // Only the keys that can move this verdict.
    const relevant = new Map();
    for (const [k, v] of ambient) {
      if (/^VITE_/.test(k) || URL_KEYS.includes(k) || TEST_MODE_FLAGS.includes(k)) relevant.set(k, v);
    }
    servers.push({
      pid: info.pid,
      cmd: info.cmd,
      ports: [...info.ports],
      dir: fs.realpathSync(cwd),
      mode,
      ambient: relevant,
    });
  }
  return servers;
}

// ── the verdict ────────────────────────────────────────────────────────
function truthy(v) {
  return v !== undefined && v !== null && v !== "" && v !== "0" && v.toLowerCase?.() !== "false";
}

function judge(resolutions, sanctioned) {
  const violations = [];
  for (const r of resolutions) {
    const flags = TEST_MODE_FLAGS.filter((f) => truthy(r.merged.get(f)));
    if (flags.length === 0) continue;
    for (const key of URL_KEYS) {
      const url = r.merged.get(key);
      if (!url) continue;
      if (url === sanctioned) continue;
      violations.push({ ...r, flags, key, url, sanctioned });
    }
  }
  return violations;
}

function main() {
  const gateRoot = fs.realpathSync(process.cwd());
  console.log("TEST-ENV ISOLATION (PER-WORKTREE)");
  console.log("=".repeat(62));

  const sanctioned = sanctionedUrl(gateRoot);

  const worktrees = discoverWorktrees(gateRoot);
  if (worktrees.length && !worktrees.includes(gateRoot)) {
    fail(
      "F1",
      `this gate's own directory is not among the discovered worktrees: ${gateRoot}`,
      "  the surface set is therefore not the set this gate is running in",
    );
  }

  const launchTargets = discoverLaunchTargets(worktrees);

  const surfaces = new Map(); // dir -> origins[]
  for (const w of worktrees) surfaces.set(w, ["git worktree"]);
  for (const t of launchTargets) {
    if (!surfaces.has(t.dir)) surfaces.set(t.dir, []);
    surfaces.get(t.dir).push(t.origin);
  }

  const servers = discoverRuntime([...surfaces.keys()]);
  for (const s of servers) {
    if (!surfaces.has(s.dir)) surfaces.set(s.dir, []);
    surfaces.get(s.dir).push(`live pid ${s.pid} :${s.ports.join(",")}`);
  }

  // ── PER-DISCOVERER INVARIANTS ────────────────────────────────────────
  // An aggregate floor cannot tell you that one of three discoverers died.
  // Each of these is a hard failure independent of the floor.
  if (worktrees.length < 1) fail("F1", "the git-worktree discoverer produced nothing");
  if (fs.existsSync(path.join(gateRoot, ".claude/launch.json")) && launchTargets.length === 0) {
    fail(
      "F3",
      "this worktree ships .claude/launch.json but the launch-target discoverer produced nothing",
      "  a dev-server entry that stops being recognised is a surface that stops being examined",
    );
  }

  const resolutions = [];
  for (const [dir, origins] of surfaces) {
    const liveHere = servers.filter((s) => s.dir === dir);
    const modes = new Set(modesFor(dir));
    for (const s of liveHere) modes.add(s.mode);

    for (const mode of modes) {
      const live = liveHere.find((s) => s.mode === mode) ?? null;
      const { merged, from, sawAnyFile } = resolveMerged(
        dir,
        mode,
        live?.ambient ?? null,
        live ? `ambient env of pid ${live.pid} (${live.cmd ?? "?"}) :${live.ports.join(",")}` : null,
      );
      if (!sawAnyFile && !live) {
        // Inert: a surface with no env file and nothing running. Recorded,
        // not judged — the app would take a code fallback, and which one
        // depends on import order, which this gate cannot determine.
        notes.push(`inert (no env file, nothing listening): ${dir} @ ${mode}`);
        resolutions.push({ dir, mode, merged, from, origins, live, inert: true });
        continue;
      }
      if (!sawAnyFile && live) {
        fail(
          "F7",
          `a LIVE server is serving a root with no env file at all: ${dir}`,
          `  pid ${live.pid} on port(s) ${live.ports.join(",")}, mode ${mode}`,
          "  its Supabase URL comes from whichever code fallback imports first",
        );
      }
      resolutions.push({ dir, mode, merged, from, origins, live, inert: false });
    }
  }

  const judged = resolutions.filter((r) => !r.inert);
  const violations = judge(judged, sanctioned);

  console.log(
    `GATE-WORK test-env-isolation units=${resolutions.length} floor=2 label=surface-mode-resolutions`,
  );
  console.log(
    `  surfaces resolved   : ${surfaces.size} (${worktrees.length} git worktrees, ${launchTargets.length} launch.json targets, ${servers.length} runtime)`,
  );
  console.log(`  runtime dev servers : ${servers.length} listening in a repo surface`);
  console.log(
    `  out of scope        : ${outOfScope.length} listener(s) whose cwd is outside every surface`,
  );
  for (const o of outOfScope) console.log(`    skipped ${o}`);
  console.log(`  sanctioned supabase : ${sanctioned ?? "(none declared)"}`);
  for (const s of servers) {
    console.log(`    live pid ${s.pid} ${s.cmd ?? "?"} :${s.ports.join(",")} mode=${s.mode} cwd=${s.dir}`);
  }

  if (failures.length) {
    console.log("");
    console.log(`FAIL — ${failures.length} undetermined or broken surface(s):`);
    for (const f of failures) {
      console.log(`  [${f.code}] ${f.lines[0]}`);
      for (const l of f.lines.slice(1)) console.log(`        ${l}`);
    }
    console.log("");
    console.log("A surface whose env cannot be determined is not a passing surface.");
    return 1;
  }

  if (violations.length) {
    console.log("");
    console.log(`FAIL — ${violations.length} test path(s) resolve a non-sanctioned Supabase project:`);
    for (const v of violations) {
      console.log(`  ${v.dir} @ mode=${v.mode}`);
      for (const f of v.flags) {
        console.log(`    ${f}=${v.merged.get(f)}   ← ${v.from.get(f) ?? "?"}`);
      }
      console.log(`    ${v.key}=${v.url}   ← ${v.from.get(v.key) ?? "?"}`);
      console.log(`    sanctioned is ${v.sanctioned}`);
      console.log(`    surface reached via: ${v.origins.join(", ")}`);
    }
    return 1;
  }

  if (resolutions.length === 0) {
    console.log("");
    console.log("DISCOVERY BROKEN — resolved zero surface x mode pairs.");
    return 1;
  }

  console.log("");
  console.log(
    `PASS — ${judged.length} judged resolution(s) across ${surfaces.size} surface(s); none resolves a non-sanctioned Supabase project.`,
  );
  if (notes.length) {
    console.log(`  (${notes.length} inert surface(s) with no env file and nothing listening)`);
  }
  return 0;
}

process.exit(main());
