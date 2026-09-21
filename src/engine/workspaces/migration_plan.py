"""The one-company-per-workspace migration, as a PURE plan.

INPUT
  * ``tables`` — a snapshot of the production tables (``scripts/db_snapshot.py``
    format: ``{table: [row, ...]}``);
  * ``facts`` — per document id, what its stored bytes say
    (``DocFacts``: the ``CompanyIdentity`` from ``identify_document``, the
    bytes' sha256, whether the storage object exists);
  * ``migration_date`` — names the holding workspace.

OUTPUT
  a ``Plan``: the decisions (per workspace, period and document, each with
  its reason) and the ORDERED row operations (``rowstore`` vocabulary) that
  carry them out. No clock, no network, no randomness: new workspace ids are
  ``uuid5`` of (user, company), so a re-run creates nothing twice, and the
  plan of the post-state is EMPTY (tested).

THE RULES (the owner's, 2026-09-21)
-----------------------------------
Scope: every user, every NON-archived workspace the user owns alone (a
workspace with several members is reported and left untouched — moving its
data would change what the other members see).

1. A workspace's own company: ``org_prefs.prefs.cui`` if set; else the
   company of a STRICT majority of its live analysed period-source
   documents (of those whose company is known); else, if it has no such
   sources, a strict majority of its live analysed documents; else none.
   Two workspaces of one user claiming one company: prefs first, then the
   larger share, then more documents, then the older workspace; the loser
   has no company of its own.
2. A period belongs to the company of its source document (an unidentified
   source inherits the workspace's company). It is EMPTY — and archived —
   when it has no source document, the source is missing / deleted / not
   analysed, or nothing was persisted for it (no calculated_metrics, no
   statement_line_items, no canonical envelope).
3. Per company per month exactly one period survives. One already in the
   company's own workspace always wins (a currently served period is never
   replaced); otherwise the one with the latest source document. The
   others are archived.
4. A surviving period moves to its company's workspace (an existing one of
   the SAME user, else a new one named from the registry / document, with
   ``org_prefs.prefs = {cui, company_name, identity_sources}``). It is
   re-dated when its document disagrees with its date: always on the
   document's own period line; on a filename-only signal only when the YEAR
   differs (the "2025 book filed under 2017" shape).
5. Per company per month exactly one live document: the surviving period's
   source. Copies (same content hash), other files for the same company and
   month, superseded failed uploads and non-financial documents are
   archived (``deleted_at`` + ``error = "archived: <reason> (<id>)"``). A
   company+month with documents but no period keeps ONE live document (the
   latest analysed, else the latest failed) and is listed in
   ``needs_reanalysis``.
6. ARCHIVING A PERIOD: ``financial_periods`` has no archive column, so the
   period, every row scoped to it, and its source document move into the
   user's holding workspace "Arhivă (migrare <date>)" (``archived_at`` set,
   ``purge_after`` NULL — a HELD archive: ``purge_expired_workspaces`` only
   purges ``purge_after < now()``, NULL never compares, and
   ``purge_workspace`` refuses it once schema_phase_workspace_purge_now_
   hold.sql is applied, which --execute requires). The source travels
   with its period WHATEVER its state (analysed, failed, trashed, any
   scope) because ``financial_periods.source_document_id`` is
   ``ON DELETE CASCADE``: a source left in another workspace — or left in
   ANY trash — is one hard delete ("Clear all", a purge, a sweep) away from
   erasing the archived period and everything scoped to it. So a period's
   source is NEVER trashed by this migration, and a source that was already
   in the trash comes out of it as it moves (the holding workspace is
   archived: nothing in it is shown). ``period_source_hazards`` is the
   gate: the plan is refused (``blocking``) if its post-state has a period
   whose source is trashed or in another workspace that the pre-state did
   not have.
7. A workspace with no company of its own is archived once split, unless
   something live is still in it that could not be placed (then it stays,
   reported) or it would leave the user with no live workspace.
8. Every document's ``period_id`` ends up NULL or pointing at a period in
   the SAME workspace (a re-analysis must never write into another
   tenant's period).

Nothing is ever hard-deleted; Stripe, auth and billing tables are never
touched.
"""
from __future__ import annotations

import hashlib
import uuid
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple

from engine.workspaces.company_identity import (
    CompanyIdentity,
    normalize_company_name,
    normalize_cui,
)
from engine.workspaces.rowstore import NOW, apply_ops, canonical_json, pk_for

#: Fixed namespace: new workspace ids are uuid5(NS, "<user>|<company key>").
MIGRATION_NAMESPACE = uuid.UUID("5e0c7f3a-2b9d-4f61-8a4e-7d1c3b2a9f06")

HOLDING_NAME = "Arhivă (migrare {date})"

ANALYZED = "analyzed"
FAILED = "failed"
IN_FLIGHT = frozenset({"queued", "extracting", "mapping", "computing", "narrating",
                       "uploaded", "mapped"})

#: Tables whose rows are period-scoped but live in another column's org.
ORG_COLUMNS = ("org_id", "organization_id")
#: Never moved by the period/document sweeps (handled explicitly or never).
NOT_SWEPT = frozenset({
    "financial_periods", "documents", "organizations", "memberships", "org_prefs",
    "user_prefs", "subscriptions", "user_usage", "billing_events", "chat_threads",
    "chat_messages",
})


@dataclass(frozen=True)
class DocFacts:
    """What a stored document's bytes say."""

    identity: Optional[CompanyIdentity] = None
    sha256: Optional[str] = None
    #: True / False when the storage object was (not) found, None unknown.
    object_exists: Optional[bool] = None
    read_error: Optional[str] = None

    @classmethod
    def coerce(cls, value: Any) -> "DocFacts":
        if isinstance(value, DocFacts):
            return value
        if isinstance(value, CompanyIdentity):
            return cls(identity=value)
        if isinstance(value, Mapping):
            ident = value.get("identity")
            if isinstance(ident, Mapping):
                ident = CompanyIdentity.from_dict(ident)
            return cls(identity=ident, sha256=value.get("sha256"),
                       object_exists=value.get("object_exists"),
                       read_error=value.get("read_error"))
        return cls()

    def to_dict(self) -> Dict[str, Any]:
        return {"identity": self.identity.to_dict() if self.identity else None,
                "sha256": self.sha256, "object_exists": self.object_exists,
                "read_error": self.read_error}


@dataclass
class Plan:
    migration_date: str
    ops: List[Dict[str, Any]] = field(default_factory=list)
    users: List[Dict[str, Any]] = field(default_factory=list)
    workspaces: List[Dict[str, Any]] = field(default_factory=list)
    periods: List[Dict[str, Any]] = field(default_factory=list)
    documents: List[Dict[str, Any]] = field(default_factory=list)
    needs_reanalysis: List[Dict[str, Any]] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    #: Reasons --execute must refuse (in-flight uploads, inconsistent rows).
    blocking: List[str] = field(default_factory=list)

    @property
    def is_empty(self) -> bool:
        return not self.ops

    def ops_sha256(self) -> str:
        return hashlib.sha256(canonical_json(self.ops).encode("utf-8")).hexdigest()

    def to_dict(self) -> Dict[str, Any]:
        return {
            "migration_date": self.migration_date,
            "ops_sha256": self.ops_sha256(),
            "op_count": len(self.ops),
            "users": self.users,
            "workspaces": self.workspaces,
            "periods": self.periods,
            "documents": self.documents,
            "needs_reanalysis": self.needs_reanalysis,
            "warnings": self.warnings,
            "blocking": self.blocking,
            "ops": self.ops,
        }


# ── helpers ────────────────────────────────────────────────────────────

def _month(iso: Optional[str]) -> Optional[str]:
    return str(iso)[:7] if iso else None


def _is_live_org(org: Optional[Mapping[str, Any]]) -> bool:
    return bool(org) and not org.get("archived_at")


def _financial(doc: Mapping[str, Any]) -> bool:
    return (doc.get("scope") or "financial") == "financial"


def new_org_id(user_id: str, company_key: str) -> str:
    return str(uuid.uuid5(MIGRATION_NAMESPACE, "%s|%s" % (user_id, company_key)))


def holding_org_id(user_id: str) -> str:
    return str(uuid.uuid5(MIGRATION_NAMESPACE, "%s|holding" % user_id))


def _prefs_company_key(prefs: Mapping[str, Any]) -> Optional[str]:
    cui = normalize_cui(prefs.get("cui")) if prefs.get("cui") else None
    if cui:
        return "cui:" + cui
    name = normalize_company_name(prefs.get("company_name")) if prefs.get("company_name") else ""
    return ("name:" + name) if name else None


_NAME_SIGNAL_RANK = {"registry": 0, "operator_verified": 1, "document_header_label": 2,
                     "document_header_title": 3, "sheet_name": 4, "filename": 9}
_CUI_SIGNAL_RANK = {"document_header_cui": 0, "operator_verified": 1,
                    "registry_name_match": 2, "filename_registry_match": 3}


class _Planner:
    def __init__(self, tables: Mapping[str, List[Mapping[str, Any]]],
                 facts: Mapping[str, Any], *, migration_date: str,
                 pks: Optional[Mapping[str, Sequence[str]]] = None,
                 stale_before: Optional[str] = None) -> None:
        self.t = tables
        self.pks = pks
        self.date = migration_date
        self.stale_before = stale_before
        self.plan = Plan(migration_date=migration_date)
        self.facts: Dict[str, DocFacts] = {str(k): DocFacts.coerce(v) for k, v in (facts or {}).items()}

        self.orgs = {str(o["id"]): dict(o) for o in tables.get("organizations") or []}
        self.members: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
        for m in tables.get("memberships") or []:
            self.members[str(m["org_id"])].append(dict(m))
        self.prefs = {str(p["org_id"]): dict(p.get("prefs") or {}) for p in tables.get("org_prefs") or []}
        self.periods = {str(p["id"]): dict(p) for p in tables.get("financial_periods") or []}
        self.docs = {str(d["id"]): dict(d) for d in tables.get("documents") or []}
        self.metric_periods: Set[str] = set()
        for t in ("calculated_metrics", "statement_line_items"):
            for r in tables.get(t) or []:
                if r.get("period_id"):
                    self.metric_periods.add(str(r["period_id"]))
        for p in self.periods.values():
            if p.get("assembled_canonical_v1"):
                self.metric_periods.add(str(p["id"]))
        self.periods_by_org: Dict[str, List[str]] = defaultdict(list)
        for pid, p in sorted(self.periods.items()):
            self.periods_by_org[str(p["org_id"])].append(pid)
        self.docs_by_org: Dict[str, List[str]] = defaultdict(list)
        for did, d in sorted(self.docs.items()):
            self.docs_by_org[str(d["org_id"])].append(did)

        # A document whose bytes could not be read (object missing, image
        # PDF) but whose content hash equals an identified document's is
        # that document: same bytes, same company, same period.
        by_sha: Dict[str, List[str]] = defaultdict(list)
        for did in sorted(self.docs):
            f = self.facts.get(did)
            if f and f.identity and f.identity.company_key and self.sha(did):
                by_sha[str(self.sha(did))].append(did)
        self.sibling: Dict[str, CompanyIdentity] = {}
        for digest, dids in by_sha.items():
            idents = [self.facts[d].identity for d in dids]
            if len({i.company_key for i in idents}) == 1:
                self.sibling[digest] = idents[0]

        # final placement, filled by the passes
        self.period_final_org: Dict[str, str] = {}
        self.doc_final_org: Dict[str, str] = {}
        self.redates: Dict[str, str] = {}

    # ── facts ──────────────────────────────────────────────────────────

    def ident(self, doc_id: Optional[str]) -> Optional[CompanyIdentity]:
        f = self.facts.get(str(doc_id)) if doc_id else None
        own = f.identity if f else None
        if own is not None and own.company_key:
            return own
        digest = self.sha(str(doc_id)) if doc_id and str(doc_id) in self.docs else None
        return self.sibling.get(str(digest)) if digest and str(digest) in self.sibling else own

    def sha(self, doc_id: str) -> Optional[str]:
        d = self.docs.get(doc_id) or {}
        f = self.facts.get(doc_id)
        return d.get("content_hash") or (f.sha256 if f else None)

    def status(self, doc_id: str) -> str:
        d = self.docs[doc_id]
        s = str(d.get("status") or "")
        if s in IN_FLIGHT and self.stale_before and str(d.get("created_at") or "") < self.stale_before:
            return FAILED  # stuck for longer than the cut-off: it is not coming back
        return s

    # ── identity of companies ─────────────────────────────────────────

    def sole_owner(self, org_id: str) -> Optional[str]:
        ms = self.members.get(org_id) or []
        if len(ms) == 1 and ms[0].get("role") == "owner":
            return str(ms[0]["user_id"])
        return None

    def raw_key(self, doc_id: Optional[str]) -> Optional[str]:
        ident = self.ident(doc_id)
        return ident.company_key if ident else None

    # ── the plan ──────────────────────────────────────────────────────

    def build(self) -> Plan:
        users = sorted({str(m["user_id"]) for ms in self.members.values() for m in ms})
        for org_id, org in sorted(self.orgs.items()):
            n = len(self.members.get(org_id) or [])
            if _is_live_org(org) and n > 1:
                self.plan.warnings.append(
                    "workspace %s (%r) has %d members — not migrated" % (org_id, org.get("name"), n))
        for user in users:
            self.build_user(user)
        self._refuse_new_cascade_hazards()
        return self.plan

    def _refuse_new_cascade_hazards(self) -> None:
        """The plan's own post-state may not hold a period that is one hard
        delete away from ``ON DELETE CASCADE`` (its source trashed, or in
        another workspace) unless the pre-state already held it. Any such
        period makes the plan ``blocking`` — --execute refuses it."""
        after = apply_ops(self.t, self.plan.ops, now="1970-01-01T00:00:00+00:00", pks=self.pks, strict=False)
        for pid, why in new_cascade_hazards(self.t, after):
            self.plan.blocking.append("period %s would be one hard delete from erasure: %s" % (pid, why))

    def build_user(self, user: str) -> None:
        orgs = [o for o in sorted(self.orgs) if self.sole_owner(o) == user]
        live = [o for o in orgs if _is_live_org(self.orgs[o])]
        if not live:
            return
        self.user = user
        self.live = live
        self.in_scope_docs = {d for o in live for d in self.docs_by_org.get(o, [])}
        self.name_to_cui = self._name_links(live)
        self.period_final_org = {}
        self.doc_final_org = {}
        self.redates = {}

        claims = {o: self._own_company(o) for o in live}
        own = self._resolve_claims(claims)
        self.own = {o: own[o][0] for o in live}
        company_ws: Dict[str, str] = {k: o for o, k in sorted(self.own.items()) if k}

        # 1. periods: empty ones are archived, one survivor per company+month
        decisions: Dict[str, Dict[str, Any]] = {}
        by_group: Dict[Tuple[str, str], List[str]] = defaultdict(list)
        for o in live:
            for pid in self.periods_by_org.get(o, []):
                pr = self._period_row(pid, o)
                decisions[pid] = pr
                if pr["action"] == "candidate":
                    by_group[(pr["company"], pr["month"])].append(pid)
        survivors: Dict[Tuple[str, str], str] = {}
        for group, pids in sorted(by_group.items()):
            ordered = sorted(pids)
            ordered.sort(key=lambda p: str((self.docs.get(str(self.periods[p].get("source_document_id")))
                                            or {}).get("created_at") or ""), reverse=True)
            ordered.sort(key=lambda p: 0 if company_ws.get(group[0]) == str(self.periods[p]["org_id"]) else 1)
            survivors[group] = ordered[0]
            decisions[ordered[0]]["action"] = "keep"
            for loser in ordered[1:]:
                decisions[loser]["action"] = "archive"
                decisions[loser]["reason"] = "month_already_served (%s)" % ordered[0]

        # 2. documents: one live document per company+month
        doc_dec = self._document_decisions(survivors, decisions)

        # 3. a workspace for every company that keeps something live
        needed = sorted({c for (c, _m) in survivors} |
                        {dd["company"] for dd in doc_dec.values() if dd["action"] == "keep" and dd.get("company")})
        created: List[str] = []
        for company in needed:
            if company not in company_ws:
                company_ws[company] = new_org_id(user, company)
                created.append(company)
        self.company_ws = company_ws
        holding = holding_org_id(user)
        used_holding = [False]

        def _place(target: Optional[str]) -> str:
            if target is None or target == holding:
                used_holding[0] = True
                return holding
            return target

        for pid, pr in sorted(decisions.items()):
            cur = str(self.periods[pid]["org_id"])
            if pr["action"] == "keep":
                final = company_ws[pr["company"]]
                if pr.get("redate_to"):
                    self.redates[pid] = pr["redate_to"]
            elif pr["action"] == "archive":
                final = _place(holding)
            else:
                final = cur
            pr["to_org"] = final
            self.period_final_org[pid] = final

        for did, dd in sorted(doc_dec.items()):
            cur = str(self.docs[did]["org_id"])
            where = dd.pop("_place")
            period = dd.pop("_period", None)
            if where == "company":
                final = _place(company_ws.get(dd.get("company") or ""))
            elif where == "with_period":
                final = self.period_final_org.get(period, cur)
                if final == holding:
                    used_holding[0] = True
            else:
                final = cur
            dd["to_org"] = final
            self.doc_final_org[did] = final

        # 4. workspaces with no company of their own: archived once empty
        company_orgs = set(company_ws.values())
        live_after = set(company_orgs)
        pending: List[str] = []
        for o in live:
            if self.own.get(o):
                continue
            left = [p for p in self.periods_by_org.get(o, []) if self.period_final_org.get(p, o) == o]
            for d in self.docs_by_org.get(o, []):
                if self.docs[d].get("deleted_at") is not None:
                    continue
                dd = doc_dec.get(d)
                if dd is None or (dd["action"] != "archive" and self.doc_final_org.get(d) == o):
                    left.append(d)
            split = any(decisions[p]["action"] in ("keep", "archive") and self.period_final_org.get(p) != o
                        and not str(decisions[p].get("reason") or "").startswith("empty")
                        for p in self.periods_by_org.get(o, []))
            split = split or any(d in doc_dec and self.docs[d].get("deleted_at") is None
                                 and self.doc_final_org.get(d) != o for d in self.docs_by_org.get(o, []))
            if left:
                self.plan.warnings.append(
                    "workspace %s (%r) has no company of its own but still holds %d live item(s) "
                    "that could not be placed — left live" % (o, self.orgs[o].get("name"), len(left)))
                live_after.add(o)
            elif not split:
                # Nothing of a company was in it (an empty workspace, or one
                # holding only empty placeholder months): not a split, so
                # not archived.
                self.plan.warnings.append(
                    "workspace %s (%r) has no company of its own and nothing to split — left live"
                    % (o, self.orgs[o].get("name")))
                live_after.add(o)
            else:
                pending.append(o)
        archive_orgs: List[str] = []
        for o in pending:
            if live_after - {o}:
                archive_orgs.append(o)
            else:
                live_after.add(o)
                self.plan.warnings.append(
                    "workspace %s (%r) has no company of its own but is the user's only workspace — left live"
                    % (o, self.orgs[o].get("name")))

        # 5. reports
        for o in live:
            self.plan.workspaces.append({
                "user_id": user, "org_id": o, "name": self.orgs[o].get("name"),
                "company": self.own.get(o), "company_source": own[o][1],
                "action": "archive" if o in archive_orgs else "keep"})
        for company in created:
            self.plan.workspaces.append({
                "user_id": user, "org_id": company_ws[company], "name": self._company_name(company),
                "company": company, "company_source": "created", "action": "create"})
        if used_holding[0]:
            self.plan.workspaces.append({
                "user_id": user, "org_id": holding, "name": HOLDING_NAME.format(date=self.date),
                "company": None, "company_source": "holding",
                "action": "reuse_archived" if holding in self.orgs else "create_archived"})
        for pid, pr in sorted(decisions.items()):
            self.plan.periods.append(pr)
        for did, dd in sorted(doc_dec.items()):
            self.plan.documents.append(dd)

        self._emit_ops(user, created, holding, used_holding[0], archive_orgs, doc_dec)
        self.plan.users.append({
            "user_id": user, "workspaces_in_scope": len(live),
            "companies": {c: company_ws[c] for c in sorted(company_ws)},
            "created": [company_ws[c] for c in created], "archived": archive_orgs,
            "holding": holding if used_holding[0] else None})

    # ── pieces ────────────────────────────────────────────────────────

    def _name_links(self, live: Sequence[str]) -> Dict[str, str]:
        """normalized company name -> cui key, for this user's documents and
        prefs: a book that prints only "ALFA FOOD S.R.L" is the same
        company as one that prints CUI 12345674 when the registered name of
        that CUI normalizes to the same words — and only then."""
        links: Dict[str, Set[str]] = defaultdict(set)
        for o in live:
            prefs = self.prefs.get(o) or {}
            key = _prefs_company_key(prefs)
            if key and key.startswith("cui:") and prefs.get("company_name"):
                links[normalize_company_name(prefs["company_name"])].add(key)
            for did in self.docs_by_org.get(o, []):
                ident = self.ident(did)
                if ident and ident.cui and ident.company_name:
                    links[normalize_company_name(ident.company_name)].add("cui:" + ident.cui)
        return {n: next(iter(ks)) for n, ks in links.items() if n and len(ks) == 1}

    def key(self, doc_id: Optional[str]) -> Optional[str]:
        k = self.raw_key(doc_id)
        if k and k.startswith("name:"):
            return self.name_to_cui.get(k[5:], k)
        return k

    def _own_company(self, org: str) -> Tuple[Optional[str], str, float, int, str]:
        """(company key or None, how it was decided, share, count, created_at)."""
        prefs = self.prefs.get(org) or {}
        key = _prefs_company_key(prefs)
        created = str(self.orgs[org].get("created_at") or "")
        if key:
            if key.startswith("name:"):
                key = self.name_to_cui.get(key[5:], key)
            return (key, "org_prefs", 1.0, 1 << 30, created)

        def _majority(doc_ids: Iterable[str], label: str) -> Optional[Tuple[Optional[str], str, float, int, str]]:
            keys = [k for k in (self.key(d) for d in doc_ids) if k]
            if not keys:
                return None
            counts = Counter(keys)
            top, n = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[0]
            share = n / float(len(keys))
            if share > 0.5:
                return (top, "%s %d/%d" % (label, n, len(keys)), share, n, created)
            return (None, "%s: no majority (%s)" % (label, ", ".join(
                "%s=%d" % kv for kv in sorted(counts.items()))), share, n, created)

        sources = []
        for pid in self.periods_by_org.get(org, []):
            sid = str(self.periods[pid].get("source_document_id") or "")
            d = self.docs.get(sid)
            if d and d.get("deleted_at") is None and self.status(sid) == ANALYZED and _financial(d):
                sources.append(sid)
        got = _majority(sources, "period sources")
        if got is None:
            analysed = [d for d in self.docs_by_org.get(org, [])
                        if self.docs[d].get("deleted_at") is None and self.status(d) == ANALYZED
                        and _financial(self.docs[d])]
            got = _majority(analysed, "analysed documents")
        return got or (None, "no identified documents", 0.0, 0, created)

    def _resolve_claims(self, own: Mapping[str, Tuple[Optional[str], str, float, int, str]]
                        ) -> Dict[str, Tuple[Optional[str], str]]:
        """One workspace per company per user: ``{org: (key or None, why)}``."""
        out = {o: (v[0], v[1]) for o, v in own.items()}
        claims: Dict[str, List[str]] = defaultdict(list)
        for o, v in sorted(own.items()):
            if v[0]:
                claims[v[0]].append(o)
        for company, orgs in sorted(claims.items()):
            if len(orgs) < 2:
                continue
            ranked = sorted(orgs)
            ranked.sort(key=lambda o: own[o][4])                 # older first
            ranked.sort(key=lambda o: -own[o][3])                # more documents
            ranked.sort(key=lambda o: -own[o][2])                # larger share
            ranked.sort(key=lambda o: 0 if own[o][1] == "org_prefs" else 1)
            for loser in ranked[1:]:
                out[loser] = (None, "%s also claimed by %s (%s)" % (company, ranked[0], own[loser][1]))
                self.plan.warnings.append(
                    "workspaces %s and %s both resolve to %s — %s keeps it"
                    % (ranked[0], loser, company, ranked[0]))
        return out

    def _period_row(self, pid: str, org: str) -> Dict[str, Any]:
        p = self.periods[pid]
        sid = str(p.get("source_document_id") or "")
        src = self.docs.get(sid) if sid else None
        row: Dict[str, Any] = {"id": pid, "from_org": org, "period_end": p.get("period_end"),
                               "source_document_id": sid or None}
        company = self.key(sid) if src else None
        if company is None:
            company = self.own.get(org)
        reason = None
        if not sid:
            reason = "empty: no source document"
        elif src is None:
            reason = "empty: source document missing"
        elif src.get("deleted_at") is not None:
            reason = "empty: source document deleted"
        elif self.status(sid) != ANALYZED:
            reason = "empty: source document %s" % (self.status(sid) or "unknown")
        elif pid not in self.metric_periods:
            reason = "empty: nothing persisted"
        elif sid not in self.in_scope_docs:
            reason = None
            row.update(action="unplaced", reason="source document outside the user's own workspaces",
                       company=company, month=_month(p.get("period_end")))
            self.plan.warnings.append("period %s: %s" % (pid, row["reason"]))
            return row
        if reason:
            row.update(action="archive", reason=reason, company=company, month=_month(p.get("period_end")))
            return row
        if company is None:
            row.update(action="unplaced", reason="company unknown", company=None,
                       month=_month(p.get("period_end")))
            self.plan.warnings.append("period %s in %s: company unknown — left in place" % (pid, org))
            return row
        end = str(p.get("period_end"))
        redate = None
        ident = self.ident(sid)
        if ident and ident.period_end and ident.period_end != end:
            signal = (ident.sources.get("period_end") or {}).get("signal")
            if signal in ("in_document", "closing_balance") or (
                    signal == "filename" and ident.period_end[:4] != end[:4]):
                redate = ident.period_end
            else:
                self.plan.warnings.append(
                    "period %s dated %s, its document's %s signal says %s — not re-dated (same year)"
                    % (pid, end, signal, ident.period_end))
        row.update(action="candidate", reason="", company=company,
                   month=_month(redate or end), redate_to=redate,
                   redate_signal=(ident.sources.get("period_end") or {}) if redate and ident else None)
        return row

    def _document_decisions(self, survivors: Mapping[Tuple[str, str], str],
                            periods: Mapping[str, Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
        dec: Dict[str, Dict[str, Any]] = {}
        kept_source = {periods[pid]["source_document_id"]: pid for pid in survivors.values()}
        # EVERY archived period's source, whatever the archive reason: the
        # source travels with its period (rule 6), never into a trash.
        archived_source = {pr["source_document_id"]: pid for pid, pr in sorted(periods.items())
                           if pr["action"] == "archive" and pr.get("source_document_id")}

        groups: Dict[Tuple[str, Optional[str]], List[str]] = defaultdict(list)
        for did in sorted(self.in_scope_docs):
            d = self.docs[did]
            org = str(d["org_id"])
            ident = self.ident(did)
            company = self.key(did) or self.own.get(org)
            base = {"id": did, "from_org": org, "filename": d.get("original_filename"),
                    "status": d.get("status"), "company": company,
                    "live": d.get("deleted_at") is None}
            if did in archived_source:
                pid = archived_source[did]
                status = self.status(did)
                if d.get("deleted_at") is None and status in IN_FLIGHT:
                    dec[did] = dict(base, action="untouched", reason="in flight (%s)" % status, _place="stay")
                    self.plan.blocking.append("document %s is being analysed (%s)" % (did, status))
                    continue
                # Any scope, any state: it follows its period into the
                # holding workspace, and comes out of the trash if it was
                # in one (``_emit_ops``) — never trashed by the migration.
                dec[did] = dict(base, action="follow_period", reason="source of archived period %s" % pid,
                                _place="with_period", _period=pid)
                continue
            if did in kept_source:
                # live and analysed by construction (``_period_row``); any
                # scope — it goes where its period goes.
                pid = kept_source[did]
                dec[did] = dict(base, action="keep", reason="source of period %s" % pid,
                                _place="with_period", _period=pid, period=pid)
                continue
            if not _financial(d):
                continue
            if d.get("deleted_at") is not None:
                # pre-existing trash
                if company and self.own.get(org) and company != self.own.get(org):
                    # Another company's file in THIS company's trash: it would
                    # be restorable here. It goes to its own company's
                    # workspace (or the holding one). Trash inside a workspace
                    # being split stays where it is — it is archived with it.
                    dec[did] = dict(base, action="move_trash", reason="trashed document of %s" % company,
                                    _place="company")
                else:
                    dec[did] = dict(base, action="untouched", reason="trash", _place="stay")
                continue
            status = self.status(did)
            if status in IN_FLIGHT:
                dec[did] = dict(base, action="untouched", reason="in flight (%s)" % status, _place="stay")
                self.plan.blocking.append("document %s is being analysed (%s)" % (did, status))
                continue
            if company is None:
                dec[did] = dict(base, action="untouched", reason="company unknown", _place="stay")
                self.plan.warnings.append("document %s (%r): company unknown — left in place"
                                          % (did, d.get("original_filename")))
                continue
            if ident is not None and ident.document_kind == "not_a_balance":
                if status == ANALYZED:
                    # Analysed into something that is not a balance (a
                    # public-records extract lives in sku_analyses): a
                    # feature reads it. Never archived by this migration.
                    dec[did] = dict(base, action="untouched", reason="analysed non-balance document",
                                    _place="stay")
                    self.plan.warnings.append("document %s (%r): analysed but not a balance — left in place"
                                              % (did, d.get("original_filename")))
                    continue
                dec[did] = dict(base, action="archive", reason="archived: not_a_balance (%s)" % did,
                                _place="company")
                continue
            month = None
            if ident and ident.period_end:
                month = _month(ident.period_end)
            groups[(company, month)].append(did)

        for (company, month), dids in sorted(groups.items(), key=lambda kv: (kv[0][0], kv[0][1] or "")):
            if month is None:
                self._no_month_group(company, dids, dec, kept_source)
                continue
            pid = survivors.get((company, month))
            if pid:
                keeper = periods[pid]["source_document_id"]
            else:
                keeper = self._choose(dids)
                self.plan.needs_reanalysis.append({
                    "user_id": self.user, "company": company, "company_name": None, "month": month,
                    "document_id": keeper, "filename": self.docs[keeper].get("original_filename"),
                    "status": self.docs[keeper].get("status")})
                d = self.docs[keeper]
                dec[keeper] = {"id": keeper, "from_org": str(d["org_id"]),
                               "filename": d.get("original_filename"), "status": d.get("status"),
                               "company": company, "live": True, "action": "keep",
                               "reason": "chosen for re-analysis (%s %s, no period)" % (company, month),
                               "_place": "company"}
            keep_sha = self.sha(keeper)
            for did in dids:
                if did == keeper:
                    continue
                d = self.docs[did]
                if keep_sha and self.sha(did) == keep_sha:
                    why = "duplicate_of_source" if pid else "duplicate"
                elif self.status(did) == FAILED:
                    why = "failed_superseded"
                else:
                    why = "other_file_same_period"
                dec[did] = {"id": did, "from_org": str(d["org_id"]), "filename": d.get("original_filename"),
                            "status": d.get("status"), "company": company, "live": True,
                            "action": "archive", "reason": "archived: %s (%s)" % (why, keeper),
                            "_place": "company"}
        return dec

    def _choose(self, dids: Sequence[str]) -> str:
        analysed = [d for d in dids if self.status(d) == ANALYZED]
        pool = analysed or list(dids)
        ordered = sorted(pool)
        ordered.sort(key=lambda d: str(self.docs[d].get("created_at") or ""), reverse=True)
        return ordered[0]

    def _no_month_group(self, company: str, dids: Sequence[str], dec: Dict[str, Dict[str, Any]],
                        kept_source: Mapping[str, str]) -> None:
        kept_shas = {self.sha(k) for k in kept_source if self.key(k) == company}
        seen: Dict[str, str] = {}
        for did in sorted(dids, key=lambda x: (str(self.docs[x].get("created_at") or ""), x)):
            d = self.docs[did]
            sha = self.sha(did)
            base = {"id": did, "from_org": str(d["org_id"]), "filename": d.get("original_filename"),
                    "status": d.get("status"), "company": company, "live": True}
            if sha and (sha in kept_shas or sha in seen):
                ref = seen.get(sha) or next(k for k in kept_source if self.sha(k) == sha)
                dec[did] = dict(base, action="archive", reason="archived: duplicate (%s)" % ref,
                                _place="company")
                continue
            if sha:
                seen[sha] = did
            dec[did] = dict(base, action="keep", reason="no period detected in the document",
                            _place="company")
            self.plan.warnings.append("document %s (%r): no period detected — kept live"
                                      % (did, d.get("original_filename")))

    def _company_name(self, company: str) -> str:
        best: Optional[Tuple[int, str, str]] = None
        for did in sorted(self.in_scope_docs):
            if self.key(did) != company:
                continue
            ident = self.ident(did)
            if not ident or not ident.company_name:
                continue
            signal = (ident.sources.get("company_name") or {}).get("signal") or "filename"
            cand = (_NAME_SIGNAL_RANK.get(signal, 8), ident.company_name, did)
            if best is None or cand < best:
                best = cand
        if best:
            return best[1]
        return company.split(":", 1)[1]

    def _company_caen(self, company: str) -> Optional[str]:
        for did in sorted(self.in_scope_docs):
            ident = self.ident(did)
            if ident and self.key(did) == company and ident.caen_code:
                return ident.caen_code
        return None

    def _identity_sources(self, company: str, org: str, own_source: Optional[str]) -> Dict[str, Any]:
        best: Optional[Tuple[int, str, Dict[str, Any]]] = None
        for did in sorted(self.in_scope_docs):
            ident = self.ident(did)
            if not ident or self.key(did) != company:
                continue
            src = ident.sources.get("cui") or ident.sources.get("company_name") or {}
            rank = _CUI_SIGNAL_RANK.get(src.get("signal"), 5)
            cand = (rank, did, {"signal": src.get("signal"), "evidence": src.get("evidence"),
                                "document_id": did})
            if best is None or cand[:2] < best[:2]:
                best = cand
        out: Dict[str, Any] = {"workspace": {"signal": "ws_migration", "evidence": own_source or "created"}}
        if best:
            out["identity"] = best[2]
        return out

    # ── operations ────────────────────────────────────────────────────

    def _emit_ops(self, user: str, created: Sequence[str], holding: str, uses_holding: bool,
                  archive_orgs: Sequence[str], doc_dec: Mapping[str, Dict[str, Any]]) -> None:
        ops = self.plan.ops
        currency = "RON"
        for o in self.live:
            if self.orgs[o].get("default_currency"):
                currency = self.orgs[o]["default_currency"]
                break

        # 1. organizations + memberships + org_prefs
        for company in created:
            oid = self.company_ws[company]
            caen = self._company_caen(company)
            ops.append({"op": "insert", "table": "organizations", "row": {
                "id": oid, "name": self._company_name(company), "industry_key": None,
                "industry_display_name": None, "default_currency": currency,
                "caen_code": caen, "caen_code_source": "auto_suggested" if caen else None,
                "archived_at": None, "purge_after": None}})
        if uses_holding and holding not in self.orgs:
            ops.append({"op": "insert", "table": "organizations", "row": {
                "id": holding, "name": HOLDING_NAME.format(date=self.date), "industry_key": None,
                "industry_display_name": None, "default_currency": currency, "caen_code": None,
                "caen_code_source": None, "archived_at": NOW, "purge_after": None}})
        new_orgs = [self.company_ws[c] for c in created] + ([holding] if uses_holding else [])
        have = {(str(m["org_id"]), str(m["user_id"])) for ms in self.members.values() for m in ms}
        for oid in new_orgs:
            if (oid, user) not in have:
                ops.append({"op": "insert", "table": "memberships",
                            "row": {"org_id": oid, "user_id": user, "role": "owner"}})
        for company, oid in sorted(self.company_ws.items(), key=lambda kv: kv[1]):
            cui = company[4:] if company.startswith("cui:") else None
            name = self._company_name(company)
            prefs = self.prefs.get(oid) or {}
            # Already stamped (by an operator or an earlier run): never
            # re-written, so a later run that happens to read a different
            # spelling of the name does not churn the prefs.
            if prefs.get("cui") == cui and prefs.get("company_name") and "identity_sources" in prefs:
                continue
            own_src = None
            for w in self.plan.workspaces:
                if w["org_id"] == oid:
                    own_src = w.get("company_source")
            ops.append({"op": "merge_prefs", "table": "org_prefs", "key": {"org_id": oid}, "merge": {
                "cui": cui, "company_name": name,
                "identity_sources": self._identity_sources(company, oid, own_src)}})

        # 2. storage copies for every document changing workspace
        doc_moves: Dict[str, Dict[str, Any]] = {}
        for did, dd in sorted(doc_dec.items()):
            d = self.docs[did]
            cur = str(d["org_id"])
            final = self.doc_final_org.get(did, cur)
            patch: Dict[str, Any] = {}
            if final != cur:
                patch["org_id"] = final
                path = d.get("storage_path")
                if path:
                    first, _, rest = str(path).partition("/")
                    if first != cur or not rest:
                        self.plan.blocking.append(
                            "document %s: storage_path %r is not under its own workspace %s"
                            % (did, path, cur))
                        continue
                    new_path = "%s/%s" % (final, rest)
                    patch["storage_path"] = new_path
                    f = self.facts.get(did)
                    if not (f and f.object_exists is False):
                        ops.append({"op": "copy_object", "bucket": "documents", "document_id": did,
                                    "from_path": path, "from_org": cur, "to_path": new_path,
                                    "to_org": final, "content_type": d.get("mime_type")})
            if dd["action"] == "archive" and d.get("deleted_at") is None:
                patch["deleted_at"] = NOW
                patch["error"] = dd["reason"]
            elif dd["action"] == "follow_period" and d.get("deleted_at") is not None:
                # A period's source never stays in a trash: emptying it
                # would cascade the period away (rule 6).
                patch["deleted_at"] = None
            doc_moves[did] = patch

        # 3. period-scoped rows follow their period, document-scoped rows their document
        moved_periods = {pid: f for pid, f in self.period_final_org.items()
                         if f != str(self.periods[pid]["org_id"])}
        moved_docs = {did: f for did, f in self.doc_final_org.items()
                      if f != str(self.docs[did]["org_id"])}
        moved_alerts: Dict[str, str] = {}
        moved_datasets: Dict[str, str] = {}
        for table in sorted(self.t):
            if table in NOT_SWEPT:
                continue
            rows = self.t.get(table) or []
            if not rows:
                continue
            cols = set().union(*(r.keys() for r in rows))
            org_col = next((c for c in ORG_COLUMNS if c in cols), None)
            if org_col is None:
                continue
            pk = pk_for(table, self.pks)
            for r in sorted(rows, key=lambda r: canonical_json([r.get(c) for c in pk])):
                target = None
                pid = str(r.get("period_id") or "")
                if pid and pid in moved_periods:
                    target = moved_periods[pid]
                elif not pid and r.get("document_id") and str(r["document_id"]) in moved_docs:
                    target = moved_docs[str(r["document_id"])]
                if target and str(r.get(org_col)) != target:
                    ops.append({"op": "update", "table": table, "key": {c: r.get(c) for c in pk},
                                "set": {org_col: target}, "expect": {org_col: r.get(org_col)}})
                    if table == "alerts":
                        moved_alerts[str(r["id"])] = target
                    if table == "sales_datasets":
                        moved_datasets[str(r["id"])] = target
        for table, ref, moved in (("alert_states", "alert_id", moved_alerts),
                                  ("sku_lines", "dataset_id", moved_datasets),
                                  ("sku_aggregates", "dataset_id", moved_datasets)):
            pk = pk_for(table, self.pks)
            for r in self.t.get(table) or []:
                target = moved.get(str(r.get(ref)))
                if target and str(r.get("org_id")) != target:
                    ops.append({"op": "update", "table": table, "key": {c: r.get(c) for c in pk},
                                "set": {"org_id": target}, "expect": {"org_id": r.get("org_id")}})

        # 4. periods change workspace
        for pid in sorted(moved_periods):
            ops.append({"op": "update", "table": "financial_periods", "key": {"id": pid},
                        "set": {"org_id": moved_periods[pid]},
                        "expect": {"org_id": self.periods[pid]["org_id"]}})

        # 5. documents: workspace, storage path, period link, archive stamp
        for did, dd in sorted(doc_dec.items()):
            if did not in doc_moves:
                continue
            d = self.docs[did]
            patch = doc_moves[did]
            final = self.doc_final_org.get(did, str(d["org_id"]))
            pid = str(d.get("period_id") or "")
            if pid and self.period_final_org.get(pid, str((self.periods.get(pid) or {}).get("org_id") or "")) != final:
                patch["period_id"] = None
            kept_pid = dd.get("period")
            if kept_pid and pid != kept_pid:
                patch["period_id"] = kept_pid
            if kept_pid and kept_pid in self.redates:
                old_end = str(self.periods[kept_pid].get("period_end"))
                if d.get("period_end_hint") and str(d.get("period_end_hint")) == old_end:
                    patch["period_end_hint"] = self.redates[kept_pid]
            if patch:
                ops.append({"op": "update", "table": "documents", "key": {"id": did},
                            "set": patch, "expect": {c: d.get(c) for c in patch}})
        # documents outside the decisions whose period left their workspace
        for did in sorted(self.in_scope_docs):
            if did in doc_dec:
                continue
            d = self.docs[did]
            pid = str(d.get("period_id") or "")
            if pid and pid in self.period_final_org and self.period_final_org[pid] != str(d["org_id"]):
                ops.append({"op": "update", "table": "documents", "key": {"id": did},
                            "set": {"period_id": None}, "expect": {"period_id": d.get("period_id")}})

        # 6. re-date
        for pid in sorted(self.redates):
            p = self.periods[pid]
            new_end = self.redates[pid]
            patch = {"period_end": new_end}
            if str(p.get("period_start")) == str(p.get("period_end")):
                patch["period_start"] = new_end
            ops.append({"op": "update", "table": "financial_periods", "key": {"id": pid},
                        "set": patch, "expect": {c: p.get(c) for c in patch}})

        # 7. archive the split workspaces; nobody is left sitting in one
        for o in archive_orgs:
            ops.append({"op": "update", "table": "organizations", "key": {"id": o},
                        "set": {"archived_at": NOW, "purge_after": None},
                        "expect": {"archived_at": None, "purge_after": self.orgs[o].get("purge_after")}})
        for up in self.t.get("user_prefs") or []:
            if str(up.get("user_id")) == user and up.get("active_org_id") in archive_orgs:
                ops.append({"op": "update", "table": "user_prefs", "key": {"user_id": user},
                            "set": {"active_org_id": None},
                            "expect": {"active_org_id": up.get("active_org_id")}})

        # fill names into the reanalysis list
        for item in self.plan.needs_reanalysis:
            if item["user_id"] == user and item.get("company_name") is None:
                item["company_name"] = self._company_name(item["company"])
                item["org_id"] = self.company_ws.get(item["company"])


def build_plan(tables: Mapping[str, List[Mapping[str, Any]]], facts: Mapping[str, Any], *,
               migration_date: str, pks: Optional[Mapping[str, Sequence[str]]] = None,
               stale_before: Optional[str] = None) -> Plan:
    """The migration plan for ``tables``. See the module docstring."""
    return _Planner(tables, facts, migration_date=migration_date, pks=pks,
                    stale_before=stale_before).build()


# ── facts from stored bytes ────────────────────────────────────────────

def facts_from_documents(tables: Mapping[str, List[Mapping[str, Any]]],
                         fetch: Callable[[Mapping[str, Any]], Tuple[Optional[bytes], Optional[bool], Optional[str]]],
                         *, registry: Any = None, rules: Sequence[Mapping[str, Any]] = (),
                         log: Callable[[str], None] = lambda _m: None) -> Dict[str, DocFacts]:
    """Identify every financial document from its bytes.

    ``fetch(document_row) -> (content or None, object_exists, read_error)``
    is the only I/O, injected (the migration script downloads through the
    tenant-asserting storage client; tests pass bytes). Operator-verified
    identities (``rules``) are layered on with ``apply_known_identity``: a
    CUI the document prints always wins over a rule."""
    from engine.workspaces.company_identity import (
        apply_known_identity,
        identify_document,
        match_known_identity,
    )

    members: Dict[str, List[Mapping[str, Any]]] = defaultdict(list)
    for m in tables.get("memberships") or []:
        members[str(m["org_id"])].append(m)
    owner = {org: str(ms[0]["user_id"]) for org, ms in members.items() if len(ms) == 1}
    facts: Dict[str, DocFacts] = {}
    for d in sorted(tables.get("documents") or [], key=lambda r: str(r["id"])):
        if not _financial(d):
            continue
        did, org = str(d["id"]), str(d["org_id"])
        content, exists, err = fetch(d)
        sha = hashlib.sha256(content).hexdigest() if content else None
        ident = identify_document(content or b"", d.get("original_filename") or "", registry=registry)
        rule = match_known_identity(rules, user_id=owner.get(org) or d.get("uploaded_by"),
                                    content_sha256=sha or d.get("content_hash"),
                                    filename=d.get("original_filename"))
        if rule:
            ident, conflict = apply_known_identity(ident, rule, registry=registry)
            if conflict:
                log("identity conflict on %s (%r): %s" % (did, d.get("original_filename"), conflict))
        facts[did] = DocFacts(identity=ident, sha256=sha, object_exists=exists, read_error=err)
    return facts


# ── gates ──────────────────────────────────────────────────────────────

def empty_live_periods(tables: Mapping[str, List[Mapping[str, Any]]], *,
                       orgs: Optional[Iterable[str]] = None) -> List[Tuple[str, str]]:
    """G4 — every period in a live workspace has a live, analysed source
    document IN THE SAME workspace and something persisted. Returns the
    offenders as (period id, why)."""
    org_rows = {str(o["id"]): o for o in tables.get("organizations") or []}
    scope = set(orgs) if orgs is not None else None
    docs = {str(d["id"]): d for d in tables.get("documents") or []}
    metric = {str(r["period_id"]) for t in ("calculated_metrics", "statement_line_items")
              for r in tables.get(t) or [] if r.get("period_id")}
    out = []
    for p in tables.get("financial_periods") or []:
        oid = str(p["org_id"])
        if not _is_live_org(org_rows.get(oid)) or (scope is not None and oid not in scope):
            continue
        pid = str(p["id"])
        src = docs.get(str(p.get("source_document_id") or ""))
        if src is None:
            out.append((pid, "no source document"))
        elif src.get("deleted_at") is not None:
            out.append((pid, "source deleted"))
        elif src.get("status") != ANALYZED:
            out.append((pid, "source %s" % src.get("status")))
        elif str(src.get("org_id")) != oid:
            out.append((pid, "source in another workspace"))
        elif pid not in metric and not p.get("assembled_canonical_v1"):
            out.append((pid, "nothing persisted"))
    return sorted(out)


def cross_workspace_links(tables: Mapping[str, List[Mapping[str, Any]]]) -> List[str]:
    """Rule 8 — documents whose period_id points into another workspace,
    and period-scoped rows filed under a workspace their period is not in."""
    periods = {str(p["id"]): str(p["org_id"]) for p in tables.get("financial_periods") or []}
    out = []
    for d in tables.get("documents") or []:
        pid = str(d.get("period_id") or "")
        if pid and pid in periods and periods[pid] != str(d["org_id"]):
            out.append("document %s -> period %s" % (d["id"], pid))
    for table, rows in sorted(tables.items()):
        # Its own list, NOT the planner's NOT_SWEPT: a table the planner
        # forgot to sweep must still be caught here.
        if table in ("financial_periods", "documents"):
            continue
        for r in rows or []:
            pid = str(r.get("period_id") or "")
            col = next((c for c in ORG_COLUMNS if c in r), None)
            if pid and col and pid in periods and str(r.get(col)) != periods[pid]:
                out.append("%s %s -> period %s" % (table, r.get("id"), pid))
    return out


def period_source_hazards(tables: Mapping[str, List[Mapping[str, Any]]]) -> List[Tuple[str, str]]:
    """Periods one hard delete away from erasure. ``financial_periods.
    source_document_id`` is ``ON DELETE CASCADE`` (schema.sql:571): when the
    source document row goes, the period and every row scoped to it go with
    it. A source in the TRASH goes with any "Clear all" / purge of that
    trash; a source in ANOTHER workspace goes when that workspace's trash is
    emptied or the workspace is purged. Returns (period id, why)."""
    docs = {str(d["id"]): d for d in tables.get("documents") or []}
    out: List[Tuple[str, str]] = []
    for p in tables.get("financial_periods") or []:
        sid = str(p.get("source_document_id") or "")
        d = docs.get(sid) if sid else None
        if d is None:
            continue
        if d.get("deleted_at") is not None:
            out.append((str(p["id"]), "source document %s is in the trash" % sid))
        elif str(d.get("org_id")) != str(p.get("org_id")):
            out.append((str(p["id"]), "source document %s is in workspace %s, the period in %s"
                        % (sid, d.get("org_id"), p.get("org_id"))))
    return sorted(out)


def new_cascade_hazards(before: Mapping[str, List[Mapping[str, Any]]],
                        after: Mapping[str, List[Mapping[str, Any]]]) -> List[Tuple[str, str]]:
    """The ``period_source_hazards`` of ``after`` that a migration from
    ``before`` answers for: every one ``before`` did not have, and every one
    of a period whose workspace CHANGED (a period the migration moved must
    arrive whole — its source with it, out of any trash)."""
    had = set(period_source_hazards(before))
    org_before = {str(p["id"]): str(p.get("org_id")) for p in before.get("financial_periods") or []}
    org_after = {str(p["id"]): str(p.get("org_id")) for p in after.get("financial_periods") or []}
    return [(pid, why) for pid, why in period_source_hazards(after)
            if (pid, why) not in had or org_before.get(pid) != org_after.get(pid)]


# ── human report ───────────────────────────────────────────────────────

def render_report(plan: Plan) -> str:
    """The dry-run's human table. Every decision with its reason."""
    lines: List[str] = []
    w = lines.append
    w("WORKSPACE MIGRATION PLAN — %s — %d operations — ops sha256 %s"
      % (plan.migration_date, len(plan.ops), plan.ops_sha256()))
    for u in plan.users:
        uid = u["user_id"]
        w("")
        w("USER %s" % uid)
        w("  workspaces")
        for ws in plan.workspaces:
            if ws["user_id"] != uid:
                continue
            w("    %-16s %-36s %-34s company=%s  (%s)" % (
                ws["action"], ws["org_id"], repr(ws["name"])[:34], ws["company"], ws["company_source"]))
        w("  periods")
        for p in plan.periods:
            if not any(ws["org_id"] == p["from_org"] and ws["user_id"] == uid for ws in plan.workspaces):
                continue
            redate = (" re-date %s -> %s (%s)" % (p["period_end"], p["redate_to"],
                                                  (p.get("redate_signal") or {}).get("signal"))
                      if p.get("redate_to") else "")
            w("    %-9s %s %s  %s -> %s  company=%s  %s%s" % (
                p["action"], p["id"], p["period_end"], p["from_org"][:8], p.get("to_org", "")[:8],
                p.get("company"), p.get("reason") or "", redate))
        w("  documents")
        for d in plan.documents:
            if not any(ws["org_id"] == d["from_org"] and ws["user_id"] == uid for ws in plan.workspaces):
                continue
            if d["action"] == "untouched" and d.get("reason") == "trash":
                continue
            moved = "" if d.get("to_org") == d["from_org"] else "  %s -> %s" % (d["from_org"][:8], d["to_org"][:8])
            w("    %-13s %s %-9s %-44s company=%s  %s%s" % (
                d["action"], d["id"], d.get("status"), repr(d.get("filename"))[:44], d.get("company"),
                d.get("reason") or "", moved))
        items = [n for n in plan.needs_reanalysis if n["user_id"] == uid]
        if items:
            w("  needs_reanalysis")
            for n in items:
                w("    %s %s %r -> workspace %s  document %s (%s, %s)" % (
                    n["company"], n["month"], n.get("company_name"), n.get("org_id"),
                    n["document_id"], n.get("filename"), n.get("status")))
    if plan.warnings:
        w("")
        w("WARNINGS")
        for x in plan.warnings:
            w("  - %s" % x)
    if plan.blocking:
        w("")
        w("BLOCKING (--execute refuses)")
        for x in plan.blocking:
            w("  ! %s" % x)
    counts = Counter("%s %s" % (op["op"], op.get("table", op.get("bucket", ""))) for op in plan.ops)
    w("")
    w("OPERATIONS")
    for k in sorted(counts):
        w("  %5d  %s" % (counts[k], k))
    return "\n".join(lines)
