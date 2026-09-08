// legalConfig — the ONE place the operating entity's identity is declared,
// and the ONE place a legal document's URL is spelled.
//
// WHY THIS FILE EXISTS
// ====================
// Until 2026-09-05 the three legal documents (Privacy, Cookies, Terms)
// existed only as SECTIONS of the marketing page, reached by a client-side
// hash (`/#/legal`). Consequences, all measured at the time:
//   · there was no URL to hand a payment processor, an app store, a
//     data-protection authority or a crawler — `/privacy` was a 404
//     that fell through to the SPA;
//   · the entity's identity was typed inline as `[Company Legal Name]`
//     / `[Registered Address, City, Country]` / `[Reg. No.]` / `[VAT No.]`
//     in three different places, so filling it in meant editing prose in
//     three spots and hoping none was missed.
//
// 2026-09-06: the owner supplied the reviewed text (content/legal/*.md) and
// the registered-entity details. The identity below is now FILLED, and it is
// still declared exactly once — the footer, the legal pages and the
// prerendered HTML all read it from here. The document BODIES are not in
// this file and never will be: they are generated from the reviewed markdown
// into `legalDocuments.generated.ts`.
//
// `legalBlockers()` survives on purpose. It is what the launch matrix and
// the gate read, so the published/blocked state is derived from the same
// function the page renders from rather than from prose restating a
// threshold (Engine Book TC-10). It is empty today; add a required field and
// every surface goes back to BLOCKED without anyone editing a second place.

import {
  LEGAL_DOCUMENTS,
  LEGAL_ENTITY_DATA,
  type LegalDocId,
  type LegalLang,
} from "./legalDocuments.generated";

export type { LegalDocId, LegalLang };

export interface LegalEntity {
  /** Denumire — full registered company name. */
  denumire: string | null;
  /** CUI / CIF — Romanian fiscal identification code. */
  cui: string | null;
  /** Nr. Reg. Com. — trade-register number. */
  regCom: string | null;
  /** Sediu social — registered office address, one line. */
  sediu: string | null;
  /** Share capital as filed. Optional on the footer. */
  capitalSocial: string | null;
  /** Contact address for data-protection requests. */
  privacyEmail: string | null;
  /** Contact address for contractual/legal matters. */
  legalEmail: string | null;
  /** Public social handles. A null handle RENDERS NOTHING — see below. */
  social: SocialHandles;
}

/**
 * The company's public social presence, declared in the SAME place as its
 * legal identity and for the same reason.
 *
 * A NULL HANDLE RENDERS NOTHING. Not a dead link, not a greyed icon, not a
 * placeholder — the glyph does not appear. That rule is here because on
 * 2026-09-08 the production footer shipped the literal string
 * "[Company Legal Name]", forty pixels above the block rendering the real
 * entity, and the repair was to make absence render as absence rather than
 * as unfinished-looking text. A social icon linking to "#" or to a
 * half-typed URL is the same defect wearing a different shape.
 *
 * `instagram` is null today because the brief that requested this carried
 * "[INSTAGRAM URL — fill in]". Filling in a guess would have been exactly
 * the class of bug this file exists to prevent.
 *
 * Nothing may hardcode one of these outside this module —
 * `frontend/lib/__tests__/socialLinksFromConfig.test.ts` fails on any
 * social URL found elsewhere in the tree.
 */
export interface SocialHandles {
  /** Full profile URL, or null when we do not have one. */
  x: string | null;
  instagram: string | null;
}

/** The handles that are actually set, in render order. Empty when none
 *  are — a caller mapping this renders nothing without needing a guard. */
export function socialLinks(): Array<{ key: keyof SocialHandles; href: string }> {
  const s = LEGAL_ENTITY.social;
  const out: Array<{ key: keyof SocialHandles; href: string }> = [];
  // Order is declared here, not by object-key iteration, so a JSON reshuffle
  // cannot silently reorder what a reader sees.
  for (const key of ["x", "instagram"] as Array<keyof SocialHandles>) {
    const href = s ? s[key] : null;
    // A non-empty absolute https URL or nothing. An empty string, a "#", or
    // a half-typed value is treated exactly like absent.
    if (typeof href === "string" && /^https:\/\/\S+$/.test(href.trim())) {
      out.push({ key, href: href.trim() });
    }
  }
  return out;
}

/**
 * The operating entity, exactly as the owner supplied it on 2026-09-06 and
 * exactly as it appears inside the reviewed documents themselves.
 *
 * DECLARED IN `content/legal/entity.json`, not here. Two very different
 * runtimes need these values: React (this module) and the build-time
 * prerenderer (`scripts/prerender_legal.mjs`, plain Node, which cannot
 * import a `.ts` file). Typing the address in both would be exactly the
 * duplication this module exists to prevent — and the footer of the app
 * silently disagreeing with the footer of the served HTML is the kind of
 * defect nobody looks for. The generator embeds the JSON into
 * `legalDocuments.generated.ts`; the prerenderer reads the same file.
 *
 * `capitalSocial` is null: the owner's handover does not state it, and a
 * guessed share capital on a published legal page is a false declaration.
 * The footer omits the line rather than printing an empty one.
 */
export const LEGAL_ENTITY: LegalEntity = LEGAL_ENTITY_DATA;

/**
 * True once the document bodies have been reviewed. The owner delivered
 * content/legal/*.md as finished text on 2026-09-06 with the note that a
 * Romanian lawyer should review the liability cap (Terms §9) and the
 * consumer-law wording (Terms §7) "before or shortly after launch". That is
 * an owner decision about the text, not a gate on publishing it — the owner
 * asked for it to be published.
 */
export const LEGAL_TEXT_APPROVED = true as boolean;

/** Fields that must be present before any legal page counts as published.
 *  `capitalSocial` is excluded — a nice-to-have on the footer, not a
 *  requirement of the documents themselves. */
export const REQUIRED_ENTITY_FIELDS: Array<keyof LegalEntity> = [
  "denumire",
  "cui",
  "regCom",
  "sediu",
  "privacyEmail",
  "legalEmail",
];

export const LEGAL_DOC_IDS: LegalDocId[] = ["privacy", "terms", "cookies"];
export const LEGAL_LANGS: LegalLang[] = ["en", "ro"];

/** The site's own origin, used for absolute canonical / hreflang URLs. */
export const SITE_ORIGIN = "https://cfo-ai.io";

/**
 * Route path for a document.
 *
 * TWO URL FAMILIES, and the reason for each:
 *   · `/privacy` — the LINKABLE address. This is what goes to a payment
 *     processor, an app store form or a regulator, and it is what the app's
 *     own footer points at. It renders in whatever language the app is set
 *     to (i18n owns that — see frontend/i18n/index.ts), and it is prerendered
 *     in English, which is also its `x-default`.
 *   · `/ro/privacy` — the language-pinned address, the target of the `ro`
 *     hreflang alternate and of a direct link into the Romanian text. It
 *     renders Romanian regardless of the app's language setting, because
 *     that is the only thing an hreflang URL is allowed to mean.
 *
 * There is deliberately no `/en/privacy`: it would be a third URL serving
 * bytes identical to `/privacy`, i.e. duplicate content with no reader it
 * serves better.
 */
export function legalDocPath(doc: LegalDocId, lang?: LegalLang): string {
  return lang === "ro" ? `/ro/${doc}` : `/${doc}`;
}

/** Absolute URL — canonical tags and hreflang alternates need one. */
export function legalDocUrl(doc: LegalDocId, lang?: LegalLang): string {
  return `${SITE_ORIGIN}${legalDocPath(doc, lang)}`;
}

/**
 * The hreflang set for one document. `x-default` and `en` both point at the
 * un-prefixed URL, which is the English rendering a crawler is served.
 */
export function legalHreflangs(doc: LegalDocId): Array<{ hreflang: string; href: string }> {
  return [
    { hreflang: "en", href: legalDocUrl(doc) },
    { hreflang: "ro", href: legalDocUrl(doc, "ro") },
    { hreflang: "x-default", href: legalDocUrl(doc) },
  ];
}

/**
 * Everything still missing before the legal pages count as shipped.
 * Empty array = publishable. The page renders from this; the gate asserts on
 * this; the launch matrix cell is derived from this.
 *
 * A missing DOCUMENT is a blocker too — the entity fields being filled says
 * nothing about whether the reviewed text made it into the build.
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
  for (const doc of LEGAL_DOC_IDS) {
    for (const lang of LEGAL_LANGS) {
      const d = LEGAL_DOCUMENTS[`${doc}:${lang}`];
      if (!d || !d.html.trim()) missing.push(`document.${doc}.${lang}`);
    }
  }
  return missing;
}

/** True when the legal pages are safe to advertise as published. */
export function legalIsPublishable(): boolean {
  return legalBlockers().length === 0;
}
