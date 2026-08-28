"""PS3 — the deterministic public_summary envelope.

``build_public_summary(cui, year)`` is a PURE FUNCTION of the stored
(cui, year, dataset_version) snapshot: byte-identical forever for the
same inputs. Serialization is canonical (sorted keys, compact
separators, UTF-8) and the ``content_hash`` is the sha256 of the
canonical JSON WITH the volatile ``fetch_date`` (and the hash field
itself) EXCLUDED — fetch_date still travels in provenance for honesty,
it just never moves the identity.

public_summary is a NEW top-level envelope kind. It NEVER rides
canonical_bs, NEVER enters MACHINE_STATUSES ("BALANCED", "RECONCILED",
"MINOR_DRIFT", "MATERIAL_IMBALANCE"), packs, reconcile, or consensus —
its status string is exactly "PUBLIC_SUMMARY" and the spine's tests
lock that it stays outside the machine ladder.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any, Dict, Optional

from .store import PublicRoStore

PUBLIC_SUMMARY_VERSION = "ps1"
PUBLIC_SUMMARY_STATUS = "PUBLIC_SUMMARY"

#: Canonical i-slot -> stable indicator name in the envelope. Order is
#: irrelevant (serialization sorts keys) but names are frozen: renaming
#: one would change every content_hash.
INDICATOR_NAMES: Dict[str, str] = {
    "i1": "active_imobilizate_total",
    "i2": "active_circulante_total",
    "i3": "stocuri",
    "i4": "creante",
    "i5": "casa_si_conturi_la_banci",
    "i6": "cheltuieli_in_avans",
    "i7": "datorii",
    "i8": "venituri_in_avans",
    "i9": "provizioane",
    "i10": "capitaluri_total",
    "i11": "capital_subscris_varsat",
    "i12": "patrimoniul_regiei",
    "i13": "cifra_de_afaceri_neta",
    "i14": "venituri_totale",
    "i15": "cheltuieli_totale",
    "i16": "profit_brut",
    "i17": "pierdere_bruta",
    "i18": "profit_net",
    "i19": "pierdere_neta",
    "i20": "numar_mediu_salariati",
    "i21": "patrimoniul_public",
}


class PublicSummaryNotFound(LookupError):
    pass


def canonical_json(obj: Any) -> str:
    return json.dumps(
        obj, sort_keys=True, ensure_ascii=False, separators=(",", ":")
    )


def _strip_volatile(node: Any) -> Any:
    """Remove fetch_date + content_hash recursively before hashing."""
    if isinstance(node, dict):
        return {
            k: _strip_volatile(v)
            for k, v in node.items()
            if k not in ("fetch_date", "content_hash")
        }
    if isinstance(node, list):
        return [_strip_volatile(v) for v in node]
    return node


def summary_content_hash(envelope: Dict[str, Any]) -> str:
    stable = _strip_volatile(envelope)
    return hashlib.sha256(canonical_json(stable).encode("utf-8")).hexdigest()


def build_public_summary(
    cui: int, year: int, *, store: Optional[PublicRoStore] = None
) -> Dict[str, Any]:
    """Build the {"public_summary": {...}} envelope for (cui, year).

    Raises PublicSummaryNotFound when the filing is absent. Does NOT
    check publishability — the serving lanes gate on
    companies.publishable + takedowns before anything is rendered;
    this function is the data shape, not the policy gate."""
    own_store = store is None
    store = store or PublicRoStore()
    try:
        filing = None
        for row in store.get_filings(int(cui)):
            if int(row["year"]) == int(year):
                filing = row
                break
        if filing is None:
            raise PublicSummaryNotFound(
                "no filing for cui=%s year=%s" % (cui, year)
            )
        provenance_src = filing.get("provenance") or {}

        indicators: Dict[str, int] = {}
        for slot, name in INDICATOR_NAMES.items():
            value = filing.get(slot)
            if value is not None:
                indicators[name] = int(value)

        derived: Dict[str, int] = {}
        for key in ("total_assets", "net_result"):
            if filing.get(key) is not None:
                derived[key] = int(filing[key])

        summary: Dict[str, Any] = {
            "version": PUBLIC_SUMMARY_VERSION,
            "cui": int(cui),
            "year": int(year),
            "dataset_version": filing.get("dataset_id"),
            "status": PUBLIC_SUMMARY_STATUS,
            "family": filing.get("family"),
            "caen": filing.get("caen"),
            "indicators": indicators,
            "derived": derived,
            "provenance": {
                "source": "data.gov.ro/mfp",
                "dataset_version": filing.get("dataset_id"),
                "dataset_sha256": provenance_src.get("dataset_sha256"),
                "license_id": provenance_src.get("license_id"),
                "fetch_date": provenance_src.get("fetch_date"),
                "cui": int(cui),
                "year": int(year),
            },
        }
        envelope = {"public_summary": summary}
        summary["provenance"]["content_hash"] = summary_content_hash(envelope)
        return envelope
    finally:
        if own_store:
            store.close()


def serialize_public_summary(envelope: Dict[str, Any]) -> bytes:
    """The one byte form (PS3): canonical JSON, UTF-8, trailing LF."""
    return (canonical_json(envelope) + "\n").encode("utf-8")
