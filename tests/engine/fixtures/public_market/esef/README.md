# ESEF real-bytes fixtures — filings.xbrl.org

Every file in this directory is REAL BYTES fetched live from
filings.xbrl.org (this repo has twice been burned by idealized
fixtures — spec labels, BOM encodings — so adapter fixtures are
committed exactly as the wire served them, truncation excepted and
documented below).

Fetched: 2026-08-29, with the polite client header
`User-Agent: cfo-ai.io engine (contact: ad.crestin@gmail.com)`.

## Source terms

filings.xbrl.org "About" page (https://filings.xbrl.org/docs/about),
retrieved 2026-08-29, states verbatim:

> Terms of use
> At present, there are no restrictions on the ways that the data can
> be used.

Footer: `© 2021-23 XBRL All Rights Reserved.`
Contact given on the same page: filings@xbrl.org.

The same page documents a coverage gap that matters for marquee
positioning: ESEF filings for **Germany** and **Ireland** are NOT
available in the repository ("Missing data ... These countries
include: Germany, Ireland").

## Files

### filings_api_fr_page.json (3,595 bytes — UNTRUNCATED)

`GET https://filings.xbrl.org/api/filings` with query
`filter=[{"name":"country","op":"eq","val":"FR"}]`,
`page[size]=2`, `sort=-date_added`, `include=entity`.
JSON:API page of the two most recently added FR ESEF filings at fetch
time: Medincell (LEI 969500R79U6PXCL2FF46, error_count 3) and
S.T. Dupont S.A (LEI 969500YT2CGGAD8YNM04, period_end 2026-03-31).
sha256: 7cc0bb207354e87126701d9cf7703a0fff94ff99b26d4874df513c454efac4d0

### filings_api_latest_page.json (2,135 bytes — UNTRUNCATED)

`GET https://filings.xbrl.org/api/filings?page[size]=2&sort=-date_added`
(no country filter). Both rows are UAIFRS-programme filings and carry
`"package_url": null` — committed precisely because the adapter must
survive the null and the non-ESEF programme shape.
sha256: da2df6df9a9385bb16e8356f5b3627cb800c6cc26ee12dc28fb2ad0dc58f6770

### xbrl_json_st_dupont_2026_03_31_truncated.json (~181 KB — TRUNCATED)

The xBRL-JSON fact document for S.T. Dupont S.A, FY ending 2026-03-31:
`GET https://filings.xbrl.org/969500YT2CGGAD8YNM04/2026-03-31/ESEF/FR/0/969500YT2CGGAD8YNM04-2026-03-31-1-fr.json`

The original wire response is 2,308,902 bytes (370 facts, dominated by
tagged narrative text blocks). sha256 of the ORIGINAL:
ad4ce7e09bf2d392d0d61f5fbbbdff96d6c7d3920bc439d888638985794c9b3a

Truncation rule (mechanical, no value edited): kept `documentInfo`
verbatim plus every fact whose `dimensions.concept` contains one of
Revenue / ProfitLoss / Assets / Equity / NameOfReportingEntity /
PeriodCoveredByFinancialStatements / DescriptionOfPresentationCurrency
(substring match — so dimensioned members, accounting-policy text
blocks and duplicate statement/notes tags of those concepts are all
retained exactly as served; 116 of 370 facts survive). Re-serialized
with `json.dumps(..., indent=1)` — fact ids, dimension objects and
value strings are byte-for-byte the parser's view of the original.

Ground truth encoded (undimensioned, iso4217:EUR, latest period
2025-04-01T00:00:00/2026-04-01T00:00:00, instant 2026-04-01T00:00:00):

| metric  | concept                                     | value        |
|---------|---------------------------------------------|--------------|
| revenue | ifrs-full:RevenueFromContractsWithCustomers | 55,810,000.0 |
| profit  | ifrs-full:ProfitLoss                        |  2,042,000.0 |
| assets  | ifrs-full:Assets                            | 61,878,000.0 |
| equity  | ifrs-full:Equity                            | 29,802,000.0 |

(There is no undimensioned `ifrs-full:Revenue` fact in this filing —
revenue resolves through the candidate chain, which the tests assert.)

## Retained earnings (added 2026-09-05)

`esef.CORE_CONCEPTS["retained_earnings"] = ("ifrs-full:RetainedEarnings",)`.
Calibration status, measured on real bytes:

* **S.T. Dupont (this fixture) — ABSENT path.** The ORIGINAL document
  (re-fetched 2026-09-05: HTTP 200, 2,308,902 bytes, sha256 identical to
  the value above) carries **no `ifrs-full:RetainedEarnings` fact at
  all**. It tags the period slice
  `ifrs-full:RetainedEarningsProfitLossForReportingPeriod` (2,042,000 —
  its ProfitLoss) and a filer EXTENSION for the complement,
  `STD:MiscellaneousOtherReservesAndRetainedEarningsExcludingProfitLossForReportingPeriod`
  (-1,141,000). Both were already in the truncated file (their names
  contain `ProfitLoss`); the keep-rule now also lists `RetainedEarnings`
  explicitly so a re-truncation cannot drop the evidence. The adapter
  lists `retained_earnings` in `bundle.absent` for this filing — the
  honest refusal on the fixture that proves it.
* **Medincell (LEI 969500R79U6PXCL2FF46, FY 2026-03-31) — COMPOSITE
  path, committed as `xbrl_json_medincell_2026_03_31_truncated.json`.**
  Fetched 2026-09-05 from the `json_url` in `filings_api_fr_page.json`.
  First attempt: HTTP 200 but only 24,288 bytes of a chunked transfer,
  unparseable at its last byte — a real failure shape the adapter's
  `json.loads` turns into `esef_document_malformed`. Retry with
  `Accept-Encoding: identity`: 5,042,485 bytes, 516 facts, sha256 of the
  ORIGINAL `605076574bb0e3f1644076ebb489920c62a5b8b69464ea3ceec6e29ae31aa19b`.
  Truncation rule: `documentInfo` verbatim plus every fact whose
  `dimensions.concept` contains one of the keep-tokens above (now
  including `RetainedEarnings`), MINUS facts whose concept name ends in
  `Explanatory` (narrative text blocks, omitted by NAME — no value
  edited; 142 of 516 facts survive, 64,780 bytes, `json.dumps(indent=1)`).
  Ground truth (undimensioned, iso4217:EUR, instant 2026-04-01T00:00:00):

  | metric            | concept                                                          | value         |
  |-------------------|------------------------------------------------------------------|---------------|
  | revenue           | ifrs-full:Revenue                                                | 24,277,000.0  |
  | profit            | ifrs-full:ProfitLoss                                             | -31,287,000.0 |
  | assets            | ifrs-full:Assets                                                 | 108,055,000.0 |
  | equity            | ifrs-full:Equity                                                 | 3,064,000.0   |
  | retained_earnings | composite: RetainedEarningsExcludingProfitLossForReportingPeriod | -11,446,000.0 |
  |                   |          + RetainedEarningsProfitLossForReportingPeriod          | -31,287,000.0 |
  |                   |          = the line                                              | -42,733,000.0 |

  This filing tags NO bare `ifrs-full:RetainedEarnings` either — so of
  two real FR filings, zero tag the IFRS element and one tags the
  ifrs-full pair. The chain keeps `ifrs-full:RetainedEarnings` first
  (the standard element; its single-concept path is asserted with one
  synthetic fact in the test module) and resolves the pair through the
  both-or-refuse composite `esef.RETAINED_EARNINGS_COMPONENTS`.
