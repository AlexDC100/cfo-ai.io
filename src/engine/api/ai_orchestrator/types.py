"""Type definitions for the AI orchestration layer.

The orchestrator is a multi-model intelligence layer: each task is routed
to the best-fit model (Claude or GPT), high-stakes outputs are independently
verified by a second model, and disagreements escalate to a third
arbitration pass. This module defines the shared shapes that every other
file imports.

Design intent:
  · `AIRequest` / `AIResponse` are model-agnostic. Adapters translate
    them to/from provider-specific shapes (Anthropic Messages API,
    OpenAI Responses API).
  · `TaskType` is a closed enum — the router lookup is exhaustive,
    so adding a task type to the routing config without updating the
    enum is a static-check failure.
  · `Provenance` records WHICH models contributed to a final result.
    Surfaces to users via the "AI confidence" badge and powers
    router-tuning telemetry.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Literal, Optional, Protocol, Union


# ── Task taxonomy ──────────────────────────────────────────────────────
# Every LLM call in the application maps to one of these. The router
# uses task type as the primary key for routing decisions. New tasks
# require: (1) enum entry here, (2) routing rule in routing_config.py,
# (3) prompt + schema in prompts/<task>.py.
class TaskType(str, Enum):
    # — Extraction (structured data out of unstructured documents) —
    EXTRACT_TRIAL_BALANCE = "extract.trial_balance"
    EXTRACT_BALANCE_SHEET = "extract.balance_sheet"
    EXTRACT_PNL = "extract.pnl"
    EXTRACT_SKU_LIST = "extract.sku_list"

    # — Classification (assign category to known input) —
    CLASSIFY_ACCOUNT_TO_COA = "classify.account_to_coa"
    CLASSIFY_SKU_CATEGORY = "classify.sku_category"

    # — Detection (identify document format, language, currency) —
    DETECT_COA = "detect.coa"
    DETECT_INDUSTRY = "detect.industry"

    # — Reasoning (numeric chains, sanity checks) —
    REASON_FINANCIAL_RATIOS = "reason.financial_ratios"
    REASON_BENCHMARK_COMPARE = "reason.benchmark_compare"

    # — Translation / linguistic —
    TRANSLATE_FINANCIAL_TERM = "translate.financial_term"

    # — Generation (prose: commentary, reports, chat) —
    GENERATE_CFO_COMMENTARY = "generate.cfo_commentary"
    GENERATE_REPORT_SECTION = "generate.report_section"
    ASK_CFO_AI_CHAT = "ask.cfo_ai_chat"


# ── Content parts (multimodal-ready) ───────────────────────────────────
@dataclass
class TextPart:
    """Plain text segment."""
    text: str
    type: Literal["text"] = "text"


@dataclass
class ImagePart:
    """Image input (PNG/JPEG bytes or URL). Currently used for OCR fallback
    when document parsers fail."""
    data_b64: Optional[str] = None
    url: Optional[str] = None
    media_type: str = "image/png"
    type: Literal["image"] = "image"


@dataclass
class DocumentPart:
    """PDF or other document input (sent as base64 by adapters that
    natively support documents; falls back to text extraction otherwise)."""
    data_b64: str
    media_type: str = "application/pdf"
    filename: Optional[str] = None
    type: Literal["document"] = "document"


ContentPart = Union[TextPart, ImagePart, DocumentPart]


# ── Token usage + cost ─────────────────────────────────────────────────
@dataclass
class TokenUsage:
    """Per-call token counts. `cached_input_tokens` is the subset of
    `input_tokens` that hit the provider-side prompt cache (gets a
    substantial discount on both providers)."""
    input_tokens: int = 0
    output_tokens: int = 0
    cached_input_tokens: int = 0
    estimated_cost_usd: float = 0.0


# ── Request / Response ─────────────────────────────────────────────────
@dataclass
class AIRequest:
    """A unit of work for the orchestrator. Model-agnostic; adapters
    translate to provider-specific calls.

    `output_schema` (when set) instructs the adapter to return a
    validated dict. Claude uses tool_use, OpenAI uses response_format
    json_schema strict mode — but the orchestrator just sees `response.content`
    as a dict either way.
    """
    task_id: str
    task_type: TaskType
    system_prompt: str
    user_message: Union[str, List[ContentPart]]
    output_schema: Optional[Dict[str, Any]] = None
    max_tokens: int = 4096
    temperature: float = 0.0
    # Free-form tags for telemetry slicing (user_id, document_id, etc.)
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class AIResponse:
    """What every adapter returns. Content is a `dict` if the request
    had an output_schema, otherwise a plain `str`.

    `raw` holds the full provider response for debugging — NEVER expose
    to users; some providers include internal trace IDs / model versions
    in raw responses."""
    task_id: str
    model: str
    content: Union[str, Dict[str, Any]]
    finish_reason: str  # "stop" | "length" | "tool_use" | "error" | provider-specific
    usage: TokenUsage
    latency_ms: int
    raw: Optional[Any] = None


# ── Verification + reconciliation ──────────────────────────────────────
Severity = Literal["high", "medium", "low"]
Agreement = Literal["full", "partial", "conflict", "no_verifier"]


@dataclass
class FieldConflict:
    """One field where primary and verifier disagree."""
    field: str
    primary: Any
    verifier: Any
    severity: Severity
    # Optional context: e.g., absolute + relative diff for numeric fields
    notes: Optional[str] = None


@dataclass
class VerificationResult:
    """Output of verifier.verify(). Drives the reconciler's branching:
      · agreement=full  → use primary, done
      · agreement=partial (high confidence) → use primary, log conflicts
      · agreement=conflict OR low confidence → escalate to arbitration
    """
    agreement: Agreement
    confidence: float  # 0.0–1.0, fraction of fields agreed
    reasoning: str
    conflicts: List[FieldConflict] = field(default_factory=list)


@dataclass
class Provenance:
    """Record of WHICH models contributed to the final result.

    Powers two things:
      1. User-facing "AI confidence" badge — if `arbitrated=True`,
         we show a "verified by multiple models" indicator
      2. Telemetry — surfaces in the per-task agreement dashboard
    """
    sources: List[str] = field(default_factory=list)  # ['claude-opus-4-7', 'gpt-5']
    agreed: bool = True
    partial: bool = False  # partial agreement (within tolerance, no arbitration needed)
    arbitrated: bool = False
    conflicts: List[FieldConflict] = field(default_factory=list)
    notes: Optional[str] = None


@dataclass
class ExecutionResult:
    """The orchestrator's return value to the application layer.

    `response.content` is the final answer; `provenance` is metadata
    about how confident we are and which models contributed."""
    response: AIResponse
    provenance: Provenance


# ── Routing config schema ──────────────────────────────────────────────
ModelName = Literal["claude", "gpt"]


@dataclass(frozen=True)
class RoutingRule:
    """One row in the routing table — defines (primary, verifier) for a task."""
    primary: ModelName
    verify: Optional[ModelName]  # None = no cross-check
    rationale: str  # Why this routing — surfaces in telemetry + reviews


@dataclass
class RoutingConfig:
    """Full routing table: task_type → rule. Defaults file-scope at
    ROUTING_CONFIG in routing_config.py."""
    rules: Dict[TaskType, RoutingRule]


# ── Verification schema (drives compare_* dispatch) ────────────────────
@dataclass
class VerificationSchema:
    """Tells the verifier HOW to compare two outputs. Different task
    types need different comparison strategies:
      · `numeric`     — field-wise number compare with tolerance
      · `structured`  — deep dict/list diff with type awareness
      · `semantic`    — embeddings + tie-breaker LLM
    """
    kind: Literal["numeric", "structured", "semantic"]
    # Numeric: max allowed relative diff (0.001 = 0.1%)
    tolerance: float = 0.001
    # Structured: fields to ignore in comparison (e.g., timestamps)
    ignore_fields: List[str] = field(default_factory=list)
    # Both: per-field severity override (e.g., {"revenue": "high"})
    field_severity: Dict[str, Severity] = field(default_factory=dict)


# ── Model adapter Protocol ─────────────────────────────────────────────
class ModelAdapter(Protocol):
    """Every model implementation conforms to this Protocol. Lets the
    orchestrator stay model-agnostic — swap in a new provider by writing
    one adapter class.
    """
    name: str
    supports_structured_output: bool
    supports_long_context: bool  # >200k tokens
    supports_vision: bool
    available: bool  # False when API key is missing or provider is down

    def call(self, req: AIRequest) -> AIResponse:
        """Execute the request. Raises ProviderError on transient
        failures (orchestrator retries); raises BudgetExceededError if
        the call would exceed the per-user budget guard."""
        ...

    def estimate_cost(self, req: AIRequest) -> float:
        """Cheap upfront estimate (input tokens × input rate) for
        budget pre-check. Real cost is recorded in AIResponse.usage."""
        ...
