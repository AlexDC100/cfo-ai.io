"""Pack lint — static analysis over pack directories.

Four layers, all reported as ``PackIssue`` records (the same type the
loader's validation emits, so one finding vocabulary serves both):

1.  SCHEMA — a pack that fails ``load_pack`` reports every collected
    issue verbatim (missing files, bad fields, dangling line_ids,
    duplicate/shadowed rules, unknown check impls, ...).
2.  PER-PACK ANALYSES (valid packs only) — shadowing the loader
    tolerates structurally:
      * ``range-shadowed-by-prefix`` (ERROR) a range rule whose ENTIRE
        band a broader prefix rule covers — under the fixed precedence
        (exact > longest-prefix > range) the range can never win, so
        the rule is dead data;
      * ``range-overlap``   (warning) two range rules whose bands
        intersect (declaration order decides the winner on the
        overlap — legal but worth eyes);
      * ``redundant-exact`` (warning) an exact rule whose code a prefix
        rule already routes to the SAME line with the same contra flag
        and side_flip (the exact rule adds nothing).
3.  CROSS-PACK (a root of packs, per jurisdiction+pack_id lineage):
      * ``effective-overlap`` two versions' [from, to) windows
        intersect — resolution would be ambiguous (error);
      * ``effective-gap``     a window ends before the next begins —
        period_ends in the hole resolve to nothing (error).
4.  COVERAGE (opt-in) — run the compiled rules over account codes taken
    from a corpus file and report every unmatched code + a coverage
    ratio. Accepted inputs: corpus ``expected/classification.json``
    (``accounts[].code``), ``expected/extraction.json`` (``rows[].cont``),
    any JSON with either shape, or a plain text file with one code per
    line (``#`` comments allowed).

SHADOW-PHASE LEAF: pure analysis, no engine imports beyond the sibling
modules. CLI wrapper: ``scripts/pack_lint.py``.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple, Union

from .loader import load_pack
from .schema import (
    ClassificationRule,
    CompiledPack,
    PackIssue,
    PackSchemaError,
)

__all__ = [
    "LintReport",
    "lint_pack",
    "lint_root",
    "find_pack_dirs",
    "analyze_effective_ranges",
    "extract_codes",
    "coverage_report",
]


class LintReport:
    """Findings for one lint run. ``ok`` == no error-severity findings."""

    def __init__(self) -> None:
        self.findings: List[PackIssue] = []
        #: pack_dir -> CompiledPack for every pack that loaded cleanly
        self.packs: Dict[str, CompiledPack] = {}
        #: coverage results per input file (filled by coverage_report)
        self.coverage: List[Dict[str, Any]] = []

    @property
    def ok(self) -> bool:
        return not any(f.severity == "error" for f in self.findings)

    def extend(self, issues: Iterable[PackIssue]) -> None:
        self.findings.extend(issues)

    def render(self) -> str:
        lines = [f.render() for f in self.findings]
        for cov in self.coverage:
            lines.append(
                "COVERAGE %s: %d/%d codes matched (%.1f%%), %d unmatched"
                % (cov["source"], cov["matched"], cov["total"],
                   cov["coverage_pct"], len(cov["unmatched"]))
            )
            for code in cov["unmatched"]:
                lines.append("  unmatched %s" % code)
        if not lines:
            lines.append("clean — no findings")
        return "\n".join(lines)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "ok": self.ok,
            "findings": [
                {"severity": f.severity, "code": f.code, "message": f.message,
                 "file": f.file, "where": f.where}
                for f in self.findings
            ],
            "packs": {
                d: {"pack_id": p.identity.pack_id,
                    "version": p.identity.version,
                    "jurisdiction": p.identity.jurisdiction,
                    "pack_hash": p.pack_hash}
                for d, p in sorted(self.packs.items())
            },
            "coverage": self.coverage,
        }


# --- per-pack ---------------------------------------------------------------


def _pack_issue(pack_dir: Path, issue: PackIssue) -> PackIssue:
    """Prefix the issue's file with the pack directory name so a root
    lint over many packs stays readable."""
    file = "%s/%s" % (pack_dir.name, issue.file) if issue.file else pack_dir.name
    return PackIssue(issue.severity, issue.code, issue.message, file, issue.where)


def _range_band(rule: ClassificationRule) -> Tuple[int, int, int]:
    """(bound_length, from, to) of a range rule's prefix band."""
    return (len(rule.range_from or ""), int(rule.range_from or 0),
            int(rule.range_to or 0))


def _analyze_pack(pack_dir: Path, pack: CompiledPack) -> List[PackIssue]:
    out: List[PackIssue] = []
    ranges = [r for r in pack.rules if r.kind == "range"]

    # range-shadowed-by-prefix — the fixed precedence puts EVERY prefix
    # rule ahead of every range rule, so a range whose whole band lies
    # under one prefix is unreachable (e.g. band 391..398 under a bare
    # '3' catchall prefix). Dead data — error.
    for r in ranges:
        length, lo, hi = _range_band(r)
        for prefix, p_rule in pack.prefix_index.items():
            if len(prefix) > length:
                continue
            # the prefix's block of L-digit values: [P·10^k, (P+1)·10^k)
            span = 10 ** (length - len(prefix))
            block_lo = int(prefix) * span
            if block_lo <= lo and hi <= block_lo + span - 1:
                out.append(_pack_issue(pack_dir, PackIssue(
                    "error", "range-shadowed-by-prefix",
                    "range rule %r (%s..%s) is fully shadowed by prefix rule "
                    "%r (%r) — prefix outranks range, this rule can never "
                    "match" % (r.rule_id, r.range_from, r.range_to,
                               p_rule.rule_id, prefix),
                    "classification.yaml", r.rule_id,
                )))
                break

    # range-overlap — same band length and intersecting spans
    for i, a in enumerate(ranges):
        la, fa, ta = _range_band(a)
        for b in ranges[i + 1:]:
            lb, fb, tb = _range_band(b)
            if la == lb and fa <= tb and fb <= ta:
                out.append(_pack_issue(pack_dir, PackIssue(
                    "warning", "range-overlap",
                    "range rules %r (%s..%s) and %r (%s..%s) overlap — "
                    "declaration order decides the winner on the overlap"
                    % (a.rule_id, a.range_from, a.range_to,
                       b.rule_id, b.range_from, b.range_to),
                    "classification.yaml", b.rule_id,
                )))

    # redundant-exact — an exact rule a prefix rule already reproduces
    for r in pack.rules:
        if r.kind != "exact" or r.exact is None:
            continue
        code = r.exact
        covering: Optional[ClassificationRule] = None
        for length in range(len(code), 0, -1):
            covering = pack.prefix_index.get(code[:length])
            if covering is not None:
                break
        if (
            covering is not None
            and covering.line_id == r.line_id
            and covering.contra == r.contra
            and covering.side_flip == r.side_flip
        ):
            out.append(_pack_issue(pack_dir, PackIssue(
                "warning", "redundant-exact",
                "exact rule %r duplicates what prefix rule %r already does "
                "for code %s" % (r.rule_id, covering.rule_id, code),
                "classification.yaml", r.rule_id,
            )))
    return out


def lint_pack(pack_dir: Union[str, Path],
              report: Optional[LintReport] = None) -> LintReport:
    """Lint ONE pack directory: loader validation first (schema issues
    reported, not raised), then the per-pack analyses on a valid pack."""
    pack_dir = Path(pack_dir)
    report = report if report is not None else LintReport()
    try:
        pack = load_pack(pack_dir)
    except PackSchemaError as exc:
        report.extend(_pack_issue(pack_dir, i) for i in exc.issues)
        return report
    report.packs[str(pack_dir)] = pack
    report.extend(_analyze_pack(pack_dir, pack))
    return report


# --- cross-pack (a root of packs) -------------------------------------------


def _lineage_key(pack: CompiledPack) -> Tuple[str, str]:
    return (pack.identity.jurisdiction.upper(), pack.identity.pack_id)


def _window_str(pack: CompiledPack) -> str:
    ident = pack.identity
    return "[%s, %s)" % (
        ident.effective_from.isoformat(),
        ident.effective_to.isoformat() if ident.effective_to else "open",
    )


def analyze_effective_ranges(packs: Sequence[CompiledPack]) -> List[PackIssue]:
    """Per (jurisdiction, pack_id) lineage: sorted by effective_from,
    consecutive windows must tile exactly — an intersection is
    ``effective-overlap``, a hole is ``effective-gap``. An open-ended
    window followed by another window is an overlap by construction."""
    out: List[PackIssue] = []
    by_lineage: Dict[Tuple[str, str], List[CompiledPack]] = {}
    for p in packs:
        by_lineage.setdefault(_lineage_key(p), []).append(p)
    for (jur, pack_id), group in sorted(by_lineage.items()):
        group = sorted(group, key=lambda p: (p.identity.effective_from.isoformat(),
                                             p.identity.version))
        for prev, nxt in zip(group, group[1:]):
            prev_to = prev.identity.effective_to
            nxt_from = nxt.identity.effective_from
            where = "%s@%s vs @%s" % (pack_id, prev.identity.version,
                                      nxt.identity.version)
            if prev_to is None or nxt_from < prev_to:
                out.append(PackIssue(
                    "error", "effective-overlap",
                    "%s %s windows overlap: %s and %s — resolution is ambiguous "
                    "inside the intersection"
                    % (jur, pack_id, _window_str(prev), _window_str(nxt)),
                    None, where,
                ))
            elif nxt_from > prev_to:
                out.append(PackIssue(
                    "error", "effective-gap",
                    "%s %s windows leave a gap: %s then %s — period_ends in "
                    "[%s, %s) resolve to NO pack"
                    % (jur, pack_id, _window_str(prev), _window_str(nxt),
                       prev_to.isoformat(), nxt_from.isoformat()),
                    None, where,
                ))
    return out


def find_pack_dirs(root: Union[str, Path]) -> Tuple[Path, ...]:
    """Every directory under ``root`` holding a pack.yaml (recursive;
    hidden path components relative to root are skipped). Deterministic
    path order."""
    root = Path(root)
    return tuple(sorted(
        {p.parent for p in root.rglob("pack.yaml")
         if not any(part.startswith(".")
                    for part in p.parent.relative_to(root).parts)},
        key=lambda p: str(p),
    ))


def lint_root(root: Union[str, Path]) -> LintReport:
    """Lint every pack under ``root`` plus the cross-pack effective-range
    analysis over the packs that loaded cleanly."""
    root = Path(root)
    report = LintReport()
    pack_dirs = find_pack_dirs(root)
    if not pack_dirs:
        report.extend([PackIssue(
            "error", "no-packs", "no pack.yaml found under %s" % root)])
        return report
    for d in pack_dirs:
        lint_pack(d, report)
    report.extend(analyze_effective_ranges(tuple(report.packs.values())))
    return report


# --- coverage ---------------------------------------------------------------


def extract_codes(path: Union[str, Path]) -> Tuple[str, ...]:
    """Account codes from a corpus-style file, first-seen order, deduped.

    JSON: ``accounts[].code`` (corpus expected/classification.json) or
    ``rows[].cont`` (corpus expected/extraction.json) — whichever is
    present. Anything else: one code per line, ``#`` comments and blank
    lines skipped."""
    path = Path(path)
    text = path.read_text(encoding="utf-8")
    codes: List[str] = []

    def add(value: Any) -> None:
        if isinstance(value, (int,)) and not isinstance(value, bool):
            value = str(value)
        if isinstance(value, str) and value.strip():
            code = value.strip()
            if code not in seen:
                seen.add(code)
                codes.append(code)

    seen: set = set()
    if path.suffix.lower() == ".json":
        payload = json.loads(text)
        for entry in (payload.get("accounts") or []):
            if isinstance(entry, dict):
                add(entry.get("code"))
        for entry in (payload.get("rows") or []):
            if isinstance(entry, dict):
                add(entry.get("cont"))
    else:
        for line in text.splitlines():
            line = line.split("#", 1)[0].strip()
            # tolerate simple CSV: first field is the code
            if "," in line:
                line = line.split(",", 1)[0].strip()
            if line:
                add(line)
    return tuple(codes)


def coverage_report(pack: CompiledPack, codes: Sequence[str],
                    source: str = "<codes>") -> Dict[str, Any]:
    """Run the compiled rules over ``codes``; report matched/unmatched
    and the coverage percentage. Pure function — no findings, the CLI
    decides how loud unmatched codes should be."""
    matched: List[str] = []
    unmatched: List[str] = []
    for code in codes:
        (matched if pack.match(code) is not None else unmatched).append(code)
    total = len(codes)
    return {
        "source": source,
        "pack_id": pack.identity.pack_id,
        "version": pack.identity.version,
        "total": total,
        "matched": len(matched),
        "unmatched": unmatched,
        "coverage_pct": (100.0 * len(matched) / total) if total else 100.0,
    }
