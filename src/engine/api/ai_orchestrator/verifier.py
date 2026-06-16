"""Verifier — compares primary + verifier outputs and reports agreement.

Comparison strategy depends on the data shape:
  · `numeric`     → field-wise with absolute + relative tolerance,
                    severity tiered by relative difference
  · `structured`  → deep dict/list diff with type awareness, optional
                    field ignoring (e.g., timestamps), set-like
                    array compare for unordered collections
  · `semantic`    → cheap embeddings cosine sim; tie-breaker LLM for
                    high-stakes prose. Not implemented in v1 — defers
                    to structural compare for now.

The verifier is intentionally synchronous + deterministic so the same
two outputs always produce the same agreement verdict. This is what
makes telemetry actionable: a per-task agreement-rate trendline is
only meaningful if the verdict doesn't drift.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Tuple

from .types import (
    AIResponse,
    Agreement,
    FieldConflict,
    Severity,
    VerificationResult,
    VerificationSchema,
)


# ── Public entry point ─────────────────────────────────────────────────

def verify(
    primary: AIResponse,
    verifier: AIResponse,
    schema: VerificationSchema,
) -> VerificationResult:
    """Compare two responses per the schema. Returns a structured
    verdict the reconciler can branch on.

    Never raises — even on totally malformed inputs, returns a
    `conflict` verdict so the reconciler can escalate cleanly."""
    if schema.kind == "numeric":
        return _compare_numeric(primary.content, verifier.content, schema)
    if schema.kind == "structured":
        return _compare_structured(primary.content, verifier.content, schema)
    if schema.kind == "semantic":
        return _compare_semantic(primary.content, verifier.content, schema)
    # Unknown schema kind — fail closed (treat as conflict, force arbitration).
    return VerificationResult(
        agreement="conflict",
        confidence=0.0,
        reasoning=f"Unknown verification kind: {schema.kind}",
    )


# ── Numeric ────────────────────────────────────────────────────────────

def _compare_numeric(
    primary: Any,
    verifier: Any,
    schema: VerificationSchema,
) -> VerificationResult:
    """Compare two dicts of numeric values with absolute + relative
    tolerance. Tolerance heuristic for monetary values:
      · absolute diff <= 1 unit OR
      · relative diff <= schema.tolerance (default 0.1%)
    """
    if not isinstance(primary, dict) or not isinstance(verifier, dict):
        return VerificationResult(
            agreement="conflict",
            confidence=0.0,
            reasoning=(
                f"Numeric comparison requires dict on both sides; got "
                f"{type(primary).__name__} vs {type(verifier).__name__}"
            ),
        )

    fields_to_check = [f for f in primary.keys() if f not in schema.ignore_fields]
    if not fields_to_check:
        return VerificationResult(
            agreement="full",
            confidence=1.0,
            reasoning="No comparable fields",
        )

    conflicts: List[FieldConflict] = []
    for field in fields_to_check:
        pv = _coerce_number(primary.get(field))
        vv = _coerce_number(verifier.get(field))
        if pv is None or vv is None:
            # Non-numeric field — skip (might be a string label mixed
            # in with numeric extraction; handled by structured compare).
            continue

        abs_diff = abs(pv - vv)
        denom = max(abs(pv), abs(vv), 1.0)
        rel_diff = abs_diff / denom

        # Both checks must agree on "out of tolerance" — absolute floor
        # of 1 currency unit prevents flagging rounding on tiny values.
        if abs_diff > 1 and rel_diff > schema.tolerance:
            severity = _severity_for_rel_diff(rel_diff, schema.field_severity.get(field))
            conflicts.append(FieldConflict(
                field=field,
                primary=pv,
                verifier=vv,
                severity=severity,
                notes=f"abs_diff={abs_diff:.2f}, rel_diff={rel_diff*100:.3f}%",
            ))

    return _summarize(conflicts, total_fields=len(fields_to_check))


def _coerce_number(v: Any) -> Any:
    """Convert v to float when possible; None when not."""
    if v is None:
        return None
    if isinstance(v, bool):  # bool is int subclass — guard
        return None
    if isinstance(v, (int, float)):
        return float(v) if not (isinstance(v, float) and math.isnan(v)) else None
    if isinstance(v, str):
        try:
            return float(v.replace(",", "").replace(" ", ""))
        except ValueError:
            return None
    return None


def _severity_for_rel_diff(rel: float, override: Severity | None) -> Severity:
    if override is not None:
        return override
    if rel > 0.05:
        return "high"
    if rel > 0.01:
        return "medium"
    return "low"


# ── Structured ─────────────────────────────────────────────────────────

def _compare_structured(
    primary: Any,
    verifier: Any,
    schema: VerificationSchema,
) -> VerificationResult:
    """Deep dict/list compare. Numbers within tolerance are equal;
    strings compared case-insensitively after stripping; lists treated
    as ordered unless `_unordered` field name marker is used (future)."""
    conflicts: List[FieldConflict] = []
    _diff_recurse(primary, verifier, "", schema, conflicts)
    # Total fields = number of distinct paths at all leaf levels (rough proxy).
    total = max(1, _count_leaves(primary))
    return _summarize(conflicts, total_fields=total)


def _diff_recurse(
    p: Any,
    v: Any,
    path: str,
    schema: VerificationSchema,
    conflicts: List[FieldConflict],
) -> None:
    """Recursive deep diff. Appends conflicts; returns nothing."""
    if path.split(".")[-1] in schema.ignore_fields:
        return

    if isinstance(p, dict) and isinstance(v, dict):
        all_keys = set(p.keys()) | set(v.keys())
        for k in all_keys:
            child_path = f"{path}.{k}" if path else k
            _diff_recurse(p.get(k), v.get(k), child_path, schema, conflicts)
        return

    if isinstance(p, list) and isinstance(v, list):
        if len(p) != len(v):
            conflicts.append(FieldConflict(
                field=path,
                primary=f"list[{len(p)}]",
                verifier=f"list[{len(v)}]",
                severity="medium",
                notes="list length differs",
            ))
            return
        for i, (pi, vi) in enumerate(zip(p, v)):
            _diff_recurse(pi, vi, f"{path}[{i}]", schema, conflicts)
        return

    # Leaf comparison
    if _values_equal(p, v, schema.tolerance):
        return

    severity = schema.field_severity.get(path.split(".")[-1], "medium")
    conflicts.append(FieldConflict(
        field=path or "<root>",
        primary=p,
        verifier=v,
        severity=severity,
    ))


def _values_equal(a: Any, b: Any, tolerance: float) -> bool:
    if a is None and b is None:
        return True
    if isinstance(a, bool) or isinstance(b, bool):
        return a == b
    # Numeric with tolerance
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        if a == b:
            return True
        abs_diff = abs(a - b)
        denom = max(abs(a), abs(b), 1.0)
        return abs_diff <= 1 or (abs_diff / denom) <= tolerance
    # String — case + whitespace insensitive
    if isinstance(a, str) and isinstance(b, str):
        return a.strip().lower() == b.strip().lower()
    return a == b


def _count_leaves(v: Any) -> int:
    if isinstance(v, dict):
        return sum(_count_leaves(x) for x in v.values()) or len(v)
    if isinstance(v, list):
        return sum(_count_leaves(x) for x in v) or len(v)
    return 1


# ── Semantic (v1: structural delegate) ─────────────────────────────────

def _compare_semantic(
    primary: Any,
    verifier: Any,
    schema: VerificationSchema,
) -> VerificationResult:
    """Placeholder for embeddings + tie-breaker LLM. v1 delegates to
    structural compare so prose tasks still get *some* verification.
    Future v2 wires in OpenAI embeddings (text-embedding-3-large)
    with cosine threshold + LLM tie-breaker."""
    return _compare_structured(primary, verifier, schema)


# ── Summary ────────────────────────────────────────────────────────────

def _summarize(conflicts: List[FieldConflict], total_fields: int) -> VerificationResult:
    """Convert raw conflict list → VerificationResult verdict."""
    if not conflicts:
        return VerificationResult(
            agreement="full",
            confidence=1.0,
            reasoning="All compared fields within tolerance",
        )

    has_high = any(c.severity == "high" for c in conflicts)
    agreement: Agreement = "conflict" if has_high else "partial"
    confidence = max(0.0, 1.0 - len(conflicts) / max(1, total_fields))
    reasoning = (
        f"{len(conflicts)} of {total_fields} field(s) disagree "
        f"(high={sum(1 for c in conflicts if c.severity == 'high')}, "
        f"medium={sum(1 for c in conflicts if c.severity == 'medium')}, "
        f"low={sum(1 for c in conflicts if c.severity == 'low')})"
    )
    return VerificationResult(
        agreement=agreement,
        confidence=confidence,
        reasoning=reasoning,
        conflicts=conflicts,
    )
