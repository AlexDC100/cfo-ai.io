"""CLASSIFY pass — LedgerDoc atoms -> pack statement-line assignments.

SHADOW-PHASE MINIMAL IMPLEMENTATION (zero behavior change): nothing in
the production pipeline consumes this layer; the shadow comparator
(``engine.passes.shadow``) runs it side-by-side with the legacy
classification and diffs the two.

The pass is pure DATA application:

    classify(doc, pack) -> ClassificationLayer
        one entry per atom: {atom_id -> line_id, method 'rule',
        rule_id, confidence 1.0}; atoms no rule matches carry the
        explicit UNCLASSIFIED marker (line_id None, method
        'unclassified') — never guessed, never dropped. Value
        conservation is the (future) assembler's job: the shadow phase
        only CLASSIFIES.

Semantics are exactly ``CompiledPack.target_line``'s, split open so the
layer can carry the winning ``rule_id`` and the flip flag:

  * rule lookup — the pack's fixed precedence
    (exact > longest-prefix > range, ``CompiledPack.match``);
  * side flip — when the winning rule carries a ``side_flip`` and the
    atom's EFFECTIVE CLOSING SIDE equals the flip side, the assignment
    is the flip's line (RO 4111 closing credit = customer advances
    received, never negative receivables).

EFFECTIVE CLOSING SIDE (``effective_closing_side``): the sign of the
atom's net closing balance, computed in EXACT integer minor units
(never floats), normalized to the finest scale among the slots
involved:

  * closing pair present (either slot) -> closing_debit − closing_credit;
  * closing pair ABSENT (Layout B / saga_compact_6_col: the source has
    no Solduri-finale block and the front-end deliberately encodes the
    parser's synthesized sf as ABSENT) -> the SAME identity the parser
    synthesizes from: (opening_debit + period_debit) −
    (opening_credit + period_credit) over the present slots;
  * net exactly zero (or no amount slots at all) -> None: the side is
    undefined AND irrelevant — a zero balance never fires a side flip
    and contributes no value.

Confidence: every assignment is method='rule' with confidence 1.0 — a
deterministic table lookup is exact by definition (mirrors the IR's
'mechanical' provenance rule). LLM-assisted classification (a later
phase) will introduce other methods/confidences; the shadow phase has
exactly these two methods.

Import discipline: this module depends ONLY on ``engine.ir`` and
``engine.packs`` types — no parser, pipeline, or serving imports.
"""
from __future__ import annotations

from dataclasses import dataclass
from types import MappingProxyType
from typing import Mapping, Optional, Tuple

from engine.ir import AccountAtom, LedgerDoc, Money
from engine.packs import CompiledPack

__all__ = [
    "METHOD_RULE",
    "METHOD_UNCLASSIFIED",
    "ClassifyError",
    "AtomClassification",
    "ClassificationLayer",
    "classify",
    "effective_closing_side",
]

#: Assignment methods this pass can emit (the shadow-phase vocabulary).
METHOD_RULE = "rule"
METHOD_UNCLASSIFIED = "unclassified"


class ClassifyError(ValueError):
    """Classification-pass input failure (wrong types — never data)."""


# --- effective closing side --------------------------------------------------


def _minor_at(money: Optional[Money], scale: int) -> int:
    """The Money's amount in minor units of ``scale`` (exact integer
    rescale — scale is always >= the Money's own scale here)."""
    if money is None:
        return 0
    return money.amount_minor * (10 ** (scale - money.scale))


def _net_signed_minor(pairs: Tuple[Tuple[Optional[Money], Optional[Money]], ...]) -> int:
    """Σ(debit − credit) over (debit, credit) Money pairs, in exact
    integer minor units at the finest scale present. ABSENT slots
    contribute zero."""
    monies = [m for pair in pairs for m in pair if m is not None]
    if not monies:
        return 0
    scale = max(m.scale for m in monies)
    total = 0
    for debit, credit in pairs:
        total += _minor_at(debit, scale) - _minor_at(credit, scale)
    return total


def effective_closing_side(atom: AccountAtom) -> Optional[str]:
    """'debit' | 'credit' | None — the side the atom's net CLOSING
    balance sits on (None == exactly zero / no amount data).

    Closing pair when the document carries one; otherwise the
    opening+period identity the parser's Layout-B synthesis uses
    (see module docstring). Exact integer math throughout.
    """
    if atom.closing_debit is not None or atom.closing_credit is not None:
        net = _net_signed_minor(((atom.closing_debit, atom.closing_credit),))
    else:
        net = _net_signed_minor((
            (atom.opening_debit, atom.opening_credit),
            (atom.period_debit, atom.period_credit),
        ))
    if net > 0:
        return "debit"
    if net < 0:
        return "credit"
    return None


# --- the layer ----------------------------------------------------------------


@dataclass(frozen=True)
class AtomClassification:
    """One atom's assignment. ``line_id`` None == UNCLASSIFIED (the
    explicit marker — the assembler-phase consumer decides placement of
    unclassified value; the shadow phase only surfaces it)."""

    atom_id: str
    account_code: str
    line_id: Optional[str]
    rule_id: Optional[str]
    method: str  # METHOD_RULE | METHOD_UNCLASSIFIED
    confidence: float
    side_flipped: bool = False
    closing_side: Optional[str] = None  # 'debit' | 'credit' | None


@dataclass(frozen=True)
class ClassificationLayer:
    """The classify pass's output: one entry per atom, document order,
    stamped with the pack content hash that produced it."""

    pack_hash: str
    entries: Tuple[AtomClassification, ...]

    def by_atom_id(self) -> Mapping[str, AtomClassification]:
        return MappingProxyType({e.atom_id: e for e in self.entries})

    @property
    def classified_count(self) -> int:
        return sum(1 for e in self.entries if e.line_id is not None)

    @property
    def unclassified_count(self) -> int:
        return sum(1 for e in self.entries if e.line_id is None)


# --- the pass -----------------------------------------------------------------


def classify(doc: LedgerDoc, pack: CompiledPack) -> ClassificationLayer:
    """Classify every atom of ``doc`` against ``pack``.

    Deterministic: the result depends only on the pack data and the
    atoms' account codes + amount slots. Assignment semantics are
    identical to ``CompiledPack.target_line(code, closing_side)`` —
    locked by tests/engine/test_shadow_divergence.py.
    """
    if not isinstance(doc, LedgerDoc):
        raise ClassifyError("classify takes a LedgerDoc, got %s" % type(doc).__name__)
    if not isinstance(pack, CompiledPack):
        raise ClassifyError(
            "classify takes a CompiledPack, got %s" % type(pack).__name__
        )

    entries = []
    for atom in doc.atoms:
        code = atom.account_code.strip()
        side = effective_closing_side(atom)
        rule = pack.match(code)
        if rule is None:
            entries.append(AtomClassification(
                atom_id=atom.atom_id,
                account_code=code,
                line_id=None,
                rule_id=None,
                method=METHOD_UNCLASSIFIED,
                confidence=1.0,
                side_flipped=False,
                closing_side=side,
            ))
            continue
        line_id = rule.line_id
        flipped = False
        if (
            rule.side_flip is not None
            and side is not None
            and side == rule.side_flip.side
        ):
            line_id = rule.side_flip.line_id
            flipped = True
        entries.append(AtomClassification(
            atom_id=atom.atom_id,
            account_code=code,
            line_id=line_id,
            rule_id=rule.rule_id,
            method=METHOD_RULE,
            confidence=1.0,
            side_flipped=flipped,
            closing_side=side,
        ))
    return ClassificationLayer(pack_hash=pack.pack_hash, entries=tuple(entries))
