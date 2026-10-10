#!/usr/bin/env python3
"""The labels of the REAL books this repository holds — derived, never typed.

Two gates must be able to say "no client's label is in a file the public can
download" without the list of labels being written anywhere a reader of the
repository could copy it from:

  · `public-sample` S5 (tests/engine/test_public_sample.py) — the published
    sample files;
  · `bundle-labels` (scripts/check_bundle_labels.py) — the production bundle
    under dist/.

Both read the labels here, off the file and directory names of the real
books at run time: the corpus cases marked `synthetic: false`, the regression
baselines, the pack's real-workbook samples, and the books under `files/`
when the checkout has them. A baseline or workbook is named
`<label>_<period>…`, so its label is the words before the first digit.

Python 3.9 — no ``match``, no ``X | Y``.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import List

REPO = Path(__file__).resolve().parents[1]

#: Words in a fixture's file or directory name that are not a client's
#: label: layout names, statement words, period markers.
GENERIC = frozenset((
    "saga", "col", "pdf", "positional", "fy", "dec", "trial", "balance", "frozen",
    "realestate", "retail", "real", "estate", "prod", "analysis", "trading", "balanta",
    "verificare",
))
BOOK_SUFFIXES = (".xlsx", ".xls", ".pdf", ".csv")


def client_labels() -> List[str]:
    import yaml

    names: List[str] = []
    for meta in sorted((REPO / "corpus").glob("*/meta.yaml")):
        if yaml.safe_load(meta.read_text(encoding="utf-8")).get("synthetic") is False:
            names.append(re.sub(r"\d+", " ", meta.parent.name))
    fixtures = REPO / "src" / "engine" / "country_packs" / "ro_romania" / "fixtures"
    books = sorted((fixtures / "regression_baselines").glob("*.json"))
    books += sorted((fixtures / "saga_contsal_samples").glob("*"))
    if (REPO / "files").is_dir():
        books += [p for p in sorted((REPO / "files").iterdir())
                  if p.is_file() and p.suffix.lower() in BOOK_SUFFIXES]
    names += [re.split(r"\d", p.stem, maxsplit=1)[0] for p in books]
    labels = set()
    for name in names:
        for word in re.split(r"[^A-Za-z]+", name):
            if len(word) >= 3 and word.lower() not in GENERIC:
                labels.add(word.lower())
    return sorted(labels)
