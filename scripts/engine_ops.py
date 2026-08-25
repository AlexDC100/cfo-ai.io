#!/usr/bin/env python3
"""Engine ops CLI — status / metrics / sentinels (engine.obs surface).

One glance = engine health, from the terminal. Everything here is
read-side and non-blocking: sentinel departures print alert-level
NOTICES (corpus_replay style, NEVER red) and every subcommand exits 0 —
the only non-zero exit is 2 for usage/internal errors. Wire ``sentinels``
into a nightly cron / CI step as a visible, non-gating check.

Subcommands:
  status [--json]           The full ops snapshot: last battery result
                            per gate (parsed from the conventional
                            record — see below — else "not recorded"),
                            deploy versions (engine + jurisdiction packs
                            + model registry), AI spend vs caps, journal
                            verification + DLQ depth, drift notices.
  metrics [--json]          The on-demand health collector: imbalance
                            histogram, reconcile cause mix, front-end
                            mix, LLM-fallback / unclassified / cache-hit
                            rates, AI agreement, cost-per-doc estimates.
  sentinels [--json]        The nightly drift check: current rates vs
            [--no-update]   the rolling baseline (data/obs/baseline.json,
                            EWMA-updated unless --no-update). Departures
                            print NOTICE lines; exit 0 always.

Roots & conventions:
  --journal-root > ENGINE_JOURNAL_DIR > <repo>/data/journal (if present)
  ENGINE_OBS_DIR   moves data/obs (baseline + battery record)
  ENGINE_BATTERY_LOG  points at an explicit battery record file;
                      default <obs dir>/battery_last.json. JSON
                      ({"ran_at", "gates": {name: {"ok": bool, ...}}})
                      or plain text ("PASS <gate>" / "FAIL <gate>"
                      lines) both parse.

Exit codes: 0 ok (including departures — notices, not failures) ·
2 usage/internal error.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


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

from engine.obs.metrics import collect_metrics  # noqa: E402
from engine.obs.sentinels import evaluate_sentinels  # noqa: E402
from engine.obs.status import ops_snapshot  # noqa: E402


def _print_json(obj) -> None:
    print(json.dumps(obj, indent=2, ensure_ascii=False, default=str))


def _fmt_rate(value) -> str:
    return "n/a" if value is None else "%.1f%%" % (float(value) * 100.0)


def _cmd_status(args: argparse.Namespace) -> int:
    snap = ops_snapshot(args.journal_root)
    if args.json:
        _print_json(snap)
        return 0

    battery = snap.get("battery") or {}
    print("ENGINE OPS — one-glance health")
    print("=" * 62)
    if battery.get("recorded"):
        print(
            "battery      %s/%s gates green%s"
            % (
                battery.get("passed"),
                battery.get("total"),
                "  (ran %s)" % battery["ran_at"] if battery.get("ran_at") else "",
            )
        )
        for name, gate in sorted((battery.get("gates") or {}).items()):
            ok = bool(isinstance(gate, dict) and gate.get("ok"))
            print("  %-6s %s" % ("PASS" if ok else "FAIL", name))
    else:
        print("battery      not recorded (%s)" % battery.get("path"))

    versions = snap.get("versions") or {}
    print("engine       %s" % versions.get("engine"))
    packs = versions.get("packs")
    if isinstance(packs, list):
        for pack in packs:
            print(
                "pack         %s %s %s  from %s  hash %s"
                % (
                    pack.get("jurisdiction"),
                    pack.get("pack_id"),
                    pack.get("version"),
                    pack.get("effective_from"),
                    pack.get("pack_hash_short"),
                )
            )
    else:
        print("packs        unavailable (%s)" % (packs or {}).get("error"))
    models = versions.get("models")
    if isinstance(models, dict) and "error" not in models:
        for role, row in models.items():
            print("model        %-18s %s" % (role, row.get("model_id")))
    else:
        print("models       unavailable (%s)" % (models or {}).get("error"))

    spend = snap.get("ai_spend") or {}
    roles = spend.get("roles") if isinstance(spend, dict) else None
    if isinstance(roles, dict) and roles:
        print("ai spend     day %s" % spend.get("day"))
        for role, entry in sorted(roles.items()):
            limits = entry.get("limits") or {}
            print(
                "  %-18s calls %s/%s  tokens %s/%s"
                % (
                    role,
                    entry.get("calls", 0),
                    limits.get("max_calls_per_day", "?"),
                    entry.get("tokens", 0),
                    limits.get("max_tokens_per_day", "?"),
                )
            )
    else:
        print("ai spend     no counters yet")

    journal = snap.get("journal") or {}
    verification = journal.get("verification") or {}
    if journal.get("enabled"):
        verdict = (
            "chain verify OK (%s checked)" % verification.get("checked")
            if journal.get("verified_ok")
            else (
                "chain verify FAILED on %s of %s"
                % (verification.get("failed"), verification.get("checked"))
                if verification.get("checked")
                else "no chains yet"
            )
        )
        print(
            "journal      %s chains · %s · DLQ depth %s"
            % (journal.get("chains"), verdict, journal.get("dlq_depth"))
        )
    else:
        print("journal      disabled (set ENGINE_JOURNAL_DIR to enable)")

    sentinels = snap.get("sentinels") or {}
    departures = sentinels.get("departures") or []
    print(
        "drift        %s"
        % ("steady vs baseline" if not departures else "%d departure(s)" % len(departures))
    )
    for line in sentinels.get("notices") or []:
        print(line)

    rates = (snap.get("metrics") or {}).get("rates") or {}
    print(
        "rates        unclassified %s · llm fallback %s · ai proposals %s · "
        "cache hits %s"
        % (
            _fmt_rate(rates.get("unclassified_rate")),
            _fmt_rate(rates.get("frontend_fallback_rate")),
            _fmt_rate(rates.get("ai_proposal_rate")),
            _fmt_rate(rates.get("cache_hit_rate")),
        )
    )
    print(
        "             consensus agreement %s · interpreter calls %s · "
        "template hits %s"
        % (
            _fmt_rate(rates.get("consensus_agreement_rate")),
            _fmt_rate(rates.get("interpreter_call_rate")),
            _fmt_rate(rates.get("template_hit_rate")),
        )
    )

    budget = snap.get("error_budget") or {}
    if budget.get("measured"):
        for lane, row in sorted((budget.get("per_lane") or {}).items()):
            if not isinstance(row, dict):
                continue
            n = row.get("n") or 0
            if not n:
                print("error budget %-16s no measurement source yet" % lane)
                continue
            rate = row.get("rate")
            line = "error budget %-16s %s on %s fields" % (
                lane,
                "%.4f%%" % (rate * 100.0) if isinstance(rate, (int, float))
                else "n/a",
                n,
            )
            ci_low, ci_high = row.get("ci_low"), row.get("ci_high")
            if isinstance(ci_low, (int, float)) and isinstance(ci_high, (int, float)):
                line += "  95%% CI [%.4f%%, %.4f%%]" % (
                    ci_low * 100.0, ci_high * 100.0,
                )
            if not row.get("sufficient"):
                line += "  (N insufficient to certify the budget)"
            print(line)
    else:
        print(
            "error budget not measured yet (%s) — run "
            "scripts/measure_error_budget.py" % budget.get("path")
        )
    tmpl = snap.get("templates") or {}
    if tmpl.get("recorded"):
        print(
            "templates    %s stored (%s confirmed, %s candidates) — "
            "hits %s / misses %s, interpreter calls saved %s"
            % (
                tmpl.get("template_count", 0), tmpl.get("confirmed", 0),
                tmpl.get("candidates", 0), tmpl.get("hits", 0),
                tmpl.get("misses", 0), tmpl.get("interpreter_calls_saved", 0),
            )
        )
    else:
        print(
            "templates    no stats recorded yet — run "
            "scripts/report_promotable_templates.py"
        )
    return 0


def _cmd_metrics(args: argparse.Namespace) -> int:
    metrics = collect_metrics(args.journal_root)
    if args.json:
        _print_json(metrics)
        return 0
    print("ENGINE METRICS — computed on demand")
    print("=" * 62)
    journal = metrics.get("journal") or {}
    print(
        "journal      enabled=%s chains=%s dlq_depth=%s"
        % (journal.get("enabled"), journal.get("chains"), metrics.get("dlq_depth"))
    )
    for name in ("frontend_mix", "extraction_method_mix", "status_mix",
                 "reconcile_outcomes", "reconcile_causes"):
        counter = (metrics.get("counters") or {}).get(name)
        if counter:
            mix = "  ".join(
                "%s=%d" % (key, int(val)) for key, val in sorted(counter.items())
            )
            print("%-24s %s" % (name, mix))
    for name, hist in sorted((metrics.get("histograms") or {}).items()):
        print(
            "%-24s count=%s mean=%s min=%s max=%s"
            % (name, hist.get("count"), hist.get("mean"), hist.get("min"),
               hist.get("max"))
        )
    for name, value in sorted((metrics.get("rates") or {}).items()):
        print("%-24s %s" % (name, "n/a" if value is None else value))
    return 0


def _cmd_sentinels(args: argparse.Namespace) -> int:
    result = evaluate_sentinels(
        journal_root=args.journal_root,
        update_baseline=not args.no_update,
    )
    if args.json:
        _print_json(result)
        return 0
    for line in result.get("notices") or []:
        print(line)
    if not result.get("notices"):
        print(
            "NOTICE  obs sentinel: all rates steady vs baseline "
            "(%s)" % json.dumps(result.get("rates"), sort_keys=True)
        )
    if result.get("baseline_updated"):
        print("baseline updated (EWMA) — data/obs/baseline.json")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="engine_ops.py",
        description="Engine observability: status / metrics / drift sentinels.",
    )
    parser.add_argument(
        "--journal-root",
        default=None,
        help="Journal root (default: ENGINE_JOURNAL_DIR, else <repo>/data/journal)",
    )
    sub = parser.add_subparsers(dest="command")

    p_status = sub.add_parser("status", help="one-glance engine health")
    p_status.add_argument("--json", action="store_true")

    p_metrics = sub.add_parser("metrics", help="on-demand health collector")
    p_metrics.add_argument("--json", action="store_true")

    p_sent = sub.add_parser("sentinels", help="nightly drift check vs baseline")
    p_sent.add_argument("--json", action="store_true")
    p_sent.add_argument(
        "--no-update",
        action="store_true",
        help="compare only — leave the rolling baseline untouched",
    )

    args = parser.parse_args(argv)
    command = args.command or "status"
    if command == "status" and not hasattr(args, "json"):
        args.json = False
    try:
        if command == "status":
            return _cmd_status(args)
        if command == "metrics":
            return _cmd_metrics(args)
        if command == "sentinels":
            return _cmd_sentinels(args)
        parser.print_help()
        return 2
    except Exception:  # noqa: BLE001 — internal error is the ONLY red path
        import traceback

        traceback.print_exc()
        return 2


if __name__ == "__main__":
    sys.exit(main())
