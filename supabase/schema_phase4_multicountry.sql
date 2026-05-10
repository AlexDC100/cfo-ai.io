-- CFO AI — Phase 4 schema: multi-country, multi-language COA support.
-- =============================================================================
-- Apply after schema.sql + schema_phase3.sql. Idempotent.
--
-- WHAT THIS ADDS
--   - countries: 15+ EU countries with default language / currency / COA
--   - coa_registries: chart-of-accounts metadata + detection signatures
--   - coa_account_mappings: per-COA account_code → standardized_bucket
--   - org_coa_mappings_overrides: per-org corrections to registry defaults
--   - documents columns: detected_language / detected_country / detected_coa
--     / detection_confidence / needs_format_confirmation
--
-- WHAT THIS DOES NOT DO
--   - The pipeline doesn't yet read from these tables — _ro_coa.py still
--     hardcodes the Romanian mappings. The pipeline refactor to use this
--     registry is Phase 4 Step 3.
--   - Detection (Phase 4 Step 2) is not wired yet.
--   - i18n migration (Phase 4 Step 4) is not in this file.
--
-- This commit puts the bones in place; subsequent commits wire the flesh.

-- ─── countries ──────────────────────────────────────────────────────────────
create table if not exists countries (
  code text primary key,                          -- ISO 3166-1 alpha-2
  display_name text not null,
  default_language text not null,                 -- ISO 639-1
  supported_languages text[] not null default '{}',
  default_currency text not null,                 -- ISO 4217
  default_coa text                                -- coa_registries.key (FK added below)
);

-- ─── coa_registries ─────────────────────────────────────────────────────────
create table if not exists coa_registries (
  key text primary key,
  country_code text references countries(code) on delete restrict,
  display_name text not null,
  language text not null,
  description text,
  detection_signatures jsonb not null default '{}'::jsonb,
  number_format jsonb not null default '{"decimal":".","thousand":","}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Defer the FK on countries.default_coa until after registries exist.
alter table countries
  drop constraint if exists countries_default_coa_fkey;
alter table countries
  add constraint countries_default_coa_fkey
  foreign key (default_coa) references coa_registries(key) deferrable initially deferred;

-- ─── coa_account_mappings ───────────────────────────────────────────────────
create table if not exists coa_account_mappings (
  id uuid primary key default gen_random_uuid(),
  coa_key text references coa_registries(key) on delete cascade not null,
  account_code text not null,
  account_name_native text not null,
  account_name_native_alts text[] default '{}',
  standardized_bucket text not null,              -- 'cash','ar','inventory','revenue', etc.
  statement text not null check (statement in ('BS','PL','CF','memo')),
  sign smallint not null default 1 check (sign in (1, -1)),
  created_at timestamptz not null default now(),
  unique (coa_key, account_code)
);

create index if not exists coa_account_mappings_coa_bucket_idx
  on coa_account_mappings (coa_key, standardized_bucket);

-- ─── org_coa_mappings_overrides ─────────────────────────────────────────────
-- Per-org corrections that take precedence over registry defaults.
create table if not exists org_coa_mappings_overrides (
  org_id uuid references organizations(id) on delete cascade not null,
  coa_key text references coa_registries(key) on delete cascade not null,
  account_code text not null,
  standardized_bucket text not null,
  sign smallint not null default 1 check (sign in (1, -1)),
  set_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (org_id, coa_key, account_code)
);

alter table org_coa_mappings_overrides enable row level security;
drop policy if exists "org_coa_overrides member select" on org_coa_mappings_overrides;
drop policy if exists "org_coa_overrides member write" on org_coa_mappings_overrides;
create policy "org_coa_overrides member select" on org_coa_mappings_overrides
  for select using (is_member_of(org_id));
create policy "org_coa_overrides member write" on org_coa_mappings_overrides
  for all using (is_member_of(org_id)) with check (is_member_of(org_id));

-- countries / coa_registries / coa_account_mappings are read-only reference
-- data — open SELECT, no INSERT/UPDATE/DELETE policies (those happen via
-- service-role migrations only).
alter table countries enable row level security;
alter table coa_registries enable row level security;
alter table coa_account_mappings enable row level security;

drop policy if exists "countries public select" on countries;
drop policy if exists "coa_registries public select" on coa_registries;
drop policy if exists "coa_account_mappings public select" on coa_account_mappings;

create policy "countries public select" on countries for select using (true);
create policy "coa_registries public select" on coa_registries for select using (true);
create policy "coa_account_mappings public select" on coa_account_mappings for select using (true);

-- ─── documents detection columns ────────────────────────────────────────────
alter table documents add column if not exists detected_language text;
alter table documents add column if not exists detected_country text;
alter table documents add column if not exists detected_coa text;
alter table documents add column if not exists detection_confidence numeric;
alter table documents add column if not exists needs_format_confirmation boolean not null default false;

-- ═════════════════════════════════════════════════════════════════════════
-- SEED DATA — 15 countries + 4 fully-mapped registries + 12 starter registries
-- ═════════════════════════════════════════════════════════════════════════

insert into countries (code, display_name, default_language, supported_languages, default_currency, default_coa) values
  ('RO', 'Romania',     'ro', ARRAY['ro','en'],         'RON', 'omfp_1802'),
  ('DE', 'Germany',     'de', ARRAY['de','en'],         'EUR', 'skr_03'),
  ('AT', 'Austria',     'de', ARRAY['de','en'],         'EUR', 'at_ekr'),
  ('CH', 'Switzerland', 'de', ARRAY['de','fr','it','en'],'CHF', 'ch_kmu_kkr'),
  ('FR', 'France',      'fr', ARRAY['fr','en'],         'EUR', 'pcg_2014'),
  ('BE', 'Belgium',     'nl', ARRAY['nl','fr','de','en'],'EUR', 'be_pcmn'),
  ('NL', 'Netherlands', 'nl', ARRAY['nl','en'],         'EUR', 'nl_rgs'),
  ('IT', 'Italy',       'it', ARRAY['it','en'],         'EUR', 'it_codice_civile'),
  ('ES', 'Spain',       'es', ARRAY['es','en'],         'EUR', 'pgc_2007'),
  ('PT', 'Portugal',    'pt', ARRAY['pt','en'],         'EUR', 'pt_snc'),
  ('PL', 'Poland',      'pl', ARRAY['pl','en'],         'PLN', 'pl_uor'),
  ('CZ', 'Czechia',     'cs', ARRAY['cs','en'],         'CZK', 'cz_uctovy_rozvrh'),
  ('HU', 'Hungary',     'hu', ARRAY['hu','en'],         'HUF', 'hu_szamlatukor'),
  ('IE', 'Ireland',     'en', ARRAY['en'],              'EUR', 'frs_102'),
  ('SE', 'Sweden',      'sv', ARRAY['sv','en'],         'SEK', 'se_bas'),
  ('DK', 'Denmark',     'da', ARRAY['da','en'],         'DKK', 'dk_standard')
on conflict (code) do update set
  display_name = excluded.display_name,
  default_language = excluded.default_language,
  supported_languages = excluded.supported_languages,
  default_currency = excluded.default_currency,
  default_coa = excluded.default_coa;

-- ─── coa_registries with detection signatures ──────────────────────────────
insert into coa_registries (key, country_code, display_name, language, description, detection_signatures, number_format) values
  ('omfp_1802', 'RO', 'OMFP 1802 (Romania)', 'ro',
   'Romanian statutory chart of accounts, classes 1–7 with 3–4 digit codes.',
   '{"filename_patterns":["balanta","verificare","trial.balance"],"header_keywords_native":["BALANȚA DE VERIFICARE","BILANȚ","PROFIT ȘI PIERDERE"],"account_code_pattern":"^[1-7][0-9]{2,4}$","language_markers":["Sold inițial","Rulaj cumulat","Sold final","Debit","Credit"]}'::jsonb,
   '{"decimal":",","thousand":"."}'::jsonb),
  ('skr_03', 'DE', 'SKR 03 (Germany)', 'de',
   'Standardkontenrahmen 03 — handelsrechtlich, 4-digit codes.',
   '{"filename_patterns":["saldenliste","summen.und.salden","kontensaldo","skr"],"header_keywords_native":["Saldenliste","Summen- und Saldenliste","Bilanz","Gewinn- und Verlustrechnung","Kontensaldoliste"],"account_code_pattern":"^[0-9]{4}$","language_markers":["Soll","Haben","Anfangsbestand","Schlussbestand","Konto","EB-Wert"]}'::jsonb,
   '{"decimal":",","thousand":"."}'::jsonb),
  ('skr_04', 'DE', 'SKR 04 (Germany)', 'de',
   'Standardkontenrahmen 04 — bilanzgliederungsorientiert, 4-digit codes.',
   '{"filename_patterns":["saldenliste","skr04"],"header_keywords_native":["Saldenliste","SKR 04","Bilanz"],"account_code_pattern":"^[0-9]{4}$","language_markers":["Soll","Haben","Konto"]}'::jsonb,
   '{"decimal":",","thousand":"."}'::jsonb),
  ('at_ekr', 'AT', 'EKR (Austria)', 'de',
   'Österreichischer Einheitskontorahmen, 4-digit codes.',
   '{"filename_patterns":["saldenliste","ekr","kontorahmen"],"header_keywords_native":["EKR","Einheitskontorahmen","Saldenliste"],"account_code_pattern":"^[0-9]{4}$","language_markers":["Soll","Haben","Konto"]}'::jsonb,
   '{"decimal":",","thousand":"."}'::jsonb),
  ('ch_kmu_kkr', 'CH', 'KMU-KKR (Switzerland)', 'de',
   'Schweizer KMU-Kontenrahmen, 4-digit codes.',
   '{"filename_patterns":["kontoplan","kkr","saldoliste"],"header_keywords_native":["Kontoplan","KMU","Saldoliste"],"account_code_pattern":"^[0-9]{4}$","language_markers":["Soll","Haben","CHF"]}'::jsonb,
   '{"decimal":".","thousand":"''"}'::jsonb),
  ('pcg_2014', 'FR', 'PCG 2014 (France)', 'fr',
   'Plan Comptable Général 2014, 3–6 digit codes.',
   '{"filename_patterns":["balance","grand.livre","fec_","plan.comptable"],"header_keywords_native":["Balance des comptes","Grand livre","Bilan","Compte de résultat","Plan Comptable"],"account_code_pattern":"^[1-7][0-9]{1,5}$","language_markers":["Débit","Crédit","Solde","Mouvement","Période"]}'::jsonb,
   '{"decimal":",","thousand":" "}'::jsonb),
  ('be_pcmn', 'BE', 'PCMN / MAR (Belgium)', 'fr',
   'Plan comptable minimum normalisé / Minimumindeling van het Algemeen Rekeningstelsel.',
   '{"filename_patterns":["balance","saldibalans","pcmn","mar"],"header_keywords_native":["PCMN","MAR","Saldibalans","Balance des comptes"],"account_code_pattern":"^[0-9]{6}$","language_markers":["Débit","Crédit","Debet","Credit"]}'::jsonb,
   '{"decimal":",","thousand":"."}'::jsonb),
  ('nl_rgs', 'NL', 'RGS (Netherlands)', 'nl',
   'Referentie Grootboekschema.',
   '{"filename_patterns":["grootboek","kolommenbalans","rgs"],"header_keywords_native":["Grootboek","Kolommenbalans","Balans","Winst- en verliesrekening","RGS"],"account_code_pattern":"^[0-9]{4,8}$","language_markers":["Debet","Credit","Saldo"]}'::jsonb,
   '{"decimal":",","thousand":"."}'::jsonb),
  ('it_codice_civile', 'IT', 'Codice Civile schema (Italy)', 'it',
   'Italian Civil Code statutory schema.',
   '{"filename_patterns":["bilancio","mastrini","piano.conti"],"header_keywords_native":["Bilancio","Stato Patrimoniale","Conto Economico","Piano dei conti"],"account_code_pattern":"^[A-Z]?[0-9.]+$","language_markers":["Dare","Avere","Saldo","Periodo"]}'::jsonb,
   '{"decimal":",","thousand":"."}'::jsonb),
  ('pgc_2007', 'ES', 'PGC 2007 (Spain)', 'es',
   'Plan General de Contabilidad, 3–7 digit codes.',
   '{"filename_patterns":["balance","sumas.y.saldos","pgc","libro.mayor"],"header_keywords_native":["Balance de Comprobación","Sumas y Saldos","Balance de Situación","Cuenta de Pérdidas y Ganancias","Plan General de Contabilidad"],"account_code_pattern":"^[1-7][0-9]{1,6}$","language_markers":["Debe","Haber","Saldo","Acumulado"]}'::jsonb,
   '{"decimal":",","thousand":"."}'::jsonb),
  ('pt_snc', 'PT', 'SNC (Portugal)', 'pt',
   'Sistema de Normalização Contabilística.',
   '{"filename_patterns":["balancete","balanco","snc"],"header_keywords_native":["Balancete","Balanço","Demonstração de Resultados","SNC"],"account_code_pattern":"^[1-8][0-9.]{1,8}$","language_markers":["Débito","Crédito","Saldo"]}'::jsonb,
   '{"decimal":",","thousand":"."}'::jsonb),
  ('pl_uor', 'PL', 'UoR (Poland)', 'pl',
   'Ustawa o Rachunkowości plan kont.',
   '{"filename_patterns":["bilans","obroty","saldo","plan.kont"],"header_keywords_native":["Bilans","Obroty i Salda","Rachunek Zysków i Strat","Plan Kont"],"account_code_pattern":"^[0-9]{3,8}$","language_markers":["Winien","Ma","Saldo"]}'::jsonb,
   '{"decimal":",","thousand":" "}'::jsonb),
  ('cz_uctovy_rozvrh', 'CZ', 'Účtový rozvrh (Czechia)', 'cs',
   'Český účtový rozvrh, 3-digit synthetic + analytical codes.',
   '{"filename_patterns":["obratova","rozvaha","saldo"],"header_keywords_native":["Rozvaha","Obratová předvaha","Výsledovka","Účtový rozvrh"],"account_code_pattern":"^[0-9]{3}([0-9]{0,4})?$","language_markers":["Má dáti","Dal","Zůstatek"]}'::jsonb,
   '{"decimal":",","thousand":" "}'::jsonb),
  ('hu_szamlatukor', 'HU', 'Számlatükör (Hungary)', 'hu',
   'Magyar számlatükör.',
   '{"filename_patterns":["fokonyv","mainkonyv","szamla"],"header_keywords_native":["Főkönyv","Mérleg","Eredménykimutatás","Számlatükör"],"account_code_pattern":"^[0-9]{3,6}$","language_markers":["Tartozik","Követel","Egyenleg"]}'::jsonb,
   '{"decimal":",","thousand":" "}'::jsonb),
  ('frs_102', 'IE', 'FRS 102 line items (Ireland)', 'en',
   'Irish FRS 102 reporting standard line items.',
   '{"filename_patterns":["trial.balance","balance.sheet"],"header_keywords_native":["Trial Balance","Balance Sheet","Profit and Loss","FRS 102"],"account_code_pattern":"^[0-9]{3,8}$","language_markers":["Debit","Credit","Balance"]}'::jsonb,
   '{"decimal":".","thousand":","}'::jsonb),
  ('se_bas', 'SE', 'BAS-kontoplanen (Sweden)', 'sv',
   'BAS-kontoplanen, 4-digit codes.',
   '{"filename_patterns":["huvudbok","balansrapport","bas"],"header_keywords_native":["Huvudbok","Balansrapport","Resultatrapport","BAS-kontoplan"],"account_code_pattern":"^[1-8][0-9]{3}$","language_markers":["Debet","Kredit","Saldo"]}'::jsonb,
   '{"decimal":",","thousand":" "}'::jsonb),
  ('dk_standard', 'DK', 'Standardkontoplan (Denmark)', 'da',
   'Danish standard chart of accounts.',
   '{"filename_patterns":["saldobalance","kontoplan"],"header_keywords_native":["Saldobalance","Balance","Resultatopgørelse","Kontoplan"],"account_code_pattern":"^[0-9]{4,6}$","language_markers":["Debet","Kredit","Saldo"]}'::jsonb,
   '{"decimal":",","thousand":"."}'::jsonb)
on conflict (key) do update set
  country_code = excluded.country_code,
  display_name = excluded.display_name,
  language = excluded.language,
  description = excluded.description,
  detection_signatures = excluded.detection_signatures,
  number_format = excluded.number_format;

-- ═════════════════════════════════════════════════════════════════════════
-- ACCOUNT MAPPINGS
-- ═════════════════════════════════════════════════════════════════════════
-- Romanian OMFP 1802 mappings are derived from _ro_coa.py — applying them
-- here keeps the source of truth in the database (the Python helper can
-- read from coa_account_mappings in a follow-up commit). Other registries
-- get starter mappings for the most common buckets (cash, AR, inventory,
-- PPE, AP, debt, equity, revenue, expenses); the full ~60 per registry
-- is a per-country expansion task.

-- Wipe + re-insert is the safest pattern for the seed; this file owns
-- mappings until per-country expansion PRs arrive.
delete from coa_account_mappings where coa_key in ('omfp_1802','skr_03','pcg_2014','pgc_2007');

-- ─── OMFP 1802 (Romania) — 60+ mappings ────────────────────────────────────
insert into coa_account_mappings (coa_key, account_code, account_name_native, standardized_bucket, statement, sign) values
  ('omfp_1802', '1012', 'Capital subscris vărsat', 'shareCapital', 'BS', 1),
  ('omfp_1802', '101',  'Capital subscris', 'shareCapital', 'BS', 1),
  ('omfp_1802', '104',  'Prime de capital', 'otherEquity', 'BS', 1),
  ('omfp_1802', '105',  'Rezerve din reevaluare', 'otherEquity', 'BS', 1),
  ('omfp_1802', '106',  'Rezerve', 'otherEquity', 'BS', 1),
  ('omfp_1802', '1061', 'Rezerve legale', 'otherEquity', 'BS', 1),
  ('omfp_1802', '117',  'Rezultatul reportat', 'retainedEarnings', 'BS', 1),
  ('omfp_1802', '121',  'Profit/pierdere curentă', 'retainedEarnings', 'BS', 1),
  ('omfp_1802', '129',  'Repartizare profit', 'retainedEarnings', 'BS', -1),
  ('omfp_1802', '151',  'Provizioane', 'otherCurrentLiab', 'BS', 1),
  ('omfp_1802', '16',   'Împrumuturi pe termen lung', 'ltDebt', 'BS', 1),
  ('omfp_1802', '162',  'Credite bancare TL', 'ltDebt', 'BS', 1),
  ('omfp_1802', '166',  'Datorii financiare TL', 'ltDebt', 'BS', 1),
  ('omfp_1802', '167',  'Alte împrumuturi', 'ltDebt', 'BS', 1),
  ('omfp_1802', '168',  'Dobânzi de plătit', 'interestExpense', 'PL', 1),
  ('omfp_1802', '201',  'Cheltuieli de constituire', 'intangibles', 'BS', 1),
  ('omfp_1802', '203',  'Cheltuieli de dezvoltare', 'intangibles', 'BS', 1),
  ('omfp_1802', '205',  'Concesiuni, brevete', 'intangibles', 'BS', 1),
  ('omfp_1802', '208',  'Alte imobilizări necorporale', 'intangibles', 'BS', 1),
  ('omfp_1802', '212',  'Construcții', 'ppe', 'BS', 1),
  ('omfp_1802', '213',  'Echipamente', 'ppe', 'BS', 1),
  ('omfp_1802', '215',  'Investiții imobiliare', 'ppe', 'BS', 1),
  ('omfp_1802', '21',   'Imobilizări corporale', 'ppe', 'BS', 1),
  ('omfp_1802', '232',  'Avansuri imobilizări', 'ppe', 'BS', 1),
  ('omfp_1802', '23',   'Imobilizări în curs', 'ppe', 'BS', 1),
  ('omfp_1802', '267',  'Creanțe imobilizate', 'otherNonCurrentAssets', 'BS', 1),
  ('omfp_1802', '26',   'Imobilizări financiare', 'otherNonCurrentAssets', 'BS', 1),
  ('omfp_1802', '28',   'Amortizare imobilizări', 'ppe', 'BS', -1),
  ('omfp_1802', '29',   'Ajustări depreciere imobilizări', 'ppe', 'BS', -1),
  ('omfp_1802', '345',  'Produse finite', 'inventory', 'BS', 1),
  ('omfp_1802', '371',  'Mărfuri', 'inventory', 'BS', 1),
  ('omfp_1802', '3',    'Stocuri', 'inventory', 'BS', 1),
  ('omfp_1802', '401',  'Furnizori', 'ap', 'BS', 1),
  ('omfp_1802', '403',  'Efecte de plătit', 'ap', 'BS', 1),
  ('omfp_1802', '404',  'Furnizori imobilizări', 'ap', 'BS', 1),
  ('omfp_1802', '408',  'Furnizori facturi nesosite', 'ap', 'BS', 1),
  ('omfp_1802', '409',  'Avansuri către furnizori', 'otherCurrentAssets', 'BS', 1),
  ('omfp_1802', '4111', 'Clienți', 'ar', 'BS', 1),
  ('omfp_1802', '411',  'Clienți', 'ar', 'BS', 1),
  ('omfp_1802', '418',  'Clienți facturi de întocmit', 'ar', 'BS', 1),
  ('omfp_1802', '419',  'Avansuri clienți', 'otherCurrentLiab', 'BS', 1),
  ('omfp_1802', '421',  'Personal salarii', 'otherCurrentLiab', 'BS', 1),
  ('omfp_1802', '43',   'Asigurări sociale', 'otherCurrentLiab', 'BS', 1),
  ('omfp_1802', '441',  'Impozit pe profit', 'taxExpense', 'PL', 1),
  ('omfp_1802', '442',  'TVA', 'otherCurrentLiab', 'BS', 1),
  ('omfp_1802', '444',  'Impozit salarii', 'otherCurrentLiab', 'BS', 1),
  ('omfp_1802', '446',  'Alte impozite', 'otherCurrentLiab', 'BS', 1),
  ('omfp_1802', '448',  'Alte datorii fiscale', 'otherCurrentLiab', 'BS', 1),
  ('omfp_1802', '461',  'Debitori diverși', 'otherCurrentAssets', 'BS', 1),
  ('omfp_1802', '462',  'Creditori diverși', 'otherCurrentLiab', 'BS', 1),
  ('omfp_1802', '47',   'Conturi regularizare active', 'otherCurrentAssets', 'BS', 1),
  ('omfp_1802', '509',  'Vărsăminte de efectuat', 'stDebt', 'BS', 1),
  ('omfp_1802', '5121', 'Conturi curente bancă RON', 'cash', 'BS', 1),
  ('omfp_1802', '5124', 'Conturi curente bancă valută', 'cash', 'BS', 1),
  ('omfp_1802', '512',  'Conturi curente la bănci', 'cash', 'BS', 1),
  ('omfp_1802', '519',  'Credite bancare termen scurt', 'stDebt', 'BS', 1),
  ('omfp_1802', '531',  'Casa', 'cash', 'BS', 1),
  ('omfp_1802', '601',  'Cheltuieli materii prime', 'cogs', 'PL', 1),
  ('omfp_1802', '602',  'Materiale consumabile', 'cogs', 'PL', 1),
  ('omfp_1802', '60',   'Cheltuieli materii prime', 'cogs', 'PL', 1),
  ('omfp_1802', '628',  'Servicii executate de terți', 'operatingExpenses', 'PL', 1),
  ('omfp_1802', '62',   'Alte servicii terți', 'operatingExpenses', 'PL', 1),
  ('omfp_1802', '635',  'Impozite și taxe', 'operatingExpenses', 'PL', 1),
  ('omfp_1802', '63',   'Cheltuieli impozite', 'operatingExpenses', 'PL', 1),
  ('omfp_1802', '641',  'Cheltuieli salariale', 'operatingExpenses', 'PL', 1),
  ('omfp_1802', '64',   'Cheltuieli personal', 'operatingExpenses', 'PL', 1),
  ('omfp_1802', '666',  'Dobânzi', 'interestExpense', 'PL', 1),
  ('omfp_1802', '665',  'Diferențe de curs', 'financialExpense', 'PL', 1),
  ('omfp_1802', '66',   'Cheltuieli financiare', 'financialExpense', 'PL', 1),
  ('omfp_1802', '681',  'Amortizare', 'depreciation', 'PL', 1),
  ('omfp_1802', '691',  'Impozit pe profit', 'taxExpense', 'PL', 1),
  ('omfp_1802', '704',  'Venituri lucrări/servicii', 'revenue', 'PL', 1),
  ('omfp_1802', '706',  'Redevențe/chirii', 'revenue', 'PL', 1),
  ('omfp_1802', '707',  'Vânzarea mărfurilor', 'revenue', 'PL', 1),
  ('omfp_1802', '70',   'Venituri din vânzări', 'revenue', 'PL', 1),
  ('omfp_1802', '711',  'Variația stocurilor', 'otherIncome', 'PL', 1),
  ('omfp_1802', '74',   'Subvenții', 'otherIncome', 'PL', 1),
  ('omfp_1802', '758',  'Alte venituri exploatare', 'otherIncome', 'PL', 1),
  ('omfp_1802', '761',  'Venituri din participații', 'financialIncome', 'PL', 1),
  ('omfp_1802', '766',  'Venituri din dobânzi', 'financialIncome', 'PL', 1),
  ('omfp_1802', '76',   'Venituri financiare', 'financialIncome', 'PL', 1);

-- ─── SKR 03 (Germany) — starter mappings, common buckets ────────────────────
insert into coa_account_mappings (coa_key, account_code, account_name_native, standardized_bucket, statement, sign) values
  ('skr_03', '1000', 'Kasse', 'cash', 'BS', 1),
  ('skr_03', '1200', 'Bank', 'cash', 'BS', 1),
  ('skr_03', '1210', 'Postbank', 'cash', 'BS', 1),
  ('skr_03', '1400', 'Forderungen aus Lieferungen und Leistungen', 'ar', 'BS', 1),
  ('skr_03', '1410', 'Forderungen Inland', 'ar', 'BS', 1),
  ('skr_03', '0500', 'Sachanlagen', 'ppe', 'BS', 1),
  ('skr_03', '0600', 'Maschinen', 'ppe', 'BS', 1),
  ('skr_03', '0700', 'BGA', 'ppe', 'BS', 1),
  ('skr_03', '3300', 'Verbindlichkeiten aus Lieferungen und Leistungen', 'ap', 'BS', 1),
  ('skr_03', '3500', 'Sonstige Verbindlichkeiten', 'otherCurrentLiab', 'BS', 1),
  ('skr_03', '0630', 'Darlehen', 'ltDebt', 'BS', 1),
  ('skr_03', '3150', 'Verbindlichkeiten gegenüber Kreditinstituten kurzfristig', 'stDebt', 'BS', 1),
  ('skr_03', '0810', 'Gezeichnetes Kapital', 'shareCapital', 'BS', 1),
  ('skr_03', '0860', 'Gewinnrücklagen', 'otherEquity', 'BS', 1),
  ('skr_03', '0900', 'Gewinnvortrag', 'retainedEarnings', 'BS', 1),
  ('skr_03', '3980', 'Waren', 'inventory', 'BS', 1),
  ('skr_03', '3970', 'Roh-, Hilfs- und Betriebsstoffe', 'inventory', 'BS', 1),
  ('skr_03', '8400', 'Erlöse 19% USt', 'revenue', 'PL', 1),
  ('skr_03', '8300', 'Erlöse 7% USt', 'revenue', 'PL', 1),
  ('skr_03', '8200', 'Erlöse', 'revenue', 'PL', 1),
  ('skr_03', '3200', 'Wareneingang', 'cogs', 'PL', 1),
  ('skr_03', '6300', 'Raumkosten', 'operatingExpenses', 'PL', 1),
  ('skr_03', '6400', 'Versicherungen, Beiträge', 'operatingExpenses', 'PL', 1),
  ('skr_03', '6500', 'Reparaturen', 'operatingExpenses', 'PL', 1),
  ('skr_03', '6600', 'Werbe- und Reisekosten', 'operatingExpenses', 'PL', 1),
  ('skr_03', '6800', 'Allgemeine Verwaltungskosten', 'operatingExpenses', 'PL', 1),
  ('skr_03', '6900', 'Sonstige betriebliche Aufwendungen', 'operatingExpenses', 'PL', 1),
  ('skr_03', '6020', 'Löhne und Gehälter', 'operatingExpenses', 'PL', 1),
  ('skr_03', '4830', 'Abschreibungen auf Sachanlagen', 'depreciation', 'PL', 1),
  ('skr_03', '4800', 'Abschreibungen', 'depreciation', 'PL', 1),
  ('skr_03', '2100', 'Zinsen und ähnliche Aufwendungen', 'interestExpense', 'PL', 1),
  ('skr_03', '2000', 'Zinserträge', 'financialIncome', 'PL', 1),
  ('skr_03', '7600', 'Körperschaftsteuer', 'taxExpense', 'PL', 1),
  ('skr_03', '7610', 'Gewerbesteuer', 'taxExpense', 'PL', 1);

-- ─── PCG 2014 (France) — starter mappings, common buckets ──────────────────
insert into coa_account_mappings (coa_key, account_code, account_name_native, standardized_bucket, statement, sign) values
  ('pcg_2014', '101', 'Capital', 'shareCapital', 'BS', 1),
  ('pcg_2014', '106', 'Réserves', 'otherEquity', 'BS', 1),
  ('pcg_2014', '110', 'Report à nouveau', 'retainedEarnings', 'BS', 1),
  ('pcg_2014', '120', 'Résultat de l''exercice', 'retainedEarnings', 'BS', 1),
  ('pcg_2014', '164', 'Emprunts auprès des établissements de crédit', 'ltDebt', 'BS', 1),
  ('pcg_2014', '167', 'Emprunts et dettes assortis de conditions particulières', 'ltDebt', 'BS', 1),
  ('pcg_2014', '20',  'Immobilisations incorporelles', 'intangibles', 'BS', 1),
  ('pcg_2014', '21',  'Immobilisations corporelles', 'ppe', 'BS', 1),
  ('pcg_2014', '213', 'Constructions', 'ppe', 'BS', 1),
  ('pcg_2014', '215', 'Installations techniques', 'ppe', 'BS', 1),
  ('pcg_2014', '218', 'Autres immobilisations corporelles', 'ppe', 'BS', 1),
  ('pcg_2014', '28',  'Amortissements des immobilisations', 'ppe', 'BS', -1),
  ('pcg_2014', '37',  'Stocks de marchandises', 'inventory', 'BS', 1),
  ('pcg_2014', '370', 'Stocks de marchandises', 'inventory', 'BS', 1),
  ('pcg_2014', '38',  'Stocks en cours de route', 'inventory', 'BS', 1),
  ('pcg_2014', '401', 'Fournisseurs', 'ap', 'BS', 1),
  ('pcg_2014', '404', 'Fournisseurs d''immobilisations', 'ap', 'BS', 1),
  ('pcg_2014', '411', 'Clients', 'ar', 'BS', 1),
  ('pcg_2014', '418', 'Clients — factures à établir', 'ar', 'BS', 1),
  ('pcg_2014', '421', 'Personnel — rémunérations dues', 'otherCurrentLiab', 'BS', 1),
  ('pcg_2014', '43',  'Sécurité sociale', 'otherCurrentLiab', 'BS', 1),
  ('pcg_2014', '44',  'État', 'otherCurrentLiab', 'BS', 1),
  ('pcg_2014', '512', 'Banques', 'cash', 'BS', 1),
  ('pcg_2014', '530', 'Caisse', 'cash', 'BS', 1),
  ('pcg_2014', '519', 'Concours bancaires courants', 'stDebt', 'BS', 1),
  ('pcg_2014', '601', 'Achats stockés — matières premières', 'cogs', 'PL', 1),
  ('pcg_2014', '607', 'Achats de marchandises', 'cogs', 'PL', 1),
  ('pcg_2014', '60',  'Achats', 'cogs', 'PL', 1),
  ('pcg_2014', '61',  'Services extérieurs', 'operatingExpenses', 'PL', 1),
  ('pcg_2014', '62',  'Autres services extérieurs', 'operatingExpenses', 'PL', 1),
  ('pcg_2014', '63',  'Impôts et taxes', 'operatingExpenses', 'PL', 1),
  ('pcg_2014', '64',  'Charges de personnel', 'operatingExpenses', 'PL', 1),
  ('pcg_2014', '65',  'Autres charges de gestion courante', 'operatingExpenses', 'PL', 1),
  ('pcg_2014', '66',  'Charges financières', 'financialExpense', 'PL', 1),
  ('pcg_2014', '661', 'Charges d''intérêts', 'interestExpense', 'PL', 1),
  ('pcg_2014', '67',  'Charges exceptionnelles', 'operatingExpenses', 'PL', 1),
  ('pcg_2014', '68',  'Dotations aux amortissements et provisions', 'depreciation', 'PL', 1),
  ('pcg_2014', '695', 'Impôts sur les bénéfices', 'taxExpense', 'PL', 1),
  ('pcg_2014', '707', 'Ventes de marchandises', 'revenue', 'PL', 1),
  ('pcg_2014', '706', 'Prestations de services', 'revenue', 'PL', 1),
  ('pcg_2014', '70',  'Ventes', 'revenue', 'PL', 1),
  ('pcg_2014', '74',  'Subventions d''exploitation', 'otherIncome', 'PL', 1),
  ('pcg_2014', '76',  'Produits financiers', 'financialIncome', 'PL', 1);

-- ─── PGC 2007 (Spain) — starter mappings, common buckets ───────────────────
insert into coa_account_mappings (coa_key, account_code, account_name_native, standardized_bucket, statement, sign) values
  ('pgc_2007', '100', 'Capital social', 'shareCapital', 'BS', 1),
  ('pgc_2007', '110', 'Prima de emisión', 'otherEquity', 'BS', 1),
  ('pgc_2007', '112', 'Reserva legal', 'otherEquity', 'BS', 1),
  ('pgc_2007', '113', 'Reservas voluntarias', 'otherEquity', 'BS', 1),
  ('pgc_2007', '120', 'Resultados ejercicios anteriores', 'retainedEarnings', 'BS', 1),
  ('pgc_2007', '129', 'Resultado del ejercicio', 'retainedEarnings', 'BS', 1),
  ('pgc_2007', '170', 'Deudas a largo plazo', 'ltDebt', 'BS', 1),
  ('pgc_2007', '171', 'Deudas LP entidades de crédito', 'ltDebt', 'BS', 1),
  ('pgc_2007', '20',  'Inmovilizado intangible', 'intangibles', 'BS', 1),
  ('pgc_2007', '21',  'Inmovilizado material', 'ppe', 'BS', 1),
  ('pgc_2007', '211', 'Construcciones', 'ppe', 'BS', 1),
  ('pgc_2007', '213', 'Maquinaria', 'ppe', 'BS', 1),
  ('pgc_2007', '281', 'Amortización acumulada', 'ppe', 'BS', -1),
  ('pgc_2007', '30',  'Comerciales', 'inventory', 'BS', 1),
  ('pgc_2007', '300', 'Mercaderías', 'inventory', 'BS', 1),
  ('pgc_2007', '400', 'Proveedores', 'ap', 'BS', 1),
  ('pgc_2007', '410', 'Acreedores por prestaciones de servicios', 'ap', 'BS', 1),
  ('pgc_2007', '430', 'Clientes', 'ar', 'BS', 1),
  ('pgc_2007', '440', 'Deudores', 'otherCurrentAssets', 'BS', 1),
  ('pgc_2007', '465', 'Remuneraciones pendientes de pago', 'otherCurrentLiab', 'BS', 1),
  ('pgc_2007', '475', 'Hacienda Pública acreedora', 'otherCurrentLiab', 'BS', 1),
  ('pgc_2007', '476', 'Organismos Seguridad Social', 'otherCurrentLiab', 'BS', 1),
  ('pgc_2007', '520', 'Deudas CP entidades de crédito', 'stDebt', 'BS', 1),
  ('pgc_2007', '570', 'Caja', 'cash', 'BS', 1),
  ('pgc_2007', '572', 'Bancos', 'cash', 'BS', 1),
  ('pgc_2007', '60',  'Compras', 'cogs', 'PL', 1),
  ('pgc_2007', '600', 'Compras de mercaderías', 'cogs', 'PL', 1),
  ('pgc_2007', '62',  'Servicios exteriores', 'operatingExpenses', 'PL', 1),
  ('pgc_2007', '63',  'Tributos', 'operatingExpenses', 'PL', 1),
  ('pgc_2007', '64',  'Gastos de personal', 'operatingExpenses', 'PL', 1),
  ('pgc_2007', '65',  'Otros gastos de gestión', 'operatingExpenses', 'PL', 1),
  ('pgc_2007', '66',  'Gastos financieros', 'financialExpense', 'PL', 1),
  ('pgc_2007', '662', 'Intereses de deudas', 'interestExpense', 'PL', 1),
  ('pgc_2007', '68',  'Dotaciones para amortizaciones', 'depreciation', 'PL', 1),
  ('pgc_2007', '630', 'Impuesto sobre beneficios', 'taxExpense', 'PL', 1),
  ('pgc_2007', '700', 'Ventas de mercaderías', 'revenue', 'PL', 1),
  ('pgc_2007', '70',  'Ventas', 'revenue', 'PL', 1),
  ('pgc_2007', '74',  'Subvenciones', 'otherIncome', 'PL', 1),
  ('pgc_2007', '76',  'Ingresos financieros', 'financialIncome', 'PL', 1);

-- Verify
select country_code, count(*) as registries
from coa_registries group by country_code order by country_code;
