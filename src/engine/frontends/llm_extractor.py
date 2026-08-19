"""LLM-extract front-end — wraps the AI lane's extract-stage result.

The AI lane's stage 2 (`engine.ai_lane.extract.run_extract`) turns a
document into strict JSON: {"rows": [{code, label, debit, credit,
balance}, ...], "totals_row": {"debit", "credit"} | null}. THIS
front-end's input bytes are exactly that strict-JSON payload — the
model's recorded response is the "document" being adapted; no model is
ever called here. `parse(data, hints)` feeds the bytes through the REAL
`run_extract` coercion (via the lane's injectable-client seam, with an
echo client that replays the given bytes) so row normalization —
non-dict rows skipped, empty codes skipped, code/label stripped,
numbers through `_num` — is the production code object, not a mirror.
A malformed payload therefore fails exactly as the lane fails
(`AiLaneError` after the one-retry protocol).

ROW -> ATOM MAPPING (documented per Part B item 3):

  * debit/credit form (either side is not null): the values are the
    row's CLOSING balances (per the extract-stage schema) —
    debit -> closing_debit, credit -> closing_credit; a null side is
    ABSENT, a stated 0 is ZERO Money.
  * balance-only form (both sides null, balance not null): `balance`
    is a single signed, debit-positive column — it lands on the
    closing side its SIGN selects: balance >= 0 -> closing_debit =
    balance; balance < 0 -> closing_credit = -balance. The atom id is
    recorded in source_meta["balance_form"] so the legacy shape (one
    signed `balance` field, sides null) is reconstructible verbatim.
  * degenerate both-form (a side AND balance present — the schema says
    either/or, but the lane's coercion preserves all three): the sides
    map to slots (matching `ExtractedRow.debit_signed`, which ignores
    `balance` when a side exists) and the raw balance value rides
    source_meta["extra_balance"] so nothing is lost.
  * all-null row: every slot ABSENT.

The document's own totals row is copied VERBATIM into
`header.document_totals` (closing pair; null sides ABSENT) — never
recomputed from rows.

PROVENANCE — method='llm'. The extract stage emits no per-row
confidence (calibrated per-account confidence appears at the classify
stage, which is NOT part of this front-end); `hints["confidence"]`
applies document-wide, defaulting to 0.6 — the same figure
`run_ai_lane` stamps on its parsed payload. The strict JSON carries no
source coordinates, so atoms use a stage ref and the gap is diagnosed.

Mixed-provenance note: any document containing even one atom built here
answers `engine.ir.has_llm_atoms(doc) == True` — the data-keyed hook
for the 'llm => never BALANCED' serving cap re-key at cutover.
"""
from __future__ import annotations

from types import SimpleNamespace
from typing import Any, Dict, List, Optional, Tuple

from engine.ir import (
    AccountAtom,
    DocHeader,
    DocumentTotals,
    LedgerDoc,
    Money,
    Provenance,
    SourceRef,
)

from .saga10 import float_to_money, repr_of

__all__ = ["LlmExtractFrontEnd", "LEGACY_SHAPE_AI_EXTRACT"]

LEGACY_SHAPE_AI_EXTRACT = "ai_extract_rows"

#: Document-wide default confidence for extract-stage atoms — mirrors
#: the `confidence: 0.6` run_ai_lane stamps on its parsed payload.
DEFAULT_LLM_CONFIDENCE = 0.6


class _EchoClient:
    """The AI lane's injectable-client seam, replaying fixed bytes: every
    `messages.create` call returns the same recorded response text, so
    `call_strict_json`'s parse (and its malformed-JSON retry protocol)
    runs against the given payload with zero model involvement."""

    def __init__(self, text: str) -> None:
        self.messages = SimpleNamespace(
            create=lambda **_kwargs: SimpleNamespace(
                content=[SimpleNamespace(type="text", text=text)]
            )
        )


class LlmExtractFrontEnd:
    format_id = "llm_extract"

    @property
    def version(self) -> str:
        from engine.ai_lane import config as _cfg
        return "%s+%s" % (_cfg.AI_LANE_PARSER_VERSION, _cfg.EXTRACT_PROMPT_VERSION)

    @property
    def spec(self) -> str:
        return "%s@%s" % (self.format_id, self.version)

    def parse(
        self, data: bytes, hints: Optional[Dict[str, Any]] = None
    ) -> Tuple[LedgerDoc, List[Dict[str, str]]]:
        from engine.ai_lane import extract as _extract_mod
        from engine.ai_lane.schemas import FormatDetectResult

        hints = dict(hints or {})
        filename = str(hints.get("filename") or "")
        jurisdiction = str(hints.get("jurisdiction") or "OTHER")
        currency = str(
            hints.get("currency")
            or ("HUF" if jurisdiction == "HU" else "EUR")  # run_ai_lane's default
        )
        confidence = float(hints.get("confidence", DEFAULT_LLM_CONFIDENCE))

        text = data.decode("utf-8")
        extract_result = _extract_mod.run_extract(
            "",  # doc_text feeds only the prompt; the echo client ignores it
            FormatDetectResult(),
            jurisdiction=jurisdiction,
            filename=filename,
            client=_EchoClient(text),
        )

        diagnostics: List[Dict[str, str]] = [{
            "code": "cell_provenance_unavailable",
            "detail": "extract-stage strict JSON carries no source "
                      "coordinates; atoms use a stage ref",
        }]
        provenance = Provenance(
            source_ref=SourceRef.pipeline_stage("frontend:%s" % self.format_id),
            method="llm",
            confidence=confidence,
        )

        atoms: List[AccountAtom] = []
        balance_form: List[str] = []
        extra_balance: Dict[str, str] = {}
        overrides: Dict[str, Dict[str, str]] = {}

        def _money(atom_id: str, legacy_field: str, value: float) -> Money:
            money, override = float_to_money(value, currency)
            if override is not None:
                overrides.setdefault(atom_id, {})[legacy_field] = override
                diagnostics.append({
                    "code": "float_repr_override",
                    "detail": "%s %s=%s exceeds exact Money encoding; exact "
                              "repr preserved in source_meta"
                              % (atom_id, legacy_field, override),
                })
            return money

        for index, row in enumerate(extract_result.rows):
            atom_id = "r%05d:%s" % (index, row.code)
            slots: Dict[str, Optional[Money]] = {}
            if row.debit is not None or row.credit is not None:
                if row.debit is not None:
                    slots["closing_debit"] = _money(atom_id, "debit", row.debit)
                if row.credit is not None:
                    slots["closing_credit"] = _money(atom_id, "credit", row.credit)
                if row.balance is not None:
                    # Degenerate both-form — keep the raw value so the
                    # legacy row reconstructs verbatim.
                    extra_balance[atom_id] = repr_of(float(row.balance))
            elif row.balance is not None:
                balance_form.append(atom_id)
                if row.balance >= 0:
                    slots["closing_debit"] = _money(atom_id, "balance", row.balance)
                else:
                    money, override = float_to_money(-row.balance, currency)
                    if override is not None:
                        # Preserve the ORIGINAL signed repr, not the negated one.
                        overrides.setdefault(atom_id, {})["balance"] = repr_of(
                            float(row.balance)
                        )
                        diagnostics.append({
                            "code": "float_repr_override",
                            "detail": "%s balance=%s exceeds exact Money "
                                      "encoding; exact repr preserved in "
                                      "source_meta" % (atom_id, repr_of(float(row.balance))),
                        })
                    slots["closing_credit"] = money
            # all-null row: every slot stays ABSENT.
            atoms.append(AccountAtom(
                atom_id=atom_id,
                account_code=row.code,
                label=row.label,
                provenance=provenance,
                **slots
            ))

        totals_overrides: Dict[str, str] = {}
        document_totals: Optional[DocumentTotals] = None
        if extract_result.totals_debit is not None or extract_result.totals_credit is not None:
            totals_slots: Dict[str, Money] = {}
            for side, value in (
                ("debit", extract_result.totals_debit),
                ("credit", extract_result.totals_credit),
            ):
                if value is None:
                    continue
                money, override = float_to_money(float(value), currency)
                if override is not None:
                    totals_overrides[side] = override
                    diagnostics.append({
                        "code": "float_repr_override",
                        "detail": "totals %s=%s exceeds exact Money encoding; "
                                  "exact repr preserved in source_meta"
                                  % (side, override),
                    })
                totals_slots["closing_%s" % side] = money
            document_totals = DocumentTotals(**totals_slots)

        source_meta: Dict[str, Any] = {
            "front_end": self.spec,
            "legacy_shape": LEGACY_SHAPE_AI_EXTRACT,
            "original_filename": filename,
            "balance_form": balance_form,
            "extra_balance": extra_balance,
            "float_repr_overrides": overrides,
            "totals_overrides": totals_overrides,
        }

        header = DocHeader(
            jurisdiction=jurisdiction,
            currency=currency,
            document_totals=document_totals,
            source_meta=source_meta,
        )
        return LedgerDoc(header=header, atoms=tuple(atoms)), diagnostics
