#!/usr/bin/env node
/**
 * F2, THE STATIC HALF — a projected figure cannot be painted as a fact.
 *
 * ══ WHY A SCRIPT AND NOT ONLY A TYPE ═════════════════════════════════
 *
 * The type barrier in `frontend/lib/forecastFacts.ts` is the strong half:
 * `ProjectedMinor` has no widening path to `number`, so no actuals
 * formatter and no figure primitive can accept a projection, and
 * `scripts/check_tsc.mjs` fails if that ever stops being true.
 *
 * What a type cannot see is the ESCAPE. `figure.amountMinor as unknown as
 * number` compiles, and so does a surface that reads the raw wire dict
 * off a fetch and paints `String(f.amount_minor_projected)` through no
 * typed accessor at all. Those are exactly the shapes the provenance
 * census declares it cannot see either — its own header says a `.ts`
 * module that builds a figure string and hands it to a `.tsx` painting
 * `{label}` "through no primitive and no formatter" is outside its reach.
 * This gate covers that hole for the forecast namespace specifically, and
 * it is the ONLY instrument that will catch the first forecast surface
 * that gets it wrong — because today there are no forecast surfaces, so
 * every screen-level gate is green by vacuity.
 *
 * ══ WHAT IT REDS ON, AFTER THE REPAIR (TC-11) ════════════════════════
 *
 *   · a `.tsx` that imports `@/lib/forecastFacts` and paints a projected
 *     figure without going through `<ProjectedAmount>` — the one
 *     sanctioned consumer of the marker;
 *   · a cast that launders a projected amount into a plain `number`
 *     anywhere outside `forecastFacts.ts` itself, where the single
 *     documented door lives;
 *   · a read of the raw wire field (`amount_minor_projected`) outside the
 *     gateway modules — a surface that skipped the typed accessor;
 *   · the two serving namespaces importing each other, in EITHER
 *     direction, on the engine side or the frontend side. A boundary that
 *     one side can reach across is not a boundary;
 *   · `engine/forecast_serving` importing the PRODUCER (`engine.forecast`
 *     or `engine.forecast_drivers`). Newly load-bearing: `adapter.py`
 *     converts the producer's `forecast_v1` bytes into fp1, and the
 *     one-line "improvement" is to take a `Projection` object instead of
 *     its dict — at which point the boundary lives inside the thing it
 *     bounds;
 *   · the two RECOGNISERS drifting apart — `boundary.py`'s
 *     `_is_projection_node` and `forecastFacts.ts`'s `looksProjected` are
 *     the same guard written twice in two runtimes that cannot share a
 *     module, and a signal only one of them knows is a shape only one of
 *     them can catch. Wave 1 shipped with NEITHER knowing the producer's
 *     own `forecast_v1` stamp, and nothing static compared them;
 *   · the base-book pointer roster losing one producer's word for it
 *     (`base_period` / `opening`) on either side;
 *   · the sanctioned primitive losing its marker: `<ProjectedAmount>`
 *     must render the value and the projected mark in ONE expression, so
 *     no code path paints one without the other;
 *   · a projected figure rendered through an ACTUALS primitive by name
 *     (`<Amount>`, `<Money>`, `<LearnableNumber>`, `<TraceableNumber>` …)
 *     in any file that also reads the forecast namespace.
 *
 * ══ WHAT IT CANNOT SEE (TC-11) ═══════════════════════════════════════
 *
 *   · a surface that copies the fp1 JSON into its own local interface and
 *     never imports this namespace at all. Nothing static catches a
 *     re-declaration; the engine-side marker (`projected: true` on every
 *     serialized figure) is what a reviewer greps for then.
 *   · whether the two recognisers BEHAVE the same. It compares the signals
 *     they name, not what they do with them. The behavioural proof is the
 *     pair of suites, each of which plants a real `forecast_v1` projection
 *     into a real committed book and asserts the leak path.
 *   · whether the served wire form actually parses. That is a round trip,
 *     not a source scan: `test_the_wire_form_reads_back_through_its_own_
 *     gateway` on the engine side and the "wire form the engine actually
 *     serves" block on the frontend side, both over committed bytes.
 *   · whether the rendered mark is LEGIBLE. That is a design question and
 *     belongs to a live spec, not to a source scan.
 *   · the exports. They do not exist yet (wave 2) — and the reason the
 *     distinction is carried by data rather than by CSS is precisely so
 *     that when they arrive they consume the same marker.
 *
 * Zero dependencies. `node scripts/check_forecast_boundary.mjs`
 * `--probe-vacuity` empties discovery and REQUIRES a failure (TC-3): a
 * gate that finds nothing is broken, not clean.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not URL.pathname — this repo's path contains spaces.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROBE_VACUITY = process.argv.includes("--probe-vacuity");

const FORECAST_LIB = "frontend/lib/forecastFacts.ts";
const PRIMITIVE = "frontend/components/forecast/ProjectedAmount.tsx";
const ENGINE_PROJECTION = "src/engine/forecast_serving";
const ENGINE_ACTUALS = "src/engine/serving";

/** Figure primitives built for ACTUALS. A projected figure reaching one of
 *  these is the defect in its purest form. Enumerated from the provenance
 *  census's own PRIMITIVES roster so the two cannot disagree about what a
 *  figure primitive is. */
const ACTUALS_PRIMITIVES = [
  "Amount",
  "MoneyAmount",
  "PercentLevel",
  "CappedMultiple",
  "PpDelta",
  "Money",
  "LearnableNumber",
  "LearnableMetricCard",
  "TraceableNumber",
  "NarrativeText",
];

const failures = [];
const notes = [];
const fail = (msg) => failures.push(msg);

// ── discovery ────────────────────────────────────────────────────────

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|py)$/.test(name)) out.push(full);
  }
  return out;
}

const files = PROBE_VACUITY
  ? []
  : [...walk(join(ROOT, "frontend")), ...walk(join(ROOT, "src", "engine"))];

const rel = (f) => relative(ROOT, f).split("\\").join("/");
const read = (f) => {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return "";
  }
};

// ── the roster must be real ──────────────────────────────────────────

const forecastLibPath = join(ROOT, FORECAST_LIB);
const primitivePath = join(ROOT, PRIMITIVE);
const libSource = read(forecastLibPath);
const primitiveSource = read(primitivePath);

if (!PROBE_VACUITY) {
  if (!libSource) fail(`ROSTER STALE: ${FORECAST_LIB} does not exist`);
  if (!primitiveSource) fail(`ROSTER STALE: ${PRIMITIVE} does not exist`);
  if (libSource && !/export type ProjectedMinor\b/.test(libSource)) {
    fail(
      `${FORECAST_LIB} no longer declares ProjectedMinor — the opaque type IS ` +
        `the compile barrier`,
    );
  }
  // Strip comments first: this module's own header NAMES the formatters it
  // refuses to contain, and a scan that reds on its own documentation is a
  // scan nobody can leave switched on.
  const libCode = libSource
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
  if (libCode && /\.toFixed\(|\.toLocaleString\(|Intl\.NumberFormat\(/.test(libCode)) {
    fail(
      `${FORECAST_LIB} contains a formatter. This module returns typed ` +
        `objects; painting them is the surface's job, and a second money ` +
        `formatter here is a second opinion about how money looks.`,
    );
  }
}

// ── the two recognisers must know the same signals ───────────────────
//
// `boundary.py::_is_projection_node` and `forecastFacts.ts::looksProjected`
// are the SAME guard, written twice, in two runtimes that cannot share a
// module. Wave 1 taught what one of them missing a signal costs: neither
// knew the producer's own `forecast_v1` shape, so a real 16-period
// projection pasted into a served envelope produced ZERO leak paths on
// both sides. Nothing static compared them, so the omission was invisible.
//
// This does not prove they behave identically — only that every signal one
// names, the other names too. The behavioural proof is the pair of suites
// (`test_forecast_serving_boundary.py` / `forecastFactsBoundary.test.ts`),
// each of which plants the producer's shape into a real committed book.

const RECOGNISER_SIGNALS = [
  "amount_minor_projected",
  "assumption_ids",
  "forecast_v1",
];

/** Source with its prose removed.
 *
 *  Load-bearing, and measured: the first draft of this check compared the
 *  RAW text, and the plant that renamed `PRODUCER_SCHEMAS` on the frontend
 *  side PASSED — because `forecastFacts.ts` explains `forecast_v1` in a
 *  comment three lines above. A scan fooled by its own documentation is the
 *  same defect as a scan that reds on it, and this file already carries the
 *  second lesson (see the formatter check below). Both halves of every one
 *  of these files are heavily commented BY DESIGN, so nothing here may
 *  compare anything but code. */
const stripProse = (src, lang) => {
  const withoutBlocks =
    lang === "py"
      ? src.replace(/"""[\s\S]*?"""/g, "").replace(/'''[\s\S]*?'''/g, "")
      : src.replace(/\/\*[\s\S]*?\*\//g, "");
  const lineComment = lang === "py" ? /^\s*#/ : /^\s*(\/\/|\*)/;
  return withoutBlocks
    .split("\n")
    .filter((line) => !lineComment.test(line))
    .join("\n");
};

if (!PROBE_VACUITY) {
  const boundaryPy = read(join(ROOT, ENGINE_PROJECTION, "boundary.py"));
  const contractPy = read(join(ROOT, ENGINE_PROJECTION, "contract.py"));
  const enginePair = stripProse(`${boundaryPy}\n${contractPy}`, "py");
  const frontendCode = stripProse(libSource, "ts");
  if (!boundaryPy) fail(`ROSTER STALE: ${ENGINE_PROJECTION}/boundary.py is gone`);
  // The comparison is worthless if stripping ate the code as well as the
  // prose, so prove both sides still carry something to compare (TC-3).
  if (enginePair.length < 1000 || frontendCode.length < 1000) {
    fail(
      `comment-stripping left ${enginePair.length} engine / ` +
        `${frontendCode.length} frontend characters — too little to compare, ` +
        `so this check would be green by vacuity`,
    );
  }
  for (const signal of RECOGNISER_SIGNALS) {
    const inEngine = enginePair.includes(signal);
    const inFrontend = frontendCode.includes(signal);
    if (inEngine !== inFrontend) {
      fail(
        `the projection recogniser knows ${signal} on ` +
          `${inEngine ? "the ENGINE side only" : "the FRONTEND side only"}. ` +
          `The two guards are the same guard written twice; a signal only ` +
          `one of them knows is a shape only one of them can catch.`,
      );
    }
  }
  // The base-book pointer key roster, same reasoning: fp1 calls it
  // `base_period`, the producer calls it `opening`, and a side that knows
  // only one of them either reds on correct code or exempts too much.
  const contractCode = stripProse(contractPy, "py");
  for (const key of ["base_period", "opening"]) {
    if (!contractCode.includes(`"${key}"`) || !frontendCode.includes(`"${key}"`)) {
      fail(
        `the base-book pointer key ${key} is missing from ` +
          `${contractCode.includes(`"${key}"`) ? FORECAST_LIB : `${ENGINE_PROJECTION}/contract.py`}. ` +
          `Both producers' names for the same pointer have to be exempt on ` +
          `both sides, or one side reds on a correct projection.`,
      );
    }
  }
}

// ── the primitive renders value and mark in ONE expression ───────────

if (primitiveSource) {
  if (!primitiveSource.includes("data-projected-value")) {
    fail(`${PRIMITIVE}: the value is not tagged data-projected-value`);
  }
  if (!primitiveSource.includes("data-projected-mark")) {
    fail(
      `${PRIMITIVE}: the projected MARK is gone. The mark is not decoration ` +
        `— it is rendered from the same marker, in the same expression as ` +
        `the value, so no code path paints one without the other.`,
    );
  }
  if (!/projectedDisplay\(/.test(primitiveSource)) {
    fail(
      `${PRIMITIVE}: no longer reads the value through projectedDisplay, so ` +
        `it no longer takes delivery of the marker`,
    );
  }
  const valueIdx = primitiveSource.indexOf("data-projected-value");
  const markIdx = primitiveSource.indexOf("data-projected-mark");
  const displayIdx = primitiveSource.indexOf("projectedDisplay(");
  if (valueIdx > -1 && markIdx > -1 && displayIdx > -1) {
    if (!(displayIdx < valueIdx && valueIdx < markIdx)) {
      fail(
        `${PRIMITIVE}: value and mark are no longer inside the one ` +
          `projectedDisplay callback`,
      );
    }
  }
}

// ── per-file rules ───────────────────────────────────────────────────

let tsChecked = 0;
let pyChecked = 0;
let consumers = 0;

for (const file of files) {
  const path = rel(file);
  const src = read(file);
  if (!src) continue;

  const isTest = /__tests__|\.test\.|\.spec\.|^tests\//.test(path);

  if (path.endsWith(".py")) {
    pyChecked += 1;
    // Neither engine namespace may import the other.
    if (path.startsWith(ENGINE_PROJECTION)) {
      if (/from\s+\.\.serving|import\s+engine\.serving|from\s+engine\.serving/.test(src)) {
        fail(
          `${path} imports the ACTUALS serving gateway. The two namespaces ` +
            `must not reach across: a boundary one side can cross is not one.`,
        );
      }
      // ...and it must not import the PRODUCER either. This was never
      // checked, and it became load-bearing when `adapter.py` arrived: the
      // adapter turns `forecast_v1` into fp1, and the one-line "improvement"
      // is to take a `Projection` object instead of its dict. A boundary
      // that lives inside the thing it bounds is not a boundary, and this
      // package's own docstring promises it imports neither producer.
      if (/from\s+engine\.forecast(_drivers)?\b|import\s+engine\.forecast(_drivers)?\b|from\s+\.\.forecast(_drivers)?\b/.test(src)) {
        fail(
          `${path} imports the projection PRODUCER (engine.forecast / ` +
            `engine.forecast_drivers). The serving boundary reads a DICT, ` +
            `never the model: a boundary that lives inside the thing it ` +
            `bounds is not a boundary.`,
        );
      }
    }
    if (path.startsWith(ENGINE_ACTUALS)) {
      if (/forecast_serving|forecast_drivers|engine\.forecast\b/.test(src)) {
        fail(
          `${path} names the projection namespace. The actuals gateway must ` +
            `not know projections exist, or a consumer will eventually get ` +
            `one out of it.`,
        );
      }
    }
    continue;
  }

  tsChecked += 1;

  const importsForecast =
    /from\s+["'](@\/lib\/forecastFacts|\.\/forecastFacts|\.\.\/lib\/forecastFacts)["']/.test(
      src,
    ) || /from\s+["'][^"']*forecastFacts["']/.test(src);

  // servedFacts must not know about projections, in either direction.
  if (path === "frontend/lib/servedFacts.ts" && /forecastFacts|ProjectedMinor/.test(src)) {
    fail(
      `frontend/lib/servedFacts.ts names the projection namespace. The ` +
        `actuals gateway must not know projections exist.`,
    );
  }
  if (path === FORECAST_LIB && /from\s+["'][^"']*servedFacts["']/.test(src)) {
    fail(
      `${FORECAST_LIB} imports servedFacts. The projection gateway computes ` +
        `nothing from actuals; it reads a projection payload and nothing else.`,
    );
  }

  if (!importsForecast) continue;
  consumers += 1;

  // A cast that launders the opaque amount into a plain number.
  if (path !== FORECAST_LIB && !isTest) {
    const laundering =
      /amountMinor\s+as\s+unknown\s+as\s+number/.test(src) ||
      /as\s+unknown\s+as\s+number/.test(src);
    if (laundering) {
      fail(
        `${path} casts a projected amount into a plain number. The single ` +
          `documented door is unwrapProjected(), which hands over the marker ` +
          `in the same call.`,
      );
    }
    if (/\bamount_minor_projected\b/.test(src)) {
      fail(
        `${path} reads the raw wire field amount_minor_projected. Read it ` +
          `through readProjection() so the basis comes with it.`,
      );
    }
  }

  // A .tsx consumer must paint through the sanctioned primitive — but ONLY
  // if it actually touches a projected VALUE. A surface that reads the
  // namespace to list the drivers and their stated bases, and paints no
  // projected figure at all, has nothing to mislabel; requiring the
  // primitive there would be this gate reddening on correct code, which is
  // the gate being wrong (TC-11). The AI-surface roster in
  // engine/forecast_serving/boundary.py carries the same lesson, learned
  // the same way.
  const touchesAValue =
    /\bprojectedDisplay\s*\(|\bunwrapProjected\s*\(|\.amountMinor\b/.test(src);
  if (path.endsWith(".tsx") && path !== PRIMITIVE && !isTest && touchesAValue) {
    if (!/\bProjectedAmount\b/.test(src)) {
      fail(
        `${path} reaches a projected VALUE but does not use ` +
          `<ProjectedAmount>. It is the one sanctioned consumer of the ` +
          `projected marker; a surface that paints a projection any other ` +
          `way is painting it as a fact.`,
      );
    }
    for (const primitive of ACTUALS_PRIMITIVES) {
      const tag = new RegExp(`<${primitive}[\\s/>]`);
      if (tag.test(src)) {
        fail(
          `${path} renders <${primitive}> in a file that also reaches a ` +
            `projected value. ${primitive} is an ACTUALS primitive: it ` +
            `offers a source-cell affordance a projection cannot honour.`,
        );
      }
    }
  }
}

// ── report ───────────────────────────────────────────────────────────

console.log("FORECAST BOUNDARY GATE (F2, static half)");
console.log("=".repeat(62));
// `units=` is the count scripts/run_battery.py reads (plan/2 B0). The
// per-runtime counts stay on the same line so a collapse of one runtime
// cannot hide inside the total.
console.log(
  `GATE-WORK forecast-boundary units=${tsChecked + pyChecked} ts=${tsChecked} ` +
    `py=${pyChecked} consumers=${consumers} label=files-scanned`,
);
// A scan over nothing is a broken gate, never a clean one (TC-3). The
// floors below catch a partial collapse; this names the total one.
if (tsChecked + pyChecked === 0) {
  fail(
    "ZERO FILES SCANNED — discovery found no .ts, .tsx or .py file under " +
      "frontend/ or src/engine/. Nothing was checked, so nothing may pass.",
  );
}

// ── plan/2 B13 (minimal cut): THE SCENARIOS PAGE COMPUTES NOTHING ──────
//
// Until B13 the Scenarios page ran its own cascade in the browser
// (`lib/scenarios/cascade.ts` over `baseline.ts`, defect 0.5) and never read
// the forecast namespace, so every rule above was green over it by vacuity and
// this gate printed it as EXCLUDED. At the cut-over it joins the scope, and it
// joins with a rule of its own: the page's whole import CLOSURE — the page,
// every module it imports, and theirs, resolved inside frontend/ — may not
// reach a client scenario-math module. A direct-import check alone would pass
// a page that reaches the cascade through a component (the old page imported
// it through ScenarioComparison and CovenantPanel as well as directly).
//
// RED ON (TC-11): the page, or anything it imports, importing a module under
// frontend/lib/scenarios/ (cascade, baseline, covenants, levers, templates,
// types, dashboardCanon) or the old input store frontend/stores/scenario.tsx;
// the closure not reaching frontend/lib/forecastFacts.ts (the one reader of
// a served projection); the page no longer POSTing the engine
// (`forecastRecompute`); the page file missing (a closure over nothing).
//
// CANNOT SEE: a dynamic import built from a string; a surface that copies the
// fp1 JSON into its own local interface (the header above says the same).
//
// The old cascade renderers under frontend/components/scenarios/ stay on disk
// (a sign-flip canary still renders ScenarioComparison) and are printed below
// as unreachable from the page, so their presence is never read as coverage.

const SCENARIOS_PAGE = "frontend/pages/cfo/Scenarios.tsx";
const SCENARIOS_CLIENT_MATH = [
  /^frontend\/lib\/scenarios\//,
  /^frontend\/stores\/scenario\.tsx$/,
];

/** Every module a file reaches through static imports, re-exports and
 *  literal dynamic imports, resolved inside frontend/ (`@/` and relative
 *  specifiers; packages are outside the question). */
export function importClosure(root, startRel) {
  const exts = ["", ".ts", ".tsx", ".json", "/index.ts", "/index.tsx"];
  const resolveSpec = (fromAbs, spec) => {
    let base;
    if (spec.startsWith("@/")) base = join(root, "frontend", spec.slice(2));
    else if (spec.startsWith(".")) base = join(fromAbs, "..", spec);
    else return null;
    for (const ext of exts) {
      const candidate = base + ext;
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        /* not this extension */
      }
    }
    return null;
  };
  const importRx =
    /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\sfrom\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  const seen = new Set();
  const stack = [join(root, startRel)];
  while (stack.length > 0) {
    const abs = stack.pop();
    if (seen.has(abs)) continue;
    let src;
    try {
      src = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    seen.add(abs);
    if (abs.endsWith(".json")) continue;
    for (const m of src.matchAll(importRx)) {
      const target = resolveSpec(abs, m[1] ?? m[2]);
      if (target && !seen.has(target)) stack.push(target);
    }
  }
  return [...seen].map((abs) => relative(root, abs).split("\\").join("/")).sort();
}

let scenariosClosure = [];
if (!PROBE_VACUITY) {
  const pageSource = read(join(ROOT, SCENARIOS_PAGE));
  if (!pageSource) {
    fail(`ROSTER STALE: ${SCENARIOS_PAGE} does not exist — a closure over nothing checks nothing`);
  } else {
    scenariosClosure = importClosure(ROOT, SCENARIOS_PAGE);
    for (const mod of scenariosClosure) {
      if (SCENARIOS_CLIENT_MATH.some((rx) => rx.test(mod))) {
        fail(
          `${SCENARIOS_PAGE} reaches ${mod} through its imports. The Scenarios ` +
            `page computes nothing: every figure it shows is served by ` +
            `/api/forecast/{id}/recompute and read through ${FORECAST_LIB} ` +
            `(plan/2 B13, one engine). A client scenario-math module in its ` +
            `closure is a second calculator wearing the engine's labels.`,
        );
      }
    }
    if (!scenariosClosure.includes(FORECAST_LIB)) {
      fail(
        `${SCENARIOS_PAGE} no longer reaches ${FORECAST_LIB}. A Scenarios page ` +
          `that does not read the served projection is painting figures from ` +
          `somewhere else.`,
      );
    }
    // Line comments first, then blocks: a `//` line naming a path that ends
    // in `/*` would otherwise open a block that swallows the code after it.
    const pageCode = pageSource
      .split("\n")
      .filter((line) => !/^\s*\/\//.test(line))
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    if (!/\bforecastRecompute\s*\(/.test(pageCode)) {
      fail(
        `${SCENARIOS_PAGE} no longer POSTs /api/forecast/{id}/recompute ` +
          `(cfoApi.forecastRecompute). Its templates are lever sets the ENGINE ` +
          `runs; a page that stops asking the engine is computing its own.`,
      );
    }
  }
}
const scenariosSurface = scenariosClosure.filter((p) =>
  /^frontend\/(pages\/cfo\/Scenarios\.tsx|components\/scenarios\/|lib\/scenarioTemplates)/.test(p),
);
const unreachableScenarios = files
  .map(rel)
  .filter(
    (p) =>
      /^frontend\/(components\/scenarios\/|lib\/scenarios\/|stores\/scenario\.tsx)/.test(p) &&
      !/__tests__/.test(p) &&
      !scenariosClosure.includes(p),
  )
  .sort();
console.log(
  `  scope: forecast-namespace consumers in frontend/ and the two serving ` +
    `namespaces in src/engine/; the Scenarios page's import closure ` +
    `(${scenariosClosure.length} module(s)) against client scenario math:`,
);
for (const p of scenariosSurface) console.log(`    in the Scenarios closure: ${p}`);
for (const p of unreachableScenarios) {
  console.log(`    unreachable from the Scenarios page (not coverage): ${p}`);
}
console.log(
  `GATE-WORK forecast-boundary-scenarios units=${scenariosClosure.length} ` +
    `label=modules-in-scenarios-closure`,
);
// The floors run in BOTH modes on purpose: emptying discovery has to break
// something, and these are what it breaks. Floors derived from the measured
// tree on 2026-09-08 (739 ts / 380 py) with generous headroom, so ordinary
// churn does not move them and a collapse is loud.
if (tsChecked < 300) {
  fail(
    `only ${tsChecked} TypeScript file(s) scanned; discovery is broken ` +
      `(the tree carries far more)`,
  );
}
if (pyChecked < 100) {
  fail(`only ${pyChecked} Python file(s) scanned; discovery is broken`);
}
if (consumers < 1) {
  fail(
    `no file imports the forecast namespace — not even its own test. A ` +
      `gate with no consumer to check is green by vacuity.`,
  );
}
notes.push(
  `  forecast-namespace consumers found: ${consumers} ` +
    `(the primitive, its lib and the boundary suite today; every wave-2 ` +
    `surface joins this count)`,
);

if (PROBE_VACUITY) {
  if (failures.length === 0) {
    console.log(
      "\nPROBE FAILED — discovery was emptied and the gate still passed. " +
        "A census that finds nothing is broken, not clean.",
    );
    process.exit(1);
  }
  console.log(
    `\nPROBE OK — emptied discovery produced ${failures.length} failure(s), ` +
      `so the gate is not green by vacuity.`,
  );
  process.exit(0);
}

for (const note of notes) console.log(note);

if (failures.length > 0) {
  console.log("\nFAIL — a projected figure can be painted as a fact:\n");
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}

console.log(
  `\nPASS — ${consumers} forecast-namespace consumer(s); no laundering cast, ` +
    `no raw-wire read, no actuals primitive over a projection, and neither ` +
    `serving namespace reaches across to the other.`,
);
