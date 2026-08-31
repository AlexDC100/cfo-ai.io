#!/usr/bin/env node
/**
 * THE CAPSULE — the CRAFT static gate (Part F, lane 2).
 *
 * Runs in ~200 ms with no browser, no dev server and no dependencies, so
 * it belongs beside the other cheap gates in the battery. Everything here
 * is decidable from source text alone. The live half is
 * `e2e/design/capsule-craft.spec.ts`; the rendered-tree half is
 * `frontend/components/instrument/shell/__tests__/capsuleCraft.test.tsx`.
 *
 * ════════════════════════════════════════════════════════════════════
 * WHAT IT ENFORCES
 * ════════════════════════════════════════════════════════════════════
 *
 *   F1  NO NATIVE TOOLTIP        no `title=` on a row inside the Capsule
 *                                shell. The browser draws it unstyled,
 *                                after a delay the design does not own,
 *                                repeating text already on screen — and
 *                                never at all on touch.
 *   F2  NO CATEGORY COLUMN       no navigation row renders a section
 *                                label beside its own name.
 *   F3  STRINGS DISCIPLINE       every Capsule strings file is registered
 *                                with `addResourceBundle`, carries EN and
 *                                RO, and the two have the SAME key set.
 *                                No Capsule copy in `i18n/locales/*`.
 *   F4  FOOTER ≠ PLACEHOLDER     the idle hint does not restate the
 *                                placeholder, measured as content-word
 *                                overlap, in EN and in RO.
 *   F5  THE CRAFT SPEC IS ALIVE  `capsule-craft.spec.ts` declares its
 *                                anchors, proves them, and every anchor
 *                                it names is PRODUCIBLE by some component.
 *
 * ════════════════════════════════════════════════════════════════════
 * EXIT ZERO IS NOT EVIDENCE
 * ════════════════════════════════════════════════════════════════════
 *
 * `npx tsc --noEmit` sat in this repo's battery for months and checked
 * ZERO FILES. Five more gates were then caught passing while examining
 * nothing — including one whose DISCOVERY-BROKEN canary sat INSIDE its
 * per-item loop and therefore could never fire on the one case it
 * existed to catch (design_review/FALSE_GREEN_FINDINGS.md).
 *
 * So this gate prints a machine-readable work count, and the floor is
 * asserted ONCE, AFTER every discovery loop, against the totals:
 *
 *     GATE-WORK capsule-craft units=<N> floor=<F> ...
 *
 * Below the floor is a FAIL whatever the checks said. Prove it yourself:
 *
 *     node scripts/check_capsule_craft.mjs --probe-vacuity
 *
 * which neuters this gate's OWN discovery roots and requires the run to
 * fail. If that probe ever passes, this gate has joined the five.
 *
 * Run:  node scripts/check_capsule_craft.mjs
 *       node scripts/check_capsule_craft.mjs --census        (report only)
 *       node scripts/check_capsule_craft.mjs --probe-vacuity (self-test)
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CENSUS_ONLY = process.argv.includes("--census");
const PROBE_VACUITY = process.argv.includes("--probe-vacuity");

const FLOOR = 12;

const failures = [];
const notes = [];
const fail = (gate, message) => failures.push({ gate, message });
const note = (line) => notes.push(line);

// ── discovery roots. `--probe-vacuity` empties them on purpose. ───────

const SHELL_DIR = "frontend/components/instrument/shell";
let ROOTS = PROBE_VACUITY
  ? []
  : [SHELL_DIR, "frontend/lib/capsuleSuggestions.ts"];
let SPEC_FILES = PROBE_VACUITY ? [] : ["e2e/design/capsule-craft.spec.ts"];

// ── file walking ──────────────────────────────────────────────────────

function walk(dir, test, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, test, out);
    else if (test(name)) out.push(full);
  }
  return out;
}

function collectSources() {
  const out = [];
  for (const r of ROOTS) {
    const abs = path.join(ROOT, r);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isDirectory()) {
      out.push(...walk(abs, (n) => /\.(tsx?|json)$/.test(n)));
    } else {
      out.push(abs);
    }
  }
  return out;
}

const rel = (p) => path.relative(ROOT, p);
const read = (p) => readFileSync(p, "utf-8");

/**
 * SOURCE WITH ITS PROSE REMOVED.
 *
 * Every check below scans for a JSX pattern, and this file's subjects are
 * heavily commented components whose comments QUOTE the very patterns
 * being banned — "`title={resolved.provenance}` on the money span",
 * "kept `{item.hint}`". Scanning raw text made F1 and F2 fire on the
 * paragraphs explaining why the defect was removed, which teaches the
 * next person to stop naming the defect in comments. That is a gate
 * making the codebase worse.
 *
 * Line comments, block comments and JSX comments go; string literals
 * stay, because a `title` inside a template literal is still a title.
 * Lines are PRESERVED (blanked, not deleted) so reported line numbers
 * still point at the right place.
 */
function codeOnly(src) {
  const withoutBlocks = src.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    m.replace(/[^\n]/g, " "));
  return withoutBlocks
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

// ══════════════════════════════════════════════════════════════════════
// F1 — NO NATIVE TOOLTIP ON A ROW
// ══════════════════════════════════════════════════════════════════════
//
// The ban is scoped to ROWS, not to every element. A `title` on a
// provenance dot ("Open the source row") is a control describing an
// action; a `title` on a suggestion is a second, unstyled, delayed copy
// of the label the reader is already reading.
//
// A row is detected structurally: a JSX element carrying one of the row
// test ids, or `role="option"`. The `title=` must appear inside that
// element's attribute list — which, in this codebase's formatting, means
// on one of the lines between the opening tag and its `>`.

const ROW_MARKERS = [
  'data-testid="capsule-suggestion"',
  'data-testid="capsule-jump-row"',
  'data-testid="capsule-ask-fallback"',
  'data-testid="capsule-followup-chip"',
  'data-testid="capsule-question-chip"',
  'role="option"',
];

function checkNoRowTooltip(files) {
  let rowsSeen = 0;
  for (const file of files) {
    if (!/\.tsx$/.test(file)) continue;
    const lines = codeOnly(read(file)).split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!ROW_MARKERS.some((m) => lines[i].includes(m))) continue;
      rowsSeen++;
      // Walk backwards to the opening `<`, forwards to the closing `>`
      // of the same tag: the attribute block this row owns.
      let start = i;
      while (start > 0 && !/<[A-Za-z]/.test(lines[start])) start--;
      let end = i;
      while (end < lines.length - 1 && !/^\s*\/?>/.test(lines[end]) && !/>\s*$/.test(lines[end])) end++;
      const block = lines.slice(start, end + 1).join("\n");
      const m = block.match(/\btitle=\{?[`"']?([^`"'}\n]*)/);
      if (m) {
        fail(
          "F1 no-native-tooltip",
          `${rel(file)}:${i + 1} — a Capsule row carries \`title=\` ` +
            `(${JSON.stringify(m[1].slice(0, 60))}).\n` +
            `      The browser renders it as an unstyled OS tooltip after a delay ` +
            `the design does not control, duplicating the row's own visible text, ` +
            `and never renders it at all on touch. It is not an accessible name ` +
            `either — assistive tech announces the visible label. If the row cannot ` +
            `say it, the row needs a better label, not a second one.`,
        );
      }
    }
  }
  return rowsSeen;
}

// ══════════════════════════════════════════════════════════════════════
// F6 — NO `title=` ANYWHERE THE CAPSULE OWNS
// ══════════════════════════════════════════════════════════════════════
//
// F1 above bans a `title` on a ROW, and explicitly permits one on "a
// control describing an action" — a provenance dot, the trigger pill.
// That exemption was wrong and it was measured wrong: an ANSWERED turn
// carried three native tooltips and a follow-up carried six, because a
// provenance dot rides every figure in every turn. The pill and the
// header trust dot carried one apiece in every state, and the live sweep
// could not see them because it was rooted at the overlay and they live
// outside the portal.
//
// So the rule is ZERO, over every file this surface owns, and it is a
// SOURCE rule as well as a live one — deliberately, because the live one
// alone is now satisfiable by `CapsuleTooltipGuard`, which strips
// `title` at runtime. A runtime net that hides a source regression is
// the same failure as a fix landing on the wrong component: the defect
// is back in the code and the gate is green. Proven: planting a `title`
// back onto `ProvenanceDot` left the live sweep at zero (the guard
// re-homed it, 4 nodes → 5) and only this check reds.
//
// LICENSED, and only these: two files outside this lane's ownership that
// legitimately carry a `title` for the rest of the app. Inside the
// Capsule they are neutralised at the boundary by the guard, which
// re-homes the string onto an accessible name rather than deleting it.
const TITLE_LICENSED = new Set([
  "frontend/lib/narrativeMoney.tsx",
  "frontend/components/cfo/TraceableNumber.tsx",
]);

// THE LICENCE LIST IS ITSELF PINNED.
//
// An adversarial audit disarmed F6 — the only static guard against the
// tooltip class, and the only one the runtime guard does not neutralise —
// with a ONE-LINE edit: add the offending file to TITLE_LICENSED and the
// gate goes green with the defect live. Nothing asserted the list, so
// growing it was free.
//
// That is the TC-6 disease in its purest form: an exemption list is a
// floor of size zero on a component nobody counts. The list may still
// change, but only deliberately — the digest below has to move in the
// same commit, which is a reviewable act rather than an invisible one.
const TITLE_LICENSED_PINNED = [
  "frontend/components/cfo/TraceableNumber.tsx",
  "frontend/lib/narrativeMoney.tsx",
].join("|");

function assertLicenceListUnchanged() {
  const actual = [...TITLE_LICENSED].sort().join("|");
  if (actual === TITLE_LICENSED_PINNED) return null;
  return [
    "F6-LICENCE: the title-exemption list changed without its pin.",
    "  pinned : " + TITLE_LICENSED_PINNED.split("|").join(", "),
    "  actual : " + actual.split("|").join(", "),
    "Adding a file here disarms the ONLY static guard against native",
    "tooltips for that file, and the runtime guard re-homes the title so",
    "the live gate stays green too. If the addition is deliberate, move",
    "TITLE_LICENSED_PINNED in the same commit and say why in the diff.",
  ].join("\n");
}

/** Files this surface owns, beyond the shell tree. */
const SURFACE_EXTRA_FILES = ["frontend/components/cfo/TopHeader.tsx"];

function checkNoTitleAnywhere(files) {
  let scanned = 0;
  const all = [...files];
  for (const extra of SURFACE_EXTRA_FILES) {
    const abs = path.join(ROOT, extra);
    if (existsSync(abs)) all.push(abs);
  }
  for (const file of all) {
    if (!/\.tsx$/.test(file)) continue;
    if (TITLE_LICENSED.has(rel(file))) continue;
    if (/__tests__/.test(file)) continue;
    scanned++;
    const raw = read(file).split("\n");
    const lines = codeOnly(read(file)).split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = raw[i];
      // JSX attribute only. A comment ABOUT `title=` — and both this file
      // and its subjects are full of them — is not a tooltip.
      if (!/(^|[\s{])title=/.test(lines[i])) continue;
      fail(
        "F6 no-native-tooltip-anywhere",
        `${rel(file)}:${i + 1} — \`title=\` on the Capsule surface:\n` +
          `      ${line.trim().slice(0, 100)}\n` +
          `      The browser draws it unstyled, after a delay the design does ` +
          `not own, never on touch and never for a keyboard user. On a figure ` +
          `it MULTIPLIES: three per answered turn, six after a follow-up. Put ` +
          `the string in the element's own label, in \`aria-label\`, or nowhere.`,
      );
    }
  }
  return scanned;
}

// ══════════════════════════════════════════════════════════════════════
// F2 — NO CATEGORY COLUMN
// ══════════════════════════════════════════════════════════════════════
//
// The DOM proof is in the vitest file (render with a hint on every item,
// assert none reaches the DOM). This is the SOURCE half: a Capsule row
// component may not render a category-shaped prop at all. Named props
// rather than a shape heuristic — a heuristic over JSX either misses the
// rename or fires on every two-column row in the file.

const CATEGORY_PROPS = [
  { re: /\{\s*item\.hint\s*\}/, name: "item.hint" },
  { re: /\{\s*row\.hint\s*\}/, name: "row.hint" },
  { re: /\{\s*\w+\.(?:group|section|category)Label\s*\}/, name: "<x>.groupLabel/sectionLabel/categoryLabel" },
  { re: /\{\s*t\(\s*[`"']capsuleRouter\.group\./, name: "capsuleRouter.group.* rendered on a row" },
];

/** Files that legitimately render a group HEADING (one label above a run
 *  of rows) rather than a per-row column. A heading is a different
 *  object: one per group, not one per row. */
const HEADING_OK = /CommandPalette\.tsx$/;

function checkNoCategoryColumn(files) {
  let componentsSeen = 0;
  for (const file of files) {
    if (!/\.tsx$/.test(file)) continue;
    const src = codeOnly(read(file));
    if (!ROW_MARKERS.some((m) => src.includes(m))) continue;
    componentsSeen++;
    for (const { re, name } of CATEGORY_PROPS) {
      if (!re.test(src)) continue;
      if (HEADING_OK.test(file) && name.startsWith("capsuleRouter.group")) continue;
      const line = src.split("\n").findIndex((l) => re.test(l)) + 1;
      fail(
        "F2 no-category-column",
        `${rel(file)}:${line} — a Capsule row renders \`${name}\`.\n` +
          `      That word names the rail group the destination was filed under. ` +
          `The reader is looking for the page, not for the menu it lives in, and ` +
          `printing it on every row gives them all the same two-column rhythm — ` +
          `which is exactly what makes the surface read as a directory instead of ` +
          `an answer.`,
      );
    }
  }
  return componentsSeen;
}

// ══════════════════════════════════════════════════════════════════════
// F3 — STRINGS DISCIPLINE
// ══════════════════════════════════════════════════════════════════════
//
// Per-feature strings JSON registered with `addResourceBundle`. The
// locale files are banned for every lane this session, so a Capsule
// string that appears there is a merge conflict waiting to be resolved
// wrongly. EN + RO parity is checked as a SET COMPARISON, not a count:
// two files with the same number of different keys is the failure mode a
// count misses.

function flatKeys(obj, prefix = "", out = []) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatKeys(v, key, out);
    else out.push(key);
  }
  return out;
}

function checkStrings(files) {
  const jsonFiles = files.filter((f) => /Strings\.json$/.test(f));
  let bundlesSeen = 0;

  for (const file of jsonFiles) {
    bundlesSeen++;
    let data;
    try { data = JSON.parse(read(file)); } catch (e) {
      fail("F3 strings", `${rel(file)} — not valid JSON: ${e.message}`);
      continue;
    }
    for (const lang of ["en", "ro"]) {
      if (!data[lang]) {
        fail("F3 strings",
          `${rel(file)} — no "${lang}" bundle. Every Capsule strings file ships ` +
            `EN and RO together; a surface that ships in one language ships a ` +
            `half-finished surface to the other.`);
      }
    }
    if (data.en && data.ro) {
      // PLURAL CATEGORIES ARE NOT A PARITY GAP. i18next spells CLDR
      // plural forms as `key_one` / `key_few` / `key_other`, and the set
      // of forms a language HAS is a property of the language: English
      // has two, Romanian has three (`_few` for 2–19). Comparing raw key
      // sets reports `strip.unattached_few` as "missing in en" forever,
      // which trains the reader to ignore this gate. Compare the MESSAGE
      // — the key with its plural category removed.
      const PLURAL = /_(zero|one|two|few|many|other)$/;
      const base = (k) => k.replace(PLURAL, "");
      const en = new Set(flatKeys(data.en).map(base));
      const ro = new Set(flatKeys(data.ro).map(base));
      const missingRo = [...en].filter((k) => !ro.has(k));
      const missingEn = [...ro].filter((k) => !en.has(k));
      if (missingRo.length || missingEn.length) {
        fail("F3 strings",
          `${rel(file)} — EN/RO key sets differ.\n` +
            (missingRo.length ? `      missing in ro: ${missingRo.slice(0, 8).join(", ")}\n` : "") +
            (missingEn.length ? `      missing in en: ${missingEn.slice(0, 8).join(", ")}\n` : "") +
            `      A missing RO key renders the raw key path to a Romanian reader.`);
      }
    }
    // The bundle must be REGISTERED. A strings file nothing imports is a
    // file that renders as key paths.
    const base = path.basename(file, ".json");
    const dir = path.dirname(file);
    const siblings = walk(dir, (n) => /\.ts$/.test(n));
    const registered = siblings.some((s) => {
      const src = read(s);
      return src.includes("addResourceBundle") && src.includes(base);
    });
    if (!registered) {
      fail("F3 strings",
        `${rel(file)} — no sibling module registers it with \`addResourceBundle\`. ` +
          `Locale files are banned for this work, so an unregistered bundle means ` +
          `the copy never reaches i18next and every key renders as its own path.`);
    }
  }

  // No Capsule copy leaked into the shared locale files.
  const localeDir = path.join(ROOT, "frontend/i18n/locales");
  if (existsSync(localeDir) && !PROBE_VACUITY) {
    for (const lf of walk(localeDir, (n) => n.endsWith(".json"))) {
      let data;
      try { data = JSON.parse(read(lf)); } catch { continue; }
      const leaked = Object.keys(data).filter((k) => /^capsule/i.test(k));
      if (leaked.length) {
        fail("F3 strings",
          `${rel(lf)} — Capsule keys in a shared locale file: ${leaked.join(", ")}. ` +
            `Capsule copy lives in per-feature bundles; the locale files are owned ` +
            `by another lane this session.`);
      }
    }
  }
  return bundlesSeen;
}

// ══════════════════════════════════════════════════════════════════════
// F4 — THE FOOTER MAY NOT RESTATE THE PLACEHOLDER
// ══════════════════════════════════════════════════════════════════════
//
// Decidable from the strings file, in both languages, without a browser.
// Words are folded (diacritics stripped) and clipped to five characters
// so `întreabă` and `întrebi` count as one word — otherwise a
// morphological variant reads as a different sentence and the Romanian
// copy passes a rule the English copy fails.

const STOPWORDS = new Set([
  "a", "an", "the", "or", "and", "to", "of", "in", "on", "at", "for", "is", "it",
  "your", "you", "this", "that", "with", "by", "as", "be", "can", "will", "any",
  "sau", "si", "la", "de", "din", "un", "o", "cu", "ca", "sa", "te", "iti", "ti",
  "pe", "e", "ce", "ori",
]);

function contentWords(text) {
  return String(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\{\{[^}]*\}\}/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map((w) => w.slice(0, 5));
}

/** Fraction of the CANDIDATE's content words the placeholder also says.
 *  Asymmetric on purpose: a short hint wholly contained in a longer
 *  placeholder is a restatement; a long hint sharing one word is not. */
function overlap(candidate, placeholder) {
  const c = contentWords(candidate);
  if (!c.length) return 0;
  const p = new Set(contentWords(placeholder));
  return c.filter((w) => p.has(w)).length / c.length;
}

const RESTATEMENT = 0.6;

/** Every i18n key the Capsule shell actually renders — the argument of a
 *  `t("…")` call anywhere under the discovery roots. This is what makes
 *  F4 a claim about the SURFACE rather than about a JSON file. */
function collectRenderedKeys(files) {
  const keys = new Set();
  for (const file of files) {
    if (!/\.tsx?$/.test(file)) continue;
    for (const m of read(file).matchAll(/\bt\(\s*[`"']([A-Za-z0-9_.]+)[`"']/g)) {
      keys.add(m[1]);
    }
  }
  return keys;
}

// ── F6 — DEAD COPY (advisory) ─────────────────────────────────────────
//
// A hint string nobody renders is not a restatement — but it is a loaded
// gun. The next lane that needs a footer reaches for the key that is
// already there, and the deleted defect comes back wearing its original
// name. Reported, not gated: deleting copy is the redesign lane's call,
// not this lane's, and a gate that fails on someone else's housekeeping
// gets muted.
function reportDeadHints(files, renderedKeys) {
  const dead = [];
  for (const file of files.filter((f) => /capsuleEmptyStrings\.json$/.test(f))) {
    let data;
    try { data = JSON.parse(read(file)); } catch { continue; }
    for (const [k, v] of Object.entries(data?.en?.capsuleEmpty?.enter ?? {})) {
      if (!renderedKeys.has(`capsuleEmpty.enter.${k}`)) {
        dead.push(`capsuleEmpty.enter.${k} = ${JSON.stringify(String(v).slice(0, 48))}`);
      }
    }
  }
  return dead;
}

function checkFooterNotPlaceholder(files, renderedKeys) {
  let pairsSeen = 0;
  let placeholdersSeen = 0;
  const jsonFiles = files.filter((f) => /capsuleEmptyStrings\.json$/.test(f));
  for (const file of jsonFiles) {
    let data;
    try { data = JSON.parse(read(file)); } catch { continue; }
    for (const lang of ["en", "ro"]) {
      const empty = data?.[lang]?.capsuleEmpty;
      if (!empty) continue;
      const placeholders = Object.entries(empty.placeholder ?? {})
        .filter(([k]) => k !== "aria")        // sr-only; never on screen beside a hint
        .map(([, v]) => v);
      placeholdersSeen += placeholders.length;
      // ONLY COPY THAT REACHES A READER. A string nobody renders cannot
      // restate anything; reporting it as a restatement trains the
      // reader to ignore this gate. Dead copy is a real problem, but a
      // DIFFERENT one — it is reported below, under its own name.
      const hints = Object.entries(empty.enter ?? {})
        .filter(([k]) => /^(idle|keys|ask|go|hint|footer)$/.test(k))
        .filter(([k]) => renderedKeys.has(`capsuleEmpty.enter.${k}`))
        .map(([k, v]) => [`enter.${k}`, v]);
      for (const [hintKey, hint] of hints) {
        for (const ph of placeholders) {
          pairsSeen++;
          const o = overlap(hint, ph);
          note(`      ${lang} ${hintKey} × placeholder = ${Math.round(o * 100)}%`);
          if (o >= RESTATEMENT) {
            fail("F4 footer-restates-placeholder",
              `${rel(file)} [${lang}] — "${hintKey}" restates the placeholder ` +
                `(${Math.round(o * 100)}% of its content words).\n` +
                `        hint:        "${hint}"\n` +
                `        placeholder: "${ph}"\n` +
                `      The reader has the placeholder in front of them, in the box ` +
                `they are about to type in. Printing the same instruction a second ` +
                `time is the surface not trusting them to have read it once — and ` +
                `it spends the one line of chrome the surface has on nothing.`);
          }
        }
      }
    }
  }
  // The two counts are separate on purpose. `placeholdersSeen` is F4's
  // DISCOVERY canary: zero means the strings file moved or its shape
  // changed, and the gate is blind. `pairsSeen` is its WORKLOAD, and
  // zero is a legitimate answer — it means the surface renders no static
  // hint beside the composer at all, which is the strongest possible
  // form of "the footer does not restate the placeholder". Folding the
  // two into one number would make the correct end state look like a
  // broken gate, and a gate that goes red when the defect is fixed gets
  // deleted by the next lane.
  return { pairs: pairsSeen, placeholders: placeholdersSeen };
}

// ══════════════════════════════════════════════════════════════════════
// F5 — THE CRAFT SPEC IS ALIVE
// ══════════════════════════════════════════════════════════════════════
//
// A gate whose selector matches nothing is a false green. The live spec
// therefore declares its anchors in one place and proves them in its
// first test; this checks that BOTH halves are still there, and that
// every testid the spec names is PRODUCIBLE by some component. Not
// "present right now" — a negative assertion is legitimate — but
// emittable, so the ban has a subject.

function checkSpecAlive(specFiles) {
  let anchorsSeen = 0;
  const appSrc = walk(path.join(ROOT, "frontend"), (n) => /\.tsx?$/.test(n))
    .map((f) => read(f))
    .join("\n");

  for (const relSpec of specFiles) {
    const abs = path.join(ROOT, relSpec);
    if (!existsSync(abs)) {
      fail("F5 spec-alive",
        `${relSpec} is missing. The craft gates' live half is the only place G1, ` +
          `G2, G5 and G6 can be measured at all.`);
      continue;
    }
    const src = read(abs);
    if (!/const ANCHORS\s*=/.test(src)) {
      fail("F5 spec-alive",
        `${relSpec} declares no ANCHORS block. Every selector a gate depends on ` +
          `must be declared once and proven live, or a rename turns the whole ` +
          `file into decoration that still exits 0.`);
    }
    if (!/ANCHORS_CLOSED|ANCHORS_OPEN|ANCHORS_ANSWERED/.test(src)) {
      fail("F5 spec-alive",
        `${relSpec} has no anchor-liveness test. Declaring anchors without ` +
          `proving them is bookkeeping.`);
    }
    // FLOOR-shaped: every gate needs a work floor asserted after its loop.
    if (!/FLOOR/.test(src) || !/VACUITY/.test(src)) {
      fail("F5 spec-alive",
        `${relSpec} declares no VACUITY floors. Five battery gates in this repo ` +
          `were caught passing while examining nothing; a spec with no floor is ` +
          `the sixth waiting to happen.`);
    }
    for (const m of src.matchAll(/data-testid="([a-z0-9-]+)"/g)) {
      const id = m[1];
      anchorsSeen++;
      if (!appSrc.includes(`"${id}"`) && !appSrc.includes(`'${id}'`) && !appSrc.includes(`\`${id}\``)) {
        fail("F5 spec-alive",
          `${relSpec} names data-testid="${id}", which NO component under ` +
            `frontend/ can emit. A selector nothing produces makes every ` +
            `assertion about it a tautology.`);
      }
    }
  }
  return anchorsSeen;
}

// ══════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════

function main() {
  console.log("CAPSULE-CRAFT GATES — F1 row tooltips · F2 category column · " +
    "F3 strings · F4 footer≠placeholder · F5 spec alive · F6 no title anywhere");

  const files = collectSources();

  // ── the discovery loops. Nothing is asserted inside them. ──────────
  const renderedKeys = collectRenderedKeys(files);
  const rowsSeen = checkNoRowTooltip(files);
  // Assert the exemption list BEFORE trusting anything the title scan
  // reports — a scan whose exemptions were widened is not a measurement.
  const licenceDrift = assertLicenceListUnchanged();
  if (licenceDrift) {
    console.log("");
    console.log(licenceDrift);
    process.exitCode = 1;
  }
  const titleScanned = checkNoTitleAnywhere(files);
  const rowComponents = checkNoCategoryColumn(files);
  const bundles = checkStrings(files);
  const footer = checkFooterNotPlaceholder(files, renderedKeys);
  const anchors = checkSpecAlive(SPEC_FILES);
  const deadHints = reportDeadHints(files, renderedKeys);

  // ── AFTER every loop, against the totals ──────────────────────────
  //
  // This placement is the whole antibody. `check_metric_declared.py`
  // asserted its canary INSIDE the per-surface loop; with the surface
  // list emptied the loop body never ran, the canary never fired, and
  // the gate printed a clean census over zero surfaces. The floor and
  // the discovery canary both belong here, where an empty discovery is
  // visible as a number.
  const units =
    files.length + rowsSeen + rowComponents + bundles + footer.placeholders +
    anchors + titleScanned;

  console.log(
    `  files=${files.length} rows=${rowsSeen} rowComponents=${rowComponents} ` +
    `bundles=${bundles} renderedKeys=${renderedKeys.size} ` +
    `placeholders=${footer.placeholders} renderedHintPairs=${footer.pairs} ` +
    `specAnchors=${anchors} titleScanned=${titleScanned}`);
  if (notes.length) console.log(notes.join("\n"));
  if (deadHints.length) {
    console.log(
      `  ADVISORY — ${deadHints.length} hint string(s) no longer rendered by any ` +
      `\`t(…)\` call in the shell:\n` +
      deadHints.map((d) => `      ${d}`).join("\n") +
      `\n      Not gating. But the next lane that needs a footer will reach for ` +
      `the key\n      that is already there, and the deleted defect comes back ` +
      `under its own name.`);
  }

  const discoveryBroken =
    files.length === 0 || rowsSeen === 0 || bundles === 0 || titleScanned === 0 ||
    footer.placeholders === 0 || renderedKeys.size === 0 || anchors === 0 ||
    SPEC_FILES.length === 0;

  console.log(
    `GATE-WORK capsule-craft units=${units} floor=${FLOOR} ` +
    `units-desc="capsule files + rows + row components + bundles + placeholders + spec anchors"`);

  if (discoveryBroken || units < FLOOR) {
    console.log("\nFAIL check_capsule_craft — DISCOVERY BROKEN");
    console.log(
      `  units=${units} floor=${FLOOR} · files=${files.length} rows=${rowsSeen} ` +
      `bundles=${bundles} renderedKeys=${renderedKeys.size} ` +
      `placeholders=${footer.placeholders} anchors=${anchors}`);
    console.log(
      "  A census that finds nothing is a broken gate, never a passing one.\n" +
      "  Check the discovery roots at the top of this file — the Capsule shell\n" +
      "  moved, was renamed, or the spec was deleted.");
    return 1;
  }

  if (failures.length && !CENSUS_ONLY) {
    console.log(`\nFAIL check_capsule_craft — ${failures.length} violation(s)\n`);
    for (const f of failures) console.log(`  [${f.gate}] ${f.message}\n`);
    return 1;
  }

  if (failures.length && CENSUS_ONLY) {
    console.log(`\n(census) ${failures.length} violation(s) — not gating in --census mode`);
    for (const f of failures) console.log(`  [${f.gate}] ${f.message}\n`);
    return 0;
  }

  console.log("\nPASS check_capsule_craft — the Capsule reads as a conversation:\n" +
    "  no native tooltips, no category column, one voice per line, live anchors.");
  return 0;
}

// ── the self-test the five false greens would have failed ─────────────
if (PROBE_VACUITY) {
  const code = main();
  if (code === 0) {
    console.log(
      "\nVACUITY PROBE FAILED: with its discovery roots emptied this gate still " +
      "exited 0.\nThat is the exact disease it claims to be free of. Fix the floor " +
      "placement before\ntrusting any green from this script.");
    process.exit(1);
  }
  console.log(
    "\nVACUITY PROBE PASSED: with discovery emptied the gate FAILS, as it must.\n" +
    "The floor is asserted after the loops, against the totals — not inside them,\n" +
    "where an empty discovery would skip the check entirely.");
  process.exit(0);
}

process.exit(main());
