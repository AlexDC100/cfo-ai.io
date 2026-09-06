// The legal documents, as the app actually renders them.
//
// WHY THIS EXISTS ALONGSIDE THE GATE
// ==================================
// `scripts/check_legal_published.mjs` scans the PRERENDERED bytes — what
// nginx serves to a crawler, a regulator or a `curl`. It cannot see the other
// half: what react-router mounts when a signed-in user clicks the footer
// link. That half is a different implementation of the page chrome, and it is
// the one every logged-in customer reads.
//
// So this suite asserts on the MOUNTED DOM (TC-7): the reviewed sentence is
// on screen, the placeholder page that used to live here is gone, the
// operator is identified, and the consent record carries a version that can
// be resolved back to a document. It asserts the CLAIM in each case — the
// rendered sentence, the recorded identifier — never a shape property like
// "the object has a `version` key".

import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderWithProviders } from "@/test/renderWithProviders";
import LegalPage from "@/pages/cfo/LegalPage";
import { LegalFooter } from "@/components/cfo/LegalFooter";
import { LEGAL_DOCUMENTS, legalDocument } from "@/lib/legalDocuments.generated";
import { LEGAL_ENTITY, legalBlockers, legalDocPath, legalHreflangs } from "@/lib/legalConfig";
import { buildConsentRecord, CONSENTED_DOCS } from "@/lib/legalConsent";
import {
  analyticsAllowed,
  readCookieConsent,
  saveCookieConsent,
  CONSENT_KEY,
  loadAnalyticsIfConsented,
} from "@/lib/cookieConsent";
import i18n from "@/i18n";

/** The same three triggers the shipped gate reds on, applied to the DOM. */
const TRIGGERS: Array<[string, RegExp]> = [
  ["bracket", /[[\]]/],
  ["draft", /\bdrafts?\b/i],
  ["placeholder", /\b(TODO|TBD|FIXME|XXX|PLACEHOLDER|LOREM IPSUM|TEXT REQUIRED|not supplied)\b|\{\{|<%/i],
];

describe("legal pages — what the app renders", () => {
  beforeEach(() => {
    localStorage.clear();
    void i18n.changeLanguage("en");
  });

  it("renders the reviewed Privacy Policy, not a placeholder", () => {
    renderWithProviders(<LegalPage doc="privacy" />);
    const body = screen.getByTestId("legal-body");
    // A sentence that exists only in the owner's reviewed text.
    expect(body.textContent).toContain(
      "Your financial data is not used to train artificial intelligence models",
    );
    // The block this page used to render instead of a document.
    expect(screen.queryByTestId("legal-text-required")).toBeNull();
  });

  it("renders the Romanian text when the URL pins Romanian", () => {
    renderWithProviders(<LegalPage doc="terms" lang="ro" />);
    expect(screen.getByTestId("legal-body").textContent).toContain(
      "aveți la dispoziție 30 de zile pentru exportul datelor",
    );
    expect(screen.getByTestId("legal-page").getAttribute("data-legal-lang")).toBe("ro");
  });

  it("follows the app's language setting on the un-pinned URL", async () => {
    await i18n.changeLanguage("ro");
    renderWithProviders(<LegalPage doc="privacy" />);
    expect(screen.getByTestId("legal-page").getAttribute("data-legal-lang")).toBe("ro");
    expect(screen.getByTestId("legal-body").textContent).toContain(
      "Datele dumneavoastră financiare nu sunt folosite pentru antrenarea modelelor",
    );
  });

  it.each(["privacy", "terms", "cookies"] as const)(
    "%s carries no bracket, no 'draft', no placeholder marker in the DOM",
    (doc) => {
      renderWithProviders(<LegalPage doc={doc} />);
      const text = screen.getByTestId("legal-page").textContent ?? "";
      for (const [name, re] of TRIGGERS) {
        const m = re.exec(text);
        expect(
          m,
          `${doc} renders ${name}: ${JSON.stringify(text.slice(Math.max(0, (m?.index ?? 0) - 60), (m?.index ?? 0) + 60))}`,
        ).toBeNull();
      }
    },
  );

  it("prints the operator's identity and the version on the page", () => {
    renderWithProviders(<LegalPage doc="cookies" />);
    expect(screen.getByTestId("legal-footer-identity").textContent).toBe(
      "PARACHAIN CAPITAL S.R.L. · CUI 45298544 · J2021021081405",
    );
    expect(screen.getByTestId("legal-footer-address").textContent).toBe(
      "Intrarea Bitolia nr. 32, Sector 1, București, România",
    );
    expect(screen.getByTestId("legal-version").textContent).toBe(
      legalDocument("cookies", "en").version,
    );
  });

  it("sets the document title, description and both hreflang alternates", () => {
    renderWithProviders(<LegalPage doc="terms" />);
    expect(document.title).toBe("Terms of Service · CFO AI");
    const desc = document.head.querySelector('meta[name="description"]');
    expect(desc?.getAttribute("content")).toBe(legalDocument("terms", "en").description);
    for (const alt of legalHreflangs("terms")) {
      const link = document.head.querySelector(`link[rel="alternate"][hreflang="${alt.hreflang}"]`);
      expect(link?.getAttribute("href"), `hreflang ${alt.hreflang}`).toBe(alt.href);
    }
  });

  it("has nothing blocking publication", () => {
    expect(legalBlockers()).toEqual([]);
  });
});

describe("the footer, on every page", () => {
  beforeEach(() => void i18n.changeLanguage("en"));

  it("links all three documents plus the contact mailbox", () => {
    renderWithProviders(<LegalFooter />);
    const footer = screen.getByTestId("legal-footer");
    for (const doc of ["privacy", "terms", "cookies"] as const) {
      expect(within(footer).getByTestId(`legal-footer-link-${doc}`)).toHaveAttribute(
        "href",
        legalDocPath(doc),
      );
    }
    expect(within(footer).getByTestId("legal-footer-contact")).toHaveAttribute(
      "href",
      `mailto:${LEGAL_ENTITY.legalEmail}`,
    );
  });

  it("prints the owner's line in Romanian too", async () => {
    await i18n.changeLanguage("ro");
    renderWithProviders(<LegalFooter />);
    const footer = screen.getByTestId("legal-footer");
    // The exact labels the owner specified for the footer line.
    expect(within(footer).getByTestId("legal-footer-link-privacy").textContent).toBe(
      "Confidențialitate",
    );
    expect(within(footer).getByTestId("legal-footer-link-terms").textContent).toBe("Termeni");
    expect(within(footer).getByTestId("legal-footer-link-cookies").textContent).toBe("Cookie-uri");
    await i18n.changeLanguage("en");
  });
});

describe("the signup consent sentence", () => {
  // The owner specified the sentence verbatim. It is assembled from four
  // translation keys so both document names can be links inside it, which
  // makes it possible for a well-meaning edit to one key to break the
  // sentence without breaking anything that looks like a test. This asserts
  // the SENTENCE, not the keys.
  it.each([
    ["en", "By creating an account I accept the Terms and the Privacy Policy"],
    ["ro", "Prin crearea contului accept Termenii și Politica de confidențialitate"],
  ])("reads exactly right in %s", async (lang, expected) => {
    await i18n.changeLanguage(lang);
    const t = i18n.getFixedT(lang);
    const sentence = [
      t("legalX.consent_pre"),
      t("legalX.consent_terms"),
      t("legalX.consent_mid"),
      t("legalX.consent_privacy"),
    ].join(" ");
    expect(sentence).toBe(expected);
    await i18n.changeLanguage("en");
  });
});

describe("consent records name a reproducible version", () => {
  it("records the Terms and the Privacy Policy with their published hashes", () => {
    const record = buildConsentRecord("en");
    expect(record.documents.map((d) => d.doc)).toEqual(CONSENTED_DOCS);
    for (const accepted of record.documents) {
      const published = legalDocument(accepted.doc, "en");
      // The recorded identifier must resolve to a real published document —
      // that is the whole point of storing a version rather than a boolean.
      expect(accepted.version).toBe(published.version);
      expect(accepted.sha256).toBe(published.sha256);
      expect(accepted.published).toBe(published.published);
      // And the identifier must be reproducible FROM the hash it names.
      expect(accepted.version).toContain(accepted.sha256.slice(0, 12));
    }
    expect(Date.parse(record.accepted_at)).not.toBeNaN();
  });

  it("records the Romanian versions for a Romanian reader", () => {
    const record = buildConsentRecord("ro-RO");
    expect(record.ui_language).toBe("ro");
    expect(record.documents.every((d) => d.lang === "ro")).toBe(true);
    // The two languages are separate texts, so they must not share a version.
    expect(record.documents[0].version).not.toBe(legalDocument("terms", "en").version);
  });

  it("every published document has a distinct version identifier", () => {
    const versions = Object.values(LEGAL_DOCUMENTS).map((d) => d.version);
    expect(new Set(versions).size).toBe(versions.length);
  });
});

describe("cookie consent", () => {
  beforeEach(() => localStorage.clear());

  it("says NO before the visitor has answered", () => {
    expect(readCookieConsent()).toBeNull();
    expect(analyticsAllowed()).toBe(false);
    // The wall must refuse, not merely report.
    expect(loadAnalyticsIfConsented()).toBe(false);
  });

  it("records the Cookie Policy version the choice was made against", () => {
    const saved = saveCookieConsent(true, "ro");
    expect(saved.policyVersion).toBe(legalDocument("cookies", "ro").version);
    expect(analyticsAllowed()).toBe(true);
    expect(loadAnalyticsIfConsented()).toBe(true);
  });

  it("keeps a pre-versioning choice instead of re-prompting, and says it cannot name the version", () => {
    // The exact shape Landing.tsx wrote before this pass.
    localStorage.setItem(
      CONSENT_KEY,
      JSON.stringify({ analytics: true, marketing: true, ts: 1757000000000 }),
    );
    const migrated = readCookieConsent();
    expect(migrated?.analytics).toBe(true);
    expect(migrated?.migratedFrom).toBe("v1");
    // Honest: we do not know which text they were shown.
    expect(migrated?.policyVersion).toBeNull();
  });

  it("a declined choice stays declined across a reload", () => {
    saveCookieConsent(false, "en");
    expect(readCookieConsent()?.analytics).toBe(false);
    expect(analyticsAllowed()).toBe(false);
  });

  it("survives storage that throws", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("private mode");
    });
    expect(readCookieConsent()).toBeNull();
    expect(analyticsAllowed()).toBe(false);
    spy.mockRestore();
  });
});
