#!/usr/bin/env python3
"""ENGINE PROOF — the one generated source every accuracy number on the
public pages reads from (frontend/data/engineProof.json).

WHY THIS FILE EXISTS
  The landing page said "eight calibration fixtures" in one sentence and
  "9 / 9" in the block beside it. Both were typed by hand on 2026-09-08,
  they count different things (eight books whose balance sheet closes;
  nine file PATHS re-run five times, which are five distinct books), and
  neither carried a date or the list of what was checked. The first
  public review (2026-10-01) read the mismatch as the product not knowing
  its own numbers — which, on that page, was true.

  So: no accuracy number on a public page is typed any more. This script
  RUNS the checks, counts DISTINCT real books (never file paths), and
  writes the counts with the date they were measured. The landing block
  and the FAQ render from the JSON (frontend/lib/engineProof.ts); the gate
  `landing-proof` reds on a printed number that is not in it, on a numeric
  literal in the accuracy copy, and on a JSON whose engine identity is not
  the tree's (a stale proof). `engine-proof` (tests/engine/
  test_engine_proof.py) re-runs this script and compares.

WHAT IT MEASURES — each with the script or gate that owns the check
  rerun_identical        scripts/verify_determinism.py's roster through
                         the production deterministic path, RUNS times
                         each, byte-compared; books counted by the numeric
                         content of their rows, so a committed copy and
                         its local twin are ONE book. Plus the corpus
                         replay (scripts/corpus_replay.py): every case's
                         five artifacts against its stored result.
  balance_sheet_closes   the SERVED canonical balance sheet through the
                         full deterministic path (measure_bs_drift's
                         closing-identity roster): books at exactly 0.00,
                         books whose source imbalance is surfaced. The
                         older drift percentage rides along as a secondary
                         figure with its worst case.
  net_income_equals_121  every real corpus book carrying account 121,
                         through the real write path and the real
                         GET /api/period route (the net-income-anchor
                         gate's own harness): served statutory net income
                         against the account-121 closing balance.
  turnover_equals_filing engine net turnover against the figure filed
                         with the Ministry of Finance — ONLY for books
                         whose trial balance is the filed year. Every
                         other real book is counted as not checkable,
                         never claimed.
  ebitda_variants_agree  scripts/check_methodology_parity.py: reported /
                         strict / cash EBITDA, the written methodology
                         against the code, within its tolerance.
  counts                 listings in the bundled Bucharest Stock Exchange
                         universe and how many carry any financial figure.

THE PUBLIC FILE NAMES NO COMPANY AND CARRIES NO COMPANY'S FIGURE
  Counts, a tolerance, a date, and the largest difference observed. The
  filed turnover figures below are public Ministry-of-Finance data and are
  keyed by the fixture labels this repository already uses; they never
  leave this script.

SCOPE
  A full proof needs the local calibration books under files/ (they are
  client trial balances and are not committed). Without them this script
  REFUSES to write the public file: a proof over the committed subset
  would silently shrink every count. `--check` on such a checkout
  re-measures what the committed corpus can carry (the engine identity,
  the rerun and replay counts, account 121, the listing counts), compares
  those to the committed file, and says in plain words which checks it
  could not re-measure.

Usage
  python scripts/build_engine_proof.py            # measure, write the JSON
  python scripts/build_engine_proof.py --check    # measure, compare, write nothing
  python scripts/build_engine_proof.py --identity # print the engine identity only

Exit codes: 0 written / in agreement · 1 a check failed or the committed
file disagrees · 2 the full proof cannot be measured on this checkout.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import io
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

REPO = Path(__file__).resolve().parents[1]
SRC = REPO / "src"
for _p in (SRC, REPO / "scripts", REPO / "tests" / "engine"):
    if _p.is_dir() and str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

OUT = REPO / "frontend" / "data" / "engineProof.json"
SCHEMA = "engine_proof/1"

#: The directories whose bytes ARE the engine a proof speaks for. A change
#: under either makes the committed proof stale until it is re-measured.
IDENTITY_ROOTS: Tuple[str, ...] = ("src/engine", "packs")
_IDENTITY_SKIP_DIRS = frozenset({"__pycache__", ".pytest_cache", ".mypy_cache"})
_IDENTITY_SKIP_SUFFIXES = (".pyc", ".pyo")
_IDENTITY_SKIP_NAMES = frozenset({".DS_Store"})

#: Net turnover as FILED with the Ministry of Finance (public record), for
#: the books whose trial balance is the filed year-end close. Keyed by the
#: fixture labels the proof scripts already use. Whole RON, as published.
#: A book not listed here is a preliminary close or has no filed figure on
#: hand: it is counted as NOT CHECKABLE, never as agreeing.
FILED_TURNOVER_RON: Dict[str, int] = {
    "corpus_carniprod": 94_509_940,
    "corpus_retail": 79_018_307,
    "EEI": 2_727_104,
}
FILED_TURNOVER_TOLERANCE_RON = 1.0


#: Reader ids → the neutral layout names the public file prints. A reader
#: id that is not listed here is a new input lane: the proof refuses to
#: guess what to call it.
PUBLIC_LAYOUT_NAMES: Dict[str, str] = {
    "saga_10_col": "xlsx_10_column_layout",
    "pdf_positional": "pdf_positional_layout",
}

#: fingerprint → reader id, for every real book this run read from a file.
_FORMATS: Dict[str, str] = {}


def _note_format(fp: str, assembled_or_cbs: Dict[str, Any]) -> None:
    cbs = assembled_or_cbs.get("canonical_bs") or assembled_or_cbs
    fmt = ((cbs.get("extraction") or {}).get("source_format"))
    if isinstance(fmt, str) and fmt:
        _FORMATS[fp] = fmt


class ProofError(Exception):
    """A check ran and did not hold — the proof must not be written."""


class ScopeError(Exception):
    """The full proof cannot be measured on this checkout."""


# ── engine identity ────────────────────────────────────────────────────


def identity_files() -> List[Path]:
    out: List[Path] = []
    for root in IDENTITY_ROOTS:
        base = REPO / root
        if not base.is_dir():
            raise ScopeError("identity root missing: %s" % root)
        for p in base.rglob("*"):
            if not p.is_file():
                continue
            rel_parts = p.relative_to(REPO).parts
            if any(part in _IDENTITY_SKIP_DIRS for part in rel_parts):
                continue
            if p.name in _IDENTITY_SKIP_NAMES or p.name.endswith(_IDENTITY_SKIP_SUFFIXES):
                continue
            out.append(p)
    return sorted(out, key=lambda q: q.relative_to(REPO).as_posix())


def tree_sha256() -> Tuple[str, int]:
    """sha256 over "<posix path>\\0<sha256 of the file>\\n" for every file
    under IDENTITY_ROOTS, in path order. frontend/lib/__tests__/
    landingProof.test.tsx computes the same digest in Node — change one,
    change both."""
    h = hashlib.sha256()
    files = identity_files()
    for p in files:
        rel = p.relative_to(REPO).as_posix()
        h.update(rel.encode("utf-8"))
        h.update(b"\0")
        h.update(hashlib.sha256(p.read_bytes()).hexdigest().encode("ascii"))
        h.update(b"\n")
    return h.hexdigest(), len(files)


def engine_identity() -> Dict[str, Any]:
    from engine.country_packs.ro_romania import chart_of_accounts as coa
    from engine.country_packs.ro_romania import trial_balance_parser as tbp

    digest, n = tree_sha256()
    return {
        "parser_version": tbp.PARSER_VERSION,
        "ebitda_definition": coa.EBITDA_DEFINITION_REVISION,
        "tree_roots": list(IDENTITY_ROOTS),
        "tree_files": n,
        "tree_sha256": digest,
    }


# ── helpers ────────────────────────────────────────────────────────────


def _quiet():
    return contextlib.redirect_stdout(io.StringIO())


def book_fingerprint(rows: Iterable[Any]) -> str:
    """A book's identity by the NUMBERS in its rows — account labels are
    scrambled in the committed copies, the figures are not. Two paths
    with the same fingerprint are one book and are counted once."""
    def nums(r: Any) -> Tuple[float, ...]:
        d = r if isinstance(r, dict) else getattr(r, "__dict__", {})
        return tuple(
            round(float(v), 2) for k, v in sorted(d.items())
            if isinstance(v, (int, float)) and not isinstance(v, bool)
        )
    payload = json.dumps(sorted(nums(r) for r in rows))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _accounts_fingerprint(accounts: Iterable[Dict[str, Any]]) -> str:
    """The same idea for the one book that exists only as an extraction
    (no source file): fingerprint its amounts."""
    payload = json.dumps(sorted(
        tuple(round(float(v), 2) for k, v in sorted(a.items())
              if isinstance(v, (int, float)) and not isinstance(v, bool))
        for a in accounts
    ))
    return "x:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _pack():
    import engine.country_packs.ro_romania  # noqa: F401 — registers RomaniaPack
    from engine.core.country_pack_registry import get_pack
    return get_pack("RO")


#: The one book that exists only as an extraction (no source file): its
#: label in the drift script, which is also its key in FILED_TURNOVER_RON.
EXTRACTION_ONLY = "EEI"


def _drift_loaders(D: Any) -> List[Tuple[str, Any]]:
    """The drift script's roster, read off the script — its labels and its
    `load_<label>` functions — so this file lists no book of its own."""
    out = []
    for short in D._PER_FIXTURE_THRESHOLD:
        loader = getattr(D, "load_%s" % short.lower(), None)
        if loader is None:
            raise ProofError("measure_bs_drift has no loader for %r" % short)
        out.append((short, loader))
    return out


# ── (a) the same file gives the same output ────────────────────────────


def check_rerun() -> Tuple[Dict[str, Any], Dict[str, str]]:
    import corpus_replay
    import verify_determinism as V

    pack = _pack()
    books: Dict[str, bool] = {}
    by_label: Dict[str, str] = {}
    paths = 0
    for path, label, _expected, required in V.FIXTURES:
        if not path.is_file():
            if required:
                raise ProofError("required determinism fixture missing: %s" % label)
            continue
        paths += 1
        content = path.read_bytes()
        dumps: List[str] = []
        rows = None
        for _ in range(V.RUNS):
            with _quiet():
                tb_rows, _shaped, assembled = pack.run_deterministic_tb(content, path.name)
            rows = rows if rows is not None else tb_rows
            env = assembled.get("assembled_canonical_v1")
            if not isinstance(env, dict) or "canonical_bs" not in env:
                raise ProofError("[%s] no canonical envelope emitted" % label)
            dumps.append(json.dumps(env, sort_keys=True, ensure_ascii=False))
        fp = book_fingerprint(rows)
        by_label[label] = fp
        _note_format(fp, assembled["assembled_canonical_v1"])
        identical = all(d == dumps[0] for d in dumps[1:])
        books[fp] = books.get(fp, True) and identical

    cases = corpus_replay.discover_cases(corpus_replay.DEFAULT_CORPUS)
    real = constructed = replay_ok = 0
    for case_dir in cases:
        meta = corpus_replay._load_meta(case_dir)
        if bool(meta.get("synthetic")):
            constructed += 1
        else:
            real += 1
        with _quiet():
            failures = corpus_replay.run_case(case_dir, update=False)
        if not failures:
            replay_ok += 1

    result = {
        "runs_per_book": V.RUNS,
        "books_identical": sum(1 for ok in books.values() if ok),
        "paths_examined": paths,
        "replay_cases": len(cases),
        "replay_cases_real_books": real,
        "replay_cases_constructed": constructed,
        "replay_cases_identical": replay_ok,
        "replay_artifacts_per_case": len(corpus_replay.EXPECTED_ARTIFACTS),
    }
    check = {
        "id": "rerun_identical",
        "what_en": "The same file, analysed again, gives byte-identical output.",
        "what_ro": "Același fișier, analizat din nou, dă un rezultat identic octet cu octet.",
        "how": ("scripts/verify_determinism.py (battery gate: determinism) and "
                "scripts/corpus_replay.py (battery gate: corpus-replay)"),
        "subjects": len(books),
        "subjects_kind": "distinct real books",
        "result": result,
        "passed": (len(books) > 0
                   and result["books_identical"] == len(books)
                   and replay_ok == len(cases) and len(cases) > 0),
        "corpus_complete": True,
    }
    return check, by_label


# ── (b) the balance sheet closes ───────────────────────────────────────


def check_balance(full: bool) -> Tuple[Optional[Dict[str, Any]], Dict[str, str]]:
    if not full:
        return None, {}
    import measure_bs_drift as D

    pack = _pack()
    fps: Dict[str, str] = {}
    exact = surfaced = 0
    seen: set = set()
    for label, rel, expected_diff, expected_status in D._CANONICAL_IDENTITY_EXPECTED:
        candidates = D._candidate_paths("files/%s" % rel, "tests/fixtures/%s" % rel)
        if not candidates:
            raise ScopeError("closing-identity fixture absent: %s" % label)
        with _quiet():
            tb_rows, _shaped, assembled = pack.run_deterministic_tb(
                candidates[0].read_bytes(), candidates[0].name)
        cbs = assembled["assembled_canonical_v1"]["canonical_bs"]
        diff = float(cbs.get("difference"))
        status = str(cbs.get("status"))
        identity = (cbs.get("invariants") or {}).get("identity_holds")
        if identity is not True:
            raise ProofError("[%s] the closing identity does not hold" % label)
        if diff != expected_diff or status != expected_status:
            raise ProofError("[%s] served balance moved off its locked value" % label)
        fp = book_fingerprint(tb_rows)
        fps[label] = fp
        _note_format(fp, cbs)
        if fp in seen:
            continue
        seen.add(fp)
        if status == "BALANCED" and diff == 0.0:
            exact += 1
        elif status in ("MATERIAL_IMBALANCE", "MINOR_DRIFT") and diff != 0.0:
            # Surfaced: the served statement carries the imbalance status
            # and the difference to the cent — it is not smoothed to zero.
            surfaced += 1
        else:
            raise ProofError("[%s] neither closes nor surfaces an imbalance" % label)

    # Secondary figure — the older assembler's own balance gap as a share
    # of total assets. Kept only so the worst case is stated.
    drift: Dict[str, float] = {}
    ro_coa = D._load_ro_coa()
    loaders = _drift_loaders(D)
    for short, loader in loaders:
        with _quiet():
            accts, name, sq = loader()
            if short == EXTRACTION_ONLY:
                fps[short] = _accounts_fingerprint(accts)
                accts = D._normalize_for_assembler(accts, ro_coa)
            pct = D.measure(name, accts, source_quality=sq)
        if pct is None:
            raise ProofError("[%s] drift could not be measured" % short)
        threshold = D._PER_FIXTURE_THRESHOLD.get(short, 0.5)
        if pct > threshold:
            raise ProofError("[%s] drift above its gate threshold" % short)
        drift[short] = float(pct)

    worst = max(drift.values())
    check = {
        "id": "balance_sheet_closes",
        "what_en": ("The balance sheet the product serves closes: assets equal equity plus "
                    "liabilities. Where the source file itself does not balance, the "
                    "difference is shown on the statement, not smoothed away."),
        "what_ro": ("Bilanțul afișat de produs se închide: activele sunt egale cu "
                    "capitalurile proprii plus datoriile. Acolo unde fișierul-sursă nu se "
                    "echilibrează, diferența este afișată pe situație, nu netezită."),
        "how": "scripts/measure_bs_drift.py, closing-identity table (battery gate: bs-drift)",
        "subjects": len(seen),
        "subjects_kind": "distinct real books with a source file",
        "result": {
            "books_closing_exactly": exact,
            "exact_difference_ron": 0.0,
            "books_imbalance_surfaced": surfaced,
            "legacy_drift_books": len(drift),
            "legacy_drift_worst_pct": round(worst, 4),
        },
        "passed": exact + surfaced == len(seen) and exact > 0,
        "corpus_complete": False,
    }
    return check, fps


# ── (c) net income is account 121 · (e) turnover is the filing ─────────


def _served_real_books() -> List[Dict[str, Any]]:
    """Every REAL corpus book that carries account 121, through the real
    write path and the real GET /api/period route (the anchor gate's
    harness — imported, not copied)."""
    import corpus_replay
    import test_rebuild_net_income_anchor as A
    import _served_books as S

    pack = _pack()
    out: List[Dict[str, Any]] = []
    for case_id, case_dir, p121_golden in A.ANCHOR_CASES:
        meta = corpus_replay._load_meta(case_dir)
        if bool(meta.get("synthetic")):
            continue
        with _quiet(), contextlib.redirect_stderr(io.StringIO()):
            bk = A._book(case_id, case_dir)
            body = S.routed_body(bk)
            input_path = corpus_replay._input_path(case_dir)
            rows = pack.parse_trial_balance(input_path.read_bytes(), input_path.name)
            anchor = pack.compute_statutory_net_profit_anchor(rows)
        pl = (body.get("statements") or {}).get("assembled_pl") or {}
        _note_format(book_fingerprint(rows),
                     (body.get("statements") or {}).get("canonical_bs") or {})
        out.append({
            "case": case_id,
            "fingerprint": book_fingerprint(rows),
            "p121_golden": float(p121_golden),
            "p121_engine": None if anchor is None else float(anchor),
            "net_income": pl.get("net_income_statutory"),
            "anchor_status": pl.get("net_income_anchor_status"),
            "turnover": pl.get("turnover"),
        })
    return out


def check_net_income(served: List[Dict[str, Any]]) -> Dict[str, Any]:
    equal = 0
    for b in served:
        ni = b["net_income"]
        if ni is None:
            continue
        if (abs(float(ni) - b["p121_golden"]) < 0.005
                and b["p121_engine"] is not None
                and abs(b["p121_engine"] - b["p121_golden"]) < 0.005):
            equal += 1
    return {
        "id": "net_income_equals_121",
        "what_en": ("Net income shown equals the closing balance of account 121 — the "
                    "statutory result — to the cent. The result rebuilt from classes 6 "
                    "and 7 is printed beside it, with any gap."),
        "what_ro": ("Rezultatul net afișat este egal, la ban, cu soldul final al contului "
                    "121 — rezultatul statutar. Rezultatul reconstruit din clasele 6 și 7 "
                    "este afișat alături, împreună cu orice diferență."),
        "how": ("tests/engine/test_rebuild_net_income_anchor.py "
                "(battery gate: net-income-anchor-witness)"),
        "subjects": len(served),
        "subjects_kind": "distinct real books carrying account 121",
        "result": {"books_equal_to_the_cent": equal},
        "passed": len(served) > 0 and equal == len(served),
        "corpus_complete": True,
    }


def check_turnover(full: bool, served: List[Dict[str, Any]],
                   all_books: int) -> Optional[Dict[str, Any]]:
    if not full:
        return None
    import measure_bs_drift as D

    measured: Dict[str, float] = {}
    for b in served:
        key = "corpus_" + b["case"].replace("saga_10_col_", "")
        if key in FILED_TURNOVER_RON and b["turnover"] is not None:
            measured[key] = float(b["turnover"])
    if EXTRACTION_ONLY in FILED_TURNOVER_RON:
        with _quiet():
            accts, _name, _sq = D.load_eei()
            ro_coa = D._load_ro_coa()
            res = ro_coa.assemble_statements(
                D._normalize_for_assembler(accts, ro_coa),
                company_name="proof", currency="RON", period_label="FY2025")
        tv = ((res.get("statements") or {}).get("assembled_pl") or {}).get("turnover")
        if tv is not None:
            measured[EXTRACTION_ONLY] = float(tv)

    missing = sorted(set(FILED_TURNOVER_RON) - set(measured))
    if missing:
        raise ProofError("no engine turnover for filed book(s): %s" % ", ".join(missing))
    diffs = {k: abs(measured[k] - FILED_TURNOVER_RON[k]) for k in FILED_TURNOVER_RON}
    within = sum(1 for d in diffs.values() if d <= FILED_TURNOVER_TOLERANCE_RON)
    return {
        "id": "turnover_equals_filing",
        "what_en": ("Net turnover equals the figure the company filed with the Ministry of "
                    "Finance — checked only where the trial balance is the filed year-end "
                    "close. Preliminary closes are not claimed."),
        "what_ro": ("Cifra de afaceri netă este egală cu cea depusă de companie la "
                    "Ministerul Finanțelor — verificat doar acolo unde balanța este "
                    "închiderea de an depusă. Închiderile preliminare nu sunt revendicate."),
        "how": ("scripts/build_engine_proof.py: engine net turnover against the published "
                "filing (public Ministry-of-Finance data); the same three periods agreed "
                "in production's reprocess dry run on 2026-10-01"),
        "subjects": len(FILED_TURNOVER_RON),
        "subjects_kind": "distinct real books whose trial balance is the filed year",
        "result": {
            "tolerance_ron": int(FILED_TURNOVER_TOLERANCE_RON),
            "books_within_tolerance": within,
            "max_abs_difference_ron": round(max(diffs.values()), 2),
            "books_not_checkable": all_books - len(FILED_TURNOVER_RON),
            "real_books_total": all_books,
        },
        "passed": within == len(FILED_TURNOVER_RON),
        "corpus_complete": False,
    }


# ── (d) the three EBITDA variants agree ────────────────────────────────


def check_ebitda(full: bool) -> Optional[Dict[str, Any]]:
    if not full:
        return None
    import check_methodology_parity as M
    import measure_bs_drift as D

    ro_coa = D._load_ro_coa()
    loaders = _drift_loaders(D)
    M.SERVED["n"] = 0
    M.SERVED["bridge"] = 0
    books = ok_count = 0
    for short, loader in loaders:
        with _quiet():
            accts, name, _sq = loader()
            if short == EXTRACTION_ONLY:
                accts = D._normalize_for_assembler(accts, ro_coa)
            result = ro_coa.assemble_statements(
                accts, company_name=name, currency="RON", period_label="FY2025",
                industry=None, **M._measured_kwargs(short))
            ok, _detail, _deltas = M._check_fixture(short, result)
        books += 1
        ok_count += 1 if ok else 0
    return {
        "id": "ebitda_variants_agree",
        "what_en": ("EBITDA is computed three named ways — reported, strict, cash. The "
                    "written methodology and the code agree on each, within the stated "
                    "tolerance. This is an internal consistency check, not a comparison "
                    "with a filing."),
        "what_ro": ("EBITDA se calculează în trei variante numite — raportat, strict, "
                    "cash. Metodologia scrisă și codul dau aceeași valoare pentru fiecare, "
                    "în toleranța indicată. Este o verificare de consecvență internă, nu o "
                    "comparație cu o raportare depusă."),
        "how": "scripts/check_methodology_parity.py",
        "subjects": books,
        "subjects_kind": "distinct real books",
        "result": {
            "tolerance_ron": int(M.TOLERANCE_RON),
            "variants": 3,
            "books_within_tolerance": ok_count,
            "books_via_account_121_bridge": int(M.SERVED["bridge"]),
        },
        "passed": books > 0 and ok_count == books and M.SERVED["bridge"] > 0,
        "corpus_complete": False,
    }


# ── counts the public pages print that are not accuracy checks ─────────


def public_counts() -> Dict[str, Any]:
    from engine.public import bvb_seed

    rows = bvb_seed.bvb_universe()
    fundamentals = ("revenue", "netIncome", "equity", "ebitda")
    with_any = sum(
        1 for r in rows.values()
        if any(r.get(k) is not None for k in fundamentals)
    )
    return {
        "bvb_listings": len(rows),
        "bvb_listings_with_financials": with_any,
        "how": "engine.public.bvb_seed.bvb_universe() — the bundled universe the page serves",
    }


def format_counts() -> Dict[str, Any]:
    """How many DISTINCT real books each input layout was read from."""
    out: Dict[str, int] = {}
    for fmt in _FORMATS.values():
        name = PUBLIC_LAYOUT_NAMES.get(fmt)
        if name is None:
            raise ProofError("reader id %r has no public layout name" % fmt)
        out[name] = out.get(name, 0) + 1
    return dict(sorted(out.items()))


# ── assemble, write, compare ───────────────────────────────────────────


def _full_scope_available() -> bool:
    import measure_bs_drift as D
    for _label, rel, _d, _s in D._CANONICAL_IDENTITY_EXPECTED:
        if not D._candidate_paths("files/%s" % rel, "tests/fixtures/%s" % rel):
            return False
    try:
        with _quiet():
            D.load_eei()
    except Exception:  # noqa: BLE001
        return False
    return True


def measure(full: bool, today: str) -> Dict[str, Any]:
    rerun, fp_rerun = check_rerun()
    served = _served_real_books()
    balance, fp_balance = check_balance(full)

    fingerprints = set(fp_rerun.values()) | {b["fingerprint"] for b in served}
    fingerprints |= set(fp_balance.values())
    all_books = len(fingerprints)

    checks: List[Dict[str, Any]] = [rerun]
    if balance is not None:
        checks.append(balance)
    checks.append(check_net_income(served))
    turnover = check_turnover(full, served, all_books)
    if turnover is not None:
        checks.append(turnover)
    ebitda = check_ebitda(full)
    if ebitda is not None:
        checks.append(ebitda)

    for c in checks:
        c["measured_at"] = today
    return {
        "schema": SCHEMA,
        "generated_by": "scripts/build_engine_proof.py",
        "measured_at": today,
        "scope": "full" if full else "committed_corpus_only",
        "subjects_note": ("Subjects are DISTINCT real Romanian trial balances, counted by "
                          "the content of their rows — a committed copy and its local twin "
                          "are one book. No company is named and no company's figure is "
                          "published here."),
        "real_books_total": all_books if full else None,
        "engine": engine_identity(),
        "checks": checks,
        "formats": format_counts() if full else None,
        "counts": public_counts(),
    }


def _strip_dates(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: _strip_dates(v) for k, v in obj.items() if k != "measured_at"}
    if isinstance(obj, list):
        return [_strip_dates(v) for v in obj]
    return obj


def _dump(doc: Dict[str, Any]) -> str:
    return json.dumps(doc, indent=2, ensure_ascii=False) + "\n"


def _field_diffs(prefix: str, a: Any, b: Any, out: List[str]) -> None:
    """Name the FIELD that differs — "checks.balance_sheet_closes.result.
    books_closing_exactly: committed 7 != measured 6" — not a 300-character
    slice of two documents a reader has to diff by eye."""
    if isinstance(a, dict) and isinstance(b, dict):
        for key in sorted(set(a) | set(b)):
            _field_diffs("%s.%s" % (prefix, key) if prefix else str(key),
                         a.get(key), b.get(key), out)
    elif a != b:
        out.append("%s: committed %s != measured %s" % (
            prefix, json.dumps(a, ensure_ascii=False)[:160],
            json.dumps(b, ensure_ascii=False)[:160]))


def _by_check_id(doc: Dict[str, Any]) -> Dict[str, Any]:
    """The same document with `checks` keyed by id, so a diff names a check."""
    out = dict(doc)
    out["checks"] = {c["id"]: c for c in doc.get("checks", [])}
    return out


def _rel(path: Path) -> str:
    try:
        return path.resolve().relative_to(REPO.resolve()).as_posix()
    except ValueError:
        return str(path)


def compare(measured: Dict[str, Any], committed: Dict[str, Any], full: bool) -> List[str]:
    problems: List[str] = []
    if full:
        a, b = _strip_dates(committed), _strip_dates(measured)
        if a != b:
            _field_diffs("", _by_check_id(a), _by_check_id(b), problems)
            if [c["id"] for c in a.get("checks", [])] != [c["id"] for c in b.get("checks", [])]:
                problems.append("checks: the order or the set of checks differs")
        return problems

    if committed.get("engine") != measured.get("engine"):
        problems.append("engine identity: committed %s != this tree %s" % (
            (committed.get("engine") or {}).get("tree_sha256"),
            (measured.get("engine") or {}).get("tree_sha256")))
    if committed.get("counts") != measured.get("counts"):
        problems.append("counts: committed %s != measured %s" % (
            committed.get("counts"), measured.get("counts")))
    by_id = {c["id"]: c for c in committed.get("checks", [])}
    for c in measured["checks"]:
        if not c.get("corpus_complete"):
            continue
        want = _strip_dates(by_id.get(c["id"]) or {})
        got = _strip_dates(c)
        if c["id"] == "rerun_identical":
            # paths_examined counts the local twins too; the BOOKS do not.
            want = dict(want, result=dict(want.get("result") or {}, paths_examined=None))
            got = dict(got, result=dict(got.get("result") or {}, paths_examined=None))
        if want != got:
            problems.append("%s: committed %s != measured %s" % (
                c["id"], json.dumps(want, ensure_ascii=False)[:300],
                json.dumps(got, ensure_ascii=False)[:300]))
    return problems


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--check", action="store_true",
                    help="measure and compare with the committed file; write nothing")
    ap.add_argument("--identity", action="store_true",
                    help="print the engine identity and exit")
    ap.add_argument("--out", default=str(OUT))
    args = ap.parse_args(argv)

    if args.identity:
        print(json.dumps(engine_identity(), indent=2))
        return 0

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    full = _full_scope_available()
    try:
        if not full and not args.check:
            raise ScopeError(
                "the local calibration books (files/) are not on this checkout, so the "
                "full proof cannot be measured. Refusing to write a proof over the "
                "committed subset — every count would silently shrink. Run with "
                "--check to compare what the committed corpus can carry.")
        measured = measure(full, today)
    except ScopeError as exc:
        print("ENGINE PROOF: NOT MEASURED — %s" % exc)
        return 2
    except ProofError as exc:
        print("ENGINE PROOF: FAIL — %s" % exc)
        return 1

    failed = [c["id"] for c in measured["checks"] if not c["passed"]]
    for c in measured["checks"]:
        print("  %-24s subjects=%-2s %s  %s" % (
            c["id"], c["subjects"], "PASS" if c["passed"] else "FAIL",
            json.dumps(c["result"], ensure_ascii=False)))
    print("  formats                  %s" % json.dumps(measured["formats"]))
    print("  counts                   %s" % json.dumps(
        {k: v for k, v in measured["counts"].items() if k != "how"}))
    print("  engine                   %s · %d files · %s" % (
        measured["engine"]["parser_version"], measured["engine"]["tree_files"],
        measured["engine"]["tree_sha256"][:16]))
    units = sum(int(c["subjects"]) for c in measured["checks"])
    print("GATE-WORK engine-proof checks=%d subjects=%d scope=%s" % (
        len(measured["checks"]), units, measured["scope"]))
    if failed:
        print("ENGINE PROOF: FAIL — %s did not hold; nothing written." % ", ".join(failed))
        return 1

    out = Path(args.out)
    if args.check:
        if not out.is_file():
            print("ENGINE PROOF: FAIL — %s is not committed." % _rel(out))
            return 1
        committed = json.loads(out.read_text(encoding="utf-8"))
        problems = compare(measured, committed, full)
        if not full:
            skipped = [c["id"] for c in committed.get("checks", [])
                       if c["id"] not in {m["id"] for m in measured["checks"]}]
            print("  NOT RE-MEASURED here (the local calibration books are absent): %s"
                  % (", ".join(skipped) or "none"))
        if problems:
            print("ENGINE PROOF: FAIL — the committed proof is not what this tree measures:")
            for p in problems:
                print("    ✗ %s" % p)
            print("  Re-measure with: python scripts/build_engine_proof.py")
            return 1
        print("ENGINE PROOF: IN AGREEMENT — %s (%s)" % (
            _rel(out), "every check re-measured" if full
            else "identity, rerun, account 121 and counts re-measured"))
        return 0

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(_dump(measured), encoding="utf-8")
    print("ENGINE PROOF: WRITTEN — %s, measured %s (scope %s)" % (
        _rel(out), today, measured["scope"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
