-- ============================================================================
-- Valuation benchmarks — the industry_key-shaped rows _valuation.py reads
--
-- Context (2026-07-26): src/engine/api/_valuation.py::load_valuation_benchmarks
-- queries `industry_benchmarks` by (industry_key, metric_name in
-- (ev_ebitda_multiple, ev_revenue_multiple)) and reads p25/p50/p75/source/
-- as_of_date — but NO migration in this repo ever added those columns or rows.
-- The deployed table is the CAEN-shaped phase7 one (caen_code, p25_value, …),
-- so every pipeline run logged
--     [pipeline] valuation compute failed (non-fatal)
--     … 400 … column industry_benchmarks.industry_key does not exist
-- and every dashboard shipped WITHOUT its valuation payload. Silently, since
-- the pipeline treats valuation as non-fatal.
--
-- Additive + idempotent. Existing CAEN rows are untouched; the valuation rows
-- live in the same table with a 'VAL:'-prefixed sentinel caen_code (caen_code
-- is NOT NULL + unique(caen_code, metric_name), so each industry_key gets its
-- own sentinel).
--
-- Seed values are the methodology's EV envelopes (CLAUDE.md Appendix A §6:
-- default 6–10×, food/consumer 7–12×, real estate 8–14×, services 8–14×),
-- interpolated to p25/p50/p75 per industry. confidence='estimated' — replace
-- with licensed data when available.
-- ============================================================================

-- 1. Columns the valuation loader reads.
alter table industry_benchmarks add column if not exists industry_key text;
alter table industry_benchmarks add column if not exists p25 numeric;
alter table industry_benchmarks add column if not exists p50 numeric;
alter table industry_benchmarks add column if not exists p75 numeric;
alter table industry_benchmarks add column if not exists source text;
alter table industry_benchmarks add column if not exists as_of_date date;

create index if not exists industry_benchmarks_industry_key_idx
  on industry_benchmarks (industry_key, metric_name)
  where industry_key is not null;

-- 2. Seed. Keys cover the org-profile industries (OrgIndustryPills) plus the
--    fallback targets in _valuation.py's _INDUSTRY_FALLBACK, plus 'generic'
--    (the loader's guaranteed last resort). ON CONFLICT DO NOTHING keeps
--    re-runs safe and preserves any hand-tuned values.
insert into industry_benchmarks
  (caen_code, caen_label, industry_category, metric_name, metric_type,
   industry_key, p25, p50, p75, unit, source, source_label, source_year,
   as_of_date, confidence)
values
  -- generic (the loader's floor — must exist)
  ('VAL:generic', 'Valuation — generic RO SME', 'valuation', 'ev_ebitda_multiple', 'ratio', 'generic', 5.0, 7.0, 9.5, 'x', 'CFO AI calibration — methodology defaults', 'CFO AI calibration — methodology defaults', 2026, '2026-01-01', 'estimated'),
  ('VAL:generic-rev', 'Valuation — generic RO SME', 'valuation', 'ev_revenue_multiple', 'ratio', 'generic', 0.5, 0.8, 1.3, 'x', 'CFO AI calibration — methodology defaults', 'CFO AI calibration — methodology defaults', 2026, '2026-01-01', 'estimated'),
  ('VAL:fmcg', 'Valuation — FMCG', 'valuation', 'ev_ebitda_multiple', 'ratio', 'fmcg', 6.0, 8.0, 10.0, 'x', 'CFO AI calibration — methodology defaults', 'CFO AI calibration — methodology defaults', 2026, '2026-01-01', 'estimated'),
  ('VAL:fmcg-rev', 'Valuation — FMCG', 'valuation', 'ev_revenue_multiple', 'ratio', 'fmcg', 0.6, 0.9, 1.4, 'x', 'CFO AI calibration — methodology defaults', 'CFO AI calibration — methodology defaults', 2026, '2026-01-01', 'estimated'),
  ('VAL:manufacturing', 'Valuation — manufacturing', 'valuation', 'ev_ebitda_multiple', 'ratio', 'manufacturing', 5.0, 6.5, 8.5, 'x', 'CFO AI calibration — methodology defaults', 'CFO AI calibration — methodology defaults', 2026, '2026-01-01', 'estimated'),
  ('VAL:manufacturing-rev', 'Valuation — manufacturing', 'valuation', 'ev_revenue_multiple', 'ratio', 'manufacturing', 0.6, 0.9, 1.3, 'x', 'CFO AI calibration — methodology defaults', 'CFO AI calibration — methodology defaults', 2026, '2026-01-01', 'estimated'),
  ('VAL:saas', 'Valuation — SaaS', 'valuation', 'ev_ebitda_multiple', 'ratio', 'saas', 10.0, 14.0, 20.0, 'x', 'CFO AI calibration — methodology defaults', 'CFO AI calibration — methodology defaults', 2026, '2026-01-01', 'estimated'),
  ('VAL:saas-rev', 'Valuation — SaaS', 'valuation', 'ev_revenue_multiple', 'ratio', 'saas', 3.0, 5.0, 8.0, 'x', 'CFO AI calibration — methodology defaults', 'CFO AI calibration — methodology defaults', 2026, '2026-01-01', 'estimated'),
  ('VAL:b2b_saas', 'Valuation — B2B SaaS', 'valuation', 'ev_ebitda_multiple', 'ratio', 'b2b_saas', 10.0, 14.0, 20.0, 'x', 'CFO AI calibration — methodology defaults', 'CFO AI calibration — methodology defaults', 2026, '2026-01-01', 'estimated'),
  ('VAL:b2b_saas-rev', 'Valuation — B2B SaaS', 'valuation', 'ev_revenue_multiple', 'ratio', 'b2b_saas', 3.0, 5.0, 8.0, 'x', 'CFO AI calibration — methodology defaults', 'CFO AI calibration — methodology defaults', 2026, '2026-01-01', 'estimated'),
  ('VAL:real_estate', 'Valuation — real estate', 'valuation', 'ev_ebitda_multiple', 'ratio', 'real_estate', 10.0, 12.0, 15.0, 'x', 'CFO AI calibration — methodology defaults', 'CFO AI calibration — methodology defaults', 2026, '2026-01-01', 'estimated'),
  ('VAL:real_estate-rev', 'Valuation — real estate', 'valuation', 'ev_revenue_multiple', 'ratio', 'real_estate', 6.0, 8.0, 11.0, 'x', 'CFO AI calibration — methodology defaults', 'CFO AI calibration — methodology defaults', 2026, '2026-01-01', 'estimated'),
  ('VAL:real_estate_commercial', 'Valuation — commercial RE', 'valuation', 'ev_ebitda_multiple', 'ratio', 'real_estate_commercial', 10.0, 12.0, 15.0, 'x', 'CFO AI calibration — methodology defaults', 'CFO AI calibration — methodology defaults', 2026, '2026-01-01', 'estimated'),
  ('VAL:real_estate_commercial-rev', 'Valuation — commercial RE', 'valuation', 'ev_revenue_multiple', 'ratio', 'real_estate_commercial', 6.0, 8.0, 11.0, 'x', 'CFO AI calibration — methodology defaults', 'CFO AI calibration — methodology defaults', 2026, '2026-01-01', 'estimated'),
  ('VAL:real_estate_residential', 'Valuation — residential RE', 'valuation', 'ev_ebitda_multiple', 'ratio', 'real_estate_residential', 9.0, 11.0, 14.0, 'x', 'CFO AI calibration — methodology defaults', 'CFO AI calibration — methodology defaults', 2026, '2026-01-01', 'estimated'),
  ('VAL:real_estate_residential-rev', 'Valuation — residential RE', 'valuation', 'ev_revenue_multiple', 'ratio', 'real_estate_residential', 5.0, 7.0, 10.0, 'x', 'CFO AI calibration — methodology defaults', 'CFO AI calibration — methodology defaults', 2026, '2026-01-01', 'estimated'),
  ('VAL:retail_ecom', 'Valuation — retail / e-commerce', 'valuation', 'ev_ebitda_multiple', 'ratio', 'retail_ecom', 5.0, 7.0, 9.0, 'x', 'CFO AI calibration — methodology defaults', 'CFO AI calibration — methodology defaults', 2026, '2026-01-01', 'estimated'),
  ('VAL:retail_ecom-rev', 'Valuation — retail / e-commerce', 'valuation', 'ev_revenue_multiple', 'ratio', 'retail_ecom', 0.4, 0.7, 1.1, 'x', 'CFO AI calibration — methodology defaults', 'CFO AI calibration — methodology defaults', 2026, '2026-01-01', 'estimated'),
  ('VAL:e_commerce', 'Valuation — e-commerce', 'valuation', 'ev_ebitda_multiple', 'ratio', 'e_commerce', 5.0, 7.0, 9.0, 'x', 'CFO AI calibration — methodology defaults', 'CFO AI calibration — methodology defaults', 2026, '2026-01-01', 'estimated'),
  ('VAL:e_commerce-rev', 'Valuation — e-commerce', 'valuation', 'ev_revenue_multiple', 'ratio', 'e_commerce', 0.4, 0.7, 1.1, 'x', 'CFO AI calibration — methodology defaults', 'CFO AI calibration — methodology defaults', 2026, '2026-01-01', 'estimated'),
  ('VAL:professional_services', 'Valuation — professional services', 'valuation', 'ev_ebitda_multiple', 'ratio', 'professional_services', 6.0, 8.0, 11.0, 'x', 'CFO AI calibration — methodology defaults', 'CFO AI calibration — methodology defaults', 2026, '2026-01-01', 'estimated'),
  ('VAL:professional_services-rev', 'Valuation — professional services', 'valuation', 'ev_revenue_multiple', 'ratio', 'professional_services', 0.8, 1.2, 1.8, 'x', 'CFO AI calibration — methodology defaults', 'CFO AI calibration — methodology defaults', 2026, '2026-01-01', 'estimated'),
  ('VAL:construction', 'Valuation — construction', 'valuation', 'ev_ebitda_multiple', 'ratio', 'construction', 4.0, 5.5, 7.0, 'x', 'CFO AI calibration — methodology defaults', 'CFO AI calibration — methodology defaults', 2026, '2026-01-01', 'estimated'),
  ('VAL:construction-rev', 'Valuation — construction', 'valuation', 'ev_revenue_multiple', 'ratio', 'construction', 0.3, 0.5, 0.8, 'x', 'CFO AI calibration — methodology defaults', 'CFO AI calibration — methodology defaults', 2026, '2026-01-01', 'estimated'),
  ('VAL:healthcare', 'Valuation — healthcare', 'valuation', 'ev_ebitda_multiple', 'ratio', 'healthcare', 7.0, 9.0, 12.0, 'x', 'CFO AI calibration — methodology defaults', 'CFO AI calibration — methodology defaults', 2026, '2026-01-01', 'estimated'),
  ('VAL:healthcare-rev', 'Valuation — healthcare', 'valuation', 'ev_revenue_multiple', 'ratio', 'healthcare', 1.0, 1.5, 2.2, 'x', 'CFO AI calibration — methodology defaults', 'CFO AI calibration — methodology defaults', 2026, '2026-01-01', 'estimated'),
  ('VAL:logistics', 'Valuation — logistics', 'valuation', 'ev_ebitda_multiple', 'ratio', 'logistics', 4.5, 6.0, 8.0, 'x', 'CFO AI calibration — methodology defaults', 'CFO AI calibration — methodology defaults', 2026, '2026-01-01', 'estimated'),
  ('VAL:logistics-rev', 'Valuation — logistics', 'valuation', 'ev_revenue_multiple', 'ratio', 'logistics', 0.4, 0.6, 0.9, 'x', 'CFO AI calibration — methodology defaults', 'CFO AI calibration — methodology defaults', 2026, '2026-01-01', 'estimated'),
  ('VAL:transport_logistics', 'Valuation — transport & logistics', 'valuation', 'ev_ebitda_multiple', 'ratio', 'transport_logistics', 4.5, 6.0, 8.0, 'x', 'CFO AI calibration — methodology defaults', 'CFO AI calibration — methodology defaults', 2026, '2026-01-01', 'estimated'),
  ('VAL:transport_logistics-rev', 'Valuation — transport & logistics', 'valuation', 'ev_revenue_multiple', 'ratio', 'transport_logistics', 0.4, 0.6, 0.9, 'x', 'CFO AI calibration — methodology defaults', 'CFO AI calibration — methodology defaults', 2026, '2026-01-01', 'estimated'),
  ('VAL:agriculture', 'Valuation — agriculture', 'valuation', 'ev_ebitda_multiple', 'ratio', 'agriculture', 5.0, 6.5, 8.5, 'x', 'CFO AI calibration — methodology defaults', 'CFO AI calibration — methodology defaults', 2026, '2026-01-01', 'estimated'),
  ('VAL:agriculture-rev', 'Valuation — agriculture', 'valuation', 'ev_revenue_multiple', 'ratio', 'agriculture', 0.6, 0.9, 1.3, 'x', 'CFO AI calibration — methodology defaults', 'CFO AI calibration — methodology defaults', 2026, '2026-01-01', 'estimated'),
  ('VAL:energy_utilities', 'Valuation — energy & utilities', 'valuation', 'ev_ebitda_multiple', 'ratio', 'energy_utilities', 5.0, 7.0, 9.0, 'x', 'CFO AI calibration — methodology defaults', 'CFO AI calibration — methodology defaults', 2026, '2026-01-01', 'estimated'),
  ('VAL:energy_utilities-rev', 'Valuation — energy & utilities', 'valuation', 'ev_revenue_multiple', 'ratio', 'energy_utilities', 0.8, 1.2, 1.8, 'x', 'CFO AI calibration — methodology defaults', 'CFO AI calibration — methodology defaults', 2026, '2026-01-01', 'estimated')
on conflict (caen_code, metric_name) do nothing;

-- ---------------------------------------------------------------------------
-- Reversal:
--   delete from industry_benchmarks where caen_code like 'VAL:%';
--   alter table industry_benchmarks
--     drop column if exists industry_key,
--     drop column if exists p25, drop column if exists p50,
--     drop column if exists p75, drop column if exists source,
--     drop column if exists as_of_date;
-- ---------------------------------------------------------------------------

-- Schema-migration discipline (CLAUDE.md): optimistic PostgREST reload; on
-- Supabase managed infra ALSO click Dashboard → Settings → API → "Reload
-- schema cache" after applying.
NOTIFY pgrst, 'reload schema';
