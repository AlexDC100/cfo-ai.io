"""CLI: `python -m engine <command>`.

Commands:
    run            Run engine on an input dataset (Excel or CSV) and write JSON.
    validate       Run engine on the fixture and assert the calibrated flags.
    serve          Start the FastAPI service for n8n / HTTP triggers.
    briefing       Generate RO/EN briefing from a daily-decisions JSON file.
    export-powerbi Flatten a daily-decisions JSON into parquet for Power BI.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path
from typing import List, Optional

from .actions import build_output, write_output
from .config import load_config
from .loader import load_categories_from_csv, load_categories_from_excel, load_skus_from_excel
from .pipeline import run_pipeline
from .sku_pipeline import drill_category
from .validate import validate as run_validate


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="engine", description="SKU Decision Engine")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_run = sub.add_parser("run", help="Run the engine and write daily decisions JSON")
    p_run.add_argument("--input", type=Path, required=True, help="Path to .xlsx or .csv")
    p_run.add_argument("--config", type=Path, default=Path("config.yaml"))
    p_run.add_argument("--date", type=str, default=date.today().isoformat())
    p_run.add_argument("--period-months", type=int, default=10,
                       help="Months of data in the input (10 for YTD Oct dataset)")
    p_run.add_argument("--output", type=Path, default=None,
                       help="Output directory (overrides config.output.default_path)")
    p_run.add_argument("--data-period", type=str, default="YTD October 2025")
    p_run.add_argument("--dry-run", action="store_true",
                       help="Print summary instead of writing JSON")

    p_drill = sub.add_parser("drill", help="Show SKU-level decisions inside a category")
    p_drill.add_argument("--input", type=Path, required=True,
                         help="Excel workbook (must have YTD Oct'25 sheet)")
    p_drill.add_argument("--category", type=str, required=True,
                         help="Category name to drill into (e.g. Calamar)")
    p_drill.add_argument("--config", type=Path, default=Path("config.yaml"))
    p_drill.add_argument("--period-months", type=int, default=10)
    p_drill.add_argument("--top", type=int, default=None,
                         help="Show only top N SKUs by abs profit (default: all)")
    p_drill.add_argument("--json", action="store_true",
                         help="Emit JSON instead of a table")

    p_val = sub.add_parser("validate", help="Run validation against fixture or Excel")
    p_val.add_argument("--config", type=Path, default=Path("config.yaml"))
    p_val.add_argument("--input", type=Path,
                       default=Path("data/validation_fixture_categories.csv"),
                       help="Fixture CSV or real Excel workbook")
    p_val.add_argument("--period-months", type=int, default=10)

    p_serve = sub.add_parser("serve", help="Start the FastAPI service")
    p_serve.add_argument("--config", type=Path, default=Path("config.yaml"))
    p_serve.add_argument("--db-url", type=str, default=None,
                         help="SQLAlchemy URL (e.g. postgresql://...). Defaults to in-memory sqlite.")
    p_serve.add_argument("--host", type=str, default="0.0.0.0")
    p_serve.add_argument("--port", type=int, default=8000)
    p_serve.add_argument("--canonical-excel", type=Path, default=None,
                         help="Excel workbook (Analysis sheet) used to seed canonical category DIO/CCC for the React frontend.")

    p_brief = sub.add_parser("briefing", help="Generate RO/EN briefing from a JSON file")
    p_brief.add_argument("--input", type=Path, required=True,
                         help="Path to daily-decisions JSON file")
    p_brief.add_argument("--config", type=Path, default=Path("config.yaml"))
    p_brief.add_argument("--language", type=str, default="all",
                         help="'en', 'ro', or 'all' (defaults to all configured)")
    p_brief.add_argument("--mock", action="store_true",
                         help="Use the mock client (no API key needed)")

    p_pbi = sub.add_parser("export-powerbi", help="Flatten daily decisions to parquet")
    p_pbi.add_argument("--input", type=Path, required=True,
                       help="Path to daily-decisions JSON file")
    p_pbi.add_argument("--output", type=Path, default=Path("output"),
                       help="Output directory")
    p_pbi.add_argument("--format", choices=["parquet", "csv"], default="parquet")

    args = parser.parse_args(argv)

    if args.cmd == "run":
        return _cmd_run(args)
    if args.cmd == "validate":
        return run_validate(args.input, args.config, args.period_months)
    if args.cmd == "serve":
        return _cmd_serve(args)
    if args.cmd == "briefing":
        return _cmd_briefing(args)
    if args.cmd == "export-powerbi":
        return _cmd_export_powerbi(args)
    if args.cmd == "drill":
        return _cmd_drill(args)
    parser.print_help()
    return 2


def _cmd_drill(args: argparse.Namespace) -> int:
    cfg = load_config(args.config)
    if args.input.suffix.lower() not in (".xlsx", ".xlsm"):
        print(f"drill requires an Excel input (got {args.input.suffix})")
        return 2

    categories = load_categories_from_excel(args.input)
    skus = load_skus_from_excel(args.input)
    metrics, decisions = drill_category(
        args.category, skus, categories, cfg, args.period_months
    )

    if not decisions:
        print(f"No SKUs found for category '{args.category}'.")
        print("Available categories:")
        for c in sorted({s.category for s in skus}):
            print(f"  - {c}")
        return 1

    if args.top:
        decisions = decisions[: args.top]
        metrics = metrics[: args.top]

    if args.json:
        import json as _json
        out = {
            "category": args.category,
            "sku_count": len(decisions),
            "decisions": [d.model_dump(exclude_none=True) for d in decisions],
        }
        print(_json.dumps(out, indent=2, ensure_ascii=False))
        return 0

    print(f"\n{args.category} — {len(decisions)} SKU(s) (sorted by absolute profit)\n")
    print(f"{'SKU':<60} {'Vol(t)':<8} {'GM%':<6} {'RM%':<7} {'AbsProfit':<11} {'Flag':<14} Reason")
    print("─" * 130)
    for d, m in zip(decisions, metrics):
        sku_short = d.id[:58]
        print(
            f"{sku_short:<60} "
            f"{d.volume_tons:<8.3f} "
            f"{m.gm_pct:<6.1f} "
            f"{d.real_margin_pct:<7.1f} "
            f"{d.abs_profit_kron:<11.2f} "
            f"{d.flag:<14} "
            f"{d.reason or ''}"
        )

    counts: dict = {}
    for d in decisions:
        counts[d.flag] = counts.get(d.flag, 0) + 1
    print(f"\nFlag distribution: {dict(sorted(counts.items()))}")
    return 0


def _cmd_run(args: argparse.Namespace) -> int:
    cfg = load_config(args.config)
    rows = _load_input(args.input)
    sku_count: Optional[int] = None
    if args.input.suffix.lower() in (".xlsx", ".xlsm"):
        try:
            sku_count = len(load_skus_from_excel(args.input))
        except Exception:  # noqa: BLE001 — SKU loading is best-effort for Phase 1
            sku_count = None

    metrics, decisions = run_pipeline(rows, cfg, period_months=args.period_months)
    payload = build_output(
        decisions, metrics, cfg,
        run_date=date.fromisoformat(args.date),
        data_period=args.data_period,
        sku_count=sku_count,
    )

    if args.dry_run:
        _print_summary(payload)
        return 0

    output_dir = args.output or Path(cfg.output.default_path)
    out_path = write_output(payload, output_dir, cfg.output.json_filename_pattern)
    print(f"Wrote {out_path}")
    _print_summary(payload)
    return 0


def _load_input(path: Path) -> list:
    if path.suffix.lower() == ".csv":
        return load_categories_from_csv(path)
    if path.suffix.lower() in (".xlsx", ".xlsm"):
        return load_categories_from_excel(path)
    raise ValueError(f"Unsupported input format: {path.suffix}")


def _cmd_serve(args: argparse.Namespace) -> int:
    """Start uvicorn with the FastAPI app — blocks until killed."""
    import os
    import uvicorn
    from .api import create_app

    # CORS origins are configured via env in production. Comma-separated list,
    # e.g. CORS_ORIGINS="https://scandiafood-sku.online,https://www.scandiafood-sku.online"
    cors_env = os.environ.get("CORS_ORIGINS", "").strip()
    cors_origins = [o.strip() for o in cors_env.split(",") if o.strip()] or None

    # Boot-time Anthropic key check. The key value never leaves this process —
    # it's read from the env that docker-compose injected from .env.
    # We do not crash on failure; the engine still classifies SKUs without AI.
    _check_anthropic_key()

    app = create_app(
        config_path=args.config,
        db_url=args.db_url,
        canonical_excel=args.canonical_excel,
        cors_origins=cors_origins,
    )
    uvicorn.run(app, host=args.host, port=args.port)
    return 0


def _check_anthropic_key() -> None:
    """Probe the configured Anthropic key at startup so the deploy log shows
    "AI ready" or "AI disabled — reason" without anyone having to test by hand.
    Never prints the key, only its first 12 chars so the deploy operator can
    verify they pasted the right one.
    """
    import os
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not key:
        print("[anthropic] ANTHROPIC_API_KEY not set — AI panel will use deterministic fallback prose.")
        return
    fingerprint = key[:12] + "…"  # show enough to identify, never enough to use
    try:
        from anthropic import Anthropic
    except ImportError:
        print(f"[anthropic] Key set ({fingerprint}) but the `anthropic` SDK is not installed — AI disabled.")
        return
    try:
        client = Anthropic(api_key=key)
        # The lightest authenticated call — list models. No tokens generated.
        client.models.list(limit=1)
        print(f"[anthropic] Key {fingerprint} authenticated — AI panel ready.")
    except Exception as e:  # noqa: BLE001 — startup probe, log and continue
        msg = str(e).splitlines()[0][:140]
        print(f"[anthropic] Key {fingerprint} FAILED auth: {msg}")
        print("[anthropic] AI panel will use deterministic fallback prose. Fix the key and restart.")


def _cmd_briefing(args: argparse.Namespace) -> int:
    """Read a daily-decisions JSON, generate one or more language briefings."""
    from .briefing import (
        ClaudeBriefingClient,
        MockBriefingClient,
        generate_briefings_all_languages,
    )

    cfg = load_config(args.config)
    with open(args.input, "r", encoding="utf-8") as f:
        payload = json.load(f)

    if args.language == "all":
        langs = cfg.output.briefing_languages
    else:
        langs = [args.language]

    client = MockBriefingClient() if args.mock else ClaudeBriefingClient()
    briefings = generate_briefings_all_languages(payload, client, langs)
    for lang, text in briefings.items():
        print(f"\n══════ {lang.upper()} ══════")
        print(text)
    return 0


def _cmd_export_powerbi(args: argparse.Namespace) -> int:
    """Flatten a daily-decisions JSON into parquet/CSV for Power BI."""
    from .storage.powerbi import export_csv, export_parquet

    with open(args.input, "r", encoding="utf-8") as f:
        payload = json.load(f)
    if args.format == "parquet":
        out = export_parquet(payload, args.output)
    else:
        out = export_csv(payload, args.output)
    print(f"Wrote {out}")
    return 0


def _print_summary(payload: dict) -> None:
    s = payload["summary"]
    print(f"\nRun date:    {payload['run_date']}")
    print(f"Period:      {payload['data_period']}")
    print(f"Categories:  {s['total_categories_analyzed']}")
    print(f"Capital blocked: {s['capital_blocked_RON']:,.0f} RON")
    print(f"ROIC:        {s['total_roic_pct']}% (cost of capital {s['cost_of_capital_pct']}%)")
    print(f"\nFlag counts:")
    for k in ("anchors_count", "anchors_with_alerts", "eliminate_count",
              "warning_count", "scale_count", "keep_count"):
        print(f"  {k:<22} {s[k]}")


if __name__ == "__main__":
    sys.exit(main())
