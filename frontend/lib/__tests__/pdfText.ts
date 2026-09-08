// READING A RENDERED PDF BACK — the text layer, out of the actual bytes.
//
// ── WHY THIS EXISTS AND WHY IT HAS NO DEPENDENCY ──────────────────────
//
// The three-way parity gate (`threeWayParity.test.ts`) compares the PDF
// the recipient opens against the HTML and the workbook. To do that it
// has to read the PDF the same way a reader's PDF viewer does — from the
// printed bytes, not from the DOM that was fed to the printer. Asserting
// over the input HTML would prove nothing about the artefact: pagination,
// a `@media print` rule that hides a block, a font that fails to embed —
// every one of those is invisible upstream of the render.
//
// Nothing in this repo could read a PDF. `package.json` has no pdfjs, no
// pdf-parse, no unpdf; the machine has no `pdftotext`, no `mutool`, no
// `qpdf`. Rather than add a dependency to a shipping product for a test,
// this reads the format directly with `node:zlib`, which is a builtin.
// It is a TEST HELPER — it lives under `__tests__/`, is never imported by
// product code, and never reaches the bundle.
//
// ── WHAT IT IMPLEMENTS, AND WHAT IT DELIBERATELY DOES NOT ─────────────
//
// Measured against the artefact it has to read (Chromium/Skia `page.pdf()`
// output, `%PDF-1.4`): a classic cross-reference TABLE (zero `/ObjStm`,
// so no compressed object streams), every stream `/Filter /FlateDecode`
// (zero other filters), fonts `/Type0` + `/Encoding /Identity-H` with a
// `/ToUnicode` CMap, plus `/Type3` glyph fonts. So this implements:
//
//   · the xref table (with `/Prev` chains) and, if that is malformed, a
//     brute `N G obj` scan — but never silently: `structure` reports which
//     path was taken and how many objects it found.
//   · FlateDecode via `node:zlib.inflateSync`, with a raw-deflate retry.
//   · the page tree in document order, `/Contents` (single or array).
//   · the text operators `BT ET Tf Td TD Tm T* TL Tj TJ ' "` and the
//     graphics operators `q Q cm` that place them.
//   · `/ToUnicode` CMaps: `beginbfchar` and `beginbfrange`, both the
//     `<lo> <hi> <dst>` and the `<lo> <hi> [ ... ]` forms, with the code
//     width taken from `begincodespacerange`.
//
// NOT implemented, because the artefact does not use them: object
// streams, encryption, LZW/ASCII85/RunLength/CCITT filters, Type1 glyph
// name → Unicode heuristics. Each of those raises rather than returning
// half a document — a text extractor that quietly returns less is exactly
// the shape that makes a gate go green over an empty set.
//
// ── HOW LINES ARE ASSEMBLED, AND WHY THAT IS THE HARD PART ────────────
//
// A PDF has no lines. It has show-text operations at positions — and
// Skia positions EVERY GLYPH INDIVIDUALLY. Measured on the agras render:
// 48,964 show operations across 32 pages, one per glyph. So "a run is an
// atomic figure" is false here and a gate written on that assumption
// would compare an empty set to an empty set.
//
// What is true, measured: Skia emits real space GLYPHS inside a text
// block (`231.1 F`, `236.6 i`, … `268.2 " "`, `270.4 A`). So glyphs on
// one baseline concatenate with NO separator, and a separator is needed
// only where two independent blocks share a baseline — a row label at
// x=50 and its figure at x=400. That gap is recognised geometrically:
// a glyph advance is at most about one em, so a gap wider than 1.05 ×
// the effective font size (`Tfs` scaled by the text matrix, tracked per
// run) is a real separation and becomes one space.
//
// The result is cross-checked, not asserted: `threeWayParity.test.ts`
// compares this reader's figure set against PyMuPDF's on the same bytes
// and the transcript of that comparison is in the gate's header. A text
// extractor that quietly returns less than the document contains is the
// exact shape that makes a parity gate go green over nothing.

import { inflateSync, inflateRawSync } from "node:zlib";

// ── low-level: bytes as a byte-preserving string ──────────────────────

function latin1(bytes: Uint8Array): string {
  let out = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return out;
}

const WS = new Set([" ", "\t", "\r", "\n", "\f", "\0"]);
const DELIM = new Set(["(", ")", "<", ">", "[", "]", "{", "}", "/", "%"]);

// ── a minimal PDF object model ────────────────────────────────────────

export interface PdfRef {
  readonly ref: number;
  readonly gen: number;
}
export interface PdfName {
  readonly name: string;
}
export type PdfDict = Map<string, PdfValue>;
export type PdfValue =
  | number
  | string
  | boolean
  | null
  | PdfName
  | PdfRef
  | PdfValue[]
  | PdfDict;

function isRef(v: PdfValue): v is PdfRef {
  return typeof v === "object" && v !== null && "ref" in (v as object);
}
function isName(v: PdfValue): v is PdfName {
  return typeof v === "object" && v !== null && "name" in (v as object);
}
function isDict(v: PdfValue): v is PdfDict {
  return v instanceof Map;
}

/** Recursive-descent parser for one PDF object, over the latin1 view. */
class ObjParser {
  constructor(
    readonly src: string,
    public pos: number,
  ) {}

  skip(): void {
    for (;;) {
      while (this.pos < this.src.length && WS.has(this.src[this.pos])) this.pos += 1;
      if (this.src[this.pos] === "%") {
        while (this.pos < this.src.length && this.src[this.pos] !== "\n" && this.src[this.pos] !== "\r") {
          this.pos += 1;
        }
        continue;
      }
      return;
    }
  }

  token(): string {
    this.skip();
    const start = this.pos;
    while (this.pos < this.src.length && !WS.has(this.src[this.pos]) && !DELIM.has(this.src[this.pos])) {
      this.pos += 1;
    }
    return this.src.slice(start, this.pos);
  }

  value(): PdfValue {
    this.skip();
    const c = this.src[this.pos];
    if (c === undefined) throw new Error("pdf: unexpected end of object");
    if (c === "/") {
      this.pos += 1;
      const raw = this.token();
      return { name: raw.replace(/#([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16))) };
    }
    if (c === "(") return this.literalString();
    if (c === "<") {
      if (this.src[this.pos + 1] === "<") return this.dict();
      return this.hexString();
    }
    if (c === "[") {
      this.pos += 1;
      const arr: PdfValue[] = [];
      for (;;) {
        this.skip();
        if (this.src[this.pos] === "]") {
          this.pos += 1;
          return arr;
        }
        arr.push(this.value());
      }
    }
    if (c === "]" || c === ">" || c === "}") throw new Error(`pdf: stray ${c}`);
    // number / keyword / indirect reference
    const save = this.pos;
    const tok = this.token();
    if (tok === "true") return true;
    if (tok === "false") return false;
    if (tok === "null") return null;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) {
      // "12 0 R" is an indirect reference; "12 0" alone is two numbers.
      if (/^\d+$/.test(tok)) {
        const after = this.pos;
        this.skip();
        const genStart = this.pos;
        const gen = this.token();
        if (/^\d+$/.test(gen)) {
          this.skip();
          if (this.src[this.pos] === "R" && !/[A-Za-z0-9]/.test(this.src[this.pos + 1] ?? " ")) {
            this.pos += 1;
            return { ref: Number(tok), gen: Number(gen) };
          }
        }
        this.pos = genStart === after ? after : after;
      }
      return Number(tok);
    }
    if (tok === "") {
      this.pos = save + 1;
      return null;
    }
    return { name: tok }; // bare keyword — treated as a name-ish token
  }

  dict(): PdfDict {
    this.pos += 2; // <<
    const d: PdfDict = new Map();
    for (;;) {
      this.skip();
      if (this.src[this.pos] === ">" && this.src[this.pos + 1] === ">") {
        this.pos += 2;
        return d;
      }
      const key = this.value();
      if (!isName(key)) throw new Error("pdf: dict key is not a name");
      d.set(key.name, this.value());
    }
  }

  literalString(): string {
    this.pos += 1;
    let depth = 1;
    let out = "";
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos++];
      if (ch === "\\") {
        const n = this.src[this.pos++];
        const simple: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
        if (simple[n] !== undefined) out += simple[n];
        else if (n >= "0" && n <= "7") {
          let oct = n;
          while (oct.length < 3 && this.src[this.pos] >= "0" && this.src[this.pos] <= "7") {
            oct += this.src[this.pos++];
          }
          out += String.fromCharCode(parseInt(oct, 8));
        } else if (n === "\n") {
          /* line continuation */
        } else out += n;
        continue;
      }
      if (ch === "(") depth += 1;
      if (ch === ")") {
        depth -= 1;
        if (depth === 0) return out;
      }
      out += ch;
    }
    throw new Error("pdf: unterminated literal string");
  }

  hexString(): string {
    this.pos += 1;
    let hex = "";
    while (this.pos < this.src.length && this.src[this.pos] !== ">") {
      const ch = this.src[this.pos++];
      if (/[0-9A-Fa-f]/.test(ch)) hex += ch;
    }
    this.pos += 1;
    if (hex.length % 2 === 1) hex += "0";
    let out = "";
    for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    return out;
  }
}

// ── the document ──────────────────────────────────────────────────────

export interface PdfStructure {
  /** "xref-table" when the trailer's table parsed, "scan" when it did not. */
  readonly indexSource: "xref-table" | "scan";
  readonly objectCount: number;
  readonly pageCount: number;
  readonly fontsWithToUnicode: number;
  readonly fontsWithoutToUnicode: number;
}

class PdfDoc {
  readonly src: string;
  readonly offsets = new Map<number, number>();
  readonly cache = new Map<number, PdfValue>();
  trailer: PdfDict = new Map();
  indexSource: "xref-table" | "scan" = "xref-table";

  constructor(readonly bytes: Uint8Array) {
    this.src = latin1(bytes);
    try {
      this.readXref();
      if (this.offsets.size === 0) throw new Error("pdf: xref table is empty");
      if (!this.trailer.has("Root")) throw new Error("pdf: trailer has no /Root");
    } catch {
      this.offsets.clear();
      this.scanObjects();
      this.indexSource = "scan";
      const t = this.src.lastIndexOf("trailer");
      if (t >= 0) {
        const p = new ObjParser(this.src, t + "trailer".length);
        const d = p.value();
        if (isDict(d)) this.trailer = d;
      }
      if (!this.trailer.has("Root")) {
        // last resort: find the /Catalog object
        for (const [num] of this.offsets) {
          const o = this.obj(num);
          if (isDict(o) && isName(o.get("Type") as PdfValue) && (o.get("Type") as PdfName).name === "Catalog") {
            this.trailer.set("Root", { ref: num, gen: 0 });
            break;
          }
        }
      }
    }
  }

  private readXref(): void {
    const tail = this.src.slice(-2048);
    const m = /startxref\s+(\d+)\s*%%EOF\s*$/.exec(tail.replace(/\s+$/, "") + "\n");
    const start = m ? Number(m[1]) : NaN;
    if (!Number.isFinite(start)) throw new Error("pdf: no startxref");
    const seen = new Set<number>();
    let at: number | null = start;
    while (at !== null && !seen.has(at)) {
      seen.add(at);
      at = this.readXrefSection(at);
    }
  }

  private readXrefSection(offset: number): number | null {
    const p = new ObjParser(this.src, offset);
    p.skip();
    if (this.src.startsWith("xref", p.pos)) {
      p.pos += 4;
      for (;;) {
        p.skip();
        if (this.src.startsWith("trailer", p.pos)) {
          p.pos += "trailer".length;
          const t = p.value();
          if (!isDict(t)) throw new Error("pdf: trailer is not a dict");
          for (const [k, v] of t) if (!this.trailer.has(k)) this.trailer.set(k, v);
          const prev = t.get("Prev");
          return typeof prev === "number" ? prev : null;
        }
        const first = Number(p.token());
        const count = Number(p.token());
        if (!Number.isFinite(first) || !Number.isFinite(count)) {
          throw new Error("pdf: malformed xref subsection header");
        }
        for (let i = 0; i < count; i += 1) {
          p.skip();
          const entry = this.src.slice(p.pos, p.pos + 20);
          const em = /^(\d{10})\s(\d{5})\s([nf])/.exec(entry);
          if (!em) throw new Error("pdf: malformed xref entry");
          p.pos += em[0].length;
          if (em[3] === "n" && !this.offsets.has(first + i)) {
            this.offsets.set(first + i, Number(em[1]));
          }
        }
      }
    }
    throw new Error("pdf: cross-reference stream (/ObjStm) is not supported by this reader");
  }

  private scanObjects(): void {
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.src)) !== null) this.offsets.set(Number(m[1]), m.index);
  }

  obj(num: number): PdfValue {
    if (this.cache.has(num)) return this.cache.get(num) as PdfValue;
    const off = this.offsets.get(num);
    if (off === undefined) return null;
    const p = new ObjParser(this.src, off);
    p.token(); // object number
    p.token(); // generation
    const kw = p.token(); // "obj"
    if (kw !== "obj") {
      this.cache.set(num, null);
      return null;
    }
    const value = p.value();
    if (isDict(value)) {
      p.skip();
      if (this.src.startsWith("stream", p.pos)) {
        p.pos += "stream".length;
        if (this.src[p.pos] === "\r") p.pos += 1;
        if (this.src[p.pos] === "\n") p.pos += 1;
        value.set("__streamStart", p.pos);
      }
    }
    this.cache.set(num, value);
    return value;
  }

  resolve(v: PdfValue): PdfValue {
    let out = v;
    let guard = 0;
    while (isRef(out) && guard++ < 32) out = this.obj(out.ref);
    return out;
  }

  get(d: PdfDict, key: string): PdfValue {
    return this.resolve(d.get(key) ?? null);
  }

  /** The decoded bytes of a stream object, as a latin1 string. */
  streamData(d: PdfDict): string {
    const start = d.get("__streamStart");
    if (typeof start !== "number") return "";
    let len = this.get(d, "Length");
    if (typeof len !== "number") {
      const end = this.src.indexOf("endstream", start);
      len = end < 0 ? 0 : end - start;
    }
    // A wrong /Length would truncate silently; trust `endstream` when the
    // declared length does not land on one.
    const declaredEnd = start + len;
    const tail = this.src.slice(declaredEnd, declaredEnd + 20);
    if (!/^\s*endstream/.test(tail)) {
      const end = this.src.indexOf("endstream", start);
      if (end > start) len = end - start;
    }
    const raw = this.bytes.subarray(start, start + len);
    const filter = this.get(d, "Filter");
    const names: string[] = [];
    if (isName(filter)) names.push(filter.name);
    else if (Array.isArray(filter)) for (const f of filter) if (isName(this.resolve(f))) names.push((this.resolve(f) as PdfName).name);
    if (names.length === 0) return latin1(raw);
    if (names.length !== 1 || names[0] !== "FlateDecode") {
      throw new Error(`pdf: stream filter ${names.join("+")} is not supported by this reader`);
    }
    try {
      return latin1(new Uint8Array(inflateSync(Buffer.from(raw))));
    } catch {
      return latin1(new Uint8Array(inflateRawSync(Buffer.from(raw))));
    }
  }

  pages(): PdfDict[] {
    const root = this.resolve(this.trailer.get("Root") ?? null);
    if (!isDict(root)) throw new Error("pdf: /Root is not a dict");
    const pagesNode = this.get(root, "Pages");
    if (!isDict(pagesNode)) throw new Error("pdf: /Root has no /Pages");
    const out: PdfDict[] = [];
    const walk = (node: PdfDict, depth: number, inherited: PdfDict): void => {
      if (depth > 64) throw new Error("pdf: page tree is too deep / cyclic");
      const merged: PdfDict = new Map(inherited);
      for (const key of ["Resources", "MediaBox", "CropBox", "Rotate"]) {
        if (node.has(key)) merged.set(key, node.get(key) as PdfValue);
      }
      const type = node.get("Type");
      const kids = this.get(node, "Kids");
      if (Array.isArray(kids)) {
        for (const k of kids) {
          const kid = this.resolve(k);
          if (isDict(kid)) walk(kid, depth + 1, merged);
        }
        return;
      }
      if (isName(type) && type.name === "Pages") return;
      const page: PdfDict = new Map(node);
      for (const [k, v] of merged) if (!page.has(k)) page.set(k, v);
      out.push(page);
    };
    walk(pagesNode, 0, new Map());
    return out;
  }
}

// ── ToUnicode CMaps ───────────────────────────────────────────────────

interface Cmap {
  readonly codeBytes: number;
  readonly map: Map<number, string>;
}

function hexToInt(h: string): number {
  let n = 0;
  for (let i = 0; i < h.length; i += 1) n = n * 256 + h.charCodeAt(i);
  return n;
}

function utf16be(s: string): string {
  let out = "";
  for (let i = 0; i + 1 < s.length; i += 2) out += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1));
  if (s.length === 1) out += s;
  return out;
}

function parseCmap(text: string): Cmap {
  const map = new Map<number, string>();
  let codeBytes = 0;

  const csr = /begincodespacerange([\s\S]*?)endcodespacerange/g;
  let m: RegExpExecArray | null;
  while ((m = csr.exec(text)) !== null) {
    const p = new ObjParser(m[1], 0);
    for (;;) {
      p.skip();
      if (p.pos >= m[1].length) break;
      if (m[1][p.pos] !== "<") break;
      const lo = p.hexString();
      p.skip();
      if (m[1][p.pos] !== "<") break;
      p.hexString();
      codeBytes = Math.max(codeBytes, lo.length);
    }
  }

  const bfchar = /beginbfchar([\s\S]*?)endbfchar/g;
  while ((m = bfchar.exec(text)) !== null) {
    const body = m[1];
    const p = new ObjParser(body, 0);
    for (;;) {
      p.skip();
      if (p.pos >= body.length || body[p.pos] !== "<") break;
      const src = p.hexString();
      p.skip();
      if (body[p.pos] === "<") map.set(hexToInt(src), utf16be(p.hexString()));
      else if (body[p.pos] === "/") {
        p.value();
      } else break;
      codeBytes = Math.max(codeBytes, src.length);
    }
  }

  const bfrange = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = bfrange.exec(text)) !== null) {
    const body = m[1];
    const p = new ObjParser(body, 0);
    for (;;) {
      p.skip();
      if (p.pos >= body.length || body[p.pos] !== "<") break;
      const lo = p.hexString();
      p.skip();
      if (body[p.pos] !== "<") break;
      const hi = p.hexString();
      codeBytes = Math.max(codeBytes, lo.length);
      p.skip();
      const loN = hexToInt(lo);
      const hiN = hexToInt(hi);
      if (body[p.pos] === "[") {
        const arr = p.value();
        if (!Array.isArray(arr)) break;
        arr.forEach((dst, i) => {
          if (typeof dst === "string") map.set(loN + i, utf16be(dst));
        });
      } else if (body[p.pos] === "<") {
        const dst = p.hexString();
        const base = utf16be(dst);
        for (let c = loN; c <= hiN && c - loN < 65536; c += 1) {
          const bumped = base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + (c - loN));
          map.set(c, bumped);
        }
      } else break;
    }
  }

  return { codeBytes: codeBytes === 0 ? 2 : codeBytes, map };
}

// ── content-stream text extraction ────────────────────────────────────

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function mul(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

export interface PdfRun {
  readonly page: number;
  readonly x: number;
  readonly y: number;
  /** Effective glyph size: `Tfs` scaled by the text rendering matrix. */
  readonly size: number;
  /**
   * Device-space width of this run, measured from the document itself —
   * see `calibrateAdvances`. `x + advance` is the run's right edge.
   */
  readonly advance: number;
  /** The embedded font subset that drew it. */
  readonly font: string;
  readonly text: string;
}

export interface PdfLine {
  readonly page: number;
  readonly y: number;
  readonly text: string;
}

export interface PdfDocText {
  readonly runs: PdfRun[];
  readonly lines: PdfLine[];
  /** Every line, newline-joined, in page order. */
  readonly text: string;
  readonly structure: PdfStructure;
}

interface FontInfo {
  readonly cmap: Cmap | null;
  /** The subset name, e.g. `GAAAAA+Charter-Roman`. Identity for calibration. */
  readonly baseFont: string;
}

function fontsOf(doc: PdfDoc, page: PdfDict, counters: { with: number; without: number }): Map<string, FontInfo> {
  const out = new Map<string, FontInfo>();
  const res = doc.get(page, "Resources");
  if (!isDict(res)) return out;
  const fonts = doc.get(res, "Font");
  if (!isDict(fonts)) return out;
  for (const [name] of fonts) {
    const slot = fonts.get(name) as PdfValue;
    const f = doc.resolve(slot);
    if (!isDict(f)) continue;
    const bf = doc.get(f, "BaseFont");
    // A Type3 font carries no /BaseFont, and a resource name like `F9`
    // means different fonts on different pages — so fall back to the
    // object number, which is one identity for the whole document.
    const baseFont = isName(bf) ? bf.name : isRef(slot) ? `obj:${slot.ref}` : name;
    const tu = doc.get(f, "ToUnicode");
    if (isDict(tu)) {
      out.set(name, { cmap: parseCmap(doc.streamData(tu)), baseFont });
      counters.with += 1;
    } else {
      out.set(name, { cmap: null, baseFont });
      counters.without += 1;
    }
  }
  return out;
}

function decode(s: string, font: FontInfo | undefined): string {
  if (!font || !font.cmap) {
    // No ToUnicode: the codes are not text this reader can name. Emitting
    // the raw bytes would fabricate characters, so emit nothing — and
    // `structure.fontsWithoutToUnicode` reports how often that happened,
    // so a gate can refuse a document this reader could only half read.
    return "";
  }
  const { codeBytes, map } = font.cmap;
  let out = "";
  for (let i = 0; i + codeBytes <= s.length; i += codeBytes) {
    let code = 0;
    for (let k = 0; k < codeBytes; k += 1) code = code * 256 + s.charCodeAt(i + k);
    out += map.get(code) ?? "";
  }
  return out;
}

type RawRun = Omit<PdfRun, "advance">;

// ── measuring a glyph's advance from the document, not from the font ──
//
// The obvious source is the font: `/DescendantFonts[0]/W`. Measured, it
// does not agree with what Skia actually did — the footer's `F` advances
// 650.8 thousandths on the page while `/W` for that CID says 610.84,
// because CSS letter-spacing is folded into the `Td` displacement and
// never appears as a `Tc`. Sizing gaps off `/W` therefore mis-measures
// every letter-spaced run in the document.
//
// What the renderer did is recoverable from what it wrote. Skia places
// every glyph individually, so the distance to the next glyph ON THE SAME
// BASELINE is that glyph's advance — except where the next glyph belongs
// to a different block, which is exactly the case being detected. The
// advance is therefore the LOW end of the observed distances for that
// glyph at that size across the whole document: the 10th percentile,
// which is a tight-set occurrence, while a column jump sits far above it.
// A glyph seen only at the end of a line has no sample and falls back to
// 0.62 em, the advance of a digit in this document's numeric font.
function calibrateAdvances(runs: RawRun[]): PdfRun[] {
  const samples = new Map<string, number[]>();
  // Keyed by SUBSET too, not just glyph and size: the same character at
  // the same size advances differently in a proportional run and in a
  // `tabular-nums` run, and those are different embedded subsets. Pooling
  // them made the calibrated advance of "1" the proportional one and the
  // reader then split "18,420,491.28" after its leading digit.
  const key = (r: RawRun): string => `${r.font}\u0000${r.text}\u0000${r.size.toFixed(2)}`;

  const byBaseline = new Map<string, RawRun[]>();
  for (const r of runs) {
    const k = `${r.page}\u0000${r.y.toFixed(2)}`;
    const list = byBaseline.get(k);
    if (list) list.push(r);
    else byBaseline.set(k, [r]);
  }
  for (const list of byBaseline.values()) {
    const sorted = list.slice().sort((a, b) => a.x - b.x);
    for (let i = 0; i + 1 < sorted.length; i += 1) {
      const d = sorted[i + 1].x - sorted[i].x;
      if (d <= 0) continue;
      const k = key(sorted[i]);
      const arr = samples.get(k);
      if (arr) arr.push(d);
      else samples.set(k, [d]);
    }
  }

  const advance = new Map<string, number>();
  for (const [k, arr] of samples) {
    arr.sort((a, b) => a - b);
    advance.set(k, arr[Math.floor(arr.length * 0.1)]);
  }
  return runs.map((r) => ({ ...r, advance: advance.get(key(r)) ?? 0.62 * r.size }));
}

/** Median of a non-empty list. */
function median(xs: number[]): number {
  const a = xs.slice().sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

function runsOfPage(doc: PdfDoc, page: PdfDict, pageNo: number, counters: { with: number; without: number }): RawRun[] {
  const contents = doc.get(page, "Contents");
  const parts: string[] = [];
  if (isDict(contents)) parts.push(doc.streamData(contents));
  else if (Array.isArray(contents)) {
    for (const c of contents) {
      const cc = doc.resolve(c);
      if (isDict(cc)) parts.push(doc.streamData(cc));
    }
  }
  const stream = parts.join("\n");
  const fonts = fontsOf(doc, page, counters);

  const runs: RawRun[] = [];
  const p = new ObjParser(stream, 0);
  let ctm: Matrix = IDENTITY;
  const stack: Matrix[] = [];
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  let leading = 0;
  let fontSize = 0;
  let font: FontInfo | undefined;
  const operands: PdfValue[] = [];

  const show = (text: string): void => {
    if (text === "") return;
    const m = mul(tm, ctm);
    const size = Math.abs(fontSize) * Math.hypot(m[2], m[3]);
    runs.push({ page: pageNo, x: m[4], y: m[5], size, font: font ? font.baseFont : "", text });
  };

  const num = (v: PdfValue | undefined): number => (typeof v === "number" ? v : 0);

  while (p.pos < stream.length) {
    p.skip();
    if (p.pos >= stream.length) break;
    const c = stream[p.pos];
    if (c === "/" || c === "(" || c === "<" || c === "[" || /[0-9+\-.]/.test(c)) {
      try {
        operands.push(p.value());
      } catch {
        p.pos += 1;
      }
      continue;
    }
    const op = p.token();
    if (op === "") {
      p.pos += 1;
      operands.length = 0;
      continue;
    }
    switch (op) {
      case "q":
        stack.push(ctm);
        break;
      case "Q":
        ctm = stack.pop() ?? IDENTITY;
        break;
      case "cm":
        if (operands.length >= 6) {
          ctm = mul(
            [
              num(operands[operands.length - 6]),
              num(operands[operands.length - 5]),
              num(operands[operands.length - 4]),
              num(operands[operands.length - 3]),
              num(operands[operands.length - 2]),
              num(operands[operands.length - 1]),
            ],
            ctm,
          );
        }
        break;
      case "BT":
        tm = IDENTITY;
        tlm = IDENTITY;
        break;
      case "ET":
        break;
      case "Tf":
        if (operands.length >= 2 && isName(operands[operands.length - 2] as PdfValue)) {
          font = fonts.get((operands[operands.length - 2] as PdfName).name);
        }
        fontSize = num(operands[operands.length - 1]);
        break;
      case "TL":
        leading = num(operands[operands.length - 1]);
        break;
      case "Td":
        tlm = mul([1, 0, 0, 1, num(operands[operands.length - 2]), num(operands[operands.length - 1])], tlm);
        tm = tlm;
        break;
      case "TD":
        leading = -num(operands[operands.length - 1]);
        tlm = mul([1, 0, 0, 1, num(operands[operands.length - 2]), num(operands[operands.length - 1])], tlm);
        tm = tlm;
        break;
      case "Tm":
        if (operands.length >= 6) {
          tlm = [
            num(operands[operands.length - 6]),
            num(operands[operands.length - 5]),
            num(operands[operands.length - 4]),
            num(operands[operands.length - 3]),
            num(operands[operands.length - 2]),
            num(operands[operands.length - 1]),
          ];
          tm = tlm;
        }
        break;
      case "T*":
        tlm = mul([1, 0, 0, 1, 0, -leading], tlm);
        tm = tlm;
        break;
      case "Tj":
        if (typeof operands[operands.length - 1] === "string") {
          show(decode(operands[operands.length - 1] as string, font));
        }
        break;
      case "'":
      case '"':
        tlm = mul([1, 0, 0, 1, 0, -leading], tlm);
        tm = tlm;
        if (typeof operands[operands.length - 1] === "string") {
          show(decode(operands[operands.length - 1] as string, font));
        }
        break;
      case "TJ": {
        const arr = operands[operands.length - 1];
        if (Array.isArray(arr)) {
          // A TJ element list is ONE run: the numbers between the strings
          // are kerning, not spaces. Joining them keeps a figure whole —
          // which is the whole point of reading runs rather than lines.
          let acc = "";
          for (const el of arr) {
            if (typeof el === "string") acc += decode(el, font);
            else if (typeof el === "number" && el <= -180) acc += " ";
          }
          show(acc);
        }
        break;
      }
      case "BI": {
        // Inline image: skip to EI so its binary body is never tokenised.
        const ei = stream.indexOf("EI", p.pos);
        p.pos = ei < 0 ? stream.length : ei + 2;
        break;
      }
      default:
        break;
    }
    operands.length = 0;
  }
  return runs;
}

/** The whole text layer of a rendered PDF, read from its bytes. */
export function extractPdfText(bytes: Uint8Array): PdfDocText {
  const doc = new PdfDoc(bytes);
  const pages = doc.pages();
  const counters = { with: 0, without: 0 };
  const raw: RawRun[] = [];
  pages.forEach((page, i) => {
    raw.push(...runsOfPage(doc, page, i + 1, counters));
  });
  const runs = calibrateAdvances(raw);

  // Lines: runs grouped by page and device y, ordered by x. The tolerance
  // is half a point — two runs on the same baseline are emitted with the
  // same y by the renderer, so this groups rather than guesses.
  const lines: PdfLine[] = [];
  const byPage = new Map<number, PdfRun[]>();
  for (const r of runs) {
    const list = byPage.get(r.page);
    if (list) list.push(r);
    else byPage.set(r.page, [r]);
  }
  for (const page of Array.from(byPage.keys()).sort((a, b) => a - b)) {
    const list = (byPage.get(page) as PdfRun[]).slice().sort((a, b) => b.y - a.y || a.x - b.x);
    let bucket: PdfRun[] = [];
    const flush = (): void => {
      if (bucket.length === 0) return;
      const sorted = bucket.slice().sort((a, b) => a.x - b.x);
      // ── where one block ends and the next begins ────────────────────
      //
      // Skia emits real space glyphs inside a text block, so consecutive
      // glyphs concatenate with nothing between them. A separator belongs
      // only between two independent blocks sharing a baseline — a row
      // label and the right-aligned figure beside it.
      //
      // Neither test alone survives the document. The GLYPH test (does
      // the next glyph start clear of this one's calibrated right edge?)
      // splits "18,420,491.28" after its leading 1, because that font is
      // used both proportionally and with `tabular-nums` and the tight
      // sample wins the calibration. The LINE test (is this step much
      // wider than the typical step on this baseline?) mis-fires after a
      // wide glyph — %, W, an em dash — whose own advance exceeds the
      // line's median. Measured, each test alone corrupts figures; the
      // conjunction agrees with PyMuPDF on the same bytes.
      const steps: number[] = [];
      for (let i = 0; i + 1 < sorted.length; i += 1) steps.push(sorted[i + 1].x - sorted[i].x);
      const typical = steps.length >= 4 ? median(steps) * 1.45 : Number.POSITIVE_INFINITY;
      let text = "";
      let prev: PdfRun | null = null;
      for (const r of sorted) {
        if (prev !== null) {
          const step = r.x - prev.x;
          const clearOfTheGlyph = step - prev.advance > 0.18 * Math.max(prev.size, 1);
          if (clearOfTheGlyph && step > typical) text += " ";
        }
        text += r.text;
        prev = r;
      }
      lines.push({ page, y: sorted[0].y, text: text.replace(/\s+/g, " ").trim() });
      bucket = [];
    };
    for (const r of list) {
      if (bucket.length > 0 && Math.abs(bucket[0].y - r.y) > 0.5) flush();
      bucket.push(r);
    }
    flush();
  }

  return {
    runs,
    lines,
    text: lines.map((l) => l.text).join("\n"),
    structure: {
      indexSource: doc.indexSource,
      objectCount: doc.offsets.size,
      pageCount: pages.length,
      fontsWithToUnicode: counters.with,
      fontsWithoutToUnicode: counters.without,
    },
  };
}

// ── THE PAGE-SHAPED VIEW ──────────────────────────────────────────────
//
// `scripts/check_report_pdf.mjs` asks page-shaped questions — is this A4,
// does page 7 carry the running head, does it number itself "Page 7 of
// 31" — and used to answer them with a SECOND reader,
// `scripts/_pdf_text.mjs`: 275 lines of independent PDF parsing over the
// same format, with its own object scanner, its own CMap decoder and its
// own page-tree walk.
//
// One renderer, two readers. The two had already diverged in kind rather
// than in degree: this one indexes through the cross-reference table and
// reports which path it took, that one brute-scanned `N 0 obj` bodies
// and could not say; this one places every glyph and recovers columns,
// that one concatenated show-operators. Whichever of them was wrong on a
// given document, only one gate would have seen it.
//
// So the second reader was deleted and these two functions took its
// place. They are thin views over `extractPdfText`, not a parallel path:
// the parse, the CMaps and the page ordering are the ones the parity
// gate's 2,591 assertions run on, and a regression in them now shows up
// in both gates instead of one.
//
// Deliberately NOT preserved from the old reader: its `mediaBoxMm(bytes)`
// took the FIRST `/MediaBox` in the file by regex, which is the document
// default and not necessarily any page's box. `pageBoxesMm` walks the
// page tree, so a document whose pages disagree about their size — the
// exact thing a "is this A4?" check exists to catch — reports one entry
// per page instead of one answer for all of them.

export interface PdfPageBox {
  /** Page width in millimetres. */
  readonly w: number;
  /** Page height in millimetres. */
  readonly h: number;
}

const PT_TO_MM = 25.4 / 72;

/** Every page's media box, in page order, in millimetres. */
export function pageBoxesMm(bytes: Uint8Array): PdfPageBox[] {
  const doc = new PdfDoc(bytes);
  return doc.pages().map((page) => {
    const box = doc.get(page, "MediaBox");
    if (!Array.isArray(box) || box.length < 4) {
      throw new Error(
        "pdf: a page carries no resolvable /MediaBox — the page tree was read, so this is a " +
          "malformed document rather than a reader limitation",
      );
    }
    const n = box.map((v) => {
      const r = doc.resolve(v);
      return typeof r === "number" ? r : Number.NaN;
    });
    return { w: (n[2] - n[0]) * PT_TO_MM, h: (n[3] - n[1]) * PT_TO_MM };
  });
}

/**
 * The text of each page, in page order, one string per page.
 *
 * Every page the document has gets an entry — including one that carries
 * no text at all, which is the empty string. Returning a shorter array
 * would let a gate that counts pages agree with a reader that lost one.
 */
export function pageTexts(bytes: Uint8Array): string[] {
  const { lines, structure } = extractPdfText(bytes);
  const out: string[] = Array.from({ length: structure.pageCount }, () => "");
  for (const line of lines) {
    if (line.page < 1 || line.page > out.length) continue;
    out[line.page - 1] = out[line.page - 1] === "" ? line.text : `${out[line.page - 1]}\n${line.text}`;
  }
  return out;
}
