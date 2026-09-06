#!/usr/bin/env node
/**
 * ORG PURGE BY NAME — a destructive path against `organizations` may not
 * choose its victims by NAME.
 *
 * ════════════════════════════════════════════════════════════════════════
 * THE INCIDENT (2026-09-06)
 * ════════════════════════════════════════════════════════════════════════
 * A cleanup deleted junk workspaces with `name = 'Test workspace'`. The
 * filter cut both ways:
 *
 *   · It DESTROYED THE SENTINEL. Org 00000000-0000-4000-8000-000000000002
 *     — hardcoded as `_DEFAULT_TEST_ORG_ID` in src/engine/api/_test_mode.py
 *     and `TEST_ORG_ID` in frontend/lib/testMode.ts — was itself named
 *     "Test workspace", so the filter took it, and the cascade took its
 *     four financial_periods and every document with it.
 *   · It SPARED 12 junk orgs named "My workspace", because
 *     ensureDefaultWorkspace() names a workspace from the Supabase
 *     session's user_metadata.company_name, which is absent in some flows.
 *
 * A name is not an identity. The correct filter is "every org of the test
 * user EXCEPT the sentinel id" — an id, a membership, or a timestamp.
 *
 * ════════════════════════════════════════════════════════════════════════
 * IT ASSERTS THE SAFE SHAPE, NOT THE ABSENCE OF THE BAD ONE
 * ════════════════════════════════════════════════════════════════════════
 * A denylist of bad patterns fails OPEN on anything novel, and a regex
 * vocabulary is trivially evaded — a quoted identifier (`"name" = ...`),
 * a `.or("name.ilike.…")`, a dynamic column key, or a predicate hidden in
 * a helper all defeat a pattern list. So the primary rule here is
 * POSITIVE: every destructive statement against `organizations` must
 * select its victims by a predicate this gate RECOGNISES AS SAFE — an id,
 * a membership/user scope, or a time column. A predicate it does not
 * recognise is a FAIL, not a pass. Novelty fails closed.
 *
 * The name-specific detectors remain, because they turn a generic
 * "unrecognised predicate" into the specific message a reader can act on.
 *
 * ════════════════════════════════════════════════════════════════════════
 * TWO WORK COUNTS, BECAUSE HALF THIS GATE CAN DIE SILENTLY
 * ════════════════════════════════════════════════════════════════════════
 * `units` counts the destructive statements ADJUDICATED — not the files
 * scanned, and not the pattern hits. A file count cannot fall when the
 * window finder breaks; an adjudication count can only be produced by the
 * half of the gate that actually reaches a verdict. The scan count is
 * printed alongside so a collapse in EITHER half is visible.
 *
 * Files excluded by the prefilter are COUNTED AND PRINTED. A prefilter
 * that hides its own exclusions is how coverage dies quietly.
 *
 * ════════════════════════════════════════════════════════════════════════
 * WHAT THIS GATE CANNOT DO — STATED, NOT IMPLIED
 * ════════════════════════════════════════════════════════════════════════
 * It reads REPO TEXT. It cannot read the deployed database. This project
 * applies migrations by hand in the Supabase SQL editor (CLAUDE.md §14),
 * and `create or replace function` by migration is normal practice here,
 * so a name-based purge can be live in Postgres with every file in git
 * correct. The incident itself was a human pasting a DELETE at a console.
 * The PASS line says only what was examined. Do not read it as "this
 * cannot happen".
 *
 * Usage: node scripts/check_org_purge_by_name.mjs [--self-test]
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const TABLE = "organizations";

/**
 * A DESTRUCTIVE STATEMENT IS ONE THAT REMOVES OR RETIRES ROWS.
 *
 * The first draft matched a broad verb vocabulary (purge|prune|…|drop|
 * archive) anywhere near the word `organizations`, and duly fired on
 * `drop policy if exists "organizations owner delete" on organizations`
 * — schema DDL that selects no victims at all. DDL, grants and policy
 * definitions are not victim selection, and a gate that cannot tell them
 * apart from a DELETE is one whose findings get skimmed.
 *
 * So the window is opened by a ROW MUTATION against the table, not by a
 * verb near it. The vocabulary is still deliberately open on the RPC side
 * (any `purge|prune|reap|sweep|nuke|wipe|teardown` function that deletes)
 * so a cleanup written with a fresh verb is not dropped.
 */
const ROW_MUTATION = [
  /\bdelete\s+from\s+"?organizations"?\b/i,
  /\btruncate\s+(?:table\s+)?"?organizations"?\b/i,
  /\bupdate\s+"?organizations"?\s+set\b/i,
  /\.(?:from|table)\(\s*["'`]organizations["'`]\s*\)[\s\S]{0,240}?\.(?:delete|update)\s*\(/i,
  /rest\/v1\/organizations[^\s"'`]*[\s\S]{0,160}?-X\s*(?:DELETE|PATCH)/i,
  /-X\s*(?:DELETE|PATCH)[\s\S]{0,160}?rest\/v1\/organizations/i,
  /\b(?:purge|prune|reap|sweep|nuke|wipe|teardown)[A-Za-z_]*\s*\([^)]*\)[\s\S]{0,240}?\bdelete\s+from\b/i,
];

/** DDL and permissions touch the table without choosing any row. */
const NOT_A_VICTIM_SELECTION =
  /\b(?:drop|create|alter)\s+(?:policy|table|index|function|trigger|view|type|constraint|publication)\b|\b(?:grant|revoke)\b|\bcomment\s+on\b/i;

/** Predicates a destructive statement is ALLOWED to select victims by. */
const SAFE_PREDICATE = [
  // Both argument orders. The SQL form puts the column first
  // (`where id = $1`); the supabase-js and PostgREST forms put the verb
  // first (`.eq("id", …)`, `?id=eq.…`). The first draft only knew the SQL
  // order and therefore called `.update(patch).eq("id", org.id)` — the
  // safest statement in the file — an unrecognised predicate.
  { name: "id", rx: /\b(?:"?id"?|org_id|orgId|p_org_id|organization_id)\s*(?:=|==|!=|<>|\bin\b|\.eq|\.in)/i },
  { name: "id (js)", rx: /\.(?:eq|neq|in_?|match|filter)\(\s*["'`](?:id|org_id|organization_id)["'`]/i },
  { name: "id (js object)", rx: /\.match\(\s*\{[^}]*\b(?:id|org_id)\s*:/i },
  { name: "id (rest)", rx: /\bid=(?:eq|in|neq)\./i },
  { name: "membership/user scope", rx: /\b(?:user_id|auth\.uid\(\)|memberships|is_member_of|owner_id)\b/i },
  { name: "time column", rx: /\b(?:purge_after|archived_at|created_at|updated_at|deleted_at)\b/i },
];

/** Name-based victim selection. These make the failure legible; the
 *  positive rule above is what actually makes the gate closed. */
const NAME_SELECTORS = [
  { id: "SQL", rx: /"?\bname\b"?\s*(?:=|<>|!=|~~\*?|\bilike\b|\blike\b|\bin\b)/i },
  { id: "REST", rx: /\bname=(?:eq|ilike|like|in|neq|fts|plfts)\./i },
  { id: "JS-filter", rx: /\.(?:eq|neq|ilike|like|in_?|match|filter|textSearch|contains)\(\s*["'`]name["'`]/i },
  { id: "JS-or", rx: /\.or\(\s*[^)]*\bname\.(?:eq|ilike|like|in)\b/i },
  { id: "JS-match-obj", rx: /\.match\(\s*\{[^}]*\bname\s*:/i },
  { id: "py-filter", rx: /\.eq\(\s*["']name["']/i },
  { id: "dynamic-key", rx: /\[\s*(?:col|column|field|key)\s*\]|%I/i },
];

const EXTS = new Set([
  ".sql", ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".sh", ".bash", ".zsh", ".md", ".json", ".yml", ".yaml", ".toml",
]);

/** This gate's own text, and the plant log that must quote it, describe
 *  the forbidden shape in prose. Printed, never a silent skip. */
const SELF_EXEMPT = [
  "scripts/check_org_purge_by_name.mjs",
  "docs/engine_book/gates.md",
];

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

function trackedFiles(root) {
  const out = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 });
  return out.split("\n").filter(Boolean);
}

/**
 * PROSE IS NOT CODE, AND THIS GATE MUST NOT ADJUDICATE IT.
 *
 * The first run of this detector produced 48 findings, of which every one
 * was a sentence — CLAUDE.md explaining the incident, qa_cleanup.py's own
 * docstring describing what it refuses to do, this repo's runbooks quoting
 * the forbidden statement in order to forbid it. A gate that reds on the
 * documentation of its own law is a gate that gets switched off.
 *
 * So non-code spans are blanked before adjudication — blanked, not
 * removed, so every reported line number still points at the real line.
 * Markdown keeps ONLY fenced code; source keeps only what is not a
 * comment or a docstring. The number of blanked lines is COUNTED and
 * PRINTED: a preprocessing step that quietly eats coverage is the same
 * defect as a prefilter that quietly drops files.
 */
function stripNonCode(text, ext) {
  const lines = text.split("\n");
  const keep = lines.slice();
  let blanked = 0;
  const blank = (i) => {
    if (keep[i] !== "") {
      keep[i] = "";
      blanked++;
    }
  };

  if (ext === ".md") {
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
      const fence = /^\s*```/.test(lines[i]);
      if (fence) {
        inFence = !inFence;
        blank(i);
        continue;
      }
      const indentedCode = /^(?: {4}|\t)/.test(lines[i]);
      if (!inFence && !indentedCode) blank(i);
    }
    return { text: keep.join("\n"), blanked };
  }

  const lineComment =
    ext === ".py" || ext === ".sh" || ext === ".bash" || ext === ".zsh" || ext === ".yml" || ext === ".yaml"
      ? /^\s*#/
      : ext === ".sql"
        ? /^\s*--/
        : /^\s*(\/\/|\*|\/\*)/;

  let inDoc = null; // python triple-quote or a /* */ block
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (inDoc) {
      const closed = l.includes(inDoc);
      blank(i);
      if (closed) inDoc = null;
      continue;
    }
    const m = ext === ".py" ? /("""|''')/.exec(l) : /\/\*/.exec(l);
    if (m) {
      const tok = ext === ".py" ? m[1] : "*/";
      const rest = l.slice(m.index + m[0].length);
      if (!rest.includes(tok)) inDoc = tok;
      blank(i);
      continue;
    }
    if (lineComment.test(l)) blank(i);
  }
  return { text: keep.join("\n"), blanked };
}

/** Split text into candidate statements. SQL on `;`, everything else on
 *  lines, with a small trailing window so a filter chained on the next
 *  line is still inside its statement. */
function statements(text, ext) {
  if (ext === ".sql") {
    const parts = [];
    let buf = [];
    let line = 1;
    let start = 1;
    for (const l of text.split("\n")) {
      if (buf.length === 0) start = line;
      buf.push(l);
      if (l.includes(";")) {
        parts.push({ text: buf.join("\n"), line: start });
        buf = [];
      }
      line++;
    }
    if (buf.length) parts.push({ text: buf.join("\n"), line: start });
    return parts;
  }
  // ANCHOR THE WINDOW ON THE MUTATION, NOT ON EVERY LINE.
  //
  // A window per line reported the same `.from("organizations").delete()`
  // four times, anchored at four different lines, three of which printed
  // an excerpt that had nothing to do with the finding. Anchoring on the
  // line that names the mutation gives one finding per statement and an
  // excerpt that is the statement. The window reaches BACKWARD as well as
  // forward, because a supabase-js filter is as often chained above the
  // call as below it.
  const lines = text.split("\n");
  const ANCHOR =
    /\.(?:from|table)\(\s*["'`]organizations["'`]|\bdelete\s+from\s+"?organizations"?\b|\btruncate\s+(?:table\s+)?"?organizations"?\b|\bupdate\s+"?organizations"?\s+set\b|rest\/v1\/organizations/i;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!ANCHOR.test(lines[i])) continue;
    out.push({
      text: lines.slice(Math.max(0, i - 4), i + 6).join("\n"),
      line: i + 1,
      anchor: lines[i].trim(),
    });
  }
  return out;
}

function adjudicate(root, files) {
  const findings = [];
  let adjudicated = 0;
  let scanned = 0;
  let proseLines = 0;
  const skippedExt = [];
  const skippedNoTable = [];

  for (const rel of files) {
    const ext = path.extname(rel).toLowerCase();
    if (!EXTS.has(ext)) {
      skippedExt.push(rel);
      continue;
    }
    let text;
    try {
      text = fs.readFileSync(path.join(root, rel), "utf8");
    } catch {
      // Unreadable is not absent — a tracked file we cannot read is a
      // file we cannot clear.
      findings.push({ rel, line: 0, code: "UNREADABLE", detail: "tracked file could not be read" });
      continue;
    }
    scanned++;
    if (!text.includes(TABLE)) {
      skippedNoTable.push(rel);
      continue;
    }
    if (SELF_EXEMPT.includes(rel)) continue;

    const stripped = stripNonCode(text, ext);
    proseLines += stripped.blanked;
    for (const st of statements(stripped.text, ext)) {
      const s = st.text;
      if (!s.includes(TABLE)) continue;
      if (NOT_A_VICTIM_SELECTION.test(s)) continue;
      if (!ROW_MUTATION.some((rx) => rx.test(s))) continue;

      adjudicated++;
      const named = NAME_SELECTORS.filter((n) => n.rx.test(s));
      const safe = SAFE_PREDICATE.filter((p) => p.rx.test(s));

      if (named.length) {
        findings.push({
          rel,
          line: st.line,
          code: "NAME-SELECTED",
          detail: `destructive statement against ${TABLE} selects by name (${named.map((n) => n.id).join(", ")})`,
          excerpt: (st.anchor ?? s.split("\n")[0]).trim().slice(0, 140),
        });
      } else if (safe.length === 0) {
        findings.push({
          rel,
          line: st.line,
          code: "UNRECOGNISED-PREDICATE",
          detail:
            "destructive statement against organizations selects by a predicate this gate does not recognise as safe (id / membership / time)",
          excerpt: (st.anchor ?? s.split("\n")[0]).trim().slice(0, 140),
        });
      }
    }
  }
  return { findings, adjudicated, scanned, skippedExt, skippedNoTable, proseLines };
}

// ── self-test: the detector must fire on planted text ──────────────────
const PLANTS = [
  ["delete from organizations where name = 'Test workspace';", true, "name"],
  [`delete from organizations where "name" = 'Test workspace';`, true, "name"],
  ["delete from organizations o where o.\"name\" ilike 'Test %';", true, "name"],
  ["await supabase.from('organizations').delete().eq('name', label)", true, "name"],
  // supabase-py's client says .table(), not .from(). The certifying plant
  // used exactly this line and slipped straight through the first draft —
  // the gate printed PASS over the incident it exists to catch.
  ['supabase.table("organizations").delete().eq("name", "Test workspace")', true, "name"],
  ["await supabase.from('organizations').delete().or(`name.ilike.%${l}%`)", true, "name"],
  ["await supabase.from('organizations').delete().match({ name: label })", true, "name"],
  ["curl -X DELETE \"$U/rest/v1/organizations?name=eq.Test%20workspace\"", true, "name"],
  ["execute format('delete from organizations where %I = $1', 'name')", true, "name"],
  // Caught only by the POSITIVE rule: no name anywhere, but no recognised
  // safe predicate either. This is the entry that keeps the positive half
  // measured.
  ["delete from organizations where label_slug = $1;", true, "predicate"],
  ["delete from organizations where id = any(p_ids);", false, "safe"],
  ["delete from organizations where purge_after < now();", false, "safe"],
  ["delete from organizations where id in (select org_id from memberships where user_id = p_uid);", false, "safe"],
];

function selfTest() {
  console.log("ORG PURGE BY NAME — DETECTOR SELF-TEST");
  console.log("=".repeat(62));

  // ── WHY THIS ASSERTS PER-MECHANISM ────────────────────────────────────
  // The first version asked only "does the gate fire?". It could not fail:
  // a name-shaped plant fires EITHER because a NAME selector matched it OR
  // because it has no safe predicate, and the two mask each other. Blinding
  // the JS filter pattern, then the Python one, then making the positive
  // rule vacuous — each was planted and observed, and the self-test stayed
  // 12/12 green through all of them. Two mechanisms, one assertion, and a
  // regression in either was invisible.
  //
  // So each mechanism is now asserted on its own: a name-shaped plant must
  // be caught BY THE NAME DETECTORS, and a predicate-less plant must be
  // caught BY THE POSITIVE RULE. Losing either is red.
  let pass = 0;
  const fails = [];
  for (const [snippet, shouldFire, mechanism] of PLANTS) {
    const named = NAME_SELECTORS.some((n) => n.rx.test(snippet));
    const safe = SAFE_PREDICATE.some((p) => p.rx.test(snippet));
    const fires = named || !safe;

    let ok = fires === shouldFire;
    if (ok && shouldFire && mechanism === "name" && !named) {
      ok = false;
      fails.push(`NAME DETECTOR BLIND (only the positive rule caught it): ${snippet}`);
    } else if (ok && shouldFire && mechanism === "predicate" && safe) {
      ok = false;
      fails.push(`POSITIVE RULE BLIND (only a name pattern caught it): ${snippet}`);
    } else if (!ok) {
      fails.push(`${shouldFire ? "MISSED" : "FALSE FIRE"}: ${snippet}`);
    }
    if (ok) pass++;
  }
  console.log(`GATE-WORK org-purge-selftest units=${PLANTS.length} floor=8 label=planted-cases`);
  for (const f of fails) console.log(`  \u2717 ${f}`);
  if (fails.length) {
    console.log(`\nFAIL — ${fails.length} planted case(s) are not caught by the mechanism that must catch them.`);
    return 1;
  }
  console.log(
    `\nPASS — every planted violation is caught by its own mechanism, and no safe form fires (${pass}/${PLANTS.length}).`,
  );
  return 0;
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();

  const root = repoRoot();
  const files = trackedFiles(root);
  const { findings, adjudicated, scanned, skippedExt, skippedNoTable, proseLines } =
    adjudicate(root, files);

  console.log("ORG PURGE BY NAME");
  console.log("=".repeat(62));
  console.log(`GATE-WORK org-purge-by-name units=${adjudicated} floor=3 label=destructive-statements-adjudicated`);
  console.log(`  tracked files       : ${files.length}`);
  console.log(`  files read          : ${scanned}`);
  console.log(`  skipped, extension  : ${skippedExt.length}`);
  console.log(`  skipped, no "${TABLE}" : ${skippedNoTable.length}`);
  console.log(`  prose lines blanked : ${proseLines} (comments, docstrings, unfenced markdown)`);
  console.log(`  self-exempt         : ${SELF_EXEMPT.join(", ")}`);

  if (adjudicated === 0) {
    console.log("");
    console.log("DISCOVERY BROKEN — adjudicated zero destructive statements against");
    console.log(`${TABLE}. This repo has several (purge_expired_workspaces,`);
    console.log("archive_workspace, purge_workspace). A census that finds nothing is a");
    console.log("broken gate, never a passing one.");
    return 1;
  }

  if (findings.length) {
    console.log("");
    console.log(`FAIL — ${findings.length} destructive statement(s) that do not select safely:`);
    for (const f of findings) {
      console.log(`  [${f.code}] ${f.rel}:${f.line}`);
      console.log(`        ${f.detail}`);
      if (f.excerpt) console.log(`        > ${f.excerpt}`);
    }
    console.log("");
    console.log("A name is not an identity. Select by id, by membership, or by time.");
    return 1;
  }

  console.log("");
  console.log(
    `PASS — ${adjudicated} destructive statement(s) against ${TABLE} in the REPO TEXT all select by id, membership or time.`,
  );
  console.log("  Scope: repo text only. The deployed database is not examined and");
  console.log("  migrations here are applied by hand — this is not a claim about Postgres.");
  return 0;
}

process.exit(main());
