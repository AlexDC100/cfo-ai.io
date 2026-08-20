"""Pack loader — YAML directory -> schema-validated ``CompiledPack``.

Pipeline per pack directory (all five files REQUIRED):

    pack.yaml / classification.yaml / checks.yaml /
    statement_map.yaml / reconcile.yaml
        -> yaml.safe_load                       (PyYAML — already a
                                                 pyproject dependency)
        -> hand-rolled validation               (py3.9, no new deps;
                                                 EVERY problem collected
                                                 into PackIssue records,
                                                 then one PackSchemaError)
        -> compiled immutable form              (frozen dataclasses,
                                                 deep-frozen bags,
                                                 precompiled rule index:
                                                 exact O(1) dict /
                                                 longest-prefix dict /
                                                 declaration-order ranges)
        -> pack_hash                            (sha256 over the canonical
                                                 serialized CONTENT —
                                                 sorted-key compact JSON of
                                                 CompiledPack.canonical_form;
                                                 formatting/comments/path
                                                 never affect it)

Effective-dated resolution: ``resolve(packs, jurisdiction, period_end)``
returns THE pack whose [effective_from, effective_to) window contains
period_end. Deterministic; typed errors: ``NoPackFoundError`` when no
window matches, ``AmbiguousPackError`` when more than one does (that
pack data is broken — lint flags it as ``effective-overlap``).

SHADOW-PHASE LEAF: nothing in the production pipeline calls this yet.
"""
from __future__ import annotations

import hashlib
import json
from datetime import date
from pathlib import Path
from types import MappingProxyType
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple, Union

import yaml

from .schema import (
    CHECK_IMPLS,
    KNOWN_DECLARATIVE_CHECK_IDS,
    PACK_SCHEMA_VERSION,
    RECONCILE_PLACEMENTS,
    AmbiguousPackError,
    ChangelogEntry,
    CheckConfig,
    ClassificationRule,
    CompiledPack,
    LegalSource,
    NoPackFoundError,
    PackIdentity,
    PackIssue,
    PackSchemaError,
    ReconcilePolicy,
    SideFlip,
    StatementNode,
    freeze_json,
    registered_check_impls,
)

__all__ = [
    "PACK_FILES",
    "load_pack",
    "discover_packs",
    "resolve",
    "compute_pack_hash",
]

#: The five required data files of a pack directory, in load order.
PACK_FILES = (
    "pack.yaml",
    "classification.yaml",
    "checks.yaml",
    "statement_map.yaml",
    "reconcile.yaml",
)

_SIDES = ("debit", "credit")


# --- issue collector --------------------------------------------------------


class _Collector:
    """Accumulates PackIssues so ONE load reports EVERY problem."""

    def __init__(self) -> None:
        self.issues: List[PackIssue] = []

    def error(self, code: str, message: str,
              file: Optional[str] = None, where: Optional[str] = None) -> None:
        self.issues.append(PackIssue("error", code, message, file, where))

    def errors(self) -> Tuple[PackIssue, ...]:
        return tuple(i for i in self.issues if i.severity == "error")

    def raise_if_errors(self) -> None:
        errs = self.errors()
        if errs:
            raise PackSchemaError(errs)


# --- primitive field validators ---------------------------------------------


def _req_str(c: _Collector, data: Dict[str, Any], key: str, file: str,
             where: Optional[str] = None) -> str:
    v = data.get(key)
    if not isinstance(v, str) or not v.strip():
        c.error("missing-field", "'%s' must be a non-empty string, got %r" % (key, v),
                file, where)
        return ""
    return v


def _opt_bool(c: _Collector, data: Dict[str, Any], key: str, default: bool,
              file: str, where: Optional[str] = None) -> bool:
    v = data.get(key, default)
    if not isinstance(v, bool):
        c.error("bad-type", "'%s' must be a boolean, got %r" % (key, v), file, where)
        return default
    return v


def _parse_date(c: _Collector, raw: Any, key: str, file: str) -> Optional[date]:
    # yaml.safe_load already parses ISO dates into datetime.date
    if isinstance(raw, date):
        return raw
    if isinstance(raw, str):
        try:
            return date.fromisoformat(raw)
        except ValueError:
            pass
    c.error("bad-date", "'%s' must be an ISO date (YYYY-MM-DD), got %r" % (key, raw),
            file)
    return None


def _digit_str(c: _Collector, raw: Any, key: str, file: str,
               where: Optional[str]) -> Optional[str]:
    """Account-code fields: digits only, kept as STRINGS (a YAML author
    writing ``exact: 5121`` unquoted gets it coerced, never rejected —
    but 05xx codes must be quoted to survive, so int coercion warns via
    normal str())."""
    if isinstance(raw, int) and not isinstance(raw, bool):
        raw = str(raw)
    if not isinstance(raw, str) or not raw.isdigit():
        c.error("bad-code", "'%s' must be a digit string, got %r" % (key, raw),
                file, where)
        return None
    return raw


# --- pack.yaml --------------------------------------------------------------


def _load_identity(c: _Collector, data: Any) -> Optional[PackIdentity]:
    f = "pack.yaml"
    if not isinstance(data, dict):
        c.error("bad-file", "pack.yaml must be a mapping", f)
        return None
    schema_version = data.get("schema_version", PACK_SCHEMA_VERSION)
    if schema_version != PACK_SCHEMA_VERSION:
        c.error("bad-schema-version",
                "schema_version %r is not %r — bump the loader, don't parse leniently"
                % (schema_version, PACK_SCHEMA_VERSION), f)
    jurisdiction = _req_str(c, data, "jurisdiction", f)
    pack_id = _req_str(c, data, "pack_id", f)
    version = _req_str(c, data, "version", f)
    eff_from = None
    if "effective_from" in data:
        eff_from = _parse_date(c, data.get("effective_from"), "effective_from", f)
    else:
        c.error("missing-field", "'effective_from' is required", f)
    eff_to: Optional[date] = None
    if data.get("effective_to") is not None:
        eff_to = _parse_date(c, data.get("effective_to"), "effective_to", f)
    if eff_from is not None and eff_to is not None and eff_to <= eff_from:
        c.error("bad-effective-window",
                "effective_to %s must be after effective_from %s (half-open window)"
                % (eff_to, eff_from), f)

    sources: List[LegalSource] = []
    raw_sources = data.get("legal_sources")
    if not isinstance(raw_sources, list) or not raw_sources:
        c.error("missing-field", "'legal_sources' must be a non-empty list", f)
    else:
        for i, s in enumerate(raw_sources):
            where = "legal_sources[%d]" % i
            if isinstance(s, str) and s.strip():
                sources.append(LegalSource(citation=s))
            elif isinstance(s, dict):
                citation = _req_str(c, s, "citation", f, where)
                url = s.get("url")
                if url is not None and not isinstance(url, str):
                    c.error("bad-type", "'url' must be a string", f, where)
                    url = None
                if citation:
                    sources.append(LegalSource(citation=citation, url=url))
            else:
                c.error("bad-type",
                        "legal source must be a citation string or mapping, got %r"
                        % (s,), f, where)

    changelog: List[ChangelogEntry] = []
    raw_log = data.get("changelog")
    if not isinstance(raw_log, list) or not raw_log:
        c.error("missing-field", "'changelog' must be a non-empty list", f)
    else:
        for i, e in enumerate(raw_log):
            where = "changelog[%d]" % i
            if not isinstance(e, dict):
                c.error("bad-type", "changelog entry must be a mapping", f, where)
                continue
            ver = _req_str(c, e, "version", f, where)
            d = e.get("date")
            parsed = _parse_date(c, d, "date", f) if d is not None else None
            if parsed is None:
                continue
            notes = _req_str(c, e, "notes", f, where)
            if ver and notes:
                changelog.append(ChangelogEntry(ver, parsed.isoformat(), notes))

    unknown = set(data) - {
        "schema_version", "jurisdiction", "pack_id", "version",
        "effective_from", "effective_to", "legal_sources", "changelog",
    }
    for k in sorted(unknown):
        c.error("unknown-field", "unknown key %r in pack.yaml" % k, f)

    if c.errors():
        return None
    assert eff_from is not None
    return PackIdentity(
        jurisdiction=jurisdiction, pack_id=pack_id, version=version,
        effective_from=eff_from, effective_to=eff_to,
        legal_sources=tuple(sources), changelog=tuple(changelog),
    )


# --- classification.yaml ----------------------------------------------------


def _load_rules(c: _Collector, data: Any) -> Tuple[ClassificationRule, ...]:
    f = "classification.yaml"
    if not isinstance(data, dict) or not isinstance(data.get("rules"), list):
        c.error("bad-file", "classification.yaml must be a mapping with a 'rules' list", f)
        return ()
    rules: List[ClassificationRule] = []
    seen_ids: Dict[str, int] = {}
    for i, raw in enumerate(data["rules"]):
        where = "rules[%d]" % i
        if not isinstance(raw, dict):
            c.error("bad-type", "rule must be a mapping", f, where)
            continue
        rule_id = _req_str(c, raw, "rule_id", f, where)
        if rule_id:
            where = rule_id
            if rule_id in seen_ids:
                c.error("duplicate-rule-id",
                        "rule_id %r already declared at rules[%d]"
                        % (rule_id, seen_ids[rule_id]), f, where)
            seen_ids.setdefault(rule_id, i)
        line_id = _req_str(c, raw, "line_id", f, where)

        matchers = [k for k in ("exact", "prefix", "range") if k in raw]
        if len(matchers) != 1:
            c.error("bad-matcher",
                    "rule must have exactly one of exact/prefix/range, got %s"
                    % (matchers or "none"), f, where)
            continue
        kind = matchers[0]
        exact = prefix = range_from = range_to = None
        if kind == "exact":
            exact = _digit_str(c, raw["exact"], "exact", f, where)
            if exact is None:
                continue
        elif kind == "prefix":
            prefix = _digit_str(c, raw["prefix"], "prefix", f, where)
            if prefix is None:
                continue
        else:
            rng = raw["range"]
            if not isinstance(rng, dict):
                c.error("bad-matcher", "'range' must be a {from, to} mapping", f, where)
                continue
            range_from = _digit_str(c, rng.get("from"), "range.from", f, where)
            range_to = _digit_str(c, rng.get("to"), "range.to", f, where)
            if range_from is None or range_to is None:
                continue
            if len(range_from) != len(range_to):
                c.error("bad-range",
                        "range bounds must be digit strings of EQUAL length "
                        "(prefix-band semantics), got %r..%r"
                        % (range_from, range_to), f, where)
                continue
            if int(range_from) > int(range_to):
                c.error("bad-range", "range.from %s > range.to %s"
                        % (range_from, range_to), f, where)
                continue

        contra = _opt_bool(c, raw, "contra", False, f, where)

        side_flip = None
        raw_flip = raw.get("side_flip")
        if raw_flip is not None:
            if not isinstance(raw_flip, dict):
                c.error("bad-side-flip", "'side_flip' must be a {side, line_id} mapping",
                        f, where)
            else:
                side = raw_flip.get("side")
                flip_line = raw_flip.get("line_id")
                ok = True
                if side not in _SIDES:
                    c.error("bad-side-flip",
                            "side_flip.side must be one of %s, got %r"
                            % (list(_SIDES), side), f, where)
                    ok = False
                if not isinstance(flip_line, str) or not flip_line.strip():
                    c.error("bad-side-flip", "side_flip.line_id must be a non-empty string",
                            f, where)
                    ok = False
                if ok:
                    side_flip = SideFlip(side=side, line_id=flip_line)

        description = raw.get("description", "")
        if not isinstance(description, str):
            c.error("bad-type", "'description' must be a string", f, where)
            description = ""

        unknown = set(raw) - {
            "rule_id", "line_id", "exact", "prefix", "range",
            "contra", "side_flip", "description",
        }
        for k in sorted(unknown):
            c.error("unknown-field", "unknown key %r on rule" % k, f, where)

        if rule_id and line_id:
            rules.append(ClassificationRule(
                rule_id=rule_id, kind=kind, line_id=line_id,
                exact=exact, prefix=prefix,
                range_from=range_from, range_to=range_to,
                contra=contra, side_flip=side_flip, description=description,
            ))
    return tuple(rules)


# --- checks.yaml ------------------------------------------------------------


def _load_checks(c: _Collector, data: Any) -> Tuple[CheckConfig, ...]:
    f = "checks.yaml"
    if not isinstance(data, dict) or not isinstance(data.get("checks"), list):
        c.error("bad-file", "checks.yaml must be a mapping with a 'checks' list", f)
        return ()
    checks: List[CheckConfig] = []
    seen: Dict[str, int] = {}
    for i, raw in enumerate(data["checks"]):
        where = "checks[%d]" % i
        if not isinstance(raw, dict):
            c.error("bad-type", "check must be a mapping", f, where)
            continue
        check_id = _req_str(c, raw, "check_id", f, where)
        if check_id:
            where = check_id
            if check_id in seen:
                c.error("duplicate-check-id",
                        "check_id %r already declared at checks[%d]"
                        % (check_id, seen[check_id]), f, where)
            seen.setdefault(check_id, i)
        enabled = _opt_bool(c, raw, "enabled", True, f, where)
        impl = raw.get("impl")
        if impl is not None and (not isinstance(impl, str) or not impl.strip()):
            c.error("bad-type", "'impl' must be a non-empty string", f, where)
            impl = None
        # The escape-hatch gate: packs may ONLY reference registered ids.
        if impl is not None and impl not in CHECK_IMPLS:
            c.error("unknown-check-impl",
                    "impl %r is not registered in CHECK_IMPLS (registered: %s)"
                    % (impl, ", ".join(registered_check_impls()) or "<none>"),
                    f, where)
        if check_id and check_id not in KNOWN_DECLARATIVE_CHECK_IDS and impl is None:
            c.error("unknown-check-id",
                    "check_id %r is not a known declarative check (D0-D9) and "
                    "names no registered impl — per-jurisdiction checks must "
                    "reference a CHECK_IMPLS id" % check_id, f, where)
        raw_params = raw.get("params", {})
        if not isinstance(raw_params, dict):
            c.error("bad-type", "'params' must be a mapping", f, where)
            raw_params = {}
        unknown = set(raw) - {"check_id", "enabled", "impl", "params"}
        for k in sorted(unknown):
            c.error("unknown-field", "unknown key %r on check" % k, f, where)
        if check_id:
            checks.append(CheckConfig(
                check_id=check_id, enabled=enabled, impl=impl,
                params=freeze_json(raw_params, "checks.%s.params" % check_id),
            ))
    return tuple(checks)


# --- statement_map.yaml -----------------------------------------------------


def _load_statement_nodes(
    c: _Collector, raw: Any, statement: str, seen_ids: Dict[str, str],
    path: str,
) -> Tuple[StatementNode, ...]:
    f = "statement_map.yaml"
    if raw is None:
        return ()
    if not isinstance(raw, list):
        c.error("bad-type", "'%s' must be a list of nodes" % path, f)
        return ()
    nodes: List[StatementNode] = []
    for i, entry in enumerate(raw):
        where = "%s[%d]" % (path, i)
        if not isinstance(entry, dict):
            c.error("bad-type", "statement node must be a mapping", f, where)
            continue
        node_id = _req_str(c, entry, "id", f, where)
        label = _req_str(c, entry, "label", f, where)
        if node_id:
            where = node_id
            if node_id in seen_ids:
                c.error("duplicate-line-id",
                        "line id %r already declared in %s"
                        % (node_id, seen_ids[node_id]), f, where)
            seen_ids.setdefault(node_id, statement)
        children = _load_statement_nodes(
            c, entry.get("children"), statement, seen_ids,
            "%s.children" % (node_id or where),
        )
        unknown = set(entry) - {"id", "label", "children"}
        for k in sorted(unknown):
            c.error("unknown-field", "unknown key %r on statement node" % k, f, where)
        if node_id and label:
            nodes.append(StatementNode(id=node_id, label=label, children=children))
    return tuple(nodes)


def _load_statement_map(
    c: _Collector, data: Any
) -> Tuple[Tuple[StatementNode, ...], Tuple[StatementNode, ...]]:
    f = "statement_map.yaml"
    if not isinstance(data, dict) or not isinstance(data.get("statements"), dict):
        c.error("bad-file",
                "statement_map.yaml must be a mapping with a 'statements' mapping", f)
        return (), ()
    stmts = data["statements"]
    seen: Dict[str, str] = {}
    bs = _load_statement_nodes(c, stmts.get("balance_sheet"), "balance_sheet",
                               seen, "balance_sheet")
    pl = _load_statement_nodes(c, stmts.get("profit_loss"), "profit_loss",
                               seen, "profit_loss")
    if not bs:
        c.error("missing-field", "'statements.balance_sheet' must be a non-empty tree", f)
    if not pl:
        c.error("missing-field", "'statements.profit_loss' must be a non-empty tree", f)
    unknown = set(stmts) - {"balance_sheet", "profit_loss"}
    for k in sorted(unknown):
        c.error("unknown-field", "unknown statement %r (balance_sheet/profit_loss only)"
                % k, f)
    return bs, pl


# --- reconcile.yaml ---------------------------------------------------------


def _load_reconcile(c: _Collector, data: Any) -> Optional[ReconcilePolicy]:
    f = "reconcile.yaml"
    if not isinstance(data, dict):
        c.error("bad-file", "reconcile.yaml must be a mapping", f)
        return None
    threshold = data.get("threshold")
    if not isinstance(threshold, (int, float)) or isinstance(threshold, bool) \
            or not (0 < float(threshold) <= 1):
        c.error("bad-threshold",
                "'threshold' must be a number in (0, 1], got %r" % (threshold,), f)
        threshold = 0.0

    placements: Dict[str, str] = {}
    raw_rules = data.get("placement_rules")
    if not isinstance(raw_rules, list) or not raw_rules:
        c.error("missing-field", "'placement_rules' must be a non-empty list", f)
    else:
        for i, r in enumerate(raw_rules):
            where = "placement_rules[%d]" % i
            if not isinstance(r, dict):
                c.error("bad-type", "placement rule must be a mapping", f, where)
                continue
            cause = _req_str(c, r, "cause", f, where)
            placement = r.get("placement")
            if placement not in RECONCILE_PLACEMENTS:
                c.error("bad-placement",
                        "placement must be one of %s, got %r"
                        % (sorted(RECONCILE_PLACEMENTS), placement), f, where)
                continue
            if cause in placements:
                c.error("duplicate-placement-cause",
                        "cause %r declared twice" % cause, f, where)
            elif cause:
                placements[cause] = placement
        if placements and "default" not in placements:
            c.error("missing-default-placement",
                    "placement_rules must include a 'default' cause", f)

    labels: Dict[str, str] = {}
    raw_labels = data.get("adjustment_labels")
    if not isinstance(raw_labels, dict) or not raw_labels:
        c.error("missing-field",
                "'adjustment_labels' must be a non-empty {language: label} mapping", f)
    else:
        for lang, label in raw_labels.items():
            if not isinstance(lang, str) or not isinstance(label, str) \
                    or not lang.strip() or not label.strip():
                c.error("bad-type",
                        "adjustment_labels entries must be non-empty strings "
                        "(got %r: %r)" % (lang, label), f)
            else:
                labels[lang] = label

    unknown = set(data) - {"threshold", "placement_rules", "adjustment_labels"}
    for k in sorted(unknown):
        c.error("unknown-field", "unknown key %r in reconcile.yaml" % k, f)

    if c.errors():
        return None
    return ReconcilePolicy(
        threshold=float(threshold),
        placement_rules=freeze_json(placements, "reconcile.placement_rules"),
        adjustment_labels=freeze_json(labels, "reconcile.adjustment_labels"),
    )


# --- cross-file semantic validation ----------------------------------------


def _validate_cross(
    c: _Collector,
    rules: Tuple[ClassificationRule, ...],
    line_ids: Tuple[str, ...],
    leaf_ids: Tuple[str, ...],
) -> None:
    known = set(line_ids)
    leaves = set(leaf_ids)
    for r in rules:
        for label, target in (("line_id", r.line_id),
                              ("side_flip.line_id",
                               r.side_flip.line_id if r.side_flip else None)):
            if target is None:
                continue
            if target not in known:
                c.error("dangling-line-id",
                        "%s %r is not defined in statement_map.yaml"
                        % (label, target), "classification.yaml", r.rule_id)
            elif target not in leaves:
                c.error("non-leaf-target",
                        "%s %r targets a parent (subtotal) node — classification "
                        "must target leaves" % (label, target),
                        "classification.yaml", r.rule_id)

    # Index-level reachability: duplicate exact codes / duplicate prefixes
    # make the later rule unreachable under the fixed precedence — that is
    # data ambiguity, rejected at load (lint re-reports these findings).
    seen_exact: Dict[str, str] = {}
    seen_prefix: Dict[str, str] = {}
    seen_range: Dict[Tuple[str, str], str] = {}
    for r in rules:
        if r.kind == "exact":
            assert r.exact is not None
            if r.exact in seen_exact:
                c.error("rule-shadowed-exact",
                        "exact code %r already claimed by rule %r — this rule "
                        "is unreachable" % (r.exact, seen_exact[r.exact]),
                        "classification.yaml", r.rule_id)
            seen_exact.setdefault(r.exact, r.rule_id)
        elif r.kind == "prefix":
            assert r.prefix is not None
            if r.prefix in seen_prefix:
                c.error("rule-shadowed-prefix",
                        "prefix %r already claimed by rule %r — this rule "
                        "is unreachable" % (r.prefix, seen_prefix[r.prefix]),
                        "classification.yaml", r.rule_id)
            seen_prefix.setdefault(r.prefix, r.rule_id)
        else:
            key = (r.range_from or "", r.range_to or "")
            if key in seen_range:
                c.error("rule-shadowed-range",
                        "range %s..%s already claimed by rule %r — this rule "
                        "is unreachable" % (key[0], key[1], seen_range[key]),
                        "classification.yaml", r.rule_id)
            seen_range.setdefault(key, r.rule_id)


# --- hashing ----------------------------------------------------------------


def compute_pack_hash(canonical: Dict[str, Any]) -> str:
    """sha256 hex digest of the canonical pack content: sorted-key,
    compact-separator, ascii-only JSON — the same discipline as
    ``engine.ir.schema.content_hash``. Stable across loads, file
    formatting, key order, and directory location; changes on ANY
    semantic edit."""
    blob = json.dumps(canonical, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


# --- the loader -------------------------------------------------------------


def _read_yaml(c: _Collector, pack_dir: Path, name: str) -> Any:
    path = pack_dir / name
    if not path.is_file():
        c.error("missing-file", "required pack file %r is missing" % name, name)
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return yaml.safe_load(fh)
    except yaml.YAMLError as exc:
        c.error("yaml-parse-error", "cannot parse %s: %s" % (name, exc), name)
        return None


def load_pack(pack_dir: Union[str, Path]) -> CompiledPack:
    """Load, validate, and compile one pack directory.

    Raises ``PackSchemaError`` carrying EVERY collected issue when the
    directory is not a valid pack. On success returns the immutable
    ``CompiledPack`` with its precompiled rule index and content hash.
    """
    pack_dir = Path(pack_dir)
    c = _Collector()
    if not pack_dir.is_dir():
        c.error("missing-dir", "pack directory %s does not exist" % pack_dir)
        c.raise_if_errors()

    raw = {name: _read_yaml(c, pack_dir, name) for name in PACK_FILES}
    c.raise_if_errors()  # missing files / YAML syntax stop here

    identity = _load_identity(c, raw["pack.yaml"])
    rules = _load_rules(c, raw["classification.yaml"])
    checks = _load_checks(c, raw["checks.yaml"])
    bs, pl = _load_statement_map(c, raw["statement_map.yaml"])
    reconcile = _load_reconcile(c, raw["reconcile.yaml"])

    if not c.errors():
        # cross-file validation only makes sense on structurally-valid parts
        probe = CompiledPack(
            identity=identity, rules=rules, checks=checks,  # type: ignore[arg-type]
            balance_sheet=bs, profit_loss=pl,
            reconcile=reconcile, pack_hash="",  # type: ignore[arg-type]
        )
        _validate_cross(c, rules, probe.statement_line_ids(), probe.leaf_line_ids())
    c.raise_if_errors()
    assert identity is not None and reconcile is not None

    # -- compile the rule index (exact O(1) / longest-prefix / range scan) --
    exact_index: Dict[str, ClassificationRule] = {}
    prefix_index: Dict[str, ClassificationRule] = {}
    range_rules: List[ClassificationRule] = []
    for r in rules:
        if r.kind == "exact":
            exact_index[r.exact or ""] = r
        elif r.kind == "prefix":
            prefix_index[r.prefix or ""] = r
        else:
            range_rules.append(r)

    unhashed = CompiledPack(
        identity=identity, rules=rules, checks=checks,
        balance_sheet=bs, profit_loss=pl, reconcile=reconcile,
        pack_hash="",
        exact_index=freeze_json_mapping(exact_index),
        prefix_index=freeze_json_mapping(prefix_index),
        range_rules=tuple(range_rules),
    )
    pack_hash = compute_pack_hash(unhashed.canonical_form())
    return CompiledPack(
        identity=identity, rules=rules, checks=checks,
        balance_sheet=bs, profit_loss=pl, reconcile=reconcile,
        pack_hash=pack_hash,
        exact_index=unhashed.exact_index,
        prefix_index=unhashed.prefix_index,
        range_rules=unhashed.range_rules,
    )


def freeze_json_mapping(
    mapping: Dict[str, ClassificationRule]
) -> Mapping[str, ClassificationRule]:
    """Read-only view over a rule index dict (values are already frozen
    dataclasses, so proxying the dict completes the immutability)."""
    return MappingProxyType(dict(mapping))


# --- discovery + effective-dated resolution ---------------------------------


def discover_packs(root: Union[str, Path]) -> Tuple[CompiledPack, ...]:
    """Load every pack directory under ``root`` (any directory holding a
    pack.yaml; hidden directories skipped). Deterministic order:
    (jurisdiction, pack_id, effective_from, version). A broken pack
    raises its PackSchemaError — discovery is not a lint pass."""
    root = Path(root)
    if not root.is_dir():
        raise NoPackFoundError("pack root %s does not exist" % root)
    dirs = sorted(
        {p.parent for p in root.rglob("pack.yaml")
         if not any(part.startswith(".")
                    for part in p.parent.relative_to(root).parts)},
        key=lambda p: str(p),
    )
    packs = tuple(load_pack(d) for d in dirs)
    return tuple(sorted(
        packs,
        key=lambda p: (p.identity.jurisdiction, p.identity.pack_id,
                       p.identity.effective_from.isoformat(), p.identity.version),
    ))


def _as_date(period_end: Union[str, date], what: str = "period_end") -> date:
    if isinstance(period_end, date):
        return period_end
    if isinstance(period_end, str):
        try:
            return date.fromisoformat(period_end)
        except ValueError:
            pass
    raise NoPackFoundError(
        "%s must be a datetime.date or ISO date string, got %r" % (what, period_end)
    )


def resolve(
    packs: Sequence[CompiledPack],
    jurisdiction: str,
    period_end: Union[str, date],
) -> CompiledPack:
    """THE pack governing ``period_end`` for ``jurisdiction``.

    Effective-dated: a pack matches when period_end lies inside its
    half-open [effective_from, effective_to) window (open-ended when
    effective_to is null). Deterministic — the result depends only on
    the pack data and the arguments. Typed failures:

    * ``NoPackFoundError``  — no pack for the jurisdiction, or none
      whose window contains period_end (message lists the known windows).
    * ``AmbiguousPackError`` — more than one window contains period_end
      (broken pack data; lint flags it as ``effective-overlap``).
    """
    when = _as_date(period_end)
    if not isinstance(jurisdiction, str) or not jurisdiction.strip():
        raise NoPackFoundError("jurisdiction must be a non-empty string, got %r"
                               % (jurisdiction,))
    jur = jurisdiction.strip().upper()
    candidates = [p for p in packs if p.identity.jurisdiction.upper() == jur]
    if not candidates:
        known = sorted({p.identity.jurisdiction for p in packs})
        raise NoPackFoundError(
            "no packs for jurisdiction %r (known: %s)" % (jur, known or "<none>")
        )
    hits = sorted(
        (p for p in candidates if p.identity.contains(when)),
        key=lambda p: (p.identity.effective_from.isoformat(),
                       p.identity.version, p.identity.pack_id),
    )
    if not hits:
        windows = ", ".join(
            "%s [%s, %s)" % (
                p.identity.version, p.identity.effective_from.isoformat(),
                p.identity.effective_to.isoformat() if p.identity.effective_to
                else "open",
            )
            for p in sorted(candidates,
                            key=lambda p: p.identity.effective_from.isoformat())
        )
        raise NoPackFoundError(
            "no %s pack window contains %s (windows: %s)"
            % (jur, when.isoformat(), windows)
        )
    if len(hits) > 1:
        raise AmbiguousPackError(
            "%d %s pack windows contain %s: %s — overlapping effective ranges "
            "must be fixed (lint: effective-overlap)"
            % (len(hits), jur, when.isoformat(),
               ", ".join("%s@%s" % (p.identity.pack_id, p.identity.version)
                         for p in hits))
        )
    return hits[0]
