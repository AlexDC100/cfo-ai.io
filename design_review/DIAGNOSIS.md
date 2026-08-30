# PART A — DIAGNOSIS (verified against source, 2026-08-30)

## Root cause: semantic misuse of `period_end_hint` by the FE.
NOT "detection is missing" and NOT "period inherited from the open
period". Detection EXISTS, is correctly ranked, and is being
deliberately overridden.

### The engine is correct (src/engine/api/pipeline.py stage_persist ~1536)
Ranked resolution, already matching Part B:
  1. documents.period_end_hint   -> "User-confirmed period-end wins"
  2. parsed.period_end           -> in-document / content date
  3. _detect_period_end_from_filename(original_filename)
  4. today (last resort, warned)
Its own comment: "When present it overrides both the extracted
(content) and filename-derived dates so the period is filed under
exactly the month THE USER CONFIRMED."
`period_end_hint` is therefore a CONFIRMATION channel: it means "a
human looked at this document and said it closes on this date."

### The frontend fills that channel with the DROP TARGET's date
frontend/components/cfo/workspace/PeriodsSection.tsx
  · line ~399  attachFileToPeriod(p, file):
        uploadDocument(file, { periodEndHint: p.period_end })
    -> p.period_end is the PERIOD ROW being dropped on, not anything
       read from the file.
  · line ~1163 the add/replace dialog:
        uploadDocument(file, { periodEndHint: periodEnd })
    -> periodEnd is the dialog's chosen month, not the document's.

### Therefore, exactly the reported defects
- "Carniprod Trial Balance 2025.xlsx" dropped on the Dec 2017 row
  sends periodEndHint=2017-12-31. The engine DOES parse 2025 from the
  content and DOES detect 2025 from the filename — then discards both,
  because it believes a human confirmed 2017. Silent, by construction.
- Two companies in Dec 2025: both files dropped on that month get the
  same hint, so both file there regardless of content. (stage_persist
  keys periods by (org, period_end, source_document_id), so each file
  gets its OWN period row; the workspace UI groups them by month, which
  is why they appear as one period holding two entities.)
- Upload/Replace offer no period picker: the hint is computed from UI
  context and never shown, so there is nothing to confirm or correct.

### Corollary (why this is a data-integrity bug, not cosmetics)
period_end is the period identity: it keys financial_periods, and thus
the snapshot key, the header context label, YoY, and Benchmark fiscal
alignment. A wrong hint mis-files all of them consistently, which is
exactly why nothing looked broken.

## The fix shape (what the wave must build)
period_end_hint must ONLY carry a value a human actually confirmed for
THAT document. The attach paths must instead:
  1. detect from the document (content > filename), 
  2. show the proposal + evidence,
  3. send the hint only after the user confirms/edits it,
  4. and guard the mismatch + entity cases explicitly.
Passing the target period's date as a "hint" is the defect; removing
that is the core fix. Everything else in Parts C–E is the UI that makes
the confirmed value real.
