"""Deterministic jurisdiction resolver — runs BEFORE lane selection.

resolve(doc_meta, file_bytes, user_choice) ->
    {"jurisdiction": "RO"|"HU"|<any jurisdiction with a pack>|"OTHER",
     "source": "user"|"language"|"account_pattern"|"default",
     "confidence": float}

Priority ladder (task contract):
  1. Explicit user choice — the `user_choice` argument, else the
     document row's `jurisdiction_hint` key. CONTRACT: the pipeline
     passes `doc.get("jurisdiction_hint")`; the `documents` table today
     has no such column, so the hint is absent until a migration adds it
     (or a caller injects the key into the doc dict). Values are
     normalized upper-case and admitted BY PACK DISCOVERY (N7): a choice
     naming a jurisdiction that has a discoverable data pack resolves to
     that jurisdiction; anything else resolves "OTHER". There is
     deliberately NO hardcoded list of admissible jurisdictions here —
     adding a jurisdiction means authoring packs/<jur>/..., never
     editing this module (locked by tests/engine/test_new_jurisdiction.py).
  2. Document language/locale — deterministic keyword + diacritic scan
     over a text sample (xlsx sharedStrings, PDF text, raw decode). The
     HU pack's own `detect_from_content` is consulted as an additional
     signal (today it honestly returns 0.0 — skeleton pack — but the
     seam is wired for when it graduates).
  3. Account-code pattern — HU számlatükör class shapes vs RO RAS code
     shapes, from the numeric account codes visible in the sample.
  4. Default — RO (the platform's calibrated home jurisdiction).

Deterministic, zero LLM calls, never raises (any internal failure falls
through to the RO default). The RO deterministic lane is guarded by
tests: every RO fixture must resolve RO.
"""
from __future__ import annotations

import io
import logging
import re
import zipfile
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

logger = logging.getLogger("engine.api")


# ── Deterministic language signals ─────────────────────────────────────
# Keywords are matched on a lower-cased sample; each set counts DISTINCT
# hits so one repeated header word can't outvote a real document.
# Diacritic-folded variants included because ERP exports frequently strip
# accents.

_HU_KEYWORDS = (
    "számla", "szamlatükör", "számlatükör", "egyenleg", "tartozik",
    "követel", "kovetel", "főkönyvi", "fokonyvi", "kivonat",
    "megnevezés", "megnevezes", "összesen", "osszesen", "nyitó",
    "záró egyenleg", "forgalom", "adószám", "készletek",
)
# Letters ő / ű exist in Hungarian but not in Romanian.
_HU_UNIQUE_LETTERS = ("ő", "ű")

_RO_KEYWORDS = (
    "balanta", "balanță", "balanţă", "verificare", "rulaj", "rulaje",
    "solduri", "sold initial", "sold final", "denumire", "denumirea",
    "simbol cont", "precedente", "cumulate", "capital subscris",
    "furnizori", "clienti", "clienți", "tva",
)

# ── Account-pattern signals ────────────────────────────────────────────
# RO RAS marker prefixes: synthetic-analytic pairs that only the OMFP
# chart uses. HU Act C of 2000 markers: notable számlatükör accounts.
_RO_MARKER_CODES = {
    "1012", "1061", "1171", "121", "129", "4111", "4426", "4427",
    "4428", "4423", "4424", "5121", "5311", "601", "607", "691", "707", "711",
}
_HU_MARKER_CODES = {
    "384", "381", "389", "311", "454", "466", "467", "479", "411",
    "412", "413", "414", "419", "491", "811", "814", "816", "911", "914",
}

_CODE_RE = re.compile(r'(?m)^\s*"?(\d{3,4})\b')


def _decode(sample: bytes) -> str:
    try:
        return sample.decode("utf-8")
    except UnicodeDecodeError:
        return sample.decode("latin-1", errors="replace")


def _text_sample(file_bytes: bytes, filename: str = "", limit: int = 200_000) -> str:
    """Best-effort text sample from raw upload bytes. XLSX: read the
    shared-strings part (where all cell text lives) + first worksheet.
    PDF: pypdf text when available. Everything else: plain decode."""
    if not file_bytes:
        return ""
    head = file_bytes[:8]
    # ZIP container (xlsx/xlsm/ods)
    if head[:2] == b"PK":
        parts: List[str] = []
        try:
            with zipfile.ZipFile(io.BytesIO(file_bytes)) as zf:
                names = zf.namelist()
                for wanted in ("xl/sharedStrings.xml", "xl/worksheets/sheet1.xml"):
                    if wanted in names:
                        try:
                            parts.append(_decode(zf.read(wanted)[:limit]))
                        except Exception:  # noqa: BLE001
                            continue
        except Exception:  # noqa: BLE001 — corrupt zip → no sample
            return ""
        return "\n".join(parts)[:limit]
    # PDF
    if head[:5] == b"%PDF-":
        try:
            try:
                from pypdf import PdfReader  # type: ignore
            except ImportError:
                from PyPDF2 import PdfReader  # type: ignore
            out: List[str] = []
            reader = PdfReader(io.BytesIO(file_bytes))
            for page in reader.pages[:10]:
                out.append(page.extract_text() or "")
                if sum(len(p) for p in out) > limit:
                    break
            return "\n".join(out)[:limit]
        except Exception:  # noqa: BLE001
            return ""
    # CSV / TSV / TXT / unknown — plain decode.
    return _decode(file_bytes[:limit])


def _distinct_hits(text_lower: str, keywords: Iterable[str]) -> int:
    return sum(1 for kw in keywords if kw in text_lower)


def _result(jurisdiction: str, source: str, confidence: float) -> Dict[str, Any]:
    return {
        "jurisdiction": jurisdiction,
        "source": source,
        "confidence": round(float(confidence), 4),
    }


#: The platform's calibrated HOME jurisdiction — rung 4's default, the
#: deterministic lane, and the jurisdiction every internal failure falls
#: back to. Named once here instead of being spelled "RO" in five places.
HOME_JURISDICTION = "RO"

#: The GENERIC (non-jurisdiction) pack. Documents that name no
#: jurisdiction-specific pack are classified against it, and this lane's
#: wire code for that state is "OTHER" (engine.ai_lane.config.
#: classify_pack maps OTHER -> the INTL pack). It has a pack directory
#: like every other jurisdiction, so pack-discovery admission has to skip
#: it explicitly: admitting "INTL" as a jurisdiction of its own would
#: rename the lane's OTHER bucket and change what every stored envelope
#: and golden records.
GENERIC_PACK_JURISDICTION = "INTL"

#: Long-form spellings callers have historically sent for the two
#: jurisdictions that predate pack-driven admission. Alias -> the
#: jurisdiction CODE; the code itself is admitted by pack discovery like
#: any other, so this table never grows for a NEW jurisdiction — it only
#: carries spellings that are not the code.
_CHOICE_ALIASES = {
    "ROU": "RO", "ROMANIA": "RO",
    "HUN": "HU", "HUNGARY": "HU",
}


def _has_pack(jurisdiction: str) -> bool:
    """True when a jurisdiction DATA PACK is discoverable for this code.

    Goes through the production pack runtime (cached per packs root +
    jurisdiction), so this costs one dict lookup after the first call.
    Guarded: a missing/broken packs root must never break resolution —
    it degrades to 'not admitted', and the caller's own fallbacks
    (rung 4, HOME_JURISDICTION) take over."""
    try:
        from engine.packs.runtime import active_pack

        active_pack(jurisdiction)
        return True
    except Exception:  # noqa: BLE001 — resolver must NEVER raise
        return False


def selectable_jurisdictions() -> Tuple[str, ...]:
    """Every jurisdiction an explicit choice may name, sorted.

    DATA-DRIVEN (N7): the set is whatever packs/ contains, plus the home
    jurisdiction (which the resolver falls back to regardless, and which
    must stay selectable even if pack discovery is unavailable). The
    generic pack is excluded — its wire code is "OTHER", not a
    jurisdiction. Callers that validate a user-supplied jurisdiction
    (e.g. the reextract route) read this instead of keeping their own
    list, so a new pack is selectable the moment it is deployed."""
    found = {HOME_JURISDICTION}
    try:
        from engine.packs.loader import discover_packs
        from engine.packs.runtime import default_packs_root

        for pack in discover_packs(default_packs_root()):
            code = pack.identity.jurisdiction.strip().upper()
            if code and code != GENERIC_PACK_JURISDICTION:
                found.add(code)
    except Exception:  # noqa: BLE001 — never break on a broken pack root
        logger.exception("[ai_lane] pack discovery failed listing jurisdictions")
    return tuple(sorted(found))


def _normalize_choice(choice: Any) -> Optional[str]:
    """An explicit choice -> the jurisdiction it names, or "OTHER".

    Admission is BY PACK DISCOVERY, not by a list in this file: any code
    with a discoverable pack resolves to itself. The generic pack's code
    ("INTL", the FE's wire code for the international pack) and every
    unknown code resolve "OTHER" — unchanged behavior for every value
    that existed before packs became the registry."""
    if choice is None:
        return None
    val = str(choice).strip().upper()
    if not val:
        return None
    val = _CHOICE_ALIASES.get(val, val)
    if val == GENERIC_PACK_JURISDICTION:
        return "OTHER"
    if val == HOME_JURISDICTION or _has_pack(val):
        return val
    return "OTHER"


def _hu_pack_confidence(file_bytes: bytes, filename: str) -> float:
    """Consult the HU pack's own content detector (skeleton: 0.0 today).
    Guarded — a pack import problem must never break resolution."""
    try:
        from engine.country_packs.hu_hungary.pack import HungaryPack
        det = HungaryPack().detect_from_content(file_bytes, filename)
        return float(getattr(det, "confidence", 0.0) or 0.0)
    except Exception:  # noqa: BLE001
        return 0.0


def _codes_in_sample(text: str) -> Set[str]:
    return set(_CODE_RE.findall(text))


def resolve(
    doc_meta: Optional[Dict[str, Any]],
    file_bytes: bytes,
    user_choice: Optional[str] = None,
) -> Dict[str, Any]:
    """Deterministic jurisdiction resolution. Never raises."""
    doc_meta = doc_meta or {}
    try:
        # 1 — explicit user choice wins outright.
        choice = _normalize_choice(
            user_choice if user_choice is not None else doc_meta.get("jurisdiction_hint")
        )
        if choice is not None:
            return _result(choice, "user", 1.0)

        text = _text_sample(file_bytes, str(doc_meta.get("original_filename") or ""))
        text_lower = text.lower()

        # 2 — language / locale detection.
        hu_hits = _distinct_hits(text_lower, _HU_KEYWORDS)
        hu_hits += sum(1 for ch in _HU_UNIQUE_LETTERS if ch in text_lower)
        ro_hits = _distinct_hits(text_lower, _RO_KEYWORDS)
        pack_conf = _hu_pack_confidence(
            file_bytes, str(doc_meta.get("original_filename") or "")
        )
        if pack_conf >= 0.8 and pack_conf > ro_hits * 0.1:
            return _result("HU", "language", pack_conf)
        if hu_hits >= 2 and hu_hits > ro_hits:
            return _result("HU", "language", min(0.95, 0.5 + 0.1 * hu_hits))
        if ro_hits >= 2 and ro_hits > hu_hits:
            return _result("RO", "language", min(0.95, 0.5 + 0.1 * ro_hits))

        # 3 — account-code pattern (számlatükör vs RAS shapes).
        codes = _codes_in_sample(text)
        if codes:
            ro_markers = len(codes & _RO_MARKER_CODES)
            hu_markers = len(codes & _HU_MARKER_CODES)
            classes = {c[0] for c in codes}
            if ro_markers >= 2 and ro_markers >= hu_markers:
                return _result("RO", "account_pattern", min(0.9, 0.5 + 0.1 * ro_markers))
            # HU shape: marker accounts present AND the P&L lives in
            # classes 8/9 (expenses/revenues) with no RO-style 6xx/7xx
            # P&L block dominance.
            if hu_markers >= 2 and (("8" in classes or "9" in classes)
                                    or not ({"6", "7"} & classes)):
                return _result("HU", "account_pattern", min(0.85, 0.45 + 0.1 * hu_markers))
            if ro_markers == 1 and hu_markers == 0:
                return _result("RO", "account_pattern", 0.55)

        # 4 — default: the calibrated home jurisdiction.
        return _result(HOME_JURISDICTION, "default", 0.2)
    except Exception:  # noqa: BLE001 — resolver must NEVER break extraction
        logger.exception("[ai_lane] jurisdiction resolver crashed — defaulting home")
        return _result(HOME_JURISDICTION, "default", 0.0)
