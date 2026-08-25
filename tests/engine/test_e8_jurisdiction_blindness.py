"""E8 — zero jurisdiction hardcoding in the AI-first-reader engine code.

The adversarial wave (2026-08-25) planted literal jurisdiction branches
(``if jurisdiction == "RO": ...``) into the interpreter, the consensus
lane and the template store, one at a time. NO committed test fired for
any of them: two plants were caught only incidentally (return-None broke
end-to-end behavior) and a behavior-affecting branch in the template
store escaped the full suite outright. This guard closes that hole —
the N7 discipline's token-scan, extended to the wave's new modules.

RULES the scan enforces over every ``*.py`` under the scanned roots:

  * no quoted country-code literal ("RO", 'HU', ...) — jurisdiction is
    an OPAQUE string in these modules; naming a jurisdiction is a
    branch waiting to happen;
  * no ``jurisdiction ==`` / ``== jurisdiction`` comparison against
    anything (the opaque string may be passed through, keyed on via
    pack lookup, or embedded in prompts — never compared in code);
  * no jurisdiction-named module path (``country_packs.<jur>_...``)
    except the single documented legacy-bridge import below.

ALLOWLIST (exact-line, reason required):
  * ``map_guided_legacy.py``'s import of
    ``engine.country_packs.ro_romania.trial_balance_parser`` — the
    legacy bridge must build a REAL ``TrialBalanceParseResult`` /
    ``compute_source_anchor`` output and the pack object does not
    forward those seams; the import carries the jurisdiction token in
    its MODULE PATH only (recorded by the mapfe lane's report). Any
    second such import is a violation until it carries its own entry.
"""
from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ENGINE = REPO / "src" / "engine"

#: Roots the AI-first-reader wave added — all jurisdiction-blind by
#: contract. Extend this list when a new jurisdiction-blind package
#: lands; shrinking it is a red flag.
SCANNED_ROOTS = (
    ENGINE / "interp",
    ENGINE / "consensus",
)
SCANNED_FILES = (
    ENGINE / "frontends" / "map_guided.py",
    ENGINE / "frontends" / "map_guided_legacy.py",
    ENGINE / "passes" / "movements.py",
    ENGINE / "passes" / "movement_review.py",
)

#: Known jurisdiction vocabulary. Quoted, standalone. "ZZ" is the N7
#: test jurisdiction — planting it here must fire too.
_CODE = r"(?:RO|HU|ZZ)"
TOKEN_PATTERNS = (
    # quoted country-code literal: "RO" / 'HU'
    re.compile(r"""["']%s["']""" % _CODE),
    # comparisons against a jurisdiction variable, either direction
    re.compile(r"\bjurisdiction\s*(?:==|!=)"),
    re.compile(r"(?:==|!=)\s*jurisdiction\b"),
    # jurisdiction-named module paths
    re.compile(r"\bcountry_packs\.[a-z]{2}_[a-z]+"),
)

#: (file basename, exact substring, reason) — the ONLY sanctioned hits.
ALLOWLIST = (
    (
        "map_guided_legacy.py",
        "from engine.country_packs.ro_romania.trial_balance_parser import",
        "legacy bridge needs the real TrialBalanceParseResult/"
        "compute_source_anchor seams; token lives in the module path only",
    ),
)


def _iter_files():
    for root in SCANNED_ROOTS:
        assert root.is_dir(), "scanned root vanished: %s" % root
        yield from sorted(root.rglob("*.py"))
    for f in SCANNED_FILES:
        assert f.is_file(), "scanned file vanished: %s" % f
        yield f


def _allowed(path: Path, line: str) -> bool:
    return any(
        path.name == name and frag in line
        for name, frag, _reason in ALLOWLIST
    )


def test_e8_no_jurisdiction_hardcoding_in_ai_first_reader_modules():
    violations = []
    for path in _iter_files():
        for lineno, line in enumerate(
            path.read_text(encoding="utf-8").splitlines(), 1
        ):
            for pat in TOKEN_PATTERNS:
                if pat.search(line) and not _allowed(path, line):
                    violations.append(
                        "%s:%d: %s"
                        % (path.relative_to(REPO), lineno, line.strip()[:100])
                    )
                    break
    assert not violations, (
        "E8 violated — jurisdiction hardcoding in jurisdiction-blind "
        "modules (route jurisdiction data through hints/pack data, or add "
        "a reasoned ALLOWLIST entry):\n" + "\n".join(violations)
    )


def test_e8_allowlist_entries_still_exist():
    """A stale allowlist entry hides nothing but rots the reasoning —
    every entry must still match a real line."""
    for name, frag, _reason in ALLOWLIST:
        hits = [
            p for p in _iter_files()
            if p.name == name and frag in p.read_text(encoding="utf-8")
        ]
        assert hits, "stale ALLOWLIST entry: %s / %r" % (name, frag)
