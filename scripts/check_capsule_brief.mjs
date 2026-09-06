#!/usr/bin/env node
/**
 * THE CAPSULE BRIEF — the static + pure half of gates N1–N8.
 *
 * Part F, gates lane. This lane owns no product code. It owns the proof
 * that the resting capsule EARNS ITS SPACE: that what it says is
 * computed from this workspace, is not a second copy of the sidebar, and
 * costs nothing to read.
 *
 *   B1  (N1)  the resting mount is passed NO destination rows
 *   B2  (N2)  every resting unit is DERIVED — proven by a mutation
 *             differential, not by hunting for a known-bad literal
 *   B3  (N7)  the declared row budgets: <=3 tiles, <=3 chips, <=8 rows
 *   B4  (N5)  an account code resolves from the fact index, with
 *             provenance, in <100ms — and a FABRICATED code does not
 *   B5  (N8)  subject floors: every law above has something to be about
 *
 * Everything needing a painted DOM lives in
 * `e2e/design/capsule-brief.spec.ts` — N1 live, N3 spend, N4 provenance,
 * N5 honesty, N6 handoff, N7 live budget.
 *
 * ── WHY THIS FILE EXISTS IN THE SHAPE IT DOES ─────────────────────────
 *
 * The brief names N2 as "the gate most likely to be written vacuously —
 * a check that only looks for a known-bad literal passes the moment
 * someone picks a different literal."
 *
 * So B2 does not look for a literal at all. It drives the REAL builders
 * through a MUTATION MATRIX and asks a different question: does this
 * unit's content MOVE when the workspace state moves? A hardcoded string
 * is invariant under every mutation of the snapshot, whatever the string
 * happens to spell. That is the derivation, asserted directly.
 *
 * And B2 carries its own POSITIVE CONTROL — a deliberately hardcoded
 * builder registered beside the real ones. Every run must flag it. If
 * the detector ever stops flagging the control, the gate fails on the
 * control rather than reporting a clean sweep, because a detector that
 * cannot see a planted defect is not evidence about the real ones.
 *
 * ── THE VACUITY DISCIPLINE ────────────────────────────────────────────
 *
 * Three of these laws are BANS ("no resting row duplicates the
 * sidebar"), and a ban is satisfied by an empty surface. Measured
 * 2026-09-01 on the live stack: the resting capsule paints ZERO
 * destination rows, so N1's ban is already satisfied — VACUOUSLY, and
 * it would stay satisfied if the entire surface were deleted.
 *
 * Every ban here is therefore paired with a SUBJECT FLOOR asserted
 * AFTER the discovery loop that produced it. A law with no subject is
 * reported NO-SUBJECT and FAILS. It never passes.
 *
 * Run:
 *   node scripts/check_capsule_brief.mjs
 *   node scripts/check_capsule_brief.mjs --census          (print, exit 0)
 *   node scripts/check_capsule_brief.mjs --probe-vacuity   (self-test)
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import esbuild from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARGV = process.argv.slice(2);
const CENSUS_ONLY = ARGV.includes("--census");
/** Empties every discovery set, then asserts this gate FAILS. A gate
 *  that still passes with nothing to examine is a decoration. */
const PROBE_VACUITY = ARGV.includes("--probe-vacuity");

const failures = [];
const notes = [];
const census = {};
const fail = (gate, message) => failures.push({ gate, message });
const ok = (m) => notes.push(m);
const rel = (p) => path.relative(ROOT, p);
const read = (p) => readFileSync(p, "utf-8");

// ══════════════════════════════════════════════════════════════════════
// THE TS LOADER — the gate drives the REAL modules, not a paraphrase
// ══════════════════════════════════════════════════════════════════════
//
// B2 and B4 assert behaviour, and behaviour cannot be read off source
// text. esbuild bundles the module under test into memory and it is
// imported as ESM. Two deliberate choices:
//
//   · the app's UI dependencies are STUBBED, not bundled. Nothing here
//     renders; `react-i18next` is pulled in transitively by a barrel and
//     would drag a browser runtime into a 200 ms gate for no assertion.
//     The stub is a proxy that answers any shape, so an accidental call
//     is inert rather than a crash that would read as a gate failure.
//   · `import.meta.env` is DEFINED rather than stubbed, because Vite
//     replaces it at build time and an undefined `.DEV` read is a
//     TypeError, not a missing feature.
//
// If a future module under test needs a real dependency, add it to the
// bundle rather than to STUBBED — a stub that answers a question the
// real module would have answered differently is a fake store, and this
// repo has a file about what those cost.

const STUBBED = [
  "react", "react-dom", "react/jsx-runtime", "react-i18next", "i18next",
  "i18next-browser-languagedetector", "@tanstack/react-query",
  "react-router-dom", "html-parse-stringify", "@supabase/supabase-js",
];

const STUB_SOURCE = `
const chain = new Proxy(function () {}, {
  get: (_t, p) => (p === "then" ? undefined : chain),
  apply: () => chain,
});
export default chain;
export const useTranslation = () => ({ t: (k) => k, i18n: chain });
export const initReactI18next = chain;
export const Trans = () => null;
export const use = () => chain;
export const createClient = () => chain;
`;

const stubPlugin = {
  name: "capsule-brief-stub",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (a) =>
      STUBBED.includes(a.path) ? { path: a.path, namespace: "cb-stub" } : undefined,
    );
    build.onLoad({ filter: /.*/, namespace: "cb-stub" }, () => ({
      contents: STUB_SOURCE,
      loader: "js",
    }));
  },
};

async function loadTs(relPath) {
  const built = await esbuild.build({
    entryPoints: [path.join(ROOT, relPath)],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["import", "module", "default"],
    alias: { "@": path.join(ROOT, "frontend") },
    plugins: [stubPlugin],
    define: {
      "import.meta.env": JSON.stringify({
        DEV: false, PROD: true, MODE: "test", VITE_API_URL: "http://localhost:8000",
      }),
    },
    logLevel: "silent",
  });
  const code = built.outputFiles[0].text;
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

// ══════════════════════════════════════════════════════════════════════
// RECORDED EXPECTATIONS — per component, never a shared sum (TC-6)
// ══════════════════════════════════════════════════════════════════════
//
// A floor on a SUM cannot see one addend collapse. That failure has been
// caught seven times in this repo, so every number below is attached to
// ONE named component and is checked against that component alone.
//
// MEASURED 2026-09-01 against HEAD on the live test-mode stack
// (vite :5173 + engine :8000, workspace `demo-meridian`). Raw output in
// design_review/capsule-brief/probe.json and probe-n5.json.

const EXPECT = {
  /** B2 — one entry per registered content builder. `minUnits` is what a
   *  builder must produce on its own base snapshot for its derivation to
   *  be measurable at all; `minSensitive` is how many of those units
   *  must MOVE under at least one mutation. Both are per-builder. */
  builders: {
    // MEASURED: 3 suggestions on the base snapshot, all 3 sensitive.
    buildCapsuleSuggestions: { minUnits: 3, minSensitive: 3 },
    // MEASURED: buildCapsuleContext returns ONE model object; its
    // fields are the units. 7 fields, 6 of them snapshot-sensitive
    // (`hasPeriod` moves, `findingCount` moves, …).
    buildCapsuleContext: { minUnits: 6, minSensitive: 5 },
    // THE POSITIVE CONTROL. Not product code — a builder that ignores
    // its snapshot entirely. It MUST be flagged as underived on every
    // run; a run that reports it clean has a broken detector.
    __control_hardcoded: { minUnits: 1, minSensitive: 0, mustFail: true },
  },
  /** B3 — declared caps, per surface zone. */
  budget: {
    /** N7: <=3 chips at rest. `MAX_SUGGESTIONS` in capsuleSuggestions.ts. */
    chips: 3,
    /** N7: <=3 tiles at rest. No constant declares this yet — that
     *  ABSENCE is the finding, not a reason to skip the law. */
    tiles: 3,
    /** N7: <=8 rows visible in any typing state. MEASURED at HEAD:
     *  `CommandPalette.tsx` slices to 18, and the live surface painted
     *  19 activatable nodes for the query "a". */
    rowsTyping: 8,
  },
  /** B4 — the account path, measured on the committed real fixtures. */
  accounts: {
    /** Account codes that must be discoverable across the fixtures
     *  before the resolution law means anything. MEASURED below and
     *  asserted AFTER the discovery loop. */
    minCodes: 20,
    /** N5's budget. */
    maxResolveMs: 100,
  },
};

// ══════════════════════════════════════════════════════════════════════
// DISCOVERY — every set this gate reads, built once, floored later
// ══════════════════════════════════════════════════════════════════════

function discover() {
  if (PROBE_VACUITY) {
    // The self-test: hand every law an EMPTY world and require the gate
    // to fail. This is the check that this file is an instrument rather
    // than a decoration.
    return { navPaths: [], restingSources: [], fixtures: [], host: "", suggestionsSrc: null };
  }

  // (a) the sidebar's nav registry — the destinations N1 forbids the
  //     resting surface from restating.
  const sidebarSrc = path.join(ROOT, "frontend/components/cfo/Sidebar.tsx");
  const navPaths = [];
  if (existsSync(sidebarSrc)) {
    const src = read(sidebarSrc);
    const block = src.slice(src.indexOf("SHELL_NAV_ALL"));
    for (const m of block.matchAll(/\bto:\s*"(\/[^"]*)"/g)) navPaths.push(m[1]);
  }

  // (b) the resting render path — the components the capsule paints
  //     with nothing typed.
  const restingDir = path.join(ROOT, "frontend/components/instrument/shell/capsuleEmpty");
  const restingSources = existsSync(restingDir)
    ? readdirSync(restingDir)
        .filter((n) => /\.tsx?$/.test(n))
        .map((n) => path.join(restingDir, n))
    : [];

  // (c) the committed REAL period fixtures — B4's subject.
  const fxDir = path.join(ROOT, "frontend/lib/__tests__/fixtures/capsuleTier0");
  const fixtures = existsSync(fxDir)
    ? readdirSync(fxDir).filter((n) => n.endsWith(".json")).map((n) => path.join(fxDir, n))
    : [];

  // (d) the host that mounts the resting state.
  const hostPath = path.join(ROOT, "frontend/components/instrument/shell/CommandPalette.tsx");
  const host = existsSync(hostPath) ? read(hostPath) : "";

  // (e) the pure suggestion engine — B2's and B3's subject.
  const sugPath = path.join(ROOT, "frontend/lib/capsuleSuggestions.ts");
  const suggestionsSrc = existsSync(sugPath) ? sugPath : null;

  return { navPaths, restingSources, fixtures, host, suggestionsSrc };
}

const D = discover();
census.navPaths = D.navPaths.length;
census.restingSources = D.restingSources.length;
census.fixtures = D.fixtures.length;
census.hostBytes = D.host.length;

// ══════════════════════════════════════════════════════════════════════
// B1 (N1) — the resting mount is passed NO destination rows
// ══════════════════════════════════════════════════════════════════════
//
// The owner's evidence: four "Jump to" rows at rest, all four already
// visible in the sidebar two inches to the left. The mechanism that
// paints them is `CapsuleJumpList`, and the ONE thing that decides
// whether it paints at rest is whether the host hands it a non-empty
// `jumps` prop in the resting branch.
//
// So the static law is the wiring, which is decidable here; the PAINTED
// law — "no visible resting row's destination matches a VISIBLE sidebar
// item" — is asserted live in capsule-brief.spec.ts, where visibility
// exists. Two halves of one gate, and neither is sufficient alone: the
// live half cannot see a regression behind a feature flag, and this half
// cannot see a destination arriving by some other route.

function gateRestingJumps() {
  if (!D.host) {
    fail("B1", "CommandPalette.tsx not found — the resting mount cannot be examined.");
    return;
  }
  // The resting branch's element. Located by its component name, then
  // read to its closing `/>` so a `jumps=` anywhere inside the element
  // is caught regardless of prop order or formatting.
  const idx = D.host.indexOf("<CapsuleEmptyState");
  if (idx < 0) {
    fail("B1",
      "No `<CapsuleEmptyState` element in CommandPalette.tsx. Either the resting\n" +
      "        state moved to another host — retarget this gate at it — or the\n" +
      "        resting surface is gone. Both need a human; neither is a pass.");
    return;
  }
  const end = D.host.indexOf("/>", idx);
  const element = D.host.slice(idx, end < 0 ? idx + 2000 : end + 2);
  census.restingMountBytes = element.length;

  if (/\bjumps\s*=/.test(element)) {
    fail("B1",
      "The resting mount is passed a `jumps` prop:\n" +
      `        ${rel(path.join(ROOT, "frontend/components/instrument/shell/CommandPalette.tsx"))}\n` +
      `        ${element.replace(/\s+/g, " ").slice(0, 200)}\n` +
      "        N1: no resting row's destination may restate a visible sidebar item.\n" +
      "        The four rows the owner photographed — Dashboard, Scenarios,\n" +
      "        Workspaces, Benchmark — are all four in SHELL_NAV_ALL. Destinations\n" +
      "        belong behind the first keystroke, under their own label.");
    return;
  }
  ok(`B1 resting mount passes no destination rows (${D.navPaths.length} sidebar paths would have been eligible)`);
}

// ══════════════════════════════════════════════════════════════════════
// B2 (N2) — DERIVED CONTENT, proven by differential
// ══════════════════════════════════════════════════════════════════════
//
// THE LAW: every unit the resting surface paints must be a function of
// this workspace's state. THE TEST: move the state and require the unit
// to move. A hardcoded string is invariant under every mutation of the
// snapshot — which is true whatever string it spells, which is why this
// gate cannot be defeated by picking a different literal.
//
// A second, independent law runs alongside it: TRACEABILITY. Every
// interpolated parameter a unit carries must be findable IN THE
// SNAPSHOT. A parameter that appears from nowhere was invented, and an
// invented parameter can be perfectly sensitive to mutation while still
// being a fabrication.

/** The base snapshot. Chosen to make every candidate branch in
 *  `buildCapsuleSuggestions` reachable, so the differential has
 *  something to move in each. */
const BASE_SNAPSHOT = Object.freeze({
  hasPeriod: true,
  periodLabel: "Dec 2025",
  trustBand: "minor_drift",
  findings: [
    { key: "f.margin", severity: "high", subject: "Gross margin" },
    { key: "f.dso", severity: "medium", subject: "Days sales outstanding" },
  ],
  silence: false,
  metrics: [
    { name: "dscr", value: 1.10, unit: "ratio" },
    { name: "current_ratio", value: 1.15, unit: "ratio" },
  ],
  unattached: [{ periodId: "p-sept", label: "Sept 2026" }],
  moves: [{ key: "m.cash", subject: "Cash conversion", direction: "down", magnitude: 12 }],
});

/** Every mutation the differential applies. Each is a DIFFERENT
 *  workspace, not a perturbation of one — the point is that a unit
 *  whose content survives all of these is not reading the workspace. */
const MUTATIONS = [
  ["no period", (s) => ({ ...s, hasPeriod: false, periodLabel: null })],
  ["other period", (s) => ({ ...s, periodLabel: "Mar 2024" })],
  ["clean trust", (s) => ({ ...s, trustBand: "balanced" })],
  ["material imbalance", (s) => ({ ...s, trustBand: "material_imbalance" })],
  ["no findings", (s) => ({ ...s, findings: [] })],
  ["other finding", (s) => ({ ...s, findings: [{ key: "f.x", severity: "critical", subject: "Inventory provision" }] })],
  ["no unattached", (s) => ({ ...s, unattached: [] })],
  ["other unattached", (s) => ({ ...s, unattached: [{ periodId: "p-jan", label: "Jan 2026" }] })],
  ["no metrics", (s) => ({ ...s, metrics: [] })],
  ["healthy metrics", (s) => ({ ...s, metrics: [{ name: "dscr", value: 4.0, unit: "ratio" }] })],
  ["no moves", (s) => ({ ...s, moves: [] })],
  ["silence", (s) => ({ ...s, findings: [], silence: true })],
];

/** Every scalar the snapshot states, flattened — B2's traceability set. */
function snapshotValues(snap) {
  const out = new Set();
  const walk = (v) => {
    if (v == null) return;
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v === "object") return Object.values(v).forEach(walk);
    out.add(String(v));
  };
  walk(snap);
  return out;
}

/** A builder's output reduced to comparable UNITS: `{ id, content }`.
 *  Two shapes are supported because the two live builders have two
 *  shapes — a list of rows, and one model object whose FIELDS are the
 *  units. Reducing both to the same vocabulary is what lets one
 *  differential judge both. */
function unitsOf(result) {
  if (Array.isArray(result)) {
    return result.map((r, i) => ({
      id: String(r?.id ?? r?.key ?? i),
      content: JSON.stringify(r),
      params: r?.labelParams ?? {},
      basis: r?.basisKey ?? r?.basis ?? null,
    }));
  }
  if (result && typeof result === "object") {
    return Object.entries(result).map(([k, v]) => ({
      id: k,
      content: JSON.stringify(v),
      params: {},
      basis: null,
    }));
  }
  return [];
}

async function gateDerivation() {
  const suggestionsMod = D.suggestionsSrc
    ? await loadTs(path.relative(ROOT, D.suggestionsSrc))
    : null;
  if (!suggestionsMod && !PROBE_VACUITY) {
    fail("B2", "frontend/lib/capsuleSuggestions.ts not found — nothing to prove derived.");
    return;
  }

  /** The registry. A content builder that paints at rest belongs here.
   *  ADDING THE TILE BUILDER IS THE CONTENT LANE'S HANDOFF: register it
   *  and B2 measures it the same way, with its own recorded floor. */
  const registry = PROBE_VACUITY ? [] : [
    {
      name: "buildCapsuleSuggestions",
      run: (s) => suggestionsMod.buildCapsuleSuggestions(s, "simple"),
    },
    {
      name: "buildCapsuleContext",
      run: (s) => suggestionsMod.buildCapsuleContext(s),
    },
    {
      // POSITIVE CONTROL — see the file header. Ignores its argument.
      name: "__control_hardcoded",
      run: () => [{ id: "control", labelParams: { subject: "Revenue" }, label: "How is revenue doing?" }],
    },
  ];

  census.builders = registry.length;
  const examined = [];

  for (const b of registry) {
    const spec = EXPECT.builders[b.name];
    if (!spec) {
      fail("B2",
        `Builder \`${b.name}\` is registered but has no recorded expectation.\n` +
        "        TC-6: a floor on the SUM cannot see one addend collapse, so every\n" +
        "        builder carries its own. Measure it and add it to EXPECT.builders.");
      continue;
    }

    let base;
    try {
      base = unitsOf(b.run(BASE_SNAPSHOT));
    } catch (e) {
      fail("B2", `\`${b.name}\` threw on the base snapshot: ${e?.message ?? e}`);
      continue;
    }

    // ── the differential ────────────────────────────────────────────
    // A unit is DERIVED when some mutation changes it — including
    // changing it to "absent", which is the honest response to a
    // workspace that no longer states the thing.
    const sensitive = new Set();
    for (const [label, mutate] of MUTATIONS) {
      let mutated;
      try {
        mutated = unitsOf(b.run(mutate(BASE_SNAPSHOT)));
      } catch (e) {
        fail("B2", `\`${b.name}\` threw under mutation "${label}": ${e?.message ?? e}`);
        continue;
      }
      const byId = new Map(mutated.map((u) => [u.id, u.content]));
      for (const u of base) {
        if (!byId.has(u.id) || byId.get(u.id) !== u.content) sensitive.add(u.id);
      }
    }

    // ── traceability ────────────────────────────────────────────────
    const values = snapshotValues(BASE_SNAPSHOT);
    const invented = [];
    for (const u of base) {
      for (const [k, v] of Object.entries(u.params ?? {})) {
        if (typeof v !== "string") continue;
        if (!values.has(v)) invented.push({ unit: u.id, param: k, value: v });
      }
    }

    const rec = {
      builder: b.name,
      units: base.length,
      sensitive: sensitive.size,
      underived: base.filter((u) => !sensitive.has(u.id)).map((u) => u.id),
      invented,
    };
    examined.push(rec);

    // ── the control inverts the verdict ─────────────────────────────
    if (spec.mustFail) {
      if (rec.underived.length === 0) {
        fail("B2",
          "THE POSITIVE CONTROL WAS NOT FLAGGED.\n" +
          `        \`${b.name}\` ignores its snapshot entirely and the differential\n` +
          "        still called every unit derived. The detector is broken, so this\n" +
          "        run says nothing about the real builders. Fix the differential\n" +
          "        before reading any other B2 result.");
      } else {
        ok(`B2 control: \`${b.name}\` correctly flagged underived (${rec.underived.join(", ")})`);
      }
      continue;
    }

    if (rec.units < spec.minUnits) {
      fail("B2",
        `\`${b.name}\` produced ${rec.units} unit(s) on the base snapshot; ` +
        `recorded expectation is >= ${spec.minUnits}.\n` +
        "        A builder that produces nothing makes its own derivation law\n" +
        "        vacuous — there is no unit left to be underived. Either the\n" +
        "        builder collapsed or the base snapshot stopped reaching its\n" +
        "        branches; both need a human.");
    }
    if (rec.sensitive < spec.minSensitive) {
      fail("B2",
        `\`${b.name}\`: ${rec.sensitive}/${rec.units} unit(s) move when the ` +
        `workspace moves; recorded expectation is >= ${spec.minSensitive}.\n` +
        `        UNDERIVED: ${rec.underived.join(", ") || "(none named)"}\n` +
        "        N2: a hardcoded string is invariant under every mutation of the\n" +
        "        snapshot. That is what this gate measures, and it is why picking\n" +
        "        a different literal does not get past it.");
    }
    if (rec.invented.length) {
      fail("B2",
        `\`${b.name}\` interpolates ${rec.invented.length} parameter(s) that are ` +
        "not in the snapshot:\n" +
        rec.invented.map((i) => `        · ${i.unit}.${i.param} = ${JSON.stringify(i.value)}`).join("\n") +
        "\n        A parameter can be perfectly sensitive to mutation and still be\n" +
        "        a fabrication. Every value a row prints must come from the state.");
    }
    if (rec.units >= spec.minUnits && rec.sensitive >= spec.minSensitive && !rec.invented.length) {
      // The underived names are printed even on a PASS. A builder above
      // its floor can still carry an invariant unit, and a gate that
      // only speaks when it fails hides exactly that.
      ok(`B2 ${b.name}: ${rec.sensitive}/${rec.units} units derived, 0 invented params` +
         (rec.underived.length ? `  · invariant: ${rec.underived.join(", ")}` : ""));
    }
  }

  // ── THE FLOOR, after the loop ───────────────────────────────────────
  census.buildersExamined = examined.length;
  census.unitsExamined = examined.reduce((n, r) => n + r.units, 0);
  if (!PROBE_VACUITY && examined.length === 0) {
    fail("B2",
      "NO SUBJECT — zero content builders were examined.\n" +
      "        Every B2 law is vacuously satisfied by an empty registry. A census\n" +
      "        that finds nothing is broken, not clean (TC-3).");
  }

  // ── the tile builder: absent is a FINDING, not a skip ───────────────
  const hasTileBuilder = registry.some((b) => /tile/i.test(b.name));
  if (!PROBE_VACUITY && !hasTileBuilder) {
    fail("B2",
      "NO TILE BUILDER IS REGISTERED.\n" +
      "        The brief's resting surface is <=3 FACT TILES and <=3 question\n" +
      "        chips. MEASURED 2026-09-01 on the live stack: 0 tiles, 1 chip.\n" +
      "        The chips are derived and gated; the tiles do not exist, so N2's\n" +
      "        tile half has no subject and this gate refuses to report it clean.\n" +
      "        Register the tile builder here when it lands and give it a\n" +
      "        recorded expectation in EXPECT.builders.");
  }
  return examined;
}

// ══════════════════════════════════════════════════════════════════════
// B3 (N7) — the declared row budgets
// ══════════════════════════════════════════════════════════════════════
//
// The live spec measures what is PAINTED. This measures what is
// DECLARED, which is the thing a reviewer can change without noticing:
// a constant edited from 3 to 8 is a one-character diff and a different
// surface.

function gateBudgets() {
  // Read through DISCOVERY, not straight off disk. A law that reaches
  // around the discovery set survives `--probe-vacuity` and reports a
  // green while every other law is starved — which is the same class of
  // false green the probe exists to detect, hiding inside the detector.
  const sugSrc = D.suggestionsSrc;
  if (sugSrc && existsSync(sugSrc)) {
    const m = /export const MAX_SUGGESTIONS\s*=\s*(\d+)/.exec(read(sugSrc));
    if (!m) {
      fail("B3", "MAX_SUGGESTIONS is not declared in capsuleSuggestions.ts — the chip cap is unenforceable.");
    } else if (Number(m[1]) > EXPECT.budget.chips) {
      fail("B3", `MAX_SUGGESTIONS = ${m[1]}; N7 caps resting chips at ${EXPECT.budget.chips}.`);
    } else {
      ok(`B3 chips: MAX_SUGGESTIONS = ${m[1]} <= ${EXPECT.budget.chips}`);
      census.chipCap = Number(m[1]);
    }
  } else if (!PROBE_VACUITY) {
    fail("B3", "capsuleSuggestions.ts not found — the chip cap cannot be read.");
  }

  // The typing slice. MEASURED at HEAD: 18.
  if (D.host) {
    const m = /const visible = out\.slice\(0,\s*(\d+)\)/.exec(D.host);
    if (!m) {
      fail("B3",
        "The typing-state row slice could not be located in CommandPalette.tsx.\n" +
        "        This gate reads `const visible = out.slice(0, N)`. If the cap moved,\n" +
        "        retarget the gate — a cap this gate cannot find is a cap nothing\n" +
        "        is holding.");
    } else {
      census.rowSlice = Number(m[1]);
      if (Number(m[1]) > EXPECT.budget.rowsTyping) {
        fail("B3",
          `The typing state slices to ${m[1]} rows; N7 caps it at ${EXPECT.budget.rowsTyping}.\n` +
          "        MEASURED 2026-09-01: query \"a\" painted 19 activatable nodes and\n" +
          "        \"cash\" painted 14. A list that long is the menu the capsule was\n" +
          "        supposed to stop being — the reader scans it instead of reading it.\n" +
          "        (design_review/capsule-brief/probe.json, rowBudget)");
      } else {
        ok(`B3 typing rows: slice(0, ${m[1]}) <= ${EXPECT.budget.rowsTyping}`);
      }
    }
  }

  // The tile cap. Its ABSENCE is the finding.
  const tileCap = findTileCap();
  census.tileCap = tileCap;
  if (tileCap == null) {
    fail("B3",
      "NO TILE CAP IS DECLARED anywhere in frontend/.\n" +
      "        N7 caps the resting surface at <=3 fact tiles. There is no constant\n" +
      "        to hold that, because there are no tiles — MEASURED 0 at rest on\n" +
      "        2026-09-01. Declare MAX_TILES beside MAX_SUGGESTIONS when the tiles\n" +
      "        land; a budget with no constant is a budget nobody is keeping.");
  } else if (tileCap > EXPECT.budget.tiles) {
    fail("B3", `The tile cap is ${tileCap}; N7 caps resting tiles at ${EXPECT.budget.tiles}.`);
  } else {
    ok(`B3 tiles: cap = ${tileCap} <= ${EXPECT.budget.tiles}`);
  }
}

function findTileCap() {
  for (const f of D.restingSources) {
    const m = /export const MAX_TILES\s*=\s*(\d+)/.exec(read(f));
    if (m) return Number(m[1]);
  }
  if (D.suggestionsSrc && existsSync(D.suggestionsSrc)) {
    const m = /export const MAX_TILES\s*=\s*(\d+)/.exec(read(D.suggestionsSrc));
    if (m) return Number(m[1]);
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════
// B4 (N5) — an account code resolves, with provenance, under budget
// ══════════════════════════════════════════════════════════════════════
//
// WHY THIS RUNS ON FIXTURES AND NOT ON THE LIVE STACK. The test-mode
// workspace is `demo-meridian`, a CLIENT-SIDE demo with no backend
// period (frontend/lib/demo/demoCompany.ts) — it carries no attached
// documents, so its fact index has no account facts at all. MEASURED
// 2026-09-01: typing 5121 and typing 9999 produce the identical surface,
// and pressing Enter on either spends a model call and answers
// "Reading account … unavailable".
//
// So N5's RESOLVE half is unmeasurable on that workspace, and a live
// gate asserting it there would be asserting over an empty set. The
// committed real fixtures ARE the subject: three real served periods,
// captured from production data. The live spec asserts the other half —
// that a real code and a fabricated one are DISTINGUISHABLE, which is
// measurable on any workspace, including an empty one.

async function gateAccountLookup() {
  if (PROBE_VACUITY || D.fixtures.length === 0) {
    if (!PROBE_VACUITY) {
      fail("B4",
        "NO FIXTURES — frontend/lib/__tests__/fixtures/capsuleTier0/*.json is empty.\n" +
        "        B4 has nothing to resolve an account against; the law is vacuous.");
    }
    return;
  }

  let mod;
  try {
    mod = await loadTs("frontend/lib/capsuleFactIndex.ts");
  } catch (e) {
    fail("B4", `capsuleFactIndex.ts could not be loaded: ${e?.message ?? e}`);
    return;
  }

  const periods = [];
  for (const f of D.fixtures) {
    let blob;
    try { blob = JSON.parse(read(f)); } catch { continue; }
    periods.push({
      periodId: path.basename(f, ".json"),
      periodLabel: blob?.period_label ?? blob?.label ?? path.basename(f, ".json"),
      currency: blob?.currency ?? "RON",
      entity: blob?.entity ?? "fixture",
      statements: blob,
      docId: path.basename(f),
    });
  }
  census.fixturePeriods = periods.length;

  let index;
  try {
    index = mod.buildFactIndex({ periods, activePeriodId: periods[0]?.periodId ?? null });
  } catch (e) {
    fail("B4", `buildFactIndex threw on the committed fixtures: ${e?.message ?? e}`);
    return;
  }
  census.factCount = index?.facts?.length ?? 0;

  // ── DISCOVERY: every account code the index actually knows ─────────
  const codes = new Set();
  for (const fact of index.facts ?? []) {
    for (const c of fact.accountCodes ?? []) {
      const s = String(c).trim();
      if (/^\d{3,4}$/.test(s)) codes.add(s);
    }
  }
  const codeList = [...codes].sort();
  census.accountCodes = codeList.length;

  // ── THE FLOOR, after the discovery loop ────────────────────────────
  if (codeList.length < EXPECT.accounts.minCodes) {
    fail("B4",
      `Only ${codeList.length} account code(s) discovered across ` +
      `${periods.length} fixture period(s); recorded expectation is >= ` +
      `${EXPECT.accounts.minCodes}.\n` +
      "        Every law below resolves codes from this set. An empty or thin set\n" +
      "        satisfies them without examining anything — which is the exact\n" +
      "        failure this floor exists to catch, and it is asserted HERE,\n" +
      "        after the loop, not inside it (TC-3).");
    return;
  }

  // ── THE LAW: a real code resolves, with provenance, under budget ───
  const t0 = process.hrtime.bigint();
  const unresolved = [];
  const unprovenanced = [];
  for (const code of codeList) {
    const keys = mod.matchFactKeys(index, code);
    if (!keys || keys.length === 0) { unresolved.push(code); continue; }
    const fact = mod.factFor(index, keys[0], index.activePeriodId) ??
                 (index.byKey.get(keys[0]) ?? [])[0];
    if (!fact) { unresolved.push(code); continue; }
    const prov = fact.provenance;
    if (!prov || (!prov.account && !prov.cell && !prov.docId)) unprovenanced.push(code);
  }
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  census.accountResolveMs = Math.round(elapsedMs * 100) / 100;

  // ── THE ROTATION CONTROL ───────────────────────────────────────────
  //
  // Any list of dead codes invites the reply "those codes are just not
  // in the data". The rotation refutes that without argument: build the
  // SAME index once per period, made active in turn, and watch the dead
  // set MOVE. A code that is genuinely absent is dead under every
  // rotation. A code that is dead only while some other period is
  // active is present, stored, and unreachable — which is a different
  // fact about the software, and the one N5 is about.
  const rotation = [];
  for (const active of periods.map((p) => p.periodId)) {
    const ordered = [...periods].sort(
      (a, b) => (a.periodId === active ? -1 : 0) - (b.periodId === active ? -1 : 0),
    );
    let ri;
    try { ri = mod.buildFactIndex({ periods: ordered, activePeriodId: active }); }
    catch { continue; }
    const rcodes = new Set();
    for (const f of ri.facts ?? []) {
      for (const c of f.accountCodes ?? []) {
        const s = String(c).trim();
        if (/^\d{3,4}$/.test(s)) rcodes.add(s);
      }
    }
    const dead = [...rcodes].sort().filter((c) => (mod.matchFactKeys(ri, c) ?? []).length === 0);
    rotation.push({ active, codes: rcodes.size, dead });
  }
  census.rotation = rotation.map((r) => ({ active: r.active, dead: r.dead.length }));
  const deadEverywhere = rotation.length
    ? rotation.reduce((acc, r) => acc.filter((c) => r.dead.includes(c)), rotation[0].dead)
    : [];
  const deadSometimes = [...new Set(rotation.flatMap((r) => r.dead))]
    .filter((c) => !deadEverywhere.includes(c)).sort();
  census.deadEverywhere = deadEverywhere.length;
  census.deadSometimes = deadSometimes.length;

  if (unresolved.length) {
    fail("B4",
      `${unresolved.length}/${codeList.length} account code(s) the index itself ` +
      "names do not resolve back through `matchFactKeys`:\n" +
      `        ${unresolved.slice(0, 14).join(", ")}${unresolved.length > 14 ? " …" : ""}\n` +
      "        N5: typing a code must resolve from the fact index. A code the\n" +
      "        index stored and cannot find again is a dead entry.\n" +
      "\n        ROTATION CONTROL — the same index, each period made active:\n" +
      rotation.map((r) =>
        `          active=${r.active.padEnd(24)} codes=${r.codes}  dead=${r.dead.length}  [${r.dead.join(", ")}]`,
      ).join("\n") +
      `\n        dead under EVERY rotation: ${deadEverywhere.length}` +
      `   dead under SOME rotation only: ${deadSometimes.length}\n` +
      (deadSometimes.length
        ? "\n        The dead set MOVES with the active period, and inverts — so these\n" +
          "        codes are not missing from the data. They are stored and\n" +
          "        unreachable. MECHANISM (`capsuleFactIndex.ts::buildTermIndex`):\n" +
          "        the loop reads `refs[0]` — the HEAD ref, which is the ACTIVE\n" +
          "        period's — and indexes only ITS `accountCodes`. Codes named only\n" +
          "        by another period's version of the same row are never added to\n" +
          "        the term index, so switching period silently un-teaches the\n" +
          "        capsule those codes. MEASURED: typing an unrecognised code and\n" +
          "        pressing Enter spends one model call and answers\n" +
          "        \"Reading account NNNN … unavailable\"\n" +
          "        (design_review/capsule-brief/probe-n5.json).\n" +
          "        Fix belongs to the fact-index owner: index every ref's codes,\n" +
          "        not the head's."
        : "\n        Every dead code is dead under every rotation, so this is an\n" +
          "        indexing gap that does not depend on the active period."));
  }
  if (unprovenanced.length) {
    fail("B4",
      `${unprovenanced.length}/${codeList.length} resolved fact(s) carry no ` +
      "provenance:\n" +
      `        ${unprovenanced.slice(0, 12).join(", ")}${unprovenanced.length > 12 ? " …" : ""}\n` +
      "        N4/C3: a figure reaches the reader with its source or not at all.");
  }
  const perCode = elapsedMs / codeList.length;
  if (perCode > EXPECT.accounts.maxResolveMs) {
    fail("B4",
      `Account resolution averaged ${perCode.toFixed(2)}ms per code; N5's budget ` +
      `is ${EXPECT.accounts.maxResolveMs}ms.`);
  }

  // ── THE HONESTY HALF: a fabricated code resolves to NOTHING ────────
  //
  // This is the positive control. Without it the three laws above are
  // satisfied by a `matchFactKeys` that returns everything for
  // everything — which would "resolve" 9999 just as confidently.
  const fabricated = ["9999", "8888", "7777"].filter((c) => !codes.has(c));
  const falsePositives = fabricated.filter((c) => (mod.matchFactKeys(index, c) ?? []).length > 0);
  census.fabricatedProbed = fabricated.length;
  if (fabricated.length === 0) {
    fail("B4",
      "NO CONTROL — every fabricated probe code is genuinely in the index, so the\n" +
      "        false-positive check examined nothing. Pick codes the fixtures do\n" +
      "        not contain.");
  } else if (falsePositives.length) {
    fail("B4",
      `The index resolves fabricated account code(s): ${falsePositives.join(", ")}.\n` +
      "        N5's second half: a code that is not in this period must be SAID to\n" +
      "        be absent, not answered. ABSENT is not a value.");
  } else if (!unresolved.length && !unprovenanced.length) {
    ok(`B4 accounts: ${codeList.length} real code(s) resolve with provenance in ` +
       `${census.accountResolveMs}ms total (${perCode.toFixed(3)}ms each); ` +
       `${fabricated.length} fabricated code(s) correctly refused`);
  }
}

// ══════════════════════════════════════════════════════════════════════
// B5 (N8) — subject floors
// ══════════════════════════════════════════════════════════════════════

function gateFloors() {
  const broken = [];
  if (D.navPaths.length === 0)
    broken.push("0 sidebar nav paths — B1's duplication law has nothing to compare against");
  if (D.restingSources.length === 0)
    broken.push("0 resting-surface source files — B3's tile-cap search examined nothing");
  if (D.fixtures.length === 0)
    broken.push("0 committed period fixtures — B4 resolved no account");
  if (!D.host)
    broken.push("0 bytes of CommandPalette.tsx — B1 and B3 read the host and found none");
  if (!D.suggestionsSrc)
    broken.push("capsuleSuggestions.ts not discovered — B2 measured no real builder");

  if (broken.length) {
    fail("B5",
      "DISCOVERY BROKEN — a census that finds nothing is broken, not clean:\n" +
      broken.map((b) => `        · ${b}`).join("\n"));
  } else {
    ok(`B5 floors: nav=${D.navPaths.length} resting=${D.restingSources.length} ` +
       `fixtures=${D.fixtures.length} host=${D.host.length}B`);
  }
}

// ══════════════════════════════════════════════════════════════════════

async function main() {
  gateRestingJumps();
  await gateDerivation();
  gateBudgets();
  await gateAccountLookup();
  gateFloors();

  if (CENSUS_ONLY) {
    console.log("CENSUS " + JSON.stringify(census, null, 2));
    console.log(`census-only: ${failures.length} violation(s) would have been raised, exit 0`);
    return 0;
  }

  for (const n of notes) console.log(`   ok  ${n}`);

  // ── WORK COUNT — machine readable, floored AFTER discovery ─────────
  //
  // The units are the things actually examined, not the things walked:
  // a gate that reports "42 files scanned" while every law short-
  // circuited is the report this repo has been burned by.
  const units =
    (census.buildersExamined ?? 0) +
    (census.unitsExamined ?? 0) +
    (census.accountCodes ?? 0) +
    (census.navPaths ?? 0);
  const FLOOR = 30;

  console.log(
    `GATE-WORK capsule-brief units=${units} floor=${FLOOR} ` +
    `label=builders+units+account-codes+nav-paths ` +
    `detail=builders:${census.buildersExamined ?? 0},units:${census.unitsExamined ?? 0},` +
    `codes:${census.accountCodes ?? 0},nav:${census.navPaths ?? 0}`,
  );

  if (units < FLOOR) {
    console.log(`\nFAIL check_capsule_brief — WORK COUNT BELOW FLOOR (${units} < ${FLOOR})`);
    console.log("  Every law in this file examines one of those four sets. A run that");
    console.log("  examined nothing satisfies all of them, which is why the count is");
    console.log("  floored here — after discovery — and not inside any loop.");
    if (PROBE_VACUITY) {
      // SELF-TEST CONVENTION: this mode asserts that the GATE fails, so
      // the mode exits 0 when it did. Wire it into CI as a positive
      // assertion beside the gate itself.
      console.log("\nPASS --probe-vacuity — discovery emptied, the gate FAILED as it must.");
      console.log("  The floor is load-bearing: with nothing to examine this file");
      console.log("  reports a failure rather than a clean sweep.");
      return 0;
    }
    return 1;
  }

  if (PROBE_VACUITY) {
    console.log("\nFAIL --probe-vacuity — THE GATE DID NOT FAIL WITH ITS DISCOVERY EMPTIED.");
    console.log(`  ${units} unit(s) of work were still reported against a floor of ${FLOOR},`);
    console.log("  which means some law reaches around the discovery sets and would");
    console.log("  keep reporting green over nothing. Route it through discover().");
    return 1;
  }

  if (failures.length === 0) {
    console.log(`\nPASS check_capsule_brief — B1..B5 (${units} units examined)`);
    return 0;
  }
  console.log(`\nFAIL check_capsule_brief — ${failures.length} violation(s)\n`);
  for (const f of failures) console.log(`  [${f.gate}] ${f.message}\n`);
  return 1;
}

process.exit(await main());
