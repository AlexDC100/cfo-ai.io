#!/usr/bin/env python3
"""Versioned reprocessing of stored production documents
(docs/CANONICAL_BS_V2_CONTRACT.md, "Reprocessing (requirement 3)").

For every active financial period with a stored source document, downloads
the original bytes from Supabase storage, re-runs the deterministic
extraction+assembly OFFLINE (`RomaniaPack.run_deterministic_tb` — the same
code object the pipeline and the determinism gate run; no LLM, no writes),
and diffs the new canonical totals against the stored envelope's totals.

Modes:
  · DRY-RUN (default) — read-only. Emits a per-document report
    (JSON + Markdown) to --out; prod data is never touched.
  · --apply — archives the old envelope under
    `assembled_canonical_v1.archives[]` (with its extraction / parser /
    mapping versions + timestamp), writes the new envelope, and stamps
    `canonical_bs.reprocessed = {changed, previous_totals}` so the FE can
    show the "figures updated by engine vX" note. NEVER a silent
    overwrite; NEVER applied without the explicit flag.

Skipped (reported, never guessed): deleted documents (row gone or
soft-deleted), missing storage objects, unsupported kinds (images/text —
LLM-only, not offline-reprocessable), and files the deterministic parser
rejects.

Scope note: --apply rewrites the ENVELOPE only (the canonical_bs
authority the FE renders verbatim). statement_line_items / metrics /
narratives are refreshed by a full pipeline re-run, which needs the live
backend — outside this offline tool per the contract.

Env: VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY /
SUPABASE_SERVICE_ROLE_KEY — read from the environment, else from the
repo-root .env.

Usage:
  python3 scripts/reprocess_documents.py                 # dry-run, all periods
  python3 scripts/reprocess_documents.py --org <uuid>    # one workspace
  python3 scripts/reprocess_documents.py --document <id> # one document
  python3 scripts/reprocess_documents.py --apply         # write mode
  python3 scripts/reprocess_documents.py --out /path/rep # report basename
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


# ── Repo-root + sys.path setup (same pattern as measure_bs_drift.py) ──


def _find_repo_root() -> Path:
    here = Path(__file__).resolve().parent
    for candidate in [here, *here.parents][:6]:
        if (candidate / "pyproject.toml").is_file():
            return candidate
    return Path(__file__).resolve().parent.parent


REPO = _find_repo_root()
SRC = REPO / "src"
if SRC.is_dir() and str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

import httpx  # noqa: E402

import engine.country_packs.ro_romania  # noqa: E402,F401 — registers RomaniaPack
from engine.core.country_pack_registry import get_pack  # noqa: E402


def _load_supabase_module():
    """Load engine/api/_supabase.py WITHOUT importing the engine.api
    package — its __init__ pulls server.py → sqlalchemy/fastapi, which
    this offline tool doesn't need (and dev machines may not have).
    _supabase.py itself is stdlib + httpx only."""
    path = SRC / "engine" / "api" / "_supabase.py"
    spec = importlib.util.spec_from_file_location("_supabase_standalone", path)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    # Must be registered BEFORE exec: dataclasses resolves the module's
    # postponed (string) annotations via sys.modules[cls.__module__].
    sys.modules["_supabase_standalone"] = mod
    spec.loader.exec_module(mod)
    return mod


def _load_dotenv_if_needed() -> None:
    """Populate the three Supabase vars from <repo>/.env when absent.
    Minimal KEY=VALUE parser; never overrides an existing env var."""
    needed = ("VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY")
    if all(os.environ.get(k) for k in needed):
        return
    env_path = REPO / ".env"
    if not env_path.is_file():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if k in needed and not os.environ.get(k):
            os.environ[k] = v


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _classify_kind(mime: str, name: str) -> str:
    """Mirror of pipeline._classify_file for the three offline-parseable
    kinds; everything else is LLM-only and reported as unsupported."""
    mime, name = (mime or "").lower(), (name or "").lower()
    if mime == "application/pdf" or name.endswith(".pdf"):
        return "pdf"
    if "spreadsheet" in mime or name.endswith((".xlsx", ".xls")):
        return "xlsx"
    if mime == "text/csv" or name.endswith(".csv"):
        return "csv"
    return "unsupported"


_TOTAL_KEYS = ("assets", "equity", "liabilities")


def _stored_totals(env: Optional[Dict[str, Any]]) -> Optional[Dict[str, float]]:
    """Old totals, canonical_bs first (bs_v2 envelopes), methodology
    fallback (legacy) — the same precedence the read path serves."""
    if not isinstance(env, dict):
        return None
    cbs = env.get("canonical_bs")
    if isinstance(cbs, dict) and isinstance(cbs.get("totals"), dict):
        t = cbs["totals"]
        if all(t.get(k) is not None for k in _TOTAL_KEYS):
            return {k: round(float(t[k]), 2) for k in _TOTAL_KEYS}
    mt = (env.get("methodology") or {}).get("totals") or {}
    legacy = {"assets": "total_assets", "equity": "total_equity",
              "liabilities": "total_liabilities"}
    if all(mt.get(v) is not None for v in legacy.values()):
        return {k: round(float(mt[v]), 2) for k, v in legacy.items()}
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--apply", action="store_true",
                    help="write mode: archive old envelope + persist the new one "
                         "(default is a read-only dry run)")
    ap.add_argument("--dry-run", action="store_true",
                    help="explicit dry-run (the default; kept for operator clarity)")
    ap.add_argument("--out", default="/private/tmp/reprocess_report",
                    help="report basename — writes <out>.json and <out>.md")
    ap.add_argument("--org", help="limit to one org/workspace id")
    ap.add_argument("--document", help="limit to one document id")
    ap.add_argument("--period", help="limit to one period id")
    ap.add_argument("--limit", type=int, help="max periods to process")
    args = ap.parse_args()
    if args.apply and args.dry_run:
        ap.error("--apply and --dry-run are mutually exclusive")

    _load_dotenv_if_needed()
    _supabase = _load_supabase_module()
    pack = get_pack("RO")

    filters: Dict[str, str] = {}
    if args.org:
        filters["org_id"] = f"eq.{args.org}"
    if args.period:
        filters["id"] = f"eq.{args.period}"
    if args.document:
        filters["source_document_id"] = f"eq.{args.document}"

    entries: List[Dict[str, Any]] = []
    applied = 0

    with _supabase.admin() as admin:
        periods = admin.select(
            "financial_periods",
            columns="id,org_id,period_end,source_document_id,assembled_canonical_v1",
            filters=filters,
            # Deterministic report order — never dict/insertion order.
            order="period_end.asc,id.asc",
        )
        if args.limit:
            periods = periods[: args.limit]
        print(f"{len(periods)} period(s) selected "
              f"({'APPLY' if args.apply else 'dry-run'})")

        doc_cache: Dict[str, Optional[Dict[str, Any]]] = {}
        for period in periods:
            pid = period["id"]
            doc_id = period.get("source_document_id")
            entry: Dict[str, Any] = {
                "period_id": pid,
                "period_end": period.get("period_end"),
                "document_id": doc_id,
                "filename": None,
                "status": "processed",
                "old_totals": None,
                "new_totals": None,
                "delta": None,
                "changed": None,
            }
            entries.append(entry)

            if not doc_id:
                entry["status"] = "skipped: period has no source document"
                continue
            if doc_id not in doc_cache:
                rows = admin.select(
                    "documents",
                    columns="id,original_filename,mime_type,storage_path,deleted_at,status",
                    filters={"id": f"eq.{doc_id}"},
                    single=True,
                )
                doc_cache[doc_id] = rows[0] if rows else None
            doc = doc_cache[doc_id]
            if doc is None:
                entry["status"] = "skipped: document row deleted"
                continue
            entry["filename"] = doc.get("original_filename")
            if doc.get("deleted_at"):
                entry["status"] = "skipped: document soft-deleted"
                continue
            kind = _classify_kind(doc.get("mime_type") or "",
                                  doc.get("original_filename") or "")
            if kind == "unsupported":
                entry["status"] = (
                    "skipped: kind not offline-reprocessable (image/text — LLM path)"
                )
                continue

            try:
                signed = admin.signed_url("documents", doc["storage_path"],
                                          expires_in=300)
                with httpx.Client(timeout=60.0) as http:
                    r = http.get(signed)
                    r.raise_for_status()
                    content = r.content
            except Exception as e:  # noqa: BLE001
                entry["status"] = f"skipped: storage object unavailable ({type(e).__name__})"
                continue

            try:
                _tb, _shaped, assembled = pack.run_deterministic_tb(
                    content, doc.get("original_filename") or "", kind=kind,
                )
            except Exception as e:  # noqa: BLE001
                entry["status"] = (
                    f"skipped: deterministic parse failed ({type(e).__name__}: "
                    f"{str(e)[:120]}) — LLM-extracted document, not offline-reprocessable"
                )
                continue

            new_env = assembled.get("assembled_canonical_v1")
            new_cbs = (new_env or {}).get("canonical_bs")
            if not isinstance(new_cbs, dict):
                entry["status"] = "skipped: new run emitted no canonical_bs"
                continue

            old_env = period.get("assembled_canonical_v1")
            old_totals = _stored_totals(old_env)
            new_totals = {k: round(float(new_cbs["totals"][k]), 2) for k in _TOTAL_KEYS}
            delta = (
                {k: round(new_totals[k] - old_totals[k], 2) for k in _TOTAL_KEYS}
                if old_totals else None
            )
            # 1-cent tolerance: below that is float noise, not a change.
            changed = old_totals is None or any(
                abs(d) > 0.01 for d in (delta or {}).values()
            )
            entry.update({
                "old_totals": old_totals,
                "new_totals": new_totals,
                "delta": delta,
                "changed": changed,
                "new_status": new_cbs.get("status"),
                "anchor_status": (new_cbs.get("source_anchor") or {}).get("anchor_status"),
            })

            if args.apply:
                # Archive-then-write — never a silent overwrite. The old
                # envelope (sans its own archives, which carry forward at
                # the top level) is preserved with its version stamps.
                archives = []
                if isinstance(old_env, dict):
                    archives = list(old_env.get("archives") or [])
                    old_cbs = old_env.get("canonical_bs") or {}
                    archives.append({
                        "archived_at": _now_iso(),
                        "extraction": old_cbs.get("extraction"),
                        "mapping_version": old_cbs.get("mapping_version"),
                        "schema_version": old_env.get("schema_version"),
                        "envelope": {k: v for k, v in old_env.items()
                                     if k != "archives"},
                    })
                new_env["archives"] = archives
                new_cbs["reprocessed"] = {
                    "changed": bool(changed),
                    "previous_totals": old_totals or {},
                }
                admin.update(
                    "financial_periods",
                    {"assembled_canonical_v1": new_env},
                    filters={"id": f"eq.{pid}"},
                )
                entry["applied"] = True
                applied += 1

    # ── Report (JSON + MD) ─────────────────────────────────────────────
    out_base = Path(args.out)
    out_base.parent.mkdir(parents=True, exist_ok=True)
    processed = [e for e in entries if e["status"] == "processed"]
    changed_n = sum(1 for e in processed if e.get("changed"))
    report = {
        "generated_at": _now_iso(),
        "mode": "apply" if args.apply else "dry-run",
        "periods_selected": len(entries),
        "processed": len(processed),
        "changed": changed_n,
        "applied": applied,
        "skipped": len(entries) - len(processed),
        "documents": entries,
    }
    json_path = out_base.with_suffix(".json")
    json_path.write_text(
        json.dumps(report, indent=2, sort_keys=True, ensure_ascii=False),
        encoding="utf-8",
    )

    md: List[str] = [
        "# Document reprocessing report",
        "",
        f"- Generated: {report['generated_at']}",
        f"- Mode: **{report['mode']}**",
        f"- Periods: {report['periods_selected']} selected · "
        f"{report['processed']} processed · {report['changed']} changed · "
        f"{report['skipped']} skipped · {report['applied']} applied",
        "",
        "| Period end | Period | Document | Old A / E / L | New A / E / L | Δ A / E / L | Changed | Status |",
        "|---|---|---|---|---|---|---|---|",
    ]

    def _fmt(t: Optional[Dict[str, float]]) -> str:
        if not t:
            return "—"
        return " / ".join(f"{t[k]:,.2f}" for k in _TOTAL_KEYS)

    for e in entries:
        md.append(
            f"| {e.get('period_end') or '—'} | `{e['period_id'][:8]}` "
            f"| {e.get('filename') or '—'} | {_fmt(e.get('old_totals'))} "
            f"| {_fmt(e.get('new_totals'))} | {_fmt(e.get('delta'))} "
            f"| {'YES' if e.get('changed') else ('no' if e.get('changed') is False else '—')} "
            f"| {e['status']} |"
        )
    md_path = out_base.with_suffix(".md")
    md_path.write_text("\n".join(md) + "\n", encoding="utf-8")

    print(f"\nReport: {json_path}\n        {md_path}")
    print(f"Processed {len(processed)}/{len(entries)} — {changed_n} changed"
          + (f", {applied} applied" if args.apply else " (dry-run, nothing written)"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
