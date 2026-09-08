// LegalFooter — the company-identification block, on every page.
//
// The owner's requirement is one line long and easy to under-read: the
// identification block goes on the marketing site AND the signed-in app.
// That is a Romanian trade-law obligation (Law 26/1990 art. 29 — a company's
// name, registration number and registered office on its published
// communications), not a design preference, which is why this is a component
// mounted app-wide rather than a block copied into two page templates.
//
// Every value comes from `lib/legalConfig`'s LEGAL_ENTITY through
// `entityLines()`. Nothing here is retyped, so filling in a share capital or
// correcting the office address is one edit, in one file, and it lands on
// every surface at once.
//
// The links use react-router <Link>, deliberately: a signed-in user clicking
// "Privacy" in the app footer must NOT get a full page load — that would
// tear down the React tree, re-run the whole boot (session restore, org
// resolution, period bootstrap) and drop them back at the top of a cold app.
// The prerendered static copies of the same pages exist for the cold,
// out-of-app arrival; in-app navigation stays client-side.

import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { LEGAL_DOC_IDS, LEGAL_ENTITY } from "@/lib/legalConfig";
import { SocialLinks } from "./SocialLinks";
import { docLangOf, documentLabel, entityLines, legalDocPath } from "@/lib/legalDocs";

export function LegalFooter({ className = "" }: { className?: string }) {
  const { i18n } = useTranslation();
  const lang = docLangOf(i18n.language);
  const lines = entityLines();
  const identity = lines.find((l) => l.id === "identity");
  const address = lines.find((l) => l.id === "address");

  return (
    <footer
      data-testid="legal-footer"
      className={`border-t border-rule-soft px-4 py-6 text-[11.5px] leading-relaxed text-ink-mute sm:px-8 ${className}`}
    >
      <div className="mx-auto flex max-w-[1760px] flex-col gap-1.5">
        {identity && (
          <div data-testid="legal-footer-identity" className="font-mono tracking-[0.02em]">
            {identity.text}
          </div>
        )}
        {address && <div data-testid="legal-footer-address">{address.text}</div>}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-0.5">
          {LEGAL_DOC_IDS.map((doc, i) => (
            <span key={doc} className="flex items-center gap-2">
              {i > 0 && <span aria-hidden>·</span>}
              <Link
                to={legalDocPath(doc)}
                data-testid={`legal-footer-link-${doc}`}
                className="text-ink-soft underline-offset-2 hover:text-ink hover:underline"
              >
                {documentLabel(doc, lang)}
              </Link>
            </span>
          ))}
          {LEGAL_ENTITY.legalEmail && (
            <span className="flex items-center gap-2">
              <span aria-hidden>·</span>
              <a
                href={`mailto:${LEGAL_ENTITY.legalEmail}`}
                data-testid="legal-footer-contact"
                className="text-ink-soft underline-offset-2 hover:text-ink hover:underline"
              >
                {LEGAL_ENTITY.legalEmail}
              </a>
            </span>
          )}
        </div>
        {/* Beneath the company-identification block, never inside it: the
            identity above is a legal declaration and this is a marketing
            affordance. Renders nothing at all when no handle is set. */}
        <SocialLinks className="pt-1" />
      </div>
    </footer>
  );
}

export default LegalFooter;
