#!/usr/bin/env python3
"""Build src/engine/data/ro_sector_benchmarks.json from the REAL Ministry
of Finance annual-filings mass files (data.gov.ro, CC-BY-4.0).

  python scripts/build_ro_sector_benchmarks.py \\
      --manifest src/engine/benchmarks_ro/sources_fy2024.json \\
      --filings-dir <dir holding the downloaded files> \\
      --out src/engine/data/ro_sector_benchmarks.json

The manifest names each file, its CKAN dataset/resource, its license and
its sha256; a file whose bytes do not match the manifest aborts the
build. Reading goes through engine.public_ro (spec resolution, strict
parser, license gate). The mass files never enter git — only the small
aggregate does, under a provenance header.

Deterministic: same input bytes -> same output bytes. No clock, no
hash(), sorted keys. ``--slice-out DIR`` also writes the rows of the
requested CAEN classes (and their prior-year rows, by CUI) as small
files in the mass-file format — that is how the committed test slice
under tests/engine/fixtures/benchmarks_ro/ was cut from the real bytes.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

REPO = Path(__file__).resolve().parents[1]
if str(REPO / "src") not in sys.path:
    sys.path.insert(0, str(REPO / "src"))

from engine.benchmarks_ro import build as B  # noqa: E402
from engine.benchmarks_ro import definitions as D  # noqa: E402
from engine.benchmarks_ro.dataset import validate  # noqa: E402


def _dump(dataset: Dict[str, Any]) -> bytes:
    return (json.dumps(dataset, indent=1, sort_keys=True,
                       ensure_ascii=True) + "\n").encode("ascii")


def build_from_manifest(manifest: Dict[str, Any], filings_dir: Path,
                        manifest_label: str,
                        slice_out: Optional[Path] = None) -> Dict[str, Any]:
    year = int(manifest["year"])
    prior_year = manifest.get("prior_year")
    caen4 = [D.normalize_caen(c) for c in manifest["caen4"]]
    files = sorted(manifest["files"],
                   key=lambda f: (-int(f["year"]), f["family"]))
    by_year: Dict[int, List[Dict[str, Any]]] = {}
    header: List[Dict[str, Any]] = []
    raw_lines: Dict[str, Dict[int, str]] = {}
    for spec in files:
        data = (filings_dir / spec["file"]).read_bytes()
        spec_bytes = (filings_dir / spec["spec"]).read_bytes()
        rows, stats = B.read_family(
            data, spec_bytes.decode("utf-8"), year=int(spec["year"]),
            family=spec["family"], license_id=spec["license_id"],
            expected_sha256=spec["sha256"])
        seen = {r["cui"] for r in by_year.get(int(spec["year"]), [])}
        clash = [r["cui"] for r in rows if r["cui"] in seen]
        if clash:
            raise B.BuildError(
                "FY%s: %d CUIs appear in more than one family (first %s)"
                % (spec["year"], len(clash), clash[0]))
        by_year.setdefault(int(spec["year"]), []).extend(rows)
        header.append({
            "year": int(spec["year"]), "family": spec["family"],
            "dataset_slug": spec["dataset_slug"],
            "dataset_id": spec["dataset_id"],
            "resource_id": spec["resource_id"],
            "resource_url": spec["resource_url"],
            "license_id": spec["license_id"],
            "file_sha256": stats["file_sha256"],
            "spec_sha256": B.sha256_hex(spec_bytes),
            "row_count": stats["row_count"],
        })
        if slice_out is not None:
            text = data.decode("ascii").splitlines()
            raw_lines[spec["file"]] = {
                int(line.split(",", 1)[0]): line for line in text[1:] if line}
            raw_lines[spec["file"] + "#header"] = {0: text[0]}

    prior_map: Optional[Dict[int, int]] = None
    if prior_year is not None:
        prior_map = {}
        for row in by_year.get(int(prior_year), []):
            turnover = row["ind"].get("i13")
            if turnover is not None:  # absent stays absent
                prior_map[row["cui"]] = turnover

    sectors, counts = B.build_sectors(
        by_year[year], year=year, caen4=caen4,
        prior_turnover_by_cui=prior_map,
        prior_year=int(prior_year) if prior_year is not None else None)
    labels = manifest.get("sector_labels") or {}
    for key, entry in sectors.items():
        if key in labels:
            entry["label"] = labels[key]

    if slice_out is not None:
        _write_slice(slice_out, manifest, by_year, caen4, year, raw_lines)

    provenance = {
        "publisher": manifest["publisher"],
        "license": D.LICENSE,
        "citation": D.source_label((year,)),
        "caen_revision": manifest.get("caen_revision"),
        "datasets": header,
        "counts": counts,
        "manifest": manifest_label,
        "build_command": (
            "python scripts/build_ro_sector_benchmarks.py --manifest %s "
            "--filings-dir <dir> --out src/engine/data/"
            "ro_sector_benchmarks.json" % manifest_label),
        "reader": "engine.public_ro (specs.resolve_spec, "
                  "ingest.parse_bilant, ingest.derive_fields, "
                  "ingest.check_license)",
        "method": {
            "arithmetic": "decimal, precision 28, round half even; "
                          "fractions to 6 places, days to 2",
            "percentile": "linear interpolation between closest ranks",
            "peer_set": "every filer in families UU and BL with a positive "
                        "filed net turnover (I13) in the sector for the "
                        "year; the subject company, if it filed there, is "
                        "included",
            "per_ratio_drop": "a row with an absent operand or a "
                              "non-positive denominator is dropped from "
                              "that ratio only and counted; nothing is "
                              "imputed, an empty field is never zero",
            "total_assets": "I1 + I2 + I6, all three required",
            "natural_person_forms": "absent by construction: families UU "
                                    "and BL are 'societati comerciale' per "
                                    "the portal's description file; any "
                                    "other family is refused",
            "invalid_rows": "the strict reader aborts the build on any "
                            "malformed row; none are skipped quietly",
        },
    }
    return validate(B.assemble_dataset(
        year=year, prior_year=prior_year, sectors=sectors,
        provenance=provenance))


def _write_slice(out_dir: Path, manifest: Dict[str, Any],
                 by_year: Dict[int, List[Dict[str, Any]]],
                 caen4: List[str], year: int,
                 raw_lines: Dict[str, Dict[int, str]]) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    keep = {r["cui"] for r in by_year[year] if r["caen"] in caen4}
    for spec in manifest["files"]:
        lines = raw_lines[spec["file"]]
        body = [lines[c] for c in sorted(lines) if c in keep]
        text = "\r\n".join([raw_lines[spec["file"] + "#header"][0]] + body)
        (out_dir / spec["file"]).write_bytes((text + "\r\n").encode("ascii"))


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--manifest", required=True, type=Path)
    ap.add_argument("--filings-dir", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--slice-out", type=Path, default=None)
    args = ap.parse_args(argv)
    manifest = json.loads(args.manifest.read_text("utf-8"))
    try:
        label = str(args.manifest.resolve().relative_to(REPO))
    except ValueError:
        label = args.manifest.name
    dataset = build_from_manifest(manifest, args.filings_dir, label,
                                  args.slice_out)
    payload = _dump(dataset)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(payload)
    print("wrote %s  %d bytes  sha256 %s"
          % (args.out, len(payload), B.sha256_hex(payload)))
    for key, entry in dataset["sectors"].items():
        for band, cell in entry["cells"].items():
            print("  %s %-9s n_companies=%d"
                  % (key, band, cell["n_companies"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
