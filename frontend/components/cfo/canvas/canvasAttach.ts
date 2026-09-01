// THE CANVAS — ATTACH, AS A HAND-OFF.
//
// Dropping a file into a conversation is an obvious gesture and a
// dangerous one to implement, because the obvious implementation is a
// SECOND INGESTION PATH: read the file here, post it somewhere, report
// success. That path would bypass the period picker, the period
// detection, the 25 MB guard, the budget-deck interception, the
// extra-document confirmation (402) and the quota block (429) — every
// one of which lives in the dashboard's upload flow and exists because
// something went wrong without it.
//
// So the canvas does not ingest. It HANDS OFF:
//
//   drop  →  stage the File in this module (in memory, TTL'd)
//         →  navigate to the upload surface
//         →  that surface takes it through `onFileChosen`, the same
//            entry point its own dropzone uses
//         →  the thread reports what the REAL pipeline did, by reading
//            the global upload store
//
// The thread never claims an outcome it did not observe. "Queued",
// "blocked", "failed" all come from `lib/uploadStore`, which the
// dashboard's own progress card reads — one source of truth for what
// happened to the file, and the canvas is a second reader of it, not a
// second writer.
//
// ══ WHY A TTL ══════════════════════════════════════════════════════════
//
// A staged File held forever is a memory leak with the user's document
// in it. It is also a correctness hazard: navigate away, come back an
// hour later, and an upload surface would consume a file the reader has
// long forgotten dropping. Two minutes is long enough for a route
// change and short enough that nothing surprising happens.
//
// The module holds AT MOST ONE file. A second drop replaces the first,
// matching the dashboard's own "one file at a time" invariant.

export const ATTACH_TTL_MS = 2 * 60 * 1000;

interface Staged {
  file: File;
  stagedAt: number;
}

let staged: Staged | null = null;

/** Stage a dropped file for the upload surface to pick up. */
export function stageCanvasAttachment(file: File, now: number = Date.now()): void {
  staged = { file, stagedAt: now };
}

/**
 * Take the staged file, if one is still fresh. CONSUMING — a second call
 * returns null, so two mounts of the upload surface cannot both start an
 * upload of the same file.
 */
export function takeCanvasAttachment(now: number = Date.now()): File | null {
  const s = staged;
  staged = null;
  if (!s) return null;
  if (now - s.stagedAt > ATTACH_TTL_MS) return null;
  return s.file;
}

/** Peek without consuming — for a test, and for the canvas to know it
 *  has something in flight. */
export function peekCanvasAttachment(now: number = Date.now()): string | null {
  if (!staged) return null;
  if (now - staged.stagedAt > ATTACH_TTL_MS) return null;
  return staged.file.name;
}

export function __resetCanvasAttachmentForTests(): void {
  staged = null;
}

/**
 * Extensions the upload surface can actually do something with.
 *
 * Deliberately a SMALL allowlist, and deliberately checked here rather
 * than at the upload surface: refusing a `.jpg` in the thread, in one
 * sentence, beside the question the reader was asking, is a better place
 * to say no than a toast on a page they were bounced to. The upload
 * surface still applies its own guards — this is a courtesy filter, not
 * a security boundary, and it must never be the only check.
 */
export const ATTACH_EXTENSIONS: readonly string[] = Object.freeze([
  ".xlsx", ".xls", ".xlsm", ".csv", ".pdf", ".pptx", ".ppt",
]);

export function attachmentLooksSupported(filename: string): boolean {
  const lower = (filename ?? "").toLowerCase();
  return ATTACH_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
