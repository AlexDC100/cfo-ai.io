#!/usr/bin/env python3
"""Gate `bundle-labels` — no client book's label in the files every visitor downloads.

WHY THIS EXISTS (2026-10-02)
  The production bundle (dist/assets/index-*.js) carried the label of a
  client's book six times: developer notes written as CSS comments INSIDE the
  report's stylesheet template ("MEASURED on the delivered <label> pack …").
  A minifier does not strip a comment that lives inside a string. The
  public-sample gate had found the same notes in the exported report and
  `shippedCss()` removed them from the EXPORT — one of the two outlets. The
  bundle is the other: every visitor of the landing page downloads it. The
  notes are now TypeScript comments (`${""/* … */}` inside the template), so
  the string the bundle holds carries none.

WHAT IT SCANS
  Every .js / .css / .html / .json / .webmanifest / .txt / .xml / .svg file
  under dist/ (the build `npm run build` leaves; this gate runs after
  `npm-build` in the battery). The labels are derived at run time from the
  names of the real books the repository holds (scripts/client_labels.py) —
  never typed here.

WHAT IS NOT A LABEL IN A BUNDLE
  · an IDENTIFIER: a label glued to a hyphen (`--abc-ink`, `abc-board`) is a
    CSS custom property or class name, not prose a reader meets;
  · a PLACE NAME that is also part of a fixture's file name: listed in
    PLACE_NAMES below with the reason — the listed-company map names the
    county a company sits in.
  Both are reported in the work line, so "0 hits" is never an empty scan.

WHAT IT REDS ON, now that the bundle is clean (TC-11): a client label in any
text file under dist/ outside those two cases; a missing dist/ (a scan of
nothing is not a pass); fewer than 4 labels derived; fewer than 50 files
scanned.
WHAT IT CANNOT SEE: a client's name that is not in a fixture's file name; a
label inside an image; the server-rendered storefront.

Exit 0 clean · 1 a label found · 2 nothing to scan.
Python 3.9 — no ``match``, no ``X | Y``.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Dict, List, Tuple

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts"))

import client_labels as CL  # noqa: E402

DIST = REPO / "dist"
TEXT_SUFFIXES = (".js", ".css", ".html", ".json", ".webmanifest", ".txt", ".xml", ".svg", ".map")

#: A fixture label that is ALSO a place name, where the bundle legitimately
#: names the place. Typed here because it is a town, not a client.
PLACE_NAMES: Dict[str, str] = {
    "sibiu": "a Romanian county and city — the listed-company map names the county a company sits in",
}


def scan(dist: Path, labels: List[str]) -> Tuple[List[Tuple[str, int, int]], int, int, int]:
    """(hits [(file, offset, label length)], files scanned, identifier matches, place matches)."""
    prose = [lab for lab in labels if lab not in PLACE_NAMES]
    if not prose:
        return [], 0, 0, 0
    alternation = "|".join(map(re.escape, prose))
    as_prose = re.compile(r"(?<![A-Za-z-])(%s)(?![A-Za-z-])" % alternation, re.I)
    as_identifier = re.compile(r"(?:(?<=-)(%s)|(%s)(?=-))" % (alternation, alternation), re.I)
    places = re.compile(r"(?<![A-Za-z])(%s)(?![A-Za-z])" % "|".join(map(re.escape, PLACE_NAMES)), re.I)
    hits: List[Tuple[str, int, int]] = []
    files = identifiers = place_hits = 0
    for path in sorted(dist.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in TEXT_SUFFIXES:
            continue
        # public/sample is the fictional company's files, held by `public-sample` S5
        text = path.read_text(encoding="utf-8", errors="replace")
        files += 1
        identifiers += len(as_identifier.findall(text))
        place_hits += len(places.findall(text))
        for match in as_prose.finditer(text):
            hits.append((path.relative_to(REPO).as_posix(), match.start(), len(match.group(0))))
    return hits, files, identifiers, place_hits


def main() -> int:
    labels = CL.client_labels()
    if len(labels) < 4:
        print("BUNDLE LABELS: DISCOVERY BROKEN — only %d client label(s) derived" % len(labels))
        return 2
    if not DIST.is_dir():
        print("BUNDLE LABELS: NOTHING TO SCAN — dist/ is absent; run `npm run build` first. "
              "A scan of nothing is not a pass.")
        return 2
    hits, files, identifiers, place_hits = scan(DIST, labels)
    print("GATE-WORK bundle-labels files=%d labels=%d identifiers=%d places=%d"
          % (files, len(labels), identifiers, place_hits))
    if files < 50:
        print("BUNDLE LABELS: DISCOVERY BROKEN — only %d text file(s) under dist/" % files)
        return 2
    if hits:
        print("BUNDLE LABELS: FAIL — a real book's label is in the production bundle (%d place(s)):"
              % len(hits))
        # The label itself is not printed: a log is not the place for it.
        for rel, offset, length in hits[:20]:
            print("  %s at character %d (%d characters long)" % (rel, offset, length))
        print("  Find the string in the source (a comment inside a template literal ships; a "
              "TypeScript comment does not) and remove it there.")
        return 1
    print("BUNDLE LABELS: PASS — %d file(s) under dist/ carry no client label "
          "(%d identifier match(es) and %d place-name match(es) are not prose)"
          % (files, identifiers, place_hits))
    return 0


if __name__ == "__main__":
    sys.exit(main())
