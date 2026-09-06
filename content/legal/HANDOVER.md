# Legal pages — handover to Claude Code

Five files, ready to publish. Company details are filled in throughout;
nothing is left as a placeholder.

| File | Route |
|---|---|
| `privacy-ro.md` / `privacy-en.md` | `/privacy` |
| `terms-ro.md` / `terms-en.md` | `/terms` |
| `cookies-ro.md` (bilingual, RO then EN) | `/cookies` |

## Company identification for the footer

Render on every page, in both languages:

```
PARACHAIN CAPITAL S.R.L. · CUI 45298544 · J2021021081405
Intrarea Bitolia nr. 32, Sector 1, București, România
Confidențialitate · Termeni · Cookie-uri · contact@cfo-ai.io
```

## Requirements for the implementation

1. **Server-rendered and linkable.** `/privacy`, `/terms`, `/cookies` must
   return 200 with real content — not a client-side hash route, not the
   SPA 404. Indexable, with correct `<title>` and meta description.
2. **Bilingual**, following the app's existing language setting, with
   `hreflang` alternates between the RO and EN versions.
3. **Footer links** on every page, including the marketing site and the
   signed-in app.
4. **Signup consent line**: "Prin crearea contului accept Termenii și
   Politica de confidențialitate" / "By creating an account I accept the
   Terms and the Privacy Policy", with both words linked. Record the
   timestamp and the document version accepted, per user.
5. **Cookie banner** consistent with `cookies-ro.md`: strictly necessary
   and preference cookies load by default; analytics only after consent;
   the choice is changeable under Settings.
6. **Version the documents.** Store the publication date and a hash of
   each document so that the version a user accepted can be reproduced
   later.
7. **The gate stands**: a published legal page containing a bracket,
   the word "draft", or any placeholder marker fails the build.

## Two mailboxes to create before publishing

- `privacy@cfo-ai.io` — referenced in the Privacy and Cookie policies
- `contact@cfo-ai.io` — referenced in the Terms

Both must actually receive mail; the Privacy Policy commits to a 30-day
response window on data subject requests.

## Three commitments the product must keep

These are written into the documents, so the product has to match them:

- **Account deletion in-app**, deleting uploaded documents and analyses
  within 30 days (Privacy §7, §8).
- **Data export** available to the user for 30 days after termination
  (Terms §11).
- **Backups retained no longer than 35 days** (Privacy §7) — confirm this
  matches the actual backup configuration, and change whichever is wrong.

## Note

Drafted for a Romanian B2B SaaS, GDPR-shaped, covering the controller /
processor split for accountants uploading client documents. It is a solid
v1 written to be honest and specific rather than generic. Have a Romanian
lawyer review it before or shortly after launch, particularly the
liability cap in Terms §9 and the consumer-law wording in Terms §7.
