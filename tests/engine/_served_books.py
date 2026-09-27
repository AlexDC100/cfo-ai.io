"""Real GET /api/period bodies for the ratio gates: the four corpus books
and the Scandia FY2025 regression baseline.

NO FAKE ASSEMBLER, NO MIRROR STORE. The corpus books are carried through
the production write path (`stage_map` -> `stage_persist`) by
`test_rebuild_net_income_anchor._Book`, and every body below is read back
through the REAL router over that module's projection-faithful Supabase
double (`_routed`). Imported, not copied: two gates that disagree about
what "served" means would each be green over a different product.

The Scandia baseline is a committed CAPTURE, not a corpus workbook: it
carries the persisted line items and the persisted `assembled_canonical_v1`,
so it is seeded as the row pair `stage_persist` would have written (period
row with that envelope, its line items) and read back through the same
route. It predates `pack_provenance`, the account-121 anchor and the
stock-variation evidence on its own envelope, which is exactly what a period
persisted before those stamps looks like when it is served today — a LEGACY
witness (its one EBITDA refuses `period_predates_stock_variation_
measurement`).

It is read from `regression_baselines/archive/scandia_fy2025_pre_one_ebitda
.json`: the parity pair itself was re-captured under the owner's 711 ruling
on 2026-09-27 (BASELINE_HISTORY) and now carries the evidence, so it is no
longer a legacy period. The archive is those same pre-ruling bytes.
"""
from __future__ import annotations

import copy
import json
import types
from pathlib import Path
from typing import Any, Dict, Tuple

from _pytest.monkeypatch import MonkeyPatch

import test_rebuild_net_income_anchor as ANCHOR

REPO = Path(__file__).resolve().parents[2]
SCANDIA_BASELINE = (REPO / "src" / "engine" / "country_packs" / "ro_romania" / "fixtures"
                    / "regression_baselines" / "archive" / "scandia_fy2025_pre_one_ebitda.json")

#: The four committed corpus books the ratio table is held to.
CORPUS_BOOKS: Tuple[str, ...] = ("agras", "carniprod", "realestate", "retail")
SCANDIA = "scandia_baseline"
ALL_BOOKS: Tuple[str, ...] = CORPUS_BOOKS + (SCANDIA,)

_BODIES: Dict[str, Dict[str, Any]] = {}
_BOOK_OBJ: Dict[str, Any] = {}


def _case(book: str):
    case_id = "saga_10_col_%s" % book
    for cid, cdir, _p121 in ANCHOR.ANCHOR_CASES:
        if cid == case_id:
            return cid, cdir
    raise AssertionError("corpus case %s is not in the anchor case list" % case_id)


def scandia_baseline_book(period_id: str = "period-scandia-fy2025"):
    doc = json.loads(SCANDIA_BASELINE.read_text(encoding="utf-8"))["assembled"]
    period = {
        "id": period_id, "org_id": "org-corpus", "source_document_id": None,
        "period_start": "2025-01-01", "period_end": "2025-12-31", "currency": "RON",
        "extraction_confidence": 1.0,
        "assembled_canonical_v1": doc["assembled_canonical_v1"],
    }
    line_items = [dict(li, period_id=period_id) for li in doc["lineItems"]]
    return types.SimpleNamespace(
        period=period, line_items=line_items,
        org={"id": "org-corpus", "name": "Scandia FY2025 regression baseline"},
        period_id=period_id,
        persist_assembled={"statements": doc["statements"],
                           "assembled_canonical_v1": doc["assembled_canonical_v1"]},
    )


def book(name: str):
    if name not in _BOOK_OBJ:
        if name == SCANDIA:
            _BOOK_OBJ[name] = scandia_baseline_book()
        else:
            cid, cdir = _case(name)
            _BOOK_OBJ[name] = ANCHOR._book(cid, cdir)
    return _BOOK_OBJ[name]


def routed_body(bk, metrics=None) -> Dict[str, Any]:
    """GET /api/period/{id} through the real router over `bk`'s persisted
    rows. `metrics` seeds `calculated_metrics` (default: none persisted)."""
    mp = MonkeyPatch()
    try:
        with ANCHOR._routed(bk, mp) as (client, db):
            if metrics:
                db.tables["calculated_metrics"] = [dict(m, period_id=bk.period_id) for m in metrics]
            resp = client.get("/api/period/%s" % bk.period_id,
                              headers={"Authorization": "Bearer test"})
    finally:
        mp.undo()
    assert resp.status_code == 200, resp.text[:400]
    return resp.json()


def served_body(name: str) -> Dict[str, Any]:
    """The cached route body for one of `ALL_BOOKS` (deep-copied)."""
    if name not in _BODIES:
        _BODIES[name] = routed_body(book(name))
    return copy.deepcopy(_BODIES[name])
