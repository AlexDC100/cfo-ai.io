#!/usr/bin/env python3
"""port_hu_pack.py — the FROZEN port source of packs/hu/actc2000-v1/ and
packs/intl/ifrs-captions-v1/.

DIRECTION OF TRUTH (Phase 4 cutover, 2026-08-20): the pack YAML under
packs/hu/actc2000-v1/ and packs/intl/ifrs-captions-v1/ is the RUNTIME
SOURCE OF TRUTH for the AI lane's classify stage — the HU chart-logic
block, the IFRS-captions guidance and the canonical line vocabulary all
render from the resolved CompiledPack (engine.ai_lane.classify), and the
classify prompt_version derives from the pack content hash
(engine.ai_lane.config.classify_prompt_version). The in-code sources —
engine.country_packs.hu_hungary.classification_map (HU_CLASS_MAP +
HU_NOTABLE_ACCOUNTS + classify_prompt_block) and the hardcoded
jurisdiction/vocabulary prompt blocks in engine.ai_lane.classify — are
DELETED as runtime sources; they live on ONLY as the FROZEN snapshot
below (FROZEN_HU_* / FROZEN_INTL_GUIDANCE), exactly as they stood at the
cutover. This mirrors the Phase-3 RO cutover (scripts/port_ro_pack.py).

WHAT EACH PACK CARRIES

  packs/hu/actc2000-v1/
    pack.yaml            identity: HU / actc2000 / v1, Act C of 2000
                         legal sources, effective from 2001-01-01
    classification.yaml  the 21 FROZEN_HU_NOTABLE_ACCOUNTS as exact
                         rules (code -> canonical line, gloss verbatim
                         as description — the prompt's "Notable
                         accounts" lines render from these) + the
                         prompt_guidance section (header prose, the
                         10-class FROZEN_HU_CLASS_MAP, footer prose)
    statement_map.yaml   the canonical statement-line vocabulary
                         (engine.canonical BS_BUCKETS + PL_BUCKETS —
                         LIVE read, so a schema change trips --check)
                         grouped by the schema's own section lists,
                         plus the `excluded` section carrying
                         excluded_control
    checks.yaml          the SAME D0-D9 + reconciliation-identities
                         configuration the RO pack mirrors — the
                         canonical_bs v2 diagnosis machinery is
                         jurisdiction-neutral engine logic that runs on
                         AI-lane envelopes too (LIVE reads of
                         engine.confidence.reconciliation_checks)
    reconcile.yaml       the auto-reconcile constants (LIVE reads of
                         engine.api._reconcile — the serve path runs on
                         AI-lane envelopes unchanged)

  packs/intl/ifrs-captions-v1/
    same five files; classification.yaml carries ZERO code rules (IFRS
    documents have arbitrary code schemes — classification is by
    account-name meaning) and the one-paragraph FROZEN_INTL_GUIDANCE as
    prompt_guidance.header.

Neither generated pack includes confirmed_mappings.yaml — that overlay
is OPERATOR-OWNED (human-confirmed code -> line memoizations, loaded by
engine.packs.loader at highest precedence and covered by pack_hash); the
generator never writes or checks it.

--check is the PACK-VS-FROZEN-SNAPSHOT gate: regeneration must stay
byte-identical to the checked-in v1 packs
(tests/engine/test_hu_pack.py::test_regeneration_is_byte_identical), so
pack_hash cannot drift silently — and with it the derived classify
prompt_version ('classify_hu@<hash12>' / 'classify_intl@<hash12>' for
any non-v1 content; the exact v1 hashes alias to the frozen
'classify_v1' in engine.ai_lane.config so stored envelopes and the
golden corpus stay byte-stable). Any deliberate change is a NEW pack
version (new directory, new effective window) — this script is never
edited to "update" v1.

USAGE
  python scripts/port_hu_pack.py                    # (re)write both packs
  python scripts/port_hu_pack.py --out-hu DIR --out-intl DIR
  python scripts/port_hu_pack.py --check            # byte-diff both packs
                                                    # against the checked-in
                                                    # versions; exit 1 on drift

EXIT CODES: 0 = written (or --check clean), 1 = --check drift or
self-check failure, 2 = internal/usage error.
"""
from __future__ import annotations

import argparse
import difflib
import importlib.util
import json
import sys
import tempfile
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

# ── Repo-root + sys.path setup — independent of cwd (same pattern as
# scripts/port_ro_pack.py) ──────────────────────────────────────────────


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

# Still-LIVE engine reads (post-cutover): the canonical statement-line
# schema (engine.canonical.schema_v1) — the classify vocabulary IS that
# schema, so the statement maps regenerate from it and any schema change
# trips --check, forcing a deliberate new pack version. The HU chart
# logic and the INTL guidance are NOT imported — they no longer exist in
# the engine; the frozen copies below are the historical port source.
from engine.canonical import schema_v1 as _schema  # noqa: E402

#: Default output directories (the checked-in packs).
DEFAULT_OUT_HU = REPO / "packs" / "hu" / "actc2000-v1"
DEFAULT_OUT_INTL = REPO / "packs" / "intl" / "ifrs-captions-v1"

#: Emitted file order (mirrors engine.packs.loader.PACK_FILES).
PACK_FILE_NAMES = (
    "pack.yaml",
    "classification.yaml",
    "checks.yaml",
    "statement_map.yaml",
    "reconcile.yaml",
)

#: Port date — fixed so regeneration stays byte-identical.
PORT_DATE = "2026-08-20"


# ── THE FROZEN PORT SOURCE (Phase 4 cutover, 2026-08-20) ───────────────
# The in-code prompt data exactly as it stood when the packs were cut.
# These are HISTORY, not configuration: the running engine reads the
# pack YAML; editing these constants can only make --check fail.

#: engine.country_packs.hu_hungary.classification_map.HU_CLASS_MAP at
#: the cutover — class digit -> (Hungarian name, routing guidance),
#: VERBATIM including diacritics and em-dashes.
FROZEN_HU_CLASS_MAP: Dict[str, Tuple[str, str]] = {
    "1": (
        "Befektetett eszközök",
        "non-current assets: intangibles (11x), property/plant/equipment "
        "(12x-14x incl. accumulated depreciation on 129/139/149 credit "
        "side), investments in progress (16x), long-term financial assets "
        "(17x-19x)",
    ),
    "2": (
        "Készletek",
        "inventories: raw materials (21x-22x), work in progress (23x), "
        "finished goods (25x), goods for resale (26x-28x), advances on "
        "inventories ((26)8x/28x per chart)",
    ),
    "3": (
        "Követelések, pénzügyi eszközök és aktív időbeli elhatárolások",
        "current assets: trade receivables (31x), receivables from "
        "employees/other (36x), securities (37x), CASH AND BANK (38x: 381 "
        "pénztár = petty cash, 384 elszámolási betétszámla = bank "
        "account), deferred/accrued assets (39x). 368/466 VAT recoverable "
        "is an asset-side tax receivable.",
    ),
    "4": (
        "Források",
        "equity and liabilities: equity (41x: 411 jegyzett tőke = share "
        "capital, 412 tőketartalék = share premium, 413 eredménytartalék "
        "= retained earnings, 414 lekötött tartalék, 417/419 mérleg "
        "szerinti / adózott eredmény = current-year result), provisions "
        "(42x), subordinated + long-term liabilities (43x-44x), trade "
        "payables (454-455 szállítók), other short-term liabilities "
        "(46x-47x incl. 467 fizetendő áfa = VAT payable, 462 personnel, "
        "463-464 tax authorities), passive accruals (48x), and 49x "
        "technical opening/closing accounts (491 nyitómérleg számla — "
        "CONTROL, exclude from the statement).",
    ),
    "5": (
        "Költségnemek",
        "costs by nature (P&L expense side in a pre-closing TB): material "
        "costs (51x), services (52x-53x), payroll (54x), social "
        "contributions (56x), depreciation (57x), capitalized own "
        "performance offsets (58x), cost reallocations (59x)",
    ),
    "6": (
        "Költséghelyek (opcionális)",
        "OPTIONAL management-accounting cost centres — technical mirror "
        "of class 5; normally excluded as control accounts",
    ),
    "7": (
        "Költségviselők (opcionális)",
        "OPTIONAL management-accounting cost bearers — technical mirror "
        "of class 5; normally excluded as control accounts",
    ),
    "8": (
        "Ráfordítások",
        "expenses: cost of goods sold / own performance (81x-83x when the "
        "entity books by cost-of-sales method), other expenses (86x), "
        "financial expenses (87x), extraordinary/tax items (88x-89x incl. "
        "891 társasági adó = income tax)",
    ),
    "9": (
        "Bevételek",
        "revenues: net sales domestic/export (91x-92x), other operating "
        "income (96x), financial income (97x), extraordinary income (98x)",
    ),
    "0": (
        "Nyilvántartási számlák",
        "off-balance memo accounts — exclude from the statement",
    ),
}

#: classification_map.HU_NOTABLE_ACCOUNTS at the cutover — code ->
#: short English gloss, VERBATIM.
FROZEN_HU_NOTABLE_ACCOUNTS: Dict[str, str] = {
    "113": "concessions and similar rights (intangible asset)",
    "114": "intellectual property (intangible asset)",
    "123": "buildings (PP&E)",
    "131": "technical machinery and equipment (PP&E)",
    "211": "raw materials (inventory)",
    "251": "finished goods (inventory)",
    "261": "goods for resale (inventory)",
    "311": "domestic trade receivables (vevők)",
    "381": "petty cash (pénztár)",
    "384": "bank current account (elszámolási betétszámla)",
    "411": "share capital (jegyzett tőke)",
    "412": "share premium / capital reserve (tőketartalék)",
    "413": "retained earnings (eredménytartalék)",
    "419": "current-year after-tax result (adózott/mérleg szerinti eredmény)",
    "454": "domestic trade payables (szállítók)",
    "462": "personnel payables",
    "466": "input VAT recoverable (előzetesen felszámított áfa) — asset",
    "467": "output VAT payable (fizetendő áfa) — liability",
    "491": "opening balance sheet account (nyitómérleg) — control, exclude",
    "811": "material-type expenses (anyagjellegű ráfordítások)",
    "911": "net domestic sales revenue (belföldi értékesítés árbevétele)",
}

#: The canonical statement line each notable account pins to — the
#: line_id half of the exact rule (the gloss above names the target;
#: several are additionally confirmed by the hu_ai_lane golden corpus
#: mock, which classifies 114/123/211/311/381/384/411/413/454/466/467/
#: 811/911 to exactly these lines). Part of the FROZEN port decision.
FROZEN_HU_NOTABLE_LINE_IDS: Dict[str, str] = {
    "113": "intangibles_other",
    "114": "intangibles_other",
    "123": "ppe_buildings",
    "131": "ppe_machinery_equipment",
    "211": "inventory_raw_materials",
    "251": "inventory_finished_goods",
    "261": "inventory_merchandise_resale",
    "311": "ar_trade_gross",
    "381": "cash_operating",
    "384": "cash_operating",
    "411": "share_capital",
    "412": "share_premium",
    "413": "retained_earnings_prior_years",
    "419": "current_year_profit",
    "454": "ap_trade",
    "462": "ap_personnel_other",
    "466": "ar_tax_recoverable",
    "467": "ap_tax",
    "491": "excluded_control",
    "811": "cogs_raw_materials",
    "911": "revenue_products",
}

#: classify_prompt_block()'s frame text at the cutover, VERBATIM.
FROZEN_HU_PROMPT_HEADER = (
    "HUNGARIAN CHART LOGIC (számlatükör, Act C of 2000). The FIRST "
    "DIGIT of each account code names its class:"
)
FROZEN_HU_PROMPT_FOOTER = (
    "Classes 6/7 (management accounting), 49x opening/closing and "
    "class 0 memo accounts must be classified as `excluded_control`."
)

#: engine.ai_lane.classify._jurisdiction_block's non-HU branch at the
#: cutover, VERBATIM — the whole INTL guidance is this one paragraph.
FROZEN_INTL_GUIDANCE = (
    "INTERNATIONAL (IFRS-style) DOCUMENT. Codes may be arbitrary — "
    "classify by the account NAME's economic meaning using IFRS "
    "statement captions (IAS 1 / IAS 7). Suspense or clearing "
    "accounts are `excluded_control`."
)

#: engine.ai_lane.classify's excluded_control prompt wording at the
#: cutover — becomes the excluded leaf's label so the vocabulary block
#: renders byte-identically from the pack.
FROZEN_EXCLUDED_CONTROL_LABEL = (
    "control/technical/closing account, keep OUT of the statement"
)


# ── Legacy prompt-block reconstruction (parity-test oracles) ────────────


def legacy_hu_prompt_block() -> str:
    """classification_map.classify_prompt_block() exactly as it rendered
    pre-cutover, reconstructed from the frozen tables."""
    lines = [FROZEN_HU_PROMPT_HEADER]
    for digit in sorted(FROZEN_HU_CLASS_MAP):
        name, guidance = FROZEN_HU_CLASS_MAP[digit]
        lines.append("  class %s — %s: %s" % (digit, name, guidance))
    lines.append("Notable accounts:")
    for code in sorted(FROZEN_HU_NOTABLE_ACCOUNTS):
        lines.append("  %s = %s" % (code, FROZEN_HU_NOTABLE_ACCOUNTS[code]))
    lines.append(FROZEN_HU_PROMPT_FOOTER)
    return "\n".join(lines)


def legacy_intl_prompt_block() -> str:
    return FROZEN_INTL_GUIDANCE


def legacy_vocabulary_block() -> str:
    """engine.ai_lane.classify._vocabulary_block() exactly as it
    rendered pre-cutover — over the LIVE canonical schema (the live half
    was never jurisdiction data; a schema change legitimately changes
    the vocabulary and trips --check via the statement map)."""
    lines: List[str] = ["CANONICAL LINE VOCABULARY (line_id — label — side):"]
    for b in _schema.BS_BUCKETS:
        lines.append("  %s — %s — %s" % (b.canonical_name, b.display_label,
                                         b.bucket_type.value))
    for b in _schema.PL_BUCKETS:
        lines.append("  %s — %s — %s" % (b.canonical_name, b.display_label,
                                         b.bucket_type.value))
    lines.append(
        "  excluded_control — %s — excluded" % FROZEN_EXCLUDED_CONTROL_LABEL
    )
    return "\n".join(lines)


# ── Reuse of the RO porter's live-constant readers ──────────────────────


def _ro_porter():
    """scripts/port_ro_pack.py loaded by file path (scripts/ is not a
    package). Reused pieces: load_reconciliation_checks_module() and
    extract_reconcile_constants() — the SAME live engine constants both
    generators mirror, so the drift alarm stays single-sourced."""
    name = "_port_ro_pack_for_hu_port"
    cached = sys.modules.get(name)
    if cached is not None:
        return cached
    path = REPO / "scripts" / "port_ro_pack.py"
    spec = importlib.util.spec_from_file_location(name, str(path))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


# ── YAML emission helpers (hand-built text: deterministic formatting,
# comments preserved — yaml.dump can do neither) ───────────────────────


def q(value: str) -> str:
    """Double-quoted YAML scalar via JSON escaping (ensure_ascii=False
    keeps Hungarian diacritics and em-dashes literal)."""
    return json.dumps(value, ensure_ascii=False)


def qlist(values: Sequence[str]) -> str:
    return "[" + ", ".join(q(v) for v in values) + "]"


def _num(value: float) -> str:
    """Deterministic YAML 1.1-safe number (see port_ro_pack._num)."""
    text = repr(value)
    if "e" in text or "E" in text:
        text = format(value, ".17f").rstrip("0")
        if text.endswith("."):
            text += "0"
    return text


_GENERATED_BANNER = (
    "# GENERATED by scripts/port_hu_pack.py — DO NOT EDIT BY HAND.\n"
    "# 1:1 mechanical port of the AI-lane classify prompt data at the\n"
    "# Phase-4 cutover (engine.country_packs.hu_hungary.classification_map\n"
    "# + the jurisdiction/vocabulary blocks of engine.ai_lane.classify).\n"
    "# Regenerate: python scripts/port_hu_pack.py   Drift check: --check\n"
)


# ── Statement-map source: the canonical schema's own group lists ───────

#: (section_id, section_label, schema group list) — balance sheet. The
#: concatenation of the group lists MUST equal BS_BUCKETS (asserted), so
#: document order in the pack == schema order == the pre-cutover
#: vocabulary-block order.
_BS_SECTIONS: Tuple[Tuple[str, str, str], ...] = (
    ("current_assets", "Current assets", "_BS_CURRENT_ASSETS"),
    ("non_current_assets", "Non-current assets", "_BS_NON_CURRENT_ASSETS"),
    ("current_liabilities", "Current liabilities", "_BS_CURRENT_LIABILITIES"),
    ("non_current_liabilities", "Non-current liabilities",
     "_BS_NON_CURRENT_LIABILITIES"),
    ("equity", "Equity", "_BS_EQUITY"),
)

#: (section_id, section_label, schema group list) — profit & loss.
_PL_SECTIONS: Tuple[Tuple[str, str, str], ...] = (
    ("pl_revenue", "Revenue", "_PL_REVENUE"),
    ("pl_cogs", "Cost of goods sold", "_PL_COGS"),
    ("pl_opex", "Operating expenses (by nature)", "_PL_OPEX"),
    ("pl_personnel", "Personnel costs", "_PL_PERSONNEL"),
    ("pl_dap", "Depreciation, amortization, impairments and provisions",
     "_PL_DAP"),
    ("pl_other_operating", "Other operating income (incl. statutory memo lines)",
     "_PL_OTHER_OP_INCOME"),
    ("pl_financial", "Financial result — components", "_PL_FINANCIAL"),
    ("pl_tax", "Income tax", "_PL_TAX"),
)

_EXCLUDED_SECTION_LABEL = (
    "Excluded from statements — control / technical / memo accounts "
    "(never summed)"
)


def _assert_tables() -> None:
    """Drift alarms over the frozen tables + the live schema reads."""
    if set(FROZEN_HU_NOTABLE_LINE_IDS) != set(FROZEN_HU_NOTABLE_ACCOUNTS):
        raise SystemExit(
            "port_hu_pack: FROZEN_HU_NOTABLE_LINE_IDS keys drifted from "
            "FROZEN_HU_NOTABLE_ACCOUNTS"
        )
    if sorted(FROZEN_HU_CLASS_MAP) != [str(d) for d in range(10)]:
        raise SystemExit("port_hu_pack: FROZEN_HU_CLASS_MAP must cover digits 0-9")
    # Live schema group lists must tile BS_BUCKETS / PL_BUCKETS exactly —
    # the pack's document order IS the schema order (prompt byte-parity).
    bs_concat = [b.canonical_name
                 for _sid, _lbl, attr in _BS_SECTIONS
                 for b in getattr(_schema, attr)]
    if bs_concat != [b.canonical_name for b in _schema.BS_BUCKETS]:
        raise SystemExit(
            "port_hu_pack: _BS_SECTIONS no longer tile engine.canonical."
            "BS_BUCKETS — the schema grouping changed; cut a new pack version"
        )
    pl_concat = [b.canonical_name
                 for _sid, _lbl, attr in _PL_SECTIONS
                 for b in getattr(_schema, attr)]
    if pl_concat != [b.canonical_name for b in _schema.PL_BUCKETS]:
        raise SystemExit(
            "port_hu_pack: _PL_SECTIONS no longer tile engine.canonical."
            "PL_BUCKETS — the schema grouping changed; cut a new pack version"
        )
    # Every notable line_id must be a canonical leaf (or excluded_control).
    leaf_ids = {b.canonical_name
                for b in list(_schema.BS_BUCKETS) + list(_schema.PL_BUCKETS)}
    for code, line_id in sorted(FROZEN_HU_NOTABLE_LINE_IDS.items()):
        if line_id != "excluded_control" and line_id not in leaf_ids:
            raise SystemExit(
                "port_hu_pack: notable %s targets %r — not a canonical leaf"
                % (code, line_id)
            )


# ── File builders ──────────────────────────────────────────────────────


def build_hu_pack_yaml() -> str:
    notes = (
        "1:1 mechanical port of engine.country_packs.hu_hungary."
        "classification_map at the Phase-4 cutover: HU_CLASS_MAP (%d account "
        "classes, Act C of 2000 számlatükör structure) rendered as "
        "prompt_guidance.class_map, HU_NOTABLE_ACCOUNTS (%d accounts) as exact "
        "rules (gloss verbatim as description; line_id pins the canonical "
        "statement line the gloss names), the classify_prompt_block frame text "
        "as prompt_guidance header/footer, + the canonical statement-line "
        "vocabulary (engine.canonical BS_BUCKETS/PL_BUCKETS) as the statement "
        "map, + the D0-D9 diagnosis configuration and auto-reconcile constants "
        "(jurisdiction-neutral engine machinery that runs on AI-lane envelopes "
        "— mirrored from the same live constants the RO pack mirrors). "
        "Generated by scripts/port_hu_pack.py; regeneration must stay "
        "byte-identical (--check). The AI-lane classify prompt renders from "
        "this pack, and the classify prompt_version derives from its content "
        "hash — this exact v1 content aliases to the frozen 'classify_v1' "
        "(engine.ai_lane.config), so stored envelopes and the golden corpus "
        "stay byte-stable; ANY content change re-versions the prompt and "
        "invalidates the AI cache."
        % (len(FROZEN_HU_CLASS_MAP), len(FROZEN_HU_NOTABLE_ACCOUNTS))
    )
    lines = [
        _GENERATED_BANNER,
        "schema_version: pack1",
        "jurisdiction: HU",
        "pack_id: actc2000",
        "version: v1",
        "# Act C of 2000 on Accounting (2000. évi C. törvény a számvitelről)",
        "# entered into force on 2001-01-01; no successor pack, window open.",
        "effective_from: 2001-01-01",
        "effective_to: null",
        "legal_sources:",
        "  - citation: %s" % q(
            "2000. évi C. törvény a számvitelről (Act C of 2000 on Accounting), "
            "hatályos 2001. január 1-jétől — in force from 1 January 2001"
        ),
        "  # The uniform chart-of-accounts frame (egységes számlakeret) is the",
        "  # general legal source of the class structure the prompt_guidance",
        "  # class_map encodes; the in-code map carried the Act citation",
        "  # generally (no per-rule section citations), so rules cite nothing",
        "  # finer — honest, not fabricated detail.",
        "  - citation: %s" % q(
            "Act C of 2000, §§ 160–161: az egységes számlakeret és a számlarend "
            "— the uniform chart-of-accounts frame (classes 1–4 balance sheet, "
            "5 costs by nature, 6–7 optional management accounting, 8 expenses, "
            "9 revenues, 0 off-balance memo)"
        ),
        "changelog:",
        "  - version: v1",
        "    date: %s" % q(PORT_DATE),
        "    notes: %s" % q(notes),
    ]
    return "\n".join(lines) + "\n"


def build_intl_pack_yaml() -> str:
    notes = (
        "1:1 mechanical port of engine.ai_lane.classify's international "
        "(IFRS-style) prompt data at the Phase-4 cutover: the one-paragraph "
        "jurisdiction guidance as prompt_guidance.header (verbatim) and the "
        "canonical statement-line vocabulary (engine.canonical BS_BUCKETS/"
        "PL_BUCKETS — the IFRS-caption list the classify prompt offers) as "
        "the statement map. No account-code rules: IFRS documents carry "
        "arbitrary code schemes, classification is by account-name meaning "
        "(LLM), memoizable per document family via a confirmed_mappings.yaml "
        "overlay. checks/reconcile mirror the same jurisdiction-neutral "
        "engine constants the RO and HU packs mirror. Generated by "
        "scripts/port_hu_pack.py; regeneration must stay byte-identical "
        "(--check). The classify prompt_version derives from this pack's "
        "content hash — this exact v1 content aliases to the frozen "
        "'classify_v1' (engine.ai_lane.config); ANY content change "
        "re-versions the prompt and invalidates the AI cache."
    )
    lines = [
        _GENERATED_BANNER,
        "schema_version: pack1",
        "jurisdiction: INTL",
        "pack_id: ifrs-captions",
        "version: v1",
        "# IFRS caption guidance (IAS 1 / IAS 7). Window opens with EU-wide",
        "# IFRS adoption (Regulation (EC) No 1606/2002 — IAS/IFRS apply from",
        "# financial years starting in 2005). The AI lane resolves the LATEST",
        "# window (no period_end threading), so the start date only gates",
        "# hypothetical effective-dated resolves.",
        "effective_from: 2005-01-01",
        "effective_to: null",
        "legal_sources:",
        "  - citation: %s" % q(
            "IAS 1 Presentation of Financial Statements (IASB) — the statement "
            "caption vocabulary the classify guidance names"
        ),
        "  - citation: %s" % q(
            "IAS 7 Statement of Cash Flows (IASB)"
        ),
        "changelog:",
        "  - version: v1",
        "    date: %s" % q(PORT_DATE),
        "    notes: %s" % q(notes),
    ]
    return "\n".join(lines) + "\n"


def build_hu_classification_yaml() -> str:
    lines = [
        _GENERATED_BANNER,
        "# HU classification is LLM-DRIVEN (engine.ai_lane.classify): these",
        "# rules are the prompt's classification vocabulary data, not a",
        "# deterministic parser. Each exact rule is one \"Notable accounts\"",
        "# prompt line — `<code> = <description>` renders verbatim — with",
        "# line_id pinning the canonical statement line the gloss names",
        "# (several pinned additionally by the hu_ai_lane golden corpus",
        "# mock). prompt_guidance carries the Act C of 2000 class structure",
        "# the prompt renders between its header and footer. An OPTIONAL",
        "# operator-owned confirmed_mappings.yaml overlay (never generated,",
        "# never --check'd) adds human-confirmed exact mappings at highest",
        "# precedence; every overlay entry renders into the prompt as a",
        "# further notable line and re-versions the pack content hash.",
        "rules:",
    ]
    for code in sorted(FROZEN_HU_NOTABLE_ACCOUNTS):
        lines.extend([
            "  - rule_id: %s" % q("hu.%s" % code),
            "    exact: %s" % q(code),
            "    line_id: %s" % q(FROZEN_HU_NOTABLE_LINE_IDS[code]),
            "    description: %s" % q(FROZEN_HU_NOTABLE_ACCOUNTS[code]),
        ])
    lines.extend([
        "",
        "prompt_guidance:",
        "  header: %s" % q(FROZEN_HU_PROMPT_HEADER),
        "  class_map:",
    ])
    for digit in sorted(FROZEN_HU_CLASS_MAP):
        name, guidance = FROZEN_HU_CLASS_MAP[digit]
        lines.extend([
            "    - digit: %s" % q(digit),
            "      name: %s" % q(name),
            "      guidance: %s" % q(guidance),
        ])
    lines.append("  footer: %s" % q(FROZEN_HU_PROMPT_FOOTER))
    return "\n".join(lines) + "\n"


def build_intl_classification_yaml() -> str:
    lines = [
        _GENERATED_BANNER,
        "# INTL classification is LLM-DRIVEN over ARBITRARY code schemes, so",
        "# there are NO account-code rules — the model classifies by the",
        "# account NAME's economic meaning against the canonical caption",
        "# vocabulary (statement_map.yaml). prompt_guidance.header is the",
        "# entire jurisdiction block the classify prompt renders. An OPTIONAL",
        "# operator-owned confirmed_mappings.yaml overlay (never generated,",
        "# never --check'd) memoizes human-confirmed code -> line mappings;",
        "# every overlay entry renders into the prompt as a notable line and",
        "# re-versions the pack content hash.",
        "rules: []",
        "",
        "prompt_guidance:",
        "  header: %s" % q(FROZEN_INTL_GUIDANCE),
    ]
    return "\n".join(lines) + "\n"


def build_checks_yaml() -> str:
    """The SAME canonical_bs v2 diagnosis + identity checks the RO pack
    mirrors — this machinery is jurisdiction-neutral engine logic
    (engine.confidence.reconciliation_checks + the canonical builder)
    and runs unchanged on AI-lane envelopes. LIVE reads: an engine
    constant change trips --check and demands a new pack version. NOTE
    the D3/D4 prefix params are the engine's RO-rooted heuristics; they
    run verbatim on every envelope regardless of jurisdiction — mirrored
    as-is, honestly, not re-derived for HU/IFRS charts."""
    rc = _ro_porter().load_reconciliation_checks_module()
    lines = [
        _GENERATED_BANNER,
        "# D0-D9 — the canonical_bs v2 diagnosis vocabulary",
        "# (docs/CANONICAL_BS_V2_CONTRACT.md). Emitted by the SAME engine",
        "# machinery for every jurisdiction: D0-D8 by engine.confidence.",
        "# reconciliation_checks.run_bs_diagnosis inside the canonical",
        "# builder (AI-lane envelopes flow through build_canonical_bs_v2",
        "# too), D9 by the builder itself. Params mirror the in-code",
        "# constants — including the RO-rooted D3/D4 prefix heuristics,",
        "# which run verbatim on every envelope (recorded as-is; they are",
        "# engine behavior, not Act-C/IFRS chart data).",
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
        "  # (An LLM extraction's status is additionally capped below",
        "  # BALANCED by the ai_lane contract.)",
        "  - check_id: reconciliation_identities",
        "    impl: builtin.reconciliation_identities",
        "    params:",
        "      ron_tolerance: %s" % _num(rc._RON_TOLERANCE),
        "      pct_tolerance: %s" % _num(rc._PCT_TOLERANCE),
        "      minor_drift_pct: %s" % _num(rc._MINOR_DRIFT_PCT),
        "      ebitda_rollup_tolerance_pct: 0.01",
    ]
    return "\n".join(lines) + "\n"


def _leaf_lines(bucket, indent: str) -> List[str]:
    return [
        "%s- id: %s" % (indent, bucket.canonical_name),
        "%s  label: %s" % (indent, q(bucket.display_label)),
    ]


def build_statement_map_yaml() -> str:
    """The canonical statement-line vocabulary as the pack tree — LIVE
    read of engine.canonical BS_BUCKETS/PL_BUCKETS, grouped by the
    schema's own section lists so DOCUMENT ORDER == SCHEMA ORDER (the
    classify vocabulary block renders leaves in document order and must
    stay byte-identical to the pre-cutover text). The statement side of
    each leaf stays schema-owned (BucketType — engine placement logic,
    exactly like the RO pack leaves placement tables engine-owned);
    tests pin pack-leaf <-> schema parity both directions."""
    lines = [
        _GENERATED_BANNER,
        "# Tree = the canonical schema-v1 statement-line vocabulary",
        "# (engine.canonical BS_BUCKETS + PL_BUCKETS — every classify",
        "# line_id is one of these leaves), grouped by the schema's own",
        "# section lists in schema order. The AI-lane classify prompt",
        "# renders its CANONICAL LINE VOCABULARY block from these leaves in",
        "# document order (labels verbatim); the `excluded` section carries",
        "# the excluded_control token for technical/closing/memo accounts",
        "# and renders last. Leaf SIDE (asset/liability/equity/revenue/",
        "# expense/memo) stays schema-owned in the engine — placement",
        "# logic, not jurisdiction data.",
        "statements:",
        "  balance_sheet:",
    ]
    for section_id, section_label, attr in _BS_SECTIONS:
        lines.append("    - id: %s" % section_id)
        lines.append("      label: %s" % q(section_label))
        lines.append("      children:")
        for bucket in getattr(_schema, attr):
            lines.extend(_leaf_lines(bucket, "        "))
    lines.extend([
        "    # NOT a statement section: the AI lane's excluded vocabulary.",
        "    # excluded_control claims control/technical/closing/memo",
        "    # accounts explicitly (HU 49x opening/closing, classes 6/7",
        "    # management accounting, class 0 memo; IFRS suspense/clearing)",
        "    # and is NEVER summed into any statement total.",
        "    - id: excluded",
        "      label: %s" % q(_EXCLUDED_SECTION_LABEL),
        "      children:",
        "        - id: excluded_control",
        "          label: %s" % q(FROZEN_EXCLUDED_CONTROL_LABEL),
        "  profit_loss:",
    ])
    for section_id, section_label, attr in _PL_SECTIONS:
        lines.append("    - id: %s" % section_id)
        lines.append("      label: %s" % q(section_label))
        lines.append("      children:")
        for bucket in getattr(_schema, attr):
            lines.extend(_leaf_lines(bucket, "        "))
    return "\n".join(lines) + "\n"


def build_reconcile_yaml() -> str:
    """Mirror of the auto-reconcile constants (engine.api._reconcile) —
    the serve path (`served_canonical_bs`) runs on AI-lane envelopes
    unchanged, so the honest pack data is the engine's actual policy.
    LIVE reads via the RO porter's extractor."""
    consts = _ro_porter().extract_reconcile_constants()
    gate = 1.0 / int(consts["gate_multiplier"])
    label = consts["synthetic_row_label"]
    lines = [
        _GENERATED_BANNER,
        "# Auto-reconcile policy (docs/CANONICAL_BS_V2_CONTRACT.md,",
        "# AUTO-RECONCILE addendum; engine.api._reconcile constants) — the",
        "# SAME jurisdiction-neutral serve machinery that runs on AI-lane",
        "# envelopes. threshold: offer/accept only while |difference| /",
        "# max(assets, equity_plus_liabilities) <= 0.001 (0.1%) — in-code",
        "# the exact-cents gate _GATE_MULTIPLIER = %s." % consts["gate_multiplier"],
        "threshold: %s" % _num(gate),
        "# Placement (engine.api._reconcile._placement_for): a diagnosed",
        "# cause naming a class 6/7 account routes the visible line to the",
        "# P&L by the DELTA'S SIGN; every other cause is a balance-sheet",
        "# line: the synthetic row %s." % consts["synthetic_row_id"],
        "placement_rules:",
        "  - cause: class_67_target_delta_positive",
        "    placement: %s" % consts["placement_detail_pl_income"],
        "  - cause: class_67_target_delta_negative",
        "    placement: %s" % consts["placement_detail_pl_expense"],
        "  - cause: default",
        "    placement: %s" % consts["placement_detail_bs"],
        "# One visible adjustment line. The engine currently serves the",
        "# SYNTHETIC_ROW_LABEL string VERBATIM in every language and every",
        "# jurisdiction (the RO statutory wording — engine-owned behavior,",
        "# mirrored as-is, not translated here).",
        "adjustment_labels:",
        "  en: %s" % q(label),
    ]
    return "\n".join(lines) + "\n"


# ── Generation / check drivers ─────────────────────────────────────────


def generate() -> Dict[str, Dict[str, str]]:
    """Both packs' five files: {pack_key: {filename: content}}."""
    _assert_tables()
    return {
        "hu": {
            "pack.yaml": build_hu_pack_yaml(),
            "classification.yaml": build_hu_classification_yaml(),
            "checks.yaml": build_checks_yaml(),
            "statement_map.yaml": build_statement_map_yaml(),
            "reconcile.yaml": build_reconcile_yaml(),
        },
        "intl": {
            "pack.yaml": build_intl_pack_yaml(),
            "classification.yaml": build_intl_classification_yaml(),
            "checks.yaml": build_checks_yaml(),
            "statement_map.yaml": build_statement_map_yaml(),
            "reconcile.yaml": build_reconcile_yaml(),
        },
    }


def write_packs(out_hu: Path, out_intl: Path) -> None:
    fresh = generate()
    for out_dir, key in ((out_hu, "hu"), (out_intl, "intl")):
        out_dir.mkdir(parents=True, exist_ok=True)
        for name, content in fresh[key].items():
            (out_dir / name).write_text(content, encoding="utf-8")


def self_check(out_hu: Path, out_intl: Path) -> int:
    """Load + lint both emitted packs; print the summary. 0 on clean."""
    from engine.packs.lint import lint_pack

    rc = 0
    for out_dir in (out_hu, out_intl):
        report = lint_pack(out_dir)
        if report.findings:
            print(report.render())
            rc = 1
            continue
        pack = next(iter(report.packs.values()))
        print(
            "port_hu_pack: %s %s@%s — %d rules, %d checks, %d statement "
            "lines, prompt_guidance=%s\npack_hash: %s"
            % (
                pack.identity.jurisdiction,
                pack.identity.pack_id, pack.identity.version,
                len(pack.rules), len(pack.checks),
                len(pack.statement_line_ids()),
                "yes" if pack.prompt_guidance is not None else "no",
                pack.pack_hash,
            )
        )
    return rc


def check_against(out_hu: Path, out_intl: Path) -> int:
    """Byte-compare a fresh generation with the checked-in packs."""
    fresh = generate()
    drift = False
    for target_dir, key in ((out_hu, "hu"), (out_intl, "intl")):
        for name in PACK_FILE_NAMES:
            on_disk_path = target_dir / name
            if not on_disk_path.is_file():
                print("DRIFT %s/%s: missing from %s" % (key, name, target_dir))
                drift = True
                continue
            on_disk = on_disk_path.read_text(encoding="utf-8")
            if on_disk != fresh[key][name]:
                drift = True
                diff = difflib.unified_diff(
                    on_disk.splitlines(keepends=True),
                    fresh[key][name].splitlines(keepends=True),
                    fromfile="checked-in/%s/%s" % (key, name),
                    tofile="regenerated/%s/%s" % (key, name),
                )
                print("DRIFT %s/%s:" % (key, name))
                sys.stdout.writelines(list(diff)[:80])
    if drift:
        print(
            "port_hu_pack --check: a checked-in v1 pack no longer matches "
            "the FROZEN port snapshot (+ the still-live engine constants it "
            "mirrors). v1 is immutable — revert the YAML edit and cut a NEW "
            "pack version instead; if a live engine constant or the canonical "
            "schema changed, that change likewise demands a deliberate new "
            "pack version."
        )
        return 1
    print("port_hu_pack --check: clean — both packs match the frozen port snapshot.")
    return 0


def main(argv: Sequence[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="port_hu_pack.py",
        description=(
            "Regenerate packs/hu/actc2000-v1/ and packs/intl/ifrs-captions-v1/ "
            "from the FROZEN port snapshot (--check: verify the checked-in "
            "packs match it byte-for-byte)."
        ),
    )
    parser.add_argument(
        "--out-hu", metavar="DIR", default=str(DEFAULT_OUT_HU),
        help="HU pack output directory (default: %s)" % DEFAULT_OUT_HU,
    )
    parser.add_argument(
        "--out-intl", metavar="DIR", default=str(DEFAULT_OUT_INTL),
        help="INTL pack output directory (default: %s)" % DEFAULT_OUT_INTL,
    )
    parser.add_argument(
        "--check", action="store_true",
        help="regenerate in memory and byte-diff against the out dirs; "
             "exit 1 on drift",
    )
    args = parser.parse_args(list(argv))
    out_hu = Path(args.out_hu)
    out_intl = Path(args.out_intl)
    if args.check:
        return check_against(out_hu, out_intl)
    write_packs(out_hu, out_intl)
    rc = self_check(out_hu, out_intl)
    if rc == 0:
        print("wrote %s and %s" % (out_hu, out_intl))
    return rc


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 — CLI boundary
        print("port_hu_pack: internal error: %s" % exc, file=sys.stderr)
        sys.exit(2)
