// Single source of truth for site-wide URLs + identity strings.
//
// Every component that needs the domain, API host, support email,
// or any other site-identifying string imports from here. NEVER
// hardcode the domain elsewhere — that's how migrations break.
//
// Lint enforcement (eslint.config — see DOMAIN_MIGRATION.md):
//   `no-restricted-syntax` rule against literal "cfo-ai.io" outside
//   this file flags any re-introduction of hardcoded references.
//
// Environment variables shape (Vite — VITE_ prefix is required for
// browser-bundle exposure):
//   VITE_SITE_DOMAIN  — "cfo-ai.io" / "staging.cfo-ai.io" / "localhost:5173"
//   VITE_SITE_URL     — full URL with scheme, no trailing slash
//   VITE_API_URL      — backend base URL (FE fetcher consumes this)
//
// Defaults fall back to production cfo-ai.io so a fresh dev clone with
// no .env still resolves to a working set of URLs (just hitting the
// wrong target — set up local .env to point at localhost).

const env = import.meta.env;

export const SITE = {
  /** Bare hostname (no scheme, no path). Used in meta tags + cookie scoping. */
  domain: (env.VITE_SITE_DOMAIN as string | undefined) ?? "cfo-ai.io",
  /** Full canonical site URL with scheme, no trailing slash. */
  url: (env.VITE_SITE_URL as string | undefined) ?? "https://cfo-ai.io",
  /** Backend API base URL. FE fetcher (src/lib/api.ts, src/lib/rates.ts) consumes this. */
  apiUrl: (env.VITE_API_URL as string | undefined) ?? "https://api.cfo-ai.io",
  /** Product name for headings + email "from" friendly name. */
  appName: "CFO AI",
  /** Legal entity name for footers + Terms / Privacy boilerplate. */
  legalName: "CFO AI",
  /** Contact addresses. `contact@` is the canonical inbox (single mailbox
   *  for support, sales, billing, legal — manually triaged today; if
   *  volume splits we add separate aliases later, but the FE still reads
   *  `supportEmail` so we change one constant and the whole app updates). */
  supportEmail: "contact@cfo-ai.io",
  /** Mailto URL — prefer this in href attributes so we don't sprinkle
   *  `mailto:` literals across the FE. Composes prefilled mailtos via
   *  `${SITE.supportMailto}?subject=...&body=...` at the call site. */
  supportMailto: "mailto:contact@cfo-ai.io",
  noreplyEmail: "noreply@cfo-ai.io",
  /** Social handle (used in Twitter card meta + footer). Update once @cfoai
   *  is verified across platforms; for now keep as placeholder. */
  twitterHandle: "@cfoai",
  /** Documentation / help center root. */
  docsUrl: "https://cfo-ai.io/docs",
} as const;

/** Type for the SITE record — useful in components that read individual
 *  fields and want TS to enforce they're using a real key. */
export type SiteConfig = typeof SITE;
