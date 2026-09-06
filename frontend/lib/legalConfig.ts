// legalConfig — the ONE place the operating entity's identity is declared.
//
// WHY THIS FILE EXISTS
// ====================
// Until 2026-09-05 the three legal documents (Privacy, Cookies, Terms)
// existed only as SECTIONS of the marketing page, reached by a
// client-side hash (`/#/legal`). Consequences, all measured:
//   · there was no URL to hand a payment processor, an app store, a
//     data-protection authority or a crawler — `/privacy` was a 404
//     that fell through to the SPA;
//   · the entity's identity was typed inline as `[Company Legal Name]`
//     / `[Registered Address, City, Country]` / `[Reg. No.]` / `[VAT No.]`
//     in three different places, so filling it in meant editing prose in
//     three spots and hoping none was missed.
//
// This module holds the identity ONCE. The footer and all three legal
// routes read it. Every field is `null` until the owner fills it in —
// and while any required field is null, the legal routes render a
// clearly-marked TEXT REQUIRED block rather than pretending the page is
// published. Nothing here drafts legal text; that is the owner's item,
// and a lawyer's.
//
// TO GO LIVE: fill the fields below, set `LEGAL_TEXT_APPROVED` to true
// once a lawyer has signed off the document bodies, redeploy. The LR
// gate reads `legalBlockers()`, so the matrix flips from BLOCKED to
// WORKING off the same function the page renders from — no prose
// restating a threshold (Engine Book TC-10).

export interface LegalEntity {
  /** Denumire — full registered company name, e.g. "EXAMPLE SRL". */
  denumire: string | null;
  /** CUI / CIF — Romanian fiscal identification code. */
  cui: string | null;
  /** Nr. Reg. Com. — trade-register number, e.g. "J40/1234/2020". */
  regCom: string | null;
  /** Sediu social — registered office address, one line. */
  sediu: string | null;
  /** Share capital as filed, e.g. "200 RON". Optional on the footer. */
  capitalSocial: string | null;
  /** Contact address for data-protection requests. */
  privacyEmail: string | null;
  /** Contact address for contractual/legal matters. */
  legalEmail: string | null;
}

/**
 * UNFILLED. Every value is null on purpose — see the header. Do not
 * invent placeholders here: a plausible-looking fake entity on a
 * published privacy policy is worse than a visible gap, because it
 * reads as a real declaration to anyone who lands on the page.
 */
export const LEGAL_ENTITY: LegalEntity = {
  denumire: null,
  cui: null,
  regCom: null,
  sediu: null,
  capitalSocial: null,
  privacyEmail: null,
  legalEmail: null,
};

/**
 * Flip to `true` only after a qualified lawyer has reviewed the document
 * bodies. Separate from the entity fields because the two are different
 * owner items: filling in the CUI does not make the prose reviewed.
 */
export const LEGAL_TEXT_APPROVED = false as boolean;

/** Fields that must be present before any legal page can be considered
 *  published. `capitalSocial` is excluded — it is a nice-to-have on the
 *  footer, not a requirement of the documents themselves. */
export const REQUIRED_ENTITY_FIELDS: Array<keyof LegalEntity> = [
  "denumire",
  "cui",
  "regCom",
  "sediu",
  "privacyEmail",
  "legalEmail",
];

export type LegalDocId = "privacy" | "terms" | "cookies";

export const LEGAL_DOC_IDS: LegalDocId[] = ["privacy", "terms", "cookies"];

/** Route path for a document. Single authority — the footer, the router
 *  and the gate all read this rather than spelling the path three times. */
export function legalDocPath(doc: LegalDocId): string {
  return `/${doc}`;
}

/**
 * Everything still missing before the legal pages count as shipped.
 * Empty array = publishable. The page renders from this; the gate
 * asserts on this; the launch matrix cell is derived from this.
 */
export function legalBlockers(
  entity: LegalEntity = LEGAL_ENTITY,
  approved: boolean = LEGAL_TEXT_APPROVED,
): string[] {
  const missing = REQUIRED_ENTITY_FIELDS.filter((f) => {
    const v = entity[f];
    return typeof v !== "string" || v.trim() === "";
  }).map((f) => `entity.${f}`);
  if (!approved) missing.push("legal_text_review");
  return missing;
}

/** True when the legal pages are safe to advertise as published. */
export function legalIsPublishable(): boolean {
  return legalBlockers().length === 0;
}
