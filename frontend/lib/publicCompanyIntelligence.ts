// TypeScript shapes + fetch helpers for the Public Company AI Intelligence
// backend (/api/public/intelligence/*).
//
// Mirrors src/engine/public/intelligence/models.py 1:1 — the FastAPI routes
// emit dataclasses.asdict() output and these types describe the JSON exactly.
// When the BE adds a field, add it here too (and ideally a test that catches
// the drift; that's in Phase A.tests).
//
// Architectural note: this module is the ONLY place the FE imports
// intelligence shapes from. Components import from here, never from
// publicCompanyUniverse.ts (which is the pre-existing 35-field financial
// snapshot, NOT the intelligence layer).

export type Severity = "low" | "medium" | "high" | "critical";

export type SignalType =
  | "geopolitical"
  | "supply_chain"
  | "energy"
  | "commodity"
  | "interest_rates"
  | "fx"
  | "regulation"
  | "technology"
  | "consumer_demand"
  | "climate"
  | "company_news"
  | "earnings"
  | "filing"
  | "credit";

export type RiskCategory =
  | "geopolitical"
  | "supply_chain"
  | "energy"
  | "rates_credit"
  | "fx"
  | "regulation"
  | "technology"
  | "consumer_demand";

export type TimeHorizon = "immediate" | "3m" | "12m" | "long_term";

export type FinancialImpactChannel =
  | "revenue"
  | "gross_margin"
  | "ebitda_margin"
  | "capex"
  | "working_capital"
  | "inventory"
  | "debt_cost"
  | "fx"
  | "valuation_multiple"
  | "supply_availability";

export type ExposureSource = "filings" | "sector_model" | "ai_inferred" | "manual";

export type FeedStatus =
  | "live_feed_active"
  | "sector_model_only"
  | "no_provider_configured";

// ─── Risk-radar payload ──────────────────────────────────────────────────

export interface IntelligenceSignal {
  id: string;
  signal_type: SignalType;
  title: string;
  summary: string;
  source: string;
  source_url?: string | null;
  severity: Severity;
  time_horizon: TimeHorizon;
  confidence: number;
  published_at?: string | null;
  affected_sectors: string[];
  affected_industries: string[];
  affected_companies: string[];
  affected_tickers: string[];
  geography: string[];
  financial_impact_channels: FinancialImpactChannel[];
  risk_categories: RiskCategory[];
}

/** Provenance of a per-ticker exposure score. Drives the source-badge chip. */
export type ExposureSource =
  | "sector_model"        // sector-default, lowest confidence
  | "sec_filing"          // extracted from 10-K text
  | "operator_curated"    // operator-edited override
  | "bvb_override";       // Romanian-specific BVB override

/** One ticker's slot in a radar card's affected list. The category_score
 *  drives the exposure-bar width (0.0-1.0 → 0-100%). country='RO' flips on
 *  the 🇷🇴 emoji prefix. source feeds the provenance badge. */
export interface AffectedTickerRich {
  ticker: string;
  category_score: number;   // 0.0-1.0
  country: string;          // "US" | "RO" | "EU" | ...
  sector: string;
  source: ExposureSource;
  confidence: number;
}

/** One entry in a card's structural-correlation footnote. `related` is the
 *  OTHER category we overlap with; `drivers` is the human-readable cause
 *  (e.g. "Semiconductors (Taiwan exposure)"). FE computes the N/M overlap
 *  count from set intersection of affected_tickers_rich. */
export interface StructuralCorrelation {
  related: RiskCategory;
  drivers: string;
}

/** Diversity-of-sector status for a card's top-N. `structural_correlation`
 *  fires when this category is documented in _KNOWN_STRUCTURAL_CORRELATIONS
 *  (sector-default-only scoring resolution → predictable overlap with
 *  another category). `sector_constrained` fires when top-N draws from <3
 *  sectors (real concentration). `diverse` is healthy default. */
export type DiversityStatus =
  | "diverse"
  | "sector_constrained"
  | "structural_correlation";

export interface RiskRadarCategory {
  category: RiskCategory;
  score: number;             // 0–100
  level: Severity;
  affected_sectors: string[];
  affected_tickers: string[];                    // legacy bare-list, kept for back-compat
  affected_tickers_rich?: AffectedTickerRich[];  // v2 canonical field
  diversity_status?: DiversityStatus;
  structural_correlations?: StructuralCorrelation[];
  sectors_represented?: number;
  signal_count: number;
  top_signals: IntelligenceSignal[];
}

export interface RiskRadarResponse {
  categories: Record<RiskCategory, RiskRadarCategory>;
  feed_status: FeedStatus;
  computed_at: string;
}

// ─── Per-ticker risk score ───────────────────────────────────────────────

export interface RiskCategoryScores {
  macro: number;
  supply_chain: number;
  geopolitical: number;
  financial: number;
  valuation: number;
  operational: number;
  regulatory: number;
}

export interface RiskItem {
  key: string;
  label: string;
  severity: Severity;
  score_contribution: number;
  channels: FinancialImpactChannel[];
  source_signal_ids: string[];
}

export interface OpportunityItem {
  key: string;
  label: string;
  strength: Severity;
  score_contribution: number;
  channels: FinancialImpactChannel[];
  source_signal_ids: string[];
}

export interface PublicCompanyRiskScore {
  ticker: string;
  overall_risk_score: number;
  risk_level: Severity;
  categories: RiskCategoryScores;
  top_risks: RiskItem[];
  top_opportunities: OpportunityItem[];
  explanation: string;
  confidence: number;
  computed_at: string;
}

// ─── Company exposure ────────────────────────────────────────────────────

export interface RiskRef {
  key: string;
  label: string;
  severity: Severity;
  channels: FinancialImpactChannel[];
  explanation: string;
}

export interface OpportunityRef {
  key: string;
  label: string;
  severity: Severity;
  channels: FinancialImpactChannel[];
  explanation: string;
}

export interface CompanyExposureProfile {
  ticker: string;
  company_name: string;
  sector: string;
  industry?: string | null;
  geographic_exposure: Record<string, number>;
  supply_chain_exposure: Record<string, number>;
  financial_sensitivity: Record<string, number>;
  main_risks: RiskRef[];
  main_opportunities: OpportunityRef[];
  confidence: number;
  source: ExposureSource;
  last_updated: string;
}

// ─── Macro signals feed payload ──────────────────────────────────────────

export interface MacroSignalsResponse {
  signals: IntelligenceSignal[];
  feed_status: FeedStatus;
  total: number;
}

// ─── AI Market Read payload ──────────────────────────────────────────────

export interface AIMarketReadResponse {
  ticker?: string;
  subject_kind: "ticker" | "sector" | "universe";
  headline: string;
  summary: string;
  top_risks: RiskItem[];
  top_opportunities: OpportunityItem[];
  what_to_watch: string[];
  confidence: number;
  model_id: string;
  source_signal_ids: string[];
  feed_status: FeedStatus;
  computed_at: string;
}

// ─── Health payload ──────────────────────────────────────────────────────

export interface AdapterHealth {
  name: string;
  configured: boolean;
  reason: string;
  last_fetch_at?: string | null;
  last_fetch_count: number;
  last_error?: string | null;
  extras: Record<string, string>;
}

export interface IntelligenceHealthResponse {
  feed_status: FeedStatus;
  adapters: Record<string, AdapterHealth>;
  sector_library_version: string;
  universe_sector_count: number;
}

// ─── Fetch helpers ───────────────────────────────────────────────────────

const API_BASE = (import.meta.env.VITE_API_URL as string | undefined)
  ?? "http://127.0.0.1:8000";

async function _get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Intelligence API ${path} failed: HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

async function _post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Intelligence API ${path} failed: HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export function fetchRiskRadar(): Promise<RiskRadarResponse> {
  return _get<RiskRadarResponse>("/api/public/intelligence/risk-radar");
}

export function fetchMacroSignals(opts?: {
  sector?: string;
  ticker?: string;
  limit?: number;
}): Promise<MacroSignalsResponse> {
  const params = new URLSearchParams();
  if (opts?.sector) params.set("sector", opts.sector);
  if (opts?.ticker) params.set("ticker", opts.ticker);
  if (opts?.limit) params.set("limit", String(opts.limit));
  const qs = params.toString();
  return _get<MacroSignalsResponse>(
    `/api/public/intelligence/macro-signals${qs ? "?" + qs : ""}`,
  );
}

export function fetchSupplyChain(opts: {
  ticker?: string;
  sector?: string;
}): Promise<{
  ticker?: string;
  sector?: string;
  exposure?: CompanyExposureProfile;
  default_geographic_exposure?: Record<string, number>;
  default_supply_chain_exposure?: Record<string, number>;
  default_financial_sensitivity?: Record<string, number>;
  affected_tickers?: string[];
  source?: string;
}> {
  const params = new URLSearchParams();
  if (opts.ticker) params.set("ticker", opts.ticker);
  if (opts.sector) params.set("sector", opts.sector);
  return _get(`/api/public/intelligence/supply-chain?${params.toString()}`);
}

export function fetchTickerRiskScore(ticker: string): Promise<PublicCompanyRiskScore> {
  return _get<PublicCompanyRiskScore>(
    `/api/public/intelligence/companies/${encodeURIComponent(ticker)}/risk-score`,
  );
}

export function fetchTickerExposure(ticker: string): Promise<CompanyExposureProfile> {
  return _get<CompanyExposureProfile>(
    `/api/public/intelligence/companies/${encodeURIComponent(ticker)}/exposure`,
  );
}

export function fetchTickerSignals(ticker: string): Promise<{
  ticker: string;
  signals: IntelligenceSignal[];
  feed_status: FeedStatus;
}> {
  return _get(
    `/api/public/intelligence/companies/${encodeURIComponent(ticker)}/signals`,
  );
}

export function fetchAIMarketRead(ticker: string): Promise<AIMarketReadResponse> {
  return _get<AIMarketReadResponse>(
    `/api/public/intelligence/companies/${encodeURIComponent(ticker)}/ai-market-read`,
  );
}

export function fetchIntelligenceHealth(): Promise<IntelligenceHealthResponse> {
  return _get<IntelligenceHealthResponse>("/api/public/intelligence/health");
}

export function postRefreshSignals(): Promise<{ cache_keys_invalidated: number; ok: boolean }> {
  return _post("/api/public/intelligence/refresh-signals", {});
}

// ─── Universe-wide risk-scores batch ────────────────────────────────────

/** One row in the universe-wide risk-score batch response — what the
 *  PublicCompaniesUniverseTable renders per ticker. */
export interface UniverseRiskScoreRow {
  ticker: string;
  risk_score: number;
  risk_level: Severity;
  main_risk: string | null;
  main_risk_severity: Severity | null;
  opportunity_score: number;
  opportunity_level: Severity;
  exposure_source: ExposureSource;
  confidence: number;
}

export interface UniverseRiskScoresResponse {
  scores: Record<string, UniverseRiskScoreRow>;
  total: number;
  feed_status: FeedStatus;
  computed_at: string;
}

export function fetchUniverseRiskScores(): Promise<UniverseRiskScoresResponse> {
  return _get<UniverseRiskScoresResponse>("/api/public/intelligence/risk-scores");
}

// ─── UI helpers ──────────────────────────────────────────────────────────

/** Severity → Tailwind text color class (matches the project's design tokens). */
export function severityToTextClass(s: Severity): string {
  switch (s) {
    case "critical": return "text-alert";
    case "high":     return "text-brand";
    case "medium":   return "text-brand";
    case "low":      return "text-brand";
  }
}

/** Severity → Tailwind background tint (paired with severityToTextClass). */
export function severityToBgClass(s: Severity): string {
  switch (s) {
    case "critical": return "bg-alert/10 border-alert/30";
    case "high":     return "bg-brand/10 border-brand/30";
    case "medium":   return "bg-brand/10 border-brand/30";
    case "low":      return "bg-brand/10 border-brand/30";
  }
}

/** Human-readable category label. Aligned with the brief §14 wording. */
export const RISK_CATEGORY_LABEL: Record<RiskCategory, string> = {
  geopolitical:     "Geopolitical",
  supply_chain:     "Supply Chain",
  energy:           "Energy",
  rates_credit:     "Rates & Credit",
  fx:               "FX",
  regulation:       "Regulation",
  technology:       "Technology",
  consumer_demand:  "Consumer Demand",
};

/** Brief 1-line description per category for the radar card subhead. */
export const RISK_CATEGORY_BLURB: Record<RiskCategory, string> = {
  geopolitical:     "Conflicts, tariffs, sanctions, regional exposure",
  supply_chain:     "Concentration, shipping, supplier disruption",
  energy:           "Oil shock, power constraints, transition risk",
  rates_credit:     "Refinancing, NIM, credit-loss cycles",
  fx:               "Currency translation + EM exposure",
  regulation:       "Antitrust, environmental, drug pricing",
  technology:       "Capex cycles, disruption, AI commoditization",
  consumer_demand:  "Spending slowdown, premiumization shifts",
};
