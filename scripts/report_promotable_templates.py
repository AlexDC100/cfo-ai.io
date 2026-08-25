#!/usr/bin/env python3
"""report_promotable_templates.py — nightly REPORT of promotable format templates.

ZERO-OWNER DESIGN, on purpose: this repo has NO PR-opening automation
anywhere (verified repo-wide by the understand-phase maps — no `gh pr
create`, no peter-evans action). So this script REPORTS and never
mutates: it lists the candidate templates that meet the promotion bar
(default: >= 3 confirmations across >= 2 distinct company keys), prints
the exact operator promotion procedure, and refreshes the ops stats file
at data/obs/template_stats.json. A human runs the promotion; nothing
here flips a template to "confirmed".

EXIT CODE IS ALWAYS 0 — nightly-report style. A broken store prints the
problem loudly and still exits 0; the ops/sentinel surfaces are where
absence shows up, not a red CI.

Env:
    ENGINE_TEMPLATES_DIR  override the template store directory
                          (default <repo>/data/format_templates)
    ENGINE_OBS_DIR        override the obs stats directory
                          (default <repo>/data/obs)

Stats file shape (template_stats_v1, for the ops surface):
    {template_count, confirmed, candidates, hits, misses,
     interpreter_calls_saved}
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict


# ── Repo-root + sys.path setup — independent of cwd (same pattern as
# scripts/verify_determinism.py) ──────────────────────────────────────


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


def _load_templates_module() -> Any:
    """Import engine.interp.templates; fall back to a direct file load.

    The fallback keeps this report working even if a sibling module in
    the engine.interp package is mid-change — templates.py itself has no
    package-relative imports.
    """
    try:
        from engine.interp import templates as mod  # noqa: PLC0415

        return mod
    except Exception:  # noqa: BLE001 — package __init__ may be in flux
        path = SRC / "engine" / "interp" / "templates.py"
        spec = importlib.util.spec_from_file_location(
            "_report_templates_mod", str(path)
        )
        if spec is None or spec.loader is None:
            raise
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod


def _obs_dir() -> Path:
    env = os.environ.get("ENGINE_OBS_DIR")
    if env:
        return Path(env)
    return REPO / "data" / "obs"


def _atomic_write_json(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(
        payload, sort_keys=True, ensure_ascii=False, indent=2, allow_nan=False
    )
    fd, tmp_name = tempfile.mkstemp(
        prefix=path.name + ".", suffix=".tmp", dir=str(path.parent)
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text + "\n")
        os.replace(tmp_name, str(path))
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


_PROMOTION_PROCEDURE = """\
OPERATOR PROMOTION PROCEDURE (manual, human-reviewed — there is no PR bot):
  1. Inspect the candidate's structural map and its confirmations:
       .venv/bin/python - <<'EOF'
       import json
       from engine.interp.templates import TemplateStore
       print(json.dumps(TemplateStore().get_entry("<FINGERPRINT>"), indent=2))
       EOF
  2. Sanity-check the map against one of the confirming documents
     (mechanical extraction + totals-leg check must reconcile).
  3. Promote WITH YOUR IDENTITY (anonymous promotion is refused):
       .venv/bin/python - <<'EOF'
       from engine.interp.templates import TemplateStore
       TemplateStore().promote("<FINGERPRINT>", promoted_by="<your name/email>")
       EOF
  4. Re-run this report to confirm the entry moved to "confirmed":
       .venv/bin/python scripts/report_promotable_templates.py
  Promotion only changes SERVING for future uploads of this exact layout
  (fingerprint hit -> mechanical extraction, no interpreter call). The
  totals-leg check remains mandatory on every hit."""


def main(argv: Any = None) -> int:
    parser = argparse.ArgumentParser(
        description="Report format templates meeting the promotion bar."
    )
    parser.add_argument(
        "--templates-dir",
        default=None,
        help="template store directory (default: ENGINE_TEMPLATES_DIR or "
        "<repo>/data/format_templates)",
    )
    parser.add_argument(
        "--n-confirm",
        type=int,
        default=None,
        help="confirmations required (default %d)" % 3,
    )
    parser.add_argument(
        "--m-companies",
        type=int,
        default=None,
        help="distinct company keys required (default %d)" % 2,
    )
    args = parser.parse_args(argv)

    try:
        tmod = _load_templates_module()
        n_confirm = (
            args.n_confirm
            if args.n_confirm is not None
            else tmod.DEFAULT_N_CONFIRMATIONS
        )
        m_companies = (
            args.m_companies
            if args.m_companies is not None
            else tmod.DEFAULT_M_COMPANIES
        )
        store = tmod.TemplateStore(args.templates_dir)

        entries = store.entries()
        confirmed = [e for e in entries if e.get("status") == "confirmed"]
        candidates = [e for e in entries if e.get("status") == "candidate"]
        promotable = store.promotable(n_confirm, m_companies)
        stats = store.stats()

        print("format-template promotion report")
        print("  store: %s" % store.root)
        print(
            "  templates: %d total (%d confirmed, %d candidates)"
            % (len(entries), len(confirmed), len(candidates))
        )
        print(
            "  lookup stats: %d hits / %d misses "
            "(%d interpreter calls saved)"
            % (
                stats["hits"],
                stats["misses"],
                stats["interpreter_calls_saved"],
            )
        )
        print(
            "  promotion bar: >= %d confirmations across >= %d distinct "
            "company keys" % (n_confirm, m_companies)
        )
        if not promotable:
            print("  promotable now: none")
        else:
            print("  promotable now: %d" % len(promotable))
            for entry in promotable:
                confirmations = entry.get("confirmations") or []
                companies = sorted(
                    {
                        str(c.get("company_key"))
                        for c in confirmations
                        if c.get("company_key")
                    }
                )
                created_from = entry.get("created_from") or {}
                print("    - fingerprint: %s" % entry.get("fingerprint"))
                print(
                    "      confirmations: %d across %d companies (%s)"
                    % (len(confirmations), len(companies), ", ".join(companies))
                )
                print(
                    "      created_from.map_hash: %s"
                    % created_from.get("map_hash")
                )
            print()
            print(_PROMOTION_PROCEDURE)

        stats_payload = {
            "schema": "template_stats_v1",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "template_count": len(entries),
            "confirmed": len(confirmed),
            "candidates": len(candidates),
            "hits": stats["hits"],
            "misses": stats["misses"],
            "interpreter_calls_saved": stats["interpreter_calls_saved"],
        }
        stats_path = _obs_dir() / "template_stats.json"
        _atomic_write_json(stats_path, stats_payload)
        print("  stats written: %s" % stats_path)
    except Exception as exc:  # noqa: BLE001 — report-style: loud, never red
        print(
            "report_promotable_templates: DEGRADED — %s: %s"
            % (type(exc).__name__, exc)
        )
        print("(nightly-report contract: exiting 0 anyway)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
