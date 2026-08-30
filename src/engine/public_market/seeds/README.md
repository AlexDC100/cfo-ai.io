# public_market seeds — the universe, as versioned DATA

One JSON file per market, named for the market it declares. **The
filename is a convenience; the authority is the `market_id` field
inside the file** (`universe.load_seeds()` reads that, so a mis-named
file is a load error rather than a silent reassignment).

## What a seed is

Identity, and nothing else: legal name, listed ticker(s), and whatever
deterministic keys (ISIN / LEI / CIK) the source published.

**No seed carries a figure.** Every number this document class serves
comes from a deterministic feed (SEC EDGAR companyfacts, ESEF) through
the adapters, with its own per-figure accession. A membership list is
not a source for a number, and fusing the two would mean either
re-fetching 500 companies' fundamentals to refresh a membership change,
or serving a figure whose provenance is a Wikipedia table.

Loading a seed writes `entities` rows and nothing else. A seeded
company is one we can NAME; the company route keeps answering
`NOT_CACHED` until a real filing lands for it.

## Schema (`public_market_seed_v1`)

```jsonc
{
  "schema": "public_market_seed_v1",
  "market_id": "us",            // must exist in markets.yaml
  "as_of": "2026-08-20",        // the SOURCE's date, not the fetch clock
  "source": {
    "name": "...",              // required
    "url": "...",               // required
    "dataset_version": "...",   // required — a list nobody can diff is a rumour
    "retrieved_at": "...Z",     // required
    "upstream": "...",          // optional: where the source itself got it
    "identity_only": true
  },
  "license_note": "verbatim licence line from the source",
  "coverage_note": "what this file IS and, just as importantly, is NOT",
  "member_count": 500,          // cross-checked against members at load
  "members": [
    { "name": "Apple Inc.", "ticker": "AAPL", "cik": "320193" },
    { "name": "Alphabet Inc.", "tickers": ["GOOG", "GOOGL"], "cik": "1652044" }
  ]
}
```

`ticker` (one listing) and `tickers` (several) are mutually exclusive.
A member is an **issuer**, not a listing: Alphabet, Fox and News Corp
each file under one SEC CIK with two listed share classes, and modelling
those as two members mints one entity id twice. The real S&P 500 file
refuses to validate if you try — which is how this was found.

A member with no ISIN/LEI/CIK is kept (it is still a real company, still
searchable) but is **queued for review** at load time rather than minted:
an id derived from a name would link two same-named companies into one
entity.

## Where each file comes from

| file | source | licence | keys |
|---|---|---|---|
| `us.json` | [S&P 500 Companies data package](https://github.com/datasets/s-and-p-500-companies) `data/constituents.csv`, pinned to the commit SHA in `source.dataset_version` | ODC-PDDL-1.0 (declared in its own `datapackage.json`) | CIK |
| `uk/fr/it/es.json` | [filings.xbrl.org](https://filings.xbrl.org) filings index filtered by country (which entities actually filed) joined to [GLEIF](https://api.gleif.org) for legal names | filings index: "no restrictions on the ways that the data can be used"; GLEIF: CC0 1.0 | LEI |
| `de/cn/ae.json` | — | — | — |
| `ro.json` | — | — | — |

### Two deliberate absences, written down rather than filled in

**NASDAQ-100 is not seeded.** Its composition is proprietary to Nasdaq,
Inc.; no licence-clear machine-readable public dataset publishes it, and
the free copies are HTML tables — scraping, which this document class
does not do. Nothing is lost in capability: every NASDAQ-100 name absent
from the S&P 500, and every other SEC registrant with a ticker, stays
reachable through the SEC's own `company_tickers.json`, which the EDGAR
adapter resolves on demand (`scripts/public_market_seed.py resolve`).

**European seeds are feed coverage, not index membership.** A CAC 40 /
FTSE 100 / IBEX 35 / FTSE MIB constituent list is the index provider's
proprietary IP with the same distribution problem, and it would name
companies this platform holds nothing for. The ESEF filings index names
exactly the companies the feed can speak about, keyed by a real LEI.
They carry no ticker because the feed publishes none — which is
precisely why those markets are `fundamentals_only` in `markets.yaml`:
the figures exist, the ticker lookup does not.

`de.json`, `cn.json` and `ae.json` are empty **on purpose**, each with a
dated `coverage_note` naming the missing feed. An empty seed is a
declared gap; a fabricated one is a lie with a schema.

`ro.json` is empty because of PM7: Romania is served by `public_ro`, and
`universe.load_into_store()` *refuses* a home-market seed that carries
members, so the invariant is enforced by code and not only by prose.

## Regenerating

```
.venv/bin/python scripts/public_market_seed.py fetch-us   --market us
.venv/bin/python scripts/public_market_seed.py fetch-esef --market uk --country GB
.venv/bin/python scripts/public_market_seed.py fetch-esef --market fr --country FR
.venv/bin/python scripts/public_market_seed.py fetch-esef --market it --country IT
.venv/bin/python scripts/public_market_seed.py fetch-esef --market es --country ES
.venv/bin/python scripts/public_market_seed.py verify
```

Every fetch validates the document **before** writing, and refuses a
suspiciously short response rather than overwriting a good file with a
half-failed download. `write-empty --market X --reason "..."` is how a
declared gap is (re)recorded; the reason is required.

The ISO country code for an ESEF market is passed by the operator and
recorded in `source.dataset_version` — it deliberately does not live in
the package, where the N7 guard keeps market knowledge inside
`markets.yaml`.
