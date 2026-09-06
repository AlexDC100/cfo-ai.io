"""FIRM COCKPIT — "Brief me" (engine.api._firm_brief). The ONE place a
model enters the cockpit, and everything that keeps it advisory.

WHAT THE MODEL DOES
  Writes the morning brief FROM the computed attention items: an
  opening, a grouping with a rationale per group, and a suggested
  reading order. It receives NO FIGURE — item ids, client names, kinds,
  severities, the engine's own due-status words and prose, and the
  NAMES of the typed facts it may cite as placeholders. It never sees a
  number it could copy, so it cannot invent one that looks computed.

WHAT THE MODEL CANNOT DO — asserted, not promised
  · RANK. `order` in the payload is `engine.firm.digest.deterministic_
    order`, computed BEFORE the call and never touched after it; the
    model's `suggested_order` ships beside it labeled advisory, and
    must be a permutation of the same ids (a dropped id is a
    suppression, a foreign id is a fabrication — both rejected).
  · SET A SEVERITY or SUPPRESS an item: the grouping must cover every
    item exactly once; a group that omits one is rejected whole.
  · AUTHOR A DIGIT. Every text passes engine.ai.numerals in ENFORCE
    mode: a placeholder resolves from a typed fact (money with its own
    currency, ratios, counts, labels); a bare numeral, a loose currency
    word, an unresolved or absent placeholder is a REJECTION at parse
    and the deterministic brief ships instead. Same guard, same
    semantics as the finding-sharpen lane's templatize-then-check.
  · REACH THE RANKING PATH. `engine.firm.digest.assert_no_model_in_
    critical_path` scans cadence.py and digest.py for any AI import or
    client token; the router asserts it at mount, and the FC8 gate
    plants a model call there and proves the assertion reds.

WHEN THE MODEL IS DEAD (no key, breaker open, bad JSON, rejected draft)
  the brief is the deterministic one — every item, the same order, the
  engine's own rationale per item — with an honest notice and ZERO raw
  model payload anywhere in the response (FC8).

CACHE. One brief per (firm, day, item-set hash); only a brief the model
  contributed to is cached — a degraded one is recomputed so the role
  is retried once the model is back. The cache row is WRITTEN AS THE
  CALLER (`firm_briefs firm write` / `firm update`, RLS) and carries the
  CLIENT dimension — every client the brief names — so a brief is
  readable by a firm only while every one of them is still that firm's
  (W1 / W5). An RLS refusal is recorded on the store (`last_put`) and
  the brief is served uncached, never a 500.

Python 3.9 — no `match`, no `X | Y` unions.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from engine.ai import breaker, numerals as N, registry
from engine.firm import digest as DG

from . import _firm_requests as FR
from . import _supabase

logger = logging.getLogger(__name__)

ROLE = "firm_brief"
BRIEF_VERSION = "firm_brief_v1"
MAX_ITEMS_IN_PROMPT = 60
MAX_TEXT_CHARS = 600

_SLUG_RX = re.compile(r"^i\d+$")
_FIGURE_RX = re.compile(r"\d[\d.,:/\-]*")


def mask_figures(text: Any) -> str:
    """Prose handed to the model with every digit run replaced: a date,
    a count or an amount the engine wrote into a reason is still a
    figure, and the model must cite figures by placeholder only."""
    return _FIGURE_RX.sub("‹figure›", str(text or ""))


class BriefUnavailable(Exception):
    """The advisory brief could not be produced; `kind` names why
    (credits_absent | breaker_open | model_error | rejected)."""

    def __init__(self, message: str, kind: str) -> None:
        super().__init__(message)
        self.kind = kind


# ══════════════════════════════════════════════════════════════════════════
# 1. THE VIEW — what the model may see (no figure), and the guard's facts
# ══════════════════════════════════════════════════════════════════════════


def fact_to_numeral(fact: DG.ItemFact) -> Any:
    """A typed item fact as the numeral guard's own fact type, so a
    placeholder resolves with the value AND its unit/currency from ONE
    object."""
    if fact.kind == "money":
        return N.MoneyFact(fact.amount, str(fact.currency or ""))
    if fact.kind == "ratio":
        kind = {"ratio": "ratio", "pct": "pct", "multiple": "multiple"}[fact.style]
        return N.RatioFact(fact.value, kind)
    if fact.kind == "count":
        return N.CountFact(fact.value, fact.unit)
    return N.LabelFact(fact.text)


@dataclass(frozen=True)
class BriefView:
    as_of: date
    firm_key: str
    items: Tuple[DG.AttentionItem, ...]          # deterministic order
    groups: Tuple[DG.Group, ...]                 # deterministic groups
    slugs: Dict[str, str]                        # item_id -> "i7"
    facts: Dict[str, Any]                        # "i7__total_assets" -> numeral fact
    item_set_hash: str

    def item_ids(self) -> List[str]:
        return [it.item_id for it in self.items]

    def by_slug(self) -> Dict[str, str]:
        return dict((slug, item_id) for item_id, slug in self.slugs.items())


def build_view(items: Sequence[DG.AttentionItem], as_of: date, firm_key: str) -> BriefView:
    ordered = tuple(DG.deterministic_order(items, as_of))
    slugs = {}  # type: Dict[str, str]
    facts = {}  # type: Dict[str, Any]
    for index, item in enumerate(ordered):
        slug = "i%d" % (index + 1)
        slugs[item.item_id] = slug
        for fact in item.facts:
            facts["%s__%s" % (slug, fact.name)] = fact_to_numeral(fact)
    return BriefView(as_of=as_of, firm_key=firm_key, items=ordered,
                     groups=tuple(DG.group_items(ordered, as_of)), slugs=slugs,
                     facts=facts, item_set_hash=DG.item_set_hash(ordered))


def user_text(view: BriefView) -> str:
    """The model's input. Deliberately NO numeric value anywhere: due
    status is the engine's own words, facts are listed by NAME with
    their kind so the model can cite them as placeholders."""
    rows = []  # type: List[Dict[str, Any]]
    for item in view.items[:MAX_ITEMS_IN_PROMPT]:
        slug = view.slugs[item.item_id]
        rows.append({
            "slug": slug,
            "item_id": item.item_id,
            "client": mask_figures(item.client_name),
            "kind": item.kind,
            "severity": item.severity,
            "status": mask_figures(DG.priority_rationale(item, view.as_of)),
            "reason": mask_figures(item.reason),
            "action": mask_figures(item.action),
            "dismissed_but_visible": item.dismissed,
            "placeholders": ["{%s__%s}" % (slug, f.name) for f in item.facts
                             if not f.is_absent()],
            "fact_labels": dict((f.name, mask_figures(f.label_text)) for f in item.facts),
        })
    return json.dumps({
        "as_of": view.as_of.isoformat(),
        "item_count": len(view.items),
        "items": rows,
        "engine_groups": [g.to_payload() for g in view.groups],
    }, ensure_ascii=False, sort_keys=True)


_SYSTEM = (
    "You write a short morning brief for an accountant who serves many client "
    "companies, from a list of ATTENTION ITEMS the engine already computed and "
    "ranked. Answer with ONE JSON object and nothing else, shaped exactly:\n"
    '{"opening": "<one or two sentences>", '
    '"groups": [{"title": "<short title>", "item_ids": ["<item_id>", ...], '
    '"rationale": "<why these come together and what to do first>"}], '
    '"suggested_order": ["<item_id>", ...]}\n'
    "RULES, each enforced by a parser that rejects the whole answer:\n"
    "1. Every item_id in the input appears in EXACTLY ONE group. Never drop one, "
    "never invent one.\n"
    "2. suggested_order lists EVERY item_id exactly once. The engine's order is "
    "authoritative; yours is a suggestion shown beside it.\n"
    "3. NEVER write a digit. Not a number, not a date, not a percentage, not a "
    "count, not a year. To mention a figure, write its placeholder verbatim, e.g. "
    "{i3__total_assets} — only placeholders listed for that item. Do not write a "
    "currency word (RON, EUR, USD) either; the placeholder carries it.\n"
    "4. Plain language. No praise, no filler, no advice beyond the items.\n"
    "5. Keep item_ids exactly as given."
)

_SUMMARY_SYSTEM = (
    "You write ONE sentence summarising, for an accountant, what needs attention "
    "across their clients today, from the attention items given. Answer with ONE "
    'JSON object: {"summary": "<one sentence>"}. NEVER write a digit or a currency '
    "word; to mention a figure write its placeholder verbatim (e.g. "
    "{i2__cash}) — only placeholders listed for that item. Name clients by name."
)


# ══════════════════════════════════════════════════════════════════════════
# 2. THE CALL — breaker-guarded, registry-resolved, strict JSON
# ══════════════════════════════════════════════════════════════════════════


def _estimated_tokens(text: str, max_tokens: int) -> int:
    return int(len(text or "") / 4) + int(max_tokens or 0)


def _client_for(client_factory: Optional[Callable[[], Any]], state_dir: Optional[Any]) -> Any:
    guarded = breaker.guarded_client_factory(ROLE, client_factory, state_dir=state_dir)
    try:
        return guarded()
    except breaker.BreakerOpen as exc:
        raise BriefUnavailable(
            "The advisory brief is paused: the daily spend cap for the '%s' role is "
            "exhausted (%s). The deterministic brief is shown instead." % (ROLE, exc.reason),
            kind="breaker_open")
    except Exception as exc:  # noqa: BLE001 — missing key / missing SDK
        raise BriefUnavailable(
            "The advisory brief is unavailable: no usable model client could be built "
            "for the '%s' role (%s). The deterministic brief is shown instead."
            % (ROLE, type(exc).__name__), kind="credits_absent")


def _call_json(client: Any, system: str, text: str, state_dir: Optional[Any]) -> Dict[str, Any]:
    from engine.ai_lane.schemas import AiLaneError

    params = registry.params_for(ROLE)
    max_tokens = int(params["max_tokens"])
    try:
        from engine.ai_lane._client import call_strict_json

        data = call_strict_json(client, stage=ROLE, prompt_version=str(params["prompt_version"]),
                                system=system, user_text=text, max_tokens=max_tokens)
    except AiLaneError as exc:
        raise BriefUnavailable(
            "The advisory brief did not complete: the '%s' model did not return usable "
            "JSON (%s). The deterministic brief is shown instead." % (ROLE, type(exc).__name__),
            kind="model_error")
    finally:
        breaker.record(ROLE, tokens=_estimated_tokens(text, max_tokens), state_dir=state_dir)
    if not isinstance(data, dict):
        raise BriefUnavailable("The advisory brief did not complete: the model returned a "
                               "shape this lane does not accept.", kind="model_error")
    return data


# ══════════════════════════════════════════════════════════════════════════
# 3. THE GUARD — templatize-then-check on every text, structure on the rest
# ══════════════════════════════════════════════════════════════════════════


@dataclass(frozen=True)
class GuardedText:
    text: str
    facts_used: Tuple[str, ...]


def guard_text(raw: Any, facts: Dict[str, Any], what: str) -> Tuple[Optional[GuardedText], List[str]]:
    """ENFORCE-mode numeral guard over one model text. Returns the
    rendered text (placeholders resolved from typed facts) or the
    rejection codes — never the model's raw words when rejected."""
    if not isinstance(raw, str) or not raw.strip():
        return None, ["%s: not text" % what]
    if len(raw) > MAX_TEXT_CHARS * 4:
        return None, ["%s: too long" % what]
    result = N.guard(raw.strip(), facts, fallback="", mode=N.MODE_ENFORCE)
    if not result.accepted:
        codes = sorted(set(r.code for r in result.rejections))
        return None, ["%s: %s" % (what, ", ".join(codes))]
    return GuardedText(result.text, tuple(result.resolved)), []


def validate_draft(draft: Any, view: BriefView) -> Tuple[Optional[Dict[str, Any]], List[str]]:
    """The whole answer or nothing: every text guarded, every id known,
    every item in exactly one group, the suggested order a permutation."""
    reasons = []  # type: List[str]
    if not isinstance(draft, dict):
        return None, ["draft is not an object"]
    known = view.item_ids()
    known_set = set(known)
    facts_used = []  # type: List[str]

    opening, bad = guard_text(draft.get("opening"), view.facts, "opening")
    reasons.extend(bad)
    if opening:
        facts_used.extend(opening.facts_used)

    groups_out = []  # type: List[Dict[str, Any]]
    covered = []  # type: List[str]
    groups = draft.get("groups")
    if not isinstance(groups, list) or not groups:
        reasons.append("groups: missing or empty")
        groups = []
    for index, group in enumerate(groups):
        if not isinstance(group, dict):
            reasons.append("group %d: not an object" % index)
            continue
        title, bad = guard_text(group.get("title"), view.facts, "group %d title" % index)
        reasons.extend(bad)
        rationale, bad = guard_text(group.get("rationale"), view.facts,
                                    "group %d rationale" % index)
        reasons.extend(bad)
        ids = group.get("item_ids")
        if not isinstance(ids, list) or not ids:
            reasons.append("group %d: no item_ids — a claim must name its items" % index)
            ids = []
        clean = []  # type: List[str]
        for raw_id in ids:
            item_id = str(raw_id)
            if item_id not in known_set:
                reasons.append("group %d: unknown item_id %r" % (index, item_id[:80]))
                continue
            clean.append(item_id)
        covered.extend(clean)
        if title and rationale and clean:
            facts_used.extend(title.facts_used)
            facts_used.extend(rationale.facts_used)
            groups_out.append({"title": title.text, "item_ids": clean,
                               "rationale": rationale.text})
    missing = [i for i in known if i not in set(covered)]
    if missing:
        reasons.append("groups omit %d item(s) — a dropped item is a suppression"
                       % len(missing))
    dupes = sorted(set(i for i in covered if covered.count(i) > 1))
    if dupes:
        reasons.append("groups repeat %d item(s)" % len(dupes))

    order = draft.get("suggested_order")
    order_out = []  # type: List[str]
    if not isinstance(order, list):
        reasons.append("suggested_order: missing")
    else:
        order_out = [str(i) for i in order]
        if sorted(order_out) != sorted(known):
            reasons.append("suggested_order is not a permutation of the item ids")

    if reasons or opening is None:
        return None, reasons or ["opening: rejected"]
    return {
        "opening": opening.text,
        "groups": groups_out,
        "suggested_order": order_out,
        "facts_used": sorted(set(facts_used)),
    }, []


# ══════════════════════════════════════════════════════════════════════════
# 4. THE BRIEF — deterministic always, advisory when earned
# ══════════════════════════════════════════════════════════════════════════


def order_payload(view: BriefView) -> List[Dict[str, Any]]:
    out = []  # type: List[Dict[str, Any]]
    for rank, item in enumerate(view.items):
        row = item.to_payload()
        row["rank"] = rank + 1
        row["slug"] = view.slugs[item.item_id]
        row["rationale"] = DG.priority_rationale(item, view.as_of)
        out.append(row)
    return out


def _unavailable(reason: str, kind: str) -> Dict[str, Any]:
    return {"available": False, "kind": kind, "reason": reason, "opening": None,
            "groups": [], "suggested_order": [], "facts_used": [],
            "model_id": None, "prompt_version": None}


def brief_payload(view: BriefView, advisory: Dict[str, Any], cached: bool = False) -> Dict[str, Any]:
    notice = ("Advisory brief: %s" % advisory.get("reason")
              if not advisory.get("available") else
              "Advisory brief present; the order and grouping under `order` and `groups` "
              "are the engine's and are authoritative.")
    return {
        "version": BRIEF_VERSION,
        "as_of": view.as_of.isoformat(),
        "firm_key": view.firm_key,
        "item_set_hash": view.item_set_hash,
        "item_count": len(view.items),
        "cached": cached,
        "order": order_payload(view),
        "groups": [g.to_payload() for g in view.groups],
        "advisory": dict(advisory),
        "degraded": not bool(advisory.get("available")),
        "notice": notice,
    }


def draft_advisory(view: BriefView, client_factory: Optional[Callable[[], Any]] = None,
                   state_dir: Optional[Any] = None) -> Dict[str, Any]:
    """One model call + the guard. Every failure lands as the honest
    unavailable shape; the model's raw answer is never returned."""
    if not view.items:
        return _unavailable("no attention items today; nothing to brief", "empty")
    try:
        client = _client_for(client_factory, state_dir)
        draft = _call_json(client, _SYSTEM, user_text(view), state_dir)
    except BriefUnavailable as exc:
        return _unavailable(str(exc), exc.kind)
    accepted, reasons = validate_draft(draft, view)
    if accepted is None:
        logger.warning("[firm.brief] REFUSED an advisory draft: %s", "; ".join(reasons))
        return _unavailable(
            "the model's draft was rejected by the guard (%s); the deterministic brief "
            "is shown instead" % "; ".join(reasons)[:400], "rejected")
    params = registry.params_for(ROLE)
    accepted.update({"available": True, "kind": "advisory", "reason": "",
                     "model_id": params["model_id"],
                     "prompt_version": params["prompt_version"]})
    return accepted


class MemoryBriefStore(object):
    def __init__(self) -> None:
        self.rows = {}  # type: Dict[Tuple[str, str, str], Dict[str, Any]]
        self.last_put = None  # type: Optional[str]

    def get(self, firm_key: str, day: str, item_set_hash: str) -> Optional[Dict[str, Any]]:
        return self.rows.get((firm_key, day, item_set_hash))

    def put(self, firm_key: str, day: str, item_set_hash: str, payload: Dict[str, Any],
            user_id: str = "", client_org_ids: Optional[Sequence[str]] = None) -> bool:
        self.rows[(firm_key, day, item_set_hash)] = payload
        self.last_put = "stored"
        return True


def brief_client_ids(items: Sequence[DG.AttentionItem]) -> List[str]:
    """The CLIENT dimension of a brief: every client its items name,
    sorted, de-duplicated — what `firm_briefs.client_org_ids` carries and
    what the read/write policies pin on."""
    return sorted(set(str(it.client_org_id) for it in items if it.client_org_id))


class SupabaseBriefStore(object):
    """`firm_briefs`. READS AND WRITES go through the caller's own client
    when a `jwt` is given, so `firm_briefs firm read` / `firm write` /
    `firm update` (RLS) are the second wall under the route's Python one;
    the row carries the firm the brief belongs to AND every client it
    names (`client_org_ids`). A refused write is recorded as
    `last_put == "refused"` and the brief is served uncached; a missing
    table degrades to no cache; neither blocks a brief."""

    def __init__(self, jwt: Optional[str] = None, firm_id: Optional[str] = None) -> None:
        self.jwt = jwt
        self.firm_id = firm_id
        self.last_put = None  # type: Optional[str]

    def _reader(self) -> Any:
        return _supabase.per_user(self.jwt) if self.jwt else _supabase.admin()

    _writer = _reader

    def get(self, firm_key: str, day: str, item_set_hash: str) -> Optional[Dict[str, Any]]:
        try:
            with self._reader() as client:
                rows = client.select("firm_briefs", filters={
                    "firm_key": "eq.%s" % firm_key, "brief_date": "eq.%s" % day,
                    "item_set_hash": "eq.%s" % item_set_hash}, limit=1)
        except Exception:  # noqa: BLE001
            return None
        return (rows[0].get("payload") if rows else None) or None

    def put(self, firm_key: str, day: str, item_set_hash: str, payload: Dict[str, Any],
            user_id: str = "", client_org_ids: Optional[Sequence[str]] = None) -> bool:
        adv = payload.get("advisory") or {}
        row = {
            "firm_key": firm_key, "firm_id": self.firm_id or None,
            "client_org_ids": sorted(set(str(c) for c in (client_org_ids or []) if c)),
            "brief_date": day, "item_set_hash": item_set_hash,
            "payload": payload, "user_id": user_id or None,
            "model_id": adv.get("model_id"), "prompt_version": adv.get("prompt_version"),
            "degraded": bool(payload.get("degraded")),
        }
        self.last_put = None
        try:
            with self._writer() as client:
                client.upsert("firm_briefs", row, on_conflict="firm_key,brief_date,item_set_hash")
        except Exception as exc:  # noqa: BLE001 — classified, never fatal
            if self.jwt and FR.rls_refused(exc):
                self.last_put = "refused"
                logger.warning("[firm.brief] cache write REFUSED by row-level security "
                               "(the brief is served uncached)")
                return False
            self.last_put = "failed"
            logger.exception("[firm.brief] cache write failed (non-fatal)")
            return False
        self.last_put = "stored"
        return True


def compose_brief(items: Sequence[Any], as_of: date, firm_key: str, user_id: str = "",
                  client_factory: Optional[Callable[[], Any]] = None,
                  store: Optional[Any] = None, state_dir: Optional[Any] = None,
                  force: bool = False, client_names: Optional[Dict[str, str]] = None,
                  kind_order: Optional[Dict[str, int]] = None) -> Dict[str, Any]:
    """The brief for one firm on one day. Deterministic part first, the
    model second, the cache last (and only for a brief the model earned)."""
    views, refusals = DG.coerce_items(items, client_names, kind_order)
    view = build_view(views, as_of, firm_key)
    day = as_of.isoformat()
    if store is not None and not force:
        cached = store.get(firm_key, day, view.item_set_hash)
        if isinstance(cached, dict) and cached.get("version") == BRIEF_VERSION:
            out = dict(cached)
            out["cached"] = True
            return out
    advisory = draft_advisory(view, client_factory, state_dir)
    payload = brief_payload(view, advisory)
    payload["refusals"] = [r.to_payload() for r in refusals]
    if store is not None and advisory.get("available"):
        store.put(firm_key, day, view.item_set_hash, payload, user_id,
                  client_org_ids=brief_client_ids(view.items))
    return payload


def ai_summary_line(items: Sequence[DG.AttentionItem], as_of: date,
                    client_factory: Optional[Callable[[], Any]] = None,
                    state_dir: Optional[Any] = None) -> DG.AiSummary:
    """The ONE labeled line the digest may carry. Guarded like the brief;
    any failure is the honest unavailable state."""
    view = build_view(items, as_of, "digest")
    if not view.items:
        return DG.unavailable_summary("no attention items today")
    try:
        client = _client_for(client_factory, state_dir)
        draft = _call_json(client, _SUMMARY_SYSTEM, user_text(view), state_dir)
    except BriefUnavailable as exc:
        return DG.unavailable_summary(str(exc))
    guarded, reasons = guard_text(draft.get("summary") if isinstance(draft, dict) else None,
                                  view.facts, "summary")
    if guarded is None:
        return DG.unavailable_summary("the model's line was rejected by the numeral guard (%s)"
                                      % "; ".join(reasons))
    return DG.AiSummary(available=True, text=guarded.text, guarded=True,
                        facts_used=guarded.facts_used)


# ══════════════════════════════════════════════════════════════════════════
# 5. ROUTES
# ══════════════════════════════════════════════════════════════════════════


class BriefBody(BaseModel):
    firm_id: Optional[str] = None
    as_of: Optional[str] = None
    force: bool = False


def build_router() -> APIRouter:
    # Structural: a model must not be reachable from the ranking path.
    # Asserted at mount so a regression fails the boot, not a reader.
    DG.assert_no_model_in_critical_path()
    router = APIRouter(prefix="/api/firm", tags=["firm-brief"])

    @router.get("/brief/self-check")
    def self_check() -> Dict[str, Any]:
        violations = DG.critical_path_violations()
        params = registry.params_for(ROLE)
        return {"critical_path_clean": not violations, "violations": violations,
                "role": ROLE, "model_id": params["model_id"],
                "prompt_version": params["prompt_version"], "breaker": params["breaker"],
                "version": BRIEF_VERSION}

    @router.post("/brief")
    def brief(body: BriefBody, authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        """TWO WALLS: `client_org_ids_for` is the Python wall (firm
        membership, or the caller's own workspaces); every read under it
        — the periods the board is computed from, the open requests, the
        brief cache — goes through the CALLER's own client, so RLS
        (`financial_periods firm read`, `firm_file_requests firm read`,
        `firm_briefs firm read`) is the second."""
        jwt = FR._require_jwt(authorization)
        user_id = FR._user_id(jwt)
        day = date.fromisoformat(body.as_of) if body.as_of else datetime.now(timezone.utc).date()
        firm = (body.firm_id or "").strip() or None
        ids = FR.client_org_ids_for(user_id, firm, jwt)
        firm_key = str(firm or user_id)
        try:
            provider = FR.default_report_provider(lambda: _supabase.per_user(jwt), firm_id=firm)
            report = provider(ids, day)
        except Exception as exc:  # noqa: BLE001 — the board runner is another lane's
            raise HTTPException(503, "attention items unavailable: %s" % exc)
        names = dict((str(r.client_id), str(r.client_name)) for r in getattr(report, "rows", ()))
        # Every page, one in.() chunk at a time (critic D11): one bare
        # select over a 1,200-client firm was one 55 KB filter answering
        # 1,000 rows. The walk stops on an EMPTY page (engine.api._paging).
        from ._paging import chunked, select_all
        requests = []  # type: List[Dict[str, Any]]
        with _supabase.per_user(jwt) as client:
            for chunk in chunked(ids):
                filters = {"client_org_id": "in.(%s)" % ",".join(chunk)}
                if firm:
                    filters["firm_id"] = "eq.%s" % firm
                requests.extend(select_all(client, "firm_file_requests", order="id.asc",
                                           filters=filters))
        raws = list(report.items()) + [it.to_payload() for it in
                                       FR.open_request_items(requests or [], names, day)]
        return compose_brief(raws, day, firm_key, user_id=user_id,
                             store=SupabaseBriefStore(jwt=jwt, firm_id=firm),
                             force=body.force, client_names=names,
                             kind_order=DG.kind_order_from_report(report))

    return router


__all__ = [
    "ROLE", "BRIEF_VERSION", "BriefUnavailable", "fact_to_numeral", "BriefView",
    "build_view", "user_text", "GuardedText", "guard_text", "validate_draft",
    "order_payload", "brief_payload", "draft_advisory", "MemoryBriefStore",
    "brief_client_ids", "SupabaseBriefStore", "compose_brief", "ai_summary_line",
    "build_router",
]
