"""engine.packs — jurisdiction DATA packs (Part C: loader, shadow phase).

A pack is a pure-data directory (five YAML files: pack.yaml,
classification.yaml, checks.yaml, statement_map.yaml, reconcile.yaml)
describing one jurisdiction's accounting rules for one effective
window. This package loads such directories into schema-validated,
immutable, index-compiled ``CompiledPack`` objects with a
content-addressed ``pack_hash``, resolves the governing pack for a
(jurisdiction, period_end) pair with typed errors, and lints pack data
(schema, effective-range tiling, rule shadowing, statement-map
coverage). CLI: ``scripts/pack_lint.py``.

ZERO-BEHAVIOR-CHANGE: production keeps running the legacy
classification (``engine.country_packs``); nothing in the pipeline
imports this package yet. The golden corpus is untouched by
construction.
"""
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
    PackError,
    PackIdentity,
    PackIssue,
    PackResolutionError,
    PackSchemaError,
    ReconcilePolicy,
    SideFlip,
    StatementNode,
    register_check_impl,
    registered_check_impls,
    unregister_check_impl,
)
from .loader import (
    PACK_FILES,
    compute_pack_hash,
    discover_packs,
    load_pack,
    resolve,
)
from .lint import (
    LintReport,
    analyze_effective_ranges,
    coverage_report,
    extract_codes,
    find_pack_dirs,
    lint_pack,
    lint_root,
)

__all__ = [
    # schema
    "PACK_SCHEMA_VERSION",
    "KNOWN_DECLARATIVE_CHECK_IDS",
    "RECONCILE_PLACEMENTS",
    "CHECK_IMPLS",
    "PackError",
    "PackSchemaError",
    "PackResolutionError",
    "NoPackFoundError",
    "AmbiguousPackError",
    "PackIssue",
    "LegalSource",
    "ChangelogEntry",
    "PackIdentity",
    "SideFlip",
    "ClassificationRule",
    "CheckConfig",
    "StatementNode",
    "ReconcilePolicy",
    "CompiledPack",
    "register_check_impl",
    "unregister_check_impl",
    "registered_check_impls",
    # loader
    "PACK_FILES",
    "load_pack",
    "discover_packs",
    "resolve",
    "compute_pack_hash",
    # lint
    "LintReport",
    "lint_pack",
    "lint_root",
    "find_pack_dirs",
    "analyze_effective_ranges",
    "extract_codes",
    "coverage_report",
]
