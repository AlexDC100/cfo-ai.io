#!/usr/bin/env python3
"""Run-journal operator CLI — verify / asof / dlq / gc / notice.

Root resolution: --journal-root > ENGINE_JOURNAL_DIR > <repo>/data/journal
(locally the gitignored data/ tree; in-container /app/data/journal on
the mounted volume).

Subcommands:
  verify [REF | --all]      Re-hash a document chain (or every chain)
                            and check every link + snapshot object.
                            Exit 1 on ANY tamper/corruption; 0 clean.
                            REF = file_hash | document_id | period_id.
  asof REF T                Print the envelope served at ISO time T for
                            REF (file_hash | document_id | period_id) —
                            resolves which SNAPSHOT_PERSISTED was live
                            at T and loads its content-addressed object.
                            Exit 3 when there is no journal coverage.
  dlq list                  List dead-lettered runs (typed reason per
                            entry) and print the battery NOTICE line
                            with the DLQ depth. Always exit 0 — the
                            NOTICE is an operator signal, not a gate.
  dlq replay RUN_ID         Re-execute a dead-lettered run from its
                            recorded checkpoints (the REAL stage entry
                            points). Honest refusals (missing objects /
                            lossy checkpoints / env unavailable) exit 4
                            with the typed reason; success resolves the
                            entry (moved to dlq/resolved/, never
                            deleted) and exits 0.
  resume RUN_ID             Same machinery as dlq replay for a crashed
                            (never dead-lettered) run.
  gc [--delete]             List snapshot objects no journal event
                            references (crash debris) + atomic-write
                            temp files. LIST-ONLY by default; --delete
                            removes ONLY those orphans. Exit 0 always.
  notice                    Print the battery NOTICE line only
                            (corpus_replay-style):
                              NOTICE  journal: DLQ depth N (root ...)
                            Always exit 0 — wire into CI as a visible,
                            non-blocking step.

Exit codes: 0 ok · 1 verification failure · 2 usage/internal error ·
3 no as-of coverage · 4 replay/resume refused.
"""
from __future__ import annotations

import argparse
import json
import os
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

from engine.journal import Journal  # noqa: E402
from engine.journal.resume import ResumeRefused, replay_dlq, resume_run  # noqa: E402


def _notice(message: str) -> None:
    """corpus_replay-style non-blocking operator notice."""
    print("NOTICE  %s" % message)


def _default_root() -> Path:
    env = os.environ.get("ENGINE_JOURNAL_DIR")
    if env:
        return Path(env)
    return REPO / "data" / "journal"


def _journal(args: argparse.Namespace) -> Journal:
    root = Path(args.journal_root) if args.journal_root else _default_root()
    return Journal(root)


def cmd_verify(args: argparse.Namespace) -> int:
    journal = _journal(args)
    if args.all or not args.ref:
        chains = journal.list_chains()
        if not chains:
            print("verify: no chains in %s" % journal.root)
            return 0
    else:
        resolved = journal.resolve_chain(args.ref)
        if resolved is None:
            print("verify: no chain found for %r in %s" % (args.ref, journal.root))
            return 1
        chains = [resolved]
    failures = 0
    for chain in chains:
        errors = journal.verify_chain(chain)
        if errors:
            failures += 1
            print("FAIL  %s" % chain)
            for err in errors:
                print("      %s" % err)
        else:
            n_events = len(journal.chain_events(chain))
            print("OK    %s (%d events)" % (chain, n_events))
    if failures:
        print("verify: %d/%d chain(s) FAILED integrity" % (failures, len(chains)))
        return 1
    print("verify: %d chain(s) intact" % len(chains))
    return 0


def cmd_asof(args: argparse.Namespace) -> int:
    journal = _journal(args)
    result = journal.asof(args.ref, args.timestamp)
    if result is None:
        print(
            "asof: no journal coverage for %r at %s (pre-journal history "
            "is honestly absent)" % (args.ref, args.timestamp)
        )
        return 3
    if result.get("error"):
        print("asof: %s" % result["error"])
        return 2
    print(json.dumps(result, sort_keys=True, ensure_ascii=False, indent=2))
    return 0


def cmd_dlq_list(args: argparse.Namespace) -> int:
    journal = _journal(args)
    entries = journal.dlq_entries()
    for entry in entries:
        print(
            "%s  stage=%s  reason=%s  doc=%s  %s"
            % (
                entry.get("run_id"),
                entry.get("stage"),
                entry.get("reason_type"),
                entry.get("document_id"),
                (entry.get("message") or "")[:120],
            )
        )
    depth = journal.dlq_depth()
    _notice("journal: DLQ depth %d (root %s)" % (depth, journal.root))
    return 0


def cmd_dlq_replay(args: argparse.Namespace) -> int:
    journal = _journal(args)
    try:
        result = replay_dlq(journal, args.run_id)
    except ResumeRefused as refused:
        print("dlq replay REFUSED (%s): %s" % (refused.reason, refused.detail))
        return 4
    print(json.dumps(result, sort_keys=True, ensure_ascii=False, indent=2))
    return 0


def cmd_resume(args: argparse.Namespace) -> int:
    journal = _journal(args)
    try:
        result = resume_run(journal, args.run_id)
    except ResumeRefused as refused:
        print("resume REFUSED (%s): %s" % (refused.reason, refused.detail))
        return 4
    print(json.dumps(result, sort_keys=True, ensure_ascii=False, indent=2))
    return 0


def cmd_gc(args: argparse.Namespace) -> int:
    journal = _journal(args)
    report = journal.gc_orphans(delete=bool(args.delete))
    for digest in report["orphans"]:
        print("orphan  %s" % digest)
    for tmp in report["temp_files"]:
        print("tmpfile %s" % tmp)
    if args.delete:
        print(
            "gc: deleted %d orphan object(s); %d referenced object(s) untouched"
            % (len(report["deleted"]), report["referenced_count"])
        )
    else:
        print(
            "gc: %d orphan object(s), %d temp file(s) — LIST-ONLY "
            "(pass --delete to collect); %d referenced object(s)"
            % (
                len(report["orphans"]),
                len(report["temp_files"]),
                report["referenced_count"],
            )
        )
    return 0


def cmd_notice(args: argparse.Namespace) -> int:
    journal = _journal(args)
    _notice("journal: DLQ depth %d (root %s)" % (journal.dlq_depth(), journal.root))
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="journal_cli.py", description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--journal-root",
        help="journal root (default: ENGINE_JOURNAL_DIR or <repo>/data/journal)",
    )
    sub = parser.add_subparsers(dest="command")

    p_verify = sub.add_parser("verify", help="re-hash chain(s), exit 1 on tamper")
    p_verify.add_argument("ref", nargs="?", help="file_hash | document_id | period_id")
    p_verify.add_argument("--all", action="store_true", help="verify every chain")
    p_verify.set_defaults(func=cmd_verify)

    p_asof = sub.add_parser("asof", help="envelope served at a moment in time")
    p_asof.add_argument("ref", help="file_hash | document_id | period_id")
    p_asof.add_argument("timestamp", help="ISO-8601 timestamp")
    p_asof.set_defaults(func=cmd_asof)

    p_dlq = sub.add_parser("dlq", help="dead-letter queue operations")
    dlq_sub = p_dlq.add_subparsers(dest="dlq_command")
    p_dlq_list = dlq_sub.add_parser("list", help="list entries + NOTICE depth")
    p_dlq_list.set_defaults(func=cmd_dlq_list)
    p_dlq_replay = dlq_sub.add_parser("replay", help="re-execute a dead-lettered run")
    p_dlq_replay.add_argument("run_id")
    p_dlq_replay.set_defaults(func=cmd_dlq_replay)

    p_resume = sub.add_parser("resume", help="resume a crashed run from checkpoints")
    p_resume.add_argument("run_id")
    p_resume.set_defaults(func=cmd_resume)

    p_gc = sub.add_parser("gc", help="orphan objects (list-only by default)")
    p_gc.add_argument("--delete", action="store_true")
    p_gc.set_defaults(func=cmd_gc)

    p_notice = sub.add_parser("notice", help="battery NOTICE line (DLQ depth)")
    p_notice.set_defaults(func=cmd_notice)

    args = parser.parse_args(argv)
    func = getattr(args, "func", None)
    if func is None:
        parser.print_help()
        return 2
    try:
        return int(func(args))
    except ResumeRefused as refused:  # defensive — subcommands catch their own
        print("REFUSED (%s): %s" % (refused.reason, refused.detail))
        return 4
    except Exception as exc:  # noqa: BLE001
        print("journal_cli internal error: %s: %s" % (type(exc).__name__, exc))
        return 2


if __name__ == "__main__":
    sys.exit(main())
