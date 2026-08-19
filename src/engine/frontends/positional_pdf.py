"""Positional-PDF front-end — wraps the RO country pack's PyMuPDF
trial-balance ingester (`pdf_ingester`).

WHY THIS ADAPTER READS THE INGESTER'S RAW ROWS (not its public entry):
Romanian RAS PDFs print FIVE column pairs per account — sold initial,
rulaj precedent, rulaj curent, sume totale, sold final. The public
`parse_pdf_trial_balance` collapses `rulaj_prec + rulaj_cur` into the
legacy `r_d`/`r_c` fields by FLOAT ADDITION, and that sum is frequently
not representable as exact decimal minor units (corpus `pdf_positional`
carries 44 such sums, e.g. 0.1-plus-0.2-style 33096.729999999996). Two
of the file's own pairs, each an exact 2-decimal parse, must therefore
be carried separately so the legacy value can be reproduced bit-exactly
by REDOING the identical float addition (prec + cur, in that order):

    sold_init  -> opening_debit / opening_credit
    rulaj_cur  -> period_debit / period_credit   (the current period's
                                                  own movement)
    sold_fin   -> closing_debit / closing_credit
    rulaj_prec -> source_meta["rulaj_prec"] side-channel (exact reprs)
    sume_tot   -> source_meta["rc_pair"]     side-channel (exact reprs)

The success path calls the ingester's own extraction/leaf-filter
functions (`_parse_pdf_to_rows_with_locale`, `_filter_to_leaves`) on
the raw bytes; the failure paths DELEGATE to the public
`parse_pdf_trial_balance` so the canonical `PdfIngestError` messages
are raised by the parser itself, never mirrored here. The equivalence
suite pins this composition against the public entry corpus-wide.

Provenance: method='mechanical', confidence 1.0. The ingester loses the
per-row page/bbox geometry before returning (rows carry no
coordinates), so atoms use a stage ref and the gap is diagnosed —
real {page, bbox} SourceRefs land at cutover when the ingester emits
them.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from engine.ir import (
    AccountAtom,
    DocHeader,
    LedgerDoc,
    Provenance,
    SourceRef,
)

from .saga10 import (
    META_EXTRACTION,
    META_FRONT_END,
    META_LEGACY_SHAPE,
    META_OVERRIDES,
    META_PAIRS_PRESENT,
    META_RC_PAIR,
    META_RULAJ_PREC,
    META_SYNTHESIZED_SF,
    META_TOTALS_ROW_INDEX,
    LEGACY_SHAPE_TB_ROWS,
    FrontEndError,
    _carries_value,
    float_to_money,
    repr_of,
)


__all__ = ["PositionalPdfFrontEnd"]

#: raw ingester row key -> (atom slot | None) for the three slot pairs.
_RAW_SLOTS: Tuple[Tuple[str, str, str], ...] = (
    # (raw debit key, raw credit key, slot prefix)
    ("sold_init_D", "sold_init_C", "opening"),
    ("rulaj_cur_D", "rulaj_cur_C", "period"),
    ("sold_fin_D", "sold_fin_C", "closing"),
)

#: raw ingester key -> the legacy tb_rows field the value feeds, for
#: override bookkeeping (`derive_legacy` applies overrides to the slot-
#: carried component BEFORE the prec+cur addition rebuilds r_d/r_c).
_RAW_TO_LEGACY: Dict[str, str] = {
    "sold_init_D": "si_d", "sold_init_C": "si_c",
    "rulaj_cur_D": "r_d", "rulaj_cur_C": "r_c",
    "sold_fin_D": "sf_d", "sold_fin_C": "sf_c",
}


class PositionalPdfFrontEnd:
    format_id = "pdf_positional"

    @property
    def version(self) -> str:
        from engine.country_packs.ro_romania.trial_balance_parser import PARSER_VERSION
        return PARSER_VERSION

    @property
    def spec(self) -> str:
        return "%s@%s" % (self.format_id, self.version)

    def parse(
        self, data: bytes, hints: Optional[Dict[str, Any]] = None
    ) -> Tuple[LedgerDoc, List[Dict[str, str]]]:
        from engine.country_packs.ro_romania import pdf_ingester as _pdf

        hints = dict(hints or {})
        filename = str(hints.get("filename") or "")
        currency = str(hints.get("currency") or "RON")
        jurisdiction = str(hints.get("jurisdiction") or "RO")
        keep_leaves_only = bool(hints.get("keep_leaves_only", True))

        if not _pdf.is_pdf(data):
            # Delegate to the public entry so the canonical error (same
            # class, same user_message) is raised by the parser itself.
            _pdf.parse_pdf_trial_balance(data, filename)
            raise FrontEndError("is_pdf disagreed with parse_pdf_trial_balance")

        raw_rows, locale = _pdf._parse_pdf_to_rows_with_locale(data)
        if not raw_rows:
            _pdf.parse_pdf_trial_balance(data, filename)  # raises the canonical error
            raise FrontEndError("empty raw rows but public entry succeeded")
        if keep_leaves_only:
            raw_rows = _pdf._filter_to_leaves(raw_rows)

        from engine.country_packs.ro_romania.trial_balance_parser import PARSER_VERSION

        diagnostics: List[Dict[str, str]] = [{
            "code": "cell_provenance_unavailable",
            "detail": "pdf_ingester rows carry no page/bbox geometry; atoms "
                      "use a stage ref until cutover",
        }]
        provenance = Provenance.mechanical(
            SourceRef.pipeline_stage("frontend:%s" % self.format_id)
        )

        atoms: List[AccountAtom] = []
        rc_pair: Dict[str, List[str]] = {}
        rulaj_prec: Dict[str, List[str]] = {}
        overrides: Dict[str, Dict[str, str]] = {}

        for index, row in enumerate(raw_rows):
            code = str(row.get("cont") or "").strip()
            atom_id = "r%05d:%s" % (index, code)
            slots: Dict[str, Any] = {}
            for d_key, c_key, slot_prefix in _RAW_SLOTS:
                for raw_key, side in ((d_key, "debit"), (c_key, "credit")):
                    value = float(row.get(raw_key) or 0.0)
                    money, override = float_to_money(value, currency)
                    if override is not None:
                        legacy_field = _RAW_TO_LEGACY[raw_key]
                        overrides.setdefault(atom_id, {})[legacy_field] = override
                        diagnostics.append({
                            "code": "float_repr_override",
                            "detail": "%s %s=%s exceeds exact Money encoding; "
                                      "exact repr preserved in source_meta"
                                      % (atom_id, legacy_field, override),
                        })
                    slots["%s_%s" % (slot_prefix, side)] = money

            prec_d = float(row.get("rulaj_prec_D") or 0.0)
            prec_c = float(row.get("rulaj_prec_C") or 0.0)
            if _carries_value(prec_d, prec_c):
                rulaj_prec[atom_id] = [repr_of(prec_d), repr_of(prec_c)]
            st_d = float(row.get("sume_tot_D") or 0.0)
            st_c = float(row.get("sume_tot_C") or 0.0)
            if _carries_value(st_d, st_c):
                rc_pair[atom_id] = [repr_of(st_d), repr_of(st_c)]

            atoms.append(AccountAtom(
                atom_id=atom_id,
                account_code=code,
                label=str(row.get("nume") or ""),
                provenance=provenance,
                **slots
            ))

        source_meta: Dict[str, Any] = {
            META_FRONT_END: self.spec,
            META_LEGACY_SHAPE: LEGACY_SHAPE_TB_ROWS,
            "original_filename": filename,
            META_EXTRACTION: {
                # Mirrors parse_pdf_trial_balance's extraction block —
                # pinned by the corpus equivalence suite.
                "method": "deterministic",
                "parser_version": PARSER_VERSION,
                "source_format": "pdf_positional",
                "number_locale": locale,
                "sheet": None,
                "header_row_index": None,
            },
            # parse_pdf_trial_balance computes its anchor with
            # compute_source_anchor(shaped, file_totals=None) — default
            # pairs_present (None = all pairs present), no totals row
            # (PDF totals lines are skip-filtered), nothing synthesized.
            META_PAIRS_PRESENT: None,
            META_TOTALS_ROW_INDEX: None,
            META_SYNTHESIZED_SF: False,
            META_RC_PAIR: rc_pair,
            META_RULAJ_PREC: rulaj_prec,
            META_OVERRIDES: overrides,
        }

        header = DocHeader(
            jurisdiction=jurisdiction,
            currency=currency,
            document_totals=None,  # no totals row survives the PDF skip-filters
            source_meta=source_meta,
        )
        return LedgerDoc(header=header, atoms=tuple(atoms)), diagnostics
