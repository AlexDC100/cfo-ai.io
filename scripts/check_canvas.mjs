#!/usr/bin/env node
/**
 * check_canvas.mjs — THE CANVAS GATES, static half (A1s–A8s), AND the
 * single definition of the anchors the live half asserts.
 *
 * The live halves are `e2e/design/canvas.spec.ts` (CV-G1…CV-G6, the
 * surface) and `e2e/design/canvas-law.spec.ts` (A1–A9, the law). Both are
 * DISCOVERED rather than named, and both draw their anchors from this
 * file, so "what the canvas is made of" is written down exactly once and
 * the halves cannot drift.
 *
 * ══ WHY A STATIC HALF EXISTS AT ALL ═══════════════════════════════════
 *
 * Because on the day it was written the live half had NO SUBJECT. The
 * canvas source tree is 28 files and ~7,200 lines, and `CanvasPanel` is
 * imported by nothing outside its own directory — no route, no shell
 * mount. A Playwright suite pointed at that is the `tsc --noEmit`
 * disease with a browser attached: it would find no surface, assert
 * nothing, and the only honest thing it can print is that it found no
 * surface.
 *
 * So the laws that are decidable from source are decided from source,
 * TODAY, against a real subject; and L7 below reports the mount status
 * so nobody can read a green static half as a green live half. That is
 * TC-9 applied to a gate that arrived before its surface: the two
 * outputs — "clean" and "no subject" — must not be the same bytes.
 *
 * ══ THE LAWS ══════════════════════════════════════════════════════════
 *
 *  L1 ANCHORS ARE REAL. Every id in CANVAS_ANCHORS exists as a
 *     `data-testid` in the canvas source. A live gate whose selector
 *     matches nothing passes for free; that is the disease
 *     `scripts/check_stale_gates.mjs` found 33 instances of.
 *
 *  L2 NOTHING UNCLASSIFIED. Every `data-testid` canvas.spec.ts touches is
 *     in CANVAS_ANCHORS (must exist) or CANVAS_BANNED (must not). Mirrors
 *     the header lane's L6, for the same reason: an id that is neither
 *     is an assertion nobody has decided the meaning of.
 *
 *  L3 THE NUMERAL PATH (A1/A2, source half). Not one raw number formatter
 *     anywhere on this surface — `toLocaleString`, `toFixed`,
 *     `Intl.NumberFormat`. Every figure goes through `<Amount>`, which is
 *     the component the money path and the provenance dot hang off. Plus
 *     a per-file recorded expectation on how many `<Amount>` each renderer
 *     carries, because "no violations" cannot see a renderer that stopped
 *     rendering figures at all (TC-6: a floor on a sum cannot see one
 *     addend collapse, and "zero raw formatters" is satisfied perfectly by
 *     a file that renders nothing).
 *
 *  L4 NO PERSISTED FIGURE. Every `localStorage.setItem` on this surface is
 *     in a declared allowlist naming the file AND what it is allowed to
 *     store. A restored figure has no gateway behind it — it is a digit
 *     whose provenance is "a browser once wrote this down", which at the
 *     DOM is indistinguishable from a digit a model typed. A new
 *     persistence site is therefore a red until someone declares it.
 *
 *  L5 READ-ONLY (A7, source half). No mutating verb reachable from the
 *     canvas — no `.insert/.update/.upsert/.delete(` on a client, no
 *     POST/PUT/PATCH/DELETE fetch — except the ONE declared export
 *     endpoint, which is a POST that builds a file and writes no
 *     company data. Allowlisted by exact URL with its reason, never by
 *     pattern.
 *
 *  L6 NO RAW PAYLOAD IN THE DOM (A8, source half). No
 *     `dangerouslySetInnerHTML`; no `JSON.stringify` inside JSX. A
 *     degraded surface must say what happened, not paste the provider's
 *     error body onto the page.
 *
 *  L8 THE RENDERER LAYER IS REACHABLE. L1 can only see that an anchor
 *     exists in SOURCE. That is a weaker claim than "this anchor can
 *     render", and the gap is where a whole gate goes vacuous: nothing
 *     calls `registerCanvasArtifactRenderer`, so eleven renderers and
 *     every `artifact-*` testid they carry are unreachable from the
 *     running app while L1 reports them all present.
 *
 *  L7 MOUNT STATUS. Is `CanvasPanel` reachable from the app? While it is
 *     not, this script exits 1 saying SUBJECT NOT MOUNTED — because the
 *     live gates A1–A10 cannot be proven and a clean exit here would be
 *     read as if they had been. This clears itself the moment the surface
 *     is wired; nothing in this file needs editing when it is.
 *
 * Exit 0 clean; exit 1 with one ✗ per violation.
 * Run:  node scripts/check_canvas.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

export const CANVAS_DIR = "frontend/components/cfo/canvas";
export const CANVAS_STORE = "frontend/lib/canvasThread.ts";
export const CANVAS_EXPORT = "frontend/lib/artifactExport.ts";
/**
 * The live specs. DISCOVERED, not named — two lanes wrote canvas gates
 * on the same day and the second overwrote the first's file wholesale.
 * A hardcoded single filename made L2 blind to whichever file it was not
 * pointed at, which is the same shape as a census that walks one of two
 * halves. Every `e2e/design/canvas*.spec.ts` is in the law.
 */
export const CANVAS_SPEC_DIR = "e2e/design";
export const CANVAS_SPEC_RX = /^canvas.*\.spec\.ts$/;

// ══════════════════════════════════════════════════════════════════════
// THE ANCHORS — the one definition, imported by the live spec
// ══════════════════════════════════════════════════════════════════════

/**
 * Every anchor the live gates depend on, grouped by the gate that needs
 * it. Grouping is not decoration: L1 reports coverage PER GROUP, so a
 * whole gate's worth of anchors vanishing is visible as that gate going
 * dark rather than as a slightly smaller total.
 */
export const CANVAS_ANCHOR_GROUPS = Object.freeze({
  /** A0 — the surface exists and is the thing under test. */
  surface: Object.freeze([
    "canvas-panel",
    "canvas-header",
    "canvas-thread",
    "canvas-rail",
    "canvas-composer",
    "canvas-composer-block",
    "canvas-send",
    "canvas-entry",
    "canvas-question",
    "canvas-empty",
    "canvas-empty-commands",
    "canvas-resize",
    "canvas-slash-menu",
    "canvas-slash-item",
    "canvas-suggestion",
  ]),
  /** A1 — an artifact, its figures, and the citation that backs them. */
  artifact: Object.freeze([
    "canvas-artifact",
    "canvas-artifact-figures",
    "artifact-card",
    "artifact-title",
    "artifact-body",
    "artifact-citation",
    "artifact-evidence-panel",
    "artifact-table",
    "artifact-row",
    "artifact-chart",
    "artifact-comparison",
    "artifact-finding",
    "artifact-scenario",
    "artifact-export",
  ]),
  /** A4 — the honest gap. Absence renders as absence, never as a value. */
  gap: Object.freeze([
    // Was `artifact-cell-absent`; renamed to `artifact-figure-absent` by
    // the build lane. L1 caught the rename the same hour, which is the
    // only reason the A4 gate that names it is not now aimed at nothing.
    "artifact-figure-absent",
    "artifact-refused",
    "artifact-table-empty",
    "artifact-chart-empty",
    "artifact-chart-refusal",
    "artifact-scenario-empty",
    "artifact-scenario-withheld",
    "canvas-artifact-empty",
    "canvas-empty-nostate",
  ]),
  /** A5 — the unit the figures are stated in, and the basis of a compare. */
  unit: Object.freeze([
    "artifact-comparison-basis",
    "artifact-comparison-standard",
    "artifact-scenario-parity",
  ]),
  /** A8 — degraded: the stale record, the recompute door, the notice. */
  degraded: Object.freeze([
    "canvas-artifact-stale",
    "canvas-artifact-recompute",
    "canvas-artifact-pending",
    "canvas-artifact-renderer-note",
    "canvas-trust",
    "canvas-grounding",
    "artifact-finding-recompute",
  ]),
});

export const CANVAS_ANCHORS = Object.freeze(
  Object.values(CANVAS_ANCHOR_GROUPS).flat(),
);

/**
 * Ids the canvas must NOT render. Empty is a legitimate state for this
 * list and is NOT the same as "unchecked": L2 requires every id the spec
 * touches to be in one list or the other, so an id that is neither is a
 * violation whether or not this list has entries.
 */
export const CANVAS_BANNED = Object.freeze([]);

/**
 * Ids the canvas specs legitimately touch that belong to OTHER surfaces
 * — the app shell, the Capsule. They are classified so L2 stays strict,
 * and they are still stale-anchor checked, just against `frontend/` at
 * large instead of against the canvas directory: a canvas gate that
 * asserts "⌘K still opens the Capsule" is worthless the day
 * `command-palette` is renamed and nothing notices.
 */
export const CANVAS_FOREIGN = Object.freeze([
  "command-palette",         // the Capsule overlay — CV-G1 proves ⌘J/⌘K stay separate
  "account-menu-trigger",    // the app shell — the "shell re-mounted" signal
  "public-test-mode-banner", // PUBLIC_TEST_MODE chrome the specs dismiss
]);

// ══════════════════════════════════════════════════════════════════════
// DECLARED EXCEPTIONS — each one names a file and a reason
// ══════════════════════════════════════════════════════════════════════

/**
 * L4. Every localStorage write on this surface, and what it is allowed
 * to hold. A site not listed here is a red — that is the point. The
 * question a reviewer must answer for a new entry is "can a FIGURE reach
 * this key?", and the answer has to be no by construction, not by care.
 */
const PERSISTENCE_ALLOWLIST = new Map([
  [
    `${CANVAS_DIR}/CanvasPanel.tsx`,
    "the panel's pixel WIDTH. A layout number, not a fact: it is never "
    + "rendered as a figure and carries no unit, currency or provenance.",
  ],
  [
    `${CANVAS_DIR}/canvasPin.ts`,
    "pinned QUESTIONS. Every record goes through sanitize(), which drops "
    + "any title param that looksLikeFigure() — so a pin restores as a "
    + "standing question re-asked against the active period, never as a "
    + "cached December number sitting on a January dashboard.",
  ],
  [
    CANVAS_STORE,
    "the thread: questions, titles, timestamps, artifact title KEYS and "
    + "step labels. Built from the CANVAS_PERSISTED_KEYS allowlist, so a "
    + "field added to CanvasEntry is DROPPED by default rather than "
    + "silently written.",
  ],
]);

/**
 * L5. The one mutating request this surface may issue. Allowlisted by
 * exact path, with the reason, because a pattern allowlist ("/api/
 * artifacts/*") would also bless the write endpoint nobody has written
 * yet.
 */
const WRITE_ALLOWLIST = new Map([
  [
    "/api/artifacts/export",
    "builds a workbook/deck/doc from figures the client already resolved "
    + "and returns the bytes. It writes no company data; the POST is the "
    + "verb because the payload is a body, not because anything mutates.",
  ],
]);

/**
 * L3b. The renderer set is DISCOVERED, not listed: every `.tsx` under
 * `canvas/artifacts/` is a renderer and must be bound to the money path,
 * unless it is declared below with a reason. Discovery-by-default is the
 * same posture the thread store takes with its key allowlist — a new file
 * is IN the law until someone says why it is out, rather than out until
 * someone remembers to add it.
 *
 * The first draft of this law was a hand-written per-file COUNT map, and
 * it went red within the hour for two reasons that were both mine: the
 * counts had been taken with `grep -c "<Amount"`, which counts a line
 * mentioning `<Amount>` in a COMMENT and a line opening an
 * `<AmountGroup>` wrapper, while the gate counted comment-stripped
 * element opens. Two different rules produce two different numbers and
 * the difference reads as a regression. A count floor above 1 is also
 * brittle against a refactor that legitimately moves rendering between
 * files — and a gate that reds on correct work is a gate that gets
 * silenced. What actually needs to hold is BINARY and per component:
 * this renderer is bound to the money path, and it renders at least one
 * figure through it.
 */
const NON_RENDERERS = new Map([
  [
    "ArtifactReveal.tsx",
    "an animation wrapper. It renders children into a reveal transition "
    + "and holds no figure of its own.",
  ],
]);

/**
 * THE DECLARED MONEY PATHS. A figure reaches the reader through one of
 * these or it does not reach the reader at all.
 *
 * Two, not one, and the second was learned the same hour: the first
 * draft of this law knew only `<Amount>` and reported `DocumentArtifact`
 * as unbound. That renderer is prose, and prose figures go through
 * `<NarrativeText>` — the templatize-then-check path the narrative-units
 * gate already guards, which lifts each printed token back to the fact
 * it came from. Reporting it as off-path was a false red aimed at the
 * correct implementation. The list is explicit rather than a pattern so
 * that adding a third path is a decision somebody makes on purpose.
 */
const MONEY_PATHS = new Map([
  ["@/components/instrument/Amount", /<Amount(Group)?[\s/>]/g],
  ["@/lib/narrativeMoney", /<NarrativeText[\s/>]/g],
]);

/** L2's own anti-vacuity floor: the live spec must NAME anchors, not only
 *  interpolate them. 8 measured 2026-09-01. */
const SPEC_LITERAL_FLOOR = 6;

/**
 * L3c. A floor on DIRECT LEAVES — renderers that reach a money path
 * themselves rather than through another renderer — not on the volume of
 * render sites.
 *
 * The first draft floored the SITE COUNT at 8, and it went red twice in
 * one hour on correct work: the build lane consolidated rendering into
 * fewer components and the count fell 15 -> 10 -> 6 while every figure
 * still reached `<Amount>` through a delegation chain. Volume is not the
 * property. The property is that the chain TERMINATES: L3b's fixpoint
 * cannot mark anything compliant unless some renderer is directly bound,
 * so what has to be true is that at least one leaf exists — and a
 * surface where every renderer delegates and none renders is a cycle
 * with no figure at the end of it.
 *
 * The site count is still published, as telemetry rather than as a gate,
 * because a reader watching it fall to zero should be able to see that
 * without a red.
 */
const DIRECT_LEAF_FLOOR = 1;

// ══════════════════════════════════════════════════════════════════════
// WORK CENSUS — per component, asserted after discovery (TC-3, TC-6)
// ══════════════════════════════════════════════════════════════════════

/**
 * Each component names a canary it MUST have found and a floor it MUST
 * clear. A single total would let one law walk zero files while the
 * others carried the sum — the `import-boundary` failure verbatim.
 */
const CENSUS_FLOORS = [
  { id: "files", canary: `${CANVAS_DIR}/useCanvas.ts`, floor: 20,
    label: "canvas source files walked" },
  { id: "testids", canary: "canvas-artifact", floor: 60,
    label: "distinct data-testids found in canvas source" },
  { id: "anchors", canary: "canvas-panel", floor: 35,
    label: "declared anchors checked" },
  { id: "renderers", canary: `${CANVAS_DIR}/artifacts/ChartArtifact.tsx`, floor: 5,
    label: "artifact renderers discovered and checked" },
  { id: "amounts", canary: `${CANVAS_DIR}/artifacts/ChartArtifact.tsx`, floor: 8,
    label: "money-path render sites counted" },
];

// ══════════════════════════════════════════════════════════════════════

const failures = [];
const ok = [];
const fail = (law, msg) => failures.push(`  ✗ ${law}  ${msg}`);
const pass = (law, msg) => ok.push(`  ✓ ${law}  ${msg}`);

/**
 * PRODUCT SOURCE ONLY. `__tests__` trees are walked past.
 *
 * Not cosmetic: the moment the build lane added
 * `canvas/artifacts/__tests__/artifactGates.test.tsx`, L3b reported it as
 * an artifact renderer with no money path and L6 reported three
 * `JSON.stringify` calls "reaching the DOM". Both were false reds aimed
 * at a file whose entire job is to construct hostile payloads and assert
 * they are refused — a gate that reds on the tests written to satisfy it
 * gets switched off within a day.
 *
 * The obvious loophole (hide product code under `__tests__/` to escape
 * these laws) is not one worth defending against here: nothing imports a
 * `__tests__` file, so code parked there renders to nobody.
 */
function walk(dir, out = []) {
  const abs = path.join(ROOT, dir);
  if (!existsSync(abs)) return out;
  for (const name of readdirSync(abs)) {
    const rel = `${dir}/${name}`;
    if (statSync(path.join(ROOT, rel)).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      walk(rel, out);
      continue;
    }
    if (/\.(test|spec)\.tsx?$/.test(name)) continue;
    if (/\.(ts|tsx)$/.test(name)) out.push(rel);
  }
  return out;
}

const read = (rel) => {
  try {
    return readFileSync(path.join(ROOT, rel), "utf8");
  } catch {
    return null;
  }
};

/** Strip line and block comments so a law reads code, not prose about
 *  code. Without this every one of these bans fires on its own
 *  explanation — and a gate that reds on its own documentation gets its
 *  documentation deleted, which is the worst possible trade. */
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => (/^\s*\/\//.test(l) ? "" : l))
    .join("\n");
}

export function runCanvasGate() {
  const census = { files: 0, testids: 0, anchors: 0, renderers: 0, amounts: 0 };
  const censusCanaries = new Set();

  // ── discovery ───────────────────────────────────────────────────────
  const files = [...walk(CANVAS_DIR)];
  for (const extra of [CANVAS_STORE, CANVAS_EXPORT]) {
    if (existsSync(path.join(ROOT, extra))) files.push(extra);
  }
  census.files = files.length;

  const sources = new Map();
  for (const f of files) {
    const src = read(f);
    if (src === null) continue;
    sources.set(f, src);
    if (CENSUS_FLOORS.some((c) => c.canary === f)) censusCanaries.add(f);
  }

  // AN ID IS NOT ALWAYS SPELLED `data-testid=`.
  //
  // The documented trap, hit here verbatim: `check_stale_gates.mjs`'s
  // second draft matched `data-testid=` only and reported twenty LIVE
  // sidebar ids as stale, because they are declared in a config array as
  // `testId: "…"`. `ArtifactCard` does the same thing — its action row is
  // a component taking a `testId` prop, so `artifact-export`,
  // `artifact-refine`, `artifact-pin`, `artifact-copy` and
  // `artifact-evidence` never appear as a literal attribute. L1's first
  // run reported `artifact-export` as rendering nowhere while the button
  // is right there in the source. Three spellings, one set.
  const testids = new Set();
  const ID_PATTERNS = [
    /data-testid="([a-z0-9-]+)"/g,   // the attribute
    /testId="([a-z0-9-]+)"/g,        // passed as a JSX prop
    /testId:\s*"([a-z0-9-]+)"/g,     // declared in a config object
  ];
  for (const [, src] of sources) {
    for (const rx of ID_PATTERNS) {
      rx.lastIndex = 0;              // TC-3: /g regexes carry state per file
      for (const m of src.matchAll(rx)) testids.add(m[1]);
    }
  }
  census.testids = testids.size;
  for (const id of testids) {
    if (CENSUS_FLOORS.some((c) => c.canary === id)) censusCanaries.add(id);
  }

  // ── L1 — anchors are real ───────────────────────────────────────────
  {
    const missingByGroup = [];
    for (const [group, ids] of Object.entries(CANVAS_ANCHOR_GROUPS)) {
      const missing = ids.filter((id) => !testids.has(id));
      census.anchors += ids.length;
      if (missing.length) missingByGroup.push(`${group}: ${missing.join(", ")}`);
    }
    if (missingByGroup.length) {
      fail(
        "L1",
        `declared anchor(s) render nowhere in ${CANVAS_DIR} — ${missingByGroup.join(" | ")}. `
        + "A live assertion aimed at one of these passes for free, which is a "
        + "false green, not a missing test. Re-anchor it on what the surface "
        + "renders now, or delete the anchor AND the gate that used it.",
      );
    } else {
      pass("L1", `all ${census.anchors} declared anchors exist in canvas source `
        + `(${Object.keys(CANVAS_ANCHOR_GROUPS).length} groups)`);
    }
  }

  // ── L2 — nothing unclassified in the live specs ─────────────────────
  {
    const specFiles = existsSync(path.join(ROOT, CANVAS_SPEC_DIR))
      ? readdirSync(path.join(ROOT, CANVAS_SPEC_DIR))
        .filter((n) => CANVAS_SPEC_RX.test(n))
        .map((n) => `${CANVAS_SPEC_DIR}/${n}`)
        .sort()
      : [];
    if (!specFiles.length) {
      fail("L2", `no ${CANVAS_SPEC_DIR}/canvas*.spec.ts exists. The live half `
        + "of these gates is the half that can observe the surface; without it "
        + "this script is checking source text about a product nobody has "
        + "watched run.");
    } else {
      const used = new Map();          // id -> the spec files that name it
      for (const f of specFiles) {
        const specSrc = read(f) ?? "";
        const ids = [
          ...[...specSrc.matchAll(/getByTestId\(\s*"([^"]+)"/g)].map((m) => m[1]),
          ...[...specSrc.matchAll(/\[data-testid="([^"]+)"\]/g)].map((m) => m[1]),
        ].filter((id) => !id.includes("${"));
        for (const id of ids) {
          if (!used.has(id)) used.set(id, new Set());
          used.get(id).add(f);
        }
      }
      const classified = new Set(
        [...CANVAS_ANCHORS, ...CANVAS_BANNED, ...CANVAS_FOREIGN]);
      const unclassified = [...used.keys()].filter((id) => !classified.has(id));
      if (unclassified.length) {
        fail("L2", `unclassified testid(s) in `
          + `${[...new Set(unclassified.flatMap((id) => [...used.get(id)]))].join(", ")}: `
          + `${unclassified.join(", ")} — add each to CANVAS_ANCHORS (must exist `
          + "in the canvas), CANVAS_FOREIGN (belongs to another surface) or "
          + "CANVAS_BANNED (must not exist), so the next deletion trips L1 "
          + "instead of turning that assertion into a no-op.");
      } else if (used.size < SPEC_LITERAL_FLOOR) {
        // L2 IS SUBJECT TO ITS OWN RULE. "Every id is classified" is
        // trivially true of a spec that names none — and it would be,
        // the moment someone rewrote the selectors as `[data-testid=
        // "${id}"]`, which this check deliberately skips as loop bodies.
        // A clean L2 over zero literals is the tsc failure again, two
        // files down.
        fail("L2", `${specFiles.join(", ")} name only ${used.size} literal testid(s), `
          + `floor ${SPEC_LITERAL_FLOOR}. Nothing is unclassified because `
          + "almost nothing is classified: interpolated selectors are skipped "
          + "as loop bodies, so a spec built entirely from them makes this law "
          + "vacuously true. A gate whose clean output is its no-subject "
          + "output is not measuring (TC-9).");
      } else {
        pass("L2", `every testid the live spec(s) touch is classified `
          + `(${used.size} distinct, literal; floor ${SPEC_LITERAL_FLOOR}) `
          + `across ${specFiles.length} file(s): ${specFiles.map(
            (f) => path.basename(f)).join(", ")}`);
      }

      // FOREIGN ANCHORS ARE STILL ANCHORS. Checked against frontend/ at
      // large rather than the canvas directory, because that is where
      // they live — but checked, because a canvas gate asserting "⌘K
      // still opens the Capsule" is worthless the day `command-palette`
      // is renamed and only this file still says it.
      const touchedForeign = CANVAS_FOREIGN.filter((id) => used.has(id));
      const frontendIds = new Set();
      for (const rel of walk("frontend")) {
        const src = read(rel);
        if (src === null) continue;
        for (const m of src.matchAll(/data-testid=["'{`]*"?([a-z0-9-]+)"/g)) {
          frontendIds.add(m[1]);
        }
      }
      const staleForeign = touchedForeign.filter((id) => !frontendIds.has(id));
      if (staleForeign.length) {
        fail("L2b", `foreign anchor(s) the canvas specs depend on render `
          + `nowhere in frontend/: ${staleForeign.join(", ")}. These belong to `
          + "other surfaces (the Capsule, the app shell) and the canvas gates "
          + "assert against them; a renamed one turns those assertions into "
          + "no-ops.");
      } else if (touchedForeign.length) {
        pass("L2b", `${touchedForeign.length} foreign anchor(s) still exist in `
          + `frontend/ (${touchedForeign.join(", ")})`);
      }
    }
  }

  // ── L3 — the numeral path ───────────────────────────────────────────
  {
    const RAW = /\btoLocaleString\s*\(|\btoFixed\s*\(|\bIntl\.NumberFormat\b/;
    const offenders = [];
    for (const [f, src] of sources) {
      const c = code(src);
      for (const [i, line] of c.split("\n").entries()) {
        if (RAW.test(line)) offenders.push(`${f}:${i + 1}`);
      }
    }
    if (offenders.length) {
      fail("L3a", `raw number formatter(s) on the canvas surface: `
        + `${offenders.join(", ")}. Every figure here is a resolved fact `
        + "rendered through <Amount>, which is where the unit, the currency "
        + "and the provenance dot come from. A number formatted any other way "
        + "is a digit with no gateway behind it — and NO EXCEPTION FOR "
        + '"it is just a chart label".');
    } else {
      pass("L3a", `no raw number formatters in ${sources.size} canvas file(s)`);
    }

    // Renderers are DISCOVERED under canvas/artifacts/. A file that is
    // not a renderer must say so in NON_RENDERERS; silence means it is
    // one and the law applies.
    const renderers = new Map();
    for (const [f, src] of sources) {
      if (!f.startsWith(`${CANVAS_DIR}/artifacts/`) || !f.endsWith(".tsx")) continue;
      const base = path.basename(f);
      if (NON_RENDERERS.has(base)) continue;
      census.renderers += 1;
      if (CENSUS_FLOORS.some((c) => c.canary === f)) censusCanaries.add(f);
      const c = code(src);
      let sites = 0;
      let bound = false;
      for (const [mod, elementRx] of MONEY_PATHS) {
        if (!new RegExp(`from\\s+["']${mod.replace(/[/]/g, "\\/")}["']`).test(c)) continue;
        bound = true;
        sites += (c.match(new RegExp(elementRx.source, "g")) ?? []).length;
      }
      census.amounts += sites;
      renderers.set(f, { base, code: c, direct: bound && sites >= 1 });
    }

    // DELEGATION IS COMPLIANCE. `SpreadsheetArtifact` renders its sheets
    // by handing them to `TableArtifact`; it holds no figure of its own
    // and importing the money path would be dead weight. Composition is
    // the right shape, so the law follows the figure to wherever it is
    // actually printed: a renderer is compliant if it is directly bound,
    // or if it delegates to a renderer that is. Computed to a fixpoint so
    // a two-hop chain resolves; a cycle simply never becomes compliant,
    // which is the correct verdict for figures that reach no money path.
    for (let changed = true; changed;) {
      changed = false;
      for (const [f, r] of renderers) {
        if (r.direct) continue;
        for (const [g, other] of renderers) {
          if (g === f || !other.direct) continue;
          const name = other.base.replace(/\.tsx$/, "");
          if (new RegExp(`from\\s+["']\\.\\/${name}["']`).test(r.code)
            && new RegExp(`<${name}[\\s/>]`).test(r.code)) {
            r.direct = true;
            r.viaDelegation = name;
            changed = true;
            break;
          }
        }
      }
    }

    const unbound = [];
    for (const [f, r] of renderers) {
      if (r.direct) continue;
      unbound.push(`${f} (no declared money path, no delegation)`);
    }
    if (unbound.length) {
      fail("L3b", `artifact renderer(s) not bound to the money path: `
        + `${unbound.join(", ")}. L3a cannot see this — a renderer that prints `
        + "no figure at all has zero raw formatters and passes perfectly. "
        + "Every figure on this surface is a resolved fact rendered through a "
        + `declared money path (${[...MONEY_PATHS.keys()].join(", ")}) or `
        + "through a renderer that is. One that reaches neither is either "
        + "printing figures some other way or has stopped printing them. If it "
        + "is genuinely not a renderer, declare it in NON_RENDERERS with the "
        + "reason.");
    } else {
      const delegated = [...renderers.values()].filter((r) => r.viaDelegation).length;
      pass("L3b", `${census.renderers} discovered renderer(s) all reach a `
        + `declared money path (${census.renderers - delegated} directly, `
        + `${delegated} by delegation; ${census.amounts} render sites)`);
    }
    const leaves = [...renderers.values()].filter((r) => r.direct && !r.viaDelegation);
    if (leaves.length < DIRECT_LEAF_FLOOR) {
      fail("L3c", `${leaves.length} renderer(s) reach a money path DIRECTLY, `
        + `floor ${DIRECT_LEAF_FLOOR}. Every compliant renderer above is `
        + "compliant because some chain of delegation ends at a leaf; with no "
        + "leaf, the chain ends nowhere and no figure reaches the money path.");
    } else {
      pass("L3c", `${leaves.length} direct money-path leaf/leaves `
        + `(${census.amounts} render sites — published, not gated: the count `
        + "moves with legitimate consolidation)");
    }
  }

  // ── L4 — no persisted figure ────────────────────────────────────────
  {
    const sites = [];
    for (const [f, src] of sources) {
      if (/localStorage\s*\.\s*setItem\s*\(/.test(code(src))) sites.push(f);
    }
    const undeclared = sites.filter((f) => !PERSISTENCE_ALLOWLIST.has(f));
    if (undeclared.length) {
      fail("L4a", `undeclared persistence site(s): ${undeclared.join(", ")}. `
        + "Every localStorage write on this surface must be declared in "
        + "PERSISTENCE_ALLOWLIST with what it is allowed to hold. A figure "
        + "read back out of storage has no gateway behind it, and a December "
        + "number restored over January is still TRUE, which is exactly what "
        + "makes it unreadable as stale.");
    } else {
      pass("L4a", `${sites.length} persistence site(s), all declared`);
    }

    const store = sources.get(CANVAS_STORE);
    if (store && !/CANVAS_PERSISTED_KEYS/.test(store)) {
      fail("L4b", `${CANVAS_STORE} no longer defines CANVAS_PERSISTED_KEYS. `
        + "That allowlist is what makes a new CanvasEntry field DROPPED by "
        + "default instead of silently written; without it the store's rule "
        + "depends on whoever adds the next field remembering it.");
    } else if (store) {
      pass("L4b", "the thread store still serializes through its key allowlist");
    }

    // L4c asserts the LAW, not an identifier. Its first draft named the
    // predicate `looksLikeFigure` and went red an hour later when the
    // build lane replaced it with `isSafeTitleParam` imported from the
    // thread store — a STRICTLY BETTER version of the same law. A red for
    // an improvement is a false red, and a false red is as corrosive as a
    // false green because it teaches the next reader to silence the gate.
    // What must hold is that the pin store consults the ONE authority on
    // what a figure is, rather than keeping a second, inevitably more
    // lenient, opinion of its own.
    const pin = sources.get(`${CANVAS_DIR}/canvasPin.ts`);
    if (pin) {
      const c = code(pin);
      const imp = c.match(
        /import\s*\{([^}]*)\}\s*from\s*["']@\/lib\/canvasThread["']/);
      const shared = imp
        ? imp[1].split(",").map((s) => s.trim())
          .filter((s) => s && !s.startsWith("type "))
          .map((s) => s.split(/\s+as\s+/)[0].trim())
        : [];
      const body = c.slice(c.indexOf("function sanitize"));
      const consulted = shared.filter((sym) => new RegExp(`\\b${sym}\\s*\\(`).test(body));
      if (!shared.length || !consulted.length) {
        fail("L4c", `${CANVAS_DIR}/canvasPin.ts does not consult the thread `
          + "store's figure predicate inside sanitize(). "
          + (shared.length
            ? `It imports {${shared.join(", ")}} from @/lib/canvasThread but calls `
              + "none of them there."
            : "It imports no value from @/lib/canvasThread at all.")
          + " A pin is a standing QUESTION; the moment one can carry a value, "
          + '"live card" quietly means "cached card". Two sanitizers with two '
          + "rules is how one of them ends up being the lenient one.");
      } else {
        pass("L4c", `pins sanitize through the thread store's own predicate `
          + `(${consulted.join(", ")})`);
      }
    }
  }

  // ── L5 — read-only ──────────────────────────────────────────────────
  {
    const MUTATE_CALL = /\.(insert|update|upsert|delete)\s*\(\s*[^)\s]/;
    const MUTATE_VERB = /method:\s*["'](POST|PUT|PATCH|DELETE)["']/;
    const hits = [];
    for (const [f, src] of sources) {
      const c = code(src);
      const lines = c.split("\n");
      for (const [i, line] of lines.entries()) {
        if (MUTATE_CALL.test(line)) {
          // `listeners.delete(cb)` / `map.delete(k)` — a Set/Map, not a
          // data store. Named exactly, never waved past by pattern.
          if (/\b(listeners|turns|cache|seen|pending)\s*\.\s*delete\s*\(/.test(line)) continue;
          hits.push({ f, i, line: line.trim(), kind: "client-mutation" });
        }
        if (MUTATE_VERB.test(line)) {
          const window_ = lines.slice(Math.max(0, i - 6), i + 3).join("\n");
          const allowed = [...WRITE_ALLOWLIST.keys()].some((u) => window_.includes(u));
          if (!allowed) hits.push({ f, i, line: line.trim(), kind: "mutating-fetch" });
        }
      }
    }
    if (hits.length) {
      fail("L5", `write path(s) reachable from the canvas: `
        + hits.map((h) => `${h.f}:${h.i + 1} [${h.kind}] ${h.line}`).join(" | ")
        + ". The canvas is a READING instrument. The only mutating request it "
        + "may issue is the declared export endpoint, which returns bytes and "
        + "writes no company data.");
    } else {
      pass("L5", `no undeclared write path in ${sources.size} canvas file(s) `
        + `(${WRITE_ALLOWLIST.size} allowlisted endpoint)`);
    }
  }

  // ── L6 — no raw payload in the DOM ──────────────────────────────────
  {
    const hits = [];
    for (const [f, src] of sources) {
      if (!f.endsWith(".tsx")) continue;
      const c = code(src);
      for (const [i, line] of c.split("\n").entries()) {
        if (/dangerouslySetInnerHTML/.test(line)) hits.push(`${f}:${i + 1} innerHTML`);
        if (/\{\s*JSON\.stringify\s*\(/.test(line)) hits.push(`${f}:${i + 1} JSON in JSX`);
      }
    }
    if (hits.length) {
      fail("L6", `raw payload can reach the DOM: ${hits.join(", ")}. A degraded `
        + "canvas must say what happened in reviewed copy. Pasting the "
        + "provider's error body onto the page leaks request ids and provider "
        + "slugs to the reader and teaches them the product is broken in a "
        + "way they cannot act on.");
    } else {
      pass("L6", "no innerHTML and no JSON payload rendered into JSX");
    }
  }

  // ── L7 — mount status ───────────────────────────────────────────────
  let mounted = false;
  {
    // MOUNTED MEANS RENDERED, and the import may be relative.
    //
    // The first draft matched only the ALIASED specifier
    // (`@/components/cfo/canvas`). `AppShell.tsx` imports
    // `from "./canvas"`, so when the build lane wired the panel in, this
    // law went on printing SUBJECT NOT MOUNTED against a mounted
    // surface. A gate that cannot see its subject arrive is the same
    // false reading as one that cannot see it leave — it just fails in
    // the safe direction, which is how it survives review. Caught by
    // running it, not by reading it.
    //
    // Two conditions, because an unused import is not a mount: the
    // specifier must resolve into this directory, and the component must
    // actually appear as an element.
    const importers = [];
    const IMPORT_RX = /import\s*\{[^}]*\bCanvasPanel\b[^}]*\}\s*from\s*["']([^"']+)["']/g;
    for (const rel of walk("frontend")) {
      if (rel.startsWith(`${CANVAS_DIR}/`)) continue;
      const src = read(rel);
      if (src === null) continue;
      const c = code(src);
      IMPORT_RX.lastIndex = 0;                 // TC-3: /g regexes carry state
      let m;
      let resolves = false;
      while ((m = IMPORT_RX.exec(c)) !== null) {
        if (/(^|\/)canvas(\/CanvasPanel)?$/.test(m[1])) resolves = true;
      }
      if (resolves && /<CanvasPanel[\s/>]/.test(c)) importers.push(rel);
    }
    mounted = importers.length > 0;
    if (!mounted) {
      fail("L7", "SUBJECT NOT MOUNTED — CanvasPanel is imported by nothing "
        + `outside ${CANVAS_DIR}, so there is no route and no shell slot that `
        + "renders the canvas. The live gates in " + CANVAS_SPEC + " therefore "
        + "have no surface to observe, and a clean exit here would be read as "
        + "if they had passed. This is the correct state of this gate until "
        + "the panel is wired into the app; nothing in this file needs "
        + "changing when it is.");
    } else {
      pass("L7", `CanvasPanel is mounted by ${importers.join(", ")} — the live `
        + "gates have a subject");
    }
  }

  // ── L8 — the renderer layer is REACHABLE ────────────────────────────
  //
  // L1 asserts that an anchor exists in the canvas SOURCE. That is not
  // the same claim as "this anchor can render", and the gap between them
  // is where a whole gate goes quietly vacuous.
  //
  // MEASURED 2026-09-01, and this is the finding that produced the law:
  // `canvasArtifactRegistry` is a seam — `CanvasArtifactCard` asks
  // `canvasArtifactRenderer(kind)` and falls back to a figure list when
  // it returns null. NOTHING CALLS `registerCanvasArtifactRenderer`.
  // Eleven renderers and ~2,900 lines under `canvas/artifacts/` —
  // TableArtifact, ChartArtifact, ComparisonArtifact, ScenarioArtifact,
  // FindingArtifact, SpreadsheetArtifact, DocumentArtifact and the
  // ArtifactCard chrome that carries `artifact-export`, `artifact-refine`
  // and `artifact-evidence` — are unreachable from the running app.
  // Every one of their `artifact-*` testids exists in source, so L1 is
  // satisfied; none of them can appear on screen, so every live gate
  // aimed at one asserts about an element the product cannot paint.
  //
  // That is why the live A6 reported "the artifact card offers no
  // artifact-export": a true statement, and not the one it looks like.
  {
    let registrations = 0;
    const sites = [];
    for (const rel of walk("frontend")) {
      const src = read(rel);
      if (src === null) continue;
      const c = code(src);
      const n = (c.match(/registerCanvasArtifactRenderer\s*\(/g) ?? []).length;
      // The definition and the re-export are not registrations.
      if (n && !/export function registerCanvasArtifactRenderer/.test(c)
        && !/^\s*registerCanvasArtifactRenderer,\s*$/m.test(c)) {
        registrations += n;
        sites.push(`${rel} x${n}`);
      }
    }
    if (registrations === 0) {
      fail("L8", "the artifact renderer registry is EMPTY — nothing calls "
        + "registerCanvasArtifactRenderer(), so every artifact falls back to "
        + `the figure list and all ${census.renderers} renderers under `
        + `${CANVAS_DIR}/artifacts/ are unreachable from the running app. `
        + "Their data-testids exist in source, which is all L1 can see, so "
        + "live gates aimed at artifact-export / artifact-table / "
        + "artifact-chart assert about elements the product cannot paint. "
        + "A gate pointed at a latent anchor is a false green with extra "
        + "steps.");
    } else {
      // A REGISTRATION IN AN UNIMPORTED MODULE REGISTERS NOTHING.
      // `registerCanvasArtifactRenderer(...)` at module scope only runs
      // if something imports the module — and a side-effect import
      // (`import "./canvasArtifactBridge";`) is exactly the kind of line
      // a tidy-up deletes because it "imports nothing". That would empty
      // the registry silently while this law kept counting the calls, so
      // the law follows the same latent-vs-live distinction it exists to
      // make.
      const orphans = [];
      for (const site of sites) {
        const file = site.split(" x")[0];
        const base = path.basename(file).replace(/\.tsx?$/, "");
        let imported = false;
        for (const [other, src] of sources) {
          if (other === file) continue;
          // COMMENT-STRIPPED. The first draft tested the raw source, so
          // planting `// import "./canvasArtifactBridge";` left the check
          // green — the law read a commented-out import as a live one.
          // Every other law here reads `code(src)`; this one did not, and
          // the plant is what said so.
          const c = code(src);
          if (new RegExp(`from\\s+["']\\.\\/${base}["']`).test(c)
            || new RegExp(`import\\s+["']\\.\\/${base}["']`).test(c)) {
            imported = true;
            break;
          }
        }
        if (!imported) orphans.push(file);
      }
      if (orphans.length) {
        fail("L8b", `renderer registration(s) live in module(s) nothing `
          + `imports: ${orphans.join(", ")}. Module-scope registration only `
          + "runs when the module is loaded; an unimported one leaves the "
          + "registry empty while this law happily counts its calls. If the "
          + "hook is a bare side-effect import, say so at the import site — "
          + 'it is the first line a cleanup deletes for "importing nothing".');
      } else {
        pass("L8", `${registrations} renderer registration(s) in module(s) the `
          + `canvas imports — the artifact layer is reachable (${sites.join(", ")})`);
      }
    }
  }

  // ── census, asserted AFTER discovery, per component ─────────────────
  console.log("CANVAS GATE — static half (L1–L8)");
  console.log("=".repeat(62));
  for (const c of CENSUS_FLOORS) {
    const units = census[c.id];
    console.log(`GATE-WORK canvas-${c.id} units=${units} floor=${c.floor} `
      + `label=${c.label}`);
  }
  let censusBroken = false;
  for (const c of CENSUS_FLOORS) {
    const units = census[c.id];
    const sawCanary = censusCanaries.has(c.canary);
    if (units < c.floor || !sawCanary) {
      censusBroken = true;
      fail("CENSUS", `${c.id}: ${units} unit(s), floor ${c.floor}; canary `
        + `${c.canary} ${sawCanary ? "seen" : "NOT seen"}. A census that finds `
        + "nothing is a broken gate, not a passing one — and a floor on the "
        + "TOTAL cannot see one law walk zero files while the others carry the "
        + "sum.");
    }
  }
  if (!censusBroken) {
    pass("CENSUS", `every law examined its subject `
      + `(${census.files} files, ${census.testids} testids, `
      + `${census.anchors} anchors, ${census.renderers} renderers)`);
  }

  for (const line of ok) console.log(line);
  if (failures.length) {
    console.log("");
    for (const line of failures) console.log(line);
    console.log("");
    console.log(`${failures.length} violation(s). See design_review/canvas/GATES.md.`);
    if (!mounted) {
      console.log("");
      console.log("NOTE — while L7 is the only failure above, the STATIC laws");
      console.log("are all green and the LIVE laws are unproven. Those are");
      console.log("different states and this gate refuses to print one as the");
      console.log("other.");
    }
    return 1;
  }
  console.log("");
  console.log("  all clean — static AND mounted.");
  return 0;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(runCanvasGate());
