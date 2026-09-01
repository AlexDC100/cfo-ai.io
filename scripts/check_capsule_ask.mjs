#!/usr/bin/env node
/**
 * THE CAPSULE — the ASK-FIRST static gate (K1, K8) and the STALE-SELECTOR
 * census (S1–S3).
 *
 * Runs in ~200 ms with no browser, no dev server and no dependencies, so
 * it can sit in `scripts/run_battery.py` beside the other cheap gates.
 * Everything here is decidable from source text alone; anything needing a
 * live DOM lives in `e2e/design/capsule.spec.ts`, and anything needing a
 * rendered React tree lives in `frontend/lib/__tests__/capsuleAskGates.test.ts`.
 *
 * ── Why a STATIC gate exists at all ───────────────────────────────────
 *
 * The live gates cost 90 s and a running stack. A copy regression ("Search
 * pages, actions…" creeping back into the placeholder) is decidable from a
 * JSON file, and a gate that is cheap gets run. The expensive gate proves
 * the surface; this one stops the surface from being rewritten wrong in
 * the first place.
 *
 * ── The stale-selector class (S1–S3) ─────────────────────────────────
 *
 * A gate whose selector matches nothing is a FALSE GREEN, and a false
 * green is the same failure as a false red — worse, because nobody looks
 * at it. `header.spec.ts` asserts `toHaveCount(0)` on a testid no
 * component has ever emitted; it has passed every run since it was
 * written and would keep passing if the control it bans came back under
 * any other name. That is not a gate, it is a decoration.
 *
 * So: every selector an e2e spec names must be PRODUCIBLE. Not "present
 * right now" — a negative assertion is legitimate — but resolvable to a
 * component that can emit it. The distinction is the whole gate:
 *
 *     expect(locator("[data-testid=x]")).toHaveCount(0)
 *        · some component emits x  → a real ban, can fail, keep it
 *        · nothing emits x         → a tautology, delete or retarget it
 *
 * Run:  node scripts/check_capsule_ask.mjs
 *       node scripts/check_capsule_ask.mjs --census   (census only, exit 0)
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CENSUS_ONLY = process.argv.includes("--census");

const failures = [];
const notes = [];
function fail(gate, message) {
  failures.push({ gate, message });
}

// ── file walking ───────────────────────────────────────────────────────

function walk(dir, test, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, test, out);
    else if (test(name)) out.push(full);
  }
  return out;
}

const rel = (p) => path.relative(ROOT, p);
const read = (p) => readFileSync(p, "utf-8");

const FRONTEND_SOURCE = walk(
  path.join(ROOT, "frontend"),
  (n) => /\.tsx?$/.test(n),
).filter((p) => !/__tests__/.test(p));

const SPEC_FILES = walk(
  path.join(ROOT, "e2e", "design"),
  (n) => n.endsWith(".spec.ts"),
).sort();

// ══════════════════════════════════════════════════════════════════════
// K1 — ASK-FIRST: the verb the surface leads with is ASK, not SEARCH
// ══════════════════════════════════════════════════════════════════════
//
// Three separate places can state the verb, and production got all three
// wrong at once, so all three are gated:
//
//   a. the PLACEHOLDER the prose input carries
//   b. the ACCESSIBLE NAME of the capsule trigger (`aria-label`/`title`)
//   c. whether "Ask" is a ROW — a list item among navigation destinations
//
// (b) is the one nobody noticed: the pill's own `aria-label="Search"` and
// `title="Search (Ctrl+K)"` told every screen-reader user the control was
// a search box, whatever the placeholder said.

/** An ask verb, per language. RO is informal tu-form: "Întreabă". */
const ASK_VERB = {
  en: /\bask\b/i,
  // î/i and ă/a folded — a strings file may carry either spelling.
  ro: /(întreab|intreab)/i,
};

/** A search verb where an ask verb belongs. Presence is not itself a
 *  failure — "Ask anything · search pages" is a legitimate line. Leading
 *  with it is the failure, so the test is ORDER, not presence. */
const SEARCH_VERB = { en: /\bsearch\b/i, ro: /\b(caut[ăa]|caut)\b/i };

function collectStringsFiles() {
  return walk(path.join(ROOT, "frontend"), (n) => n.endsWith("Strings.json"));
}

function askFirstVerdict(text, lang) {
  const ask = ASK_VERB[lang].exec(text);
  const search = SEARCH_VERB[lang].exec(text);
  if (!ask) return { ok: false, why: "carries no ask verb" };
  if (search && search.index < ask.index) {
    return { ok: false, why: "leads with the search verb, ask comes later" };
  }
  return { ok: true };
}

function gateAskFirstCopy() {
  const files = collectStringsFiles();
  // The placeholder lives wherever the shell lane put it. Find it by
  // KEY NAME, not by file path, so a lane may move the file freely.
  let found = 0;
  for (const file of files) {
    let bundle;
    try {
      bundle = JSON.parse(read(file));
    } catch (err) {
      fail("K1", `${rel(file)} is not parseable JSON: ${err.message}`);
      continue;
    }
    for (const lang of ["en", "ro"]) {
      const langBag = bundle[lang];
      if (!langBag) continue;
      for (const [dotted, value] of flatten(langBag)) {
        // MUST match a nested placeholder object too, not only a key
        // that ENDS in "placeholder".
        //
        // An adversarial audit changed the live command-surface string to
        // "Search pages, actions, periods, companies… then Ask" — the
        // exact regression K1 exists to guard — and this gate stayed
        // GREEN. The real capsule placeholder is an OBJECT
        // (`placeholder: { ask, askNoPeriod, aria }`), so its leaves are
        // `…placeholder.ask` / `.askNoPeriod` / `.aria` and the
        // end-anchored test never selected them. K1 was grading
        // `capsuleAnswer.followUpPlaceholder` — a follow-up field — and
        // reporting the actual command surface as DEAD COPY.
        if (!/(^|\.)placeholder(\.|$)/i.test(dotted)) continue;
        // `.aria` is the accessible NAME of the field, not its copy; it
        // is graded by K1-d against the trigger instead.
        if (/\.aria$/i.test(dotted)) continue;
        // Only the COMMAND SURFACE placeholder is under this law. A
        // period filter or a search-a-list field is honestly a search.
        if (!/palette|capsule|command|ask/i.test(dotted)) continue;
        // A STRING NOBODY RENDERS IS NOT A PLACEHOLDER, IT IS LITTER.
        //
        // The live gate proved this distinction: the surface now reads
        // "Ask anything — or jump anywhere" while `shell.palette.
        // placeholder` still held the old "Search pages, actions…". The
        // old key was reported as a K1 violation, and the report was
        // wrong — nothing renders it. Dead copy is a cleanup, not a law
        // broken. It is still NAMED, because a stale string is how the
        // old wording finds its way back.
        const rendered = isKeyRendered(dotted);
        if (!rendered) {
          notes.push(
            `K1: ${lang}.${dotted} = ${JSON.stringify(value)} is DEAD COPY — ` +
              `no component renders this key. Not a violation; delete it before ` +
              `someone wires it back up.`,
          );
          continue;
        }
        found += 1;
        const verdict = askFirstVerdict(String(value), lang);
        if (!verdict.ok) {
          fail(
            "K1",
            `${rel(file)} → ${lang}.${dotted} ${verdict.why}: ` +
              `${JSON.stringify(value)}\n` +
              `        The Capsule's verb is ASK. A user who reads "search" ` +
              `types a noun, gets a list, and never learns the surface answers.`,
          );
        }
      }
    }
  }
  if (found === 0) {
    fail(
      "K1",
      "no command-surface placeholder string found in any *Strings.json — " +
        "either the key was renamed out of the /palette|capsule|command|ask/ " +
        "family, or the gate is now looking at nothing. A gate that finds " +
        "no subject FAILS; it does not pass quietly.",
    );
  } else {
    notes.push(`K1: ${found} command-surface placeholder string(s) checked`);
  }
}

/** Does any COMPONENT resolve this i18n key? Matches the full dotted key
 *  and the leaf-namespaced form a `useTranslation("ns")` call produces. */
function isKeyRendered(dotted) {
  const tail = dotted.split(".").slice(1).join(".");
  return FRONTEND_SOURCE.some((p) => {
    const src = read(p);
    return (
      src.includes(`"${dotted}"`) || src.includes(`'${dotted}'`) ||
      (tail && (src.includes(`"${tail}"`) || src.includes(`'${tail}'`)))
    );
  });
}

function* flatten(obj, prefix = "") {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) yield* flatten(v, key);
    else yield [key, v];
  }
}

/** K1c — "Ask" must not be a LIST ROW.
 *
 *  Enforced through DEAD KEYS: the row's own i18n keys must have no
 *  reference left in component source. When Ask is promoted out of the
 *  list, nothing renders them; while it is still a row, something does.
 *  This survives refactors that a source-pattern match would not. */
const ASK_ROW_KEYS = ["capsuleRouter.ask.row", "capsuleRouter.ask.rowEmpty"];

function gateAskIsNotARow() {
  for (const key of ASK_ROW_KEYS) {
    const short = key.split(".").pop();
    // The dot is ESCAPED. An earlier draft wrote `ask\\.${short}` with a
    // live `.` metacharacter, which matched the PROSE "the Ask row
    // carries the query" in a comment and reported `capsuleRouter.ts` —
    // a frozen, import-only file — as a renderer. A gate that names the
    // wrong file sends the next reader to fix something that is not
    // broken, so this one is exact.
    const users = FRONTEND_SOURCE.filter((p) => {
      // SCOPE, corrected by the live gate. `frontend/lib/capsuleRouter.ts`
      // is frozen and import-only, and it does not render anything — it
      // returns ROW DATA that includes an ask row, which the surface is
      // free to present as its default action rather than as a list item.
      // Flagging it sent the reader to a file they must not edit, to fix
      // a defect that is not there. The law is about what a COMPONENT
      // puts on screen, and `capsule.spec.ts` §K1 proves the outcome.
      if (/\/lib\/capsuleRouter\.ts$/.test(p)) return false;
      const src = read(p);
      // t("capsuleRouter.ask.row") or t("ask.row") under a namespace
      return (
        src.includes(`"${key}"`) ||
        src.includes(`'${key}'`) ||
        new RegExp(`["'\`]ask\\.${short}["'\`]`).test(src)
      );
    });
    if (users.length) {
      fail(
        "K1",
        `"${key}" is still rendered by ${users.map(rel).join(", ")}.\n` +
          `        ASK IS NOT A ROW. It is the DEFAULT ACTION of the prose ` +
          `input — Enter answers. A row makes asking a navigation choice ` +
          `the reader has to find among destinations.`,
      );
    }
  }
}

/** K1b — the capsule trigger's accessible name. */
function gateTriggerAccessibleName() {
  const hits = FRONTEND_SOURCE.filter((p) =>
    read(p).includes('data-testid="header-command-bar"'),
  );
  if (hits.length === 0) {
    fail(
      "K1",
      'no component emits data-testid="header-command-bar" — the capsule ' +
        "trigger anchor every capsule gate depends on is gone. Retarget the " +
        "gates or restore the anchor; do not leave them pointing at nothing.",
    );
    return;
  }
  notes.push(
    `K1b: capsule trigger anchor data-testid="header-command-bar" found in ` +
      `${hits.map(rel).join(", ")}`);
  for (const p of hits) {
    const src = read(p);
    const block = src.slice(
      Math.max(0, src.indexOf('data-testid="header-command-bar"') - 900),
      src.indexOf('data-testid="header-command-bar"') + 900,
    );
    const labels = [...block.matchAll(/(?:aria-label|title)=\{?["'{]([^"'}]{2,80})/g)]
      .map((m) => m[1])
      .filter((s) => !s.startsWith("$"));
    for (const label of labels) {
      // A t(...) call resolves at runtime; the live gate checks those.
      if (/^t\(/.test(label) || label.includes("(")) continue;
      if (SEARCH_VERB.en.test(label) && !ASK_VERB.en.test(label)) {
        fail(
          "K1",
          `${rel(p)} labels the capsule trigger ${JSON.stringify(label)}.\n` +
            `        That is the accessible name — a screen-reader user is ` +
            `told this control SEARCHES, whatever the placeholder now says.`,
        );
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════════════
// K8 — the header budget is FOUR
// ══════════════════════════════════════════════════════════════════════
//
// The header lane owns `header.spec.ts` and the live census. This gate
// owns only the NUMBER, read from that spec, so the two lanes cannot
// silently disagree about what the budget is. Asserting the number here
// and the census there means neither lane can move the budget alone.

// OWNER AMENDMENT 2026-08-31: FIVE, not four. Simple|Pro was restored
// to the bar, reversing the Prompt-16 placement.
//
// This is the FIFTH law that had to move for that one reversal —
// after SANCTIONED_DESKTOP, L4 in check_header_law.mjs, H1's live
// census and H0's self-audit. It was missed on the first pass and
// caught by the battery, which is the argument for keeping every one
// of them as an assertion rather than deleting the ones that get
// inconvenient: a duplicated expectation nobody updates is how the
// bar and its budget end up disagreeing silently.
const HEADER_BUDGET_TARGET = 5;

function gateHeaderBudget() {
  const specPath = path.join(ROOT, "e2e/design/header.spec.ts");
  let src;
  try {
    src = read(specPath);
  } catch {
    fail("K8", "e2e/design/header.spec.ts is missing — the budget has no home.");
    return;
  }
  // SHAPE-TOLERANT, because the header lane changed shape mid-wave: its
  // law moved from a scalar ceiling (`HEADER_BUDGET = 5`) to an EXACT
  // sanctioned set (`SANCTIONED_DESKTOP = [...]`). A gate that knew only
  // the old shape reported "the number moved or was renamed" — which
  // read as this lane's bug rather than the header lane's improvement.
  // NEITHER shape present is still a failure: then nothing pins it.
  const set = /const SANCTIONED_DESKTOP[^=]*=\s*(?:Object\.freeze\()?\[([\s\S]*?)\]/.exec(src);
  const m = /const HEADER_BUDGET\s*=\s*(\d+)/.exec(src);
  let budget = null;
  let shape = "";
  if (set) {
    budget = set[1].split(",").map((x) => x.trim()).filter(Boolean).length;
    shape = `SANCTIONED_DESKTOP (${budget} identities)`;
  } else if (m) {
    budget = Number(m[1]);
    shape = `HEADER_BUDGET = ${budget}`;
  }
  if (budget === null) {
    fail(
      "K8",
      "header.spec.ts pins the header budget in NEITHER shape this gate knows " +
        "(SANCTIONED_DESKTOP nor HEADER_BUDGET) — nothing pins it on that side.",
    );
    return;
  }
  if (budget !== HEADER_BUDGET_TARGET) {
    fail(
      "K8",
      `header.spec.ts pins ${shape}; the H1 budget for this wave is ` +
        `${HEADER_BUDGET_TARGET} (brand · capsule · dial · bell · avatar).`,
    );
  } else {
    notes.push(`K8: header.spec.ts pins ${shape}`);
  }
}

// ══════════════════════════════════════════════════════════════════════
// S1–S3 — the STALE-SELECTOR census
// ══════════════════════════════════════════════════════════════════════

/** Every literal `data-testid="x"` a component emits. */
function producedTestIds() {
  const exact = new Set();
  const dynamicPrefixes = new Set();
  for (const p of walk(path.join(ROOT, "frontend"), (n) => /\.tsx?$/.test(n))) {
    const src = read(p);
    for (const m of src.matchAll(/data-testid=["']([^"']+)["']/g)) exact.add(m[1]);
    // data-testid={`thing-${x}`} — everything before the first ${
    for (const m of src.matchAll(/data-testid=\{`([^`$]*)\$\{/g)) {
      if (m[1].length >= 3) dynamicPrefixes.add(m[1]);
    }
    // testId="x" props that a shared component spreads onto data-testid
    for (const m of src.matchAll(/\btestId[:=]\s*["']([^"']+)["']/g)) exact.add(m[1]);
  }
  return { exact, dynamicPrefixes };
}

/** Non-testid attribute selectors an e2e spec names, e.g. [data-coachmark]. */
const ATTR_SELECTOR_RE = /\[\s*(data-[a-z0-9-]+|cmdk-[a-z-]+)\s*(?:[\]=^*$~|])/gi;

function censusStaleSelectors() {
  const { exact, dynamicPrefixes } = producedTestIds();
  const rows = [];

  const isProduced = (id) =>
    exact.has(id) || [...dynamicPrefixes].some((p) => id.startsWith(p));

  for (const spec of SPEC_FILES) {
    const lines = read(spec).split("\n");
    lines.forEach((line, i) => {
      // testids, in every form a spec writes them
      const ids = new Set();
      for (const m of line.matchAll(/getByTestId\(\s*["'`]([^"'`]+)["'`]/g)) ids.add(m[1]);
      for (const m of line.matchAll(/data-testid=\\?["']([^"'\\\]]+)\\?["']/g)) ids.add(m[1]);
      // THE CLASSIFIER READS THE STATEMENT, NOT THE LINE. A Playwright
      // assertion is routinely spread over four lines: an `await expect(`
      // opener, then the locator, then the failure message, then a
      // `.toHaveCount(0)` on the closing line.
      //
      // (Written as prose rather than as a code sample on purpose. A
      // literal selector inside a comment is indistinguishable from a
      // real reference to the repo-wide `scripts/check_stale_gates.mjs`,
      // which scans `scripts/` too — an example in a comment was being
      // reported as a stale gate. A census must not be a source of the
      // noise it exists to remove.)
      // A line-scoped classifier sees only the locator and grades the
      // most dangerous case in the repo — a negative assertion on a dead
      // selector — as harmless debt. The window is the statement.
      const window = lines.slice(Math.max(0, i - 3), i + 7).join(" ");

      for (const id of ids) {
        // A wildcard/prefix matcher is not a literal id; skip those.
        if (/[*^$~]/.test(id)) continue;
        if (!isProduced(id)) {
          rows.push({ spec, line: i + 1, kind: "testid", sel: id, text: line.trim(), window });
        }
      }
      // bare attribute hooks
      for (const m of line.matchAll(ATTR_SELECTOR_RE)) {
        const attr = m[1];
        if (attr === "data-testid") continue;
        const produced = walkHasAttr(attr);
        if (!produced) {
          rows.push({ spec, line: i + 1, kind: "attr", sel: `[${attr}]`, text: line.trim(), window });
        }
      }
    });
  }
  return rows;
}

/**
 * LIBRARY-EMITTED ATTRIBUTES.
 *
 * `data-radix-popper-content-wrapper` is stamped by Radix at runtime, not
 * by any file under `frontend/`, so a source scan alone would report it
 * stale — a FALSE POSITIVE, which is exactly the disease this gate treats.
 * The membership test is therefore "does an INSTALLED package emit it",
 * resolved once against the dependency that owns the prefix.
 *
 * `cmdk-*` is deliberately NOT on this list. `cmdk` is in package.json but
 * imported nowhere in `frontend/` (0 references) — the palette is a Radix
 * Dialog. `[cmdk-root]` therefore cannot match, and an unused dependency
 * is a finding of its own, recorded in GATES.md.
 */
const LIBRARY_ATTR_PREFIXES = [
  { prefix: "data-radix-", pkg: "@radix-ui/react-popper" },
];

let ATTR_CACHE = null;
function walkHasAttr(attr) {
  const lower = attr.toLowerCase();
  for (const { prefix, pkg } of LIBRARY_ATTR_PREFIXES) {
    if (!lower.startsWith(prefix)) continue;
    // Only counts if the package is actually installed — an attribute
    // whose library was removed is as dead as one nobody ever wrote.
    try {
      statSync(path.join(ROOT, "node_modules", pkg));
      return true;
    } catch {
      return false;
    }
  }
  if (!ATTR_CACHE) {
    ATTR_CACHE = new Set();
    // e2e/ too: a gate that PLANTS an attribute and then selects it is
    // its own producer, and looking only in frontend/ calls that dead.
    const producerRoots = [path.join(ROOT, "frontend"), path.join(ROOT, "e2e")];
    for (const p of producerRoots.flatMap((r) => walk(r, (n) => /\.tsx?$/.test(n)))) {
      const src = read(p);
      // THREE PRODUCER SHAPES, because matching only the first is the
      // false-positive half of this census.
      //
      //   <div data-foo=…>                     a literal JSX attribute
      //   const ATTR = "data-foo"              a named constant, then
      //                                        applied indirectly
      //   el.setAttribute("data-foo", …)       set imperatively
      //
      // Scanning literals alone reported `data-suppressed-title` as
      // having no producer while `CapsuleTooltipGuard` emits it through
      // `SUPPRESSED_TITLE_ATTR`, and reported a spec's own
      // `setAttribute` plant as dead. Both are the same mistake this
      // gate exists to catch, made by the gate: a scan that cannot see a
      // producer reports the producer missing rather than reporting that
      // it cannot see.
      for (const m of src.matchAll(/\b(data-[a-z0-9-]+|cmdk-[a-z-]+)\s*[=}]/gi)) {
        ATTR_CACHE.add(m[1].toLowerCase());
      }
      for (const m of src.matchAll(/["'`](data-[a-z0-9-]+|cmdk-[a-z-]+)["'`]/gi)) {
        ATTR_CACHE.add(m[1].toLowerCase());
      }
    }
  }
  return ATTR_CACHE.has(lower);
}

/** A selector that matches nothing is only a BUG when the assertion
 *  around it can therefore never fail. Three shapes qualify, and the
 *  census classifies rather than lumping them: */
function classify(text) {
  if (/toHaveCount\(\s*0\s*\)|toBeHidden|not\.toBeVisible/.test(text)) {
    return {
      severity: "FALSE-GREEN",
      why: "a negative assertion on a selector nothing emits can never fail",
    };
  }
  if (/count\(\)\)\s*===\s*0|count\(\)\s*===\s*0/.test(text)) {
    return {
      severity: "FALSE-GREEN",
      why: "an early-return guard whose condition is always true — the gate body is unreachable",
    };
  }
  if (/\.exclude\(/.test(text)) {
    return {
      severity: "DEAD-LIMB",
      why: "an exclusion that excludes nothing; the scan is not doing what the comment claims",
    };
  }
  return {
    severity: "DEAD-LIMB",
    why: "an unreachable limb of a selector union, or a positive assertion that would fail loudly if reached",
  };
}

function gateStaleSelectors() {
  const rows = censusStaleSelectors();
  const byFile = new Map();
  for (const r of rows) {
    const k = rel(r.spec);
    if (!byFile.has(k)) byFile.set(k, []);
    byFile.get(k).push(r);
  }

  console.log("\n── STALE-SELECTOR CENSUS ──────────────────────────────────");
  console.log(
    `   ${SPEC_FILES.length} spec file(s) swept · ` +
      `${rows.length} selector reference(s) with no producer in frontend/`,
  );
  if (rows.length === 0) console.log("   clean");
  for (const [file, list] of [...byFile].sort()) {
    console.log(`\n   ${file}`);
    for (const r of list) {
      const c = classify(r.window ?? r.text);
      console.log(`     :${r.line}  ${c.severity}  ${r.sel}`);
      console.log(`             ${c.why}`);
      console.log(`             ${r.text.slice(0, 96)}`);
    }
  }
  console.log("");

  // Only FALSE-GREEN rows fail the gate. A DEAD-LIMB inside a union
  // (`[role="dialog"], [cmdk-root]`) still has a live sibling, so the
  // assertion CAN fail; it is debt, not a lie. The distinction is the
  // point — a gate that shouted equally at both would be ignored.
  const lying = rows.filter((r) => classify(r.window ?? r.text).severity === "FALSE-GREEN");
  for (const r of lying) {
    fail(
      "S1",
      `${rel(r.spec)}:${r.line} asserts on ${r.sel}, which no component in ` +
        `frontend/ can emit — the assertion is a tautology.\n` +
        `        ${r.text.slice(0, 110)}\n` +
        `        Retarget it at what the law actually means, or delete it. ` +
        `A gate that cannot fail is not protecting anything.`,
    );
  }
  return rows;
}

// ══════════════════════════════════════════════════════════════════════

function main() {
  const rows = gateStaleSelectors();
  if (CENSUS_ONLY) {
    console.log(`census-only: ${rows.length} row(s), exit 0`);
    return 0;
  }
  gateAskFirstCopy();
  gateAskIsNotARow();
  gateTriggerAccessibleName();
  gateHeaderBudget();

  for (const n of notes) console.log(`   ok  ${n}`);

  // ── WORK CENSUS + DISCOVERY CANARY ────────────────────────────────
  //
  // Every law here is decided by reading two file sets. Both are built
  // by a walker at module load, and a walker that returns [] makes each
  // law vacuously satisfied: no strings file to lint, no spec file to
  // sweep, no component to find the trigger in. K1 already fails when
  // it finds no placeholder — this extends that discipline to the sets
  // themselves, so the sweep cannot report a clean census over nothing.
  const scanned = FRONTEND_SOURCE.length + SPEC_FILES.length;
  const broken = [];
  if (FRONTEND_SOURCE.length === 0) broken.push("0 frontend source files walked");
  if (SPEC_FILES.length === 0) broken.push("0 e2e/design spec files walked");
  if (broken.length) {
    console.log("\nFAIL check_capsule_ask — DISCOVERY BROKEN");
    for (const b of broken) console.log(`  - ${b}`);
    console.log("  Every gate in this file reads one of those two sets. " +
      "Empty sets satisfy every law it states.");
    return 1;
  }

  if (failures.length === 0) {
    console.log(`GATE-WORK capsule-ask units=${scanned} floor=100 ` +
      `label=source+spec-files`);
    console.log(`\nPASS check_capsule_ask — ASK-FIRST copy, header budget, ` +
      `selector census (${FRONTEND_SOURCE.length} source + ` +
      `${SPEC_FILES.length} spec file(s) scanned)`);
    return 0;
  }
  console.log(`\nFAIL check_capsule_ask — ${failures.length} violation(s)\n`);
  for (const f of failures) console.log(`  [${f.gate}] ${f.message}\n`);
  return 1;
}

process.exit(main());
