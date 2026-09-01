#!/usr/bin/env node
/**
 * THE ARTIFACTS — static law (Part B).
 *
 * Four things a runtime suite cannot see, because they are about what
 * the SOURCE contains rather than what one render produced:
 *
 *   B-COMPLETE  every one of the eight artifact kinds is wired end to
 *               end — a schema walk, a dispatcher branch, a renderer, a
 *               fixture, and a gate case. This is TC-6 applied to the
 *               lane's own structure: a kind that quietly loses its
 *               renderer would still leave seven kinds passing every
 *               runtime assertion, and the suite's total would look
 *               healthy.
 *
 *   B-NOLIB     no chart library is imported anywhere under
 *               artifacts/**. `recharts` is in package.json and one
 *               `import` away; it brings its own palette, grid, type
 *               scale and tooltip, and every one of those is a second
 *               design system arriving under a component name. The
 *               charts are hand-drawn over `artifactGeometry` for
 *               exactly this reason, and nothing but a lint keeps it
 *               that way.
 *
 *   B-ONEACCENT every colour in an artifact resolves to a TOKEN. The
 *               repo-wide `check_design_lint.mjs` catches raw hex; this
 *               is stricter and narrower — inside this lane a fill or a
 *               stroke must be `hsl(var(--…))`, so a chart cannot
 *               acquire a second hue through an rgb() or a named colour
 *               that no hex lint would ever see.
 *
 *   B-REDRESERVED  semantic red (`--alert`) appears ONLY where it means
 *               something: a negative magnitude on a chart, a negative
 *               delta in a table, a disagreeing reconciliation, and a
 *               critical finding's severity chip. Red as "series 2" is
 *               how a palette loses its one signal.
 *
 * Every count is asserted AFTER the discovery walk, per kind and per
 * rule (TC-3 / TC-6), and the script prints what it examined so a green
 * run carries information (TC-9).
 *
 * Zero dependencies.
 *   node scripts/check_artifact_law.mjs
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not URL.pathname — the repo path contains spaces.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LANE = "frontend/components/cfo/canvas/artifacts";
const LANE_DIR = join(ROOT, LANE);

const rel = (p) => relative(ROOT, p).split(sep).join("/");

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(p)) yield p;
  }
}

const problems = [];
const fail = (rule, where, detail) => problems.push({ rule, where, detail });

if (!existsSync(LANE_DIR)) {
  console.error(`DISCOVERY BROKEN — ${LANE} does not exist.`);
  process.exit(1);
}

const files = [...walk(LANE_DIR)];
const source = new Map(files.map((f) => [rel(f), readFileSync(f, "utf8")]));

// ── the eight kinds, read from the source of truth ─────────────────────

const specSrc = source.get(`${LANE}/artifactSpec.ts`);
if (!specSrc) {
  console.error(`DISCOVERY BROKEN — artifactSpec.ts not found under ${LANE}.`);
  process.exit(1);
}
const kindsBlock = /export const ARTIFACT_KINDS = \[([\s\S]*?)\] as const;/.exec(specSrc);
if (!kindsBlock) {
  console.error("DISCOVERY BROKEN — ARTIFACT_KINDS could not be read from artifactSpec.ts.");
  process.exit(1);
}
const KINDS = [...kindsBlock[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);

// TC-3 — the canary. A census that lost its subject must fail LOUDLY
// rather than report a clean eight-of-eight over nothing. Two checks,
// because a count alone can be right for the wrong reason: the arity,
// and named members at both ends of the list.
if (KINDS.length !== 8) {
  console.error(`DISCOVERY BROKEN — found ${KINDS.length} kind(s), expected 8: ${KINDS.join(",")}`);
  process.exit(1);
}
for (const canary of ["chart", "finding"]) {
  if (!KINDS.includes(canary)) {
    console.error(`DISCOVERY BROKEN — canary kind "${canary}" absent from ARTIFACT_KINDS.`);
    process.exit(1);
  }
}

// ── B-COMPLETE — five wirings per kind ─────────────────────────────────

const dispatcher = source.get(`${LANE}/Artifact.tsx`) ?? "";
const fixtures = source.get(`${LANE}/artifactFixtures.ts`) ?? "";
const gateFile = source.get(`${LANE}/__tests__/artifactGates.test.tsx`) ?? "";

/**
 * The dispatcher has TWO places a kind must appear, and the census has
 * to look at each of them SEPARATELY.
 *
 * The first draft searched the whole file for `kind === "<kind>"`. A
 * refuter deleted the comparison branch outright and the gate still
 * printed 7/7 for every kind — because `figureCensus()`, a helper at
 * the bottom of the same file, also names every kind. The detector's
 * subject had been removed and its canary survived, which is TC-6's
 * exact shape: "a canary names a file, a floor names a number, and both
 * can survive the failure they exist to catch."
 *
 * So the two blocks are extracted by their own boundaries and searched
 * one at a time. A kind that loses either half now fails.
 */
function block(text, startMarker, endMarker) {
  const from = text.indexOf(startMarker);
  if (from < 0) return "";
  const to = text.indexOf(endMarker, from + startMarker.length);
  return to < 0 ? "" : text.slice(from, to);
}
const RESOLVE_BLOCK = block(dispatcher, "const built = useMemo(", "}, [spec, evidence, trust]);");
const RENDER_BLOCK = block(dispatcher, "<ArtifactCard", "</ArtifactCard>");
if (!RESOLVE_BLOCK || !RENDER_BLOCK) {
  console.error(
    "DISCOVERY BROKEN — the dispatcher's resolve/render blocks could not be located; " +
      "every wiring check below would examine an empty string.",
  );
  process.exit(1);
}

/** Which file renders each kind. A kind whose renderer moves must move
 *  this table too, which is the point: the binding is declared, not
 *  guessed from a filename. */
const RENDERER = {
  chart: "ChartArtifact.tsx",
  table: "TableArtifact.tsx",
  spreadsheet: "SpreadsheetArtifact.tsx",
  slide: "SlideArtifact.tsx",
  document: "DocumentArtifact.tsx",
  scenario: "ScenarioArtifact.tsx",
  comparison: "ComparisonArtifact.tsx",
  finding: "FindingArtifact.tsx",
};

const wiring = {};
for (const kind of KINDS) {
  const rendererFile = RENDERER[kind];
  const renderer = rendererFile ? source.get(`${LANE}/${rendererFile}`) : undefined;
  const w = {
    schema: new RegExp(`kind === "${kind}"\\)|kind: "${kind}"`).test(specSrc),
    walk: new RegExp(`walk${kind[0].toUpperCase()}${kind.slice(1)}\\b`).test(specSrc),
    resolved: new RegExp(`kind: "${kind}" as const`).test(RESOLVE_BLOCK),
    rendered: new RegExp(`built\\.kind === "${kind}"`).test(RENDER_BLOCK),
    renderer: Boolean(renderer),
    rootTestId: renderer ? /data-testid="artifact-/.test(renderer) : false,
    fixture: new RegExp(`kind: "${kind}"`).test(fixtures),
    gated: new RegExp(`kind: "${kind}"`).test(gateFile),
  };
  wiring[kind] = w;
  for (const [prop, ok] of Object.entries(w)) {
    if (!ok) fail("B-COMPLETE", kind, `missing wiring: ${prop}`);
  }
}

// ── B-NOLIB — no chart library under the lane ──────────────────────────

const CHART_LIBS = ["recharts", "chart.js", "d3-shape", "victory", "nivo", "echarts", "plotly"];

// The OTHER `artifactSpec`. `frontend/lib/artifactSpec.ts` is the
// pipeline lane's WIRE contract with `_artifact_spec.py`; it exports a
// symbol called `ARTIFACT_SPEC_VERSION` and one called `ARTIFACT_KINDS`
// with the same names and a DIFFERENT vocabulary. A file inside this
// lane importing it would resolve those names to the wrong contract,
// and the mistake reads as correct code. The two must never meet.
const FOREIGN_SPEC = "@/lib/artifactSpec";

let importsScanned = 0;
for (const [path, body] of source) {
  for (const m of body.matchAll(/from\s+"([^"]+)"/g)) {
    importsScanned += 1;
    const spec = m[1];
    for (const lib of CHART_LIBS) {
      if (spec === lib || spec.startsWith(`${lib}/`)) {
        fail("B-NOLIB", path, `imports ${spec}`);
      }
    }
    if (spec === FOREIGN_SPEC) {
      fail("B-NOLIB", path, `imports ${FOREIGN_SPEC} — that is the WIRE contract, not the canvas one`);
    }
  }
}

// ── B-ONEACCENT — colours are tokens ───────────────────────────────────

// A colour VALUE in a style/attribute position. Anything that is not
// `hsl(var(--token))`, `currentColor`, `none`, `transparent` or `inherit`
// is a hard-coded colour, whether or not it is a hex literal.
const COLOR_VALUE = /(?:fill|stroke|background|color)\s*[:=]\s*[{"]?\s*["`]?([^"`;}\n]+)/gi;
const TOKEN_OK = /^(hsl\(var\(--|var\(--|currentColor$|none$|transparent$|inherit$)/;
let colorValuesScanned = 0;
for (const [path, body] of source) {
  if (path.includes("/__tests__/")) continue;
  COLOR_VALUE.lastIndex = 0;
  let m;
  while ((m = COLOR_VALUE.exec(body)) !== null) {
    const value = m[1].trim();
    // Tailwind class strings and JSX expressions referencing a helper
    // are not colour literals; only a literal value is.
    if (!/^(#|rgb|hsl|[a-z]+$)/i.test(value)) continue;
    if (/^[a-z]+$/i.test(value) && !/^(red|blue|green|black|white|orange|yellow|purple|gray|grey)$/i.test(value)) {
      continue;
    }
    colorValuesScanned += 1;
    if (!TOKEN_OK.test(value)) fail("B-ONEACCENT", path, `hard-coded colour: ${value}`);
  }
}

// ── B-REDRESERVED — semantic red only where it means something ─────────

/** Where `--alert` / `alert` may appear, and why. Anything else is red
 *  spent on decoration. */
const RED_ALLOWED = new Map([
  [`${LANE}/ChartArtifact.tsx`, "a NEGATIVE magnitude, and a bridge that does not reconcile"],
  [`${LANE}/TableArtifact.tsx`, "a negative DELTA — a movement the reader must notice"],
  [`${LANE}/FindingArtifact.tsx`, "a critical finding's own severity, as the engine graded it"],
]);
let redSites = 0;
for (const [path, body] of source) {
  if (path.includes("/__tests__/")) continue;
  const hits = [...body.matchAll(/(?:--alert|\balert-tint\b|\btext-alert\b|\bborder-alert\b|\bbg-alert\b)/g)];
  if (hits.length === 0) continue;
  redSites += hits.length;
  if (!RED_ALLOWED.has(path)) {
    fail("B-REDRESERVED", path, `${hits.length} use(s) of semantic red outside the allowlist`);
  }
}

// ── report ─────────────────────────────────────────────────────────────

const kindLines = KINDS.map((k) => {
  const w = wiring[k];
  const ok = Object.values(w).filter(Boolean).length;
  return `  ${k.padEnd(12)} ${ok}/${Object.keys(w).length} wirings`;
});

console.log("ARTIFACT LAW");
console.log("==============================================================");
console.log(kindLines.join("\n"));
console.log(
  `GATE-WORK artifact-law units=${files.length} kinds=${KINDS.length} imports=${importsScanned} colors=${colorValuesScanned} red=${redSites}`,
);

// Floors, asserted AFTER the walk (TC-3) and per component (TC-6).
const FLOORS = { files: 14, imports: 60, red: 4, colors: 3 };
let floorBroken = false;
if (files.length < FLOORS.files) {
  console.error(`WORK FLOOR — ${files.length} lane file(s), floor ${FLOORS.files}`);
  floorBroken = true;
}
if (importsScanned < FLOORS.imports) {
  console.error(`WORK FLOOR — ${importsScanned} import(s) scanned, floor ${FLOORS.imports}`);
  floorBroken = true;
}
if (colorValuesScanned < FLOORS.colors) {
  console.error(
    `WORK FLOOR — ${colorValuesScanned} colour value(s) examined, floor ${FLOORS.colors}. ` +
      `Zero would mean the token rule found nothing to check, not that every colour is a token.`,
  );
  floorBroken = true;
}
if (redSites < FLOORS.red) {
  console.error(
    `WORK FLOOR — ${redSites} semantic-red site(s), floor ${FLOORS.red}. ` +
      `Zero would mean the red rule examined nothing, not that red is unused.`,
  );
  floorBroken = true;
}

if (problems.length === 0 && !floorBroken) {
  console.log(`\nPASS — 8/8 kinds wired, no chart library, colours are tokens, red is reserved.`);
  process.exit(0);
}

for (const rule of ["B-COMPLETE", "B-NOLIB", "B-ONEACCENT", "B-REDRESERVED"]) {
  const rows = problems.filter((p) => p.rule === rule);
  if (rows.length === 0) continue;
  console.error(`\n${rule} — ${rows.length} violation(s):`);
  for (const r of rows) console.error(`  ${r.where}: ${r.detail}`);
}
process.exit(1);
