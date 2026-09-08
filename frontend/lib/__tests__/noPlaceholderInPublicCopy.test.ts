/**
 * NO UNREPLACED PLACEHOLDER REACHES A PUBLIC PAGE.
 *
 * Found on production on launch day, in the footer of the marketing page,
 * in both languages:
 *
 *     © 2026 CFO AI · [Company Legal Name]. All rights reserved.
 *
 * `lib/legalConfig.ts` exists precisely to end this. Its own header
 * records the defect it was created for — the entity "was typed inline as
 * `[Company Legal Name]` / `[Registered Address, City, Country]` in three
 * different places, so filling it in meant editing prose in three spots
 * and hoping none was missed." Two of the three were fixed. The
 * copyright line in `landingStrings.ts` was the one that was missed, and
 * it sat directly above a footer block that renders the real, complete
 * entity from `LEGAL_ENTITY` — so the page printed the right identity and
 * a bracket placeholder within about forty pixels of each other.
 *
 * This is the class of defect that costs credibility rather than
 * correctness: nothing is wrong with the numbers, and a reader who is
 * being asked to trust the product with client financials sees an
 * unfinished template.
 *
 * WHAT THIS REDS ON (TC-11)
 *   · any `[Bracketed Placeholder]` in the landing copy, EN or RO;
 *   · the standard lorem/TBD/TODO/FIXME/XXX placeholder vocabulary;
 *   · a `{token}` in a string that no caller substitutes — the shape that
 *     produced this bug is a template whose substitution was forgotten,
 *     so an UNKNOWN token is treated exactly like a bracket.
 * WHAT IT CANNOT SEE
 *   · placeholders in the legal document BODIES, which are generated from
 *     the reviewed markdown — `legalPublished.test.tsx` covers those;
 *   · copy that is merely wrong or stale rather than templated;
 *   · authenticated surfaces, which this file has no fixture for.
 */

import { describe, it, expect } from "vitest";
import { LANDING_STRINGS } from "@/pages/cfo/landingStrings";

/**
 * Tokens the renderer genuinely substitutes at call time.
 * `year` and `company` are substituted in the footer (`Landing.tsx`);
 * `privacy`, `terms` and `cookiePolicy` are the in-page link family fed
 * through `inlineLink()` at `Landing.tsx:718-719`.
 *
 * NOTE (TC-11): membership here means "a token the renderer KNOWS", not
 * "substituted at every site". `consent.body` carries `{cookiePolicy}`
 * and is not rendered anywhere — the live banner reads
 * `t("cookieConsent.body")` from i18n instead — so that string is dead
 * copy. Recorded in the launch audit rather than silently deleted.
 */
const SUBSTITUTED = new Set([
  "year", "company", "count", "price", "n",
  "privacy", "terms", "cookiePolicy",
]);

const PLACEHOLDER_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "bracketed placeholder", re: /\[[A-Z][^\]]{2,60}\]/ },
  { name: "lorem ipsum", re: /\blorem\s+ipsum\b/i },
  { name: "TBD / TODO / FIXME / XXX", re: /\b(TBD|TODO|FIXME|XXX)\b/ },
];

/** Walk every string in the nested copy object, remembering its path. */
function everyString(node: unknown, path: string, out: Array<[string, string]>): void {
  if (typeof node === "string") {
    out.push([path, node]);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => everyString(v, `${path}[${i}]`, out));
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      everyString(v, path ? `${path}.${k}` : k, out);
    }
  }
}

describe("no unreplaced placeholder reaches a public page", () => {
  const langs = Object.keys(LANDING_STRINGS) as Array<keyof typeof LANDING_STRINGS>;

  it("is not vacuous — there is copy in more than one language to scan", () => {
    expect(langs.length).toBeGreaterThanOrEqual(2);
    const all: Array<[string, string]> = [];
    everyString(LANDING_STRINGS, "", all);
    // The landing copy is large; a scan that found a handful of strings
    // would mean the walker broke, not that the copy is clean.
    expect(all.length).toBeGreaterThan(100);
  });

  for (const lang of langs) {
    it(`${String(lang)} landing copy carries no placeholder`, () => {
      const found: string[] = [];
      const strings: Array<[string, string]> = [];
      everyString(LANDING_STRINGS[lang], String(lang), strings);

      for (const [path, text] of strings) {
        for (const { name, re } of PLACEHOLDER_PATTERNS) {
          const m = text.match(re);
          if (m) found.push(`${path}: ${name} — ${JSON.stringify(m[0])} in ${JSON.stringify(text.slice(0, 110))}`);
        }
        // A template token nobody substitutes prints as literal braces.
        for (const m of text.matchAll(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g)) {
          if (!SUBSTITUTED.has(m[1])) {
            found.push(`${path}: unsubstituted token — {${m[1]}} in ${JSON.stringify(text.slice(0, 110))}`);
          }
        }
      }

      expect(
        found,
        `${String(lang)} landing copy printed ${found.length} placeholder(s) on a public page. ` +
          `Production carried "© 2026 CFO AI · [Company Legal Name]. All rights reserved." in the ` +
          `footer, directly above the real entity block. The entity is declared once, in ` +
          `content/legal/entity.json via lib/legalConfig.ts — read it from there:\n  ` +
          found.join("\n  "),
      ).toEqual([]);
    });
  }

  it("the copyright line names the real entity, in every language", () => {
    // The specific line that was wrong. Asserted by CONTENT, not by
    // absence of a bracket, so replacing one placeholder with another
    // cannot pass.
    for (const lang of langs) {
      const rights = LANDING_STRINGS[lang].footer.rights;
      expect(
        rights,
        `${String(lang)}: the copyright line must carry the {company} token so the ` +
          `renderer can substitute LEGAL_ENTITY.denumire; got ${JSON.stringify(rights)}`,
      ).toContain("{company}");
    }
  });
});
