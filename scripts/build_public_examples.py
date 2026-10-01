#!/usr/bin/env python3
"""The dashboard's two downloadable EXAMPLE trial balances.

    public/examples/example_trial_balance_8col.xlsx   four Debit/Credit pairs
    public/examples/example_trial_balance_6col.xlsx   three Debitoare/Creditoare pairs

WHY THEY ARE GENERATED NOW. The two files were hand-made on 2026-06-22 and
were wrong in two ways a reader could see (verified 2026-10-01):

  · their title row said "EXEMPLU ANONIMIZAT - date fictive" — "anonymised"
    and "fictional" are different claims, and only the second was true;
  · the book did not hold together: account 121 closed at 360,000 while
    classes 6/7 made 113,000, so the engine anchored net profit to 121,
    raised a CRITICAL reconstruction-gap finding and graded the same book
    AAA. A user who uploaded the product's own example met a critical
    finding on first use.

Both files are now two layouts of ONE book — FY2025 of the fictional
company `scripts/build_public_sample_tb.py` writes (the public sample's
book: a double-entry ledger, closed into account 121). Same accounts, same
figures, two column layouts; "date fictive", never "anonimizat".

    .venv/bin/python scripts/build_public_examples.py
    .venv/bin/python scripts/build_public_examples.py --check

The copies under tests/fixtures/trial_balance/ are a test's own fixtures
and are deliberately left alone.

Python 3.9 — no ``match``, no ``X | Y``.
"""

from __future__ import annotations

import argparse
import sys
from collections import OrderedDict
from pathlib import Path
from typing import List, Optional

REPO = Path(__file__).resolve().parents[1]
if str(REPO / "scripts") not in sys.path:
    sys.path.insert(0, str(REPO / "scripts"))

import build_public_sample_tb as TB  # noqa: E402

EXAMPLES_DIR = REPO / "public" / "examples"
EXAMPLE_YEAR = 2025
FOUR_PAIR = "example_trial_balance_8col.xlsx"
COMPACT = "example_trial_balance_6col.xlsx"

#: The title row both files carry. Fictional — not "anonymised".
EXAMPLE_NOTICE_RO = "EXEMPLU FICTIV - date fictive, doar pentru demonstrarea formatului"


def example_files() -> "OrderedDict[str, bytes]":
    rows = TB.build_books()[EXAMPLE_YEAR]["rows"]
    return OrderedDict((
        (FOUR_PAIR, TB.write_workbook(EXAMPLE_YEAR, rows, notice=EXAMPLE_NOTICE_RO)),
        (COMPACT, TB.write_workbook(EXAMPLE_YEAR, rows, notice=EXAMPLE_NOTICE_RO, compact=True)),
    ))


def stale_files() -> List[str]:
    return [name for name, data in example_files().items()
            if not (EXAMPLES_DIR / name).is_file() or (EXAMPLES_DIR / name).read_bytes() != data]


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--check", action="store_true",
                        help="compare the committed files with a rebuild; write nothing")
    args = parser.parse_args(argv)
    if args.check:
        stale = stale_files()
        for name in stale:
            print("  FAIL public/examples/%s is not what a rebuild produces" % name, file=sys.stderr)
        print("public examples: %s" % ("STALE — run scripts/build_public_examples.py" if stale else "PASS"))
        return 1 if stale else 0
    EXAMPLES_DIR.mkdir(parents=True, exist_ok=True)
    for name, data in example_files().items():
        (EXAMPLES_DIR / name).write_bytes(data)
        print("wrote public/examples/%s (%d bytes)" % (name, len(data)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
