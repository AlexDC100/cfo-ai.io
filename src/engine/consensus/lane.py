"""CONSENSUS LANE ORCHESTRATION.

Two entry points, both jurisdiction-blind (jurisdiction arrives as a
parameter and reaches pack behaviour only through
``engine.core.country_pack_registry.get_pack``):

``run_dual_map_lane`` — the C2 lane, invoked by the pipeline's parse-
failure branch (env gate ``AI_STRUCTURAL_READER=1``, default OFF)
BEFORE the freeform-LLM fallback:

  1. Two INDEPENDENT structural interpretations (framings a + b — two
     registry roles, two prompts) produce two StructuralMaps. The AI
     emits STRUCTURE ONLY; it never sees or produces a numeric value.
  2. Each map is executed MECHANICALLY by the map_guided front-end
     (per-cell reads, exact Money bridge, per-cell provenance).
  3. The two readings are compared atom-by-atom in integer cents.
     Structural misalignment → the lane REFUSES (returns None) and the
     pipeline falls through to the freeform LLM exactly as before.
  4. The three-leg E9 verdict is computed (full dual consensus; totals
     row exact — via the REAL compute_source_anchor output on the
     mapped doc; layout-conditional movement identity). Serving reads
     framing A; ANY value disagreement becomes a needs-review atom
     (E3 — never silent) and forfeits BALANCED via the verdict.
  5. Returns a `parsed`-payload dict compatible with the pipeline's
     ``_deterministic_tb_parsed`` shape, with
     ``extraction.method == "mechanical_mapped"`` and the consensus
     block riding ``extraction["consensus"]`` (the canonical builder
     pops it out to the top-level ``canonical_bs.consensus`` key).

``run_c1_consensus`` — the C1 probe for documents the classic parser
already reads (gates ``CONSENSUS_SHADOW=1`` log-only /
``CONSENSUS_ENABLED=1`` persisted): one cached interpretation + one
mechanical mapped read, compared against the CLASSIC rows. The classic
reading is ALWAYS what is served (E4) — the returned block is
comparison metadata only and is attached additively at stage_persist.

AI-call discipline: model interaction happens ONLY inside
``engine.interp`` through an injectable ``client_factory``; tests
inject scripted ``interpret_fn`` callables and this module never
imports the SDK.
"""
from __future__ import annotations

import logging
from typing import Any, Callable, Dict, List, Optional, Tuple

from .compare import compare_readings
from .selfcheck import (
    CUMULATIVE_MOVEMENTS,
    CUMULATIVE_WITH_OPENING,
    movement_leg,
    totals_leg_from_anchor,
)
from .verdict import three_leg_verdict

logger = logging.getLogger("engine.consensus.lane")

#: Env gates (documented in the package docstring; all default OFF).
ENV_STRUCTURAL_READER = "AI_STRUCTURAL_READER"
ENV_SHADOW = "CONSENSUS_SHADOW"
ENV_ENABLED = "CONSENSUS_ENABLED"

#: legacy row field -> the StructuralMap column semantics that feed it.
_FIELD_SEMANTICS: Tuple[Tuple[str, Tuple[str, ...]], ...] = (
    ("si_d", ("opening_debit",)),
    ("si_c", ("opening_credit",)),
    ("r_d", ("movement_period_debit",)),
    ("r_c", ("movement_period_credit",)),
    ("st_d", ("total_with_opening_debit", "movement_cumulative_debit")),
    ("st_c", ("total_with_opening_credit", "movement_cumulative_credit")),
    ("sf_d", ("closing_debit",)),
    ("sf_c", ("closing_credit",)),
)


def _default_interpret(
    content: bytes,
    filename: str,
    *,
    jurisdiction: str,
    framing: str,
    client_factory: Optional[Callable[[], Any]] = None,
) -> Tuple[Any, Dict[str, Any]]:
    """Cached structural interpretation (a fingerprint/content hit makes
    ZERO model calls). The interp package owns roles, prompts, breaker
    and cache policy — this is just the seam."""
    from engine.interp.cache import FileCacheStore, interpret_with_cache

    return interpret_with_cache(
        content,
        filename,
        jurisdiction=jurisdiction,
        framing=framing,
        store=FileCacheStore(),
        client_factory=client_factory,
    )


def _map_dict(smap: Any) -> Dict[str, Any]:
    if hasattr(smap, "to_json_dict"):
        return smap.to_json_dict()
    return dict(smap)


def _semantics_index(map_dict: Dict[str, Any]) -> Dict[str, int]:
    out: Dict[str, int] = {}
    for col in map_dict.get("columns") or []:
        if isinstance(col, dict) and isinstance(col.get("semantic"), str):
            try:
                out[col["semantic"]] = int(col["index"])
            except (TypeError, ValueError):
                continue
    return out


def _cumulative_semantics(map_dict: Dict[str, Any]) -> Optional[str]:
    sems = _semantics_index(map_dict)
    if "total_with_opening_debit" in sems or "total_with_opening_credit" in sems:
        return CUMULATIVE_WITH_OPENING
    if "movement_cumulative_debit" in sems or "movement_cumulative_credit" in sems:
        return CUMULATIVE_MOVEMENTS
    return None


def _mapped_view(
    content: bytes,
    filename: str,
    jurisdiction: str,
    smap: Any,
    *,
    currency: Optional[str] = None,
) -> Tuple[Any, Any, Dict[str, Any]]:
    """Execute one StructuralMap mechanically. Returns
    (ledger_doc, legacy_view, map_dict). The mechanical executor and the
    legacy bridge are the REAL front-end seams — never mirrored here."""
    from engine.frontends.map_guided import MapGuidedFrontEnd
    from engine.frontends.map_guided_legacy import derive_map_guided_legacy

    map_dict = _map_dict(smap)
    hints: Dict[str, Any] = {
        "structural_map": map_dict,
        "jurisdiction": jurisdiction,
        "filename": filename,
    }
    cur = map_dict.get("currency") or currency
    if cur:
        hints["currency"] = cur
    doc, _diagnostics = MapGuidedFrontEnd().parse(content, hints=hints)
    view = derive_map_guided_legacy(doc)
    return doc, view, map_dict


def _source_refs(doc: Any, map_dict: Dict[str, Any]) -> Dict[str, Any]:
    """Grid coordinates for the mapped reading: per-row grid indices
    from the per-atom cell provenance, per-field grid columns from the
    map's semantics."""
    sems = _semantics_index(map_dict)
    cols: Dict[str, Optional[int]] = {}
    for field, candidates in _FIELD_SEMANTICS:
        col = None
        for sem in candidates:
            if sem in sems:
                col = sems[sem]
                break
        cols[field] = col
    rows: List[Optional[int]] = []
    sheet = map_dict.get("sheet")
    for atom in getattr(doc, "atoms", ()) or ():
        ref = getattr(getattr(atom, "provenance", None), "source_ref", None)
        rows.append(getattr(ref, "row", None))
        if sheet is None:
            sheet = getattr(ref, "sheet", None)
    return {"sheet": sheet, "rows": rows, "cols": cols}


def _atoms_from_disagreements(
    disagreements: List[Dict[str, Any]], consensus_pct: float,
) -> List[Dict[str, Any]]:
    """E3 — one needs-review atom per value disagreement, in the
    existing ai_lane atom shape (alias-tolerant on the FE). `amount` is
    the SERVED reading (side A: classic on C1, framing A on C2); the
    rationale names both readings so neither is silently dropped."""
    atoms: List[Dict[str, Any]] = []
    for d in disagreements:
        amount = d.get("classic_cents", 0) / 100.0
        atoms.append({
            "code": d.get("code"),
            "name": d.get("name"),
            "line_id": None,
            "amount": amount,
            "section": "current_assets" if amount >= 0 else "current_liabilities",
            "confidence": round(float(consensus_pct) / 100.0, 4),
            "rationale": "readings A=%.2f B=%.2f (%s)" % (
                d.get("classic_cents", 0) / 100.0,
                d.get("mapped_cents", 0) / 100.0,
                d.get("field"),
            ),
            "reason": "consensus_disagreement",
            "source_ref": d.get("source_ref"),
        })
    return atoms


def _compose_block(
    cmp: Dict[str, Any],
    *,
    totals_match: str,
    totals_pass: bool,
    movement: Optional[bool],
    mode: str,
    framings: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    full_consensus = bool(
        cmp["structural"]["aligned"]
        and not cmp["disagreements"]
        and cmp["consensus_pct"] == 100.0
    )
    verdict = three_leg_verdict(
        dual_map_full_consensus=full_consensus,
        totals_row_exact=totals_pass,
        movement_checks_pass=movement,
    )
    block: Dict[str, Any] = {
        "schema": "consensus_v1",
        "mode": mode,
        "consensus_pct": cmp["consensus_pct"],
        "atoms_compared": cmp["atoms_compared"],
        "disagreements": cmp["disagreements"],
        "structural": cmp["structural"],
        "totals_match": totals_match,
        "legs": verdict["legs"],
        "eligible_balanced": verdict["eligible_balanced"],
        "needs_review": _atoms_from_disagreements(
            cmp["disagreements"], cmp["consensus_pct"]
        ),
    }
    if framings:
        block["framings"] = framings
    return block


def _framing_meta(meta: Any) -> Dict[str, Any]:
    if not isinstance(meta, dict):
        return {}
    keep = ("role", "framing", "model_id", "prompt_version",
            "map_version", "map_hash", "cached")
    return {k: meta[k] for k in keep if k in meta}


def run_dual_map_lane(
    content: bytes,
    filename: str,
    jurisdiction: str,
    *,
    client_factory: Optional[Callable[[], Any]] = None,
    interpret_fn: Optional[Callable[..., Tuple[Any, Dict[str, Any]]]] = None,
    currency: Optional[str] = None,
    movement_override: Optional[bool] = None,
) -> Optional[Dict[str, Any]]:
    """The C2 dual-map lane. Returns a `parsed` payload (see module
    docstring) or None — None means "fall through to the freeform LLM
    fallback exactly as before". Never raises."""
    # ── Format-learning template-first gate (Part F) ────────────────
    # A CONFIRMED template for this layout fingerprint replaces the two
    # interpreter calls entirely: the stored map was dual-verified when
    # learned and human-confirmed since (lookup serves confirmed only).
    # The totals leg below STAYS mandatory either way. Best-effort: any
    # store/fingerprint failure degrades to the dual-map path.
    template_fp: Optional[str] = None
    template_map: Optional[Dict[str, Any]] = None
    template_store = None
    try:
        from engine.interp.fingerprint import layout_fingerprint
        from engine.interp.templates import TemplateStore
        template_fp = layout_fingerprint(content)
        template_store = TemplateStore()
        template_map = template_store.lookup(template_fp)
    except Exception as e:  # noqa: BLE001 — telemetry seam, never blocks
        logger.info(
            "[consensus.c2] template store unavailable (%s: %s) — dual-map",
            type(e).__name__, str(e)[:160],
        )

    interpret = interpret_fn or _default_interpret
    meta_a: Dict[str, Any] = {}
    meta_b: Dict[str, Any] = {}
    if template_map is not None:
        # Template hit: one confirmed map serves both readings; zero AI
        # calls. mode="template" records the provenance honestly.
        smap_a = smap_b = template_map
        meta_a = meta_b = {"template_fingerprint": template_fp}
    else:
        try:
            smap_a, meta_a = interpret(
                content, filename, jurisdiction=jurisdiction, framing="a",
                client_factory=client_factory,
            )
            smap_b, meta_b = interpret(
                content, filename, jurisdiction=jurisdiction, framing="b",
                client_factory=client_factory,
            )
        except Exception as e:  # noqa: BLE001 — the lane must never block the pipeline
            logger.info(
                "[consensus.c2] structural interpretation unavailable (%s: %s) — "
                "falling through", type(e).__name__, str(e)[:200],
            )
            return None

    try:
        doc_a, view_a, map_dict_a = _mapped_view(
            content, filename, jurisdiction, smap_a, currency=currency,
        )
        _doc_b, view_b, _map_dict_b = _mapped_view(
            content, filename, jurisdiction, smap_b, currency=currency,
        )
    except Exception as e:  # noqa: BLE001
        logger.info(
            "[consensus.c2] mechanical mapped read failed (%s: %s) — "
            "falling through", type(e).__name__, str(e)[:200],
        )
        return None

    rows_a = [r for r in view_a.tb_rows if isinstance(r, dict)]
    rows_b = [r for r in view_b.tb_rows if isinstance(r, dict)]
    cmp = compare_readings(
        rows_a, rows_b, source_refs=_source_refs(doc_a, map_dict_a),
    )
    if not cmp["structural"]["aligned"]:
        logger.info(
            "[consensus.c2] structural misalignment between framings "
            "(A=%d rows, B=%d rows) — falling through",
            cmp["structural"]["row_count_a"], cmp["structural"]["row_count_b"],
        )
        return None

    anchor = getattr(view_a.tb_rows, "source_anchor", None)
    totals_match, totals_pass = totals_leg_from_anchor(anchor, rows_a)
    movement = movement_override
    if movement is None:
        # Full movement intelligence (Part D) when available: the
        # convention probe + M1/M2/M3 findings supersede the lane's
        # minimal per-row identity leg. Best-effort — the minimal leg
        # remains the fallback.
        probe_ran = False
        try:
            from engine.passes.movements import (
                compute_movement_checks, movement_checks_pass,
            )
            probe = compute_movement_checks(
                rows_a,
                None,
                layout_hint={"synthesized_sf": _synthesized_sf(doc_a)},
            )
            probe_ran = isinstance(probe, dict)
            movement = movement_checks_pass(probe)
        except Exception as e:  # noqa: BLE001
            logger.info(
                "[consensus] movement probe unavailable (%s) — minimal leg",
                type(e).__name__,
            )
        # Hardened 2026-08-25: when the full probe RAN, its verdict
        # stands — None fails closed at the E9 verdict. The weaker
        # per-row leg is only the fallback for a probe that could not
        # run at all (import/CHECK_IMPLS failure), never a second
        # opinion that can overrule an indecisive probe.
        if movement is None and not probe_ran:
            movement = movement_leg(
                rows_a,
                cumulative_semantics=_cumulative_semantics(map_dict_a),
                synthesized_sf=_synthesized_sf(doc_a),
            )
    block = _compose_block(
        cmp,
        totals_match=totals_match,
        totals_pass=totals_pass,
        movement=movement,
        mode="template" if template_map is not None else "dual_map",
        framings={"a": _framing_meta(meta_a), "b": _framing_meta(meta_b)},
    )
    if template_fp is not None:
        block["template_fingerprint"] = template_fp

    shaped = view_a.assemble_shape
    if shaped is None:
        logger.info(
            "[consensus.c2] no country pack registered for jurisdiction %r — "
            "falling through", jurisdiction,
        )
        return None
    from engine.core.country_pack_registry import get_pack
    pack = get_pack(jurisdiction)
    if pack is None:
        return None

    tb = view_a.tb_rows
    extraction = dict(getattr(tb, "extraction", {}) or {})
    if meta_a:
        extraction.setdefault("model", meta_a.get("model_id"))
        extraction.setdefault("prompt_version", meta_a.get("prompt_version"))
    # The consensus block rides the extraction dict through the existing
    # assemble plumbing; build_canonical_bs_v2 pops it to the top-level
    # canonical_bs.consensus key (it never serves inside extraction).
    extraction["consensus"] = block
    if template_fp is not None:
        # Stamped on hit AND miss so the human-confirm flow can find the
        # layout this document exercised (Part F confirm/promotion loop).
        extraction["template_fingerprint"] = template_fp
    if template_store is not None and template_map is None:
        # Miss + a validated map: park it as a CANDIDATE (never served
        # until human-confirmed). Additive-only-when-absent; best-effort.
        try:
            template_store.record_candidate(
                template_fp,
                map_dict_a,
                created_from={
                    "roles": [
                        str(meta_a.get("role") or "structural_interpreter_a"),
                        str(meta_b.get("role") or "structural_interpreter_b"),
                    ],
                    "prompt_versions": [
                        str(meta_a.get("prompt_version") or ""),
                        str(meta_b.get("prompt_version") or ""),
                    ],
                    "map_hash": str(map_dict_a.get("map_hash") or ""),
                },
            )
        except Exception as e:  # noqa: BLE001
            logger.info(
                "[consensus.c2] candidate template not recorded (%s)",
                type(e).__name__,
            )

    def _safe(callable_name: str, arg: Any) -> Any:
        fn = getattr(pack, callable_name, None)
        if fn is None:
            return None
        try:
            return fn(arg)
        except Exception:  # noqa: BLE001
            return None

    payload: Dict[str, Any] = {
        "company_name": (filename or "Imported entity").rsplit("/", 1)[-1].rsplit(".", 1)[0]
        or "Imported entity",
        "period_label": "Imported period",
        "period_end": None,
        "currency": str(
            map_dict_a.get("currency") or currency or
            getattr(getattr(doc_a, "header", None), "currency", None) or "RON"
        ),
        "confidence": 0.9,
        "detected_type": "trial_balance",
        "accounts": list(shaped),
        "warnings": [],
        "source_data_quality": _safe("compute_source_imbalance", tb),
        "statutory_net_profit_anchor": _safe("compute_statutory_net_profit_anchor", tb),
        "source_anchor": getattr(tb, "source_anchor", None),
        "extraction": extraction,
        "parser_unmapped": list(getattr(shaped, "unmapped", None) or []),
        "parser_excluded": list(getattr(shaped, "excluded", None) or []),
        "source_account_census": _safe("deterministic_source_census", shaped),
    }
    logger.info(
        "[consensus.c2] dual-map lane produced %d rows: consensus_pct=%s "
        "atoms=%d disagreements=%d totals=%s movement=%s eligible=%s",
        len(rows_a), block["consensus_pct"], block["atoms_compared"],
        len(block["disagreements"]), totals_match, movement,
        block["eligible_balanced"],
    )
    return payload


def _synthesized_sf(doc: Any) -> bool:
    try:
        meta = doc.header.source_meta
        return bool(meta.get("synthesized_sf"))
    except Exception:  # noqa: BLE001
        return False


def run_c1_consensus(
    content: bytes,
    filename: str,
    jurisdiction: str,
    classic_rows: Any,
    *,
    client_factory: Optional[Callable[[], Any]] = None,
    interpret_fn: Optional[Callable[..., Tuple[Any, Dict[str, Any]]]] = None,
    currency: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """The C1 classic-vs-mapped consensus block for a document the
    classic parser already reads. Side A = the CLASSIC rows (what is
    served — E4); side B = the mechanical mapped read. Returns the
    consensus block, or None when no comparison could be set up. The
    caller decides logging vs persistence (the two gates). Never raises
    into the pipeline (callers guard, this logs)."""
    interpret = interpret_fn or _default_interpret
    try:
        smap, meta = interpret(
            content, filename, jurisdiction=jurisdiction, framing="a",
            client_factory=client_factory,
        )
        doc_b, view_b, map_dict = _mapped_view(
            content, filename, jurisdiction, smap, currency=currency,
        )
    except Exception as e:  # noqa: BLE001
        logger.info(
            "[consensus.c1] probe unavailable (%s: %s)",
            type(e).__name__, str(e)[:200],
        )
        return None

    rows_a = [r for r in (classic_rows or []) if isinstance(r, dict)]
    rows_b = [r for r in view_b.tb_rows if isinstance(r, dict)]
    cmp = compare_readings(
        rows_a, rows_b, source_refs=_source_refs(doc_b, map_dict),
    )
    anchor = getattr(view_b.tb_rows, "source_anchor", None)
    totals_match, totals_pass = totals_leg_from_anchor(anchor, rows_b)
    movement: Optional[bool] = None
    try:
        # Full Part D probe first (same upgrade as the C2 lane).
        from engine.passes.movements import (
            compute_movement_checks, movement_checks_pass,
        )
        probe = compute_movement_checks(
            rows_b,
            None,
            layout_hint={"synthesized_sf": _synthesized_sf(doc_b)},
        )
        movement = movement_checks_pass(probe)
    except Exception:  # noqa: BLE001
        pass
    if movement is None:
        movement = movement_leg(
            rows_b,
            cumulative_semantics=_cumulative_semantics(map_dict),
            synthesized_sf=_synthesized_sf(doc_b),
        )
    return _compose_block(
        cmp,
        totals_match=totals_match,
        totals_pass=totals_pass,
        movement=movement,
        mode="classic_vs_mapped",
        framings={"a": _framing_meta(meta)},
    )
