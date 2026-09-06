// legalDocs — the app-facing view of the reviewed legal documents.
//
// `legalDocuments.generated.ts` is the data (generated from
// content/legal/*.md, never edited by hand). `legalConfig.ts` is the entity
// and the URL scheme. This module is the thin layer both React and the
// prerenderer's contract need on top: resolving which language to show, the
// version identifiers a consent record is written against, and the
// entity-identification lines the footer prints on every page.
//
// Nothing here contains legal prose. If you find yourself typing a sentence
// of policy into this file, it belongs in content/legal/*.md instead — that
// is the text someone reviewed.

import {
  LEGAL_DOCUMENTS,
  legalDocument,
  type LegalDocId,
  type LegalDocument,
  type LegalLang,
} from "./legalDocuments.generated";
import { LEGAL_ENTITY, LEGAL_DOC_IDS, legalDocPath } from "./legalConfig";

export { LEGAL_DOCUMENTS, legalDocument, legalDocPath };
export type { LegalDocId, LegalDocument, LegalLang };

/** Narrow an i18next language tag (`ro`, `ro-RO`, `en-GB`) to a document
 *  language. Anything we don't publish falls back to English, which is the
 *  fallbackLng the i18n bootstrap already uses. */
export function docLangOf(language: string | null | undefined): LegalLang {
  return (language ?? "").toLowerCase().startsWith("ro") ? "ro" : "en";
}

/**
 * The version identifier of every document as currently published, keyed by
 * document id. This is what a consent record stores — see legalConsent.ts.
 *
 * It is per (document, language) because the two language versions are
 * separate texts with separate hashes: a user who accepted the Romanian
 * Terms accepted THAT text, and reproducing what they saw means knowing
 * which one.
 */
export function documentVersion(doc: LegalDocId, lang: LegalLang): {
  version: string;
  sha256: string;
  published: string;
  lang: LegalLang;
  title: string;
} {
  const d = legalDocument(doc, lang);
  return {
    version: d.version,
    sha256: d.sha256,
    published: d.published,
    lang: d.lang,
    title: d.title,
  };
}

/** The document's own H1 — used as the page heading and as the link label
 *  wherever there is room for the full title. */
export function documentTitle(doc: LegalDocId, lang: LegalLang): string {
  return legalDocument(doc, lang).title;
}

/**
 * SHORT footer labels, exactly as the owner specified the footer line:
 *   "Confidențialitate · Termeni · Cookie-uri · contact@cfo-ai.io"
 * and its English counterpart.
 *
 * These are UI chrome, not policy text — the full titles ("Politica de
 * confidențialitate", "Termeni și condiții de utilizare") are the documents'
 * own H1s and would wrap onto three lines in a footer strip. They live here
 * rather than in i18n locale JSON because the same labels are printed into
 * the PRERENDERED HTML, where i18next has not booted yet, and two copies of
 * a label is exactly how the footer ends up disagreeing with itself.
 */
const FOOTER_LABELS: Record<LegalLang, Record<LegalDocId, string>> = {
  ro: { privacy: "Confidențialitate", terms: "Termeni", cookies: "Cookie-uri" },
  en: { privacy: "Privacy", terms: "Terms", cookies: "Cookies" },
};

export function documentLabel(doc: LegalDocId, lang: LegalLang): string {
  return FOOTER_LABELS[lang][doc];
}

export interface EntityLine {
  /** Stable id so a test can assert on the claim, not on a string. */
  id: "identity" | "address" | "contact";
  text: string;
}

/**
 * The company-identification block the owner asked to appear in the footer
 * of every page, in both languages:
 *
 *   PARACHAIN CAPITAL S.R.L. · CUI 45298544 · J2021021081405
 *   Intrarea Bitolia nr. 32, Sector 1, București, România
 *   Confidențialitate · Termeni · Cookie-uri · contact@cfo-ai.io
 *
 * The third line is rendered as LINKS by the footer component (that is what
 * makes it useful), so only the first two are text here; `contact` carries
 * the mailbox. Every value comes from LEGAL_ENTITY — no string is retyped.
 */
export function entityLines(): EntityLine[] {
  const e = LEGAL_ENTITY;
  const identity = [e.denumire, e.cui ? `CUI ${e.cui}` : null, e.regCom]
    .filter((x): x is string => !!x)
    .join(" · ");
  const lines: EntityLine[] = [{ id: "identity", text: identity }];
  if (e.sediu) lines.push({ id: "address", text: e.sediu });
  if (e.legalEmail) lines.push({ id: "contact", text: e.legalEmail });
  return lines;
}

/** Footer link set: the three documents plus the contact mailbox. */
export function footerLegalLinks(lang: LegalLang): Array<{ doc: LegalDocId; label: string; href: string }> {
  return LEGAL_DOC_IDS.map((doc) => ({
    doc,
    label: documentLabel(doc, lang),
    href: legalDocPath(doc),
  }));
}
