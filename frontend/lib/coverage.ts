// coverage — what the product can read today, from ONE data file.
//
// `frontend/data/coverage.json` is the only place coverage wording is
// written: the landing table beside the upload step, the same table in the
// in-app upload zone, and the availability word a plan bullet quotes all
// render from it. The headline said "any European country" for two months
// while every test in the repository was a Romanian trial balance; this
// file exists so a claim cannot be typed anywhere else.
//
// Gate `public-claims` (lib/__tests__/publicClaims.test.tsx) reds on a
// tested row without evidence, on a tested row's book count that is not the
// proof's, and on any coverage claim a public surface makes that is not a
// row here.
//
// THE DENOMINATOR IS PRINTED (2026-10-02). The first version of the table
// said "6 real books" beside the spreadsheet layout and "2 real books"
// beside the text-layer PDF, under the heading "Tested". Both rows were
// wider than what is read: one real 10-column sheet on hand is REFUSED (its
// header abbreviates Debit / Credit), and the text reader reads three named
// row layouts and refuses a real file in one of them. A row now prints how
// many real files were read AND how many were refused, and its note takes
// those counts as tokens — {read} {refused} {held} {record_date} — from the
// proof or from a dated record (frontend/data/coverageRecords.json), so a
// count cannot be typed into a sentence.

import coverageJson from "@/data/coverage.json";
import recordsJson from "@/data/coverageRecords.json";
import { ENGINE_PROOF, proofDate } from "@/lib/engineProof";

export type CoverageCategory = "tested" | "ai_interpreted" | "not_supported";
export type CoverageLang = "en" | "ro";

export interface CoverageRowData {
  id: string;
  category: CoverageCategory;
  label_en: string;
  label_ro: string;
  formats: string[];
  software: string[];
  evidence: CoverageEvidence;
  /** Distinct REAL trial balances READ, or "constructed test files only". */
  real_books: number | string;
  /** Key of engineProof.json `formats` this count must equal. */
  real_books_proof?: string;
  /** Real files of this kind the reader REFUSED (from the row's record). */
  real_files_refused?: number;
  availability?: "available" | "unavailable";
  availability_en?: string;
  availability_ro?: string;
  note_en: string;
  note_ro: string;
  as_of: string;
}

/** What a row's claim rests on: battery gates that exist, a dated record of
 *  a measurement no gate can re-run, and / or a plain note. */
export interface CoverageEvidence {
  gates?: string[];
  /** id of a record in frontend/data/coverageRecords.json */
  record?: string;
  note_en?: string;
  note_ro?: string;
}

export interface CoverageRecord {
  id: string;
  row: string;
  measured_at: string;
  measured_by: string;
  how_en: string;
  how_ro: string;
  detail: string;
  real_books_read: number;
  real_files_refused: number;
  repeatable_from_this_repository: boolean;
}

export const COVERAGE_RECORDS = (recordsJson as unknown as { records: CoverageRecord[] }).records;

export function coverageRecord(id: string | undefined): CoverageRecord | null {
  if (!id) return null;
  return COVERAGE_RECORDS.find((r) => r.id === id) ?? null;
}

export interface CoverageData {
  schema: string;
  as_of: string;
  rows: CoverageRowData[];
  untested_note_en: string;
  untested_note_ro: string;
  upload_guide: {
    accepted_untested_formats: string[];
    tested_on_real_en: string;
    tested_on_real_ro: string;
    untested_formats_en: string;
    untested_formats_ro: string;
    untested_document_en: string;
    untested_document_ro: string;
  };
}

export const COVERAGE = coverageJson as unknown as CoverageData;

export const COVERAGE_CATEGORY_ORDER: CoverageCategory[] = [
  "tested",
  "ai_interpreted",
  "not_supported",
];

const langOf = (lang: string | null | undefined): CoverageLang =>
  (lang ?? "").toLowerCase().startsWith("ro") ? "ro" : "en";

/** The words around the data — headings and the evidence line. They carry
 *  no coverage claim of their own: every label, note and count is a row. */
const WORDS = {
  en: {
    title: "What CFO AI can read today",
    lede: "Tested means tested on files, and we say which: real trial balances from Romanian companies, or files we built ourselves.",
    category: {
      tested: "Tested",
      ai_interpreted: "AI-interpreted",
      not_supported: "Not supported yet",
    },
    categoryNote: {
      tested: "Read by the deterministic engine — no AI touches the numbers.",
      ai_interpreted: "Read by an AI model and labelled as such on the result.",
      not_supported: "Do not rely on a result from these files.",
    },
    realBooks: (n: number) => (n === 1 ? "1 real book read" : `${n} real books read`),
    refused: (n: number) => (n === 1 ? "1 real file refused" : `${n} real files refused`),
    constructedOnly: "constructed test files only",
    none: "no real book tested",
    evidence: "Evidence",
    asOf: "as of",
    colWhat: "File",
    colTestedOn: "Tested on",
  },
  ro: {
    title: "Ce poate citi CFO AI astăzi",
    lede: "Testat înseamnă testat pe fișiere, și spunem care: balanțe reale ale unor companii românești sau fișiere construite de noi.",
    category: {
      tested: "Testat",
      ai_interpreted: "Interpretat de AI",
      not_supported: "Încă nesuportat",
    },
    categoryNote: {
      tested: "Citit de motorul determinist — niciun AI nu atinge cifrele.",
      ai_interpreted: "Citit de un model AI și etichetat ca atare pe rezultat.",
      not_supported: "Nu te baza pe un rezultat obținut din aceste fișiere.",
    },
    realBooks: (n: number) => (n === 1 ? "1 balanță reală citită" : `${n} balanțe reale citite`),
    refused: (n: number) => (n === 1 ? "1 fișier real refuzat" : `${n} fișiere reale refuzate`),
    constructedOnly: "doar fișiere de test construite",
    none: "nicio balanță reală testată",
    evidence: "Dovadă",
    asOf: "la data de",
    colWhat: "Fișier",
    colTestedOn: "Testat pe",
  },
} as const;

export interface CoverageRowView {
  id: string;
  category: CoverageCategory;
  label: string;
  note: string;
  /** "6 real books" · "constructed test files only" · "no real book tested". */
  testedOn: string;
  evidence: string;
  /** "Currently unavailable" on a row that is switched off, else null. */
  availability: string | null;
  asOf: string;
  asOfIso: string;
}

export interface CoverageGroupView {
  category: CoverageCategory;
  heading: string;
  note: string;
  rows: CoverageRowView[];
}

export interface CoverageView {
  title: string;
  lede: string;
  groups: CoverageGroupView[];
  untestedNote: string;
  words: { evidence: string; asOf: string; colWhat: string; colTestedOn: string };
  asOf: string;
}

/** The count a row prints. A row tied to the proof reads the PROOF's
 *  number, so the table and the proof block can never disagree; a row
 *  resting on a dated record reads the RECORD's. */
export function realBooksOf(row: CoverageRowData): number | string {
  if (row.real_books_proof) {
    const n = ENGINE_PROOF.formats?.[row.real_books_proof];
    if (typeof n === "number") return n;
  }
  const record = coverageRecord(row.evidence.record);
  if (record && typeof row.real_books === "number") return record.real_books_read;
  return row.real_books;
}

/** Real files of the row's kind the reader refused — the record's count. */
export function refusedOf(row: CoverageRowData): number {
  const record = coverageRecord(row.evidence.record);
  if (record) return record.real_files_refused;
  return typeof row.real_files_refused === "number" ? row.real_files_refused : 0;
}

/** The evidence line, in the reader's language: the gate ids (identifiers,
 *  the same in both), the dated record ("production reprocess, 1 Oct 2026"
 *  — the date through the page's own date printer), and any note. */
export function evidenceText(row: CoverageRowData, lang: string): string {
  const l = langOf(lang);
  const parts: string[] = [];
  if (row.evidence.gates?.length) parts.push(row.evidence.gates.join(", "));
  const record = coverageRecord(row.evidence.record);
  if (record) parts.push(`${l === "ro" ? record.how_ro : record.how_en}, ${proofDate(record.measured_at, l)}`);
  const note = l === "ro" ? row.evidence.note_ro : row.evidence.note_en;
  if (note) parts.push(note);
  return parts.join(" · ");
}

const NOTE_TOKEN = /\{(read|refused|held|record_date)\}/g;

/** A row's note with its counts filled in. An unknown token stays visible. */
function noteText(row: CoverageRowData, l: CoverageLang): string {
  const template = l === "ro" ? row.note_ro : row.note_en;
  if (!template.includes("{")) return template;
  const read = realBooksOf(row);
  const refused = refusedOf(row);
  const record = coverageRecord(row.evidence.record);
  const number = (n: number) => new Intl.NumberFormat(l === "ro" ? "ro-RO" : "en-US").format(n);
  return template.replace(NOTE_TOKEN, (whole, key: string) => {
    if (key === "read") return typeof read === "number" ? number(read) : whole;
    if (key === "refused") return number(refused);
    if (key === "held") return typeof read === "number" ? number(read + refused) : whole;
    return record ? proofDate(record.measured_at, l) : whole;
  });
}

export function coverageView(lang: string): CoverageView {
  const l = langOf(lang);
  const w = WORDS[l];
  const rowView = (row: CoverageRowData): CoverageRowView => {
    const books = realBooksOf(row);
    const refused = refusedOf(row);
    const testedOn =
      typeof books === "number"
        ? (books > 0 ? w.realBooks(books) : w.none) + (refused > 0 ? ` · ${w.refused(refused)}` : "")
        : w.constructedOnly;
    const availability =
      row.availability === "unavailable"
        ? (l === "ro" ? row.availability_ro : row.availability_en) ?? null
        : null;
    return {
      id: row.id,
      category: row.category,
      label: l === "ro" ? row.label_ro : row.label_en,
      note: noteText(row, l),
      testedOn,
      evidence: evidenceText(row, l),
      availability,
      asOf: proofDate(row.as_of, l),
      asOfIso: row.as_of,
    };
  };
  return {
    title: w.title,
    lede: w.lede,
    groups: COVERAGE_CATEGORY_ORDER.map((category) => ({
      category,
      heading: w.category[category],
      note: w.categoryNote[category],
      rows: COVERAGE.rows.filter((r) => r.category === category).map(rowView),
    })).filter((g) => g.rows.length > 0),
    untestedNote: l === "ro" ? COVERAGE.untested_note_ro : COVERAGE.untested_note_en,
    words: { evidence: w.evidence, asOf: w.asOf, colWhat: w.colWhat, colTestedOn: w.colTestedOn },
    asOf: proofDate(COVERAGE.as_of, l),
  };
}

// ── The in-app upload guide ────────────────────────────────────────────
//
// The dashboard's "Expected format" grid, its drop zone, the /workspace
// drop zone and the upload flow's hint each typed their own format list:
// "XLSX · CSV · PDF", "PDF · XLSX · XLS · CSV", "PDF, Excel, CSV or a
// photo". coverage.json says CSV passes on constructed files only, .xls has
// no real-file test and a photo needs the AI reader. The lists are now
// DERIVED from the rows, so a surface cannot offer a format as plainly as a
// tested one when the table says otherwise.

export interface UploadGuideView {
  /** "XLSX · PDF" — formats of a tested row read on at least one real book. */
  testedFormats: string;
  /** "CSV · XLS" — accepted by the uploader, no real-file test. */
  untestedFormats: string;
  /** "XLSX · PDF — tested on real trial balances. CSV · XLS — accepted,
   *  not yet tested on a real file." */
  formatsLine: string;
  /** "CSV · XLS — accepted, not yet tested on a real file." */
  untestedLine: string;
  /** For a document card (the statutory filing): "Accepted, not yet tested
   *  on a real file". */
  untestedDocument: string;
  /** The AI reader's availability word, lower case ("currently
   *  unavailable"), or "" when it is available. */
  aiReader: string;
}

export function uploadGuideView(lang: string): UploadGuideView {
  const l = langOf(lang);
  const guide = COVERAGE.upload_guide;
  const tested: string[] = [];
  const untested: string[] = [];
  const testedRows = COVERAGE.rows.filter((r) => r.category === "tested");
  for (const row of testedRows) {
    const books = realBooksOf(row);
    if (typeof books === "number" && books > 0) {
      for (const f of row.formats) if (!tested.includes(f)) tested.push(f);
    }
  }
  for (const row of testedRows) {
    for (const f of row.formats) if (!tested.includes(f) && !untested.includes(f)) untested.push(f);
  }
  for (const f of guide.accepted_untested_formats) {
    if (tested.includes(f)) {
      throw new Error(`coverage.json upload_guide lists "${f}" as untested, but a tested row read it on a real book`);
    }
    if (!untested.includes(f)) untested.push(f);
  }
  const show = (formats: string[]) => formats.map((f) => f.toUpperCase()).join(" · ");
  const testedFormats = show(tested);
  const untestedFormats = show(untested);
  const testedWords = l === "ro" ? guide.tested_on_real_ro : guide.tested_on_real_en;
  const untestedWords = l === "ro" ? guide.untested_formats_ro : guide.untested_formats_en;
  const untestedLine = untested.length ? `${untestedFormats} — ${untestedWords}.` : "";
  const ai = COVERAGE.rows.find((r) => r.id === "ai_read");
  const aiWords =
    ai?.availability === "unavailable" ? ((l === "ro" ? ai.availability_ro : ai.availability_en) ?? "") : "";
  return {
    testedFormats,
    untestedFormats,
    formatsLine: `${testedFormats} — ${testedWords}.${untestedLine ? ` ${untestedLine}` : ""}`,
    untestedLine,
    untestedDocument: l === "ro" ? guide.untested_document_ro : guide.untested_document_en,
    aiReader: aiWords ? aiWords.charAt(0).toLowerCase() + aiWords.slice(1) : "",
  };
}
