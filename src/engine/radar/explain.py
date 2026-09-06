"""RADAR — AI EXPLANATION, IN ITS LANE (engine.radar.explain).

Radar's rows are deterministic end to end: detection, quantification,
materiality, ranking, the surfaced cap and dismissal all happen UPSTREAM
of this module (``engine.api.findings`` + ``engine.api._finding_rank``)
and are finished before it is called. This module does ONE thing to a
surfaced row: it attaches an explanation — the why-here paragraph and
the action list, in English and Romanian — drafted by a model and gated
by the adversarial specificity reviewer, through the SAME seam the
findings contract already guards (``engine.ai.finding_sharpen`` ->
``_finding.apply_advisory_narrative``).

Four properties, each held by SHAPE rather than by discipline:

  NEVER ON THE CRITICAL PATH.
      The route returns its deterministic rows first. :func:`attach_cached`
      is the only call allowed before the rows go out, and it is
      cache-only: it never builds a client, never consults the breaker,
      never calls the model. Explanations are produced AFTER the rows by
      :func:`explain_subjects` (a lazy generator — nothing is drafted
      until it is iterated) or :func:`explain_in_background`. A model
      that is dead, capped, or slow costs the reader an honest
      ``explanation.status == "absent"`` marker and nothing else.

  NO AI IN RANKING, SEVERITY, CAP OR SUPPRESSION.
      The lane receives :class:`ExplainSubject` — a READ-ONLY projection
      of an already-ranked, already-capped row (``_freeze``'d: callables
      withheld and never invoked, unknown objects named by type and never
      ``repr``'d) — and returns :class:`Explanation`, whose fields are
      prose and provenance ONLY. There is no field on it that could carry
      a severity, a rank, a disposition or a dismissal, and
      :func:`attach` refuses (``ExplanationOverreach``) any payload that
      grew one. A model that answers with ``"severity": "critical"`` is
      answering a question nobody asked; the key is dropped at projection
      and the row is byte-identical afterwards.

  NO MODEL QUANTITY REACHES A READER (C1, on this path).
      ONE numeral law, both languages, both paths:
      ``finding_sharpen.numeral_violations``. It refuses an ASCII figure,
      a number word (trei / treizeci / două milioane / forty-seven /
      a third / doubled), a currency word or symbol in any case on either
      side of a placeholder or a figure (euro / EUR / € / lei / Lei /
      "in EUR:" / "EUR-"), every Unicode numeral (², ½, ⑦, ⁴⁷, Ⅻ) and a
      Roman numeral written as letters, a whitelisted ledger code used as
      a quantity ("461%", "past 461 days", "de 461 ori", "since 455"), a
      placeholder OPTION (``|abs``, ``|d4``, ``|bare``, ``|suffix``, ``|k``
      — the whitelist is what the deterministic prose uses, measured:
      nothing) and an unresolved or malformed placeholder
      (``{{money:x|Bare}}``, ``{{ money }}``) that would reach a reader as
      literal braces. The drafting lane runs it at parse, regenerates
      once, then falls back to the deterministic template; this module
      runs it AGAIN on the SERVED text — a fresh draft and a cache record
      alike — through :func:`served_numeral_violations`.

  THE CACHE PATH RUNS THE SAME CHECKS AS THE FRESH PATH, ON READ.
      A cache record is DATA written earlier and trusted no more than a
      fresh draft. :func:`_from_cache` re-runs, on every read: the
      numeral law; the finding contract through the ONE seam (anchors,
      hedges, the imperative lexicon, the account code in the prose —
      ``finding_sharpen.narrative_contract_problems``); the self-review
      (an accepted score row per served language at or above TODAY's
      floor and a numeric specificity on the prose —
      ``finding_sharpen.review_problems``); and ``source``, which is never
      passed through — it is re-derived as ``advisory`` only once every
      check has passed. A record failing any check is a MISS with its
      kind named (``numeral_refused``, ``contract_refused``,
      ``review_missing``, ``stale_cache``): the critical path serves the
      honest marker and the after-rows path regenerates.

THE CONTRACT THE ROUTE WIRES (the explain side of the seam).
    ``Explanation.to_payload()`` IS the seam; nothing else writes
    ``row["explanation"]``. The serve lane calls, in this order:

        subjects = subjects_from_ranked(report, profile, org, period, snap)
        rows     = attach(rows, attach_cached(subjects), subjects)   # before the rows go out
        explain_in_background(subjects)                              # after

    ``attach`` sets ONE key per row, ``explanation``, to the payload whose
    keys are exactly :data:`EXPLANATION_PAYLOAD_KEYS`; ``en`` / ``ro`` are
    :data:`PROSE_PAYLOAD_KEYS` or ``None``; every ``review`` row carries a
    subset of :data:`REVIEW_ROW_KEYS`. ``status`` is ``cached`` | ``fresh``
    | ``absent``; an absent explanation carries a ``kind`` from
    :data:`ABSENT_KINDS` and a ``reason`` that is a sentence. No key in the
    payload is ever numeric except ``specificity`` and ``attempts`` (the
    review's own scores — provenance, not a figure about the company),
    and none is ever ranking vocabulary. The key sets are pinned by
    ``test_the_payload_contract_is_stable``.

  DEGRADED IS CALM AND CARRIES NO PAYLOAD.
      Breaker open, credits absent, model error, a refused draft, a
      generic draft — every one lands as ``status: absent`` with a
      human-readable ``reason`` and a ``kind``. The model's raw answer,
      a rejected draft, a critique, a traceback: none of it is on the
      served shape. Rejected text goes to the AI journal, which is an
      audit surface.

THE CACHE. One record per (org, period, snapshot hash, finding id,
prompt version). ``prompt version`` is COMPOSITE — this lane's own row in
``models.yaml`` plus the drafting and reviewing prompt versions — so a
change to any prompt that shaped the text invalidates it. Only an EARNED
explanation is cached; a degraded one is recomputed next time (the
breaker bounds the cost of a dead model, which is what it is for).

THE BUDGET. ``radar_explain`` is a role of its own in ``models.yaml``
with EXPLICIT caps: one lane call per explained finding is counted
against it, in addition to the ``narrative`` and ``finding_specificity``
roles the drafting lane already charges. A trip means "no more
explanations today", and the reader still gets every row with its
deterministic why-here and action list.

Python 3.9 — no `match`, no `X | Y` unions.
"""
from __future__ import annotations

import ast
import hashlib
import importlib
import json
import logging
import os
import re
import threading
from dataclasses import dataclass, fields, replace
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional, Sequence, Tuple

from engine.ai import breaker, registry
from engine.ai import finding_sharpen as FS

logger = logging.getLogger("engine.radar.explain")


# ── Identity ─────────────────────────────────────────────────────────────

#: The lane's own registry role. Drafting still runs on
#: ``finding_sharpen.ROLE_DRAFT`` and review on ``ROLE_REVIEW``; this row
#: is the lane's daily budget and the cache-key half it owns.
ROLE = "radar_explain"

#: Journal lane tag (``finding_sharpen.journal_record`` rows carry it).
LANE = "radar_explain"

#: Bump on any change to the cache record shape or to what a record must
#: carry to be served. v2: the review rows and the prose specificity are
#: load-bearing on read (a record cleared by the v1 read path — which
#: checked only the numeral guard — is a miss).
CACHE_VERSION = 2

#: Env override for the file cache directory (tests + ops).
CACHE_DIR_ENV = "RADAR_EXPLAIN_CACHE_DIR"

STATUS_CACHED = "cached"
STATUS_FRESH = "fresh"
STATUS_ABSENT = "absent"

#: Why an explanation is absent. ``KIND_NOT_YET`` is the honest marker
#: the critical path attaches when nothing has been drafted yet.
KIND_NOT_YET = "not_yet_explained"
KIND_BREAKER_OPEN = "breaker_open"
KIND_ADVISORY_UNAVAILABLE = "advisory_unavailable"
KIND_NUMERAL_REFUSED = "numeral_refused"
KIND_CONTRACT_REFUSED = "contract_refused"
KIND_REVIEW_MISSING = "review_missing"
KIND_STALE_CACHE = "stale_cache"
KIND_LANE_ERROR = "lane_error"
KIND_REGISTRY_ERROR = "registry_error"
ABSENT_KINDS = frozenset([
    KIND_NOT_YET, KIND_BREAKER_OPEN, KIND_ADVISORY_UNAVAILABLE,
    KIND_NUMERAL_REFUSED, KIND_CONTRACT_REFUSED, KIND_REVIEW_MISSING,
    KIND_STALE_CACHE, KIND_LANE_ERROR, KIND_REGISTRY_ERROR,
])
#: The cache-miss kinds a reader is told about (the record existed and
#: was REFUSED) as opposed to a plain miss (nothing drafted yet).
REFUSED_CACHE_KINDS = frozenset([
    KIND_NUMERAL_REFUSED, KIND_CONTRACT_REFUSED, KIND_REVIEW_MISSING,
    KIND_STALE_CACHE,
])

#: THE PAYLOAD CONTRACT — what `row["explanation"]` carries. Pinned by a
#: test; a change here is a change the serve lane and the frontend read.
EXPLANATION_PAYLOAD_KEYS = frozenset([
    "finding_id", "key", "status", "kind", "reason", "prompt_version",
    "row_fingerprint", "en", "ro", "ro_absent_reason", "review",
])
PROSE_PAYLOAD_KEYS = frozenset([
    "language", "rationale", "steps", "source", "specificity", "attempts",
])
STEP_PAYLOAD_KEYS = frozenset(["imperative", "artefact", "provider", "horizon", "lang"])

#: The vocabulary this lane may NEVER carry on its output. A key from this
#: set on an explanation payload is the model reaching into ranking, and
#: :func:`attach` refuses it. Kept as data so the structural test and the
#: runtime refusal read the same list.
RANKING_VOCABULARY = frozenset([
    "severity", "effective_severity", "rank", "score", "disposition",
    "surfaced", "demoted", "dismissed", "dismissal", "dismissed_but_retained",
    "cap", "held_back", "recommendation", "materiality", "tier",
    "demotion_reason", "root_cause", "merged_from", "contributor_rules",
])

#: Tokens that must never appear on a served shape — the raw-payload
#: signatures the degraded tests grep for.
_RAW_PAYLOAD_SIGNATURES = ("Traceback", "messages.create", "raw_response")

#: The modules of this package that must stay model-free. Everything
#: except this file (and the package init, which imports nothing).
_PACKAGE_DIR = Path(__file__).resolve().parent


def model_free_modules() -> Tuple[Path, ...]:
    """Every ``engine.radar`` module other than this one. Serve, cap and
    whatever lands beside them must never import ``engine.ai`` or call a
    model — see :func:`critical_path_violations`."""
    out = []  # type: List[Path]
    for path in sorted(_PACKAGE_DIR.glob("*.py")):
        if path.name in ("explain.py", "__init__.py"):
            continue
        out.append(path)
    return tuple(out)


class ExplanationOverreach(ValueError):
    """An explanation payload carries a ranking-vocabulary key. Refused:
    the model explains, it does not rank, grade, cap or suppress."""


# ── Lazy engine.api access (its package __init__ builds the FastAPI app) ─

_LAZY_LOCK = threading.Lock()
_LAZY = {}  # type: Dict[str, Any]


def _lazy(name: str) -> Any:
    with _LAZY_LOCK:
        mod = _LAZY.get(name)
        if mod is None:
            mod = importlib.import_module(name)
            _LAZY[name] = mod
        return mod


def _F() -> Any:
    return _lazy("engine.api._finding")


# ── The read-only projection ─────────────────────────────────────────────


@dataclass(frozen=True)
class ExplainSubject:
    """ONE surfaced row, as this lane is allowed to see it.

    ``finding`` is the engine's frozen ``Finding`` — the drafting seam
    needs it to fingerprint the numerics before and after the rewrite.
    ``profile`` is the ``CompanyProfile`` that qualified it; the drafting
    lane reads it only through ``to_payload()`` / ``anchors()``. ``row``
    is the ranked row payload, PROJECTED through ``finding_sharpen._freeze``
    at construction: a callable in it is withheld and never invoked, an
    object it does not understand is named by type and never ``repr``'d.
    The lane never writes into any of the three.
    """

    finding: Any
    profile: Any
    row: Dict[str, Any]
    finding_id: str
    org_id: str
    period_id: str
    snapshot_hash: str
    row_fingerprint: str
    gateway_facts: Optional[Dict[str, Any]] = None


def finding_identity(finding: Any) -> str:
    """``rule_id|codes`` — the id a stored explanation is keyed on. The
    subject codes are what make two firings of one rule on different
    accounts two findings rather than one."""
    subject = getattr(finding, "subject", None)
    codes = []  # type: List[str]
    for account in (getattr(subject, "accounts", ()) or ()):
        code = str(getattr(account, "code", "") or "").strip()
        if code:
            codes.append(code)
    return "%s|%s" % (str(getattr(finding, "rule_id", "") or ""), ",".join(codes))


def project_row(payload: Any) -> Dict[str, Any]:
    """The ranked row, as data. Reuses the drafting lane's projector so
    the two lanes cannot disagree about what "read-only" means: a
    callable becomes ``CALLABLE_WITHHELD`` (not called), an unknown
    object becomes ``<TypeName withheld>`` (not ``repr``'d)."""
    frozen = FS._freeze(payload)
    if not isinstance(frozen, dict):
        return {"row": frozen}
    return frozen


def _fingerprint(payload: Any) -> str:
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, ensure_ascii=False,
                   default=str).encode("utf-8")).hexdigest()


def snapshot_hash_of(statements: Any) -> str:
    """A stable identity for the numbers a period was judged on. Callers
    that hold a content hash or a snapshot id may pass that instead."""
    return _fingerprint(statements)


def subject_for(finding: Any, profile: Any, row_payload: Any,
                org_id: str, period_id: str, snapshot_hash: str,
                gateway: Any = None,
                gateway_facts: Optional[Dict[str, Any]] = None
                ) -> ExplainSubject:
    """Build the projection for one surfaced row."""
    row = project_row(row_payload)
    facts = None  # type: Optional[Dict[str, Any]]
    if gateway_facts is not None:
        facts = FS._freeze(dict(gateway_facts))
    elif gateway is not None:
        facts = FS.gateway_presence(gateway)
    return ExplainSubject(
        finding=finding, profile=profile, row=row,
        finding_id=finding_identity(finding),
        org_id=str(org_id or ""), period_id=str(period_id or ""),
        snapshot_hash=str(snapshot_hash or ""),
        row_fingerprint=_fingerprint(row),
        gateway_facts=facts,
    )


def subjects_from_result(result: Any, org_id: str, period_id: str,
                         snapshot_hash: str, gateway: Any = None
                         ) -> Tuple[ExplainSubject, ...]:
    """Every SURFACED finding of a ``SinglePeriodResult``, in the
    result's own severity order. Demoted findings are never subjects —
    the lane has no opinion about which findings exist."""
    profile = result.profile
    out = []  # type: List[ExplainSubject]
    by_id = {}  # type: Dict[str, Any]
    for finding in result.finding_set.surfaced:
        by_id[finding_identity(finding)] = finding
    for payload in result.surfaced():
        rule = str(payload.get("rule_key") or "")
        match = None
        for fid, finding in by_id.items():
            if fid.split("|", 1)[0] == rule and _fingerprint(
                    finding.to_payload()) == _fingerprint(payload):
                match = finding
                break
        if match is None:
            continue
        out.append(subject_for(match, profile, payload, org_id, period_id,
                               snapshot_hash, gateway=gateway))
    return tuple(out)


def subjects_from_ranked(report: Any, profile: Any, org_id: str,
                         period_id: str, snapshot_hash: str,
                         gateway: Any = None) -> Tuple[ExplainSubject, ...]:
    """Only ``report.surfaced`` — the rows that survived materiality, the
    merge, the rank, dismissal and the cap. The lane sees nothing that
    was held back, so it cannot explain something the reader is not
    shown, and it cannot promote one either."""
    out = []  # type: List[ExplainSubject]
    for ranked in (getattr(report, "surfaced", ()) or ()):
        out.append(subject_for(ranked.finding, profile, ranked.to_payload(),
                               org_id, period_id, snapshot_hash,
                               gateway=gateway))
    return tuple(out)


# ── The output: prose and provenance only ────────────────────────────────


@dataclass(frozen=True)
class Prose:
    """The two text fields, in one language, as primitives."""

    language: str
    rationale: str
    steps: Tuple[Dict[str, Optional[str]], ...]
    source: str                        # "advisory"
    specificity: Optional[float] = None
    attempts: int = 0

    def to_payload(self) -> Dict[str, Any]:
        return {
            "language": self.language,
            "rationale": self.rationale,
            "steps": [dict(s) for s in self.steps],
            "source": self.source,
            "specificity": self.specificity,
            "attempts": self.attempts,
        }


@dataclass(frozen=True)
class Explanation:
    """What the lane returns. Prose, provenance, and an honest status.

    Deliberately NO field for severity, rank, disposition, dismissal or
    the cap — see :data:`RANKING_VOCABULARY`. The structural test
    asserts the dataclass fields are disjoint from that vocabulary; the
    runtime refuses a payload that grew one.
    """

    finding_id: str
    key: str
    status: str
    kind: str
    reason: str
    prompt_version: str
    row_fingerprint: str
    en: Optional[Prose] = None
    ro: Optional[Prose] = None
    ro_absent_reason: str = ""
    review: Tuple[Dict[str, Any], ...] = ()

    @property
    def present(self) -> bool:
        return self.status != STATUS_ABSENT and self.en is not None

    def to_payload(self) -> Dict[str, Any]:
        return {
            "finding_id": self.finding_id,
            "key": self.key,
            "status": self.status,
            "kind": self.kind,
            "reason": self.reason,
            "prompt_version": self.prompt_version,
            "row_fingerprint": self.row_fingerprint,
            "en": self.en.to_payload() if self.en else None,
            "ro": self.ro.to_payload() if self.ro else None,
            "ro_absent_reason": self.ro_absent_reason,
            "review": [dict(r) for r in self.review],
        }


def assert_explanation_is_prose_only(payload: Any, path: str = "explanation") -> None:
    """Refuse an explanation payload carrying a ranking-vocabulary key at
    ANY depth. The runtime half of the structural guarantee."""
    if isinstance(payload, dict):
        for key, value in payload.items():
            if str(key) in RANKING_VOCABULARY:
                raise ExplanationOverreach(
                    "%s.%s: an explanation may carry prose and provenance "
                    "only — %r is ranking vocabulary and the model does not "
                    "rank, grade, cap or suppress" % (path, key, key))
            assert_explanation_is_prose_only(value, "%s.%s" % (path, key))
    elif isinstance(payload, (list, tuple)):
        for n, value in enumerate(payload):
            assert_explanation_is_prose_only(value, "%s[%d]" % (path, n))


def explanation_field_names() -> Tuple[str, ...]:
    """The output dataclasses' field names — what the structural test
    holds against :data:`RANKING_VOCABULARY`."""
    return tuple(f.name for f in fields(Explanation)) + tuple(
        f.name for f in fields(Prose))


def absent(finding_id: str, key: str, kind: str, reason: str,
           row_fingerprint: str = "", prompt_version: str = "") -> Explanation:
    """The honest marker. ``reason`` is a sentence a reader may see; it
    is never a model payload."""
    return Explanation(
        finding_id=finding_id, key=key, status=STATUS_ABSENT, kind=kind,
        reason=_scrub(reason), prompt_version=prompt_version,
        row_fingerprint=row_fingerprint)


def _scrub(reason: str) -> str:
    """A reason is prose. Anything that looks like a payload — a brace, a
    traceback, an SDK call — is replaced by a generic sentence rather
    than shipped."""
    text = str(reason or "").strip()
    if not text:
        return "No explanation is available for this finding."
    low = text.lower()
    if "{" in text or "}" in text or any(
            sig.lower() in low for sig in _RAW_PAYLOAD_SIGNATURES):
        return ("No explanation is available for this finding: the advisory "
                "pass did not produce usable text. The deterministic why-here "
                "and action list are shown instead.")
    return text[:600]


# ── Prompt version and cache key ─────────────────────────────────────────


def prompt_version() -> str:
    """COMPOSITE: this lane's registry row + the drafting prompt + the
    reviewing prompt + the NUMERAL LAW. Any of the four changing
    invalidates every cached explanation, which is the point of keying on
    it — a record cleared by an older, weaker law was never judged by
    this one."""
    own = registry.params_for(ROLE)["prompt_version"]
    return "%s|%s|%s|%s" % (own, FS.DRAFT_PROMPT_VERSION,
                            FS.REVIEW_PROMPT_VERSION, FS.NUMERAL_LAW_VERSION)


def cache_key(org_id: str, period_id: str, snapshot_hash: str,
              finding_id: str, prompt: str) -> str:
    blob = json.dumps({
        "v": CACHE_VERSION, "org": str(org_id or ""),
        "period": str(period_id or ""), "snapshot": str(snapshot_hash or ""),
        "finding": str(finding_id or ""), "prompt": str(prompt or ""),
    }, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def key_for(subject: ExplainSubject, prompt: Optional[str] = None) -> str:
    return cache_key(subject.org_id, subject.period_id, subject.snapshot_hash,
                     subject.finding_id, prompt or prompt_version())


# ── Stores ───────────────────────────────────────────────────────────────


class MemoryExplainStore(object):
    """In-process cache. Tests, and a process that wants no disk."""

    def __init__(self) -> None:
        self.rows = {}  # type: Dict[str, Dict[str, Any]]

    def get(self, key: str) -> Optional[Dict[str, Any]]:
        row = self.rows.get(key)
        return dict(row) if isinstance(row, dict) else None

    def put(self, key: str, record: Dict[str, Any]) -> None:
        self.rows[key] = dict(record)


def _repo_root() -> Path:
    # src/engine/radar/explain.py -> parents[3] == repo root (== /app).
    return Path(__file__).resolve().parents[3]


def cache_dir(explicit: Optional[Any] = None) -> Path:
    if explicit is not None:
        return Path(explicit)
    env = os.environ.get(CACHE_DIR_ENV)
    if env:
        return Path(env)
    return _repo_root() / "data" / "radar_explain"


class FileExplainStore(object):
    """One JSON file per key under the ``data/`` convention the spend
    breaker and the AI journal already use — no new datastore. NEVER
    raises: an unreadable record is a miss, a failed write is a log
    line, and serving proceeds either way."""

    def __init__(self, directory: Optional[Any] = None) -> None:
        self._dir = cache_dir(directory)

    def _path(self, key: str) -> Path:
        safe = re.sub(r"[^0-9a-f]", "", str(key or ""))[:64] or "invalid"
        return self._dir / (safe + ".json")

    def get(self, key: str) -> Optional[Dict[str, Any]]:
        try:
            raw = json.loads(self._path(key).read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        except Exception:  # noqa: BLE001 — a corrupt record is a miss
            logger.warning("[radar.explain] unreadable cache record for %s", key[:12])
            return None
        return raw if isinstance(raw, dict) else None

    def put(self, key: str, record: Dict[str, Any]) -> None:
        try:
            path = self._path(key)
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_name(path.name + ".tmp")
            tmp.write_text(json.dumps(record, sort_keys=True, ensure_ascii=False),
                           encoding="utf-8")
            os.replace(str(tmp), str(path))
        except Exception:  # noqa: BLE001 — a cache write never takes serving down
            logger.warning("[radar.explain] could not persist cache record %s", key[:12])


def default_store() -> Any:
    return FileExplainStore()


# ── The served guard (C1 on this path) ───────────────────────────────────


def _steps_as_actions(steps: Sequence[Dict[str, Any]], lang: str) -> Tuple[Any, ...]:
    F = _F()
    out = []  # type: List[Any]
    for step in steps:
        out.append(F.ActionStep(
            imperative=str(step.get("imperative") or ""),
            artefact=str(step.get("artefact") or ""),
            provider=str(step.get("provider") or ""),
            horizon=(str(step["horizon"]) if step.get("horizon") else None),
            lang=str(step.get("lang") or lang),
        ))
    return tuple(out)


def served_numeral_violations(finding: Any, prose: Optional[Prose]) -> Tuple[str, ...]:
    """Every quantity in the prose about to be SERVED that the engine
    never computed — the ONE numeral law (``finding_sharpen.
    numeral_violations``, through the F9 guard
    ``assert_no_new_numerals``) the drafting lane runs at parse, run
    again here on the served text, so a cache record or a lane bug
    cannot walk a digit, a number word, a currency label, a Unicode
    numeral, a placeholder option or an unresolved placeholder past it.
    Each violation starts with its class."""
    if prose is None:
        return ()
    try:
        FS.assert_no_new_numerals(
            finding, rationale=prose.rationale,
            action_steps=_steps_as_actions(prose.steps, prose.language))
    except FS.AdvisoryNumeralError as exc:
        return tuple(exc.violations)
    return ()


def _numeral_refusal_reason(stage: str, violations: Sequence[str]) -> str:
    """A reader-facing sentence naming the CLASSES refused — never the
    model's text."""
    classes = FS.violation_classes(violations)
    return ("Served explanation refused by the numeral guard: the %s text "
            "carried %d quantit%s the engine never computed (%s). The "
            "deterministic why-here and action list are shown instead."
            % (stage, len(violations), "y" if len(violations) == 1 else "ies",
               ", ".join(classes) or "unclassified"))


def served_contract_problems(finding: Any, en: Optional[Prose],
                             ro: Optional[Prose]) -> Tuple[Tuple[str, ...], Tuple[str, ...]]:
    """The finding contract — anchor, hedge, imperative lexicon, account
    code — re-run on prose about to be served, through the ONE seam."""
    return FS.narrative_contract_problems(
        finding, en.to_payload() if en else None, ro.to_payload() if ro else None)


def served_review_problems(en: Optional[Prose], ro: Optional[Prose],
                           review: Sequence[Dict[str, Any]]) -> Tuple[str, ...]:
    """The self-review — an accepted row per served language at or above
    today's floor, and a numeric specificity on the prose."""
    return FS.review_problems(
        list(review), en.specificity if en else None,
        ro.specificity if ro else None, ro_present=ro is not None)


# ── Cache read ───────────────────────────────────────────────────────────


def _prose_from_record(block: Any) -> Optional[Prose]:
    if not isinstance(block, dict):
        return None
    rationale = block.get("rationale")
    steps_raw = block.get("steps")
    if not isinstance(rationale, str) or not rationale.strip():
        return None
    if not isinstance(steps_raw, list):
        return None
    steps = []  # type: List[Dict[str, Optional[str]]]
    for raw in steps_raw:
        if not isinstance(raw, dict):
            return None
        steps.append(dict(
            (k, (str(raw[k]) if raw.get(k) is not None else None))
            for k in ("imperative", "artefact", "provider", "horizon", "lang")))
    spec = block.get("specificity")
    # `source` is READ here only so a foreign record can be refused; the
    # served Prose is stamped "advisory" by `_from_cache` after every
    # check has passed, never from this field.
    return Prose(
        language=str(block.get("language") or ""),
        rationale=rationale,
        steps=tuple(steps),
        source=str(block.get("source") or ""),
        specificity=(float(spec) if isinstance(spec, (int, float))
                     and not isinstance(spec, bool) else None),
        attempts=int(block.get("attempts") or 0),
    )


@dataclass(frozen=True)
class CacheRead:
    """What a cache read came back as. ``explanation`` is set on a HIT.
    On a miss, ``kind`` is empty for a plain miss (no record, wrong
    version, wrong prompt, unreadable) and one of
    :data:`REFUSED_CACHE_KINDS` when a record existed and was refused —
    with ``reason`` a sentence a reader may see and ``problems`` the
    check's own findings, for the journal."""

    explanation: Optional[Explanation] = None
    kind: str = ""
    reason: str = ""
    problems: Tuple[str, ...] = ()

    @property
    def hit(self) -> bool:
        return self.explanation is not None


def _refused(kind: str, reason: str, problems: Sequence[str],
             subject: ExplainSubject, key: str, event: str,
             journal_dir: Optional[Any]) -> CacheRead:
    FS.journal_record({"lane": LANE, "event": event, "stage": "served_from_cache",
                       "kind": kind, "finding_id": subject.finding_id,
                       "period_id": subject.period_id, "key": key,
                       "problems": list(problems)[:12]}, journal_dir)
    return CacheRead(kind=kind, reason=reason, problems=tuple(problems))


def _from_cache(store: Any, key: str, subject: ExplainSubject,
                prompt: str, journal_dir: Optional[Any]) -> CacheRead:
    """A cache record is DATA written earlier, trusted no more than a
    fresh draft. On EVERY read it must pass what a fresh draft passes:

      1. the record is this lane's (version, prompt version, and a
         numeric fingerprint matching the finding it is served against —
         the figures resolved into its prose belonged to these numbers);
      2. the NUMERAL LAW, on every rationale and step, both languages;
      3. the FINDING CONTRACT through the one seam — anchor, hedge,
         imperative lexicon, account code (English), the Romanian gate;
      4. the SELF-REVIEW — an accepted score row per served language at
         or above TODAY's floor, and a numeric specificity on the prose;
      5. ``source`` — a record that does not claim ``advisory`` was not
         written by this lane; and the served source is never the
         record's field, it is re-derived once 1-4 have passed.

    A record failing any of these is a MISS carrying its kind.
    """
    try:
        record = store.get(key)
    except Exception:  # noqa: BLE001 — a failing store is a miss
        logger.warning("[radar.explain] cache read failed for %s", key[:12])
        return CacheRead()
    if not isinstance(record, dict) or record.get("v") != CACHE_VERSION:
        return CacheRead()
    if record.get("prompt_version") != prompt:
        return CacheRead()
    F = _F()
    try:
        current_fp = F._numeric_fingerprint(subject.finding)
    except Exception:  # noqa: BLE001
        return CacheRead()
    if record.get("numeric_fingerprint") != current_fp:
        return _refused(
            KIND_STALE_CACHE,
            "The explanation on file was drafted against different figures "
            "for this finding; the deterministic why-here and action list "
            "are shown while it is redrafted.",
            ("numeric fingerprint moved",), subject, key, "stale_cache",
            journal_dir)
    en = _prose_from_record(record.get("en"))
    if en is None:
        return CacheRead()
    ro = _prose_from_record(record.get("ro"))

    # 2. the numeral law
    for prose in (en, ro):
        violations = served_numeral_violations(subject.finding, prose)
        if violations:
            return _refused(
                KIND_NUMERAL_REFUSED, _numeral_refusal_reason("cached", violations),
                violations, subject, key, "numeral_refusal", journal_dir)

    # 3. the finding contract, through the seam
    en_problems, ro_problems = served_contract_problems(subject.finding, en, ro)
    if en_problems or ro_problems:
        return _refused(
            KIND_CONTRACT_REFUSED,
            "Served explanation refused by the finding contract: the cached "
            "text no longer meets it (%s). The deterministic why-here and "
            "action list are shown instead."
            % _contract_summary(en_problems, ro_problems),
            tuple(en_problems) + tuple(ro_problems), subject, key,
            "contract_refusal", journal_dir)

    # 4. the self-review, at today's floor
    review_raw = record.get("review")
    review = tuple(dict(r) for r in review_raw if isinstance(r, dict)) \
        if isinstance(review_raw, list) else ()
    review_issues = served_review_problems(en, ro, review)
    # 5. provenance — the record must claim what this lane writes
    if en.source != "advisory" or (ro is not None and ro.source != "advisory"):
        review_issues = review_issues + (
            "the record's source is not the advisory pass",)
    if review_issues:
        return _refused(
            KIND_REVIEW_MISSING,
            "Served explanation refused: the cached text carries no "
            "adversarial specificity review at or above the floor, so it "
            "was never cleared by the anti-generic net. The deterministic "
            "why-here and action list are shown instead.",
            review_issues, subject, key, "review_refusal", journal_dir)

    return CacheRead(explanation=Explanation(
        finding_id=subject.finding_id, key=key, status=STATUS_CACHED, kind="",
        reason=("Explanation served from cache; re-checked on read against "
                "the numeral law, the finding contract and the specificity "
                "floor."),
        prompt_version=prompt,
        row_fingerprint=subject.row_fingerprint,
        en=replace(en, source="advisory"),
        ro=(replace(ro, source="advisory") if ro is not None else None),
        ro_absent_reason=str(record.get("ro_absent_reason") or ""),
        review=review,
    ))


def _contract_summary(en_problems: Sequence[str], ro_problems: Sequence[str]) -> str:
    """Which element refused — a label, never the model's text."""
    labels = []  # type: List[str]
    for problem in list(en_problems) + list(ro_problems):
        low = str(problem).lower()
        if "anchor" in low:
            label = "anchor"
        elif "banned phrasing" in low or "hedge" in low:
            label = "hedge"
        elif "imperative" in low or "verb" in low:
            label = "imperative"
        elif "account" in low:
            label = "account code"
        elif "figure" in low:
            label = "figure"
        else:
            label = "contract element"
        if label not in labels:
            labels.append(label)
    return ", ".join(labels) or "contract element"


# ── The critical-path call: cache only ───────────────────────────────────


def attach_cached(subjects: Sequence[ExplainSubject], store: Any = None,
                  journal_dir: Optional[Any] = None) -> List[Explanation]:
    """What the route may call BEFORE returning its rows.

    Cache-only, by construction: no client factory is accepted, no
    breaker is consulted, no model is reachable from here. A miss is the
    honest ``not_yet_explained`` marker. Every failure — a broken
    registry, a failing store — is a marker too, never an exception into
    the route.
    """
    out = []  # type: List[Explanation]
    try:
        prompt = prompt_version()
    except Exception:  # noqa: BLE001 — a broken registry must not take rows down
        logger.warning("[radar.explain] registry unavailable; explanations absent")
        for subject in subjects:
            out.append(absent(
                subject.finding_id, "", KIND_REGISTRY_ERROR,
                "No explanation is available: the model registry could not be "
                "read. The deterministic why-here and action list are shown "
                "instead.", row_fingerprint=subject.row_fingerprint))
        return out
    store = store if store is not None else default_store()
    for subject in subjects:
        key = key_for(subject, prompt)
        read = _from_cache(store, key, subject, prompt, journal_dir)
        if read.hit:
            out.append(read.explanation)
            continue
        if read.kind in REFUSED_CACHE_KINDS:
            # The record existed and was refused: the reader is told why,
            # and the after-rows path redrafts it.
            out.append(absent(subject.finding_id, key, read.kind, read.reason,
                              row_fingerprint=subject.row_fingerprint,
                              prompt_version=prompt))
            continue
        out.append(absent(
            subject.finding_id, key, KIND_NOT_YET,
            "No explanation has been drafted for this finding yet; the "
            "deterministic why-here and action list are shown.",
            row_fingerprint=subject.row_fingerprint, prompt_version=prompt))
    return out


# ── The after-rows call: draft, gate, cache ──────────────────────────────


_REVIEW_KEYS = ("language", "attempt", "specificity", "reads_identically",
                "accepted", "outcome", "floor", "draft_model", "review_model")
#: The review-row half of the payload contract (see the module docstring).
REVIEW_ROW_KEYS = frozenset(_REVIEW_KEYS)


def _review_rows(scores: Sequence[Dict[str, Any]]) -> Tuple[Dict[str, Any], ...]:
    """The score rows, STRIPPED to numbers and labels. The journal keeps
    the candidate text, the critique and the generic spans; a served
    shape carries none of them — a rejected draft is a model payload."""
    out = []  # type: List[Dict[str, Any]]
    for row in scores:
        if not isinstance(row, dict):
            continue
        out.append(dict((k, row.get(k)) for k in _REVIEW_KEYS if k in row))
    return tuple(out)


def _prose_from_narrative(narrative: Any) -> Optional[Prose]:
    if narrative is None:
        return None
    steps = []  # type: List[Dict[str, Optional[str]]]
    for step in (getattr(narrative, "steps", ()) or ()):
        steps.append({
            "imperative": str(getattr(step, "imperative", "") or ""),
            "artefact": str(getattr(step, "artefact", "") or ""),
            "provider": str(getattr(step, "provider", "") or ""),
            "horizon": (str(getattr(step, "horizon")) if getattr(step, "horizon", None)
                        else None),
            "lang": str(getattr(step, "lang", "") or getattr(narrative, "language", "")),
        })
    return Prose(
        language=str(getattr(narrative, "language", "") or ""),
        rationale=str(getattr(narrative, "rationale", "") or ""),
        steps=tuple(steps),
        source=str(getattr(narrative, "source", "") or ""),
        specificity=getattr(narrative, "specificity", None),
        attempts=int(getattr(narrative, "attempts", 0) or 0),
    )


def _record(expl: Explanation, subject: ExplainSubject) -> Dict[str, Any]:
    F = _F()
    return {
        "v": CACHE_VERSION,
        "key": expl.key,
        "finding_id": expl.finding_id,
        "org_id": subject.org_id,
        "period_id": subject.period_id,
        "snapshot_hash": subject.snapshot_hash,
        "prompt_version": expl.prompt_version,
        "numeric_fingerprint": F._numeric_fingerprint(subject.finding),
        "en": expl.en.to_payload() if expl.en else None,
        "ro": expl.ro.to_payload() if expl.ro else None,
        "ro_absent_reason": expl.ro_absent_reason,
        "review": [dict(r) for r in expl.review],
    }


def explain_one(subject: ExplainSubject, store: Any = None,
                client_factory: Optional[Callable[[], Any]] = None,
                reviewer_factory: Optional[Callable[[], Any]] = None,
                state_dir: Optional[Any] = None,
                journal_dir: Optional[Any] = None,
                decoy_profile: Any = None,
                floor: Optional[float] = None,
                refresh: bool = False) -> Explanation:
    """Explain ONE surfaced row: cache, then the lane budget, then the
    drafting lane through the seam, then the served guard, then the
    cache. Returns an :class:`Explanation` in every state and never
    raises for an AI reason."""
    store = store if store is not None else default_store()
    try:
        prompt = prompt_version()
    except Exception:  # noqa: BLE001
        return absent(subject.finding_id, "", KIND_REGISTRY_ERROR,
                      "No explanation is available: the model registry could "
                      "not be read. The deterministic why-here and action list "
                      "are shown instead.", row_fingerprint=subject.row_fingerprint)
    key = key_for(subject, prompt)
    if not refresh:
        read = _from_cache(store, key, subject, prompt, journal_dir)
        if read.hit:
            return read.explanation
        # A refused record is a MISS: it is redrafted below (one
        # regeneration inside the drafting lane, then the deterministic
        # template) — never served, never left to be served next time.

    # ── the lane's own budget, BEFORE any client exists ──────────────
    try:
        breaker.check(ROLE, state_dir=state_dir)
    except breaker.BreakerOpen as exc:
        FS.journal_record({"lane": LANE, "event": "degraded", "kind": KIND_BREAKER_OPEN,
                           "finding_id": subject.finding_id,
                           "period_id": subject.period_id, "reason": exc.reason},
                          journal_dir)
        return absent(
            subject.finding_id, key, KIND_BREAKER_OPEN,
            "Explanations are paused: the daily spend cap for the '%s' role is "
            "exhausted (%s). The deterministic why-here and action list are "
            "shown instead." % (ROLE, exc.reason),
            row_fingerprint=subject.row_fingerprint, prompt_version=prompt)

    # ── the drafting lane, through the ONE seam ───────────────────────
    try:
        result = FS.sharpen_finding(
            subject.finding, subject.profile,
            gateway_facts=subject.gateway_facts,
            client_factory=client_factory, reviewer_factory=reviewer_factory,
            decoy_profile=decoy_profile, state_dir=state_dir,
            journal_dir=journal_dir, floor=floor)
    except Exception as exc:  # noqa: BLE001 — a lane bug is a marker, not an outage
        logger.exception("[radar.explain] drafting lane raised on %s", subject.finding_id)
        FS.journal_record({"lane": LANE, "event": "degraded", "kind": KIND_LANE_ERROR,
                           "finding_id": subject.finding_id,
                           "period_id": subject.period_id,
                           "error": type(exc).__name__}, journal_dir)
        return absent(
            subject.finding_id, key, KIND_LANE_ERROR,
            "No explanation is available: the advisory pass failed (%s). The "
            "deterministic why-here and action list are shown instead."
            % type(exc).__name__,
            row_fingerprint=subject.row_fingerprint, prompt_version=prompt)
    finally:
        # One lane call per explained finding, counted whatever happened
        # (the drafting roles count their own calls inside the lane).
        try:
            breaker.record(ROLE, tokens=int(registry.params_for(ROLE)["max_tokens"]),
                           state_dir=state_dir)
        except Exception:  # noqa: BLE001 — counting is best-effort
            pass

    review = _review_rows(getattr(result, "scores", ()) or ())
    if getattr(result, "degraded", True):
        FS.journal_record({"lane": LANE, "event": "degraded",
                           "kind": KIND_ADVISORY_UNAVAILABLE,
                           "finding_id": subject.finding_id,
                           "period_id": subject.period_id,
                           "reason": str(getattr(result, "reason", ""))[:400]},
                          journal_dir)
        out = absent(subject.finding_id, key, KIND_ADVISORY_UNAVAILABLE,
                     str(getattr(result, "reason", "") or ""),
                     row_fingerprint=subject.row_fingerprint, prompt_version=prompt)
        return Explanation(**dict(_as_kwargs(out), review=review))

    en = _prose_from_narrative(result.en)
    ro = _prose_from_narrative(result.ro)
    if en is None or en.source != "advisory":
        return absent(subject.finding_id, key, KIND_ADVISORY_UNAVAILABLE,
                      "No explanation is available: the advisory pass returned "
                      "no English narrative. The deterministic why-here and "
                      "action list are shown instead.",
                      row_fingerprint=subject.row_fingerprint, prompt_version=prompt)

    # ── the served guard: C1 on this path, on the text about to ship ──
    for prose in (en, ro):
        violations = served_numeral_violations(subject.finding, prose)
        if violations:
            FS.journal_record({"lane": LANE, "event": "numeral_refusal",
                               "stage": "served_fresh",
                               "finding_id": subject.finding_id,
                               "period_id": subject.period_id,
                               "violations": list(violations)}, journal_dir)
            return absent(
                subject.finding_id, key, KIND_NUMERAL_REFUSED,
                _numeral_refusal_reason("drafted", violations),
                row_fingerprint=subject.row_fingerprint, prompt_version=prompt)
    # The drafting lane enforced the review floor; it is re-asserted here
    # on the shape about to be cached, so a lane bug cannot cache — and
    # later serve — a draft the net never cleared.
    review_issues = served_review_problems(en, ro, review)
    if review_issues:
        FS.journal_record({"lane": LANE, "event": "review_refusal",
                           "stage": "served_fresh",
                           "finding_id": subject.finding_id,
                           "period_id": subject.period_id,
                           "problems": list(review_issues)}, journal_dir)
        return absent(
            subject.finding_id, key, KIND_REVIEW_MISSING,
            "Served explanation refused: the drafted text carries no "
            "adversarial specificity review at or above the floor. The "
            "deterministic why-here and action list are shown instead.",
            row_fingerprint=subject.row_fingerprint, prompt_version=prompt)

    expl = Explanation(
        finding_id=subject.finding_id, key=key, status=STATUS_FRESH, kind="",
        reason="Explanation drafted by the advisory pass, cleared by the "
               "adversarial specificity review and the served numeral law; "
               "every figure is the engine's own.",
        prompt_version=prompt, row_fingerprint=subject.row_fingerprint,
        en=en, ro=ro,
        ro_absent_reason=("" if ro is not None else FS.RO_ABSENT_REASON),
        review=review,
    )
    try:
        store.put(key, _record(expl, subject))
    except Exception:  # noqa: BLE001 — a cache write never takes serving down
        logger.warning("[radar.explain] cache write failed for %s", key[:12])
    FS.journal_record({"lane": LANE, "event": "explained",
                       "finding_id": subject.finding_id,
                       "period_id": subject.period_id, "key": key,
                       "specificity_en": en.specificity,
                       "specificity_ro": (ro.specificity if ro else None),
                       "ro_present": ro is not None}, journal_dir)
    return expl


def _as_kwargs(expl: Explanation) -> Dict[str, Any]:
    return dict((f.name, getattr(expl, f.name)) for f in fields(Explanation))


def explain_subjects(subjects: Sequence[ExplainSubject], **kwargs: Any
                     ) -> Iterator[Explanation]:
    """LAZY. Nothing is drafted until the caller iterates — which is what
    lets a route return its rows first and stream explanations after."""
    for subject in subjects:
        yield explain_one(subject, **kwargs)


def explain_rows(subjects: Sequence[ExplainSubject], **kwargs: Any) -> List[Explanation]:
    return list(explain_subjects(subjects, **kwargs))


def explain_in_background(subjects: Sequence[ExplainSubject],
                          on_done: Optional[Callable[[List[Explanation]], None]] = None,
                          **kwargs: Any) -> threading.Thread:
    """Draft after the rows have gone out. A daemon thread that fills the
    cache; the next :func:`attach_cached` finds the results. Never
    raises into the caller."""

    def _run() -> None:
        out = []  # type: List[Explanation]
        try:
            for expl in explain_subjects(subjects, **kwargs):
                out.append(expl)
        except Exception:  # noqa: BLE001
            logger.exception("[radar.explain] background explanation failed")
        if on_done is not None:
            try:
                on_done(out)
            except Exception:  # noqa: BLE001
                logger.exception("[radar.explain] on_done callback failed")

    thread = threading.Thread(target=_run, name="radar-explain", daemon=True)
    thread.start()
    return thread


# ── Attaching to rows ────────────────────────────────────────────────────


def attach(rows: Sequence[Dict[str, Any]], explanations: Sequence[Explanation],
           subjects: Sequence[ExplainSubject] = ()) -> List[Dict[str, Any]]:
    """Copy each row and set ONE key, ``explanation``. Nothing else on
    the row is touched, and an explanation is attached only to the row
    it was drafted for (same finding id, same row fingerprint) — a row
    whose ranking moved since the draft gets the honest marker instead.

    Refuses an explanation carrying ranking vocabulary at any depth.
    """
    by_id = {}  # type: Dict[str, Explanation]
    for expl in explanations:
        by_id[expl.finding_id] = expl
    fp_by_id = {}  # type: Dict[str, str]
    for subject in subjects:
        fp_by_id[subject.finding_id] = subject.row_fingerprint
    out = []  # type: List[Dict[str, Any]]
    for row in rows:
        # Projected, not deep-copied: a copy that falls back to `str()`
        # would run a planted object's __repr__ on the way through.
        fresh = project_row(row)
        fid = _row_identity(fresh)
        expl = by_id.get(fid)
        if expl is None:
            fresh["explanation"] = absent(
                fid, "", KIND_NOT_YET,
                "No explanation has been drafted for this finding yet; the "
                "deterministic why-here and action list are shown.").to_payload()
        else:
            payload = expl.to_payload()
            assert_explanation_is_prose_only(payload)
            expected_fp = fp_by_id.get(fid)
            if (expected_fp is not None and expl.row_fingerprint
                    and expl.row_fingerprint != expected_fp):
                payload = absent(
                    fid, expl.key, KIND_STALE_CACHE,
                    "The explanation on file was drafted for a different ranking "
                    "of this finding; the deterministic why-here and action list "
                    "are shown.", row_fingerprint=expected_fp,
                    prompt_version=expl.prompt_version).to_payload()
            fresh["explanation"] = payload
        out.append(fresh)
    return out


def _row_identity(row: Dict[str, Any]) -> str:
    """The same ``rule_id|codes`` id :func:`finding_identity` derives from
    a Finding, read off its payload."""
    rule = str(row.get("rule_key") or row.get("rule_id") or "")
    elements = row.get("contract_elements") or {}
    subject = elements.get("subject") if isinstance(elements, dict) else None
    codes = []  # type: List[str]
    for account in ((subject or {}).get("accounts") or []) if isinstance(subject, dict) else []:
        code = str((account or {}).get("code") or "").strip() if isinstance(account, dict) else ""
        if code:
            codes.append(code)
    return "%s|%s" % (rule, ",".join(codes))


# ── Structural guard over the package's model-free modules ───────────────

_MODEL_IMPORT_ROOTS = ("engine.ai", "engine.ai_lane", "anthropic")


def critical_path_violations(paths: Optional[Sequence[Any]] = None) -> List[str]:
    """Statically: no module of ``engine.radar`` other than this one may
    import a model lane or call a model. Ranking, the cap, dismissal and
    serving must stay model-free by SHAPE, so the check is on the
    source, not on a runtime flag."""
    targets = [Path(p) for p in paths] if paths is not None else list(model_free_modules())
    out = []  # type: List[str]
    for path in targets:
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            out.append("%s could not be parsed: %s" % (path.name, type(exc).__name__))
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    if _is_model_root(alias.name):
                        out.append("%s imports %s" % (path.name, alias.name))
            elif isinstance(node, ast.ImportFrom):
                mod = node.module or ""
                if (node.level and mod == "explain") or mod == "engine.radar.explain":
                    out.append("%s imports the explain lane" % path.name)
                if _is_model_root(mod):
                    out.append("%s imports %s" % (path.name, mod))
                for alias in node.names:
                    if mod in ("engine", "") and _is_model_root(alias.name):
                        out.append("%s imports %s" % (path.name, alias.name))
                    if alias.name == "explain" and (
                            (node.level and mod == "") or mod == "engine.radar"):
                        out.append("%s imports the explain lane" % path.name)
            elif isinstance(node, ast.Attribute) and node.attr == "create":
                base = node.value
                if isinstance(base, ast.Attribute) and base.attr == "messages":
                    out.append("%s calls messages.create" % path.name)
    return out


def _is_model_root(name: str) -> bool:
    for root in _MODEL_IMPORT_ROOTS:
        if name == root or name.startswith(root + "."):
            return True
    return name in ("ai", "ai_lane")


class CriticalPathViolation(RuntimeError):
    """A model-free module of this package reaches a model."""


def assert_no_model_in_critical_path(paths: Optional[Sequence[Any]] = None) -> None:
    violations = critical_path_violations(paths)
    if violations:
        raise CriticalPathViolation("; ".join(violations))


__all__ = [
    "ROLE", "LANE", "CACHE_VERSION", "CACHE_DIR_ENV",
    "STATUS_CACHED", "STATUS_FRESH", "STATUS_ABSENT",
    "KIND_NOT_YET", "KIND_BREAKER_OPEN", "KIND_ADVISORY_UNAVAILABLE",
    "KIND_NUMERAL_REFUSED", "KIND_CONTRACT_REFUSED", "KIND_REVIEW_MISSING",
    "KIND_STALE_CACHE", "KIND_LANE_ERROR", "KIND_REGISTRY_ERROR",
    "ABSENT_KINDS", "REFUSED_CACHE_KINDS", "RANKING_VOCABULARY",
    "EXPLANATION_PAYLOAD_KEYS", "PROSE_PAYLOAD_KEYS", "STEP_PAYLOAD_KEYS",
    "REVIEW_ROW_KEYS",
    "ExplainSubject", "Prose", "Explanation", "ExplanationOverreach",
    "CriticalPathViolation", "CacheRead",
    "finding_identity", "project_row", "snapshot_hash_of", "subject_for",
    "subjects_from_result", "subjects_from_ranked",
    "assert_explanation_is_prose_only", "explanation_field_names", "absent",
    "prompt_version", "cache_key", "key_for",
    "MemoryExplainStore", "FileExplainStore", "default_store", "cache_dir",
    "served_numeral_violations", "served_contract_problems",
    "served_review_problems",
    "attach_cached", "explain_one", "explain_subjects", "explain_rows",
    "explain_in_background", "attach",
    "model_free_modules", "critical_path_violations",
    "assert_no_model_in_critical_path",
]
