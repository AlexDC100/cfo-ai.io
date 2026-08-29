# REPORT PAGES lane — critique r1

Shots: `design_review/report-pages-r1/` (live routes via `scripts/design_shots.mjs`,
data-dense states via `design_review/report-pages-probe.mjs` — see "test-mode
limits" below). Both themes, 1440/1280/390.

## Test-mode limits (why the probe exists)

- The engine cannot mint a test session in this stack (`/api/test-mode/session`
  → `VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY missing`), so `/report` and
  `/peer-report` render only their empty states in the live loop, and
  `/dashboard/public/TLV` renders only the "Nasdaq API key is not configured"
  error state. All three states shot and reviewed — they're real surfaces.
- The data-dense renderings are verified through the fixture probe
  (`report-pages-probe.mjs`), which intercepts `/api/period`,
  `/api/benchmarks/report` and `/api/public/companies` with Scandia/Transavia/
  TLV-flavored payloads. That's what fixture-*.png are.
- `/multi-year-history` is compile-time gated (`PUBLIC_RECORDS_ENABLED=false`
  in `frontend/config/features.ts`, not a lane file) → the router redirects to
  /dashboard, so the live shot shows the dashboard. The migrated page is
  covered by `frontend/pages/cfo/__tests__/multiYearHistory.smoke.test.tsx`
  (renders the fixture, asserts no serif / no legacy hex / mono figures).

## Hierarchy

- /report: the A3 eviction lands — eyebrow → 19px title → context line with
  mono period date; Export PDF is the single dark-primary, Print the outline.
  The old teal gradient hero is gone and the page now leads with the KPI
  ledger, which is where the reader's first question lives. GOOD.
- KPI strip: Core EBITDA carries the one brand rule (left border) — a single
  emphasized tile per row-set, consistent with the memo's "one headline"
  doctrine. Sub-lines carry the exact converted figure under the compacted
  group figure, so compaction loses nothing.
- Section bands: the navy eei-h2 bars are replaced with the 13px caps
  hairline headers used by the Benchmark/Peer memos — the numbered mono
  prefix keeps the "8 sections" identity without the paint.
- TLV overview: "Latest period / FY ending <mono date>" reads as a proper
  data line now, not a serif display moment.

## Density

- P&L / BS / CF tables are on the h-8 instrument grid with pl-8 indents,
  dashed reconciliation separators and bg-bg-2 subtotals — a screenful of
  P&L now fits ~19 rows where the eei table fit ~13. The 722 bridge rows
  read clearly subordinate (italic, muted, dashed).
- Ratios: five panels in a 3-col grid with h-8 rows — tight and scannable.

## Contrast / theme

- Dark theme is the real win: the eei-scope used to force paper-white into
  Terminal dark; the whole report now sits on token surfaces in both themes
  (checked crop-report-pnl-dark.png — subtotal tints, brand-tint EBITDA rows
  and the caution approx-banner all hold AA against bg).
- Severity semantics: risk inventory + recommendations now run
  alert(red)=critical, caution(amber)=high/medium, info/neutral=low — red is
  reserved for danger. Previously high/medium were brand teal (meaningless).
- MultiYear loss rows: bg-alert-tint + text-alert only on loss cells — red
  = losses only, per law.

## Soul / consistency

- Peer memo and Comprehensive report now share one vocabulary end-to-end
  (same section headers, same Panel tables, same chips). fixture-peer-report
  vs fixture-report side-by-side read as two documents from one instrument.
- Every figure in the lane is mono tabular via <Amount>/<MoneyAmount>/
  <PercentLevel>/<CappedMultiple>; magnitude groups per stat row (KPI strip,
  TLV overview rows, valuation money tiles) — "10.96 B RON" beside
  "5.73 B RON", never mixed scales.
- Verdict chips on the TLV ratios tab now flow through Chip tones
  (STRONG/HEALTHY=success, WATCH=caution, CRITICAL=alert) instead of inline
  hex styles.

## Defects found in r1 → fixed for r2

1. **PublicCompanyHeader collapses at 390px** — the "Add as peer"/"Refresh"
   cluster overlapped the meta column (no wrap, no basis floor). Fixed:
   `flex-wrap` on the header + `basis-[220px]` on the title block so the
   button cluster drops to its own row. (fixture-public-tlv-overview--mobile
   r1 vs r2.)
2. **GuideMe tour scrim occluded the /report header** in every probe shot —
   probe now pre-seeds `cfo:learning-mode:v1` (mode off, tutorials seen).
   Not a product defect; capture hygiene.

## Open nits (noted, deliberate)

- KPI grid on /report has 9 tiles → a lone Altman tile on the last row at
  4-col. Same as the legacy eei grid; not worth a bespoke breakpoint.
- CF row labels render "~ Δ Inventory" in approximated mode — the tilde is
  the honest-approximation mark from the methodology; kept.
- The peer table's "Financial impact" for capital-structure rows
  (equity-ratio gap × revenue) is an odd economic quantity — pre-existing
  engine-side semantics, out of lane scope.
