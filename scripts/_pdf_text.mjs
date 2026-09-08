// READING BACK A CHROMIUM PDF — page geometry and per-page text.
//
// `scripts/check_report_pdf.mjs` has to assert over what the PRODUCED
// FILE says: that page 7 carries the company name, that it numbers
// itself "Page 7 of 31", that a section heading opens it. That means
// extracting text, and extracting text from a Chromium PDF is not
// grepping it.
//
// WHY THE NAIVE VERSION DOES NOT WORK
//   Skia embeds subsetted CID fonts with `/Encoding /Identity-H`, so a
//   text-showing operator carries TWO-BYTE GLYPH INDICES, not
//   characters. `(Page 7 of 31) Tj` does not appear anywhere in the
//   file; what appears is a string of glyph ids that mean nothing
//   without the font's own `/ToUnicode` CMap. A first cut of this gate
//   read those bytes as latin1 and reported the running head missing
//   from all thirty pages — a false RED, which is as bad as a false
//   green because it teaches the next reader to distrust the gate.
//
// WHY NOT A LIBRARY
//   Adding `pdfjs-dist` to the app's `package.json` to satisfy a gate
//   puts a megabyte of parser into the dependency graph of a product
//   that never parses a PDF. This file is ~120 lines and depends on
//   `node:zlib` alone.
//
// WHAT IT HANDLES, AND WHAT IT DOES NOT
//   Handles: uncompressed xref-less scanning of `N 0 obj` bodies, Flate
//   content streams, `/ToUnicode` `bfchar` + `bfrange` CMaps, per-page
//   font resources, `Tf` font switching, `Tj` and `TJ`.
//   Does NOT handle: object streams (`/ObjStm`), encryption, predictors
//   on stream data, or `Tz`/`TJ` kerning as spacing. Skia writes none of
//   those for our documents; if it ever does, `pageTexts()` returns
//   fewer pages than the file has and G0 in the gate reds on exactly
//   that — the extractor failing is a visible failure, not a silent one.

import { inflateSync } from "node:zlib";

function objects(latin) {
  /** @type {Map<number, {dict: string, stream: Buffer|null}>} */
  const map = new Map();
  const re = /(\d+)\s+\d+\s+obj\b/g;
  let m;
  while ((m = re.exec(latin)) !== null) {
    const num = Number(m[1]);
    const start = m.index + m[0].length;
    const end = latin.indexOf("endobj", start);
    if (end < 0) continue;
    const body = latin.slice(start, end);
    const sIdx = body.search(/stream\r?\n/);
    let dict = body;
    let stream = null;
    if (sIdx >= 0) {
      dict = body.slice(0, sIdx);
      const sm = /stream\r?\n/.exec(body.slice(sIdx));
      const from = sIdx + sm[0].length;
      const to = body.indexOf("endstream", from);
      const raw = Buffer.from(body.slice(from, to), "latin1");
      stream = /\/Filter\s*\/FlateDecode/.test(dict) ? tryInflate(raw) : raw;
    }
    map.set(num, { dict, stream });
  }
  return map;
}

function tryInflate(buf) {
  try {
    return inflateSync(buf);
  } catch {
    return null;
  }
}

const ref = (dict, key) => {
  const m = new RegExp(`${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dict);
  return m === null ? null : Number(m[1]);
};

/**
 * One font's `/ToUnicode` CMap: code → string, plus how many bytes a
 * code is (from `codespacerange`; Identity-H is always 2).
 */
function parseCMap(text) {
  const map = new Map();
  const csr = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(text);
  let width = 2;
  if (csr !== null) {
    const first = /<([0-9A-Fa-f]+)>/.exec(csr[1]);
    if (first !== null) width = Math.max(1, first[1].length / 2);
  }
  const hexToStr = (hex) => {
    let out = "";
    for (let i = 0; i + 3 < hex.length + 1; i += 4) {
      out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    }
    return out;
  };
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(parseInt(pair[1], 16), hexToStr(pair[2]));
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const row of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const lo = parseInt(row[1], 16);
      const hi = parseInt(row[2], 16);
      const base = parseInt(row[3], 16);
      for (let c = lo; c <= hi && c - lo < 65536; c += 1) {
        map.set(c, String.fromCharCode(base + (c - lo)));
      }
    }
  }
  return { map, width };
}

/** Page size in millimetres, from the first `/MediaBox`. */
export function mediaBoxMm(bytes) {
  const latin = Buffer.from(bytes).toString("latin1");
  const m = /\/MediaBox\s*\[\s*([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s*\]/.exec(latin);
  if (m === null) return null;
  return {
    w: ((Number(m[3]) - Number(m[1])) / 72) * 25.4,
    h: ((Number(m[4]) - Number(m[2])) / 72) * 25.4,
  };
}

/**
 * The text of each page, in page order.
 *
 * Page order is the `/Kids` array of the page tree, NOT the order
 * `N 0 obj` happens to appear in the file — Skia writes page objects in
 * an order that does not match the document, and reading them as they
 * appear silently shuffles the assertions.
 */
export function pageTexts(bytes) {
  const latin = Buffer.from(bytes).toString("latin1");
  const objs = objects(latin);

  // THE PAGE TREE IS NESTED. Skia writes a root `/Pages` whose Kids are
  // intermediate `/Pages` nodes of eight leaves each. Collecting Kids
  // from every `/Pages` object — the obvious first cut — returns the 31
  // leaves PLUS the 4 intermediate nodes, i.e. 35 "pages", and every
  // per-page assertion then addresses the wrong page.
  let rootNum = null;
  for (const [num, o] of objs) {
    if (/\/Type\s*\/Pages\b/.test(o.dict) && !/\/Parent\s+\d+\s+\d+\s+R/.test(o.dict)) {
      rootNum = num;
      break;
    }
  }
  const pageNums = [];
  const walk = (num, depth) => {
    if (depth > 16) return; // a cycle in a malformed file is not our problem to solve twice
    const node = objs.get(num);
    if (node === undefined) return;
    if (/\/Type\s*\/Page\b(?!s)/.test(node.dict)) {
      pageNums.push(num);
      return;
    }
    const kids = /\/Kids\s*\[([\s\S]*?)\]/.exec(node.dict);
    if (kids === null) return;
    for (const k of kids[1].matchAll(/(\d+)\s+\d+\s+R/g)) walk(Number(k[1]), depth + 1);
  };
  if (rootNum !== null) walk(rootNum, 0);

  const cmapCache = new Map();
  const cmapFor = (fontNum) => {
    if (cmapCache.has(fontNum)) return cmapCache.get(fontNum);
    const font = objs.get(fontNum);
    let parsed = { map: new Map(), width: 1 };
    if (font !== undefined) {
      const tuNum = ref(font.dict, "/ToUnicode");
      const tu = tuNum === null ? null : objs.get(tuNum);
      if (tu?.stream) parsed = parseCMap(tu.stream.toString("latin1"));
    }
    cmapCache.set(fontNum, parsed);
    return parsed;
  };

  const out = [];
  for (const pn of pageNums) {
    const page = objs.get(pn);
    if (page === undefined) continue;

    // name → font object number, for this page
    const fonts = new Map();
    let resDict = page.dict;
    const resRef = ref(page.dict, "/Resources");
    if (resRef !== null && objs.has(resRef)) resDict = objs.get(resRef).dict;
    const fontBlock = /\/Font\s*<<([\s\S]*?)>>/.exec(resDict);
    if (fontBlock !== null) {
      for (const f of fontBlock[1].matchAll(/\/(\w+)\s+(\d+)\s+\d+\s+R/g)) {
        fonts.set(f[1], Number(f[2]));
      }
    }

    const cNum = ref(page.dict, "/Contents");
    const content = cNum === null ? null : objs.get(cNum)?.stream ?? null;
    if (content === null) {
      out.push("");
      continue;
    }
    const body = content.toString("latin1");

    let current = { map: new Map(), width: 1 };
    let text = "";
    // One pass over the operators that matter: `Tf` switches the font,
    // `Tj`/`TJ` show a string, `Td`/`TD`/`T*`/`ET` end a line.
    // Skia shows text as HEX strings — `<37> Tj`, `[<0048><0065>] TJ` —
    // not as `(…)` literals. A first cut of this file only matched the
    // literal form, found nothing, and reported the running head absent
    // from every page: a false RED.
    const opRe =
      /\/(\w+)\s+[-\d.]+\s+Tf|<([0-9A-Fa-f\s]*)>\s*Tj|\[([^\]]*)\]\s*TJ|\(((?:[^()\\]|\\.)*)\)\s*Tj|\bET\b/g;
    let m;
    while ((m = opRe.exec(body)) !== null) {
      if (m[1] !== undefined) {
        const num = fonts.get(m[1]);
        current = num === undefined ? { map: new Map(), width: 1 } : cmapFor(num);
        continue;
      }
      if (m[2] !== undefined) {
        text += decodeHex(m[2], current);
        continue;
      }
      if (m[3] !== undefined) {
        for (const h of m[3].matchAll(/<([0-9A-Fa-f\s]*)>/g)) text += decodeHex(h[1], current);
        for (const l of m[3].matchAll(/\(((?:[^()\\]|\\.)*)\)/g)) text += decodeLiteral(l[1], current);
        continue;
      }
      if (m[4] !== undefined) {
        text += decodeLiteral(m[4], current);
        continue;
      }
      // `ET` — end of a text object. `Td`/`TD` are NOT line breaks here:
      // Skia positions EVERY GLYPH with its own `Td`, so treating them
      // as breaks produced "C O M P R E H E N S I V E" — one character
      // per line, and every `includes("Page 7 of 31")` assertion false.
      text += "\n";
    }
    out.push(text);
  }
  return out;
}

/** Codes → text, given the font's own `/ToUnicode` map. A code the CMap
 *  does not carry yields NOTHING rather than a guessed character: an
 *  invented glyph in a gate's evidence is worse than a short string. */
function codes(list, { map }) {
  let out = "";
  for (const code of list) out += map.get(code) ?? "";
  return out;
}

function decodeHex(hex, font) {
  const clean = hex.replace(/\s+/g, "");
  const w = font.width * 2;
  const list = [];
  for (let i = 0; i + w <= clean.length; i += w) list.push(parseInt(clean.slice(i, i + w), 16));
  return codes(list, font);
}

function decodeLiteral(escaped, font) {
  const raw = escaped
    .replace(/\\(\d{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
    .replace(/\\([()\\nrt])/g, (_, c) =>
      c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c);
  const list = [];
  if (font.width === 1) {
    for (let i = 0; i < raw.length; i += 1) list.push(raw.charCodeAt(i));
  } else {
    for (let i = 0; i + 1 < raw.length; i += 2) {
      list.push((raw.charCodeAt(i) << 8) | raw.charCodeAt(i + 1));
    }
  }
  return codes(list, font);
}
