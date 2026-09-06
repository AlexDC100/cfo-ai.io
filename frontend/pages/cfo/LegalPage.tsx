// LegalPage — /privacy, /terms, /cookies (and the /ro/* language-pinned twins).
//
// WHAT CHANGED ON 2026-09-06
// ==========================
// This page used to contain NO legal text at all: the documents were still
// the owner's item, so it rendered a marked "TEXT REQUIRED" block rather than
// invent prose with legal force. The owner has now supplied the reviewed
// text (content/legal/*.md), so the page renders it — and still contains no
// prose of its own. Everything below the heading comes from
// `legalDocuments.generated.ts`, which is generated from that markdown; this
// file owns only chrome.
//
// TWO RENDERINGS, ONE TEXT
// ========================
// The same document HTML is served two ways, and it is important to know
// which is which:
//   · COLD ARRIVAL (a crawler, a regulator, `curl https://cfo-ai.io/privacy`)
//     gets a PRERENDERED static file written at build time by the Vite plugin
//     in vite.config.ts. The text is in the served bytes; no JavaScript has
//     to run for it to be readable.
//   · IN-APP NAVIGATION (a signed-in user clicking the footer link) never
//     touches the server: react-router mounts this component and it injects
//     the identical `doc.html` string.
// Both read the same generated module, so they cannot disagree — and the
// gate (scripts/check_legal_published.mjs) scans the SERVED BYTES, which is
// the surface a stranger actually reads.
//
// `dangerouslySetInnerHTML` is correct here and not a shortcut: the HTML is
// produced at build time by scripts/legal_markdown.mjs from repo-controlled
// files, with unconditional escaping of `&<>"` and a closed tag set. There is
// no user input anywhere in this path.

import { useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { setLanguage } from "@/i18n";
import { LegalFooter } from "@/components/cfo/LegalFooter";
import {
  LEGAL_DOC_IDS,
  legalDocPath,
  legalDocUrl,
  legalHreflangs,
  type LegalDocId,
  type LegalLang,
} from "@/lib/legalConfig";
import { docLangOf, documentLabel, legalDocument } from "@/lib/legalDocs";

/** Replace (or create) a single <meta name=…> / <link rel=…> in <head>.
 *  Tagged with `data-legal` so the page can clear exactly what it added and
 *  never strip a tag index.html shipped. */
function setHeadTag(
  tag: "meta" | "link",
  match: Record<string, string>,
  attrs: Record<string, string>,
): void {
  const selector =
    tag +
    Object.entries(match)
      .map(([k, v]) => `[${k}="${v}"]`)
      .join("");
  let el = document.head.querySelector<HTMLElement>(selector);
  if (!el) {
    el = document.createElement(tag);
    Object.entries(match).forEach(([k, v]) => el!.setAttribute(k, v));
    el.setAttribute("data-legal", "1");
    document.head.appendChild(el);
  }
  Object.entries(attrs).forEach(([k, v]) => el!.setAttribute(k, v));
}

export function LegalPage({ doc, lang: pinned }: { doc: LegalDocId; lang?: LegalLang }) {
  const navigate = useNavigate();
  const { i18n } = useTranslation();
  // A `/ro/...` URL pins the language: that is the only thing an hreflang
  // alternate is allowed to mean. Everywhere else the page follows the app's
  // own language setting, which i18n already owns.
  const lang: LegalLang = pinned ?? docLangOf(i18n.language);
  const d = legalDocument(doc, lang);
  const other: LegalLang = lang === "ro" ? "en" : "ro";

  useEffect(() => {
    const prevTitle = document.title;
    document.title = `${d.title} · CFO AI`;
    setHeadTag("meta", { name: "description" }, { content: d.description });
    setHeadTag("link", { rel: "canonical" }, { href: legalDocUrl(doc, pinned) });
    for (const alt of legalHreflangs(doc)) {
      setHeadTag("link", { rel: "alternate", hreflang: alt.hreflang }, { href: alt.href });
    }
    return () => {
      document.title = prevTitle;
      // Only the alternates are ours to remove — description and canonical
      // exist in index.html and are restored by whichever page mounts next.
      document.head
        .querySelectorAll('link[data-legal="1"][rel="alternate"]')
        .forEach((el) => el.remove());
    };
  }, [doc, pinned, d.title, d.description]);

  return (
    <div className="flex min-h-screen flex-col bg-bg text-ink">
      <main
        data-testid="legal-page"
        data-legal-doc={doc}
        data-legal-lang={lang}
        data-legal-version={d.version}
        className="mx-auto w-full max-w-[840px] flex-1 px-6 py-12 sm:px-8"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => navigate("/")}
            className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-mute hover:text-ink"
          >
            CFO AI
          </button>

          {/* Language switch. On the un-pinned URL it goes through the app's
              OWN setLanguage() — the same function the footer switcher and
              Settings call — so reading the policy in Romanian and then
              carrying on in the app keeps one language, rather than this
              page inventing a second mechanism. From a pinned /ro/ URL there
              is nothing to toggle in place, so it navigates to the other
              document URL. */}
          <button
            type="button"
            data-testid="legal-lang-switch"
            onClick={() => {
              if (pinned) navigate(legalDocPath(doc, other === "ro" ? "ro" : undefined));
              else setLanguage(other);
            }}
            className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-soft hover:text-ink"
          >
            {other === "ro" ? "Română" : "English"}
          </button>
        </div>

        {/* Sans, not the serif display voice. Two reasons and they agree:
            design-lint D10-SERIF reserves serif for marketing surfaces and
            this route is reachable signed-in, and the prerendered static copy
            of this same page has no webfont available at first paint — a
            serif heading there would repaint when the font arrives, on the
            one surface whose whole purpose is being readable immediately. */}
        <h1 className="mt-5 text-[30px] font-medium leading-tight tracking-[-0.01em] text-ink sm:text-[34px]">
          {d.title}
        </h1>
        <p data-testid="legal-updated" className="mt-2 text-[12.5px] text-ink-mute">
          {d.updatedLabel}
        </p>

        {/* The reviewed text. Nothing on this page paraphrases it. */}
        <article
          data-testid="legal-body"
          className="legal-doc mt-8"
          dangerouslySetInnerHTML={{ __html: d.html }}
        />

        <nav className="mt-12 flex flex-wrap gap-4 border-t border-rule-soft pt-6 text-[13px]">
          {LEGAL_DOC_IDS.filter((x) => x !== doc).map((x) => (
            <Link key={x} to={legalDocPath(x)} className="text-ink-soft hover:text-ink">
              {documentLabel(x, lang)}
            </Link>
          ))}
          <Link to="/" className="text-ink-soft hover:text-ink">
            {lang === "ro" ? "Acasă" : "Home"}
          </Link>
        </nav>

        {/* The exact version a reader is looking at. This is not decoration:
            a consent record stores this identifier (see lib/legalConsent.ts),
            so being able to see it on the page is what makes "the version you
            accepted" checkable by the person who accepted it. */}
        <p data-testid="legal-version" className="mt-6 font-mono text-[10.5px] text-ink-mute">
          {d.version}
        </p>
      </main>

      <LegalFooter />
    </div>
  );
}

export default LegalPage;
