// Types for scripts/generate_legal_documents.mjs, which vite.config.ts imports.
//
// The implementation is `.mjs` on purpose: it also runs standalone under plain
// `node` (an operator regenerating after editing content/legal/*.md, and the
// gate's plant/revert loop), which a `.ts` file cannot do without a compile
// step. This declaration is the small price for one implementation serving
// both callers.
export interface LegalDocumentBuild {
  doc: "privacy" | "terms" | "cookies";
  lang: "en" | "ro";
  sourceFile: string;
  title: string;
  updatedLabel: string;
  published: string;
  sha256: string;
  fileSha256: string;
  version: string;
  description: string;
  html: string;
}

export interface LegalEntityData {
  denumire: string;
  cui: string;
  regCom: string;
  sediu: string;
  capitalSocial: string | null;
  privacyEmail: string;
  legalEmail: string;
}

/** Rewrite frontend/lib/legalDocuments.generated.ts from content/legal/*.md.
 *  Returns true when the file's bytes actually changed. */
export function regenerate(): boolean;
/** Every (document, language) rendering, derived from the markdown. */
export function buildDocuments(): LegalDocumentBuild[];
/** The operating entity, from content/legal/entity.json. */
export function readEntity(): LegalEntityData;
export const OUTPUT: string;
