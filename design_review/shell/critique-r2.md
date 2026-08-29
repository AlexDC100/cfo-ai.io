# Shell — critique r2 (final)

- **Hierarchy** — Command deck reads in one sweep: context object → command bar → trust/actions. Rail groups (OVERVIEW/ANALYZE/EXPLORE/ASK, 10px caps) scan instantly; active row = 2px accent rule + ink text, verified on /settings and /chat (ASK group). Palette groups (Pages → Actions → Learn/Periods; Products/Companies on query) rank by frequency of use.
- **Density** — Palette rows now single-line 36px (label left, muted hint right, kbd chips for ⌘J/⌘.); 15 items fit without scroll. Rail 36px rows, 56px header — nothing padded for its own sake.
- **Contrast** — Own overlay (black/30) replaced the shared black/80: the glass panel (surface/0.9 + blur-xl + shadow-2xl) reads as the one floating layer in both Paper and Terminal; row text AA on both grounds. Focus pass: all 10 tab stops in header+rail show a visible ring; disabled rail items are skipped.
- **Soul** — One accent, used three ways only: active rule, Ask sparkles, brand chips. Collapse animation keeps icons dead-center at 64px; labels crossfade. RO verified end-to-end (SINTEZĂ/ANALIZĂ/EXPLOREAZĂ/ÎNTREABĂ, "Caută sau apasă ⌘K") — zero raw keys.
- **Consistency** — Context chip, command bar, kbd hints, popover, receipt sheet all share rounded-sm/hairline/mono idiom with Panel/Chip. Drawer preserved exactly (currency row, account row, notifications, 44px). TrustChip refuses to render on the legacy demo lane — no fake trust, unit-tested (7 tests).

**Pass.** Remaining items are cross-lane (CouncilSphereHost padding mirror, brand-d alias, SearchDialog deletion) and are reported, not patched here.
