"""PUBLIC_SUMMARY presenter — the one wording authority for the
reduced open-data tier (ps1 envelopes, ``envelope["public_summary"]``).

``present_public_summary(envelope)`` is the summary-tier sibling of
``present_status`` for canonical servings: a PURE function of the
persisted envelope (no I/O, no DB lookup, no paywall-state fetch —
serving purity, same line as status.py). It NEVER touches the
BALANCED/RECONCILED/MINOR_DRIFT/MATERIAL_IMBALANCE ladder: a public
summary has no balance verdict, and ``PUBLIC_SUMMARY`` is a parallel
presentation status, never a fifth MACHINE_STATUSES member (the
legacy-lane ``status: null`` → UNVERIFIED precedent, servedFacts.ts).

Data facts baked into the wording (verified live research, 2026-08):
the source is data.gov.ro's CKAN portal, org mfp (Ministerul
Finanțelor), datasets ``situatii_financiare_<YEAR>`` — mass bilant
indicator files (I1..I20), CC-BY-4.0 for FY2019-FY2023 bilant +
identification datasets.

Import boundary: this module lives INSIDE src/engine/serving/ and is
re-exported via serving/__init__ (ALLOWED_SERVING_IMPORTS carries
``engine.serving.public_summary`` — scripts/check_import_boundary.py).
"""

from __future__ import annotations

from typing import Any, Dict, Optional

#: The public_summary envelope contract version. Parallel to (never
#: reusing) the canonical serve stamp "sv1" — a ps1 object cannot
#: satisfy the sv1 canonical_bs required-key contract and must not
#: claim conformance to it.
PUBLIC_SUMMARY_VERSION = "ps1"

#: The parallel presentation status. NEVER a MACHINE_STATUSES member.
PUBLIC_SUMMARY_STATUS = "PUBLIC_SUMMARY"

_DEFAULT_SOURCE = "data.gov.ro"
_DEFAULT_LICENSE_LINE = (
    "Conține informații publice · data.gov.ro / Ministerul Finanțelor · "
    "licența CC BY 4.0"
)


def present_public_summary(envelope: Any) -> Optional[Dict[str, Any]]:
    """The presentation object for one ps1 public_summary envelope.

    Returns ``{status, trust_en, trust_ro, source_line, license_line}``
    — or None when the envelope carries no public_summary block (the
    caller falls back to its canonical/legacy path). Pure and
    deterministic: same envelope, same output; the input is never
    mutated.
    """
    if not isinstance(envelope, dict):
        return None
    summary = envelope.get("public_summary")
    if not isinstance(summary, dict) or not isinstance(summary.get("indicators"), dict):
        return None

    provenance = summary.get("provenance") if isinstance(summary.get("provenance"), dict) else {}
    source = str(provenance.get("source") or _DEFAULT_SOURCE)
    # Trust lines name the portal, not the internal provenance path.
    source_label = _DEFAULT_SOURCE if _DEFAULT_SOURCE in source else source
    year = summary.get("year")
    year_label = str(year) if year is not None else ""
    dataset_version = str(
        summary.get("dataset_version") or provenance.get("dataset_version") or ""
    )
    cui = summary.get("cui")

    trust_en = " · ".join(
        part for part in (
            "Public filing data",
            "summary level",
            ("%s %s" % (source_label, year_label)).strip(),
        ) if part
    )
    trust_ro = " · ".join(
        part for part in (
            "Date din raportări publice",
            "nivel sumar",
            ("%s %s" % (source_label, year_label)).strip(),
        ) if part
    )
    source_parts = [source]
    if dataset_version:
        source_parts.append(dataset_version)
    if cui is not None:
        source_parts.append("CUI %s" % cui)
    if year_label:
        source_parts.append(year_label)

    license_line = str(summary.get("license_line") or _DEFAULT_LICENSE_LINE)

    return {
        "status": PUBLIC_SUMMARY_STATUS,
        "trust_en": trust_en,
        "trust_ro": trust_ro,
        "source_line": " · ".join(source_parts),
        "license_line": license_line,
    }
