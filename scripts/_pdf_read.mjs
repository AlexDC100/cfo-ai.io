// READING A CHROMIUM PDF BACK — pages, their text, and where the ink is.
//
// `scripts/check_report_print.mjs` asserts over the PRODUCED FILE: that
// page 17 is not eight inches of white, that the printed contents page
// carries no leader ending in nothing. That means opening the bytes, and
// a Chromium PDF does not open by grepping.
//
// ── WHY IT IS NOT A LIBRARY ───────────────────────────────────────────
// Putting `pdfjs-dist` into the app's dependency graph to satisfy a gate
// adds a megabyte of parser to a product that never parses a PDF. This
// file depends on `node:zlib` alone.
//
// ── THE TWO TRAPS ─────────────────────────────────────────────────────
//   1. Skia embeds subsetted CID fonts with `/Encoding /Identity-H`, so a
//      text-showing operator carries TWO-BYTE GLYPH INDICES, not
//      characters. `(Page 7 of 31) Tj` appears nowhere in the file. The
//      glyph ids mean nothing without the font's own `/ToUnicode` CMap.
//   2. The page tree is NESTED — a root `/Pages` whose kids are
//      intermediate `/Pages` nodes. Collecting kids from every `/Pages`
//      object returns the leaves PLUS the intermediate nodes, and every
//      per-page assertion then addresses the wrong page.
//
// ── WHAT `inkRows` DOES THAT TEXT EXTRACTION CANNOT ───────────────────
// Trailing whitespace is not a text question: a page can end with a rule,
// a chart, or a table border. So `inkRows` interprets the content stream
// — the CTM stack, the text matrix, the fill and stroke colours — and
// returns the y of every mark that is NOT white. Grepping numbers out of
// the stream does not work: the coordinates are relative to a `cm` that
// scales by 3.125 inside a base transform that flips the page, so a raw
// number is in none of the spaces the answer is wanted in.
//
// WHAT IT DOES NOT HANDLE: object streams (`/ObjStm`), encryption,
// stream predictors, `Tz`, `TJ` kerning as spacing, or a clipping path
// (an off-page mark inside a clip is still counted as ink). Skia writes
// none of the first five for our documents; the sixth would understate
// whitespace, i.e. fail safe. If any of it appears, `pageTexts()` returns
// fewer pages than the file has, which the caller's own page-count check
// reds on — a visible failure, not a silent one.

import { inflateSync } from "node:zlib";

// ── object graph ──────────────────────────────────────────────────────

function objects(latin) {
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
      if (/\/Filter\s*\/FlateDecode/.test(dict)) {
        try {
          stream = inflateSync(raw);
        } catch {
          stream = null;
        }
      } else {
        stream = raw;
      }
    }
    map.set(num, { dict, stream });
  }
  return map;
}

const refOf = (dict, key) => {
  const m = new RegExp(`${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dict);
  return m === null ? null : Number(m[1]);
};

function pageObjects(objs) {
  let root = null;
  for (const [num, o] of objs) {
    if (/\/Type\s*\/Pages\b/.test(o.dict) && !/\/Parent\s+\d+\s+\d+\s+R/.test(o.dict)) {
      root = num;
      break;
    }
  }
  const out = [];
  const walk = (num, depth) => {
    if (depth > 16) return; // a cycle in a malformed file is not ours to solve twice
    const node = objs.get(num);
    if (node === undefined) return;
    if (/\/Type\s*\/Page\b(?!s)/.test(node.dict)) {
      out.push(num);
      return;
    }
    const kids = /\/Kids\s*\[([\s\S]*?)\]/.exec(node.dict);
    if (kids === null) return;
    for (const k of kids[1].matchAll(/(\d+)\s+\d+\s+R/g)) walk(Number(k[1]), depth + 1);
  };
  if (root !== null) walk(root, 0);
  return out;
}

function contentOf(objs, pageDict) {
  const direct = refOf(pageDict, "/Contents");
  if (direct !== null) {
    const o = objs.get(direct);
    return o?.stream === null || o?.stream === undefined ? "" : o.stream.toString("latin1");
  }
  const arr = /\/Contents\s*\[([\s\S]*?)\]/.exec(pageDict);
  if (arr === null) return "";
  return [...arr[1].matchAll(/(\d+)\s+\d+\s+R/g)]
    .map((m) => objs.get(Number(m[1]))?.stream?.toString("latin1") ?? "")
    .join("\n");
}

// ── text ──────────────────────────────────────────────────────────────

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
    for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
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
      for (let c = lo; c <= hi && c - lo < 65536; c += 1) map.set(c, String.fromCharCode(base + (c - lo)));
    }
  }
  return { map, width };
}

function fontsOf(objs, pageDict) {
  const out = new Map();
  const resNum = refOf(pageDict, "/Resources");
  const res = resNum === null ? pageDict : (objs.get(resNum)?.dict ?? "");
  const fontNum = refOf(res, "/Font");
  const fontDict = fontNum === null ? res : (objs.get(fontNum)?.dict ?? "");
  for (const m of fontDict.matchAll(/\/(F\d+)\s+(\d+)\s+\d+\s+R/g)) {
    const f = objs.get(Number(m[2]));
    if (f === undefined) continue;
    const tu = refOf(f.dict, "/ToUnicode");
    if (tu === null) continue;
    const cmapStream = objs.get(tu)?.stream;
    if (!cmapStream) continue;
    out.set(m[1], parseCMap(cmapStream.toString("latin1")));
  }
  return out;
}

function decodeShow(arg, cmap) {
  // `<hex>` strings only — Skia writes Identity-H, so a literal
  // `(string)` never carries text in these documents.
  let out = "";
  for (const m of arg.matchAll(/<([0-9A-Fa-f]*)>/g)) {
    const hex = m[1];
    const step = (cmap?.width ?? 2) * 2;
    for (let i = 0; i + step <= hex.length; i += step) {
      const code = parseInt(hex.slice(i, i + step), 16);
      out += cmap?.map.get(code) ?? "";
    }
  }
  return out;
}

/**
 * The text of each page, in page-tree order.
 *
 * Driven off the SAME token scan `inkRows` uses. A regex that tries to
 * capture "the operands in front of a `Tj`" in one alternation
 * backtracks catastrophically on a 200 KB content stream — measured:
 * it did not finish in two minutes on page 1. One linear pass over
 * tokens cannot.
 */
export function pageTexts(bytes) {
  const latin = Buffer.from(bytes).toString("latin1");
  const objs = objects(latin);
  return pageObjects(objs).map((pn) => {
    const p = objs.get(pn);
    const fonts = fontsOf(objs, p.dict);
    const toks = contentOf(objs, p.dict).match(/\/[^\s/[\]<>()]+|<[^>]*>|\[[^\]]*\]|\([^)]*\)|\S+/g) ?? [];
    let cur = null;
    let out = "";
    let pending = [];
    for (const t of toks) {
      if (t === "Tf") {
        // `/F20 10 Tf` — the font name is two tokens back.
        const name = pending.find((v) => /^\/F\d+$/.test(v));
        cur = name === undefined ? cur : (fonts.get(name.slice(1)) ?? null);
        pending = [];
      } else if (t === "Tj" || t === "TJ") {
        out += decodeShow(pending.join(" "), cur);
        pending = [];
      } else if (t === "Tm" || t === "ET") {
        // A NEW ABSOLUTE POSITION ENDS A RUN — and `Td` does NOT.
        // Skia writes one `Tj` PER GLYPH with a `Td` advance between
        // them, so breaking on `Td` puts a separator between every pair
        // of letters and "IMPORTED PERIOD" comes back as
        // "I M P O R T E D  P E R I O D", which matches no assertion
        // anyone would write.
        out += "\n";
        pending = [];
      } else {
        pending.push(t);
      }
      if (pending.length > 64) pending = pending.slice(-16);
    }
    return out;
  });
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

// ── ink ───────────────────────────────────────────────────────────────

const IDENTITY = [1, 0, 0, 1, 0, 0];
const mul = (M, N) => [
  M[0] * N[0] + M[1] * N[2],
  M[0] * N[1] + M[1] * N[3],
  M[2] * N[0] + M[3] * N[2],
  M[2] * N[1] + M[3] * N[3],
  M[4] * N[0] + M[5] * N[2] + N[4],
  M[4] * N[1] + M[5] * N[3] + N[5],
];
const applyY = (M, x, y) => M[1] * x + M[3] * y + M[5];

/**
 * The y (in PDF points, from the bottom of the page) of every non-white
 * mark on each page.
 *
 * White is excluded on purpose: Chromium paints a full-page white
 * rectangle under every page, and counting it would report every page as
 * full to the bottom margin — which is how a whitespace gate passes on a
 * blank page.
 */
export function inkRows(bytes) {
  const latin = Buffer.from(bytes).toString("latin1");
  const objs = objects(latin);
  return pageObjects(objs).map((pn) => {
    const src = contentOf(objs, objs.get(pn).dict);
    const toks = src.match(/\/[^\s/[\]<>()]+|<[^>]*>|\[[^\]]*\]|\([^)]*\)|\S+/g) ?? [];
    let ctm = IDENTITY.slice();
    const stack = [];
    let tm = IDENTITY.slice();
    let tlm = IDENTITY.slice();
    let fill = [0, 0, 0];
    let stroke = [0, 0, 0];
    const args = [];
    const rects = [];
    const pts = [];
    const ys = [];
    const isWhite = (c) => c[0] > 0.985 && c[1] > 0.985 && c[2] > 0.985;
    const at = (i) => Number(args[args.length + i]);
    const emit = (x, y, white) => {
      if (white) return;
      ys.push(applyY(ctm, x, y));
    };
    const paint = (white) => {
      for (const [x, y, , h] of rects) {
        emit(x, y, white);
        emit(x, y + h, white);
      }
      for (const [x, y] of pts) emit(x, y, white);
      rects.length = 0;
      pts.length = 0;
    };
    for (const t of toks) {
      if (/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(t)) {
        args.push(t);
        continue;
      }
      switch (t) {
        case "q": stack.push(ctm.slice()); break;
        case "Q": ctm = stack.pop() ?? IDENTITY.slice(); break;
        case "cm": ctm = mul([at(-6), at(-5), at(-4), at(-3), at(-2), at(-1)], ctm); break;
        case "rg": fill = [at(-3), at(-2), at(-1)]; break;
        case "RG": stroke = [at(-3), at(-2), at(-1)]; break;
        case "g": fill = [at(-1), at(-1), at(-1)]; break;
        case "G": stroke = [at(-1), at(-1), at(-1)]; break;
        case "BT": tm = IDENTITY.slice(); tlm = IDENTITY.slice(); break;
        case "Tm": tm = [at(-6), at(-5), at(-4), at(-3), at(-2), at(-1)]; tlm = tm.slice(); break;
        case "Td": case "TD": tlm = mul([1, 0, 0, 1, at(-2), at(-1)], tlm); tm = tlm.slice(); break;
        case "Tj": case "TJ": if (!isWhite(fill)) ys.push(applyY(mul(tm, ctm), 0, 0)); break;
        case "re": rects.push([at(-4), at(-3), at(-2), at(-1)]); break;
        case "m": case "l": pts.push([at(-2), at(-1)]); break;
        case "f": case "f*": case "F": case "b": case "b*": case "B": case "B*": paint(isWhite(fill)); break;
        case "S": case "s": paint(isWhite(stroke)); break;
        case "n": rects.length = 0; pts.length = 0; break;
        default: break;
      }
      args.length = 0;
    }
    return ys;
  });
}
