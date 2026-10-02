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
  Every file under dist/ (the build `npm run build` leaves; this gate runs
  after `npm-build` in the battery) that can carry a word:
    · text — .js / .css / .html / .json / .webmanifest / .txt / .xml / .svg /
      .map / .csv / .md: the raw bytes;
    · workbooks and other ZIP containers (.xlsx …): every member,
      decompressed, with its name — the sheets, the shared strings and the
      document properties;
    · PDFs: the text layer, the info dictionary, the XMP packet and the
      uncompressed objects
  (scripts/public_bytes.py, shared with `public-sample` S5). Until 2026-10-02
  it read text suffixes only: two spreadsheets under dist/templates named a
  client and the gate printed "PASS — 127 file(s)".
  The labels are derived at run time from the names of the real books the
  repository holds (scripts/client_labels.py) — never typed here.

WHAT IS NOT A LABEL IN A BUNDLE
  · a PLACE NAME that is also part of a fixture's file name: listed in
    PLACE_NAMES below with the reason — the listed-company map names the
    county a company sits in. Counted in the work line.
  NOTHING ELSE. Until 2026-10-02 a label glued to a hyphen was excused as "an
  identifier", which let "…measured on the <label>-Food pack" through, and
  excused 162 occurrences of a calibration book's label that shipped as a
  stylesheet namespace. The namespace is renamed (`--ctrl-*`,
  frontend/styles/controllerBoard.css) and the exemption is deleted: a label
  between two non-letters is a hit, hyphen or not.

WHAT IT REDS ON, now that the bundle is clean (TC-11): a client label in any
file under dist/ that it reads, in prose, in an identifier, in a workbook
cell or property, or in a PDF's text or metadata; a missing dist/ (a scan
of nothing is not a pass); fewer than 4 labels derived; fewer than 50 files
scanned; no workbook or no PDF among them.
WHAT IT CANNOT SEE: a client's name that is not in a fixture's file name; a
label inside an image, a font or a pre-compressed copy (.gz / .br — the same
bytes as the file beside them, which is read); a word split across two XML
runs of a workbook; the server-rendered storefront. A MINIFIED IDENTIFIER
that happens to spell a three-letter label is a red here, by design: the
position is printed and a person reads it.

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
import public_bytes as PB  # noqa: E402

DIST = REPO / "dist"
TEXT_SUFFIXES = (".js", ".css", ".html", ".json", ".webmanifest", ".txt", ".xml", ".svg", ".map",
                 ".csv", ".md")
CONTAINER_SUFFIXES = PB.ZIP_SUFFIXES + (".pdf",)

#: A fixture label that is ALSO a place name, where the bundle legitimately
#: names the place. Typed here because it is a town, not a client.
PLACE_NAMES: Dict[str, str] = {
    "sibiu": "a Romanian county and city — the listed-company map names the county a company sits in",
}


def scan(dist: Path, labels: List[str]) -> Tuple[List[Tuple[str, int, int]], Dict[str, int]]:
    """(hits [(file or part, offset, label length)], counts)."""
    counts = {"files": 0, "containers": 0, "parts": 0, "places": 0}
    wanted = [lab for lab in labels if lab not in PLACE_NAMES]
    if not wanted:
        return [], counts
    pattern = re.compile(r"(?<![A-Za-z])(%s)(?![A-Za-z])" % "|".join(map(re.escape, wanted)), re.I)
    places = re.compile(r"(?<![A-Za-z])(%s)(?![A-Za-z])" % "|".join(map(re.escape, PLACE_NAMES)), re.I)
    hits: List[Tuple[str, int, int]] = []
    for path in sorted(dist.rglob("*")):
        suffix = path.suffix.lower()
        if not path.is_file() or suffix not in TEXT_SUFFIXES + CONTAINER_SUFFIXES:
            continue
        rel = path.relative_to(REPO).as_posix()
        counts["files"] += 1
        if suffix in CONTAINER_SUFFIXES:
            counts["containers"] += 1
            parts = PB.parts(path, rel)
        else:
            parts = [(rel, path.read_text(encoding="utf-8", errors="replace"))]
        for name, text in parts:
            counts["parts"] += 1
            counts["places"] += len(places.findall(text))
            for match in pattern.finditer(text):
                hits.append((name, match.start(), len(match.group(0))))
    return hits, counts


def main() -> int:
    labels = CL.client_labels()
    if len(labels) < 4:
        print("BUNDLE LABELS: DISCOVERY BROKEN — only %d client label(s) derived" % len(labels))
        return 2
    if not DIST.is_dir():
        print("BUNDLE LABELS: NOTHING TO SCAN — dist/ is absent; run `npm run build` first. "
              "A scan of nothing is not a pass.")
        return 2
    hits, counts = scan(DIST, labels)
    print("GATE-WORK bundle-labels files=%d labels=%d containers=%d parts=%d places=%d"
          % (counts["files"], len(labels), counts["containers"], counts["parts"], counts["places"]))
    if counts["files"] < 50:
        print("BUNDLE LABELS: DISCOVERY BROKEN — only %d file(s) read under dist/" % counts["files"])
        return 2
    if counts["containers"] < 5:
        print("BUNDLE LABELS: DISCOVERY BROKEN — only %d workbook(s) / PDF(s) read under dist/; the "
              "published templates, examples and sample are not in the build" % counts["containers"])
        return 2
    if hits:
        print("BUNDLE LABELS: FAIL — a real book's label is in the production bundle (%d place(s)):"
              % len(hits))
        # The label itself is not printed: a log is not the place for it.
        for name, offset, length in hits[:20]:
            print("  %s at character %d (%d characters long)" % (name, offset, length))
        print("  Find the string in the source (a comment inside a template literal ships; a "
              "TypeScript comment does not; a workbook is regenerated by its script) and remove "
              "it there.")
        return 1
    print("BUNDLE LABELS: PASS — %d file(s) under dist/ carry no client label: %d workbook(s) and "
          "PDF(s) opened, %d part(s) read; no identifier is exempt (%d place-name match(es) are a "
          "town, not a client)"
          % (counts["files"], counts["containers"], counts["parts"], counts["places"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
