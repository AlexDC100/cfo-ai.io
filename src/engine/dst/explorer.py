"""DST explorer — seeded enumeration of (fixture × fault × boundary).

Profiles (task contract):
    per-pr   the bounded matrix: ONE fixture per fault class, one
             representative boundary — every fault class exercised on
             every PR at fixed cost.
    deep     the exhaustive matrix (env ``DST_PROFILE=deep``): three
             deterministic fixtures (+ the AI-lane fixture where the
             fault applies) × every fault × every boundary — the
             nightly sweep.

The SEED drives the schedule: the run order of the matrix is a
``random.Random(seed)`` permutation, so interleaving-order effects
(shared module state, cache warm-up, journal-cache hygiene) are hunted
across runs while any single seed reproduces its exact schedule. The
scenarios themselves are deterministic — the seed never changes WHAT a
config does, only WHEN it runs relative to the others.

Every failure MINIMIZES (the same fault + boundary re-run on
lane-compatible fixtures in ascending input size; the smallest failing
configuration wins) and ARCHIVES {seed, fixture, fault, boundary,
traceback} to ``corpus/quarantine/dst/<sha16>/`` — the same discipline
as the property-suite quarantine (tests/engine/test_properties.py).
"""
from __future__ import annotations

import hashlib
import json
import os
import random
import tempfile
import traceback as _traceback_mod
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from .faults import FAULTS, GAPS, FaultSpec
from .harness import FIXTURES, REPO, minimize_order

QUARANTINE_ROOT = REPO / "corpus" / "quarantine" / "dst"

PROFILES = ("per-pr", "deep")

DEFAULT_SEED = 20260823


def profile_from_env(default: str = "per-pr") -> str:
    return "deep" if os.environ.get("DST_PROFILE") == "deep" else default


@dataclass(frozen=True)
class DstConfig:
    fault: str
    fixture: str
    boundary: str

    def as_dict(self) -> Dict[str, str]:
        return {"fault": self.fault, "fixture": self.fixture, "boundary": self.boundary}

    def label(self) -> str:
        return "%s @ %s [%s]" % (self.fault, self.boundary, self.fixture)


def build_matrix(
    profile: str,
    *,
    faults: Optional[Sequence[str]] = None,
    fixtures: Optional[Sequence[str]] = None,
) -> List[DstConfig]:
    """The (fixture × fault × boundary) enumeration for ``profile``,
    optionally filtered. Deterministic order (sorted by fault name, then
    fixture, then boundary position) — the seed permutes it later."""
    if profile not in PROFILES:
        raise ValueError("unknown profile %r (known: %s)" % (profile, PROFILES))
    wanted_faults = set(faults) if faults else None
    wanted_fixtures = set(fixtures) if fixtures else None
    unknown = (wanted_faults or set()) - set(FAULTS)
    if unknown:
        raise ValueError("unknown fault(s): %s" % ", ".join(sorted(unknown)))
    unknown_fx = (wanted_fixtures or set()) - set(FIXTURES)
    if unknown_fx:
        raise ValueError("unknown fixture(s): %s" % ", ".join(sorted(unknown_fx)))

    matrix: List[DstConfig] = []
    for name in sorted(FAULTS):
        if wanted_faults is not None and name not in wanted_faults:
            continue
        spec = FAULTS[name]
        fixture_names = spec.fixtures_for(profile)
        boundaries: Tuple[str, ...] = (
            spec.boundaries if profile == "deep" else (spec.per_pr_boundary,)
        )
        for fixture_name in fixture_names:
            if wanted_fixtures is not None and fixture_name not in wanted_fixtures:
                continue
            for boundary in boundaries:
                matrix.append(DstConfig(name, fixture_name, boundary))
    return matrix


def run_config(config: DstConfig, scratch: Optional[Path] = None) -> Dict[str, Any]:
    """Run ONE injection point in a fresh scratch dir. Returns
    ``{"config", "ok", "summary" | "error"}`` — the error carries the
    full traceback for the quarantine artifact."""
    spec = FAULTS[config.fault]
    own_tmp: Optional[tempfile.TemporaryDirectory] = None
    if scratch is None:
        own_tmp = tempfile.TemporaryDirectory(prefix="dst-%s-" % config.fault)
        scratch = Path(own_tmp.name)
    try:
        summary = spec.runner(config.fixture, config.boundary, Path(scratch))
        return {"config": config.as_dict(), "ok": True, "summary": summary}
    except Exception as exc:  # noqa: BLE001 — every failure is data, not a crash
        return {
            "config": config.as_dict(),
            "ok": False,
            "error": {
                "type": type(exc).__name__,
                "message": str(exc),
                "traceback": _traceback_mod.format_exc(),
            },
        }
    finally:
        if own_tmp is not None:
            own_tmp.cleanup()


def _minimize_candidates(spec: FaultSpec, failing_fixture: str) -> List[str]:
    """Lane-compatible fixtures in ascending input size — the smallest
    failing one is the minimal configuration. Receipt-only scenarios and
    the AI lane have exactly one valid fixture (nothing to shrink)."""
    if spec.receipt_only:
        return ["rounding_004pct"]
    if FIXTURES[failing_fixture].lane == "hu_ai_lane":
        return ["hu_ai_lane"]
    return minimize_order()


def minimize_failure(
    config: DstConfig,
) -> Tuple[DstConfig, Dict[str, Any]]:
    """Re-run the same fault + boundary on ever-smaller fixtures; return
    (smallest failing config, its failure record). Falls back to the
    original config when nothing smaller fails (or nothing smaller
    exists)."""
    spec = FAULTS[config.fault]
    for candidate in _minimize_candidates(spec, config.fixture):
        candidate_cfg = DstConfig(config.fault, candidate, config.boundary)
        result = run_config(candidate_cfg)
        if not result["ok"]:
            return candidate_cfg, result
    # The failure did not reproduce on the sweep (flaky / order-coupled):
    # re-run the original once to capture a fresh traceback; if even that
    # passes, the caller keeps the original failure record it already has.
    retry = run_config(config)
    return config, retry


def archive_failure(
    config: DstConfig,
    *,
    seed: int,
    profile: str,
    traceback_text: str,
    minimized_from: Optional[DstConfig] = None,
    out_root: Optional[Path] = None,
) -> Path:
    """Write ``corpus/quarantine/dst/<sha16>/`` with {seed, fixture,
    fault, boundary, traceback} — the property-suite quarantine
    discipline. The sha16 keys on the failure IDENTITY (fault + fixture
    + boundary), so re-runs of the same failure overwrite in place
    instead of accumulating."""
    root = Path(out_root) if out_root is not None else QUARANTINE_ROOT
    identity = "dst\n%s\n%s\n%s" % (config.fault, config.fixture, config.boundary)
    sha16 = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:16]
    target = root / sha16
    target.mkdir(parents=True, exist_ok=True)
    payload = {
        "fault": config.fault,
        "fixture": config.fixture,
        "boundary": config.boundary,
        "seed": seed,
        "profile": profile,
        "minimized_from": minimized_from.as_dict() if minimized_from else None,
    }
    (target / "config.json").write_text(
        json.dumps(payload, sort_keys=True, indent=2) + "\n", encoding="utf-8"
    )
    (target / "fault").write_text(config.fault + "\n", encoding="utf-8")
    (target / "seed").write_text(
        json.dumps(
            {
                "seed": seed,
                "profile": profile,
                "note": (
                    "the seed permutes the schedule (matrix run order) only; "
                    "each scenario is deterministic given its config — "
                    "re-running this exact config reproduces the failure "
                    "without the seed"
                ),
            },
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    (target / "traceback").write_text(traceback_text, encoding="utf-8")
    return target


def explore(
    *,
    seed: int = DEFAULT_SEED,
    profile: Optional[str] = None,
    faults: Optional[Sequence[str]] = None,
    fixtures: Optional[Sequence[str]] = None,
    out_root: Optional[Path] = None,
    minimize: bool = True,
) -> Dict[str, Any]:
    """Run the full matrix for ``profile`` under the seeded schedule.
    Returns the report dict; failures are minimized and archived. Never
    raises for a scenario failure — the report is the honest record."""
    the_profile = profile or profile_from_env()
    matrix = build_matrix(the_profile, faults=faults, fixtures=fixtures)
    order = list(matrix)
    random.Random(seed).shuffle(order)

    results: List[Dict[str, Any]] = []
    failures: List[Dict[str, Any]] = []
    quarantined: List[str] = []
    for config in order:
        result = run_config(config)
        results.append(result)
        if result["ok"]:
            continue
        record = dict(result)
        if minimize:
            min_cfg, min_result = minimize_failure(config)
            if not min_result.get("ok", True):
                record = dict(min_result)
                record["minimized_from"] = config.as_dict()
                config_for_archive = min_cfg
                minimized_from = config if min_cfg != config else None
            else:
                config_for_archive = config
                minimized_from = None
        else:
            config_for_archive = config
            minimized_from = None
        target = archive_failure(
            config_for_archive,
            seed=seed,
            profile=the_profile,
            traceback_text=(record.get("error") or {}).get("traceback")
            or "traceback unavailable",
            minimized_from=minimized_from,
            out_root=out_root,
        )
        record["quarantine"] = str(target)
        failures.append(record)
        quarantined.append(str(target))

    return {
        "profile": the_profile,
        "seed": seed,
        "total": len(order),
        "passed": len(order) - len(failures),
        "failed": failures,
        "quarantined": quarantined,
        "schedule": [c.label() for c in order],
        "gaps": [dict(g) for g in GAPS],
    }
