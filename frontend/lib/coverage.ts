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

import coverageJson from "@/data/coverage.json";
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
  evidence: string;
  /** Distinct REAL trial balances, or "constructed test files only". */
  real_books: number | string;
  /** Key of engineProof.json `formats` this count must equal. */
  real_books_proof?: string;
  availability?: "available" | "unavailable";
  availability_en?: string;
  availability_ro?: string;
  note_en: string;
  note_ro: string;
  as_of: string;
}

export interface CoverageData {
  schema: string;
  as_of: string;
  rows: CoverageRowData[];
  untested_note_en: string;
  untested_note_ro: string;
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
    realBooks: (n: number) => (n === 1 ? "1 real book" : `${n} real books`),
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
    realBooks: (n: number) => (n === 1 ? "1 balanță reală" : `${n} balanțe reale`),
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
 *  number, so the table and the proof block can never disagree. */
export function realBooksOf(row: CoverageRowData): number | string {
  if (row.real_books_proof) {
    const n = ENGINE_PROOF.formats?.[row.real_books_proof];
    if (typeof n === "number") return n;
  }
  return row.real_books;
}

export function coverageView(lang: string): CoverageView {
  const l = langOf(lang);
  const w = WORDS[l];
  const rowView = (row: CoverageRowData): CoverageRowView => {
    const books = realBooksOf(row);
    const testedOn =
      typeof books === "number"
        ? books > 0 ? w.realBooks(books) : w.none
        : w.constructedOnly;
    const availability =
      row.availability === "unavailable"
        ? (l === "ro" ? row.availability_ro : row.availability_en) ?? null
        : null;
    return {
      id: row.id,
      category: row.category,
      label: l === "ro" ? row.label_ro : row.label_en,
      note: l === "ro" ? row.note_ro : row.note_en,
      testedOn,
      evidence: row.evidence,
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
