// Terms of Service — the canonical text, as data.
//
// Kept as structured sections rather than a blob of HTML because two very
// different surfaces render it:
//   · the marketing site's /#/terms page (Landing.tsx), which builds HTML
//     strings with inline styles against the `.cfo-site` CSS variables
//   · the signup consent modal (components/cfo/TermsDialog), which is a
//     React component inside the app, where those `var(--ink)` colours are
//     NOT defined the same way (the app declares them as HSL triplets used
//     via `hsl(var(--brand))`, the landing uses them as whole colours).
// Pasting the landing's HTML into the app modal would render with broken
// colours, and re-typing the text would give the product two versions of a
// legal document that silently drift apart.
//
// ⚠ NOT YET LEGALLY REVIEWED. The `[bracketed]` placeholders are real
// blanks — company legal name, jurisdiction — carried over verbatim from
// the existing Landing.tsx copy. Fill them in and have a lawyer review
// before this is relied on. `TERMS_PLACEHOLDER_WARNING` below is exported
// so a surface can choose to show that caveat.
//
// ⚠ DRIFT: Landing.tsx still holds its own hand-written HTML copy of this
// text (its `TERMS` const). Converting that page to render from this module
// is the follow-up that closes the duplication; until then, an edit here
// must be mirrored there.

export interface LegalSection {
  heading: string;
  /** Paragraphs, in order. Plain text — no markup. */
  body: string[];
}

export const TERMS_EFFECTIVE = "2026-07-27";

export const TERMS_PLACEHOLDER_WARNING =
  "Draft. Bracketed values are placeholders pending legal review.";

export const TERMS_SECTIONS: LegalSection[] = [
  {
    heading: "1. Agreement",
    body: [
      "These Terms govern your use of CFO AI, operated by [Company Legal Name]. By creating an account or using the service, you agree to these Terms and to our Privacy Policy.",
    ],
  },
  {
    heading: "2. The service",
    body: [
      "CFO AI provides AI-assisted financial analysis, benchmarking and reporting from data you upload and from public-company sources. Features and limits depend on your subscription plan.",
    ],
  },
  {
    heading: "3. Accounts",
    body: [
      "You are responsible for the accuracy of your account information, for keeping your credentials secure, and for all activity under your account. You must be at least 18 and authorised to accept these Terms on behalf of your organisation.",
    ],
  },
  {
    heading: "4. Subscriptions & billing",
    body: [
      "Paid plans are billed in advance on a monthly or annual basis. Trials convert to a paid subscription unless cancelled before they end. Fees are non-refundable except where required by law.",
      "Overage documents are charged per-document at the rate shown and confirmed before processing. We may change pricing with reasonable notice.",
    ],
  },
  {
    heading: "5. Acceptable use",
    body: [
      "You may not misuse the service, including by attempting to breach security, reverse-engineering the platform, reselling access without authorisation, or uploading data you have no right to process.",
      "You retain ownership of the data you upload and grant us a limited licence to process it solely to provide the service.",
    ],
  },
  {
    heading: "6. Not professional advice",
    body: [
      "CFO AI produces AI-assisted analysis and decision support. It is not financial, investment, legal, tax or accounting advice. Outputs may contain errors or approximations, which we flag where identified.",
      "Final decisions remain with you and your management team, and you should consult qualified professionals before acting.",
    ],
  },
  {
    heading: "7. Intellectual property",
    body: [
      "The platform, its software and its branding are owned by [Company Legal Name]. These Terms grant you a limited, non-exclusive, non-transferable right to use the service during your subscription.",
    ],
  },
  {
    heading: "8. Disclaimers & liability",
    body: [
      'The service is provided "as is" to the fullest extent permitted by law. To the maximum extent permitted, our total liability arising out of the service is limited to the fees you paid in the 12 months preceding the claim.',
      "Nothing in these Terms excludes liability that cannot be excluded by law.",
    ],
  },
  {
    heading: "9. Termination",
    body: [
      "You may cancel at any time from your account settings. We may suspend or terminate access for breach of these Terms. On termination, your data is handled as described in the Privacy Policy.",
    ],
  },
  {
    heading: "10. Governing law",
    body: [
      "These Terms are governed by the laws of [Country/Jurisdiction], and disputes are subject to the exclusive jurisdiction of the courts of [City, Country], without prejudice to your mandatory consumer rights.",
    ],
  },
  {
    heading: "11. Contact",
    body: ["Questions about these Terms? Email legal@cfo-ai.io."],
  },
];
