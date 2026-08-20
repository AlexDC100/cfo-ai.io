"""SHADOW comparator — production composition vs the classify pass.

REPURPOSED AT THE PHASE 3 CUTOVER (documented decision). Pre-cutover
this compared the LEGACY in-code classification against the pack; the
cutover made production read the pack, so "pack vs pack" is trivially
green on classification DATA — but the two lanes remain two different
CODE PATHS onto that one data source, and the comparator keeps guarding
exactly that:

  production lane  the REAL production composition — the same code
                   objects the pipeline composes, never a mirror:
                   ``RomaniaPack.assemble_parsed_tb`` (deterministic TB
                   lane: parser value-shaping + pre-assembly overrides +
                   assembler wrong-side flips, all pack-driven now) /
                   ``RomaniaPack.assemble_statements`` (LLM accounts
                   lane), projected via its outputs (line items,
                   ignored/excluded/unmapped telemetry);
  pass lane        ``engine.passes.classify`` over the front-end IR
                   (``engine.ir.LedgerDoc``) — the compiler-style pass,
                   driven by the same CompiledPack.

then maps both onto ONE comparable form and diffs:

  per account   {account code -> {statement line (or marker) -> cents}}
  per section   {statement-map section -> subtotal cents}

Empty diff == the IR front-ends + classify pass agree with the
production parser/assembler composition — a front-end amount-slot bug,
an effective_closing_side regression, or a flip-application divergence
between the two paths shows up as a cent-level diff on real corpus
inputs. Frozen-vintage drift detection (pack YAML vs the pre-cutover
tables) lives separately in tests/engine/test_ro_pack.py against
scripts/port_ro_pack.py's FROZEN_* snapshot. The corpus + property
gates (tests/engine/test_shadow_divergence.py, scripts/shadow_report.py)
require zero divergence on every deterministic corpus case.

── THE COMPARABLE FORM ────────────────────────────────────────────────

Line vocabulary: the pack's statement-map leaf ids — which are, by the
mechanical port, exactly the legacy bucket names (``canonical_bucket``
on legacy line items), plus:

  * the three excluded leaves ``ignore_control`` / ``ignore_transit`` /
    ``ignore_offbalance`` (the pack claims 121 / 581 / class-8
    explicitly; the legacy side records them as assembler
    ``ignored`` items or parser ``excluded`` telemetry);
  * the ``(unclassified)`` marker for accounts NO rule matches (legacy
    ``unmapped`` telemetry; pack UNCLASSIFIED entries).

Values, in integer cents. The two lanes compute them INDEPENDENTLY
where the pack carries the deciding data, and from ONE SHARED source
where the value is a front-end (parser) concern the pack has no say in:

  * BS lines — independent per lane. Legacy: the line item's signed
    amount (parser side-convention × rule sign × wrong-side flips).
    Pack: the row's closing balance signed on the TARGET line's natural
    side (asset sections: sf_d − sf_c; equity/liability sections:
    sf_c − sf_d). These agree by algebra whenever classification
    agrees — a contra flag or side flip mis-ported in the pack shows up
    as a cent-level section diff even when the line assignment happens
    to coincide.
  * PL lines — SHARED value: the parser-shape per-code amount sum (the
    legacy movement heuristics — pick-the-larger-cumulative-side,
    closing-only fallback, one-side-zero sign fix — are the FRONT-END's
    value extraction, not classification; the pack carries no movement
    semantics by design). The PL comparison therefore tests line
    ASSIGNMENT, deliberately not value extraction.
  * markers (excluded / unclassified) — debit-signed closing cents
    (sf_d − sf_c) on the TB lane; the raw signed amount on the
    accounts lane. Legacy ``ignored`` 121 amounts are credit-natural
    (sf_c − sf_d) on the TB lane and are negated into the shared
    convention (documented normalization #2 below).

Zero-cent entries are pruned from BOTH lanes after aggregation: the
legacy parser/assembler drop value-free rows (``amount == 0``), so a
zero balance carries no classification signal to compare.

── DOCUMENTED NORMALIZATIONS (legacy -> comparable form) ──────────────

 1. parser ``unmapped`` reason ``transit_581_nonzero_closing`` maps to
    line ``ignore_transit``, not to the unclassified marker: the legacy
    CLASSIFICATION of 581 is the ignore_transit rule; the unmapped
    re-route is the canonical builder's closing-identity mechanism
    (value-bearing transit must stay in the totals), not a different
    classification decision.
 2. assembler ``ignored`` 121 amounts arrive credit-natural
    (sf_c − sf_d, profit positive) on the TB lane and are negated to
    the debit-signed marker convention. On the accounts lane both lanes
    carry the raw amount — no negation.
 3. parser ``excluded`` reasons map to the pack's excluded leaves:
    ``ignore_transit`` -> ignore_transit; class-8 reasons
    (``off_balance_class_8`` / ``opening_balance_sheet_account`` /
    ``closing_balance_sheet_account``) -> ignore_offbalance.

── PATH-DEPENDENCE, RESOLVED AT THE CUTOVER (history) ─────────────────

Pre-cutover, the parser-layer credit-side re-routes (418/451/452/455/
461/467/425/1687 -> otherCurrentLiab) fired ONLY on the deterministic
TB lane; the LLM-accounts lane ran just the assembler's bifunctional
flips (which lacked 418/451/452/1687). The pack is ONE table encoding
the deterministic behavior, and since the cutover BOTH production lanes
read it — the assembler's wrong-side re-route now honors the pack's
418/451/452 flips on the accounts lane too (no corpus mock carries such
a row, so the goldens were untouched; the unification is the intended
one-table semantics).

── LOCATION DECISION ──────────────────────────────────────────────────

This module lives at ``engine/passes/shadow.py`` (not
``engine/shadow.py``): it composes the classify PASS with the legacy
seam, and Phase 2's assembler pass will extend the same comparator —
one home for the whole shadow phase. (The phase spec allowed either
path; this is the documented pick.)

Heavy engine imports (country pack, front-ends) happen INSIDE
functions so ``engine.passes`` stays a cheap import for the pipeline's
opt-in probe.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Tuple

from engine.packs import CompiledPack, discover_packs, resolve

from .classify import ClassificationLayer, classify

__all__ = [
    "UNCLASSIFIED",
    "DEFAULT_PERIOD_END",
    "ShadowError",
    "AccountDiff",
    "SectionDiff",
    "ShadowResult",
    "default_packs_root",
    "load_ro_pack",
    "shadow_compare_tb",
    "shadow_compare_accounts",
    "shadow_compare_hu_assignments",
    "render_result",
    "log_shadow_for_tb",
]

#: The unclassified marker in the comparable form (a name no statement
#: map can collide with — pack line ids are identifier-shaped).
UNCLASSIFIED = "(unclassified)"

#: The statement-map branch that is never summed into section subtotals.
_EXCLUDED_TOP = "excluded"

#: Debit-natural (asset-side) balance-sheet sections of the canonical
#: section vocabulary; every other BS section is credit-natural.
#: Mirrors canonical_adapter._BS_V2_ASSET_SECTIONS — asserted against
#: the pack's own tree in _line_placement.
_ASSET_SECTIONS = frozenset({"non_current_assets", "current_assets", "prepaid_expenses"})

#: Effective-dated pack resolution needs a period end; the RO pack
#: window is [2015-01-01, open), so any modern date resolves to the
#: same pack. Fixed for determinism.
DEFAULT_PERIOD_END = "2025-12-31"


class ShadowError(RuntimeError):
    """The comparator could not set up a faithful comparison (input
    shape problems — never a divergence, which is DATA, not an error)."""


# --- result shapes ------------------------------------------------------------


@dataclass
class AccountDiff:
    """One diverging account: the two lanes' {line -> cents} views."""

    code: str
    legacy: Dict[str, int]
    pack: Dict[str, int]


@dataclass
class SectionDiff:
    """One diverging section subtotal (integer cents per lane)."""

    section: str
    legacy_cents: int
    pack_cents: int


@dataclass
class ShadowResult:
    case_id: str
    lane: str  # 'deterministic_tb' | 'llm_accounts'
    pack_hash: str
    accounts_compared: int
    account_diffs: List[AccountDiff] = field(default_factory=list)
    section_diffs: List[SectionDiff] = field(default_factory=list)
    notes: List[str] = field(default_factory=list)

    @property
    def green(self) -> bool:
        return not self.account_diffs and not self.section_diffs


# --- small helpers ------------------------------------------------------------


def _cents(value: Any) -> int:
    try:
        return int(round(float(value or 0) * 100))
    except (TypeError, ValueError):
        return 0


def _add(form: Dict[str, Dict[str, int]], code: str, line: str, cents: int) -> None:
    form.setdefault(code, {})[line] = form.get(code, {}).get(line, 0) + cents


def _prune_zeros(form: Dict[str, Dict[str, int]]) -> Dict[str, Dict[str, int]]:
    out: Dict[str, Dict[str, int]] = {}
    for code, lines in form.items():
        kept = {line: cents for line, cents in lines.items() if cents != 0}
        if kept:
            out[code] = kept
    return out


def _ro_pack_legacy():
    """The registered RomaniaPack (the production composition seam —
    'legacy' names the LANE for continuity with the shadow phase; its
    classification is pack-driven since the Phase 3 cutover)."""
    import engine.country_packs.ro_romania  # noqa: F401 — registers RomaniaPack
    from engine.core.country_pack_registry import get_pack

    return get_pack("RO")


def default_packs_root() -> Path:
    """The pack root — delegated to the production runtime
    (engine.packs.runtime), so the comparator and the engine can never
    disagree about which packs directory governs. ENGINE_PACKS_ROOT /
    SHADOW_PACK_ROOT override, else repo/packs."""
    from engine.packs.runtime import default_packs_root as _runtime_root

    return _runtime_root()


def load_ro_pack(
    packs_root: Optional[Path] = None,
    period_end: str = DEFAULT_PERIOD_END,
) -> CompiledPack:
    """Discover + resolve the RO pack governing ``period_end``."""
    root = Path(packs_root) if packs_root is not None else default_packs_root()
    return resolve(discover_packs(root), "RO", period_end)


# --- statement-map placement ---------------------------------------------------


def _line_placement(pack: CompiledPack) -> Dict[str, Tuple[str, str]]:
    """{node id -> (statement, top-level id)} over the pack's trees.

    Top-level BS nodes are the canonical sections (plus the non-section
    ``excluded`` branch); top-level PL nodes are the presentation
    groups. A childless top maps to itself. Asserts the asset-section
    vocabulary matches the pack's tree so a renamed section can't
    silently flip value signs.
    """
    placement: Dict[str, Tuple[str, str]] = {}

    def _walk(statement: str, top_id: str, node: Any) -> None:
        placement[node.id] = (statement, top_id)
        for child in node.children:
            _walk(statement, top_id, child)

    bs_tops = []
    for top in pack.balance_sheet:
        bs_tops.append(top.id)
        _walk("balance_sheet", top.id, top)
    for top in pack.profit_loss:
        _walk("profit_loss", top.id, top)

    missing = _ASSET_SECTIONS - set(bs_tops)
    if missing:
        raise ShadowError(
            "pack statement map lacks expected asset sections %s — the "
            "comparator's side conventions would be wrong; update "
            "_ASSET_SECTIONS with the vocabulary change" % sorted(missing)
        )
    return placement


def _placement_for(
    placement: Dict[str, Tuple[str, str]], line: str
) -> Tuple[str, str]:
    """Placement for a line, with a loud pseudo-section for vocabulary
    strays (an unknown legacy bucket must DIVERGE, not crash)."""
    return placement.get(line, ("unknown", "(unknown:%s)" % line))


# --- legacy-lane projections ---------------------------------------------------


_PARSER_EXCLUDED_TO_LINE = {
    # documented normalization #3 (module docstring)
    "ignore_transit": "ignore_transit",
    "off_balance_class_8": "ignore_offbalance",
    "opening_balance_sheet_account": "ignore_offbalance",
    "closing_balance_sheet_account": "ignore_offbalance",
}


def _legacy_form_tb(
    shaped: Any, assembled: Dict[str, Any], notes: List[str]
) -> Dict[str, Dict[str, int]]:
    """Project the REAL deterministic-lane outputs onto the comparable
    form: assembled line items (classified), assembler ``ignored``
    (121 control), parser ``unmapped`` / ``excluded`` telemetry."""
    form: Dict[str, Dict[str, int]] = {}

    for li in assembled.get("lineItems") or []:
        if not isinstance(li, dict) or li.get("is_derived"):
            continue
        code = str(li.get("ro_account_code") or "").strip()
        line = str(li.get("canonical_bucket") or li.get("bucket") or "")
        if not code or not line:
            continue
        _add(form, code, line, _cents(li.get("amount")))

    for ig in assembled.get("ignored") or []:
        if not isinstance(ig, dict):
            continue
        code = str(ig.get("ro_account_code") or "").strip()
        bucket = str(ig.get("bucket") or "")
        if not code or not bucket:
            continue
        cents = _cents(ig.get("amount"))
        if bucket == "ignore_control" and code.startswith("121"):
            cents = -cents  # normalization #2: credit-natural -> debit-signed
        _add(form, code, bucket, cents)

    for u in getattr(shaped, "unmapped", None) or []:
        if not isinstance(u, dict):
            continue
        code = str(u.get("code") or "").strip()
        if not code:
            continue
        if "sf_d" in u or "sf_c" in u:
            cents = _cents(u.get("sf_d")) - _cents(u.get("sf_c"))
        else:
            cents = _cents(u.get("amount"))
        reason = str(u.get("reason") or "")
        if reason == "transit_581_nonzero_closing":
            _add(form, code, "ignore_transit", cents)  # normalization #1
        else:
            _add(form, code, UNCLASSIFIED, cents)

    for e in getattr(shaped, "excluded", None) or []:
        if not isinstance(e, dict):
            continue
        code = str(e.get("code") or "").strip()
        if not code:
            continue
        cents = _cents(e.get("sf_d")) - _cents(e.get("sf_c"))
        reason = str(e.get("reason") or "")
        line = _PARSER_EXCLUDED_TO_LINE.get(reason, "ignore_offbalance")
        _add(form, code, line, cents)

    stray_unmapped = assembled.get("unmapped") or []
    if stray_unmapped:
        # Deterministic lane hands the assembler only ruled accounts, so
        # in-loop misses shouldn't exist — surface them loudly if they do.
        notes.append(
            "legacy assembler reported %d in-loop unmapped account(s) on the "
            "deterministic lane (unexpected)" % len(stray_unmapped)
        )
        for u in stray_unmapped:
            if isinstance(u, dict) and u.get("code"):
                _add(form, str(u["code"]).strip(), UNCLASSIFIED, _cents(u.get("amount")))

    return _prune_zeros(form)


def _legacy_form_accounts(
    assembled: Dict[str, Any], notes: List[str]
) -> Dict[str, Dict[str, int]]:
    """Project the REAL accounts-lane (LLM shape) assembler outputs."""
    form: Dict[str, Dict[str, int]] = {}
    for li in assembled.get("lineItems") or []:
        if not isinstance(li, dict) or li.get("is_derived"):
            continue
        code = str(li.get("ro_account_code") or "").strip()
        line = str(li.get("canonical_bucket") or li.get("bucket") or "")
        if not code or not line:
            continue
        _add(form, code, line, _cents(li.get("amount")))
        if li.get("via_semantic_fallback"):
            notes.append(
                "legacy routed %s via the F3.10 semantic-name fallback "
                "(engine logic outside the pack) — pack lane reports it "
                "unclassified by design" % code
            )
    for ig in assembled.get("ignored") or []:
        if not isinstance(ig, dict):
            continue
        code = str(ig.get("ro_account_code") or "").strip()
        bucket = str(ig.get("bucket") or "")
        if code and bucket:
            # accounts lane: raw amount IS the shared marker convention
            _add(form, code, bucket, _cents(ig.get("amount")))
    for u in assembled.get("unmapped") or []:
        if isinstance(u, dict) and u.get("code"):
            _add(form, str(u["code"]).strip(), UNCLASSIFIED, _cents(u.get("amount")))
    return _prune_zeros(form)


# --- pack-lane projections -----------------------------------------------------


def _pack_form_tb(
    doc: Any,
    rows: List[Dict[str, Any]],
    shaped: Any,
    pack: CompiledPack,
    placement: Dict[str, Tuple[str, str]],
) -> Dict[str, Dict[str, int]]:
    """Pack lane, deterministic TB: classify the IR atoms; value BS
    lines from the rows' closing pair on the TARGET side, PL lines from
    the SHARED parser-shape per-code sums, markers debit-signed."""
    layer: ClassificationLayer = classify(doc, pack)
    by_id = {e.atom_id: e for e in layer.entries}

    pl_shared: Dict[str, int] = {}
    for a in shaped:
        if not isinstance(a, dict):
            continue
        code = str(a.get("code") or "").strip()
        if code:
            pl_shared[code] = pl_shared.get(code, 0) + _cents(a.get("amount"))

    form: Dict[str, Dict[str, int]] = {}
    pl_assigned: set = set()
    for atom, row in zip(doc.atoms, rows):
        entry = by_id[atom.atom_id]
        code = entry.account_code
        sf_d = float(row.get("sf_d") or 0.0)
        sf_c = float(row.get("sf_c") or 0.0)
        if entry.line_id is None:
            # marker value mirrors the parser telemetry's per-side rounding
            _add(form, code, UNCLASSIFIED,
                 _cents(round(sf_d, 2)) - _cents(round(sf_c, 2)))
            continue
        statement, top = _placement_for(placement, entry.line_id)
        if top == _EXCLUDED_TOP:
            _add(form, code, entry.line_id,
                 _cents(round(sf_d, 2)) - _cents(round(sf_c, 2)))
        elif statement == "balance_sheet":
            if top in _ASSET_SECTIONS:
                cents = _cents(round(sf_d - sf_c, 2))
            else:
                cents = _cents(round(sf_c - sf_d, 2))
            _add(form, code, entry.line_id, cents)
        elif statement == "profit_loss":
            pl_assigned.add((code, entry.line_id))
        else:  # vocabulary stray — keep it visible with a debit-signed value
            _add(form, code, entry.line_id,
                 _cents(round(sf_d, 2)) - _cents(round(sf_c, 2)))
    for code, line in sorted(pl_assigned):
        _add(form, code, line, pl_shared.get(code, 0))
    return _prune_zeros(form)


def _pack_form_accounts(
    accounts: List[Dict[str, Any]],
    pack: CompiledPack,
    placement: Dict[str, Tuple[str, str]],
) -> Dict[str, Dict[str, int]]:
    """Pack lane, LLM-accounts shape: one signed amount per account,
    rule-natural-positive by the extraction convention. The closing
    side is therefore implied by the amount's sign relative to the
    rule's natural side; flips apply per the pack's side_flip data."""
    form: Dict[str, Dict[str, int]] = {}
    for a in accounts:
        if not isinstance(a, dict):
            continue
        code = str(a.get("code") or "").strip()
        try:
            amount = float(a.get("amount") or 0)
        except (TypeError, ValueError):
            continue
        if not code or amount == 0:
            continue  # the legacy assembler skips value-free rows the same way
        rule = pack.match(code)
        if rule is None:
            _add(form, code, UNCLASSIFIED, _cents(amount))
            continue
        line = rule.line_id
        signed = -amount if rule.contra else amount
        if rule.side_flip is not None and not rule.contra:
            statement, top = _placement_for(placement, rule.line_id)
            natural: Optional[str] = None
            if statement == "balance_sheet" and top != _EXCLUDED_TOP:
                natural = "debit" if top in _ASSET_SECTIONS else "credit"
            if natural is not None:
                side = natural if signed > 0 else ("credit" if natural == "debit" else "debit")
                if side == rule.side_flip.side:
                    line = rule.side_flip.line_id
                    signed = -signed
        _add(form, code, line, _cents(signed))
    return _prune_zeros(form)


# --- diffing -------------------------------------------------------------------


def _section_totals(
    form: Dict[str, Dict[str, int]], placement: Dict[str, Tuple[str, str]]
) -> Dict[str, int]:
    totals: Dict[str, int] = {}
    for lines in form.values():
        for line, cents in lines.items():
            if line == UNCLASSIFIED:
                continue
            _statement, top = _placement_for(placement, line)
            if top == _EXCLUDED_TOP:
                continue
            totals[top] = totals.get(top, 0) + cents
    return totals


def _diff(
    case_id: str,
    lane: str,
    pack: CompiledPack,
    placement: Dict[str, Tuple[str, str]],
    legacy_form: Dict[str, Dict[str, int]],
    pack_form: Dict[str, Dict[str, int]],
    notes: List[str],
) -> ShadowResult:
    account_diffs: List[AccountDiff] = []
    for code in sorted(set(legacy_form) | set(pack_form)):
        legacy_lines = legacy_form.get(code, {})
        pack_lines = pack_form.get(code, {})
        if legacy_lines != pack_lines:
            account_diffs.append(AccountDiff(code, dict(legacy_lines), dict(pack_lines)))

    legacy_sections = _section_totals(legacy_form, placement)
    pack_sections = _section_totals(pack_form, placement)
    section_diffs: List[SectionDiff] = []
    for section in sorted(set(legacy_sections) | set(pack_sections)):
        lv = legacy_sections.get(section, 0)
        pv = pack_sections.get(section, 0)
        if lv != pv:
            section_diffs.append(SectionDiff(section, lv, pv))

    return ShadowResult(
        case_id=case_id,
        lane=lane,
        pack_hash=pack.pack_hash,
        accounts_compared=len(set(legacy_form) | set(pack_form)),
        account_diffs=account_diffs,
        section_diffs=section_diffs,
        notes=notes,
    )


# --- entry points ---------------------------------------------------------------


def _build_doc_from_tb(tb_rows: Any) -> Any:
    """Front-end IR for already-parsed tb_rows (the hook / property
    path, where no source bytes are at hand). Uses the shared
    trial-balance LedgerDoc builder with the parser-detected format id.

    Note (PDF lane): the generic builder carries the parser's collapsed
    rulaj in the period slots instead of splitting prec/cur into the
    side-channel like PositionalPdfFrontEnd does — irrelevant here
    because classification reads only account codes + the CLOSING pair,
    which the PDF lane always carries. The offline report
    (scripts/shadow_report.py) uses the real per-format front-ends.
    """
    from engine.frontends.registry import resolve_front_end
    from engine.frontends.saga10 import build_tb_ledgerdoc

    extraction = dict(getattr(tb_rows, "extraction", {}) or {})
    format_id = str(extraction.get("source_format") or "saga_10_col")
    front_end = resolve_front_end(format_id)
    filename = str(extraction.get("original_filename") or "")
    doc, _diagnostics = build_tb_ledgerdoc(
        tb_rows,
        format_id=front_end.format_id,
        spec=front_end.spec,
        hints={"filename": filename},
    )
    return doc


def shadow_compare_tb(
    tb_rows: Any,
    pack: CompiledPack,
    *,
    doc: Any = None,
    case_id: str = "",
) -> ShadowResult:
    """Deterministic-TB shadow: legacy = the REAL post-parse composition
    (``RomaniaPack.assemble_parsed_tb`` — the exact seam stage_extract +
    stage_map compose); pack = ``classify`` over the front-end IR.

    ``tb_rows`` is a parsed TrialBalanceParseResult (or row-dict list);
    ``doc`` is the front-end LedgerDoc for the SAME rows — built from
    the rows when not supplied. Inputs are never mutated.
    """
    legacy_pack = _ro_pack_legacy()
    _tb, shaped, assembled = legacy_pack.assemble_parsed_tb(tb_rows)

    if doc is None:
        doc = _build_doc_from_tb(tb_rows)

    rows = [r for r in tb_rows if isinstance(r, dict)]
    if len(doc.atoms) != len(rows):
        raise ShadowError(
            "front-end IR does not mirror tb_rows 1:1 (%d atoms vs %d rows) — "
            "refusing to compare misaligned lanes" % (len(doc.atoms), len(rows))
        )
    for atom, row in zip(doc.atoms, rows):
        if atom.account_code.strip() != str(row.get("cont") or "").strip():
            raise ShadowError(
                "front-end IR atom order diverged from tb_rows at atom %s "
                "(%r vs %r) — refusing to compare misaligned lanes"
                % (atom.atom_id, atom.account_code, row.get("cont"))
            )

    notes: List[str] = []
    placement = _line_placement(pack)
    legacy_form = _legacy_form_tb(shaped, assembled, notes)
    pack_form = _pack_form_tb(doc, rows, shaped, pack, placement)
    return _diff(case_id, "deterministic_tb", pack, placement,
                 legacy_form, pack_form, notes)


def shadow_compare_accounts(
    accounts: List[Dict[str, Any]],
    pack: CompiledPack,
    *,
    case_id: str = "",
) -> ShadowResult:
    """LLM-accounts shadow (the mocked extract rows of the llm corpus
    cases): legacy = the REAL ``assemble_statements`` over the account
    dicts; pack = rule lookup per account with the amount-sign side
    convention. See the module docstring's path-dependence note."""
    legacy_pack = _ro_pack_legacy()
    assembled = legacy_pack.assemble_statements([dict(a) for a in accounts])

    notes: List[str] = []
    placement = _line_placement(pack)
    legacy_form = _legacy_form_accounts(assembled, notes)
    pack_form = _pack_form_accounts([dict(a) for a in accounts], pack, placement)
    return _diff(case_id, "llm_accounts", pack, placement,
                 legacy_form, pack_form, notes)


def shadow_compare_hu_assignments(
    assignments: List[Dict[str, Any]],
    rows: List[Dict[str, Any]],
    pack: CompiledPack,
    *,
    case_id: str = "",
) -> ShadowResult:
    """AI-lane (HU/INTL) shadow — wired at the Phase-4 cutover, when the
    HU pack landed. Classification on this lane is MODEL-OWNED, so there
    is no full deterministic lane to mirror; what the pack DOES pin, the
    model output must agree with:

      1. VOCABULARY CONTAINMENT — every assigned line_id must be a
         statement-map leaf of the pack (the classify prompt's
         vocabulary renders from those leaves, so a stray line means the
         two sides of the prompt-from-pack contract diverged);
      2. RULE AGREEMENT — wherever the pack carries a code rule (the
         notable-account exact rules; any confirmed_mappings.yaml
         overlay), the model's line must equal the pack's target line
         for that code and closing side.

    The 'legacy' column of the diff table holds the MODEL's assignment
    (the production value — the mocked classify response in corpus
    replays); the 'pack' column holds the pack's pinned target (or a
    loud pseudo-line for vocabulary strays). Amounts come from the
    extract rows for readable diffs; agreement is per LINE."""
    cents_by_code: Dict[str, int] = {}
    side_by_code: Dict[str, Optional[str]] = {}
    for row in rows:
        code = str(row.get("code") or "").strip()
        if not code:
            continue
        debit = row.get("debit")
        credit = row.get("credit")
        signed = _cents(debit) - _cents(credit)
        if debit is None and credit is None:
            signed = _cents(row.get("balance"))
        cents_by_code[code] = signed
        if debit is not None and credit is None:
            side_by_code[code] = "debit"
        elif credit is not None and debit is None:
            side_by_code[code] = "credit"
        else:
            side_by_code[code] = "debit" if signed >= 0 else "credit"

    leaf_ids = set()

    def _walk(nodes: Any) -> None:
        for node in nodes:
            if not node.children:
                leaf_ids.add(node.id)
            _walk(node.children)

    _walk(pack.balance_sheet)
    _walk(pack.profit_loss)

    diffs: List[AccountDiff] = []
    rule_checked = 0
    compared = 0
    for a in assignments:
        code = str(a.get("code") or "").strip()
        line = str(a.get("line_id") or "").strip()
        if not code or not line:
            continue
        compared += 1
        cents = cents_by_code.get(code, 0)
        if line not in leaf_ids:
            diffs.append(AccountDiff(
                code=code,
                legacy={line: cents},
                pack={"(not-a-statement-map-leaf)": cents},
            ))
            continue
        rule = pack.match(code)
        if rule is None:
            continue  # model-owned code: nothing pinned, nothing to diff
        rule_checked += 1
        expected = pack.target_line(code, side_by_code.get(code))
        if expected != line:
            diffs.append(AccountDiff(
                code=code, legacy={line: cents}, pack={str(expected): cents},
            ))

    notes = [
        "AI-lane shadow: model assignments vs the %s pack — %d assignment(s) "
        "checked for vocabulary containment, %d covered by a pack code rule"
        % (pack.identity.jurisdiction, compared, rule_checked),
    ]
    return ShadowResult(
        case_id=case_id,
        lane="llm_hu_pack",
        pack_hash=pack.pack_hash,
        accounts_compared=compared,
        account_diffs=diffs,
        section_diffs=[],
        notes=notes,
    )


# --- rendering + the pipeline probe ---------------------------------------------


def _fmt_lines(lines: Mapping[str, int]) -> str:
    if not lines:
        return "(nothing)"
    return ", ".join(
        "%s=%s" % (line, "%.2f" % (cents / 100.0))
        for line, cents in sorted(lines.items())
    )


def render_result(result: ShadowResult, max_accounts: int = 40) -> str:
    """Human-readable per-case report (the script's table; empty diff
    sections render as an explicit ALL-CLEAR line)."""
    out: List[str] = []
    out.append(
        "%s  case=%s lane=%s accounts=%d pack=%s"
        % ("GREEN " if result.green else "DIVERGE",
           result.case_id or "-", result.lane,
           result.accounts_compared, result.pack_hash[:12])
    )
    for note in result.notes:
        out.append("  note: %s" % note)
    if result.account_diffs:
        out.append("  per-account divergences (%d):" % len(result.account_diffs))
        out.append("    %-14s | %-46s | %s" % ("account", "legacy", "pack"))
        for diff in result.account_diffs[:max_accounts]:
            out.append("    %-14s | %-46s | %s"
                       % (diff.code, _fmt_lines(diff.legacy), _fmt_lines(diff.pack)))
        if len(result.account_diffs) > max_accounts:
            out.append("    … %d more" % (len(result.account_diffs) - max_accounts))
    if result.section_diffs:
        out.append("  per-section subtotal divergences (%d):" % len(result.section_diffs))
        out.append("    %-26s | %16s | %16s | %s"
                   % ("section", "legacy", "pack", "delta"))
        for sd in result.section_diffs:
            out.append("    %-26s | %16.2f | %16.2f | %.2f"
                       % (sd.section, sd.legacy_cents / 100.0, sd.pack_cents / 100.0,
                          (sd.pack_cents - sd.legacy_cents) / 100.0))
    return "\n".join(out)


_PACK_CACHE: Dict[str, CompiledPack] = {}


def _cached_ro_pack() -> CompiledPack:
    key = str(default_packs_root())
    pack = _PACK_CACHE.get(key)
    if pack is None:
        pack = load_ro_pack()
        _PACK_CACHE[key] = pack
    return pack


def log_shadow_for_tb(tb_rows: Any, doc_id: str = "") -> Optional[ShadowResult]:
    """The SHADOW_CLASSIFY=1 pipeline probe body: run the comparison,
    LOG the outcome, return the result (for tests). Never mutates its
    input; exceptions propagate to the caller's guard (the pipeline
    hook wraps this in try/except so the shadow can never break prod).
    """
    import logging

    logger = logging.getLogger("engine.passes.shadow")
    pack = _cached_ro_pack()
    result = shadow_compare_tb(tb_rows, pack, case_id=doc_id or "doc")
    if result.green:
        logger.info(
            "[shadow_classify] GREEN doc=%s accounts=%d pack=%s",
            doc_id or "-", result.accounts_compared, result.pack_hash[:12],
        )
    else:
        logger.warning(
            "[shadow_classify] DIVERGENCE doc=%s accounts=%d "
            "account_diffs=%d section_diffs=%d\n%s",
            doc_id or "-", result.accounts_compared,
            len(result.account_diffs), len(result.section_diffs),
            render_result(result),
        )
    return result
