// fileKind.ts — the real type of a file, from its bytes; never from its name.
//
// A Word document renamed .pdf — a PK (zip) container holding
// word/document.xml — is a Word document. The name says what the user
// believes; the magic bytes say what the file IS. The upload flow reads
// them before anything else (before the engine, so before Claude), and the
// card says so in a plain sentence: "This is a Word document, not a PDF".
// The engine repeats the check on its own routes (belt and braces).
//
// Bytes that prove nothing — a CSV, an unknown header, a PK container that
// names no Office part — are never refused: refuse only what can be proved.

/** What the extension declares. */
export type DeclaredKind = "pdf" | "xlsx" | "xls" | "csv" | "image" | "pptx" | "ppt";
/** What the bytes prove. */
export type ActualKind = "pdf" | "docx" | "xlsx" | "pptx" | "zip" | "ole" | "image" | "text" | "unknown";

const DECLARED_BY_EXT: Record<string, DeclaredKind> = {
  pdf: "pdf", xlsx: "xlsx", xlsm: "xlsx", xls: "xls", csv: "csv",
  jpg: "image", jpeg: "image", png: "image", heic: "image", heif: "image",
  pptx: "pptx", ppt: "ppt",
};

/** The kinds each declared kind may actually be; everything else the bytes
 *  PROVE is a mismatch. Mirrors the engine's table (`_uploads._COMPATIBLE`). */
const COMPATIBLE: Record<DeclaredKind, ReadonlySet<ActualKind>> = {
  pdf: new Set(["pdf"]),
  xlsx: new Set(["xlsx", "zip"]),
  xls: new Set(["ole", "xlsx", "zip"]),
  csv: new Set(["text"]),
  image: new Set(["image"]),
  pptx: new Set(["pptx", "zip"]),
  ppt: new Set(["ole", "pptx", "zip"]),
};

export function declaredFileKind(filename: string): DeclaredKind | null {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  return DECLARED_BY_EXT[ext] ?? null;
}

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  return magic.every((b, i) => bytes[i] === b);
}

function hasAscii(bytes: Uint8Array, needle: string): boolean {
  const n = needle.split("").map((c) => c.charCodeAt(0));
  outer: for (let i = 0; i + n.length <= bytes.length; i++) {
    for (let j = 0; j < n.length; j++) if (bytes[i + j] !== n[j]) continue outer;
    return true;
  }
  return false;
}

/** The kind `bytes` prove — `head` is the start of the file, `tail` its end
 *  (a zip's central directory lists every entry there). Pure. */
export function actualFileKind(head: Uint8Array, tail: Uint8Array = head): ActualKind {
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46])) return "pdf"; // %PDF
  if (startsWith(head, [0x50, 0x4b])) {
    if (hasAscii(head, "word/") || hasAscii(tail, "word/")) return "docx";
    if (hasAscii(head, "xl/") || hasAscii(tail, "xl/")) return "xlsx";
    if (hasAscii(head, "ppt/") || hasAscii(tail, "ppt/")) return "pptx";
    return "zip";
  }
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "ole";
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47]) || startsWith(head, [0xff, 0xd8, 0xff]) || startsWith(head, [0x47, 0x49, 0x46, 0x38])) return "image";
  if (head.length >= 12 && head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) return "image"; // ftyp: HEIC/HEIF
  if (head.length === 0) return "unknown";
  // Text (a CSV, a plain export): no NUL and decodable.
  for (let i = 0; i < Math.min(head.length, 4096); i++) if (head[i] === 0) return "unknown";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head.subarray(0, Math.min(head.length, 4096)));
    return "text";
  } catch {
    return "unknown";
  }
}

export interface KindMismatch {
  declared: DeclaredKind;
  actual: Exclude<ActualKind, "text" | "unknown">;
  /** i18n key under `wsV2.errors.kind` — e.g. "docx_not_pdf". */
  code: string;
}

/** Pure: the mismatch the bytes prove against the name, or null. */
export function kindMismatch(filename: string, head: Uint8Array, tail: Uint8Array = head): KindMismatch | null {
  const declared = declaredFileKind(filename);
  if (!declared) return null;
  const actual = actualFileKind(head, tail);
  if (actual === "text" || actual === "unknown") return null;
  if (COMPATIBLE[declared].has(actual)) return null;
  return { declared, actual, code: `${actual}_not_${declared}` };
}

const SLICE = 262_144;

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") return new Uint8Array(await blob.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/** Read the file's head and tail and check them against its name. A file
 *  that cannot be read is not refused here — the engine reads it again. */
export async function sniffFileMismatch(file: File): Promise<KindMismatch | null> {
  try {
    const head = await bytesOf(file.slice(0, SLICE));
    const tail = file.size > SLICE ? await bytesOf(file.slice(Math.max(0, file.size - SLICE))) : head;
    return kindMismatch(file.name, head, tail);
  } catch {
    return null;
  }
}
