// THE DOWNLOAD FILENAME — one authority, on the service side.
//
// The owner asked for `Company_Period_CFO_Report.pdf`. A company name
// is not a filename: it arrives from an uploaded trial balance, it
// carries spaces, Romanian diacritics, quotes, slashes and full stops,
// and the string then crosses FOUR systems that each have a different
// opinion about what a name may contain — an HTTP `Content-Disposition`
// header, a browser's download logic, NTFS, and whatever the firm's
// document management system does to it afterwards.
//
// So this is a security surface, and it is written as one.
//
// ── THE POLICY: ALLOWLIST, NOT DENYLIST ───────────────────────────────
//
// Every character outside `[A-Za-z0-9]` becomes `_`. That is a
// deliberate over-reach, because it makes a whole class of attacks
// STRUCTURALLY impossible rather than individually handled:
//
//   `/` `\` — path traversal. `../../etc/passwd` cannot survive.
//   CR LF   — `Content-Disposition` header injection (a name carrying
//             `\r\nSet-Cookie: …` would otherwise append a header).
//   NUL     — the classic `name.pdf\0.exe` truncation trick.
//   `"`     — ends the quoted header parameter.
//   `.`     — a leading dot hides the file on Unix; a trailing dot is
//             silently stripped by Windows, which turns `report.pdf.`
//             into something a second extension can be appended to.
//   U+202E  — RIGHT-TO-LEFT OVERRIDE. `report‮fdp.exe` DISPLAYS as
//             `reportexe.pdf` in most file managers. This one is not
//             theoretical; it is the standard filename-spoofing trick.
//   ` `     — a trailing space is stripped by Windows, same problem as
//             the trailing dot.
//
// The output is therefore provably `^[A-Za-z0-9_]+\.pdf$`, and
// `filenameIsSafe()` below is that assertion, exported so the test can
// hold it rather than restating it.
//
// ── WHAT IS TRANSLITERATED, AND WHY NOT MORE ──────────────────────────
//
// Romanian diacritics are mapped to their base letters (ă â → a, î → i,
// ș ş → s, ț ţ → t) BEFORE the allowlist runs, so `SOCIETATEA AGRICOLĂ`
// becomes `SOCIETATEA_AGRICOLA` and not `SOCIETATEA_AGRICOL_`. The
// comma-below (U+0219/U+021B) and cedilla (U+015F/U+0163) spellings are
// both handled — Romanian text in the wild uses both, and a bare NFD
// decomposition only catches one of them.
//
// Nothing else is transliterated. A Cyrillic or Greek name degrades to
// `_` runs and then to the fallback below; RFC 6266's `filename*` could
// carry it faithfully, but the file still has to land on an accountant's
// Windows machine, and a name that survives the header and then breaks
// the filesystem has bought nothing.

/** Romanian letters, both the comma-below and the cedilla spellings. */
const TRANSLITERATE = new Map([
  ["ă", "a"], ["Ă", "A"],
  ["â", "a"], ["Â", "A"],
  ["î", "i"], ["Î", "I"],
  ["ș", "s"], ["Ș", "S"],
  ["ş", "s"], ["Ş", "S"],
  ["ț", "t"], ["Ț", "T"],
  ["ţ", "t"], ["Ţ", "T"],
]);

/**
 * Windows refuses these as a filename STEM, with or without an
 * extension — `CON.pdf` is not creatable. A firm's Windows box is the
 * likeliest destination for this file, so the stem is prefixed rather
 * than the download silently failing there and nowhere else.
 */
const WINDOWS_RESERVED = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

/** Longest a single part may be, so the whole name stays well under the
 *  255-byte limit every common filesystem enforces. */
const PART_MAX = 60;

/**
 * One part of the name — the company, or the period.
 *
 * `fallback` is used when the part reduces to nothing, which happens for
 * a name written entirely outside the Latin alphabet. It is a real word,
 * not an empty string: a file called `_CFO_Report.pdf` looks broken, and
 * a reader cannot tell a stripped name from a bug.
 */
export function filenamePart(raw, fallback) {
  const text = typeof raw === "string" ? raw : "";
  let out = "";
  for (const ch of text.normalize("NFC")) {
    out += TRANSLITERATE.get(ch) ?? ch;
  }
  out = out
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, PART_MAX)
    .replace(/_+$/g, "");
  if (out === "") return fallback;
  if (WINDOWS_RESERVED.has(out.toUpperCase())) return `_${out}`;
  return out;
}

/**
 * `Company_Period_CFO_Report.pdf`.
 *
 * The service computes this and hands it back in the job status, so the
 * browser writes the name the server decided rather than deriving a
 * second one from the same inputs. Two derivations of one name is how
 * the header and the saved file come to disagree.
 */
export function reportFilename(company, period) {
  return `${filenamePart(company, "Company")}_${filenamePart(period, "Period")}_CFO_Report.pdf`;
}

/**
 * The claim this module makes about its own output, as an assertion the
 * caller can run. `server.mjs` runs it on every response — a filename
 * that failed this would be a header-injection vector, so it fails the
 * render rather than being sent.
 */
export function filenameIsSafe(name) {
  return /^[A-Za-z0-9_]+\.pdf$/.test(name) && name.length <= 150;
}
