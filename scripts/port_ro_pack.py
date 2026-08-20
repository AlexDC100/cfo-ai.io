#!/usr/bin/env python3
"""port_ro_pack.py — the FROZEN historical port source of packs/ro/omfp1802-v1/.

DIRECTION OF TRUTH (Phase 3 cutover, 2026-08-20): the pack YAML under
packs/ro/omfp1802-v1/ is the RUNTIME SOURCE OF TRUTH for Romanian
classification — chart_of_accounts._RULES / BIFUNCTIONAL_WRONG_SIDE_FLIPS
and the parser's SIDE_FLIP_TO_LIAB_PREFIXES no longer exist as runtime
tables (bucket_for / accounts_to_assemble_shape read the CompiledPack).
This script keeps the tables AS THEY WERE at the cutover, FROZEN below
(FROZEN_RULES / FROZEN_BIFUNCTIONAL_WRONG_SIDE_FLIPS /
FROZEN_PARSER_SIDE_FLIPS / FROZEN_MAPPING_VERSION), and regenerates the
five pack files from them:

    packs/ro/omfp1802-v1/pack.yaml            identity + provenance
    packs/ro/omfp1802-v1/classification.yaml  FROZEN_RULES + both frozen
                                              flip layers folded to
                                              side_flip + contra (sign=-1)
    packs/ro/omfp1802-v1/checks.yaml          D0-D9 diagnosis configuration
                                              (engine.confidence.
                                              reconciliation_checks constants
                                              — still LIVE reads: those
                                              tolerances stay engine-owned)
    packs/ro/omfp1802-v1/statement_map.yaml   canonical_bs v2 section/row
                                              vocabulary with the frozen
                                              rule buckets as leaves (the
                                              _BUCKET_TO_*_FIELD placement
                                              tables are still LIVE reads —
                                              they remain engine presentation
                                              tables, not classification)
    packs/ro/omfp1802-v1/reconcile.yaml       auto-reconcile constants
                                              (0.001 gate, class-6/7 P&L
                                              placement, 'Diferențe de
                                              reconciliere' labels — LIVE
                                              reads from engine.api._reconcile)

--check is therefore the PACK-VS-FROZEN-SNAPSHOT gate: regeneration must
stay byte-identical to the checked-in v1 pack
(tests/engine/test_ro_pack.py::test_regeneration_is_byte_identical), so
pack_hash cannot drift silently. Any deliberate rule change is made in
the PACK YAML as a NEW pack version (new directory, new effective
window) — this script is never edited to "update" v1; it documents what
v1 was ported from. A --check failure means either (a) the v1 YAML was
hand-edited (revert it, cut a v2 instead), or (b) one of the still-live
engine constants this generator mirrors changed (reconcile constants,
D0-D9 params, statement placement tables) — which likewise demands a
deliberate new pack version, not a silent v1 rewrite.

SIDE-FLIP REPRESENTATION (as ported). The pre-cutover engine had TWO
flip layers; the pack schema carries ONE flip on the winning
ClassificationRule, so both layers were folded onto it (they never
disagree — asserted at generation):

  * FROZEN_BIFUNCTIONAL_WRONG_SIDE_FLIPS (assembler layer): matched per
    CODE longest-prefix-first; a sign=+1 rule whose closing balance sat
    on the side OPPOSITE its natural one re-routed. A rule whose prefix
    falls inside a flip family carries that family's flip (longest flip
    entry matching the rule's prefix).
  * FROZEN_PARSER_SIDE_FLIPS (trial_balance_parser layer — the
    DETERMINISTIC lane's first flip layer, found by the shadow-
    divergence gate): a family whose closing balance sat on the CREDIT
    side re-routed to otherCurrentLiab BEFORE the assembler ran.
    Families whose winning rule already targets otherCurrentLiab need
    no flip (425 — a no-op; the parser lane still surfaces those rows
    as bucket_override for byte-stability of its shaped output);
    families with NO classification rule (467) stay unmapped — the flip
    could never fire because rule lookup preceded the flip check. NOTE
    the parser layer fired on the credit side even when that IS the
    rule's natural side (1687 under the 168 -> ltDebt winner), so a
    pack flip may legitimately carry the natural side — the schema
    permits it, and the assembler's wrong-side re-route deliberately
    ignores natural-side flips (chart_of_accounts.wrong_side_flip_bucket).
  * a flip entry FINER than the rule table gets a synthesized
    FLIP-CARRIER rule — same line_id the frozen winner produces, so
    classification is unchanged; only the flip is carried ('512' under
    the '51' cash catchall from the bifunctional table; '1687' under
    the '168' ltDebt rule from the parser table).
  * a flip entry with NO code-mapped winner (today only '411':
    4112-4117/4119 have no rule and fall to the F3.10 name fallback,
    which is engine logic outside the pack) is represented by the flips
    already carried on its code-mapped sub-families (4111, 4118).

The frozen-vs-pack equivalence is proven exhaustively by the
universe-parity test in tests/engine/test_ro_pack.py (every 1-4 digit
code: same rule-or-None, same line, same contra, same flip behavior as
the FULL frozen model — parser layer first, then the bifunctional
layer) and end-to-end by the corpus battery (scripts/corpus_replay.py,
byte-identical across the cutover) plus the consistency harness
(scripts/shadow_report.py: production composition vs the classify pass
over the front-end IR, both reading the same pack).

USAGE
  python scripts/port_ro_pack.py                 # (re)write packs/ro/omfp1802-v1/
  python scripts/port_ro_pack.py --out DIR       # write elsewhere (tests)
  python scripts/port_ro_pack.py --check         # regenerate to temp + byte-diff
                                                 # against the checked-in pack;
                                                 # exit 1 on ANY drift

EXIT CODES: 0 = written (or --check clean), 1 = --check drift or
self-check failure, 2 = internal/usage error.
"""
from __future__ import annotations

import argparse
import difflib
import importlib.util
import json
import re
import sys
import tempfile
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

# ── Repo-root + sys.path setup — independent of cwd (same pattern as
# scripts/pack_lint.py) ─────────────────────────────────────────────────


def _find_repo_root() -> Path:
    here = Path(__file__).resolve().parent
    for candidate in [here, *here.parents][:6]:
        if (candidate / "pyproject.toml").is_file():
            return candidate
    return Path(__file__).resolve().parent.parent


REPO = _find_repo_root()
SRC = REPO / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

# Still-LIVE engine reads (post-cutover): the presentation/placement
# tables (_BUCKET_TO_BS_FIELD / _BUCKET_TO_PL_FIELD / _empty_bs) and the
# canonical section vocabulary remain engine-owned — the generator reads
# them live so an engine-side change to statement PLACEMENT trips --check
# and forces a deliberate new pack version. The CLASSIFICATION tables are
# NOT imported anymore — they no longer exist in the engine; the frozen
# copies below are the historical port source.
from engine.country_packs.ro_romania import chart_of_accounts as coa  # noqa: E402
from engine.country_packs.ro_romania import canonical_adapter as ca  # noqa: E402

#: Default output directory (the checked-in pack).
DEFAULT_OUT = REPO / "packs" / "ro" / "omfp1802-v1"

#: Emitted file order (mirrors engine.packs.loader.PACK_FILES).
PACK_FILE_NAMES = (
    "pack.yaml",
    "classification.yaml",
    "checks.yaml",
    "statement_map.yaml",
    "reconcile.yaml",
)

#: Port date — fixed so regeneration stays byte-identical.
PORT_DATE = "2026-08-19"


# ── THE FROZEN PORT SOURCE (Phase 3 cutover, 2026-08-20) ───────────────
# The in-code tables exactly as they stood when packs/ro/omfp1802-v1 was
# cut. These are HISTORY, not configuration: the running engine reads
# the pack YAML; editing these constants can only make --check fail.


class PortRule:
    """The frozen shape of a chart_of_accounts.MappingRule at the
    cutover: (prefix, bucket, sign, description)."""

    __slots__ = ("prefix", "bucket", "sign", "description")

    def __init__(self, prefix: str, bucket: str, sign: int, description: str):
        self.prefix = prefix
        self.bucket = bucket
        self.sign = sign
        self.description = description


#: The in-code MAPPING_VERSION at the moment of the Phase-3 cutover —
#: the vintage string every pre-cutover envelope carries. FROZEN.
FROZEN_MAPPING_VERSION = "ro_omfp1802_v2"

#: chart_of_accounts._RULES at the cutover — (prefix, bucket, sign,
#: description) tuples, DECLARATION ORDER (classification.yaml emits
#: rules in this order). Descriptions verbatim, diacritics included.
FROZEN_RULES: Tuple[PortRule, ...] = (
    PortRule('1012', 'shareCapital', 1, 'Capital subscris vărsat'),
    PortRule('101', 'shareCapital', 1, 'Capital subscris (catchall 101x)'),
    PortRule('104', 'otherEquity', 1, 'Prime de capital'),
    PortRule('105', 'equity_revaluation', 1, 'Rezerve din reevaluare — non-cash equity'),
    PortRule('1061', 'otherEquity', 1, 'Rezerve legale'),
    PortRule('106', 'otherEquity', 1, 'Rezerve (catchall 106x other than 1061)'),
    PortRule('1171', 'retained_earnings', 1, 'Rezultatul reportat — prior-year carry-forward'),
    PortRule('117', 'retained_earnings', 1, 'Rezultatul reportat (catchall 117x other than 1171)'),
    PortRule('121', 'ignore_control', 1, 'Profit si pierdere — CONTROL, never summed'),
    PortRule('129', 'retainedEarnings', -1, 'Repartizare profit'),
    PortRule('151', 'otherNonCurrentLiab', 1, 'Provizioane — non-current per OMFP bilanț'),
    PortRule('161', 'ltDebt', 1, 'Împrumuturi din emisiuni de obligațiuni (bonds)'),
    PortRule('164', 'ltDebt', 1, 'Credite pe termen lung (non-standard analytic)'),
    PortRule('165', 'ltDebt', 1, 'Împrumuturi pe termen lung (non-standard analytic)'),
    PortRule('166', 'ltDebt', 1, 'Datorii către entități afiliate — LT intra-group loans'),
    PortRule('169', 'ltDebt', -1, 'Prime rambursare obligațiuni — contra-debt, nets vs 161'),
    PortRule('1621', 'ltDebt', 1, 'Credite bancare pe termen lung'),
    PortRule('1622', 'ltDebt', 1, 'Credite bancare pe termen lung restante'),
    PortRule('1623', 'ltDebt', 1, 'Credite externe garantate de stat'),
    PortRule('1625', 'ltDebt', 1, 'Credite bancare nerambursate la scadență'),
    PortRule('168', 'ltDebt', 1, 'Dobânzi aferente împrumuturilor — accrued LT interest (BS liability)'),
    PortRule('167', 'ltDebt', 1, 'Datorii din leasing financiar'),
    PortRule('201', 'intangibles', 1, 'Cheltuieli de constituire'),
    PortRule('203', 'intangibles', 1, 'Cheltuieli de dezvoltare'),
    PortRule('205', 'intangibles', 1, 'Concesiuni, brevete'),
    PortRule('207', 'intangibles', 1, 'Fond comercial'),
    PortRule('208', 'intangibles', 1, 'Alte imobilizări necorporale'),
    PortRule('211', 'ppe', 1, 'Terenuri'),
    PortRule('212', 'ppe', 1, 'Construcții'),
    PortRule('213', 'ppe', 1, 'Echipamente'),
    PortRule('214', 'ppe', 1, 'Mobilier, aparatură birotică'),
    PortRule('215', 'ppe_investment', 1, 'Investiții imobiliare — CRE signal'),
    PortRule('231', 'ppe_under_construction', 1, 'Imobilizări corporale în curs'),
    PortRule('232', 'ppe', 1, 'Avansuri imobilizări (legacy advance — see 4093)'),
    PortRule('261', 'otherNonCurrentAssets', 1, 'Acțiuni entități afiliate'),
    PortRule('263', 'otherNonCurrentAssets', 1, 'Interese de participare'),
    PortRule('265', 'otherNonCurrentAssets', 1, 'Alte titluri imobilizate'),
    PortRule('2671', 'otherNonCurrentAssets', 1, 'Creanțe imobilizate'),
    PortRule('2678', 'otherNonCurrentAssets', 1, 'Alte creanțe imobilizate'),
    PortRule('269', 'otherNonCurrentAssets', -1, 'Vărsăminte de efectuat imobilizări financiare — contra to 26x'),
    PortRule('2801', 'intangibles', -1, 'Amort. cheltuieli de constituire'),
    PortRule('2803', 'intangibles', -1, 'Amort. cheltuieli de dezvoltare'),
    PortRule('2805', 'intangibles', -1, 'Amort. concesiuni, brevete'),
    PortRule('2808', 'intangibles', -1, 'Amort. alte imob. necorporale'),
    PortRule('2811', 'ppe', -1, 'Amort. construcții (1)'),
    PortRule('2812', 'ppe', -1, 'Amort. construcții (2)'),
    PortRule('2813', 'ppe', -1, 'Amort. instalații / transport'),
    PortRule('2814', 'ppe', -1, 'Amort. alte imob. corporale'),
    PortRule('2815', 'ppe', -1, 'Amort. investiții imobiliare'),
    PortRule('29', 'ppe', -1, 'Ajustări depreciere imobilizări'),
    PortRule('371', 'inventory', 1, 'Mărfuri'),
    PortRule('345', 'inventory', 1, 'Produse finite'),
    PortRule('391', 'inventory', -1, 'Ajustări depreciere materii prime — contra'),
    PortRule('392', 'inventory', -1, 'Ajustări depreciere materiale — contra'),
    PortRule('393', 'inventory', -1, 'Ajustări depreciere producție în curs — contra'),
    PortRule('394', 'inventory', -1, 'Ajustări depreciere produse finite — contra'),
    PortRule('395', 'inventory', -1, 'Ajustări depreciere semifabricate — contra'),
    PortRule('396', 'inventory', -1, 'Ajustări depreciere bunuri expediate — contra'),
    PortRule('397', 'inventory', -1, 'Ajustări depreciere mărfuri — contra'),
    PortRule('398', 'inventory', -1, 'Ajustări depreciere ambalaje — contra'),
    PortRule('3', 'inventory', 1, 'Stocuri (catchall)'),
    PortRule('401', 'ap', 1, 'Furnizori'),
    PortRule('403', 'ap', 1, 'Efecte de plătit'),
    PortRule('404', 'ap', 1, 'Furnizori imobilizări'),
    PortRule('408', 'ap', 1, 'Furnizori facturi nesosite'),
    PortRule('4093', 'ppe_advances', 1, 'Avansuri pt. imobilizări — capex advance'),
    PortRule('4091', 'otherCurrentAssets', 1, 'Avansuri furnizori stocuri'),
    PortRule('4092', 'otherCurrentAssets', 1, 'Avansuri furnizori servicii'),
    PortRule('409', 'otherCurrentAssets', 1, 'Avansuri furnizori (catchall 409x)'),
    PortRule('4111', 'ar', 1, 'Clienți'),
    PortRule('4118', 'ar_doubtful', 1, 'Clienți incerți (gross — see 491 contra)'),
    PortRule('4130', 'ar', 1, 'Efecte de primit (notes receivable)'),
    PortRule('418', 'ar', 1, 'Clienți facturi de întocmit (D-side)'),
    PortRule('419', 'otherCurrentLiab', 1, 'Clienți creditori — advances FROM customers'),
    PortRule('421', 'otherCurrentLiab', 1, 'Personal — salarii datorate'),
    PortRule('4281', 'otherCurrentLiab', 1, 'Alte datorii personal'),
    PortRule('4283', 'otherCurrentLiab', 1, 'Alte datorii legate de personal'),
    PortRule('423', 'otherCurrentLiab', 1, 'Personal — ajutoare'),
    PortRule('425', 'otherCurrentLiab', 1, 'Avansuri salarii'),
    PortRule('426', 'otherCurrentLiab', 1, 'Drepturi neplătite'),
    PortRule('427', 'otherCurrentLiab', 1, 'Alte drepturi personal'),
    PortRule('4315', 'otherCurrentLiab', 1, 'Contribuții asigurări sociale'),
    PortRule('4316', 'otherCurrentLiab', 1, 'Contribuții asigurări sănătate'),
    PortRule('431', 'otherCurrentLiab', 1, 'Asigurări sociale (catchall 431x)'),
    PortRule('436', 'otherCurrentLiab', 1, 'Contribuția asiguratorie de muncă'),
    PortRule('4382', 'otherCurrentAssets', 1, 'Alte creanțe sociale'),
    PortRule('4411', 'otherCurrentLiab', 1, 'Impozit pe profit DE PLĂTIT — BS liab, NOT P&L'),
    PortRule('441', 'otherCurrentLiab', 1, 'Impozit pe profit (catchall 441x)'),
    PortRule('4424', 'otherCurrentAssets', 1, 'TVA de recuperat'),
    PortRule('4426', 'otherCurrentAssets', 1, 'TVA deductibilă — input VAT, asset'),
    PortRule('4428', 'otherCurrentLiab', 1, 'TVA neexigibilă — by balance side (D-side flips to asset)'),
    PortRule('442', 'otherCurrentLiab', 1, 'TVA (catchall)'),
    PortRule('444', 'otherCurrentLiab', 1, 'Impozit salarii'),
    PortRule('446', 'otherCurrentLiab', 1, 'Alte impozite'),
    PortRule('4482', 'otherCurrentAssets', 1, 'Alte creanțe bugetul statului'),
    PortRule('448', 'otherCurrentLiab', 1, 'Alte datorii fiscale'),
    PortRule('445', 'otherCurrentLiab', 1, 'Alte impozite locale'),
    PortRule('447', 'otherCurrentLiab', 1, 'Fonduri speciale (mediu, accize, etc.)'),
    PortRule('451', 'ar_intercompany', 1, 'Decontări entități afiliate (D-side)'),
    PortRule('452', 'ar_intercompany', 1, 'Decontări participanți și acționari (D-side)'),
    PortRule('455', 'ar_intercompany', 1, 'Asociați conturi curente (D-side)'),
    PortRule('456', 'shareCapital', 1, 'Decontări acționari'),
    PortRule('457', 'ap_dividends', 1, 'Dividende de plată — NEVER in total_debt'),
    PortRule('461', 'ar_intercompany', 1, 'Debitori diverși — related-party flag'),
    PortRule('462', 'otherCurrentLiab', 1, 'Creditori diverși'),
    PortRule('471', 'otherCurrentAssets', 1, 'Cheltuieli înregistrate în avans'),
    PortRule('473', 'otherCurrentAssets', 1, 'Decontări operațiuni curs clarificare (473x)'),
    PortRule('472', 'otherCurrentLiab', 1, 'Venituri înregistrate în avans (deferred revenue)'),
    PortRule('475', 'otherNonCurrentLiab', 1, 'Subvenții pentru investiții (LT)'),
    PortRule('478', 'otherNonCurrentLiab', 1, 'Venituri în avans LT (grants)'),
    PortRule('491', 'ar', -1, 'Ajustări deprecierea creanțelor — contra-asset'),
    PortRule('496', 'ar', -1, 'Ajustări deprecierea creanțe afiliate — contra'),
    PortRule('495', 'ar', -1, 'Ajustări deprecierea creanțe decontări grup — contra'),
    PortRule('49', 'ar', -1, 'Ajustări deprecierea creanțelor (catchall 49x) — contra'),
    PortRule('481', 'otherCurrentAssets', 1, 'Decontări în cadrul unității'),
    PortRule('509', 'stDebt', 1, 'Vărsăminte de efectuat'),
    PortRule('5121', 'cash', 1, 'Conturi curente bancă RON'),
    PortRule('5124', 'cash_fx', 1, 'Conturi curente bancă valută'),
    PortRule('5191', 'stDebt', 1, 'Credite bancare termen scurt'),
    PortRule('5192', 'stDebt', 1, 'Credite bancare termen scurt nerambursate'),
    PortRule('5311', 'cash', 1, 'Casa în lei'),
    PortRule('5314', 'cash_fx', 1, 'Casa în valută'),
    PortRule('532', 'otherCurrentAssets', 1, 'Alte valori — tichete masă etc (532x)'),
    PortRule('581', 'ignore_transit', 1, 'Viramente interne — NEVER in cash'),
    PortRule('891', 'ignore_offbalance', 1, 'Bilanț de deschidere — opening BS control, never summed'),
    PortRule('892', 'ignore_offbalance', 1, 'Bilanț de închidere — closing BS control, never summed'),
    PortRule('8', 'ignore_offbalance', 1, 'Class 8 extrabilanțiere — off-balance memo, never summed'),
    PortRule('601', 'cogs', 1, 'Cheltuieli cu materii prime'),
    PortRule('602', 'cogs', 1, 'Materiale consumabile'),
    PortRule('607', 'cogs', 1, 'Cheltuieli privind mărfurile'),
    PortRule('603', 'operatingExpenses', 1, 'Obiecte de inventar'),
    PortRule('604', 'operatingExpenses', 1, 'Materiale nestocate'),
    PortRule('605', 'operatingExpenses', 1, 'Energia și apa'),
    PortRule('6024', 'operatingExpenses', 1, 'Piese de schimb'),
    PortRule('6051', 'operatingExpenses', 1, 'Consum de energie'),
    PortRule('611', 'operatingExpenses', 1, 'Întreținerea și reparațiile'),
    PortRule('6123', 'operatingExpenses', 1, 'Chirii'),
    PortRule('613', 'operatingExpenses', 1, 'Prime de asigurare'),
    PortRule('622', 'operatingExpenses', 1, 'Comisioane și onorarii'),
    PortRule('626', 'operatingExpenses', 1, 'Poștă și telecomunicații'),
    PortRule('627', 'operatingExpenses', 1, 'Servicii bancare (non-financial)'),
    PortRule('628', 'opex_third_party', 1, 'Servicii executate de terți — anomaly check'),
    PortRule('635', 'operatingExpenses', 1, 'Impozite și taxe'),
    PortRule('65', 'operatingExpenses', 1, 'Class 65 — alte cheltuieli exploatare (catchall)'),
    PortRule('62', 'operatingExpenses', 1, 'Class 62 — servicii executate de terți (catchall)'),
    PortRule('612', 'operatingExpenses', 1, 'Ch. chirii și redevențe (rent + royalties)'),
    PortRule('615', 'operatingExpenses', 1, 'Ch. pregătire personal (training)'),
    PortRule('618', 'operatingExpenses', 1, 'Ch. servicii diverse (subclass)'),
    PortRule('642', 'operatingExpenses', 1, 'Ch. tichete (meal & gift vouchers)'),
    PortRule('646', 'operatingExpenses', 1, 'Ch. contribuții asiguratorie muncă'),
    PortRule('6814', 'depreciation', 1, 'Ch. provizioane active circulante'),
    PortRule('665', 'fx_loss', 1, 'Diferențe nefavorabile curs (catchall)'),
    PortRule('668', 'financialExpense', 1, 'Alte cheltuieli financiare'),
    PortRule('781', 'otherIncome', 1, 'Venituri din provizioane reluare (operating)'),
    PortRule('768', 'financial_income', 1, 'Alte venituri financiare'),
    PortRule('641', 'operatingExpenses', 1, 'Salariile personalului'),
    PortRule('645', 'operatingExpenses', 1, 'Asigurări sociale (cheltuieli)'),
    PortRule('6458', 'operatingExpenses', 1, 'Alte asigurări sociale'),
    PortRule('6461', 'operatingExpenses', 1, 'Contribuția asiguratorie pt. muncă'),
    PortRule('6651', 'fx_loss', 1, 'Diferențe nefavorabile de curs valutar'),
    PortRule('666', 'interest_expense', 1, 'Cheltuieli privind dobânzile'),
    PortRule('667', 'financialExpense', 1, 'Sconturi acordate'),
    PortRule('6811', 'depreciation', 1, 'Amortizarea imobilizărilor'),
    PortRule('6812', 'depreciation', 1, 'Provizioane pt. exploatare'),
    PortRule('691', 'taxExpense', 1, 'Cheltuieli cu impozitul pe profit'),
    PortRule('701', 'revenue', 1, 'Venituri din vânzarea produselor finite'),
    PortRule('704', 'revenue', 1, 'Venituri din servicii prestate'),
    PortRule('706', 'revenue', 1, 'Venituri din chirii — CRE signal'),
    PortRule('707', 'revenue', 1, 'Venituri din vânzarea mărfurilor'),
    PortRule('708', 'revenue', 1, 'Venituri din activități diverse'),
    PortRule('709', 'revenue', 1, 'Reduceri comerciale acordate — contra-revenue (Claude-signed)'),
    PortRule('711', 'inventoryVariationMemo', 1, 'Variația stocurilor — non-cash memo'),
    PortRule('721', 'capitalizedOwnWork', 1, 'Capitalized own-work — MEMO, excluded from EBITDA'),
    PortRule('722', 'capitalizedOwnWork', 1, 'Producția imobilizări corporale — MEMO'),
    PortRule('725', 'capitalizedOwnWork', 1, 'Producția imobilizări (other) — MEMO'),
    PortRule('740', 'otherIncome', 1, 'Subvenții — flagged non-recurring'),
    PortRule('758', 'otherIncome', 1, 'Alte venituri exploatare'),
    PortRule('7611', 'financial_income', 1, 'Venituri dividende — entități afiliate'),
    PortRule('7612', 'financial_income', 1, 'Venituri dividende — entități asociate'),
    PortRule('762', 'financial_income', 1, 'Venituri din interese de participare'),
    PortRule('763', 'financial_income', 1, 'Venituri din creanțe imobilizate'),
    PortRule('7651', 'fx_gain', 1, 'Diferențe favorabile de curs valutar'),
    PortRule('766', 'interest_income', 1, 'Venituri din dobânzi'),
    PortRule('767', 'financial_income', 1, 'Venituri din sconturi obținute'),
    PortRule('13', 'otherNonCurrentLiab', 1, 'F3.8: Subvenții pentru investiții (catchall 13x)'),
    PortRule('14', 'otherEquity', 1, 'F3.8: Câștiguri/pierderi instrumente capital (catchall 14x)'),
    PortRule('22', 'ppe', 1, 'F3.8: Imobilizări în concesiune / leasing (catchall 22x)'),
    PortRule('50', 'otherCurrentAssets', 1, 'F3.8: Investiții pe termen scurt (catchall 50x; 509 stays stDebt)'),
    PortRule('519', 'stDebt', 1, 'F3.8: Credite bancare termen scurt (catchall 519x other than 5191/5192)'),
    PortRule('51', 'cash', 1, 'F3.8: Conturi la bănci (catchall 51x; 519/5121/5124 stay specific)'),
    PortRule('54', 'cash', 1, 'F3.8: Acreditive (letters of credit — catchall 54x)'),
    PortRule('59', 'cash', -1, 'F3.8: Ajustări depreciere trezorerie — contra (catchall 59x)'),
    PortRule('60', 'operatingExpenses', 1, 'F3.8: Class 60 catchall (606/608/609 — packaging, returns, discounts received)'),
    PortRule('61', 'operatingExpenses', 1, 'F3.8: Class 61 catchall (614/616/617 — equipment rent, misc services)'),
    PortRule('63', 'operatingExpenses', 1, 'F3.8: Class 63 catchall (633/634/636/637/638 — other taxes & fees)'),
    PortRule('64', 'operatingExpenses', 1, 'F3.8: Class 64 catchall (643/644/647/648 — deferred personnel, jetoane, social tickets)'),
    PortRule('66', 'financialExpense', 1, 'F3.8: Class 66 catchall (663/664/669 — other financial losses)'),
    PortRule('67', 'operatingExpenses', 1, 'F3.8: Class 67 catchall (pre-2015 extraordinary expenses, rare)'),
    PortRule('68', 'depreciation', 1, 'F3.8: Class 68 catchall (686/687/689 — other depreciation/provisions)'),
    PortRule('69', 'taxExpense', 1, 'F3.8: Class 69 catchall (695/698 — deferred tax, other income tax)'),
    PortRule('765', 'fx_gain', 1, 'F3.8: Diferențe favorabile curs (catchall 765x; 7651 stays specific)'),
    PortRule('70', 'revenue', 1, 'F3.8: Class 70 catchall (702/703/705 — semifabricate, reziduale, cercetare)'),
    PortRule('71', 'inventoryVariationMemo', 1, 'F3.8: Class 71 catchall (712 — variația produselor; same memo as 711)'),
    PortRule('72', 'capitalizedOwnWork', 1, 'F3.8: Class 72 catchall (723/724 — capitalized prod. of inventory/intangibles)'),
    PortRule('74', 'otherIncome', 1, 'F3.8: Class 74 catchall (741/745/749 — operating subsidies, other grants)'),
    PortRule('75', 'otherIncome', 1, 'F3.8: Class 75 catchall (754/755/757 — reactivated receivables, other op income)'),
    PortRule('76', 'financial_income', 1, 'F3.8: Class 76 catchall (any 76x not specifically mapped above)'),
    PortRule('77', 'otherIncome', 1, 'F3.8: Class 77 catchall (pre-2015 extraordinary income, rare)'),
    PortRule('78', 'otherIncome', 1, 'F3.8: Class 78 catchall (786/788 — other reversals; 781 stays specific)'),
)

#: chart_of_accounts.BIFUNCTIONAL_WRONG_SIDE_FLIPS at the cutover —
#: (prefix, opposite-side bucket), declaration order.
FROZEN_BIFUNCTIONAL_WRONG_SIDE_FLIPS: Tuple[Tuple[str, str], ...] = (
    ('4111', 'otherCurrentLiab'),
    ('411', 'otherCurrentLiab'),
    ('401', 'otherCurrentAssets'),
    ('409', 'otherCurrentLiab'),
    ('419', 'otherCurrentAssets'),
    ('455', 'otherCurrentLiab'),
    ('461', 'otherCurrentLiab'),
    ('462', 'otherCurrentAssets'),
    ('473', 'otherCurrentLiab'),
    ('4424', 'otherCurrentLiab'),
    ('4426', 'otherCurrentLiab'),
    ('4428', 'otherCurrentAssets'),
    ('5121', 'stDebt'),
    ('5124', 'stDebt'),
    ('512', 'stDebt'),
)

#: trial_balance_parser SIDE_FLIP_TO_LIAB_PREFIXES at the cutover —
#: the deterministic lane's credit-side re-route families.
FROZEN_PARSER_SIDE_FLIPS: Tuple[str, ...] = (
    '418', '451', '452', '455', '461', '467', '425', '1687',
)


def load_reconciliation_checks_module():
    """Load engine/confidence/reconciliation_checks.py BY FILE PATH.

    The `engine.confidence` package __init__ imports sibling modules
    (anomalies, quality_envelope) that are absent in some checkouts —
    the same reason canonical_adapter._load_run_bs_diagnosis carries a
    path-loading fallback. The module itself is dependency-light."""
    path = SRC / "engine" / "confidence" / "reconciliation_checks.py"
    name = "_port_ro_pack_reconciliation_checks"
    cached = sys.modules.get(name)
    if cached is not None:
        return cached
    spec = importlib.util.spec_from_file_location(name, str(path))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod  # register before exec (dataclasses)
    spec.loader.exec_module(mod)
    return mod


# ── Reconcile constants — read from the ACTUAL source text ─────────────
# engine/api/_reconcile.py imports fastapi + engine.serving + _supabase
# at module level, so importing it here would drag runtime dependencies
# into a data-generation script. The three constants this pack needs are
# extracted from the source text with hard-failing patterns instead —
# still reading the real code, still a drift alarm when it changes.

_RECONCILE_PATTERNS = {
    "synthetic_row_label": r'^SYNTHETIC_ROW_LABEL\s*=\s*"([^"]+)"',
    "synthetic_row_id": r'^SYNTHETIC_ROW_ID\s*=\s*"([^"]+)"',
    "gate_multiplier": r"^_GATE_MULTIPLIER\s*=\s*(\d+)",
    "placement_detail_bs": r'^PLACEMENT_DETAIL_BS\s*=\s*"([^"]+)"',
    "placement_detail_pl_income": r'^PLACEMENT_DETAIL_PL_INCOME\s*=\s*"([^"]+)"',
    "placement_detail_pl_expense": r'^PLACEMENT_DETAIL_PL_EXPENSE\s*=\s*"([^"]+)"',
}


def extract_reconcile_constants(repo: Path = REPO) -> Dict[str, str]:
    """The auto-reconcile constants from src/engine/api/_reconcile.py."""
    source = (repo / "src" / "engine" / "api" / "_reconcile.py").read_text(
        encoding="utf-8"
    )
    out: Dict[str, str] = {}
    for key, pattern in _RECONCILE_PATTERNS.items():
        match = re.search(pattern, source, re.MULTILINE)
        if match is None:
            raise SystemExit(
                "port_ro_pack: constant %r not found in engine/api/_reconcile.py "
                "(pattern %r) — the reconcile constants moved; update the port "
                "script." % (key, pattern)
            )
        out[key] = match.group(1)
    return out


# ── Parser-layer side-flip families (frozen) ───────────────────────────
# Pre-cutover, trial_balance_parser.accounts_to_assemble_shape re-routed
# these MIXED-SIDE families to otherCurrentLiab whenever the closing
# balance sat on the CREDIT side (sf_c > sf_d) — BEFORE the assembler's
# bifunctional layer ran, and only for codes a classification rule
# matched (rule lookup preceded the flip check). Post-cutover the pack's
# side_flip data owns the DESTINATION (the parser reads
# CompiledPack.target_line(code, 'credit')); the parser keeps only a
# shaped-row ENCODING tuple for these families (byte-stability of its
# telemetry output). Found by the shadow-divergence gate on 5 corpus
# cases (418/451x/4511 credit closings).

#: The override bucket the parser layer routed to at the cutover.
_PARSER_FLIP_TARGET = "otherCurrentLiab"


def extract_parser_side_flips(repo: Path = REPO) -> Tuple[str, ...]:
    """The frozen parser-layer flip families. The ``repo`` parameter is
    kept for call-site compatibility (pre-cutover this function read the
    parser source text); the table is frozen data now."""
    return FROZEN_PARSER_SIDE_FLIPS


# ── YAML emission helpers (hand-built text: deterministic formatting,
# comments preserved — yaml.dump can do neither) ───────────────────────


def q(value: str) -> str:
    """Double-quoted YAML scalar via JSON escaping (a JSON string is a
    valid YAML double-quoted scalar for all text this pack carries;
    ensure_ascii=False keeps the Romanian diacritics literal)."""
    return json.dumps(value, ensure_ascii=False)


def qlist(values: Sequence[str]) -> str:
    return "[" + ", ".join(q(v) for v in values) + "]"


# ── Derived, still-mechanical lookup tables ────────────────────────────

#: The asset-side fields of the legacy BS dict (chart_of_accounts.
#: _empty_bs). Explicit here, asserted against the live dict below —
#: they decide each bucket's NATURAL balance side (asset = debit) and
#: its canonical_bs v2 section side.
_ASSET_BS_FIELDS = (
    "cash",
    "accountsReceivable",
    "inventory",
    "otherCurrentAssets",
    "propertyPlantEquipment",
    "intangibles",
    "otherNonCurrentAssets",
)

#: Legacy BS field → canonical_bs v2 section (the OMFP bilanț section the
#: field's rows present under; canonical_adapter._BS_V2_SECTION_ORDER is
#: the section vocabulary).
_FIELD_TO_SECTION = {
    "cash": "current_assets",
    "accountsReceivable": "current_assets",
    "inventory": "current_assets",
    "otherCurrentAssets": "current_assets",
    "propertyPlantEquipment": "non_current_assets",
    "intangibles": "non_current_assets",
    "otherNonCurrentAssets": "non_current_assets",
    "accountsPayable": "current_liabilities",
    "shortTermDebt": "current_liabilities",
    "otherCurrentLiabilities": "current_liabilities",
    "longTermDebt": "non_current_liabilities",
    "otherNonCurrentLiabilities": "non_current_liabilities",
    "shareCapital": "equity",
    "retainedEarnings": "equity",
    "otherEquity": "equity",
}

#: Section labels (OMFP 1802 bilanț wording).
_SECTION_LABELS = {
    "non_current_assets": "Active imobilizate",
    "current_assets": "Active circulante",
    "prepaid_expenses": "Cheltuieli în avans",
    "equity": "Capitaluri proprii",
    "provisions": "Provizioane",
    "non_current_liabilities": "Datorii: sumele care trebuie plătite într-o perioadă mai mare de un an",
    "current_liabilities": "Datorii: sumele care trebuie plătite într-o perioadă de până la un an",
    "deferred_income": "Venituri în avans",
}

#: Presentation labels for the classifiable leaves (the _RULES bucket
#: ids). Generator-owned wording; a bucket with no label here makes the
#: generation FAIL — the drift alarm for a new bucket in the code table.
_LEAF_LABELS = {
    # Balance sheet — assets
    "cash": "Casa și conturi la bănci (RON)",
    "cash_fx": "Casa și conturi la bănci — componenta valutară (memo sub-aggregate)",
    "ar": "Creanțe comerciale — clienți (net de ajustările 49x)",
    "ar_doubtful": "Clienți incerți (4118, brut — 491 contra)",
    "ar_intercompany": "Creanțe părți afiliate / decontări (451/452/455/461)",
    "inventory": "Stocuri (net de ajustările 39x)",
    "otherCurrentAssets": "Alte active circulante",
    "ppe": "Imobilizări corporale (net)",
    "ppe_investment": "Investiții imobiliare (215) — semnal CRE",
    "ppe_under_construction": "Imobilizări corporale în curs (231)",
    "ppe_advances": "Avansuri pentru imobilizări (4093)",
    "intangibles": "Imobilizări necorporale (net)",
    "otherNonCurrentAssets": "Imobilizări financiare și alte active imobilizate",
    # Balance sheet — liabilities
    "ap": "Datorii comerciale — furnizori (401/403/404/408)",
    "ap_dividends": "Dividende de plată (457) — NICIODATĂ în total_debt",
    "stDebt": "Credite bancare pe termen scurt",
    "otherCurrentLiab": "Alte datorii curente",
    "ltDebt": "Datorii pe termen lung (16x + leasing 167)",
    "otherNonCurrentLiab": "Alte datorii pe termen lung (151/475/478/13x)",
    # Balance sheet — equity
    "shareCapital": "Capital social",
    "retainedEarnings": "Rezultatul reportat — repartizări (129, contra)",
    "retained_earnings": "Rezultatul reportat — report (117x)",
    "otherEquity": "Alte capitaluri proprii (104/106/14x)",
    "equity_revaluation": "Rezerve din reevaluare (105)",
    # Balance sheet — derived rows (canonical_bs v2 row vocabulary; NOT
    # classification targets — the builder derives them)
    "current_year_profit": "Profitul exercițiului curent (rând derivat — rezultat)",
    "current_year_loss": "Pierderea exercițiului curent (rând derivat — rezultat)",
    "unclassified_debit": "Unclassified — debit side",
    "unclassified_credit": "Unclassified — credit side",
    # Excluded (memo/control/transit — never summed)
    "ignore_control": "121 Profit și pierdere — cont de CONTROL / ancoră de rezultat, niciodată însumat",
    "ignore_transit": "581 Viramente interne — tranzit, niciodată în cash",
    "ignore_offbalance": "Clasa 8 extrabilanțiere — memo în afara bilanțului, niciodată însumat",
    # P&L
    "revenue": "Venituri din exploatare — cifra de afaceri (70x, net de 709)",
    "cogs": "Costul bunurilor vândute (601/602/607)",
    "operatingExpenses": "Cheltuieli de exploatare",
    "opex_third_party": "Servicii executate de terți (628) — memo de anomalie",
    "depreciation": "Amortizări și provizioane (68x)",
    "otherIncome": "Alte venituri din exploatare (74x/75x/77x/78x)",
    "financial_income": "Alte venituri financiare (76x)",
    "interest_income": "Venituri din dobânzi (766)",
    "fx_gain": "Diferențe favorabile de curs valutar (765)",
    "financialExpense": "Alte cheltuieli financiare (66x)",
    "interest_expense": "Cheltuieli privind dobânzile (666)",
    "fx_loss": "Diferențe nefavorabile de curs valutar (665)",
    "taxExpense": "Impozitul pe profit (69x)",
    "capitalizedOwnWork": "Producția capitalizată (72x) — memo, EXCLUS din EBITDA",
    "inventoryVariationMemo": "Variația stocurilor (711/71x) — memo non-cash",
}

#: P&L presentation groups (parents) and which legacy P&L FIELD each
#: rule-target bucket's group derives from (_BUCKET_TO_PL_FIELD value).
_PL_GROUPS: Tuple[Tuple[str, str, Tuple[str, ...]], ...] = (
    ("pl_operating", "Rezultat din exploatare — componente",
     ("revenue", "costOfGoodsSold", "operatingExpenses",
      "depreciationAmortization", "otherIncome")),
    ("pl_financial", "Rezultat financiar — componente",
     ("financialIncome", "financialExpense", "interestExpense")),
    ("pl_tax", "Impozitul pe profit", ("taxExpense",)),
    ("pl_memo", "Linii memo statutare (excluse din EBITDA cash)",
     ("capitalizedOwnWork", "inventoryVariationMemo")),
)

#: Per-rule OMFP citations — ONLY where the in-code comment blocks carry
#: an explicit OMFP-1802 treatment for that rule. Bulk rules cite the
#: chart-of-accounts annex generally via pack.yaml legal_sources —
#: honest, not fabricated detail.
_RULE_CITATIONS = {
    "117": "OMFP 1802/2014, Planul de conturi: cont 117 — Rezultatul reportat (subconturi 1171–1175)",
    "151": "OMFP 1802/2014, formatul de bilanț: provizioanele sunt secțiune proprie, prezentate non-curent",
    "169": "OMFP 1802/2014, formatul de bilanț: obligațiuni nete de prime (ct. 161 + 1681 − 169)",
    "269": "OMFP 1802/2014, formatul de bilanț: imobilizări financiare nete (ct. 26x − 269 − 296)",
    "167": "OMFP 1802/2014: datoriile din leasing financiar se prezintă împreună cu împrumuturile pe termen lung",
    "49": "OMFP 1802/2014, Planul de conturi: grupa 49 — Ajustări pentru deprecierea creanțelor",
}

_GENERATED_BANNER = (
    "# GENERATED by scripts/port_ro_pack.py — DO NOT EDIT BY HAND.\n"
    "# 1:1 mechanical port of the in-code OMFP-1802 tables at\n"
    "# MAPPING_VERSION %s (src/engine/country_packs/ro_romania/).\n"
    "# Regenerate: python scripts/port_ro_pack.py   Drift check: --check\n"
) % FROZEN_MAPPING_VERSION


# ── Frozen-table lookups (the pre-cutover matching semantics) ──────────

#: Longest-prefix-first — the sort chart_of_accounts._RULES_SORTED used.
_FROZEN_RULES_SORTED = sorted(FROZEN_RULES, key=lambda r: -len(r.prefix))

#: Longest-prefix-first, stable — as _WRONG_SIDE_FLIPS_SORTED was.
_FROZEN_FLIPS_SORTED = sorted(
    FROZEN_BIFUNCTIONAL_WRONG_SIDE_FLIPS, key=lambda p: -len(p[0])
)


def frozen_bucket_for(code: str) -> Optional[PortRule]:
    """chart_of_accounts.bucket_for exactly as it behaved pre-cutover,
    over the frozen table (longest matching prefix wins)."""
    for rule in _FROZEN_RULES_SORTED:
        if code.startswith(rule.prefix):
            return rule
    return None


def frozen_wrong_side_flip_bucket(code: str) -> Optional[str]:
    """chart_of_accounts.wrong_side_flip_bucket exactly as it behaved
    pre-cutover: longest flip prefix matching the CODE, rule-independent."""
    for prefix, flip_bucket in _FROZEN_FLIPS_SORTED:
        if code.startswith(prefix):
            return flip_bucket
    return None


# ── Sanity assertions over the frozen + still-live tables ──────────────


def _assert_tables() -> None:
    prefixes = [r.prefix for r in FROZEN_RULES]
    if len(prefixes) != len(set(prefixes)):
        dupes = sorted({p for p in prefixes if prefixes.count(p) > 1})
        raise SystemExit("port_ro_pack: duplicate prefixes in FROZEN_RULES: %s" % dupes)
    if set(_ASSET_BS_FIELDS) - set(coa._empty_bs().keys()):
        raise SystemExit("port_ro_pack: _ASSET_BS_FIELDS drifted from _empty_bs")
    if set(_FIELD_TO_SECTION.keys()) != set(coa._empty_bs().keys()):
        raise SystemExit("port_ro_pack: _FIELD_TO_SECTION drifted from _empty_bs")
    if set(ca._RESULT_LEAF_NAMES) != {"current_year_profit", "current_year_loss"}:
        raise SystemExit("port_ro_pack: result-leaf names drifted from canonical_adapter")
    unknown_sections = set(_SECTION_LABELS) ^ set(ca._BS_V2_SECTION_ORDER)
    if unknown_sections:
        raise SystemExit(
            "port_ro_pack: section vocabulary drifted from canonical_adapter: %s"
            % sorted(unknown_sections)
        )
    # the parser flip target must be a real credit-natural BS bucket
    if _natural_side(_PARSER_FLIP_TARGET) != "credit":
        raise SystemExit(
            "port_ro_pack: parser flip target %r is not credit-natural"
            % _PARSER_FLIP_TARGET
        )


# ── side_flip derivation (see module docstring) ────────────────────────


def _natural_side(bucket: str) -> str:
    """'debit' for asset buckets, 'credit' for liability/equity buckets.
    Only BS buckets have a defined side (flips only exist there)."""
    field = coa._BUCKET_TO_BS_FIELD.get(bucket)
    if field is None:
        raise SystemExit(
            "port_ro_pack: bucket %r carries a side flip but is not a BS bucket"
            % bucket
        )
    return "debit" if field in _ASSET_BS_FIELDS else "credit"


def _flip_for_rule_prefix(prefix: str) -> Optional[Tuple[str, str]]:
    """(flip_prefix, flip_bucket) applying to EVERY code the rule with
    this prefix can match — the longest flip entry that is a prefix of
    the rule's own prefix (matching wrong_side_flip_bucket's longest-
    prefix-first semantics)."""
    candidates = [
        (f, b) for f, b in FROZEN_BIFUNCTIONAL_WRONG_SIDE_FLIPS if prefix.startswith(f)
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda fb: len(fb[0]))


def _rule_flip(rule) -> Optional[Tuple[str, str]]:
    """The single (side, line_id) flip a sign=+1 rule carries, folding
    BOTH frozen layers (parser layer first — it fired first in the
    pre-cutover engine); None when no flip applies or it would be a no-op
    (flip target == the rule's own line). The two layers must AGREE
    when both apply — anything else is not representable in pack1 (one
    side_flip per rule) and hard-fails."""
    if rule.sign != 1:
        return None
    parser_flip: Optional[Tuple[str, str]] = None
    if any(rule.prefix.startswith(p) for p in extract_parser_side_flips()):
        if rule.bucket != _PARSER_FLIP_TARGET:  # no-op families (425) skip
            parser_flip = ("credit", _PARSER_FLIP_TARGET)
    bi_flip: Optional[Tuple[str, str]] = None
    hit = _flip_for_rule_prefix(rule.prefix)
    if hit is not None:
        bi_flip = (_opposite(_natural_side(rule.bucket)), hit[1])
    if parser_flip is not None and bi_flip is not None and parser_flip != bi_flip:
        raise SystemExit(
            "port_ro_pack: rule %r carries CONFLICTING flips (parser %s vs "
            "bifunctional %s) — not representable in pack1 (one side_flip "
            "per rule)" % (rule.prefix, parser_flip, bi_flip)
        )
    return parser_flip or bi_flip


def synthesized_flip_carriers() -> List[Tuple[str, str, str, str, str]]:
    """Flip entries FINER than the rule table, from EITHER flip layer:
    (flip_prefix, winner_bucket, flip_side, flip_bucket, origin_table)
    tuples needing a synthesized rule.

    A flip prefix needs a carrier rule exactly when the frozen winner
    for that prefix (frozen_bucket_for) is a SHORTER rule — then codes inside
    the flip family classify via the shorter catchall but flip via this
    entry, which the pack cannot express on the catchall rule without
    over-flipping its other codes (e.g. '512' under the '51' catchall:
    511x/518x must NOT flip; '1687' under the '168' ltDebt rule: other
    168x accruals must NOT flip)."""
    out: List[Tuple[str, str, str, str, str]] = []
    for flip_prefix, flip_bucket in FROZEN_BIFUNCTIONAL_WRONG_SIDE_FLIPS:
        winner = frozen_bucket_for(flip_prefix)
        if winner is None:
            continue  # unreachable via code routing ('411' family)
        if len(winner.prefix) < len(flip_prefix):
            if winner.sign != 1:
                raise SystemExit(
                    "port_ro_pack: flip %r sits under contra rule %r — "
                    "not representable" % (flip_prefix, winner.prefix)
                )
            out.append((
                flip_prefix, winner.bucket,
                _opposite(_natural_side(winner.bucket)), flip_bucket,
                "BIFUNCTIONAL_WRONG_SIDE_FLIPS",
            ))
    for flip_prefix in extract_parser_side_flips():
        winner = frozen_bucket_for(flip_prefix)
        if winner is None:
            continue  # no rule (467): unmapped before the flip can fire
        if len(winner.prefix) < len(flip_prefix):
            if winner.sign != 1:
                raise SystemExit(
                    "port_ro_pack: parser flip %r sits under contra rule %r — "
                    "not representable" % (flip_prefix, winner.prefix)
                )
            if winner.bucket == _PARSER_FLIP_TARGET:
                continue  # no-op
            out.append((
                flip_prefix, winner.bucket, "credit", _PARSER_FLIP_TARGET,
                "SIDE_FLIP_TO_LIAB_PREFIXES",
            ))
    seen: Dict[str, str] = {}
    for flip_prefix, _wb, _side, _fb, origin in out:
        if flip_prefix in seen:
            raise SystemExit(
                "port_ro_pack: carrier prefix %r needed by BOTH %s and %s — "
                "one rule cannot carry two flips" % (flip_prefix,
                                                     seen[flip_prefix], origin)
            )
        seen[flip_prefix] = origin
    return out


# ── File builders ──────────────────────────────────────────────────────


def build_pack_yaml() -> str:
    notes = (
        "1:1 mechanical port of in-code MAPPING_VERSION %s at commit HEAD: "
        "chart_of_accounts._RULES (%d prefix rules) + BIFUNCTIONAL_WRONG_SIDE_FLIPS "
        "(%d side-flip families) + the parser-layer SIDE_FLIP_TO_LIAB_PREFIXES "
        "(%d credit-side re-route families from trial_balance_parser."
        "accounts_to_assemble_shape; %d flip-carrier rule(s) synthesized where "
        "either flip table is finer than the rule table) + contra semantics "
        "(sign=-1 -> contra: true) "
        "+ the D0-D9 diagnosis configuration (engine.confidence.reconciliation_checks) "
        "+ the canonical_bs v2 section/row vocabulary (canonical_adapter) + the "
        "auto-reconcile constants (0.001 gate, class-6/7 P&L placement, 'Diferențe de "
        "reconciliere' labels). Generated by scripts/port_ro_pack.py; regeneration must "
        "stay byte-identical — a diff is the drift alarm between the code tables and "
        "this pack until Phase 3 deletes the code table."
        % (
            FROZEN_MAPPING_VERSION,
            len(FROZEN_RULES),
            len(FROZEN_BIFUNCTIONAL_WRONG_SIDE_FLIPS),
            len(extract_parser_side_flips()),
            len(synthesized_flip_carriers()),
        )
    )
    shadow_fix_notes = (
        "Shadow-divergence fix (classification unchanged on the natural side; "
        "credit-side targets now match the deterministic lane): ported the "
        "parser-layer SIDE_FLIP_TO_LIAB_PREFIXES, which the original port "
        "missed — 418/451/452 gained side_flip {credit -> otherCurrentLiab}; "
        "1687 gained a flip-carrier under the '168' ltDebt winner; 425 needs "
        "none (its rule already targets otherCurrentLiab); 467 has no "
        "classification rule, so the legacy flip can never fire (rule lookup "
        "precedes the flip check) and its codes stay unmapped; 455/461 were "
        "already covered identically by the bifunctional table. Found by "
        "scripts/shadow_report.py: legacy vs pack divergences on corpus cases "
        "saga_10_col (418201), saga_10_col_agras (418), saga_10_col_carniprod "
        "(418.01), saga_10_col_realestate (451105/451805), saga_10_col_retail "
        "(4511). Known legacy path-dependence, recorded not hidden: these "
        "re-routes exist ONLY on the deterministic parser lane; the legacy "
        "LLM-accounts lane does not apply them — the pack encodes the "
        "deterministic behavior."
    )
    lines = [
        _GENERATED_BANNER,
        "schema_version: pack1",
        "jurisdiction: RO",
        "pack_id: omfp1802",
        "version: v1",
        "# OMFP 1802/2014 applies to financial years beginning 2015-01-01",
        "# (it replaced OMFP 3055/2009); no successor pack yet, window open.",
        "effective_from: 2015-01-01",
        "effective_to: null",
        "legal_sources:",
        "  - citation: %s" % q(
            "Ordinul ministrului finanțelor publice nr. 1802/2014 pentru aprobarea "
            "Reglementărilor contabile privind situațiile financiare anuale individuale "
            "și situațiile financiare anuale consolidate (M. Of. nr. 963 din 30 "
            "decembrie 2014), în vigoare de la 1 ianuarie 2015"
        ),
        "  # The chart-of-accounts annex is the GENERAL legal source for the",
        "  # classification rules; rules whose in-code comments carry an explicit",
        "  # OMFP bilanț treatment cite it inline in their description.",
        "  - citation: %s" % q(
            "OMFP 1802/2014 — Planul de conturi general (cap. 14 din Reglementările "
            "contabile aprobate prin ordin): sursa generală a regulilor de clasificare"
        ),
        "changelog:",
        "  - version: v1",
        "    date: %s" % q(PORT_DATE),
        "    notes: %s" % q(notes),
        "  - version: v1",
        "    date: %s" % q(PORT_DATE),
        "    notes: %s" % q(shadow_fix_notes),
    ]
    return "\n".join(lines) + "\n"


def _rule_lines(
    rule_id: str,
    prefix: str,
    line_id: str,
    contra: bool,
    side_flip: Optional[Tuple[str, str]],
    description: str,
) -> List[str]:
    lines = [
        "  - rule_id: %s" % q(rule_id),
        "    prefix: %s" % q(prefix),
        "    line_id: %s" % q(line_id),
    ]
    if contra:
        lines.append("    contra: true")
    if side_flip is not None:
        side, flip_line = side_flip
        lines.append("    side_flip: {side: %s, line_id: %s}" % (q(side), q(flip_line)))
    if description:
        lines.append("    description: %s" % q(description))
    return lines


def build_classification_yaml() -> str:
    lines = [
        _GENERATED_BANNER,
        "# Every rule is a PREFIX rule (the in-code table matches by",
        "# code.startswith(prefix), longest prefix first — identical to the",
        "# pack loader's fixed precedence). contra: true == in-code sign=-1",
        "# (contra lines subtract from their target: 28x/29x accumulated",
        "# depreciation, 39x/49x/59x allowances, 129, 169, 269).",
        "# side_flip folds BOTH in-code flip layers onto the winning rule:",
        "# BIFUNCTIONAL_WRONG_SIDE_FLIPS (assembler layer: a closing balance",
        "# on the side OPPOSITE the rule's natural one is a REAL position on",
        "# the other side of the balance sheet — 5121 credit = overdraft ->",
        "# stDebt, never negative cash) and the parser-layer",
        "# SIDE_FLIP_TO_LIAB_PREFIXES (deterministic lane: mixed-side",
        "# families re-route to otherCurrentLiab when closing CREDIT —",
        "# 418/451/452; 455/461 identical in both layers). Re-routed with",
        "# absolute value.",
        "rules:",
    ]
    for rule in FROZEN_RULES:
        flip = _rule_flip(rule)
        description = rule.description
        citation = _RULE_CITATIONS.get(rule.prefix)
        if citation:
            description = "%s [%s]" % (description, citation)
        lines.extend(
            _rule_lines(
                "ro.%s" % rule.prefix, rule.prefix, rule.bucket,
                rule.sign == -1, flip, description,
            )
        )
    carriers = synthesized_flip_carriers()
    if carriers:
        lines.extend([
            "",
            "  # ── FLIP-CARRIER rules synthesized from flip entries finer than",
            "  # the rule table (BIFUNCTIONAL_WRONG_SIDE_FLIPS + the parser-layer",
            "  # SIDE_FLIP_TO_LIAB_PREFIXES; see scripts/port_ro_pack.py).",
            "  # line_id is EXACTLY what the in-code shorter catchall produces, so",
            "  # classification is unchanged; only the side_flip is carried here.",
        ])
        for flip_prefix, winner_bucket, flip_side, flip_bucket, origin in carriers:
            winner = frozen_bucket_for(flip_prefix)
            description = (
                "Flip-carrier for %s (%s -> %s): codes "
                "%sx classify as %s via the in-code '%s' catchall; a closing "
                "balance on the %s side re-routes to %s."
                % (
                    origin, flip_prefix, flip_bucket, flip_prefix, winner_bucket,
                    winner.prefix, flip_side, flip_bucket,
                )
            )
            lines.extend(
                _rule_lines(
                    "ro.%s.flip-carrier" % flip_prefix, flip_prefix, winner_bucket,
                    False,
                    (flip_side, flip_bucket),
                    description,
                )
            )
    return "\n".join(lines) + "\n"


def _opposite(side: str) -> str:
    return "credit" if side == "debit" else "debit"


def build_checks_yaml() -> str:
    rc = load_reconciliation_checks_module()
    lines = [
        _GENERATED_BANNER,
        "# D0-D9 — the canonical_bs v2 diagnosis vocabulary",
        "# (docs/CANONICAL_BS_V2_CONTRACT.md). D0-D8 are emitted by",
        "# engine.confidence.reconciliation_checks.run_bs_diagnosis (bound",
        "# below via the registered builtin impl); D9 is emitted by the",
        "# canonical_bs builder itself (canonical_adapter.build_canonical_bs_v2)",
        "# whenever Unclassified rows carry value — regardless of status,",
        "# always appended after D0-D8. Params carry the in-code constants.",
        "checks:",
        "  - check_id: D0_ANCHOR_DIVERGENCE",
        "    impl: builtin.bs_diagnosis",
        "    params:",
        "      ron_tolerance: %s" % _num(rc._RON_TOLERANCE),
        "      anchor_pair_order: %s" % qlist(list(rc._ANCHOR_PAIR_ORDER)),
        "  - check_id: D1_SOURCE_IMBALANCED",
        "    impl: builtin.bs_diagnosis",
        "    params:",
        "      ron_tolerance: %s" % _num(rc._RON_TOLERANCE),
        "      anchor_pair_order: %s" % qlist(list(rc._ANCHOR_PAIR_ORDER)),
        "      detail_label_ro: %s" % q("Sursă dezechilibrată"),
        "  - check_id: D2_FINGERPRINT",
        "    impl: builtin.bs_diagnosis",
        "    params:",
        "      ron_tolerance: %s" % _num(rc._RON_TOLERANCE),
        "      # |amount| ≈ |difference| -> dropped on one side;",
        "      # |amount| ≈ |difference|/2 -> sign-flip signature.",
        "      half_difference_sign_flip: true",
        "  - check_id: D3_CONTRA_MISPLACED",
        "    impl: builtin.bs_diagnosis",
        "    params:",
        "      # Contra-asset families that belong on the asset side (as",
        "      # negatives); found inside a liability-side section = D3.",
        "      contra_prefixes: %s" % qlist(list(rc._CONTRA_PREFIXES)),
        "      asset_section_ids: %s" % qlist(sorted(rc._ASSET_SECTION_IDS)),
        "  - check_id: D4_BIFUNCTIONAL_SIDE",
        "    impl: builtin.bs_diagnosis",
        "    params:",
        "      ron_tolerance: %s" % _num(rc._RON_TOLERANCE),
        "      bifunctional_prefixes: %s" % qlist(list(rc._BIFUNCTIONAL_PREFIXES)),
        "      # 117/121 deliberately NOT flagged: a debit-side balance there",
        "      # is legitimate negative equity (losses), not misclassification.",
        "      negative_equity_exempt_prefixes: %s" % qlist(["117", "121"]),
        "  - check_id: D5_DUPLICATE_ROWS",
        "    impl: builtin.bs_diagnosis",
        "    params:",
        "      ron_tolerance: %s" % _num(rc._RON_TOLERANCE),
        "  - check_id: D6_121_MISMATCH",
        "    impl: builtin.bs_diagnosis",
        "    params:",
        "      invariant_key: p121_cross_check",
        "  - check_id: D7_MAGNITUDE",
        "    impl: builtin.bs_diagnosis",
        "    params:",
        "      ron_tolerance: %s" % _num(rc._RON_TOLERANCE),
        "      # 100x misparse leaves 0.99 x value of imbalance; 1000x leaves 0.999 x.",
        "      residual_fractions: [0.99, 0.999]",
        "  - check_id: D8_OMITTED",
        "    impl: builtin.bs_diagnosis",
        "    params:",
        "      requires_source_census: true",
        "      detail_max_listed: 20",
        "  # D9 is builder-emitted (canonical_adapter), not part of the",
        "  # run_bs_diagnosis pass — declarative, no impl ref.",
        "  - check_id: D9_UNMAPPED_INCLUDED",
        "    params:",
        "      emit_regardless_of_status: true",
        "      row_ids: %s" % qlist(["unclassified_debit", "unclassified_credit"]),
        "  # Assembled-output accounting identities (debits=credits, A=L+E,",
        "  # P&L rollups) — engine.confidence.reconciliation_checks.",
        "  # run_reconciliation_checks, with its module tolerances:",
        "  #   pct_tolerance 0.00001 == the BALANCED gate",
        "  #     (|delta| <= max(1 RON, 0.001% of base));",
        "  #   minor_drift_pct 0.005 == the MINOR_DRIFT ceiling (0.5%).",
        "  - check_id: reconciliation_identities",
        "    impl: builtin.reconciliation_identities",
        "    params:",
        "      ron_tolerance: %s" % _num(rc._RON_TOLERANCE),
        "      pct_tolerance: %s" % _num(rc._PCT_TOLERANCE),
        "      minor_drift_pct: %s" % _num(rc._MINOR_DRIFT_PCT),
        "      ebitda_rollup_tolerance_pct: 0.01",
    ]
    return "\n".join(lines) + "\n"


def _num(value: float) -> str:
    """Deterministic YAML 1.1-safe number. repr() is shortest-roundtrip,
    but PyYAML's float resolver does NOT accept bare scientific notation
    ('1e-05' loads as a STRING — the mantissa needs a dot), so values
    repr'd in e-notation are expanded to plain decimals instead."""
    text = repr(value)
    if "e" in text or "E" in text:
        text = format(value, ".17f").rstrip("0")
        if text.endswith("."):
            text += "0"
    return text


def _bs_leaves_by_section() -> Dict[str, List[str]]:
    """Rule-target BS buckets grouped by canonical section, ordered by
    _BUCKET_TO_BS_FIELD declaration order (the in-code presentation
    order)."""
    targets = {r.bucket for r in FROZEN_RULES}
    by_section: Dict[str, List[str]] = {s: [] for s in ca._BS_V2_SECTION_ORDER}
    for bucket, field in coa._BUCKET_TO_BS_FIELD.items():
        if bucket not in targets:
            continue  # e.g. ar_provisions: mapped field, no in-code rule
        by_section[_FIELD_TO_SECTION[field]].append(bucket)
    return by_section


def build_statement_map_yaml() -> str:
    by_section = _bs_leaves_by_section()
    # Derived rows land where build_canonical_bs_v2 places them.
    derived = {
        "current_assets": ["unclassified_debit"],
        "equity": ["current_year_profit", "current_year_loss"],
        "current_liabilities": ["unclassified_credit"],
    }
    lines = [
        _GENERATED_BANNER,
        "# Tree = the canonical_bs v2 SECTION vocabulary (canonical_adapter.",
        "# _BS_V2_SECTION_ORDER — the OMFP 1802 bilanț sections) with the",
        "# in-code _RULES bucket ids as classifiable leaves, placed per",
        "# _BUCKET_TO_BS_FIELD side/section. Derived rows of the row",
        "# vocabulary (current_year_profit/current_year_loss result rows,",
        "# unclassified_debit/unclassified_credit closing-identity rows) are",
        "# leaves no rule targets — the builder derives them. Sections with",
        "# no leaves at this vintage stay for vocabulary fidelity: the legacy",
        "# bucket table folds their accounts into coarser leaves (471",
        "# prepaids -> otherCurrentAssets; 151 provisions ->",
        "# otherNonCurrentLiab; 472/475/478 deferred income ->",
        "# otherCurrentLiab / otherNonCurrentLiab).",
        "statements:",
        "  balance_sheet:",
    ]
    for section in ca._BS_V2_SECTION_ORDER:
        leaves = by_section[section] + derived.get(section, [])
        lines.append("    - id: %s" % section)
        lines.append("      label: %s" % q(_SECTION_LABELS[section]))
        if leaves:
            lines.append("      children:")
            for leaf in leaves:
                lines.append("        - id: %s" % leaf)
                lines.append("          label: %s" % q(_LEAF_LABELS[leaf]))
    lines.extend([
        "    # NOT a bilanț section: the contract's `excluded` vocabulary.",
        "    # These leaves claim accounts explicitly so they can NEVER fall",
        "    # through to a catchall or the semantic-name fallback — and are",
        "    # NEVER summed into any statement total.",
        "    - id: excluded",
        "      label: %s" % q(
            "Excluse din situații — conturi de control / tranzit / extrabilanțiere "
            "(niciodată însumate)"
        ),
        "      children:",
    ])
    for leaf in ("ignore_control", "ignore_transit", "ignore_offbalance"):
        lines.append("        - id: %s" % leaf)
        lines.append("          label: %s" % q(_LEAF_LABELS[leaf]))
    lines.append("  profit_loss:")
    pl_targets = {r.bucket for r in FROZEN_RULES}
    for group_id, group_label, fields in _PL_GROUPS:
        leaves = [
            bucket for bucket, field in coa._BUCKET_TO_PL_FIELD.items()
            if bucket in pl_targets and field in fields
        ]
        lines.append("    - id: %s" % group_id)
        lines.append("      label: %s" % q(group_label))
        lines.append("      children:")
        for leaf in leaves:
            lines.append("        - id: %s" % leaf)
            lines.append("          label: %s" % q(_LEAF_LABELS[leaf]))
    return "\n".join(lines) + "\n"


def build_reconcile_yaml() -> str:
    consts = extract_reconcile_constants()
    gate = 1.0 / int(consts["gate_multiplier"])
    label = consts["synthetic_row_label"]
    lines = [
        _GENERATED_BANNER,
        "# Auto-reconcile policy (docs/CANONICAL_BS_V2_CONTRACT.md,",
        "# AUTO-RECONCILE addendum; engine.api._reconcile constants).",
        "#",
        "# threshold: offer/accept only while |difference| / max(assets,",
        "# equity_plus_liabilities) <= 0.001 (0.1%) — in-code the exact-cents",
        "# gate _GATE_MULTIPLIER = %s. Above it: a human. Exactly 0: BALANCED." % consts["gate_multiplier"],
        "threshold: %s" % _num(gate),
        "# Placement (engine.api._reconcile._placement_for): a diagnosed",
        "# cause naming a class 6/7 account routes the visible line to the",
        "# P&L by the DELTA'S SIGN (difference > 0 -> other income, < 0 ->",
        "# other expense), reaching the BS through the result row",
        "# (current_year_profit / current_year_loss). Every other cause",
        "# (rounding cents, BS-account fingerprints, row ids, no named",
        "# account) is a balance-sheet line: the synthetic row %s." % consts["synthetic_row_id"],
        "placement_rules:",
        "  - cause: class_67_target_delta_positive",
        "    placement: %s" % consts["placement_detail_pl_income"],
        "  - cause: class_67_target_delta_negative",
        "    placement: %s" % consts["placement_detail_pl_expense"],
        "  - cause: default",
        "    placement: %s" % consts["placement_detail_bs"],
        "# One visible adjustment line. The engine serves the statutory",
        "# Romanian label VERBATIM in every language (SYNTHETIC_ROW_LABEL;",
        "# the FE i18n keeps it untranslated in EN too), so ro and en carry",
        "# the same value on purpose.",
        "adjustment_labels:",
        "  ro: %s" % q(label),
        "  en: %s" % q(label),
    ]
    return "\n".join(lines) + "\n"


# ── Generation / check drivers ─────────────────────────────────────────


def generate() -> Dict[str, str]:
    """All five pack files as {filename: content}."""
    _assert_tables()
    return {
        "pack.yaml": build_pack_yaml(),
        "classification.yaml": build_classification_yaml(),
        "checks.yaml": build_checks_yaml(),
        "statement_map.yaml": build_statement_map_yaml(),
        "reconcile.yaml": build_reconcile_yaml(),
    }


def write_pack(out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    for name, content in generate().items():
        (out_dir / name).write_text(content, encoding="utf-8")


def self_check(out_dir: Path) -> int:
    """Load + lint the emitted pack; print the summary. 0 on clean."""
    from engine.packs.lint import lint_pack

    report = lint_pack(out_dir)
    if report.findings:
        print(report.render())
        return 1
    pack = next(iter(report.packs.values()))
    print(
        "port_ro_pack: %s@%s — %d rules (%d contra, %d side-flip), "
        "%d checks, %d statement lines\npack_hash: %s"
        % (
            pack.identity.pack_id, pack.identity.version,
            len(pack.rules),
            sum(1 for r in pack.rules if r.contra),
            sum(1 for r in pack.rules if r.side_flip is not None),
            len(pack.checks),
            len(pack.statement_line_ids()),
            pack.pack_hash,
        )
    )
    return 0


def check_against(target_dir: Path) -> int:
    """Byte-compare a fresh generation with the checked-in pack."""
    fresh = generate()
    drift = False
    for name in PACK_FILE_NAMES:
        on_disk_path = target_dir / name
        if not on_disk_path.is_file():
            print("DRIFT %s: missing from %s" % (name, target_dir))
            drift = True
            continue
        on_disk = on_disk_path.read_text(encoding="utf-8")
        if on_disk != fresh[name]:
            drift = True
            diff = difflib.unified_diff(
                on_disk.splitlines(keepends=True),
                fresh[name].splitlines(keepends=True),
                fromfile="checked-in/%s" % name,
                tofile="regenerated/%s" % name,
            )
            print("DRIFT %s:" % name)
            sys.stdout.writelines(list(diff)[:80])
    if drift:
        print(
            "port_ro_pack --check: the checked-in v1 pack no longer matches "
            "the FROZEN port snapshot (+ the still-live engine constants it "
            "mirrors). v1 is immutable — revert the YAML edit and cut a NEW "
            "pack version instead; if a live engine constant changed, that "
            "change likewise demands a deliberate new pack version."
        )
        return 1
    print("port_ro_pack --check: clean — pack matches the frozen port snapshot.")
    return 0


def main(argv: Sequence[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="port_ro_pack.py",
        description=(
            "Regenerate packs/ro/omfp1802-v1/ from the FROZEN port snapshot "
            "(--check: verify the checked-in pack matches it byte-for-byte)."
        ),
    )
    parser.add_argument(
        "--out", metavar="DIR", default=str(DEFAULT_OUT),
        help="output pack directory (default: %s)" % DEFAULT_OUT,
    )
    parser.add_argument(
        "--check", action="store_true",
        help="regenerate in memory and byte-diff against --out; exit 1 on drift",
    )
    args = parser.parse_args(list(argv))
    out_dir = Path(args.out)
    if args.check:
        return check_against(out_dir)
    write_pack(out_dir)
    rc = self_check(out_dir)
    if rc == 0:
        print("wrote %s" % out_dir)
    return rc


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 — CLI boundary
        print("port_ro_pack: internal error: %s" % exc, file=sys.stderr)
        sys.exit(2)
