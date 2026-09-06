// legal_markdown — the ONE renderer that turns `content/legal/*.md` into the
// HTML every legal surface ships.
//
// WHY A HAND-WRITTEN RENDERER AND NOT A LIBRARY
// =============================================
// Three reasons, in order of weight:
//
//  1. DETERMINISM. The published bytes of a legal document are hashed and a
//     user's acceptance is recorded against that hash (see
//     `frontend/lib/legalConsent.ts`). A renderer whose output can shift with
//     a patch release of a markdown library would silently invalidate every
//     recorded acceptance. This file has no dependencies at all — same bytes
//     in, same bytes out, forever.
//
//  2. NO ESCAPE HATCH. A general markdown renderer passes raw HTML through.
//     These documents are reviewed prose; the renderer must not be able to
//     turn a typo into markup, and must escape `&<>"` unconditionally.
//
//  3. THE SUBSET IS TINY AND CLOSED. The five reviewed files use exactly:
//     `#`/`##`/`###` headings, `**bold**`, `- ` bullets, GFM pipe tables,
//     `[text](url)` links, `---` horizontal rules, and paragraphs. Anything
//     outside that set is a CHANGE to a reviewed document, and this renderer
//     THROWS on it rather than guessing — see `assertKnownConstructs`.
//     Silently degrading an unrecognised construct is how a legal document
//     ends up published with a literal `*` in the middle of a sentence.
//
// The output is deliberately plain: semantic tags with a single wrapper
// class, no inline styles. Each surface styles `.legal-doc` in its own
// design language (the app uses Tailwind tokens, the marketing site its own
// scoped palette), so one rendering serves both without either owning the
// other's colours.

import crypto from "node:crypto";

/** Escape the four characters that can change the meaning of the markup.
 *  Applied to every text node BEFORE any inline pattern runs. */
export function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Inline markup: `**bold**` then `[text](url)`.
 *
 * Order matters — links are resolved AFTER bold so that a bold label inside a
 * link (`[**x**](y)`) still works, and the href is written from the raw
 * captured URL rather than from already-escaped text.
 */
function renderInline(raw) {
  let out = escapeHtml(raw);
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, inner) => `<strong>${inner}</strong>`);
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text, href) => {
    // Only same-origin paths and mailto: are permitted. An absolute
    // http(s) URL in a reviewed document would be a link off the platform,
    // which is a content decision, not a rendering one — so it throws.
    if (!/^(\/|mailto:)/.test(href)) {
      throw new Error(`legal_markdown: unsupported link target ${JSON.stringify(href)}`);
    }
    return `<a href="${escapeHtml(href)}">${text}</a>`;
  });
  return out;
}

/**
 * Fail closed on anything outside the closed subset. Called on every source
 * line before parsing. The point is that an edit to a reviewed document
 * cannot introduce a construct this renderer would quietly mangle.
 */
function assertKnownConstructs(line, file, lineNo) {
  const bad = [
    [/`/, "backtick / code span"],
    [/^\s{0,3}[*+]\s/, "`*` or `+` bullet (use `- `)"],
    [/^\s{0,3}\d+\.\s/, "ordered list"],
    [/^\s{0,3}>/, "blockquote"],
    [/^\s{4,}\S/, "indented code block"],
    [/<[a-zA-Z/!]/, "raw HTML"],
    [/!\[/, "image"],
  ];
  for (const [re, what] of bad) {
    if (re.test(line)) {
      throw new Error(`legal_markdown: ${file}:${lineNo} uses an unsupported construct (${what}): ${line}`);
    }
  }
  // An unmatched `**` would render a literal asterisk into a legal sentence.
  const stars = (line.match(/\*\*/g) || []).length;
  if (stars % 2 !== 0) {
    throw new Error(`legal_markdown: ${file}:${lineNo} has an unbalanced ** run: ${line}`);
  }
}

function splitRow(line) {
  // `| a | b |` → ["a", "b"]. Leading/trailing pipes are structural.
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

const isDelimiterRow = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

/**
 * Markdown → HTML for the closed subset above.
 * Returns `{ html, title, updatedLine }`; the `# ` heading and a leading
 * `**Last updated: …**` line are LIFTED OUT of the body so the page chrome
 * can render them once, in its own type scale, instead of the document
 * carrying two competing titles.
 */
export function renderLegalMarkdown(source, file = "<memory>") {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let title = null;
  let updatedLine = null;
  let i = 0;
  let paragraph = [];
  let listItems = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    // SOFT LINE BREAKS ARE PRESERVED, deliberately. Standard markdown
    // collapses a hard-wrapped paragraph into one line; every multi-line
    // block in these five reviewed documents is an ADDRESS — the registered
    // office in Privacy §1 / Terms §1, and the entity footer at the end of
    // Terms — where the line structure is the formatting the author wrote.
    // Collapsing them would run "Registered office: … Company registration
    // number (CUI): 45298544 Trade Register number: …" into one sentence.
    // Measured: those are the ONLY multi-line paragraphs in the set, so this
    // rule changes nothing else. No word is altered either way.
    const paragraphLines = paragraph;
    const text = paragraph.join(" ");
    paragraph = [];
    // The "last updated" stamp is metadata, not a clause. Lift the first one.
    const stamp =
      paragraphLines.length === 1
        ? /^\*\*((?:Last updated|Ultima actualizare):[^*]+)\*\*$/.exec(text)
        : null;
    if (stamp && updatedLine === null && out.length === 0) {
      updatedLine = stamp[1].trim();
      return;
    }
    out.push(`<p>${paragraphLines.map(renderInline).join("<br />")}</p>`);
  };
  const flushList = () => {
    if (!listItems) return;
    out.push(`<ul>${listItems.map((it) => `<li>${renderInline(it)}</li>`).join("")}</ul>`);
    listItems = null;
  };

  for (; i < lines.length; i++) {
    const line = lines[i];
    assertKnownConstructs(line, file, i + 1);

    if (line.trim() === "") {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      const text = heading[2].trim();
      if (level === 1) {
        if (title !== null) {
          throw new Error(`legal_markdown: ${file}:${i + 1} second H1 in one document — split it first`);
        }
        title = text;
        continue; // the page chrome renders the title
      }
      out.push(`<h${level}>${renderInline(text)}</h${level}>`);
      continue;
    }

    if (/^\s*-{3,}\s*$/.test(line)) {
      flushParagraph();
      flushList();
      out.push("<hr />");
      continue;
    }

    if (/^\s*-\s+/.test(line)) {
      flushParagraph();
      if (!listItems) listItems = [];
      listItems.push(line.replace(/^\s*-\s+/, ""));
      continue;
    }

    if (line.trim().startsWith("|")) {
      flushParagraph();
      flushList();
      const header = splitRow(line);
      if (!isDelimiterRow(lines[i + 1] ?? "")) {
        throw new Error(`legal_markdown: ${file}:${i + 1} table header is not followed by a delimiter row`);
      }
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        assertKnownConstructs(lines[i], file, i + 1);
        body.push(splitRow(lines[i]));
        i++;
      }
      i--; // the outer loop increments
      const thead = `<thead><tr>${header.map((c) => `<th>${renderInline(c)}</th>`).join("")}</tr></thead>`;
      const tbody = `<tbody>${body
        .map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`)
        .join("")}</tbody>`;
      // The wrapper is what makes a wide table scroll on a phone instead of
      // pushing the whole document sideways.
      out.push(`<div class="legal-table"><table>${thead}${tbody}</table></div>`);
      continue;
    }

    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();

  if (!title) throw new Error(`legal_markdown: ${file} has no H1 title`);
  return { html: out.join("\n"), title, updatedLine };
}

// ── Publication date ───────────────────────────────────────────────────
// The date is READ from the reviewed text, never typed here: the document
// says when it was published and that is the only authority.

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  ianuarie: 1, februarie: 2, martie: 3, aprilie: 4, mai: 5, iunie: 6,
  // Romanian month names; `august` and `mai` collide harmlessly with the
  // English entries above because both languages agree on the number.
  iulie: 7, septembrie: 9, octombrie: 10, noiembrie: 11, decembrie: 12,
};

/** "Last updated: 6 September 2026" / "Ultima actualizare: 6 septembrie 2026" → "2026-09-06". */
export function parsePublishedDate(updatedLine, file = "<memory>") {
  const m = /(\d{1,2})\s+([A-Za-zăâîșțĂÂÎȘȚ]+)\s+(\d{4})/.exec(updatedLine ?? "");
  if (!m) throw new Error(`legal_markdown: ${file} — cannot read a publication date from ${JSON.stringify(updatedLine)}`);
  const month = MONTHS[m[2].toLowerCase()];
  if (!month) throw new Error(`legal_markdown: ${file} — unknown month name ${JSON.stringify(m[2])}`);
  return `${m[3]}-${String(month).padStart(2, "0")}-${String(Number(m[1])).padStart(2, "0")}`;
}

/** sha256 of exactly these bytes, hex. */
export function sha256(text) {
  return crypto.createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/**
 * Meta description, DERIVED from the reviewed text — the first paragraph of
 * the document, tag-stripped and cut on a word boundary. Writing one by hand
 * would be a sixth piece of prose about the documents that nobody reviewed.
 */
export function deriveMetaDescription(html, limit = 165) {
  const firstP = /<p>([\s\S]*?)<\/p>/.exec(html);
  if (!firstP) throw new Error("legal_markdown: document has no paragraph to derive a description from");
  const text = firstP[1]
    // A soft break is a space in a one-line description, not a join with no
    // gap — otherwise an address block reads "…RomaniaCompany registration…".
    .replace(/<br\s*\/?>/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > 0 ? lastSpace : limit).replace(/[.,;:]$/, "")}…`;
}
