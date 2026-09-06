// generate_legal_documents — content/legal/*.md → frontend/lib/legalDocuments.generated.ts
//
// WHAT THIS OWNS
// ==============
// One rendering of each legal document, plus the version identity a user's
// acceptance is recorded against. Everything in the generated module is
// DERIVED from the reviewed markdown: the title, the publication date, the
// meta description, the rendered HTML and the sha256 of the source bytes.
// Nothing is typed by hand, so nothing can drift from the text a lawyer read.
//
// WHY THE OUTPUT IS COMMITTED RATHER THAN BUILT ON THE FLY
// =======================================================
// Two consumers need it at different times: `vite build` (which prerenders
// the pages) and `vitest` / `tsc` (which type-check and assert on it without
// running a build). A committed module serves both, and `vite.config.ts`
// regenerates it on every build so it can never ship stale — the gate
// `scripts/check_legal_published.mjs` reds if the committed bytes differ from
// a fresh regeneration.
//
// Usage:  node scripts/generate_legal_documents.mjs [--check]
//   --check  exit 1 if the committed file differs (no write)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  renderLegalMarkdown,
  parsePublishedDate,
  sha256,
  deriveMetaDescription,
} from "./legal_markdown.mjs";

// ROOT IS SEARCHED FOR, NOT COMPUTED AS "../".
//
// vite.config.ts imports this module, and Vite loads its config by BUNDLING
// it with esbuild into a temp file at the repo root — which rewrites
// `import.meta.url` to that temp file. A hardcoded `dirname(...)/..` then
// resolves to the PARENT of the repository and every read fails, at build
// time only, with a confusing ENOENT. Walking up from wherever this code
// actually lives until the marker file appears is correct from `scripts/`
// (one level up) and from an inlined copy at the root (zero levels up).
function findRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "content", "legal", "entity.json"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`generate_legal_documents: no content/legal/entity.json above ${startDir}`);
}

const ROOT = findRoot(path.dirname(fileURLToPath(import.meta.url)));
const CONTENT = path.join(ROOT, "content", "legal");
export const OUTPUT = path.join(ROOT, "frontend", "lib", "legalDocuments.generated.ts");

// The five reviewed files and how they map onto (document, language).
// `cookies-ro.md` is ONE file holding both languages, split on the `---`
// rule that separates them — the owner delivered it that way and the file is
// not ours to reorganise.
const SOURCES = [
  { doc: "privacy", lang: "ro", file: "privacy-ro.md" },
  { doc: "privacy", lang: "en", file: "privacy-en.md" },
  { doc: "terms", lang: "ro", file: "terms-ro.md" },
  { doc: "terms", lang: "en", file: "terms-en.md" },
  { doc: "cookies", lang: "ro", file: "cookies-ro.md", split: 0 },
  { doc: "cookies", lang: "en", file: "cookies-ro.md", split: 1 },
];

/** Split a bilingual file on a top-level `---` rule that is followed by an H1. */
function sectionOf(raw, index, file) {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const cuts = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*-{3,}\s*$/.test(lines[i])) {
      // A language break is a rule followed (after blanks) by an H1.
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      if (/^#\s+/.test(lines[j] ?? "")) cuts.push(i);
    }
  }
  const bounds = [0, ...cuts.map((c) => c + 1), lines.length];
  const parts = [];
  for (let k = 0; k < bounds.length - 1; k++) {
    const slice = lines.slice(bounds[k], bounds[k + 1]).join("\n").trim();
    if (slice) parts.push(slice);
  }
  if (!parts[index]) {
    throw new Error(`generate_legal_documents: ${file} has no section #${index} (found ${parts.length})`);
  }
  return parts[index];
}

/**
 * The operating entity, read from content/legal/entity.json. Embedded into
 * the generated module so the React app reads it through a normal TS import,
 * and exported here so scripts/prerender_legal.mjs reads the SAME bytes for
 * the static pages. The `_note` key is documentation for a human opening the
 * JSON and is stripped before it reaches either consumer.
 */
export function readEntity() {
  const raw = JSON.parse(fs.readFileSync(path.join(CONTENT, "entity.json"), "utf8"));
  const { _note, ...entity } = raw;
  void _note;
  const required = ["denumire", "cui", "regCom", "sediu", "privacyEmail", "legalEmail"];
  for (const f of required) {
    if (typeof entity[f] !== "string" || !entity[f].trim()) {
      throw new Error(`generate_legal_documents: entity.json is missing ${f}`);
    }
  }
  return entity;
}

export function buildDocuments() {
  const docs = [];
  for (const src of SOURCES) {
    const abs = path.join(CONTENT, src.file);
    const raw = fs.readFileSync(abs, "utf8");
    const fileSha = sha256(raw);
    const section = src.split === undefined ? raw.trim() : sectionOf(raw, src.split, src.file);
    const { html, title, updatedLine } = renderLegalMarkdown(section, src.file);
    const published = parsePublishedDate(updatedLine, src.file);
    docs.push({
      doc: src.doc,
      lang: src.lang,
      sourceFile: `content/legal/${src.file}`,
      title,
      updatedLabel: updatedLine,
      published,
      // The hash of the SECTION is what a version identifier is built from,
      // so a change to the Romanian half of the cookie file does not
      // invalidate acceptances recorded against the English half.
      sha256: sha256(section),
      fileSha256: fileSha,
      // Computed HERE, not only inside emit(): the prerenderer prints this
      // identifier on the page and the consent record stores it, so the two
      // must come from one expression. It was briefly built only during
      // emit(), and the prerendered pages printed the literal "undefined".
      version: `${src.doc}-${src.lang}@${published}+${sha256(section).slice(0, 12)}`,
      description: deriveMetaDescription(html),
      html,
    });
  }
  return docs;
}

const ts = (v) => JSON.stringify(v);

function emit(docs, entity) {
  const entries = docs
    .map(
      (d) => `  "${d.doc}:${d.lang}": {
    doc: "${d.doc}",
    lang: "${d.lang}",
    sourceFile: ${ts(d.sourceFile)},
    title: ${ts(d.title)},
    updatedLabel: ${ts(d.updatedLabel)},
    published: ${ts(d.published)},
    sha256: ${ts(d.sha256)},
    fileSha256: ${ts(d.fileSha256)},
    version: ${ts(d.version)},
    description: ${ts(d.description)},
    html: ${ts(d.html)},
  },`,
    )
    .join("\n");

  return `// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Source:    content/legal/*.md  (the owner's reviewed legal text)
// Generator: scripts/generate_legal_documents.mjs
// Gate:      scripts/check_legal_published.mjs  (reds if this file differs
//            from a fresh regeneration, or if any rendered document carries
//            a bracket, the word "draft", or a placeholder marker)
//
// Every field here is derived from the markdown: the title and the
// "last updated" stamp are lifted out of the document, the publication date
// is parsed from that stamp, the description is the document's own first
// paragraph, and \`sha256\` is over the exact source bytes of this language's
// section. \`version\` is what a user's acceptance is recorded against — see
// frontend/lib/legalConsent.ts — so it must stay reproducible from the file.

export type LegalDocId = "privacy" | "terms" | "cookies";
export type LegalLang = "en" | "ro";

export interface LegalDocument {
  doc: LegalDocId;
  lang: LegalLang;
  /** Path of the reviewed source, relative to the repo root. */
  sourceFile: string;
  /** The document's own H1. */
  title: string;
  /** The document's own "Last updated" line, verbatim. */
  updatedLabel: string;
  /** ISO date parsed from that line. */
  published: string;
  /** sha256 of this language section's source bytes. */
  sha256: string;
  /** sha256 of the whole source file (one file can hold both languages). */
  fileSha256: string;
  /** Stable version identifier recorded with a user's acceptance. */
  version: string;
  /** Meta description — the document's first paragraph, trimmed. */
  description: string;
  /** Rendered body HTML. Title and "last updated" are NOT in here. */
  html: string;
}

/** The operating entity, from content/legal/entity.json. */
export const LEGAL_ENTITY_DATA = ${JSON.stringify(entity, null, 2).split("\n").join("\n")} as const;

export const LEGAL_DOCUMENTS: Record<string, LegalDocument> = {
${entries}
};

export function legalDocument(doc: LegalDocId, lang: LegalLang): LegalDocument {
  const found = LEGAL_DOCUMENTS[\`\${doc}:\${lang}\`];
  if (!found) throw new Error(\`legalDocument: no \${doc} in \${lang}\`);
  return found;
}
`;
}

function main() {
  const docs = buildDocuments();
  const next = emit(docs, readEntity());
  const check = process.argv.includes("--check");
  const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, "utf8") : null;
  if (current === next) {
    if (!check) console.log(`legal documents up to date (${docs.length} renderings)`);
    return 0;
  }
  if (check) {
    console.error(
      "generate_legal_documents: frontend/lib/legalDocuments.generated.ts is STALE.\n" +
        "  Run: node scripts/generate_legal_documents.mjs",
    );
    return 1;
  }
  fs.writeFileSync(OUTPUT, next, "utf8");
  console.log(`wrote ${path.relative(ROOT, OUTPUT)} (${docs.length} renderings)`);
  return 0;
}

/** Regenerate in place; returns true when the file changed. Used by the
 *  Vite plugin so a build can never ship a stale rendering. */
export function regenerate() {
  const next = emit(buildDocuments(), readEntity());
  const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, "utf8") : null;
  if (current === next) return false;
  fs.writeFileSync(OUTPUT, next, "utf8");
  return true;
}

// `pathToFileURL`, not a template string: the repo path contains spaces, and
// `import.meta.url` percent-encodes them while `process.argv[1]` does not —
// a bare comparison makes this script a silent no-op.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
