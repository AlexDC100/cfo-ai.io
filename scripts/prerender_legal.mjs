// prerender_legal — write the legal documents into dist/ as real HTML files.
//
// ═══════════════════════════════════════════════════════════════════════
// THE PROBLEM, AND WHY THIS IS THE ANSWER
// ═══════════════════════════════════════════════════════════════════════
// The requirement is that `curl https://cfo-ai.io/privacy` returns 200 with
// the real text IN THE BYTES. This app is a Vite SPA: nginx serves one
// `index.html` for every unknown path and React fills it in afterwards. A
// crawler, a payment processor's compliance reviewer, an app-store form
// checker, or anyone running `curl` sees an empty `<div id="root">`.
//
// TWO WAYS TO FIX IT WERE ON THE TABLE.
//
//  (a) SERVE THEM FROM THE ENGINE, the way `src/engine/public_ro/pages/`
//      already server-renders 600k storefront pages. Read first, as
//      instructed. Rejected, for reasons that are about this repo and not
//      about taste:
//        · That precedent puts a Python FastAPI process on the critical
//          path of a static document. The engine going down would take
//          /privacy with it — and the launch already ships a header
//          indicator whose entire job is telling users the engine can be
//          down while the app keeps working.
//        · The public ingress is `scandia-caddy`, whose `@api` matcher
//          would need three more path patterns added on the VPS
//          (root CLAUDE.md §21 documents that file fronting the WHOLE
//          box). More operator surface, more to get wrong at 1am, for a
//          page whose content changes when a lawyer edits a markdown file.
//        · The engine has no i18n, no design tokens and no footer
//          component; it would grow a second rendering of the same
//          document, which is the exact divergence this lane exists to end.
//
//  (b) PRERENDER AT BUILD TIME (this file). The three documents are static:
//      they change when `content/legal/*.md` changes, i.e. at build time,
//      never at request time. Writing them as files means nginx's EXISTING
//      `try_files $uri $uri/ /index.html` serves a real file before it ever
//      reaches the SPA fallback, with no new process, no new proxy rule and
//      no runtime dependency. (An explicit nginx `location` was added too,
//      so the behaviour is stated rather than inherited from try_files
//      semantics — see nginx.conf and the operator delta in the report.)
//
// ═══════════════════════════════════════════════════════════════════════
// THE SPA ROUTE KEEPS WORKING — THAT IS A REQUIREMENT, NOT A SIDE EFFECT
// ═══════════════════════════════════════════════════════════════════════
// The generated file is the SPA's own `index.html` with two changes: the
// head gets this document's title/description/canonical/hreflang, and
// `<div id="root">` is pre-filled with the document. The module script tag
// is untouched, so React still boots and `react-router` still mounts
// LegalPage — which renders the identical `doc.html` string. A signed-in
// user clicking the footer link never loads any of this: react-router
// handles it client-side and the session is never touched.
//
// The static copy is inside `#root`, which React's `createRoot().render()`
// clears on mount. That is intentional and is why this is prerendering and
// not hydration: there is no hydration mismatch to get wrong, and the
// visible result is real text at first paint instead of a blank frame.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildDocuments, readEntity } from "./generate_legal_documents.mjs";

// See the note on findRoot() in generate_legal_documents.mjs — the same
// esbuild-inlining hazard applies here, because vite.config.ts imports this
// module too. ROOT is only used for the CLI's default dist/ path and for
// pretty-printing; the Vite plugin passes an absolute outDir.
const ROOT = (() => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "content", "legal", "entity.json"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return process.cwd();
})();
const SITE_ORIGIN = "https://cfo-ai.io";

/** Kept in sync with frontend/lib/legalConfig.ts::legalDocPath — the two
 *  URL families and the reason for each are documented there. */
const pathFor = (doc, lang) => (lang === "ro" ? `/ro/${doc}` : `/${doc}`);
const urlFor = (doc, lang) => `${SITE_ORIGIN}${pathFor(doc, lang)}`;

/** Kept in sync with frontend/lib/legalDocs.ts::documentLabel. Short footer
 *  labels, exactly as the owner wrote the footer line. */
const FOOTER_LABELS = {
  ro: { privacy: "Confidențialitate", terms: "Termeni", cookies: "Cookie-uri" },
  en: { privacy: "Privacy", terms: "Terms", cookies: "Cookies" },
};
const DOC_ORDER = ["privacy", "terms", "cookies"];

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Self-contained styling for the static copy. It CANNOT reference the app's
// stylesheet: that is a hashed asset the browser has not fetched at first
// paint, and the whole point of this file is that the document is readable
// from the bytes alone. Every selector is scoped under #legal-static, which
// stops existing the moment React mounts, so none of it can leak into the app.
const STATIC_CSS = `
#legal-static{max-width:840px;margin:0 auto;padding:48px 24px 64px;color:#1a1f1d;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:14.5px;line-height:1.75}
#legal-static a{color:#1E7A68}
#legal-static .ls-eyebrow{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:#6b7570}
#legal-static h1{font-size:32px;line-height:1.15;font-weight:500;margin:18px 0 6px;color:#0B0E0D}
#legal-static .ls-updated{font-size:12.5px;color:#6b7570;margin:0 0 28px}
#legal-static h2{font-size:22px;font-weight:500;margin:34px 0 10px;color:#0B0E0D}
#legal-static h3{font-size:15px;font-weight:600;margin:24px 0 8px;color:#0B0E0D}
#legal-static p{margin:0 0 14px}
#legal-static ul{margin:0 0 14px;padding-left:20px}
#legal-static li{margin:0 0 6px}
#legal-static hr{margin:34px 0;border:0;border-top:1px solid #dfe3e1}
#legal-static .legal-table{overflow-x:auto;margin:0 0 18px}
#legal-static table{width:100%;border-collapse:collapse;font-size:13px;min-width:420px}
#legal-static th,#legal-static td{text-align:left;padding:8px 12px;border-bottom:1px solid #dfe3e1;vertical-align:top}
#legal-static th{font-weight:600;white-space:nowrap}
#legal-static .ls-foot{margin-top:48px;padding-top:20px;border-top:1px solid #dfe3e1;font-size:11.5px;line-height:1.7;color:#6b7570}
#legal-static .ls-foot .ls-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
#legal-static .ls-ver{margin-top:14px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;color:#8a938e}
@media (prefers-color-scheme: dark){
#legal-static{color:#DBDBDB}
#legal-static h1,#legal-static h2,#legal-static h3,#legal-static th{color:#F5F5F5}
#legal-static a{color:#4BBFA8}
#legal-static hr,#legal-static th,#legal-static td,#legal-static .ls-foot{border-color:#252D2A}
}`.trim();

/** The company-identification block — the same three lines the React
 *  LegalFooter renders, from the same entity.json. */
function footerHtml(entity, lang) {
  const identity = [entity.denumire, entity.cui ? `CUI ${entity.cui}` : null, entity.regCom]
    .filter(Boolean)
    .map(esc)
    .join(" · ");
  const links = DOC_ORDER.map(
    (d) => `<a href="${pathFor(d)}">${esc(FOOTER_LABELS[lang][d])}</a>`,
  ).join(" · ");
  return `<div class="ls-foot">
<div class="ls-id">${identity}</div>
<div>${esc(entity.sediu)}</div>
<div>${links} · <a href="mailto:${esc(entity.legalEmail)}">${esc(entity.legalEmail)}</a></div>
</div>`;
}

function bodyHtml(doc, entity, lang) {
  const other = lang === "ro" ? "en" : "ro";
  const otherHref = other === "ro" ? pathFor(doc.doc, "ro") : pathFor(doc.doc);
  const otherLabel = other === "ro" ? "Română" : "English";
  const home = lang === "ro" ? "Acasă" : "Home";
  return `<div id="legal-static">
<div class="ls-eyebrow"><a href="/">CFO AI</a> · <a href="${otherHref}" hreflang="${other}">${otherLabel}</a></div>
<h1>${esc(doc.title)}</h1>
<p class="ls-updated">${esc(doc.updatedLabel)}</p>
<article class="legal-doc">
${doc.html}
</article>
<p class="ls-eyebrow" style="margin-top:36px">${DOC_ORDER.filter((d) => d !== doc.doc)
    .map((d) => `<a href="${pathFor(d, lang === "ro" ? "ro" : undefined)}">${esc(FOOTER_LABELS[lang][d])}</a>`)
    .join(" · ")} · <a href="/">${esc(home)}</a></p>
<div class="ls-ver">${esc(doc.version)}</div>
${footerHtml(entity, lang)}
</div>`;
}

/** Rewrite one head tag, replacing the value index.html shipped. */
function replaceTag(html, pattern, replacement) {
  return pattern.test(html) ? html.replace(pattern, replacement) : html;
}

export function renderPage(template, doc, entity, lang) {
  const canonical = urlFor(doc.doc, lang === "ro" ? "ro" : undefined);
  const title = `${doc.title} · CFO AI`;
  let html = template;

  // <html lang> must follow the document, not the SPA's default: a screen
  // reader pronouncing Romanian with English phonemes is unusable, and it is
  // the signal a crawler reads before anything else.
  html = replaceTag(html, /<html lang="[^"]*"/, `<html lang="${lang}"`);
  html = replaceTag(html, /<title>[\s\S]*?<\/title>/, `<title>${esc(title)}</title>`);
  html = replaceTag(
    html,
    /<meta\s+name="description"[\s\S]*?\/>/,
    `<meta name="description" content="${esc(doc.description)}" />`,
  );
  html = replaceTag(
    html,
    /<link rel="canonical" href="[^"]*" \/>/,
    `<link rel="canonical" href="${canonical}" />`,
  );
  html = replaceTag(
    html,
    /<meta property="og:title" content="[^"]*" \/>/,
    `<meta property="og:title" content="${esc(title)}" />`,
  );
  html = replaceTag(
    html,
    /<meta\s+property="og:description"[\s\S]*?\/>/,
    `<meta property="og:description" content="${esc(doc.description)}" />`,
  );
  html = replaceTag(
    html,
    /<meta property="og:url" content="[^"]*" \/>/,
    `<meta property="og:url" content="${canonical}" />`,
  );
  html = replaceTag(
    html,
    /<meta property="og:locale" content="[^"]*" \/>/,
    `<meta property="og:locale" content="${lang === "ro" ? "ro_RO" : "en_GB"}" />`,
  );

  // hreflang alternates — the RO ⇄ EN pair, plus x-default. Both files
  // carry the same set, which is what makes them a valid reciprocal pair.
  const alternates = [
    `<link rel="alternate" hreflang="en" href="${urlFor(doc.doc)}" />`,
    `<link rel="alternate" hreflang="ro" href="${urlFor(doc.doc, "ro")}" />`,
    `<link rel="alternate" hreflang="x-default" href="${urlFor(doc.doc)}" />`,
  ].join("\n    ");

  html = html.replace(
    "</head>",
    `    ${alternates}\n    <style>${STATIC_CSS}</style>\n  </head>`,
  );
  html = html.replace(
    '<div id="root"></div>',
    `<div id="root">${bodyHtml(doc, entity, lang)}</div>`,
  );
  return html;
}

export function prerenderLegal(distDir) {
  const templatePath = path.join(distDir, "index.html");
  if (!fs.existsSync(templatePath)) {
    throw new Error(`prerender_legal: ${templatePath} not found — run the build first`);
  }
  const template = fs.readFileSync(templatePath, "utf8");
  if (!template.includes('<div id="root"></div>')) {
    // Fail closed. A silently-unmatched anchor would ship six pages that
    // look right in the file listing and contain no text at all.
    throw new Error('prerender_legal: dist/index.html has no `<div id="root"></div>` anchor');
  }
  const entity = readEntity();
  const docs = buildDocuments();
  const written = [];
  for (const doc of docs) {
    // `/privacy` is served the ENGLISH rendering (it is also `x-default`);
    // `/ro/privacy` is the Romanian one. There is deliberately no
    // `/en/privacy` — see legalConfig.legalDocPath.
    const rel =
      doc.lang === "en"
        ? path.join(doc.doc, "index.html")
        : path.join("ro", doc.doc, "index.html");
    const out = path.join(distDir, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, renderPage(template, doc, entity, doc.lang), "utf8");
    written.push(rel);
  }
  return written;
}

function main() {
  const dist = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, "dist");
  const written = prerenderLegal(dist);
  console.log(`prerendered ${written.length} legal pages into ${path.relative(ROOT, dist)}/`);
  for (const w of written) console.log(`  ${w}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
