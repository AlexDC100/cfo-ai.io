#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PM1-PM7 — the GLOBAL PUBLIC MARKETS gate battery.

WHY THIS FILE EXISTS, AND WHY IT IS NOT A TEST FILE
====================================================
Every check below is a plain function that any caller can run: this
script (battery entry point) and ``tests/engine/test_public_market_gates.py``
(which drives the SAME functions, plus the plants that prove each one
trips). There is deliberately ONE implementation.

That is not a style preference. On 2026-08-29 the public_ro storefront
shipped 244 green tests and a 19-gate battery while every hub page
returned HTTP 500 and every funnel event was silently dropped — because
the tests drove a hand-built ``FakeStore`` that "mirrored" the real one
and the mirror had drifted. A second implementation of a check is a
mirror. So: no mirror stores, no re-derived market tables, no parallel
copy of a rule. The gate imports the real registry, builds real pm1
envelopes from committed REAL SEC bytes, drives the real sqlite store on
a temp path, and mounts the real FastAPI router.

THE SEVEN GATES
===============
PM1  No AI-authored numerics in the facts path.
     (a) the numeric modules import no model SDK and no AI layer;
     (b) the freshness (AI) package cannot reach a store write API;
     (c) every served figure carries deterministic-feed provenance —
         a model-authored or mock-sourced figure is REFUSED.
PM2  No cross-standard / cross-market percentile blending.
     A cohort may not mix market_id or accounting_standard. The
     benchmark lane's grouping fn is probed at documented seams and the
     contract SKIPS LOUDLY until it lands; the contract itself is proven
     against a planted blending grouper today.
PM3  Small-n honesty states. n = 0 / 1 / 2 render an honest, exact
     state — never a suppressed tab, never a cohort statistic.
PM4  Stale / delayed prices are ALWAYS labeled. An unlabeled price is
     refused at three layers (quote, envelope, presenter).
PM5  Keyless resilience. PROVIDER_API_KEY unset: US/EDGAR is fully
     live, every other market degrades to a typed honest state, nothing
     crashes, no tab is blank, and NOT ONE packet goes to the provider.
PM6  Registry-only extension. A market added to markets.yaml ALONE
     appears with its honest state and no engine edit; a market-id
     branch planted in core trips the N7 guard.
PM7  BVB / public_ro untouched: corpus replay 18/18 byte-identical, no
     public_ro import from public_market, the home market's company
     route refuses, and peer-add never widens a cohort.

Run:   python scripts/check_public_market_gates.py [-v] [--no-replay]
Exit:  0 = no gate FAILED (SKIPs are reported, loudly, and do not fail)
       1 = at least one gate FAILED

``--no-replay`` skips PM7's corpus_replay subprocess (the battery runs
``corpus-replay`` as its own gate; the flag exists so the pytest lane
does not pay for it twice). Skipping it is REPORTED, never silent.

Python 3.9: no ``match``, no ``X | Y`` unions.
"""
from __future__ import annotations

import argparse
import ast
import copy
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

REPO = Path(__file__).resolve().parents[1]
if str(REPO / "src") not in sys.path:
    sys.path.insert(0, str(REPO / "src"))

PACKAGE_DIR = REPO / "src" / "engine" / "public_market"
FRESHNESS_DIR = PACKAGE_DIR / "freshness"
FIXTURES = REPO / "tests" / "engine" / "fixtures" / "public_market"
APPLE_FACTS = FIXTURES / "companyfacts_CIK0000320193_truncated.json"

#: The fetched_at stamp the edgar suite pins its real-bytes fixture to.
#: Reused here so this gate's envelopes are byte-comparable with that
#: lane's, and so nothing in this file reads a clock (PS3 determinism).
FETCHED_AT = "2026-08-29T20:53:16Z"

#: Corpus replay must stay at exactly this many cases (PM7). A drop is a
#: silently-deleted golden; a rise is an unreviewed one.
CORPUS_CASES = 18


# ══════════════════════════════════════════════════════════════════════
# Result plumbing
# ══════════════════════════════════════════════════════════════════════

PASS = "PASS"
FAIL = "FAIL"
SKIP = "SKIP"


class GateResult(object):
    """One gate's verdict. ``notes`` are printed even on PASS — an
    honest green with a caveat beats a green that hides one."""

    def __init__(self, gate, state, headline, violations=None, notes=None):
        # type: (str, str, str, Optional[List[str]], Optional[List[str]]) -> None
        self.gate = gate
        self.state = state
        self.headline = headline
        self.violations = list(violations or [])
        self.notes = list(notes or [])

    @property
    def ok(self):
        # type: () -> bool
        return self.state != FAIL

    def as_dict(self):
        # type: () -> Dict[str, Any]
        return {
            "gate": self.gate,
            "state": self.state,
            "headline": self.headline,
            "violations": list(self.violations),
            "notes": list(self.notes),
        }


def _verdict(gate, headline, violations, notes=None, skip_reason=None):
    # type: (str, str, List[str], Optional[List[str]], Optional[str]) -> GateResult
    if skip_reason is not None:
        return GateResult(gate, SKIP, skip_reason, [], notes)
    if violations:
        return GateResult(gate, FAIL, headline, violations, notes)
    return GateResult(gate, PASS, headline, [], notes)


# ══════════════════════════════════════════════════════════════════════
# Shared scanning helpers (used by PM1, PM2, PM6, PM7)
# ══════════════════════════════════════════════════════════════════════


def _python_files(root):
    # type: (Path) -> List[Path]
    return sorted(p for p in root.rglob("*.py"))


def _numeric_path_files(package_dir=None):
    # type: (Optional[Path]) -> List[Path]
    """The DETERMINISTIC modules: everything in the package except the
    freshness (AI) sub-package, which is the one place a model is
    allowed to be reached at all.

    ``package_dir`` is a parameter, not a constant, for one reason: every
    scanner in this file has to be runnable over a PLANTED temp copy of
    the tree. A scanner that can only see the real tree can never be
    proven to trip.
    """
    root = package_dir or PACKAGE_DIR
    freshness = root / "freshness"
    return [p for p in _python_files(root) if freshness not in p.parents]


def _parse(path):
    # type: (Path) -> ast.AST
    return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


def _imported_names(tree):
    # type: (ast.AST) -> List[Tuple[int, str]]
    """(lineno, dotted-name) for every import in the module. Relative
    imports are reported as ``.`` * level + module so a climb out of the
    package is visible to the caller."""
    out = []  # type: List[Tuple[int, str]]
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                out.append((node.lineno, alias.name))
        elif isinstance(node, ast.ImportFrom):
            out.append((node.lineno, "." * node.level + (node.module or "")))
    return out


def _docstring_string_nodes(tree):
    # type: (ast.AST) -> set
    """ids of string nodes that are docstrings / bare string statements,
    so prose about a market never trips a literal scan."""
    out = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) \
                and isinstance(node.value.value, str):
            out.add(id(node.value))
    return out


def _module_constant_owner(tree):
    # type: (ast.AST) -> Dict[int, str]
    """{id(string node) -> module-level constant name}, so an exemption
    can be as narrow as one named table instead of a whole file."""
    owners = {}  # type: Dict[int, str]
    for node in getattr(tree, "body", []):
        targets = []
        if isinstance(node, ast.Assign):
            targets = [t for t in node.targets if isinstance(t, ast.Name)]
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) \
                and node.value is not None:
            targets = [node.target]
        if not targets or node.value is None:
            continue
        name = targets[0].id
        for child in ast.walk(node.value):
            if isinstance(child, ast.Constant) and isinstance(child.value, str):
                owners[id(child)] = name
    return owners


def _tree_digest(root):
    # type: (Path) -> str
    """sha256 over every .py / .yaml / .json byte under ``root``,
    path-sorted. PM6 uses it to prove a registry-only extension edited NO
    code — and no seed, since the universe lane's ``seeds/*.json`` are
    market-keyed data that a market addition must also not require."""
    h = hashlib.sha256()
    for path in sorted(list(root.rglob("*.py")) + list(root.rglob("*.yaml"))
                       + list(root.rglob("*.json"))):
        h.update(str(path.relative_to(root)).encode("utf-8"))
        h.update(b"\0")
        h.update(path.read_bytes())
        h.update(b"\0")
    return h.hexdigest()


# ══════════════════════════════════════════════════════════════════════
# PM1 — no AI-authored numerics in the facts path
# ══════════════════════════════════════════════════════════════════════

#: Import prefixes no DETERMINISTIC module may reach. Reaching a model
#: SDK from the facts path is the failure this gate exists to make
#: impossible; reaching the freshness package is the same failure one
#: indirection later.
AI_IMPORT_PREFIXES = (
    "anthropic",
    "openai",
    "engine.ai",
    "engine.ai_lane",
    "engine.public_market.freshness",
)

#: Import prefixes the FRESHNESS (AI) package may never reach. Same
#: table the freshness lane lints itself with — restated here because
#: this gate must keep holding if that lane's test file is ever edited,
#: and because a battery gate that delegates to a unit test is not a
#: gate. (Two readers of one rule, not two implementations of it: the
#: rule is data, and it is spelled out once, here.)
FRESHNESS_FORBIDDEN_IMPORTS = (
    "engine.serving",
    "engine.public_ro",
    "engine.api",
    "engine.pipeline",
    "engine.passes",
    "engine.consensus",
    "engine.frontends",
    "engine.interp",
    "engine.journal",
    "engine.public_market.store",
    "engine.public_market.model",
)

#: Raw tokens of a persistence / envelope-authoring surface. A substring
#: scan, so a dynamically-built call (getattr, string dispatch) trips it
#: too. ``normalize_envelope`` / ``stamp_content_hash`` are here because
#: MINTING a document is authoring numbers, not narrating them.
FRESHNESS_FORBIDDEN_TOKENS = (
    "write_fact", "put_fact", "upsert", "set_fact", "delete_fact",
    "save_fact", "mutate_fact", "facts_store", "FactsStore",
    "served_facts", "serving.facts", "store.write",
    "put_filing", "put_price", "upsert_entity", "queue_review",
    "normalize_envelope", "stamp_content_hash",
    "PublicMarketStore", "get_store",
)

#: Provenance sources that mean "a model or a fixture made this up".
#: Matched case-insensitively as substrings of ``provenance.source`` so a
#: future ``claude-fable-6`` / ``gpt-9`` / ``provider:mock-eu`` is caught
#: without a table edit. ABSENT is treated exactly like DENIED: a figure
#: with no source is a figure nobody will own.
AI_SOURCE_DENYLIST = (
    "claude", "anthropic", "openai", "gpt-", "llm", "model:", "ai:",
    "mock", "synthetic", "estimate", "generated", "inferred",
)

#: Figure keys that carry a number. A figure must be one or the other,
#: and either way it must be able to name where the number came from.
_VALUE_KEYS = ("value_minor", "value")


def source_is_model_authored(source):
    # type: (Any) -> bool
    """True when a provenance source names a model, a mock or an
    estimate rather than a deterministic feed. An empty / missing source
    is model-authored by default — fail closed."""
    if not isinstance(source, str) or not source.strip():
        return True
    lowered = source.strip().lower()
    for token in AI_SOURCE_DENYLIST:
        if token in lowered:
            return True
    return False


def assert_no_model_authored_figures(envelope, label="envelope"):
    # type: (Any, str) -> List[str]
    """PM1's runtime guard. Every figure must carry provenance whose
    source names a deterministic feed.

    Returns violation lines (empty == clean). This never raises, because
    the caller aggregates across many envelopes and a raise would lose
    every violation after the first.
    """
    violations = []  # type: List[str]
    if not isinstance(envelope, dict):
        return ["%s: not a dict" % label]
    figures = envelope.get("figures")
    if not isinstance(figures, dict):
        return ["%s: has no figures map" % label]
    for name in sorted(figures):
        fig = figures[name]
        if not isinstance(fig, dict):
            violations.append("%s: figure %r is not a dict" % (label, name))
            continue
        if not any(k in fig for k in _VALUE_KEYS):
            # Not a number-bearing figure — nothing for PM1 to police.
            continue
        provenance = fig.get("provenance")
        if not isinstance(provenance, dict):
            violations.append(
                "%s: figure %r carries a number with NO provenance — a figure "
                "nobody will own is indistinguishable from one a model wrote"
                % (label, name)
            )
            continue
        source = provenance.get("source")
        if source_is_model_authored(source):
            violations.append(
                "%s: figure %r is sourced %r — the facts path serves "
                "deterministic feeds only" % (label, name, source)
            )
    price = envelope.get("price")
    if isinstance(price, dict) and source_is_model_authored(
            (price.get("provenance") or {}).get("source")
            if isinstance(price.get("provenance"), dict) else price.get("source")):
        # A mock quote reaching a served envelope is the same failure
        # wearing a price tag.
        if price.get("mock") or "mock" in str(price.get("source") or "").lower():
            violations.append(
                "%s: price block is mock-sourced — a canned quote must never "
                "reach a served document" % label
            )
    return violations


def scan_numeric_path_ai_imports(package_dir=None):
    # type: (Optional[Path]) -> List[str]
    root = package_dir or PACKAGE_DIR
    violations = []  # type: List[str]
    for path in _numeric_path_files(root):
        rel = str(path.relative_to(root))
        for lineno, name in _imported_names(_parse(path)):
            for prefix in AI_IMPORT_PREFIXES:
                if name == prefix or name.startswith(prefix + "."):
                    violations.append(
                        "%s:%d imports %s — the facts path may not reach a "
                        "model or the AI layer" % (rel, lineno, name)
                    )
    return violations


def scan_freshness_write_surface(freshness_dir=None):
    # type: (Optional[Path]) -> List[str]
    root = freshness_dir or FRESHNESS_DIR
    violations = []  # type: List[str]
    if not root.is_dir():
        return ["freshness package missing at %s" % root]
    for path in sorted(root.glob("*.py")):
        rel = path.name
        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.level >= 2:
                violations.append(
                    "%s:%d relative import climbs out of the freshness package"
                    % (rel, node.lineno)
                )
        for lineno, name in _imported_names(tree):
            bare = name.lstrip(".")
            for prefix in FRESHNESS_FORBIDDEN_IMPORTS:
                if bare == prefix or bare.startswith(prefix + "."):
                    violations.append(
                        "%s:%d imports %s — the AI layer may not reach the "
                        "spine's write surface" % (rel, lineno, name)
                    )
            if name.startswith(".") and bare.split(".")[0] in ("store", "model"):
                violations.append(
                    "%s:%d relative import of a spine module (%s)"
                    % (rel, lineno, name)
                )
        for token in FRESHNESS_FORBIDDEN_TOKENS:
            if token in source:
                violations.append(
                    "%s contains forbidden write-surface token %r" % (rel, token)
                )
    return violations


def check_pm1(verbose=False):
    # type: (bool) -> GateResult
    violations = []  # type: List[str]
    notes = []  # type: List[str]

    violations += scan_numeric_path_ai_imports()
    violations += scan_freshness_write_surface()

    # Runtime guard on a REAL envelope built from committed SEC bytes.
    try:
        envelope = build_reference_envelope()
    except Exception as exc:  # noqa: BLE001
        violations.append("could not build the reference envelope: %r" % exc)
    else:
        violations += assert_no_model_authored_figures(envelope, "us/AAPL (pm1)")

    # And on whatever the deployed store actually holds, when there is
    # one. A gate that only inspects a fixture proves the fixture.
    held, store_note = _scan_deployed_store()
    violations += held
    if store_note:
        notes.append(store_note)

    notes.append(
        "the spine's own validator does NOT yet refuse an AI-sourced "
        "provenance (model.validate_envelope + store.put_filing accept it) — "
        "this gate refuses it; see design_review/markets/GATES.md PM1"
    )
    return _verdict("PM1", "no AI-authored numerics in the facts path",
                    violations, notes)


def _scan_deployed_store():
    # type: () -> Tuple[List[str], Optional[str]]
    """Run PM1's runtime guard over every envelope a real store holds.

    Deliberately opened with raw sqlite in ``mode=ro`` rather than
    through :class:`PublicMarketStore`, which is the one place this file
    does NOT use the real object. The reason is narrow and specific: the
    store's constructor runs ``_ensure_schema()``, which WRITES. A gate
    that migrates the database it is auditing has changed the evidence.
    This is a read-only forensic scan of a deployment artifact, so it
    reads rows; it never seeds, and it never opens a writable handle.

    An absent store is the normal state on a dev box and is reported as
    a NOTE, not silently treated as a pass.
    """
    import sqlite3

    from engine.public_market import store as store_mod

    db_env = os.environ.get(store_mod.DB_ENV)
    db_path = Path(db_env) if db_env else store_mod.default_db_path()
    if not db_path.is_file():
        return [], ("no public_market store at %s — the runtime guard ran "
                    "against the reference envelope only" % db_path)
    violations = []  # type: List[str]
    scanned = 0
    try:
        conn = sqlite3.connect("file:%s?mode=ro" % db_path, uri=True)
    except sqlite3.Error as exc:
        return [], "deployed store at %s is unreadable (%s)" % (db_path, exc)
    try:
        conn.row_factory = sqlite3.Row
        try:
            rows = conn.execute(
                "SELECT entity_id, accession_or_version, envelope_json "
                "FROM filings").fetchall()
        except sqlite3.Error as exc:
            return [], ("deployed store at %s has no readable filings table "
                        "(%s)" % (db_path, exc))
        for row in rows:
            try:
                doc = json.loads(row["envelope_json"])
            except ValueError:
                violations.append(
                    "stored %s/%s is not decodable JSON"
                    % (row["entity_id"], row["accession_or_version"]))
                continue
            scanned += 1
            violations += assert_no_model_authored_figures(
                doc, "stored %s/%s"
                     % (row["entity_id"], row["accession_or_version"]))
    finally:
        conn.close()
    return violations, ("audited %d stored envelope(s) at %s (read-only)"
                        % (scanned, db_path))


# ══════════════════════════════════════════════════════════════════════
# PM2 — no cross-standard / cross-market percentile blending
# ══════════════════════════════════════════════════════════════════════

#: Where an ENGINE-side cohort-grouping function would land. Probed in
#: order; the FIRST hit is the one under contract. Each entry is
#: (module, attribute).
#:
#: As of 2026-08-30 none of these exists, and that is not an omission:
#: the benchmark lane shipped on the FRONTEND
#: (:data:`FRONTEND_GROUPING_SEAM`), where the cohort is formed from
#: display snapshots. So PM2's live contract is asserted there, and this
#: probe stays armed for the day a percentile is computed server-side.
GROUPING_FN_SEAMS = (
    ("engine.public_market.benchmarks", "group_cohort"),
    ("engine.public_market.benchmarks", "build_groups"),
    ("engine.public_market.percentiles", "group_cohort"),
    ("engine.public_market.screener", "group_cohort"),
    ("engine.public_market.screener", "build_groups"),
    ("engine.public_market.cohorts", "build_cohorts"),
)

#: The frontend module that actually implements the grouping law today,
#: with the symbols this gate expects to find in it. Checked as SOURCE
#: (this is a Python gate; it does not run TypeScript) purely so PM2 can
#: report WHERE the contract lives instead of reporting "not landed".
#: The behavioural assertions are in
#: frontend/lib/__tests__/marketGates.test.ts and benchmarkHonesty.test.ts.
FRONTEND_GROUPING_SEAM = "frontend/lib/benchmarkGroups.ts"
FRONTEND_GROUPING_SYMBOLS = (
    "assertHomogeneous",
    "partitionByKey",
    "MIN_N_FOR_PERCENTILES",
    "BenchmarkIntegrityError",
)


def frontend_grouping_state():
    # type: () -> Tuple[bool, List[str]]
    """(landed, missing_symbols) for the frontend grouping law."""
    path = REPO / FRONTEND_GROUPING_SEAM
    if not path.is_file():
        return False, list(FRONTEND_GROUPING_SYMBOLS)
    source = path.read_text(encoding="utf-8")
    missing = [s for s in FRONTEND_GROUPING_SYMBOLS if s not in source]
    return True, missing

#: The keys a cohort member must AGREE on before a statistic may be
#: computed across it. A percentile that mixes US GAAP with IFRS is not
#: a comparison, it is an average of two different questions.
COHORT_PARTITION_KEYS = ("market_id", "accounting_standard")

#: Names that mean "a statistic over a cohort". If any of these is ever
#: called inside the package, the module doing it must also be
#: market-aware — see :func:`scan_cohort_statistics`.
COHORT_STAT_NAMES = (
    "median", "percentile", "quantile", "quartile", "decile",
    "pstdev", "stdev", "zscore", "z_score",
)

#: Tokens that prove a module knows which market a row belongs to.
MARKET_AWARE_TOKENS = ("market_id", "accounting_standard", "registry", "Market")


def cohort_member_key(member):
    # type: (Any) -> Tuple[Optional[str], Optional[str]]
    """(market_id, accounting_standard) of one cohort member, read from
    a dict, an object, or a nested ``market`` block. Returns (None, None)
    when the member declares neither — which the partition check treats
    as a violation in its own right, because an unlabeled row can be
    quietly blended into any cohort at all."""
    def _get(obj, key):
        if isinstance(obj, dict):
            return obj.get(key)
        return getattr(obj, key, None)

    market_id = _get(member, "market_id")
    standard = _get(member, "accounting_standard")
    nested = _get(member, "market")
    if nested is not None:
        if market_id is None:
            market_id = _get(nested, "market_id")
        if standard is None:
            standard = _get(nested, "accounting_standard")
    return (
        str(market_id) if market_id not in (None, "") else None,
        str(standard) if standard not in (None, "") else None,
    )


def check_group_partition(groups):
    # type: (Any) -> List[str]
    """PM2's contract. ``groups`` is a mapping {key: [members]} or an
    iterable of member-lists. Every group must be internally uniform on
    every :data:`COHORT_PARTITION_KEYS`."""
    violations = []  # type: List[str]
    if isinstance(groups, dict):
        items = sorted(groups.items(), key=lambda kv: str(kv[0]))
    else:
        items = [(str(i), g) for i, g in enumerate(list(groups or []))]
    for key, members in items:
        members = list(members or [])
        if not members:
            continue
        seen = {}  # type: Dict[str, set]
        for field in COHORT_PARTITION_KEYS:
            seen[field] = set()
        unlabeled = 0
        for member in members:
            market_id, standard = cohort_member_key(member)
            if market_id is None and standard is None:
                unlabeled += 1
                continue
            if market_id is not None:
                seen["market_id"].add(market_id)
            if standard is not None:
                seen["accounting_standard"].add(standard)
        if unlabeled:
            violations.append(
                "group %r has %d member(s) that declare neither market_id nor "
                "accounting_standard — an unlabeled row blends into any cohort"
                % (key, unlabeled)
            )
        for field in COHORT_PARTITION_KEYS:
            if len(seen[field]) > 1:
                violations.append(
                    "group %r blends %s across %s — a percentile over two "
                    "reporting regimes answers neither question"
                    % (key, field, sorted(seen[field]))
                )
    return violations


def discover_grouping_fn():
    # type: () -> Tuple[Optional[Callable], Optional[str]]
    """The benchmark lane's grouping fn, or (None, None) when the lane
    has not landed. Import failures are swallowed on purpose: a lane
    that half-exists must not turn this gate red for the wrong reason."""
    for module_name, attr in GROUPING_FN_SEAMS:
        try:
            module = __import__(module_name, fromlist=[attr])
        except Exception:  # noqa: BLE001
            continue
        fn = getattr(module, attr, None)
        if callable(fn):
            return fn, "%s.%s" % (module_name, attr)
    return None, None


def scan_cohort_statistics(package_dir=None):
    # type: (Optional[Path]) -> List[str]
    """A cohort statistic computed by a module that has no idea which
    market a row belongs to IS the blending failure, before any grouping
    function exists to be tested.

    Today the package computes no cohort statistic at all, so this
    passes vacuously — and arms itself the moment one lands.
    """
    root = package_dir or PACKAGE_DIR
    violations = []  # type: List[str]
    for path in _python_files(root):
        rel = str(path.relative_to(root))
        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=str(path))
        market_aware = any(token in source for token in MARKET_AWARE_TOKENS)
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            name = None
            if isinstance(func, ast.Name):
                name = func.id
            elif isinstance(func, ast.Attribute):
                name = func.attr
            if name is None or name.lower() not in COHORT_STAT_NAMES:
                continue
            if not market_aware:
                violations.append(
                    "%s:%d computes %s() in a module that never mentions "
                    "market_id / accounting_standard — a cohort statistic must "
                    "know which market it is describing"
                    % (rel, node.lineno, name)
                )
    return violations


def check_pm2(verbose=False):
    # type: (bool) -> GateResult
    violations = scan_cohort_statistics()
    notes = []  # type: List[str]

    fe_landed, fe_missing = frontend_grouping_state()
    if fe_landed and fe_missing:
        violations.append(
            "%s exists but no longer exports %s — PM2's live contract has "
            "moved or been removed; find it or this gate is measuring nothing"
            % (FRONTEND_GROUPING_SEAM, ", ".join(fe_missing))
        )

    fn, seam = discover_grouping_fn()
    if fn is None:
        if fe_landed:
            notes.append(
                "PM2's live contract lives on the FRONTEND: %s carries the "
                "grouping law (%s) and is asserted by "
                "frontend/lib/__tests__/marketGates.test.ts (the plants) and "
                "benchmarkHonesty.test.ts (the states). No cohort statistic "
                "is computed server-side, so there is nothing here to blend."
                % (FRONTEND_GROUPING_SEAM, ", ".join(FRONTEND_GROUPING_SYMBOLS))
            )
        else:
            notes.append(
                "no grouping law found on EITHER side — engine seams probed: "
                "%s; frontend seam probed: %s"
                % (", ".join("%s.%s" % s for s in GROUPING_FN_SEAMS),
                   FRONTEND_GROUPING_SEAM)
            )
        notes.append(
            "the engine-side partition contract is proven against a planted "
            "blending grouper in tests/engine/test_public_market_gates.py and "
            "arms itself the moment one of the engine seams appears."
        )
        if violations:
            return _verdict("PM2", "cohort statistics are market-blind",
                            violations, notes)
        return GateResult(
            "PM2", SKIP,
            "no ENGINE-side cohort statistic exists to blend — the grouping "
            "law shipped on the frontend and is gated there",
            [], notes,
        )

    notes.append("grouping fn under contract: %s" % seam)
    try:
        groups = fn(_mixed_cohort_universe())
    except Exception as exc:  # noqa: BLE001
        violations.append("%s raised on a mixed universe: %r" % (seam, exc))
    else:
        partition = check_group_partition(groups)
        if partition:
            violations += ["%s: %s" % (seam, line) for line in partition]
        elif _group_count(groups) < 2:
            violations.append(
                "%s collapsed a US-GAAP + IFRS universe into one group — the "
                "partition is not a partition" % seam
            )
    return _verdict("PM2", "no cross-standard / cross-market blending",
                    violations, notes)


def _group_count(groups):
    # type: (Any) -> int
    if isinstance(groups, dict):
        return len([k for k, v in groups.items() if list(v or [])])
    return len([g for g in list(groups or []) if list(g or [])])


def _mixed_cohort_universe():
    # type: () -> List[Dict[str, Any]]
    """A universe a correct grouper MUST split: two markets, two
    accounting standards, one shared sector."""
    return [
        {"ticker": "AAPL", "market_id": "us", "accounting_standard": "US_GAAP",
         "sector": "Technology", "revenue_minor": 41616100000000},
        {"ticker": "MSFT", "market_id": "us", "accounting_standard": "US_GAAP",
         "sector": "Technology", "revenue_minor": 24500000000000},
        {"ticker": "SAP", "market_id": "de", "accounting_standard": "IFRS",
         "sector": "Technology", "revenue_minor": 3400000000000},
        {"ticker": "CAP", "market_id": "fr", "accounting_standard": "IFRS",
         "sector": "Technology", "revenue_minor": 2200000000000},
    ]


# ══════════════════════════════════════════════════════════════════════
# PM3 — small-n honesty states
# ══════════════════════════════════════════════════════════════════════

#: Below this many members a cohort statistic is a description of one or
#: two companies wearing the clothes of a distribution. Matches the
#: thresholds already shipping elsewhere in the product
#: (public_ro.seo.HUB_MIN_COMPANIES = 3; the FE benchmark surface
#: materializes a sector subgroup at >= 3).
MIN_COHORT_N = 3


def check_small_n_cohort(members, statistic=None):
    # type: (List[Any], Optional[Any]) -> List[str]
    """A cohort below :data:`MIN_COHORT_N` must produce NO statistic.
    ``statistic`` is whatever the surface would render; anything other
    than None below the threshold is a violation."""
    violations = []  # type: List[str]
    n = len(list(members or []))
    if n < MIN_COHORT_N and statistic is not None:
        violations.append(
            "cohort of n=%d produced a statistic (%r) — below n=%d a "
            "percentile describes one company, not a market"
            % (n, statistic, MIN_COHORT_N)
        )
    return violations


def check_registry_small_n(payload, expected_counts):
    # type: (Dict[str, Any], Dict[str, int]) -> List[str]
    """The market list must render EVERY market at every holding count,
    with the count exact. A market that vanishes at n=0 (or rounds n=1
    up to "coverage") is the blank-tab failure PM5 also guards."""
    violations = []  # type: List[str]
    entries = payload.get("markets") or []
    seen = dict((e.get("market_id"), e) for e in entries)
    from engine.public_market import registry as _registry

    for market_id in _registry.market_ids():
        entry = seen.get(market_id)
        if entry is None:
            violations.append(
                "market %r disappeared from the list — a market with few or no "
                "entities must still render its honest state" % market_id
            )
            continue
        if not str(entry.get("display_name") or "").strip():
            violations.append("market %r renders with no display name" % market_id)
        if not str(entry.get("status") or "").strip():
            violations.append("market %r renders with no status" % market_id)
        held = entry.get("entities_held")
        want = int(expected_counts.get(market_id, 0))
        if not isinstance(held, int) or held != want:
            violations.append(
                "market %r reports entities_held=%r, store holds %d — a small "
                "n must be stated exactly, never smoothed"
                % (market_id, held, want)
            )
    return violations


def check_pm3(verbose=False):
    # type: (bool) -> GateResult
    violations = []  # type: List[str]
    notes = []  # type: List[str]

    # (a) n = 0 / 1 / 2 through the REAL router and the REAL store.
    from engine.public_market import registry as _registry

    with _temp_store() as store:
        us = _registry.get_market("us")
        for n in (0, 1, 2):
            _seed_entities(store, us, n)
            payload = _registry_payload_via_router(store)
            expected = {"us": n}
            violations += [
                "n=%d: %s" % (n, line)
                for line in check_registry_small_n(payload, expected)
            ]

    # (b) the one cohort selector that exists today, at n=1 and n=2.
    try:
        from engine.public_market.freshness.peers import (
            PeerCandidate, deterministic_peers,
        )
    except Exception as exc:  # noqa: BLE001
        notes.append("peer selection unavailable (%r) — skipped" % exc)
    else:
        subject = PeerCandidate("AAPL", "Apple Inc", "Technology", 3.0e12)
        for n in (1, 2):
            universe = [
                PeerCandidate("P%d" % i, "Peer %d" % i, "Technology", 3.0e12)
                for i in range(n)
            ]
            result = deterministic_peers(subject, universe)
            peers = result.get("peers") or []
            if len(peers) != n:
                violations.append(
                    "peer selection padded or dropped at n=%d (got %d) — a "
                    "short cohort must stay short" % (n, len(peers))
                )
            if not str(result.get("basis") or "").strip():
                violations.append(
                    "peer selection at n=%d carries no basis label — the "
                    "reader cannot tell how weak the match is" % n
                )
            # And a statistic must not appear over that cohort.
            violations += check_small_n_cohort(peers, statistic=None)

    # (c) the contract itself is armed: a planted statistic at n=2 trips.
    if not check_small_n_cohort([1, 2], statistic=42.0):
        violations.append(
            "check_small_n_cohort is vacuous — it accepted a statistic at n=2"
        )

    notes.append(
        "the FE half of PM3 (small-n states RENDER) is asserted in "
        "frontend/lib/__tests__/marketGates.test.ts against the shipping "
        "benchmarkGroups.computeBenchmarkStats: n=1 and n=2 return refusal "
        "states, and MIN_N_FOR_PERCENTILES is pinned to MIN_COHORT_N here "
        "and to public_ro.seo.HUB_MIN_COMPANIES — one threshold, three "
        "surfaces"
    )
    return _verdict("PM3", "small-n states are exact and unsmoothed",
                    violations, notes)


# ══════════════════════════════════════════════════════════════════════
# PM4 — stale / delayed prices are ALWAYS labeled
# ══════════════════════════════════════════════════════════════════════

#: Keys a served price must carry before anyone may read its number.
PRICE_LABEL_KEYS = ("as_of", "delay_note")


def check_price_labeled(price, cadence=None, now=None):
    # type: (Any, Optional[str], Optional[Any]) -> List[str]
    """A price may be old. A price may not be UNLABELED.

    Violations cover: no dict, no ``as_of`` (undateable), no
    ``delay_note`` (unqualified), and — when a cadence is supplied — a
    price past its freshness budget that is not flagged ``stale``.
    """
    from engine.public_market import prices as _prices

    violations = []  # type: List[str]
    if not isinstance(price, dict):
        return ["price block is not a dict (%r)" % type(price).__name__]
    for key in PRICE_LABEL_KEYS:
        value = price.get(key)
        if not isinstance(value, str) or not value.strip():
            violations.append(
                "price block has no %s — an unlabeled quote reads as a live "
                "one, which is the freshness lie this gate exists to stop"
                % key
            )
    if cadence is not None and "as_of" in price:
        try:
            stale = _prices.is_stale(price, cadence, now=now)
        except Exception as exc:  # noqa: BLE001
            violations.append("staleness could not be decided: %r" % exc)
        else:
            if stale and not price.get("stale"):
                violations.append(
                    "price dated %r is past the %s budget but is not flagged "
                    "stale" % (price.get("as_of"), cadence)
                )
    return violations


def check_pm4(verbose=False):
    # type: (bool) -> GateResult
    from engine.public_market import model as _model
    from engine.public_market import prices as _prices
    from engine.serving import present_public_market

    violations = []  # type: List[str]
    notes = []  # type: List[str]
    now = "2026-08-29T12:00:00+00:00"

    # ── layer 1: the quote. A 3-day-old EOD close is INSIDE the budget
    # and still must be labeled; a 6-day-old one must also be flagged.
    three_day = {"symbol": "AAPL", "value": 232.14, "currency": "USD",
                 "as_of": "2026-08-26"}
    labeled = _prices.label_quote(dict(three_day), "US", now=now)
    if not isinstance(labeled, dict):
        violations.append("label_quote refused a well-formed quote: %r" % (labeled,))
    else:
        violations += ["3-day EOD: %s" % v
                       for v in check_price_labeled(labeled, "eod", now=now)]
        if labeled.get("stale"):
            violations.append(
                "a 3-day-old EOD close was flagged stale — the 5-day budget "
                "exists so a Friday close survives a long weekend"
            )

    six_day = dict(three_day, as_of="2026-08-22")
    labeled_old = _prices.label_quote(dict(six_day), "US", now=now)
    if isinstance(labeled_old, dict):
        violations += ["6-day EOD: %s" % v
                       for v in check_price_labeled(labeled_old, "eod", now=now)]
        if not labeled_old.get("stale"):
            violations.append("a 6-day-old EOD close was not flagged stale")

    # An UNDATEABLE quote must be refused, not labeled optimistically.
    undateable = _prices.label_quote({"symbol": "AAPL", "value": 1.0}, "US", now=now)
    if isinstance(undateable, dict):
        violations.append(
            "label_quote accepted a quote with no as_of — it must refuse"
        )

    # ── layer 2: the envelope. A price block missing delay_note must
    # fail pm1 validation, and the store must refuse to persist it.
    try:
        base = build_reference_envelope()
        unlabeled_env = _with_price(base, {
            "price_minor": 23214, "currency": "USD", "as_of": "2026-08-26",
        })
        problems = _model.validate_envelope(unlabeled_env)
        if not any("delay_note" in p for p in problems):
            violations.append(
                "pm1 validation accepted a price block with no delay_note "
                "(problems: %r)" % problems
            )
        with _temp_store() as store:
            from engine.public_market.store import StoreError
            try:
                store.put_filing(unlabeled_env)
            except StoreError:
                pass
            else:
                violations.append(
                    "the store persisted an unlabeled price block"
                )
    except Exception as exc:  # noqa: BLE001
        violations.append("envelope layer could not be exercised: %r" % exc)

    # ── layer 3: the presenter. Labeled price -> the note is surfaced
    # verbatim; NO price -> an explicit policy line, never a blank slot.
    try:
        priced = _with_price(build_reference_envelope(), {
            "price_minor": 23214, "currency": "USD", "as_of": "2026-08-26",
            "delay_note": _prices.delay_note_for("US"),
        })
        presented = present_public_market(priced)
        if not presented or not str(presented.get("delay_note") or "").strip():
            violations.append("the presenter dropped the delay note")
        elif presented["delay_note"] != _prices.delay_note_for("US"):
            violations.append(
                "the presenter rewrote the delay note (%r != %r)"
                % (presented["delay_note"], _prices.delay_note_for("US"))
            )
        bare = present_public_market(build_reference_envelope())
        if not bare or not str(bare.get("price_line_en") or "").strip():
            violations.append(
                "with no price block the presenter left the price line blank — "
                "a blank slot reads as loading, not as policy"
            )
    except Exception as exc:  # noqa: BLE001
        violations.append("presenter layer could not be exercised: %r" % exc)

    notes.append(
        "no price is served today (keyless mode, PM5) — every layer above was "
        "exercised on a constructed quote so the label rule is proven BEFORE a "
        "licence exists to break it"
    )
    return _verdict("PM4", "no price is served without a freshness label",
                    violations, notes)


def _with_price(envelope, price):
    # type: (Dict[str, Any], Dict[str, Any]) -> Dict[str, Any]
    """Attach a price block and re-stamp the content hash the way the
    spine does — so validation failures are about the PRICE, never about
    a hash we broke ourselves."""
    from engine.public_market import model as _model

    out = copy.deepcopy(envelope)
    out.pop("content_hash", None)
    out["price"] = dict(price)
    return _model.stamp_content_hash(out)


# ══════════════════════════════════════════════════════════════════════
# PM5 — keyless resilience
# ══════════════════════════════════════════════════════════════════════

#: Env vars that would flip the provider slot live. All are cleared for
#: the duration of the PM5 body.
PROVIDER_ENV_VARS = ("PROVIDER_API_KEY",)


class NetworkAttempted(AssertionError):
    """Raised the instant anything under PM5 opens a socket."""


class _NoNetwork(object):
    """Trap every OUTBOUND path at once: DNS, socket connect, urllib's
    opener, and the provider module's own patch point. PM5 does not
    merely assert 'no data came back' — it asserts NOTHING WAS SENT.

    Deliberately hooked at ``connect`` / ``getaddrinfo`` and NOT at
    ``socket.socket.__init__``: the in-process ASGI TestClient this gate
    drives builds an asyncio event loop whose self-pipe is a local
    ``socketpair``. Trapping construction flagged that loopback pipe as
    an outbound call — a false positive that would have made PM5 red for
    a reason that has nothing to do with the provider. Egress is what
    matters, so egress is what is trapped.
    """

    def __init__(self):
        self.attempts = []  # type: List[str]
        self._saved = {}  # type: Dict[str, Any]

    def __enter__(self):
        import urllib.request

        from engine.public_market import providers as _providers

        def _trap(label):
            def _fn(*args, **kwargs):
                self.attempts.append("%s%r" % (label, args[:2]))
                raise NetworkAttempted(
                    "PM5: keyless mode attempted the network via %s" % label
                )
            return _fn

        self._saved["connect"] = socket.socket.connect
        self._saved["connect_ex"] = socket.socket.connect_ex
        self._saved["create_connection"] = socket.create_connection
        self._saved["getaddrinfo"] = socket.getaddrinfo
        self._saved["urlopen"] = urllib.request.urlopen
        self._saved["providers_urlopen"] = _providers._urlopen

        socket.socket.connect = _trap("socket.connect")  # type: ignore[assignment]
        socket.socket.connect_ex = _trap("socket.connect_ex")  # type: ignore[assignment]
        socket.create_connection = _trap("socket.create_connection")  # type: ignore[assignment]
        socket.getaddrinfo = _trap("socket.getaddrinfo")  # type: ignore[assignment]
        urllib.request.urlopen = _trap("urllib.request.urlopen")  # type: ignore[assignment]
        _providers._urlopen = _trap("providers._urlopen")
        return self

    def __exit__(self, *exc):
        import urllib.request

        from engine.public_market import providers as _providers

        socket.socket.connect = self._saved["connect"]  # type: ignore[assignment]
        socket.socket.connect_ex = self._saved["connect_ex"]  # type: ignore[assignment]
        socket.create_connection = self._saved["create_connection"]  # type: ignore[assignment]
        socket.getaddrinfo = self._saved["getaddrinfo"]  # type: ignore[assignment]
        urllib.request.urlopen = self._saved["urlopen"]  # type: ignore[assignment]
        _providers._urlopen = self._saved["providers_urlopen"]
        return False


def check_pm5(verbose=False):
    # type: (bool) -> GateResult
    from engine.public_market import prices as _prices
    from engine.public_market import providers as _providers
    from engine.public_market import registry as _registry

    violations = []  # type: List[str]
    notes = []  # type: List[str]

    saved_env = dict((k, os.environ.get(k)) for k in PROVIDER_ENV_VARS)
    for key in PROVIDER_ENV_VARS:
        os.environ.pop(key, None)
    try:
        with _NoNetwork() as trap:
            # (a) the resolver degrades, and a blank key is not a key.
            for env in ({}, {"PROVIDER_API_KEY": ""},
                        {"PROVIDER_API_KEY": "   "}):
                provider = _providers.provider_from_env(env)
                if _providers.provider_is_live(provider):
                    violations.append(
                        "provider_from_env(%r) reported LIVE without a key" % env
                    )

            # (b) the price slot's designed ABSENCE — not a zero, not a
            #     mock quote leaking into a served block.
            for market in ("US", "DE", "FR"):
                block = _prices.price_block("AAPL", market, env={})
                if block is not None:
                    violations.append(
                        "keyless price_block(%r) returned %r — keyless mode "
                        "must return None (designed absence)" % (market, block)
                    )

            # (c) US / EDGAR is FULLY LIVE keyless, end to end, from
            #     committed real SEC bytes through the real router.
            envelope = build_reference_envelope()
            with _temp_store() as store:
                store.put_filing(envelope)
                body, status = _company_via_router(store, "us", "AAPL")
                if status != 200:
                    violations.append(
                        "US/AAPL did not serve keyless (HTTP %s, body %r)"
                        % (status, body)
                    )
                else:
                    figures = ((body.get("envelope") or {}).get("figures") or {})
                    if not figures:
                        violations.append("US/AAPL served with no figures")
                    violations += assert_no_model_authored_figures(
                        body.get("envelope"), "keyless us/AAPL")

                # (d) every OTHER market degrades to a typed honest
                #     state. Never a 500, never an empty body.
                for market in _registry.ordered_markets():
                    if market.is_live and not market.is_home:
                        continue
                    body, status = _company_via_router(
                        store, market.market_id, "AAPL")
                    if status >= 500 and status != 501:
                        violations.append(
                            "%s crashed keyless (HTTP %s)"
                            % (market.market_id, status)
                        )
                    if body.get("status") != "refused" or not body.get("code"):
                        violations.append(
                            "%s degraded without a typed refusal code (%r)"
                            % (market.market_id, body)
                        )
                    if not str(body.get("detail") or "").strip():
                        violations.append(
                            "%s refused with an empty detail — the reader is "
                            "told nothing" % market.market_id
                        )

                # (e) NO BLANK TAB: every market renders with a name, a
                #     status, a licence line and an exact holding count.
                payload = _registry_payload_via_router(store)
                for entry in payload.get("markets") or []:
                    market_id = entry.get("market_id")
                    for field in ("display_name", "status", "license_notes",
                                  "currency", "group"):
                        if not str(entry.get(field) or "").strip():
                            violations.append(
                                "market %r renders with an empty %s — that is "
                                "a blank tab" % (market_id, field)
                            )
                    if not isinstance(entry.get("entities_held"), int):
                        violations.append(
                            "market %r has no entities_held count" % market_id
                        )
                    if entry.get("status") not in _registry.STATUSES:
                        violations.append(
                            "market %r has status %r outside the closed "
                            "vocabulary" % (market_id, entry.get("status"))
                        )

            if trap.attempts:
                violations.append(
                    "keyless mode attempted the network: %s"
                    % ", ".join(trap.attempts)
                )
            notes.append(
                "network trap armed over sockets, urllib and providers._urlopen "
                "for the whole gate body; %d attempt(s) recorded"
                % len(trap.attempts)
            )
    except NetworkAttempted as exc:
        violations.append(str(exc))
    finally:
        for key, value in saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    return _verdict("PM5", "keyless: US live, everything else honestly degraded, "
                           "zero packets to the provider", violations, notes)


# ══════════════════════════════════════════════════════════════════════
# PM6 — registry-only extension + the N7 market-id guard
# ══════════════════════════════════════════════════════════════════════

#: (file, module-level constant) pairs allowed to hold a string that
#: happens to equal a market id, each with the REASON. Mirrors the spine
#: lane's allowlist deliberately: this gate must keep holding if that
#: test file is edited, and a battery gate that trusts a unit test's
#: allowlist has outsourced its own scope.
MARKET_LITERAL_ALLOWLIST = {
    ("prices.py", "MARKET_REGISTRY"): (
        "ISO-3166 country codes keying the price cadence + delay-label table; "
        "predates the registry, and price_block() already accepts an injected "
        "registry so the spine can supply this table without a signature change"
    ),
    ("providers.py", "_SLOT_MARKETS"): (
        "the licensed PROVIDER's advertised coverage — a fact about a vendor "
        "contract, not a claim about our registry"
    ),
    ("esef.py", "COVERAGE_GAPS"): (
        "country codes quoted verbatim from filings.xbrl.org's own 'Missing "
        "data' list; changing them would misquote the source"
    ),
    ("entity.py", "_NFKD_RESISTANT"): (
        "a transliteration table: 'ae' here is the expansion of the letter "
        "ligature, not a market id — an accidental collision between a Nordic "
        "orthography rule and an ISO country code"
    ),
}

#: Whole-file exemptions, with the reason.
MARKET_LITERAL_EXEMPT_FILES = {
    "registry.py": "the registry IS the authority — it validates and serves ids",
}


def scan_market_id_literals(package_dir, market_ids):
    # type: (Path, Any) -> List[str]
    """The N7 guard, runnable over ANY tree — which is what makes the
    plant possible: the same scanner runs over the real package and over
    a temp copy with a market-id branch injected.

    Catches BOTH shapes of the if/elif ladder this wave exists to avoid:
    a quoted market id outside the registry, and ``market_id == "..."``.
    """
    ids = frozenset(str(m).strip().lower() for m in market_ids)
    violations = []  # type: List[str]
    for path in _python_files(package_dir):
        rel = str(path.relative_to(package_dir))
        if rel in MARKET_LITERAL_EXEMPT_FILES:
            continue
        tree = _parse(path)
        prose = _docstring_string_nodes(tree)
        owners = _module_constant_owner(tree)

        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                if id(node) in prose:
                    continue
                if node.value.strip().lower() not in ids:
                    continue
                owner = owners.get(id(node))
                if owner is not None and (rel, owner) in MARKET_LITERAL_ALLOWLIST:
                    continue
                violations.append(
                    "%s:%d quotes market id %r%s"
                    % (rel, node.lineno, node.value,
                       "" if owner is None else " (in %s)" % owner)
                )
            elif isinstance(node, ast.Compare):
                operands = [node.left] + list(node.comparators)
                names = []
                for operand in operands:
                    if isinstance(operand, ast.Name):
                        names.append(operand.id)
                    elif isinstance(operand, ast.Attribute):
                        names.append(operand.attr)
                    elif isinstance(operand, ast.Subscript) and \
                            isinstance(operand.slice, ast.Constant):
                        names.append(str(operand.slice.value))
                has_string = any(
                    isinstance(o, ast.Constant) and isinstance(o.value, str)
                    for o in operands
                )
                if has_string and any(n in ("market_id", "market") for n in names):
                    violations.append(
                        "%s:%d compares market_id/market against a string "
                        "literal — branch on is_live / is_fundamentals_only / "
                        "is_home instead" % (rel, node.lineno)
                    )
    return violations


#: The fictional market PM6 adds to prove registry-only extension. ``zz``
#: is reserved by ISO 3166 for private use, so it can never collide with
#: a real market this platform later ships.
FICTIONAL_MARKET_ID = "zz"

FICTIONAL_MARKET_YAML = """
  - market_id: zz
    display_name: Zzyzx Exchange (PM6 gate fixture)
    exchanges: [ZZX]
    currency: XTS
    accounting_standard: IFRS
    price_source: licensed_provider_slot
    fundamentals_source: none
    refresh_cadence: none
    license_notes: >-
      PM6 gate fixture — ISO 3166 reserves ZZ for private use and XTS for
      testing, so this row can never collide with a real market.
    marquee_rank: null
    status: awaiting_provider
    coverage_note: >-
      Added by scripts/check_public_market_gates.py to prove a market can
      reach the surface through markets.yaml alone. Reverted immediately.
"""


def check_pm6(verbose=False):
    # type: (bool) -> GateResult
    from engine.public_market import registry as _registry

    violations = []  # type: List[str]
    notes = []  # type: List[str]

    # ── (a) the real tree is clean under the N7 guard ───────────────
    real_ids = _registry.market_ids()
    violations += scan_market_id_literals(PACKAGE_DIR, real_ids)

    # ── (b) THE PLANT: the same scanner over a temp copy of the real
    #        package with a market-id branch injected into core. If the
    #        planted tree scans clean, the guard is decoration.
    plant_hits = _plant_market_id_branch()
    if not plant_hits:
        violations.append(
            "the N7 guard did not trip on a planted market-id branch — a "
            "guard that cannot fail is decoration"
        )
    else:
        notes.append("N7 plant tripped %d check(s): %s"
                     % (len(plant_hits), plant_hits[0]))

    # ── (c) registry-only extension, then revert ────────────────────
    before_ids = tuple(real_ids)
    before_digest = _tree_digest(PACKAGE_DIR)
    saved = os.environ.get(_registry.PATH_ENV)
    tmp_dir = tempfile.mkdtemp(prefix="pm6-registry-")
    try:
        extended = Path(tmp_dir) / "markets.yaml"
        extended.write_text(
            _registry.default_path().read_text(encoding="utf-8").rstrip("\n")
            + "\n" + FICTIONAL_MARKET_YAML,
            encoding="utf-8",
        )
        os.environ[_registry.PATH_ENV] = str(extended)
        _registry.reset_cache()

        ids = _registry.market_ids()
        if FICTIONAL_MARKET_ID not in ids:
            violations.append(
                "a market added to markets.yaml alone did NOT appear — "
                "registry-only extension is broken"
            )
        else:
            market = _registry.get_market(FICTIONAL_MARKET_ID)
            if market.is_marquee or market.is_home:
                violations.append(
                    "the fictional market claimed a marquee slot; an unranked "
                    "market belongs in the A->Z tail"
                )
            if ids[-1] != FICTIONAL_MARKET_ID and market.group != _registry.REST_GROUP:
                violations.append(
                    "the fictional market did not land in the A->Z tail "
                    "(order: %s)" % (ids,)
                )
            if not market.is_awaiting_provider:
                violations.append(
                    "the fictional market did not render its honest state "
                    "(status %r)" % market.status
                )

            with _temp_store() as store:
                payload = _registry_payload_via_router(store)
                entry = [e for e in payload.get("markets") or []
                         if e.get("market_id") == FICTIONAL_MARKET_ID]
                if not entry:
                    violations.append(
                        "the new market has a registry row but no API tab"
                    )
                else:
                    tab = entry[0]
                    for field in ("display_name", "status", "license_notes",
                                  "currency", "group"):
                        if not str(tab.get(field) or "").strip():
                            violations.append(
                                "the new market's tab has an empty %s" % field
                            )
                    if tab.get("entities_held") != 0:
                        violations.append(
                            "the new market claims %r entities held"
                            % tab.get("entities_held")
                        )
                body, status = _company_via_router(
                    store, FICTIONAL_MARKET_ID, "ANY")
                if status != 501 or body.get("code") != "MARKET_AWAITING_PROVIDER":
                    violations.append(
                        "the new market's company route answered %s/%r instead "
                        "of a 501 MARKET_AWAITING_PROVIDER"
                        % (status, body.get("code"))
                    )

        after_digest = _tree_digest(PACKAGE_DIR)
        if after_digest != before_digest:
            violations.append(
                "the engine tree changed while adding a market — registry-only "
                "extension means ZERO engine edits"
            )
    finally:
        if saved is None:
            os.environ.pop(_registry.PATH_ENV, None)
        else:
            os.environ[_registry.PATH_ENV] = saved
        _registry.reset_cache()
        shutil.rmtree(tmp_dir, ignore_errors=True)

    # ── (d) the revert is total ─────────────────────────────────────
    after_ids = _registry.market_ids()
    if after_ids != before_ids:
        violations.append(
            "the fictional market survived the revert (%s -> %s)"
            % (before_ids, after_ids)
        )
    if _tree_digest(PACKAGE_DIR) != before_digest:
        violations.append("the package tree was modified by this gate")

    notes.append(
        "added %r via markets.yaml only, verified its tab + honest refusal, "
        "then reverted; package tree digest unchanged throughout"
        % FICTIONAL_MARKET_ID
    )
    return _verdict("PM6", "a market reaches the surface through markets.yaml "
                           "alone; a market-id branch in core trips the guard",
                    violations, notes)


def _plant_market_id_branch():
    # type: () -> List[str]
    """Copy the REAL package to a temp tree, inject a market-id branch
    into a core module, and run the REAL scanner over it.

    A temp copy rather than an in-place edit on purpose: an in-place
    plant that is interrupted (Ctrl-C, a crash, a killed CI job) leaves a
    poisoned engine file on disk. The bytes scanned are the real module's
    bytes plus two lines, so the plant proves exactly what an in-place
    one would — without the failure mode.
    """
    from engine.public_market import registry as _registry

    tmp = Path(tempfile.mkdtemp(prefix="pm6-plant-"))
    try:
        target = tmp / "public_market"
        shutil.copytree(PACKAGE_DIR, target)
        victim = target / "model.py"
        ids = _registry.market_ids()
        planted = [m for m in ids if m != _registry.home_market().market_id]
        needle = planted[0] if planted else ids[0]
        victim.write_text(
            victim.read_text(encoding="utf-8")
            + "\n\n"
            + "PLANTED_DEFAULT_MARKET = %r\n" % needle
            + "\n"
            + "def _planted_ladder(market_id):\n"
            + "    if market_id == %r:\n" % needle
            + "        return 'the first vertebra of the if/elif ladder'\n"
            + "    return None\n",
            encoding="utf-8",
        )
        return scan_market_id_literals(target, ids)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ══════════════════════════════════════════════════════════════════════
# PM7 — BVB / public_ro untouched
# ══════════════════════════════════════════════════════════════════════

#: public_market may not import the home market's pipeline, read its
#: env, or open its database. One company, one source of truth.
PUBLIC_RO_IMPORT_PREFIXES = ("engine.public_ro",)
PUBLIC_RO_ENV_TOKENS = ("PUBLIC_RO_DB_PATH", "PUBLIC_RO_SITEMAP_DIR",
                        "PUBLIC_RO_PAGES_DIR", "PUBLIC_RO_TAKEDOWN_DB")


def scan_public_ro_coupling(package_dir=None):
    # type: (Optional[Path]) -> List[str]
    root = package_dir or PACKAGE_DIR
    violations = []  # type: List[str]
    for path in _python_files(root):
        rel = str(path.relative_to(root))
        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=str(path))
        for lineno, name in _imported_names(tree):
            for prefix in PUBLIC_RO_IMPORT_PREFIXES:
                if name == prefix or name.startswith(prefix + "."):
                    violations.append(
                        "%s:%d imports %s — PM7: the home market's pipeline is "
                        "untouched by this package" % (rel, lineno, name)
                    )
        prose = _docstring_string_nodes(tree)
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str) \
                    and id(node) not in prose:
                for token in PUBLIC_RO_ENV_TOKENS:
                    if token in node.value:
                        violations.append(
                            "%s:%d reads %s — public_market must never open the "
                            "home market's store" % (rel, node.lineno, token)
                        )
    return violations


def _check_home_seed_refused(notes):
    # type: (List[str]) -> List[str]
    """PLANT: a home-market seed carrying one member must be REFUSED.

    The shipped ``seeds/ro.json`` is empty, which proves nothing on its
    own — an empty file is a convention, and conventions are one commit
    from being wrong. This plants a member into a home-market seed in
    memory and requires the loader to refuse it.
    """
    try:
        from engine.public_market import registry as _registry
        from engine.public_market import universe as _universe
    except ImportError:
        notes.append("universe lane not present — home-seed plant skipped")
        return []

    home = _registry.home_market()
    seed = _universe.Seed(
        market_id=home.market_id,
        as_of="2026-08-30",
        source={"name": "PM7 gate plant", "url": "https://example.invalid",
                "dataset_version": "plant-1",
                "retrieved_at": "2026-08-30T00:00:00Z"},
        license_note="PM7 gate plant",
        coverage_note="PM7 gate plant — must be refused",
        members=(_universe.Member(name="Banca Transilvania SA",
                                  tickers=("TLV",),
                                  lei="5493008NF6ZCBUFJ0X61"),),
    )
    with _temp_store() as store:
        try:
            _universe.load_into_store(seed, store)
        except _universe.SeedError:
            notes.append("home-market seed with members: REFUSED (PM7 plant)")
            return []
        except Exception as exc:  # noqa: BLE001
            return ["home-market seed raised %r instead of a typed SeedError"
                    % exc]
        held = store.entity_count(home.market_id)
    return [
        "a home-market seed carrying %d member(s) was ACCEPTED (store now "
        "holds %d %s entities) — the home market would be answered by two "
        "document classes" % (len(seed.members), held, home.market_id)
    ]


def _replay_python():
    """The interpreter that can actually import the engine."""
    venv = REPO / ".venv" / "bin" / "python"
    return str(venv) if venv.exists() else sys.executable


def run_corpus_replay():
    # type: () -> Tuple[bool, int, str]
    """(ok, case_count, tail). Shells out to the real gate — this file
    does not reimplement replay, it reads its verdict."""
    proc = subprocess.run(
        # Prefer the repo venv: corpus_replay imports the engine, which
        # needs sqlalchemy et al. Running the gate under a bare system
        # python3 made PM7 report a REGRESSION when the only thing wrong
        # was the interpreter — a gate that cries wolf gets ignored.
        [_replay_python(), str(REPO / "scripts" / "corpus_replay.py")],
        cwd=str(REPO), capture_output=True, text=True,
    )
    output = (proc.stdout or "") + (proc.stderr or "")
    count = -1
    for line in output.splitlines():
        if "CORPUS REPLAY" in line and "case(s)" in line:
            for token in line.replace("—", " ").split():
                if token.isdigit():
                    count = int(token)
    tail = "\n".join(output.strip().splitlines()[-4:])
    return proc.returncode == 0, count, tail


def check_pm7(verbose=False, run_replay=True):
    # type: (bool, bool) -> GateResult
    from engine.public_market import registry as _registry

    violations = scan_public_ro_coupling()
    notes = []  # type: List[str]

    # The home market's company route must refuse, by STRUCTURE.
    with _temp_store() as store:
        home = _registry.home_market()
        body, status = _company_via_router(store, home.market_id, "TLV")
        if status != 404 or body.get("code") != "HOME_MARKET_SERVED_ELSEWHERE":
            violations.append(
                "the home market's company route answered %s/%r instead of "
                "404 HOME_MARKET_SERVED_ELSEWHERE — one company must not have "
                "two sources of truth" % (status, body.get("code"))
            )
        # ...and it must still appear in the LIST, first.
        payload = _registry_payload_via_router(store)
        markets = payload.get("markets") or []
        if not markets or markets[0].get("market_id") != home.market_id:
            violations.append(
                "the home market does not lead the market list (got %r)"
                % (markets[0].get("market_id") if markets else None)
            )

    # The universe lane (landed 2026-08-30) can seed entities per market.
    # PM7 is only safe if the home market's seed cannot carry members —
    # and that must be enforced by CODE, not by the file happening to be
    # empty. Plant a home-market seed with one member and require a
    # refusal.
    violations += _check_home_seed_refused(notes)

    # Peer-add regression: an added peer from another sector must not
    # widen the cohort it is added to.
    try:
        from engine.public_market.freshness.peers import (
            PeerCandidate, deterministic_peers,
        )
    except Exception as exc:  # noqa: BLE001
        notes.append("peer selection unavailable (%r) — peer-add skipped" % exc)
    else:
        subject = PeerCandidate("AAPL", "Apple Inc", "Technology", 3.0e12)
        universe = [
            PeerCandidate("MSFT", "Microsoft", "Technology", 3.0e12),
            PeerCandidate("NVDA", "NVIDIA", "Technology", 3.1e12),
        ]
        baseline = [p.ticker for p in deterministic_peers(subject, universe)["peers"]]
        widened = universe + [
            PeerCandidate("XOM", "Exxon", "Energy", 3.0e12),      # other sector
            PeerCandidate("TINY", "Tiny Co", "Technology", 1.0e6),  # other band
        ]
        after = [p.ticker for p in deterministic_peers(subject, widened)["peers"]]
        if after != baseline:
            violations.append(
                "peer-add regression: adding an out-of-cohort company changed "
                "the peer set (%s -> %s)" % (baseline, after)
            )

    if run_replay:
        ok, count, tail = run_corpus_replay()
        if not ok:
            violations.append("corpus replay FAILED:\n%s" % tail)
        elif count != CORPUS_CASES:
            violations.append(
                "corpus replay reported %d cases, expected %d — a golden was "
                "added or deleted without review" % (count, CORPUS_CASES)
            )
        else:
            notes.append("corpus replay: PASS, %d cases byte-identical" % count)
    else:
        notes.append(
            "corpus replay SKIPPED (--no-replay). The battery runs it as its "
            "own 'corpus-replay' gate; this flag exists so the pytest lane "
            "does not pay for it twice."
        )

    notes.append(
        "the FE half of PM7 (peer-add creates a SECOND cohort rather than "
        "widening the home one) is asserted in "
        "frontend/lib/__tests__/marketGates.test.ts via partitionByKey"
    )
    return _verdict("PM7", "BVB / public_ro untouched; goldens byte-identical",
                    violations, notes)


# ══════════════════════════════════════════════════════════════════════
# Shared real-object builders (no fakes — see the module docstring)
# ══════════════════════════════════════════════════════════════════════


def build_reference_envelope(ticker="AAPL"):
    # type: (str) -> Dict[str, Any]
    """A REAL pm1 envelope: committed SEC bytes -> the real edgar
    adapter -> the real spine normalizer -> the real registry's US row.
    No hand-written figure appears anywhere in this gate's numeric
    assertions."""
    from engine.public_market import edgar as _edgar
    from engine.public_market import model as _model
    from engine.public_market import registry as _registry

    doc = json.loads(APPLE_FACTS.read_text(encoding="utf-8"))
    ir = _edgar.build_summary_ir(doc, FETCHED_AT)
    raw = _edgar.build_envelope(ir, ticker=ticker)
    return _model.normalize_envelope(raw, _registry.get_market("us"))


class _temp_store(object):
    """A REAL PublicMarketStore on a temp path. Context-managed so no
    gate run can leave ``data/public_market.db`` behind."""

    def __init__(self):
        self._dir = None  # type: Optional[str]
        self._store = None  # type: Any
        self._saved = None  # type: Any

    def __enter__(self):
        from engine.public_market import store as store_mod

        self._dir = tempfile.mkdtemp(prefix="pm-gate-store-")
        self._saved = os.environ.get(store_mod.DB_ENV)
        os.environ[store_mod.DB_ENV] = str(Path(self._dir) / "public_market.db")
        self._store = store_mod.PublicMarketStore(Path(self._dir) / "public_market.db")
        return self._store

    def __exit__(self, *exc):
        from engine.public_market import store as store_mod

        try:
            if self._store is not None:
                self._store.close()
        finally:
            if self._saved is None:
                os.environ.pop(store_mod.DB_ENV, None)
            else:
                os.environ[store_mod.DB_ENV] = self._saved
            if self._dir:
                shutil.rmtree(self._dir, ignore_errors=True)
        return False


def _client_for(store):
    # type: (Any) -> Any
    """A TestClient over the REAL router with the REAL store injected.

    ``follow_redirects=False`` deliberately: the PS6 gate lost its entire
    "a sitemap must not list a 301" check to TestClient's default, which
    silently reported the redirect TARGET's status.
    """
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from engine.public_market import router as router_mod

    app = FastAPI()
    app.include_router(router_mod.build_router(store))
    return TestClient(app, raise_server_exceptions=False, follow_redirects=False)


def _registry_payload_via_router(store):
    # type: (Any) -> Dict[str, Any]
    from engine.public_market import router as router_mod

    with _client_for(store) as client:
        response = client.get(router_mod.PREFIX)
        try:
            return response.json()
        except ValueError:
            return {}


def _company_via_router(store, market_id, ticker):
    # type: (Any, str, str) -> Tuple[Dict[str, Any], int]
    from engine.public_market import router as router_mod

    with _client_for(store) as client:
        response = client.get(
            "%s/company/%s/%s" % (router_mod.PREFIX, market_id, ticker))
        try:
            body = response.json()
        except ValueError:
            body = {}
        return body, response.status_code


def _seed_entities(store, market, n):
    # type: (Any, Any, int) -> None
    """Seed exactly ``n`` entities for ``market`` through the store's OWN
    public API. Anything this cannot express is a gap in the store's API,
    not a licence to reach into SQL — reaching into SQL is how a fake
    starts."""
    store._conn.execute("DELETE FROM entities")  # noqa: SLF001 — test reset
    store._conn.commit()  # noqa: SLF001
    for index in range(n):
        store.upsert_entity(
            "pm-gate-%s-%d" % (market.market_id, index),
            market_id=market.market_id,
            ticker="T%d" % index,
            name="Gate Fixture %d" % index,
            currency=market.currency,
            source=market.fundamentals_source,
        )


# ══════════════════════════════════════════════════════════════════════
# Entry point
# ══════════════════════════════════════════════════════════════════════

GATES = (
    ("PM1", check_pm1),
    ("PM2", check_pm2),
    ("PM3", check_pm3),
    ("PM4", check_pm4),
    ("PM5", check_pm5),
    ("PM6", check_pm6),
)


def run_gates(verbose=False, run_replay=True):
    # type: (bool, bool) -> List[GateResult]
    results = []  # type: List[GateResult]
    for name, fn in GATES:
        try:
            results.append(fn(verbose))
        except Exception as exc:  # noqa: BLE001 — a crashed gate is a red gate
            import traceback

            results.append(GateResult(
                name, FAIL, "gate raised", [traceback.format_exc(limit=6)]))
    try:
        results.append(check_pm7(verbose, run_replay=run_replay))
    except Exception:  # noqa: BLE001
        import traceback

        results.append(GateResult(
            "PM7", FAIL, "gate raised", [traceback.format_exc(limit=6)]))
    return results


def main(argv=None):
    # type: (Optional[List[str]]) -> int
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("-v", "--verbose", action="store_true")
    parser.add_argument("--no-replay", action="store_true",
                        help="skip PM7's corpus_replay subprocess (reported)")
    parser.add_argument("--json", action="store_true",
                        help="emit the machine record instead of the table")
    args = parser.parse_args(argv)

    results = run_gates(verbose=args.verbose, run_replay=not args.no_replay)

    if args.json:
        print(json.dumps([r.as_dict() for r in results], indent=2, sort_keys=True))
        return 1 if any(not r.ok for r in results) else 0

    for result in results:
        print("%-4s %-4s %s" % (result.state, result.gate, result.headline))
        for line in result.violations:
            for sub in str(line).splitlines():
                print("       ! %s" % sub)
        if args.verbose or result.state != PASS:
            for note in result.notes:
                print("       · %s" % note)

    failed = [r.gate for r in results if not r.ok]
    skipped = [r.gate for r in results if r.state == SKIP]
    print("PUBLIC-MARKET GATES: %s — %d/%d green%s"
          % ("FAIL" if failed else "PASS",
             len([r for r in results if r.state == PASS]), len(results),
             (", %d skipped (%s)" % (len(skipped), ", ".join(skipped)))
             if skipped else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
