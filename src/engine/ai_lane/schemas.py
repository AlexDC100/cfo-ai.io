"""AI extraction lane — typed shapes shared across the lane's stages.

Plain dataclasses (Python 3.9 compatible) so every stage's contract is
explicit and unit-testable without the Anthropic SDK installed. The lane
NEVER fabricates numbers: any unrecoverable model/parse failure raises
`AiLaneError`, which the pipeline's blanket handler turns into
documents.status = 'failed' with the error message — no partial figures
are ever persisted.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


class AiLaneError(RuntimeError):
    """Unrecoverable AI-lane failure (auth, transport, twice-malformed
    JSON, unsupported input). Message is user-facing via documents.error."""


@dataclass
class JurisdictionResolution:
    """Output of `jurisdiction_resolver.resolve` (also emitted as a plain
    dict — see `resolve()`); kept as a dataclass for internal typing."""
    jurisdiction: str            # "RO" | "HU" | "OTHER"
    source: str                  # "user" | "language" | "account_pattern" | "default"
    confidence: float

    def as_dict(self) -> Dict[str, Any]:
        return {
            "jurisdiction": self.jurisdiction,
            "source": self.source,
            "confidence": round(float(self.confidence), 4),
        }


@dataclass
class FormatDetectResult:
    """Stage 1 — document layout / locale detection (strict JSON)."""
    columns: List[str] = field(default_factory=list)
    header_row: Optional[int] = None
    totals_row_index: Optional[int] = None
    currency: Optional[str] = None
    scale: float = 1.0                       # 1 = units; 1000 = thousands
    thousands_sep: Optional[str] = None      # HU: " " (space)
    decimal_sep: Optional[str] = None        # HU: ","
    language: Optional[str] = None
    raw: Dict[str, Any] = field(default_factory=dict)


@dataclass
class ExtractedRow:
    """One account row, in the ORIGINAL currency/scale of the document.
    `debit`/`credit` are closing-balance columns when the layout carries
    them; `balance` is the single signed column otherwise (debit-positive).
    """
    code: str
    label: str
    debit: Optional[float] = None
    credit: Optional[float] = None
    balance: Optional[float] = None

    def debit_signed(self) -> float:
        """Debit-positive signed closing balance for this row."""
        if self.debit is not None or self.credit is not None:
            return float(self.debit or 0.0) - float(self.credit or 0.0)
        return float(self.balance or 0.0)


@dataclass
class ExtractResult:
    """Stage 2 — every account row + the document's own totals row (when
    one exists). Totals are FILE values, never recomputed."""
    rows: List[ExtractedRow] = field(default_factory=list)
    totals_debit: Optional[float] = None
    totals_credit: Optional[float] = None
    raw: Dict[str, Any] = field(default_factory=dict)


@dataclass
class ClassifiedAccount:
    """Stage 3 — one account's mapping into the canonical statement-line
    vocabulary (engine.canonical schema_v1 leaf names, plus the special
    token `excluded_control` for technical/closing accounts)."""
    code: str
    line_id: str
    confidence: float
    rationale: str = ""


@dataclass
class ClassifyResult:
    assignments: Dict[str, ClassifiedAccount] = field(default_factory=dict)
    raw: Dict[str, Any] = field(default_factory=dict)
