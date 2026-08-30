// marketApi.ts — the ONE frontend client for the global public-markets
// registry (`/api/public/markets`) and its per-company documents
// (`/api/public/markets/company/{market}/{ticker}`).
//
// WHAT THIS MODULE IS ALLOWED TO SAY
// ----------------------------------
// The market registry is CONFIGURATION: which feed serves a market, how
// often it refreshes, what licence the bytes carry, and whether the
// platform can address that market by ticker today. None of that is a
// figure about a company, so a bundled mirror of it is exactly as true
// as the endpoint's copy — and a drift test
// (`__tests__/marketRegistryDrift.test.ts`) re-derives the mirror from
// `src/engine/public_market/markets.yaml` so the two cannot separate.
//
// `entities_held` is the ONE field that is a claim about held data
// rather than configuration, so it is NEVER bundled. When the endpoint
// is unreachable the registry comes back with `holdingsKnown: false`
// and every surface renders "holdings unknown" instead of a zero. An
// absent count is not a count of zero.
//
// NO FIGURE IS EVER SYNTHESIZED HERE. Refusals from the API are passed
// through with their machine `code` intact so the UI can say which of
// "this market has no feed", "this market has a feed but no ticker
// lookup" and "we have not cached this company yet" it actually got —
// three completely different answers that a bare HTTP status flattens
// into one.

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? "";

// ── wire types (snake_case, mirroring the API body 1:1) ────────────────

/** What the platform can honestly deliver for a market TODAY.
 *  · live               — ticker in, deterministic figure out, with provenance.
 *  · fundamentals_only  — a real feed carries figures, but no ticker→filing
 *                         resolution exists, so the company route refuses.
 *  · awaiting_provider  — no feed at all. The card exists so the gap is
 *                         visible, never so a number can fill it. */
export type MarketStatus = "live" | "fundamentals_only" | "awaiting_provider";

/** Registry grouping. Romania is its OWN group and always leads. */
export type MarketGroup = "romania" | "marquee" | "rest";

export interface MarketEntry {
  market_id: string;
  display_name: string;
  exchanges: string[];
  currency: string;
  accounting_standard: string;
  /** "none" | "licensed_provider_slot" | a named feed. */
  price_source: string;
  /** "none" | a named feed ("sec_edgar_companyfacts", "public_ro", …). */
  fundamentals_source: string;
  /** "none" | "on_filing" | "annual_dataset" | … */
  refresh_cadence: string;
  /** Verbatim licence line as the adapter recorded it. Never reworded. */
  license_notes: string;
  marquee_rank: number;
  status: MarketStatus;
  coverage_note: string;
  /** Derived server-side; recomputed locally for the bundled mirror. */
  group?: MarketGroup;
  /** Companies actually cached for this market. ONLY present when the
   *  live endpoint answered — see `MarketRegistry.holdingsKnown`. */
  entities_held?: number;
}

export interface MarketRegistry {
  schema: string;
  groups: MarketGroup[];
  statuses: MarketStatus[];
  markets: MarketEntry[];
  counts: Record<string, number>;
  /** false when the registry came from the bundled mirror — no surface
   *  may print a holdings count in that state. */
  holdingsKnown: boolean;
  origin: "api" | "bundled";
}

/** The environment variable an operator sets to activate a market whose
 *  status is `awaiting_provider`. Named on every calm empty state so the
 *  gap reads as a configuration step, not a broken page. */
export const PROVIDER_ENV_VAR = "PROVIDER_API_KEY";

export const MARKET_STATUS_LIVE: MarketStatus = "live";
export const MARKET_STATUS_FUNDAMENTALS_ONLY: MarketStatus = "fundamentals_only";
export const MARKET_STATUS_AWAITING_PROVIDER: MarketStatus = "awaiting_provider";

// ── bundled mirror ─────────────────────────────────────────────────────
// Generated from src/engine/public_market/markets.yaml; `group` is
// derived (never stored twice) and `entities_held` is deliberately
// absent. Regenerate with the drift test's failure message as the guide.

export const BUNDLED_MARKETS: ReadonlyArray<MarketEntry> = [
    {
      "market_id": "ro",
      "display_name": "Romania — Bucharest Stock Exchange",
      "exchanges": [
        "BVB"
      ],
      "currency": "RON",
      "accounting_standard": "RAS/IFRS",
      "price_source": "none",
      "fundamentals_source": "public_ro",
      "refresh_cadence": "annual_dataset",
      "license_notes": "Conține informații publice · data.gov.ro / Ministerul Finanțelor · licența CC BY 4.0",
      "marquee_rank": 0,
      "status": "live",
      "coverage_note": "Served by the existing public_ro storefront (public_summary class), not by this package. price_source is none by design: BVB quotes are not licensed here and prices.py deliberately omits RO so the home market can never be claimed twice."
    },
    {
      "market_id": "us",
      "display_name": "United States",
      "exchanges": [
        "NYSE",
        "NASDAQ"
      ],
      "currency": "USD",
      "accounting_standard": "US_GAAP",
      "price_source": "licensed_provider_slot",
      "fundamentals_source": "sec_edgar_companyfacts",
      "refresh_cadence": "on_filing",
      "license_notes": "\"Current max request rate: 10 requests/second.\" · \"Please declare your user agent\" (https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data, retrieved 2026-08-29)",
      "marquee_rank": 1,
      "status": "live",
      "coverage_note": "Keyless and official: ticker -> CIK -> companyfacts -> figures with per-figure accessions. USD units only in v1 — an FX-denominated filer refuses rather than mixing currencies. Cash is deliberately not extracted, so enterprise_value refuses by design rather than subtracting a zero it never saw."
    },
    {
      "market_id": "de",
      "display_name": "Germany",
      "exchanges": [
        "XETRA"
      ],
      "currency": "EUR",
      "accounting_standard": "IFRS",
      "price_source": "licensed_provider_slot",
      "fundamentals_source": "none",
      "refresh_cadence": "none",
      "license_notes": "Prices via licensed provider slot · end-of-day licence · no redistribution rights",
      "marquee_rank": 2,
      "status": "awaiting_provider",
      "coverage_note": "filings.xbrl.org documents Germany as MISSING from the ESEF repository (esef.COVERAGE_GAPS). There is no feed for DE today, so the honest status is awaiting_provider — NOT fundamentals_only, which would imply figures exist and are merely unaddressable."
    },
    {
      "market_id": "uk",
      "display_name": "United Kingdom",
      "exchanges": [
        "LSE"
      ],
      "currency": "GBP",
      "accounting_standard": "IFRS",
      "price_source": "licensed_provider_slot",
      "fundamentals_source": "filings.xbrl.org",
      "refresh_cadence": "on_filing",
      "license_notes": "At present, there are no restrictions on the ways that the data can be used. (filings.xbrl.org/docs/about, retrieved 2026-08-29)",
      "marquee_rank": 3,
      "status": "fundamentals_only",
      "coverage_note": "UKSEF filings are in the repository and the xBRL-JSON extractor runs on them, but there is no ticker -> LEI resolution, so the company route refuses. Extraction is calibrated on one real FR filing; the same code path serves UK uncalibrated."
    },
    {
      "market_id": "fr",
      "display_name": "France",
      "exchanges": [
        "Euronext Paris"
      ],
      "currency": "EUR",
      "accounting_standard": "IFRS",
      "price_source": "licensed_provider_slot",
      "fundamentals_source": "filings.xbrl.org",
      "refresh_cadence": "on_filing",
      "license_notes": "At present, there are no restrictions on the ways that the data can be used. (filings.xbrl.org/docs/about, retrieved 2026-08-29)",
      "marquee_rank": 4,
      "status": "fundamentals_only",
      "coverage_note": "The ONE calibrated ESEF market: revenue/profit/assets/equity are extracted from committed real bytes (S.T. Dupont S.A, FY ending 2026-03-31). Still fundamentals_only, because discovery is by country and no ticker -> filing resolution exists."
    },
    {
      "market_id": "it",
      "display_name": "Italy",
      "exchanges": [
        "Borsa Italiana"
      ],
      "currency": "EUR",
      "accounting_standard": "IFRS",
      "price_source": "licensed_provider_slot",
      "fundamentals_source": "filings.xbrl.org",
      "refresh_cadence": "on_filing",
      "license_notes": "At present, there are no restrictions on the ways that the data can be used. (filings.xbrl.org/docs/about, retrieved 2026-08-29)",
      "marquee_rank": 5,
      "status": "fundamentals_only",
      "coverage_note": "In the ESEF repository and on the same extractor path as FR, but uncalibrated (no committed real IT filing) and not addressable by ticker."
    },
    {
      "market_id": "es",
      "display_name": "Spain",
      "exchanges": [
        "BME"
      ],
      "currency": "EUR",
      "accounting_standard": "IFRS",
      "price_source": "licensed_provider_slot",
      "fundamentals_source": "filings.xbrl.org",
      "refresh_cadence": "on_filing",
      "license_notes": "At present, there are no restrictions on the ways that the data can be used. (filings.xbrl.org/docs/about, retrieved 2026-08-29)",
      "marquee_rank": 6,
      "status": "fundamentals_only",
      "coverage_note": "In the ESEF repository and on the same extractor path as FR, but uncalibrated (no committed real ES filing) and not addressable by ticker."
    },
    {
      "market_id": "cn",
      "display_name": "China",
      "exchanges": [
        "SSE",
        "SZSE",
        "HKEX"
      ],
      "currency": "CNY",
      "accounting_standard": "CAS_IFRS",
      "price_source": "licensed_provider_slot",
      "fundamentals_source": "none",
      "refresh_cadence": "none",
      "license_notes": "Prices via licensed provider slot · end-of-day licence · no redistribution rights",
      "marquee_rank": 7,
      "status": "awaiting_provider",
      "coverage_note": "No deterministic feed today. currency is recorded as CNY because a single field cannot express this group honestly — HKEX lists in HKD; the provider integration must carry per-exchange currency rather than let one label stand for both."
    },
    {
      "market_id": "ae",
      "display_name": "United Arab Emirates",
      "exchanges": [
        "DFM",
        "ADX"
      ],
      "currency": "AED",
      "accounting_standard": "IFRS",
      "price_source": "licensed_provider_slot",
      "fundamentals_source": "none",
      "refresh_cadence": "none",
      "license_notes": "Prices via licensed provider slot · end-of-day licence · no redistribution rights",
      "marquee_rank": 8,
      "status": "awaiting_provider",
      "coverage_note": "UAIFRS-programme rows do appear in the filings.xbrl.org index (a committed fixture contains two), but nothing in this repo has ever extracted a figure from one — so AE claims no feed until a real AE filing is parsed end to end."
    }
  ] as ReadonlyArray<MarketEntry>;

export const REGISTRY_SCHEMA = "public_market_registry_v1";
export const MARKET_GROUPS: MarketGroup[] = ["romania", "marquee", "rest"];
export const MARKET_STATUSES: MarketStatus[] = [
  "live",
  "fundamentals_only",
  "awaiting_provider",
];

/** Group of a market, derived exactly as registry.py derives it:
 *  rank 0 is the home market, ranks 1..8 are marquee, the rest tail. */
export function marketGroup(m: MarketEntry): MarketGroup {
  if (m.marquee_rank === 0) return "romania";
  if (Number.isFinite(m.marquee_rank) && m.marquee_rank > 0) return "marquee";
  return "rest";
}

/** Canonical display order: Romania, then marquee by rank, then A→Z.
 *  Mirrors `registry.ordered_markets()`. */
export function orderMarkets(markets: ReadonlyArray<MarketEntry>): MarketEntry[] {
  const home = markets.filter((m) => marketGroup(m) === "romania");
  const marquee = markets
    .filter((m) => marketGroup(m) === "marquee")
    .slice()
    .sort((a, b) => a.marquee_rank - b.marquee_rank);
  const rest = markets
    .filter((m) => marketGroup(m) === "rest")
    .slice()
    .sort((a, b) => a.display_name.localeCompare(b.display_name));
  return [...home, ...marquee, ...rest];
}

function bundledRegistry(): MarketRegistry {
  const markets = BUNDLED_MARKETS.map((m) => ({ ...m, group: marketGroup(m) }));
  const counts: Record<string, number> = {};
  for (const s of MARKET_STATUSES) {
    counts[s] = markets.filter((m) => m.status === s).length;
  }
  return {
    schema: REGISTRY_SCHEMA,
    groups: MARKET_GROUPS,
    statuses: MARKET_STATUSES,
    markets: orderMarkets(markets),
    counts,
    holdingsKnown: false,
    origin: "bundled",
  };
}

/** The bundled registry, as a value. Exported for tests and for the
 *  synchronous first paint (React Query's `placeholderData`). */
export const BUNDLED_REGISTRY: MarketRegistry = bundledRegistry();

// ── registry fetch ─────────────────────────────────────────────────────

/** Fetch the live registry. NEVER throws and never returns empty: a
 *  deployment whose engine is down still gets the full market list from
 *  the bundled mirror, with `holdingsKnown: false` so no surface can
 *  print a holdings number it did not receive. DOD3 — a market tab is
 *  never blank. */
export async function fetchMarketRegistry(): Promise<MarketRegistry> {
  try {
    const res = await fetch(`${API_URL}/api/public/markets`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return bundledRegistry();
    const body = (await res.json()) as Partial<MarketRegistry>;
    const markets = Array.isArray(body.markets) ? body.markets : [];
    if (markets.length === 0) return bundledRegistry();
    const withGroups = markets.map((m) => ({ ...m, group: m.group ?? marketGroup(m) }));
    return {
      schema: body.schema ?? REGISTRY_SCHEMA,
      groups: body.groups ?? MARKET_GROUPS,
      statuses: body.statuses ?? MARKET_STATUSES,
      markets: orderMarkets(withGroups),
      counts: body.counts ?? {},
      // Only claim holdings are known when the payload actually carried
      // the field on at least one market.
      holdingsKnown: withGroups.some((m) => typeof m.entities_held === "number"),
      origin: "api",
    };
  } catch {
    return bundledRegistry();
  }
}

// ── company documents + typed refusals ─────────────────────────────────

/** Machine codes the company route emits. Each names a DIFFERENT gap;
 *  the UI must never collapse them into one "not found". */
export type MarketRefusalCode =
  | "UNKNOWN_MARKET"
  | "HOME_MARKET_SERVED_ELSEWHERE"
  | "MARKET_NOT_ADDRESSABLE"
  | "MARKET_AWAITING_PROVIDER"
  | "NOT_CACHED"
  | "STORE_UNAVAILABLE"
  | "STORE_READ_FAILED"
  | "EMPTY_TICKER"
  /** Local-only: the request never reached the API. */
  | "TRANSPORT_FAILED";

export interface MarketRefusal {
  status: "refused";
  code: MarketRefusalCode;
  detail: string;
  market?: MarketEntry;
  ticker?: string;
  known_markets?: string[];
}

/** One figure inside a pm1 envelope. Money carries `value_minor` +
 *  `currency`; counts carry `value` + `unit`. Absent is absent — there
 *  is no zero default anywhere in this type. */
export interface MarketFigure {
  /** Money: an INTEGER in minor units. Never a float — a float here is a
   *  rounding bug wearing a number's clothes. */
  value_minor?: number | null;
  /** Counts (shares): a plain number with a `unit`. Never converted. */
  value?: number | null;
  currency?: string | null;
  /** Name of the minor unit for a money figure, e.g. "cent". */
  minor_unit?: string | null;
  /** Unit of a COUNT figure, e.g. "shares". */
  unit?: string | null;
  provenance?: MarketFigureProvenance | null;
}

export interface MarketFigureProvenance {
  source?: string | null;
  accession?: string | null;
  accession_or_version?: string | null;
  concept?: string | null;
  fiscal_period?: string | null;
  filed?: string | null;
  form?: string | null;
  [key: string]: unknown;
}

export interface MarketPriceBlock {
  price_minor: number;
  currency: string;
  as_of: string;
  delay_note: string;
}

export interface MarketEnvelope {
  version: string;
  doc_class: string;
  status: string;
  entity_id: string;
  market_id: string;
  market?: Record<string, unknown>;
  entity?: Record<string, unknown>;
  figures?: Record<string, MarketFigure>;
  refusals?: unknown[];
  fiscal_anchor?: Record<string, unknown>;
  price?: MarketPriceBlock;
  content_hash?: string;
}

export interface MarketPresentation {
  status?: string;
  version?: string;
  market_id?: string;
  market_name?: string;
  market_status?: MarketStatus;
  currency?: string;
  accounting_standard?: string;
  trust_en?: string;
  trust_ro?: string;
  source_line?: string;
  license_line?: string;
  price_line_en?: string;
  price_line_ro?: string;
  delay_note?: string;
  as_of?: string;
  refusal_count?: number;
}

export interface MarketCompanyDocument {
  status: string;
  market: MarketEntry;
  envelope: MarketEnvelope;
  presentation?: MarketPresentation;
}

export type MarketCompanyResult =
  | { ok: true; document: MarketCompanyDocument }
  | { ok: false; refusal: MarketRefusal };

/** Read ONE company document. The route reads the spine store and never
 *  fetches from a feed on a web request, so a miss is a real "not cached
 *  yet" — reported as such, never as "no such company". */
export async function fetchMarketCompany(
  marketId: string,
  ticker: string,
): Promise<MarketCompanyResult> {
  const symbol = ticker.trim().toUpperCase();
  if (!symbol) {
    return {
      ok: false,
      refusal: { status: "refused", code: "EMPTY_TICKER", detail: "no ticker supplied" },
    };
  }
  let res: Response;
  try {
    res = await fetch(
      `${API_URL}/api/public/markets/company/${encodeURIComponent(marketId)}/${encodeURIComponent(symbol)}`,
      { headers: { Accept: "application/json" } },
    );
  } catch {
    return {
      ok: false,
      refusal: {
        status: "refused",
        code: "TRANSPORT_FAILED",
        detail: "the market service could not be reached from this browser",
        ticker: symbol,
      },
    };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.ok && body && typeof body === "object" && "envelope" in (body as object)) {
    return { ok: true, document: body as MarketCompanyDocument };
  }
  const refusal = body as Partial<MarketRefusal> | null;
  return {
    ok: false,
    refusal: {
      status: "refused",
      code: (refusal?.code as MarketRefusalCode) ?? "TRANSPORT_FAILED",
      detail: refusal?.detail ?? `the market service answered HTTP ${res.status}`,
      market: refusal?.market,
      ticker: symbol,
      known_markets: refusal?.known_markets,
    },
  };
}

// ── tab model (display only) ───────────────────────────────────────────
//
// The tab bar is DERIVED from the registry, never hardcoded, so a market
// added to markets.yaml can never silently vanish from the UI. The one
// piece of display-only knowledge that lives here is which markets
// collapse into a REGION tab, because "Europe" is a reading convenience
// and not a registry concept — the registry has no region field and
// should not grow one for the sake of a tab strip.

/** Display-only regional grouping. A market listed here renders under
 *  its region's tab (with country sub-filters) instead of taking a tab
 *  of its own. Everything NOT listed gets its own tab, in registry
 *  order — which is why a new market is impossible to lose. */
export const MARKET_REGIONS: Readonly<Record<string, string>> = {
  de: "europe",
  uk: "europe",
  fr: "europe",
  it: "europe",
  es: "europe",
};

/** i18n key stem for a region tab's label, e.g. `pcm.region.europe`. */
export const REGION_IDS: ReadonlyArray<string> = ["europe"];

export interface MarketTab {
  /** Tab id: a market_id, a region id, or "all". */
  id: string;
  kind: "market" | "region" | "all";
  /** The registry entries this tab scopes to (empty for "all" = every market). */
  markets: MarketEntry[];
  /** Present for kind "market" — the single entry. */
  market?: MarketEntry;
  /** Region id when kind is "region". */
  region?: string;
}

export const ALL_MARKETS_TAB_ID = "all";

/** Build the tab strip from a registry, in registry order, collapsing
 *  regions at the position of their first member and appending "All".
 *  With today's markets.yaml this yields exactly:
 *  Romania · United States · Europe · China · UAE · All. */
export function buildMarketTabs(markets: ReadonlyArray<MarketEntry>): MarketTab[] {
  const ordered = orderMarkets(markets);
  const tabs: MarketTab[] = [];
  const regionIndex = new Map<string, number>();
  for (const m of ordered) {
    const region = MARKET_REGIONS[m.market_id];
    if (!region) {
      tabs.push({ id: m.market_id, kind: "market", markets: [m], market: m });
      continue;
    }
    const at = regionIndex.get(region);
    if (at === undefined) {
      regionIndex.set(region, tabs.length);
      tabs.push({ id: region, kind: "region", region, markets: [m] });
    } else {
      tabs[at].markets.push(m);
    }
  }
  tabs.push({ id: ALL_MARKETS_TAB_ID, kind: "all", markets: ordered });
  return tabs;
}

/** Every market id a tab scopes to. "all" scopes to everything. */
export function tabMarketIds(tab: MarketTab): string[] {
  return tab.markets.map((m) => m.market_id);
}

/** The tab a market id belongs to (its own, or its region's). */
export function tabIdForMarket(marketId: string): string {
  return MARKET_REGIONS[marketId] ?? marketId;
}

// ── snapshot ↔ market mapping ──────────────────────────────────────────
//
// The legacy `/api/public/universe` snapshots carry an EXCHANGE, not a
// market id. This maps one to the other so a mixed grid can label each
// card honestly. An exchange we do not recognise returns null — the card
// then shows no market chip rather than guessing, because a wrong market
// chip attaches the wrong currency and the wrong licence to a real
// number.

export function marketIdForExchange(
  exchange: string | null | undefined,
  markets: ReadonlyArray<MarketEntry> = BUNDLED_MARKETS,
): string | null {
  if (!exchange) return null;
  const needle = exchange.trim().toUpperCase();
  if (!needle) return null;
  for (const m of markets) {
    if (m.exchanges.some((e) => e.toUpperCase() === needle)) return m.market_id;
  }
  return null;
}

/** Market id for a universe snapshot, or null when the exchange is not
 *  in the registry. */
export function marketIdForSnapshot(
  snapshot: { exchange?: string | null },
  markets: ReadonlyArray<MarketEntry> = BUNDLED_MARKETS,
): string | null {
  return marketIdForExchange(snapshot.exchange, markets);
}

/** ISO country codes a market's companies report under, used by surfaces
 *  (Risk Radar) whose rows carry a country rather than an exchange.
 *  Derived from the market id, which IS the ISO-3166 alpha-2 code for
 *  every market in the registry — asserted by a test rather than assumed. */
export function countryCodesForMarket(m: MarketEntry): string[] {
  return [m.market_id.toUpperCase()];
}

// ── ⌘K command palette registration descriptor ─────────────────────────
//
// The palette (components/instrument/shell/CommandPalette.tsx) is owned
// by another wave, so this lane does NOT edit it. Instead it publishes
// the descriptor the palette should register, here, as data. Wiring is
// one import plus a spread on the palette's side.

export interface MarketCommandDescriptor {
  /** Stable id for the palette's own dedupe. */
  id: string;
  /** i18n key for the group heading. */
  groupKey: string;
  /** i18n key for the command label. */
  labelKey: string;
  /** Route the command navigates to, with the market tab preselected. */
  route: string;
  /** Query param the page reads for the active market tab. */
  param: string;
  /** One entry per tab the palette should offer. */
  entries: Array<{ id: string; kind: MarketTab["kind"]; labelKey: string; value: string }>;
}

/** Query-string parameter carrying the active market tab. Deep links
 *  (`/public-companies?market=us`) land on that tab. */
export const MARKET_TAB_PARAM = "market";

/** The descriptor the ⌘K palette should register for this surface.
 *  Built from the BUNDLED registry so the palette can register it
 *  synchronously at module load, with no fetch on the critical path. */
export const MARKET_COMMAND_DESCRIPTOR: MarketCommandDescriptor = {
  id: "public-markets",
  groupKey: "pcm.command.group",
  labelKey: "pcm.command.open",
  route: "/public-companies",
  param: MARKET_TAB_PARAM,
  entries: buildMarketTabs(BUNDLED_MARKETS).map((tab) => ({
    id: `public-markets:${tab.id}`,
    kind: tab.kind,
    labelKey:
      tab.kind === "all"
        ? "pcm.tab.all"
        : tab.kind === "region"
          ? `pcm.region.${tab.region}`
          : `pcm.market.${tab.id}`,
    value: tab.id,
  })),
};
