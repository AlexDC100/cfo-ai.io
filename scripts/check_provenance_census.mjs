#!/usr/bin/env node
/**
 * THE PROVENANCE CENSUS — every figure render site, and its verdict.
 *
 * ══ WHY A REGISTRY AND NOT A HEURISTIC ═══════════════════════════════
 *
 * Whether a figure SHOULD carry the provenance affordance is a question
 * about its PAYLOAD, and no regex can read a payload. What a script can
 * do is make the question unavoidable: it discovers every site, and any
 * site not carrying a recorded verdict fails.
 *
 * Two-sided, the same protocol PLANT_MANIFEST.json uses:
 *   · a figure-render file with no registry entry           => FAIL
 *   · a registry entry whose file renders no figures        => FAIL
 *   · a file whose measured counts drift from its entry     => FAIL
 *
 * The third is the one that earns its keep. Adding an `<Amount>` to a
 * page changes its count, and the author has to answer "does this
 * payload carry provenance?" before the gate goes green. That is the
 * whole mechanism: not a rule anybody remembers, a number that moves.
 *
 * ══ THE FOUR BUCKETS ══════════════════════════════════════════════════
 *
 *   HAS_SHOWS      payload carries provenance, affordance is rendered
 *   HAS_MISSING    payload carries it, affordance is NOT rendered — work
 *   LACKS_SILENT   payload carries none, nothing claimed — correct
 *   LACKS_SHOWS    payload carries none, affordance rendered anyway —
 *                  A FABRICATED AFFORDANCE. The worst bucket. A figure
 *                  that offers a provenance jump and lands nowhere
 *                  teaches the reader the affordance is decorative, and
 *                  then the ones that DO land stop being believed.
 *
 * LACKS_SHOWS is never an acceptable steady state: the gate fails on it.
 *
 * ══ THE FABRICATION ANTIBODY ══════════════════════════════════════════
 *
 * One real defect was found by reading, at
 * CapsuleTier0Preview.tsx: `{ source: fact.periodLabel || ... }`. A
 * period is not a source, `periodLabel` is present on every fact, and
 * the card labels that field "Source" — so every Tier-0 figure told the
 * reader an origin it did not have, while discarding the sheet and
 * account codes it DID have.
 *
 * That shape is now mechanically detected: a `source:` fed from an
 * identifier that names a PERIOD, a SCOPE, a DATE or a LABEL. The next
 * one will look different, which is why the registry exists too — but
 * this one cannot come back.
 *
 * ══ WORK + FLOOR + CANARY ═════════════════════════════════════════════
 *
 * Exit zero is half a verdict. This prints how many files it scanned,
 * how many figure sites it found, and a CANARY it must see. A census
 * that finds nothing is broken, not clean (TC-3).
 *
 * Zero dependencies. `node scripts/check_provenance_census.mjs`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not URL.pathname — this repo's path contains spaces and
// pathname would keep them percent-encoded.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FE = join(ROOT, "frontend");
const REGISTRY_PATH = join(ROOT, "design_review", "PROVENANCE_CENSUS.json");

// ── floors + canaries ──────────────────────────────────────────────────

/** Files walked. Far below the real count; a collapse to a handful means
 *  the walk broke, which is the failure mode this catches. */
const FLOOR_FILES = 300;
/** Figure sites discovered across the product. */
const FLOOR_SITES = 80;
/** Files carrying a verdict. */
const FLOOR_REGISTERED = 20;
/** Sites that actually RENDER the affordance. A pass with zero of these
 *  is the lane's own work having silently disappeared. */
const FLOOR_AFFORDANCES = 10;
/** Files allowed to carry no payload verdict yet. A ceiling, not a
 *  floor: it may shrink, never grow. Measured 2026-09-02 at 12. */
const CEILING_UNAUDITED = 12;

/** Files the census MUST see. Absent => DISCOVERY BROKEN. Each is here
 *  because it is a named surface in the mission: the instrument itself,
 *  a statement, a Capsule answer, a finding. */
const CANARIES = [
  "frontend/components/instrument/Amount.tsx",
  "frontend/components/cfo/BSStatementView.tsx",
  "frontend/components/instrument/shell/capsuleAnswer/CapsuleFigures.tsx",
  "frontend/components/cfo/findings/parts.tsx",
];

// ── file walk ──────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(["node_modules", "dist", ".vite", "__preview__"]);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* walk(p);
    } else if (p.endsWith(".tsx") || p.endsWith(".ts")) {
      yield p;
    }
  }
}

const rel = (p) => relative(ROOT, p).split(sep).join("/");
const isTest = (f) =>
  /(\.test\.|\.spec\.)/.test(f) || f.includes("/__tests__/") || f.includes("/test/");

// ── measurement ────────────────────────────────────────────────────────

/** A JSX element opening tag, e.g. `<Amount` — counted only where it is
 *  really an element, not a word in a comment. Comments are stripped
 *  first, which matters: this codebase's comments name `<Amount>`
 *  constantly and a naive count would triple. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const FIGURE_TAGS = ["Amount", "MoneyAmount", "FigureValue", "FigureCell", "BsAmountCell"];
const AFFORDANCE_TAG = "ProvenanceAffordance";

function measure(src) {
  const code = stripComments(src);
  let sites = 0;
  for (const tag of FIGURE_TAGS) {
    const m = code.match(new RegExp(`<${tag}[\\s/>]`, "g"));
    sites += m ? m.length : 0;
  }
  const aff = code.match(new RegExp(`<${AFFORDANCE_TAG}[\\s/>]`, "g"));
  const prov = code.match(/\bprovenance\s*=\s*[{"]/g);
  return {
    sites,
    affordances: aff ? aff.length : 0,
    provenanceProps: prov ? prov.length : 0,
  };
}

/**
 * The fabrication antibody.
 *
 * Flags `source:` (the affordance field the card labels "Source") being
 * fed from an identifier that names something which is NOT a source: a
 * period, a scope, a date, a bare label. Deliberately narrow — it
 * catches the exact shape that shipped, and says so rather than
 * pretending to catch a class.
 */
const SOURCE_ASSIGN = /\bsource\s*:\s*([^,;}\n]+)/g;

/** Names that are NOT a source, however they are reached. Matched on the
 *  LEAF of a property chain, so `period.source` (the period's own source
 *  field — legitimate, and live in lib/canonicalMetrics.ts) does not
 *  trip while `fact.periodLabel` does. That distinction is the whole
 *  difference between the antibody and a nuisance. */
const NOT_A_SOURCE = new Set([
  "period",
  "periodlabel",
  "period_label",
  "periodid",
  "period_id",
  "scope",
  "asof",
  "as_of",
  "label",
  "periodlabels",
  "title",
]);

function fabrications(src) {
  const code = stripComments(src);
  const out = [];
  let m;
  SOURCE_ASSIGN.lastIndex = 0;
  while ((m = SOURCE_ASSIGN.exec(code)) !== null) {
    const rhs = m[1];
    // `a || b`, `a ?? b` — every operand is a candidate value for the
    // field, so every operand is checked.
    for (const operand of rhs.split(/\|\||\?\?/)) {
      const expr = operand.trim().replace(/[)("'`]/g, "");
      if (!expr) continue;
      const leaf = expr.split(/[.?]/).filter(Boolean).pop();
      if (!leaf) continue;
      if (NOT_A_SOURCE.has(leaf.toLowerCase())) {
        const line = code.slice(0, m.index).split("\n").length;
        out.push({ line, text: `source: ${operand.trim()}`.slice(0, 90) });
      }
    }
  }
  return out;
}

// ── run ────────────────────────────────────────────────────────────────

let registry;
try {
  registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
} catch (e) {
  console.error(`PROVENANCE CENSUS\n${"=".repeat(62)}`);
  console.error(`FAIL — cannot read ${rel(REGISTRY_PATH)}: ${e.message}`);
  process.exit(1);
}
const entries = registry.sites ?? {};

const measured = new Map();
let filesWalked = 0;
const fabricationHits = [];

// --probe-vacuity: empty the gate's own discovery and REQUIRE a failure.
// This flag was silently ignored — the gate ran its full 156-site census
// and printed PASS while claiming to probe itself. A self-test that
// cannot fail is a fourth instrument examining nothing (TC-9). The gate
// DOES red on empty discovery (exit 1, three units=0 lines against
// declared floors) — it just never proved that about itself until now.
const PROBE_VACUITY = process.argv.includes("--probe-vacuity");
for (const abs of (PROBE_VACUITY ? [] : walk(FE))) {
  filesWalked += 1;
  const f = rel(abs);
  if (isTest(f)) continue;
  const src = readFileSync(abs, "utf-8");
  const m = measure(src);
  if (m.sites > 0 || m.affordances > 0) measured.set(f, m);
  for (const hit of fabrications(src)) fabricationHits.push({ file: f, ...hit });
}

const totalSites = [...measured.values()].reduce((a, b) => a + b.sites, 0);
const totalAffordances = [...measured.values()].reduce((a, b) => a + b.affordances, 0);
const totalProvenanceProps = [...measured.values()].reduce(
  (a, b) => a + b.provenanceProps,
  0,
);

console.log("PROVENANCE CENSUS");
console.log("=".repeat(62));
console.log(
  `GATE-WORK provenance-census units=${measured.size} floor=${FLOOR_REGISTERED} ` +
    `label=files-rendering-figures`,
);
console.log(
  `GATE-WORK provenance-sites units=${totalSites} floor=${FLOOR_SITES} ` +
    `label=figure-render-sites`,
);
console.log(
  `GATE-WORK provenance-affordances units=${totalAffordances + totalProvenanceProps} ` +
    `floor=${FLOOR_AFFORDANCES} label=affordance-bearing-sites`,
);
console.log(`  ${filesWalked} frontend file(s) walked`);

const failures = [];

// ── discovery floors ───────────────────────────────────────────────────
if (filesWalked < FLOOR_FILES) {
  failures.push(
    `DISCOVERY BROKEN: walked ${filesWalked} files, floor ${FLOOR_FILES}. ` +
      "A census that finds nothing is broken, not clean.",
  );
}
if (totalSites < FLOOR_SITES) {
  failures.push(
    `DISCOVERY BROKEN: found ${totalSites} figure sites, floor ${FLOOR_SITES}.`,
  );
}
if (measured.size < FLOOR_REGISTERED) {
  failures.push(
    `DISCOVERY BROKEN: ${measured.size} files render figures, floor ${FLOOR_REGISTERED}.`,
  );
}
if (totalAffordances + totalProvenanceProps < FLOOR_AFFORDANCES) {
  failures.push(
    `DISCOVERY BROKEN: ${totalAffordances + totalProvenanceProps} affordance-bearing ` +
      `sites, floor ${FLOOR_AFFORDANCES}. The affordance has vanished from the product.`,
  );
}
for (const c of CANARIES) {
  if (!measured.has(c)) {
    failures.push(`DISCOVERY BROKEN: canary not seen — ${c} renders no figure.`);
  }
}

// ── the four buckets ───────────────────────────────────────────────────
const buckets = {
  HAS_SHOWS: [],
  HAS_MISSING: [],
  LACKS_SILENT: [],
  LACKS_SHOWS: [],
  UNAUDITED: [],
};
for (const [f, m] of [...measured].sort()) {
  const e = entries[f];
  if (!e) {
    failures.push(
      `UNREGISTERED: ${f} renders ${m.sites} figure site(s) and carries no ` +
        "provenance verdict. Add it to design_review/PROVENANCE_CENSUS.json " +
        "with one of HAS_SHOWS / HAS_MISSING / LACKS_SILENT / LACKS_SHOWS " +
        "and a one-line reason.",
    );
    continue;
  }
  if (!buckets[e.bucket]) {
    failures.push(`${f}: unknown bucket "${e.bucket}".`);
    continue;
  }
  buckets[e.bucket].push(f);
  const declared = m.affordances + m.provenanceProps;
  if (e.affordances !== declared) {
    failures.push(
      `COUNT DRIFT: ${f} declares ${e.affordances} affordance-bearing site(s), ` +
        `measured ${declared}. Either the change is intended (update the entry ` +
        "and re-state the verdict) or a figure lost its provenance.",
    );
  }
  if (e.sites !== m.sites) {
    failures.push(
      `COUNT DRIFT: ${f} declares ${e.sites} figure site(s), measured ${m.sites}. ` +
        "A new figure needs a provenance verdict before it ships.",
    );
  }
}

for (const f of Object.keys(entries)) {
  if (!measured.has(f)) {
    failures.push(
      `STALE ENTRY: ${f} is registered but renders no figures. A stale ` +
        "registration silently widens the allowance.",
    );
  }
}

// ── the honest fifth state, held from growing ──────────────────────────
//
// UNAUDITED is not a bucket the mission asked for; it is what the other
// four cost. Assigning HAS_MISSING or LACKS_SILENT to a file is a CLAIM
// about its payload, and claiming one for a file nobody opened is
// exactly the "clean sweep over no subject" this repo keeps catching.
// So a file may be declared unaudited — and the number is CAPPED, which
// makes the debt visible and stops it growing quietly.
if (buckets.UNAUDITED.length > CEILING_UNAUDITED) {
  failures.push(
    `UNAUDITED CEILING: ${buckets.UNAUDITED.length} file(s) carry no payload ` +
      `verdict, ceiling ${CEILING_UNAUDITED}. Audit one before adding another, ` +
      "or the census records an opinion nobody formed.",
  );
}

// ── the worst bucket is never a steady state ───────────────────────────
for (const f of buckets.LACKS_SHOWS) {
  failures.push(
    `FABRICATED AFFORDANCE: ${f} is registered LACKS_SHOWS — a figure offering ` +
      "provenance it does not have. This bucket is never an acceptable state; " +
      "fix the site or correct the verdict.",
  );
}

for (const h of fabricationHits) {
  failures.push(
    `FABRICATION SHAPE at ${h.file}:${h.line} — \`${h.text}\`. A period, a ` +
      "scope, a date or a bare label is not a SOURCE. The card labels that " +
      "field \"Source\"; feed it what the figure was read from, or use the " +
      "`period` field.",
  );
}

// ── report ─────────────────────────────────────────────────────────────
console.log("");
for (const [name, files] of Object.entries(buckets)) {
  console.log(`  ${name.padEnd(13)} ${String(files.length).padStart(3)} file(s)`);
  for (const f of files) {
    const m = measured.get(f);
    console.log(
      `      ${f} — ${m.sites} site(s), ${m.affordances + m.provenanceProps} with provenance`,
    );
    if (entries[f]?.why) console.log(`        ${entries[f].why}`);
  }
}

console.log("");
if (failures.length) {
  console.log(`FAIL — ${failures.length} finding(s):`);
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log(
  `PASS — ${totalSites} figure site(s) across ${measured.size} file(s), each with a ` +
    "recorded provenance verdict; no fabricated affordance.",
);
