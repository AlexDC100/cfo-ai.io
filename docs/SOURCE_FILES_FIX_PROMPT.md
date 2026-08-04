# PROMPT — Kill the Dashboard "Source files" duplication; one honest source line

> Paste into a fresh Claude Code session in this repo. FRONTEND ONLY.
> Verify in Playwright (test mode, 390px + 1440px, RO + EN). Don't ask
> questions. Numbers rendered must not change.

## The problem (operator report, 2026-08-04)

The Dashboard's "Source files / Replace or add files" strip lists every
file uploaded for the month — including duplicates with identical names
(`Trial_Balance_Scandia_RealEstate_31.12.2025.xlsx` twice, different
upload dates). Clicking a tile only opens a PREVIEW; it does NOT choose
which file's data the dashboard shows. So the strip: (a) duplicates the
Workspace hub's months/files management, (b) implies a choice it cannot
make, (c) wastes the most valuable screen area on the page. The user
cannot tell which file the analysis actually came from.

## The fix — one way to do each thing

1. **Dashboard**: DELETE the multi-tile source-files strip
   (`SourceFilesRow` usage in `frontend/pages/cfo/FinancialStatements.tsx`,
   the "Fișiere sursă / Înlocuiți sau adăugați fișiere" block). Replace
   with ONE quiet source line under the period header, App-Store-credit
   style: `Sursă: <filename> · încărcat <date> · [Înlocuiește] ·
   [Gestionează fișierele →]`
   - `<filename>` = the document that BACKS the current analysis — the
     period payload / documents list already carries which doc produced
     the analyzed period (find the analyzed document row: status
     `analyzed`, `period_id` = active period; if several, the most
     recently analyzed one wins — that IS the one the engine used).
   - `Înlocuiește` opens the existing staged-upload flow (same handlers
     and testids the strip used — keep `source-files-add`/staged/start-scan
     wiring reachable from here).
   - `Gestionează fișierele →` links to `/workspace` with the period
     preselected (`?period=<id>`), where the full file list (preview,
     delete, multiple files) ALREADY lives. Do not rebuild management on
     the Dashboard.
2. **Workspace hub** stays the ONLY place that lists all files per month.
   Add there (if missing): an "Activ" badge on the file whose analysis
   the dashboard currently shows, so duplicates are distinguishable —
   same detection as above. Deleting the active file keeps the existing
   behavior (period re-analysis on next upload).
3. **Duplicate-upload guard (FE only)**: when the user stages a file whose
   name matches an existing document in the SAME period, show a gentle
   inline note in the confirm dialog: "Un fișier cu același nume există
   deja pentru această lună — scanarea îl va înlocui în analiză." (i18n,
   EN+RO). No new backend calls — the info is in the period's documents
   list.
4. **i18n**: all new strings via `t()` in both locales (informal RO,
   diacritics). No hardcoded literals.
5. **Do NOT touch**: the upload pipeline, enqueue logic, engine, or the
   Products/Variance dropzones (out of scope).

## Verification (required, loop until clean)

- Playwright test-mode walk: Dashboard at 390 + 1440, RO + EN — the strip
  is gone, the source line shows the analyzed file's name + date,
  Înlocuiește opens the staged flow, the Workspace link lands with the
  right period selected, "Activ" badge visible in Workspace on the right
  file, zero horizontal overflow, zero wrong-language words.
- Re-run the sweeps: `SWEEP_MODE=authed npx playwright test
  e2e/i18n-mobile-sweep.spec.ts --project=chromium` (and public). All green.
- `npx tsc --noEmit -p tsconfig.json` clean; `npm run build` + boot-test
  `dist/` in a real browser (CLAUDE.md §19 — build success alone proves
  nothing).
- Commit with screenshots in the report; push; deploy via
  `./scripts/deploy.sh --yes`; confirm F-A3.1 stays GREEN.
