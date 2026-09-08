// SOCIAL LINKS — one implementation, two footers, zero hardcoded URLs.
//
// The marketing footer and the signed-in app footer both render this, so
// the markup, the accessible names and the tap targets cannot drift apart
// the way the two report renderers did.
//
// EVERY URL COMES FROM `lib/legalConfig`'s `socialLinks()`, which reads
// `content/legal/entity.json` — the same single authority that carries the
// company's legal identity. A handle that is null, empty, "#" or half-typed
// renders NOTHING: no icon, no dead link, no placeholder. That rule is not
// fussiness. On 2026-09-08 the production footer shipped the literal string
// "[Company Legal Name]" forty pixels above the block rendering the real
// entity, and the repair was to make absence render as absence. An icon
// pointing at "#" is the same defect wearing a different shape.
//
// `socialLinksFromConfig.test.ts` fails on any social URL found anywhere
// else in the tree, so the next person cannot reintroduce the class by
// typing a handle into a component.

import { useTranslation } from "react-i18next";

import { socialLinks, type SocialHandles } from "@/lib/legalConfig";

/** Accessible names, both languages. Keyed by handle so a new network
 *  cannot ship without one — TypeScript requires the entry. */
const LABELS: Record<keyof SocialHandles, { en: string; ro: string }> = {
  x: {
    en: "Parachain Group on X",
    ro: "Parachain Group pe X",
  },
  instagram: {
    en: "Parachain Group on Instagram",
    ro: "Parachain Group pe Instagram",
  },
};

/** 20px glyphs, drawn inline rather than pulled from an icon pack: these
 *  two marks are brand assets with fixed shapes, and a pack swap silently
 *  changing them is a worse outcome than eleven lines of path data. */
function Glyph({ network }: { network: keyof SocialHandles }) {
  const common = {
    width: 20,
    height: 20,
    viewBox: "0 0 24 24",
    "aria-hidden": true as const,
    focusable: "false" as const,
  };
  if (network === "x") {
    return (
      <svg {...common} fill="currentColor">
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
      </svg>
    );
  }
  return (
    <svg {...common} fill="none" stroke="currentColor" strokeWidth={1.9}
         strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="20" height="20" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.5" cy="6.5" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function SocialLinks({ className = "" }: { className?: string }) {
  const { i18n } = useTranslation();
  const lang = i18n.language?.toLowerCase().startsWith("ro") ? "ro" : "en";
  const links = socialLinks();

  // NOTHING, not an empty row. An empty flex container still occupies its
  // gap and its padding, which is how a "no links" state comes to look
  // like a broken one.
  if (links.length === 0) return null;

  return (
    <div
      data-testid="social-links"
      // Centred on mobile, right-aligned from sm up — the identity block
      // above it is left-aligned on desktop, so the row reads as a
      // separate thing rather than a continuation of the address.
      className={`flex items-center justify-center gap-1 sm:justify-end ${className}`}
    >
      {links.map(({ key, href }) => (
        <a
          key={key}
          href={href}
          target="_blank"
          // noopener is the security half (the opened page cannot reach
          // back through window.opener); noreferrer is the privacy half.
          rel="noopener noreferrer"
          aria-label={LABELS[key][lang]}
          data-testid={`social-link-${key}`}
          // 44px is the tap-target floor; the GLYPH stays 20px and the
          // padding carries the rest, so the icon does not grow on mobile.
          className="inline-flex h-11 w-11 items-center justify-center rounded-md text-ink-mute transition-colors duration-micro hover:text-brand-dark focus-visible:text-brand-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 dark:hover:text-brand-light dark:focus-visible:text-brand-light sm:h-9 sm:w-9"
        >
          <Glyph network={key} />
        </a>
      ))}
    </div>
  );
}

export default SocialLinks;
