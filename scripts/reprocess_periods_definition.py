#!/usr/bin/env python3
"""Deterministic reprocessing of stored periods under the ONE EBITDA
definition (owner ruling 2026-09-26; design A9 "Deploy").

WHY. Net 711 ("Variația stocurilor de produse") and net 72x are measured
from the trial balance's own rows at PERSIST time (the stock-variation
evidence block, `assembled_canonical_v1.stock_variation`), and the
methodology block carries the one EBITDA only when it was evaluated under
the ruling (`methodology.ebitda_definition`). A period persisted before the
change has neither: every served view refuses its EBITDA
(`period_predates_stock_variation_measurement` /
`period_predates_ebitda_definition`) until it is re-run from its stored
document. This tool re-runs it — with the engine's OWN pipeline stages,
nothing re-implemented.

WHAT IT RUNS, per period (the stages `_run_pipeline_stages` runs, minus
the model):
  stage_extract → stage_map → stage_persist → stage_compute (+ the account-
  121 metric override) → stage_validate → the alerts write → valuation.
NOT run: stage_narrate and stage_council (both call the model), and no
quota path (`_usage_gate`) is touched — a correction of an analysed
document is free. The stored briefing and the model-written
recommendations are left as they are: the briefing is served with the
definition it was written under and the page hides a pre-ruling one;
council alerts on the period are carried over unchanged.

NO MODEL, EVER. For the duration of a period's run the Anthropic SDK is
replaced by a guard whose constructor raises, and ANTHROPIC_API_KEY holds a
placeholder (the xlsx branch of stage_extract asks for a key before it
reads the file; nothing can use it). A period whose run so much as
constructs a client — a scanned PDF, an image, a document the
deterministic readers refuse, an AI lane — is REFUSED (`needs_model`) and
nothing of it is written.

REFUSED, never written (the reason printed):
  needs_model            the run reached for the model
  document_missing       no live source document row
  not_a_trial_balance    the extraction produced no accounts
  period_end_moved       the stored document now resolves to another month
                         (a write would stage a same-month takeover)
  period_mismatch        stage_persist resolved a different period row
  extract_failed         the deterministic readers raised

DRY RUN (the default) prints, per period: anchor status, book state, net
711 (+ provenance or refusal), net 72x, turnover before/after, EBITDA
before (the stored methodology `ebitda.reported` — the pre-ruling figure on
an unstamped block) and after, the credit composite / letter / Altman
Z'' before (the stored metric rows) and after (the credit model on the
fresh statements), and the stored `valuations` row's `ebitda_used` (and
primary method) against the one the rewrite persists (the one EBITDA, or
refused). Nothing is written.

THE VALUATIONS ROW (critic, 2026-09-27). Production's `valuations` table
held six rows the engine wrote under the previous definition (9507d2ee
54,534,488.97; ce72e080 54,443,833.33; fc85d50d 220,162.84; b1aa4152
2,127,403.70; 06ffa6e8 -29,038,838.12 asset-based; 267eefaa
10,207,627.66). The apply rewrites it through the pipeline's own
`_compute_and_persist_valuation` (no user override: the engine's row); a
period whose row's `ebitda_used` is neither the fresh EBITDA nor the user's
saved override is never `current`. User overrides
(`user_valuation_assumptions`) are the user's and are not touched — GET
/api/period serves them flagged "salvat sub definiția anterioară a EBITDA"
when typed under the previous definition.

TURNOVER MOVES BLOCK THE DEPLOY (design A10). A period persisted by an older
parser can read a different turnover now (Carniprod 7c29a71b served
99,424,740.16 where the filing says 94,509,940). Every turnover change is
flagged; `--filed <period_id>=<turnover>` names a known filed figure, and a
change that does not move toward it — or any change with no filed figure —
makes the exit code 3 unless `--allow-turnover-change` is given.

IDEMPOTENT. A period whose stored envelope already carries the evidence
blocks (stock variation AND the class-3 inventory_stock evidence the
inventory-days block reads — owner spec 2026-09-26 P1), the current
definition stamp and the RUNNING parser's stamp (G7 — the serve path
refuses 711 on any other reader), and whose fresh run reproduces its stored
turnover, EBITDA, inventory days (dio) and composite, is `current` and is
not rewritten (`--force` rewrites it anyway). The dry run prints the stored
reader beside the running one, and inventory days before -> after with the
served basis.

Usage (inside the backend container, per CLAUDE.md §14):
  python3 scripts/reprocess_periods_definition.py                 # dry run, every period
  python3 scripts/reprocess_periods_definition.py --org <uuid>    # one workspace
  python3 scripts/reprocess_periods_definition.py --period <uuid> # one period
  python3 scripts/reprocess_periods_definition.py --apply         # write
  python3 scripts/reprocess_periods_definition.py --json out.json # the rows as JSON

Python 3.9 — no `match`, no `X | Y`.
"""
from __future__ import annotations

import argparse
import contextlib
import json
import os
import sys
import types
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Sequence, Tuple


def _find_repo_root() -> Path:
    here = Path(__file__).resolve().parent
    for candidate in [here] + list(here.parents)[:6]:
        if (candidate / "pyproject.toml").is_file():
            return candidate
    return here.parent


REPO = _find_repo_root()
if str(REPO / "src") not in sys.path:
    sys.path.insert(0, str(REPO / "src"))

#: The run states a period can end in.
CURRENT = "current"
WOULD_REPROCESS = "would_reprocess"
REPROCESSED = "reprocessed"
REFUSED = "refused"

#: Alert keys this tool carries over rather than recomputes (written by the
#: model-backed council, which this tool never runs).
_CARRIED_ALERT_PREFIXES = ("ai_council::",)

_KEY_PLACEHOLDER = "reprocess-no-model"


class ModelRefused(RuntimeError):
    """The run reached for the model; the period is refused."""


class _ModelGuard(object):
    """Replace the Anthropic SDK for one period's run. Every construction is
    counted and refused, so a stage that swallows the exception still
    leaves a count behind — and a counted period is never written."""

    def __init__(self) -> None:
        self.calls = 0  # type: int

    @contextlib.contextmanager
    def installed(self) -> Iterator["_ModelGuard"]:
        guard = self

        class _Refusing(object):
            def __init__(self, *a: Any, **kw: Any) -> None:
                guard.calls += 1
                raise ModelRefused("reprocess_periods_definition never calls the model")

        stub = types.ModuleType("anthropic")
        stub.Anthropic = _Refusing  # type: ignore[attr-defined]
        stub.AsyncAnthropic = _Refusing  # type: ignore[attr-defined]
        stub.APIStatusError = ModelRefused  # type: ignore[attr-defined]
        stub.APIError = ModelRefused  # type: ignore[attr-defined]
        saved_mod = sys.modules.get("anthropic")
        saved_key = os.environ.get("ANTHROPIC_API_KEY")
        sys.modules["anthropic"] = stub
        os.environ["ANTHROPIC_API_KEY"] = _KEY_PLACEHOLDER
        try:
            yield self
        finally:
            if saved_mod is None:
                sys.modules.pop("anthropic", None)
            else:
                sys.modules["anthropic"] = saved_mod
            if saved_key is None:
                os.environ.pop("ANTHROPIC_API_KEY", None)
            else:
                os.environ["ANTHROPIC_API_KEY"] = saved_key


# ── reading what is stored ─────────────────────────────────────────────


def _num(v: Any) -> Optional[float]:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return float(v)


def _stored_view(period: Dict[str, Any], metric_rows: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """What the period serves from storage today."""
    from engine.country_packs.ro_romania.chart_of_accounts import EBITDA_DEFINITION_REVISION
    from engine.country_packs.ro_romania.trial_balance_parser import PARSER_VERSION
    from engine.ratios import credit_model

    env = period.get("assembled_canonical_v1")
    env = env if isinstance(env, dict) else {}
    evidence = env.get("stock_variation") if isinstance(env.get("stock_variation"), dict) else {}
    stored_reader = evidence.get("parser_version")
    methodology = env.get("methodology") if isinstance(env.get("methodology"), dict) else {}
    ebitda = (methodology.get("ebitda") or {}) if isinstance(methodology.get("ebitda"), dict) else {}
    totals = (methodology.get("totals") or {}) if isinstance(methodology.get("totals"), dict) else {}
    by_name = dict((str(m.get("name")), m.get("value")) for m in metric_rows)
    composite = _num(by_name.get("credit_composite"))
    return {
        "has_evidence": isinstance(env.get("stock_variation"), dict),
        # G7 (design A10): the serve path folds the 121 residual into 711
        # only when the stored rows were read by the RUNNING trial-balance
        # parser; otherwise every EBITDA-built figure refuses with
        # `reprocess_required`. A stale stamp is therefore never `current`,
        # whatever the stored methodology figures say (they were written at
        # persist time and still agree with a fresh run).
        "parser_version": stored_reader,
        "running_parser_version": PARSER_VERSION,
        "parser_current": stored_reader is not None and stored_reader == PARSER_VERSION,
        # The class-3 opening/closing evidence the inventory-days block reads
        # (owner spec 2026-09-26 P1). A period without it serves the
        # period-end snapshot only, until it is reprocessed.
        "has_inventory_evidence": isinstance(env.get("inventory_stock"), dict),
        "dio": _num(by_name.get("dio")),
        "definition": methodology.get("ebitda_definition"),
        "definition_current": methodology.get("ebitda_definition") == EBITDA_DEFINITION_REVISION,
        "turnover": _num(totals.get("revenue_net")),
        "ebitda": _num(ebitda.get("reported")),
        "composite": composite,
        "letter": credit_model.composite_to_letter_grade(composite),
        "altman_z": _num(by_name.get("altman_z_score")),
    }


def _fresh_view(assembled: Dict[str, Any]) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    """What the fresh run would serve, and the metric rows it would write."""
    from engine.ratios import credit_model

    statements = assembled.get("statements") or {}
    pl = statements.get("assembled_pl") or {}
    iv = pl.get("inventory_variation") if isinstance(pl.get("inventory_variation"), dict) else {}
    cap = pl.get("capitalized_own_work") if isinstance(pl.get("capitalized_own_work"), dict) else {}
    metrics = credit_model.compute_period_metrics(
        statements, source_data_quality=assembled.get("source_data_quality"))
    by_name = dict((str(m.get("name")), m.get("value")) for m in metrics)
    composite = _num(by_name.get("credit_composite"))
    refusal = iv.get("refusal") if isinstance(iv.get("refusal"), dict) else None
    inv = statements.get("inventory_days") if isinstance(statements.get("inventory_days"), dict) else {}
    inv_total = inv.get("total") if isinstance(inv.get("total"), dict) else {}
    return {
        "dio": _num(by_name.get("dio")),
        "inventory_days_basis": inv.get("basis"),
        "inventory_days_refusal": ((inv_total.get("reason") or {}).get("code")
                                   if isinstance(inv_total.get("reason"), dict) else None),
        "anchor_status": pl.get("net_income_anchor_status"),
        "book_state": iv.get("book_state"),
        "net_711": _num(iv.get("value")),
        "net_711_provenance": iv.get("provenance"),
        "net_711_refusal": (refusal or {}).get("code"),
        "net_72x": _num(cap.get("value")),
        "turnover": _num(pl.get("turnover", pl.get("revenue"))),
        "ebitda": _num(pl.get("ebitda")),
        "ebitda_refusal": ((pl.get("ebitda_refusal") or {}).get("code")
                           if isinstance(pl.get("ebitda_refusal"), dict) else None),
        "composite": composite,
        "letter": credit_model.composite_to_letter_grade(composite),
        "altman_z": _num(by_name.get("altman_z_score")),
    }, metrics


def _stored_valuation(valuation_row: Optional[Dict[str, Any]],
                      user_rows: Optional[List[Dict[str, Any]]]) -> Dict[str, Any]:
    """The stored `valuations` row as the rewrite judges it: its
    `ebitda_used` and primary method, and the saved EBITDA override it was
    persisted on (a user's figure — a row persisted on it is that user's,
    not stale).

    `user_valuation_assumptions` holds one row PER USER per period, so
    EVERY member's row is considered — never "the first row of the period"
    (tenancy hotfix 2026-10-02): the override reported is the one the stored
    row equals, else the first saved one. Since that hotfix the PUT route
    persists the ENGINE'S figures, so a row on a user's override can only be
    one written before it."""
    row = valuation_row or {}
    stored = _num(row.get("ebitda_used"))
    saved = [e for e in (_num((r or {}).get("ebitda_used")) for r in (user_rows or [])) if e is not None]
    on = next((e for e in saved if stored is not None and abs(stored - e) < 0.005), None)
    return {"has_row": bool(valuation_row),
            "ebitda_used": stored,
            "primary_method": row.get("primary_method"),
            "user_ebitda": on if on is not None else (saved[0] if saved else None)}


def _valuation_current(stored: Dict[str, Any], fresh_ebitda: Optional[float]) -> bool:
    """A period with no stored row has nothing to rewrite; a stored row is
    current when its `ebitda_used` is the fresh one EBITDA (both None on a
    refused EBITDA) or the user's saved override."""
    if not stored.get("has_row"):
        return True
    if stored.get("user_ebitda") is not None and _same(stored.get("ebitda_used"), stored["user_ebitda"]):
        return True
    return _same(stored.get("ebitda_used"), fresh_ebitda)


def _same(a: Optional[float], b: Optional[float]) -> bool:
    if a is None or b is None:
        return a is None and b is None
    return abs(a - b) < 0.005


def _turnover_verdict(before: Optional[float], after: Optional[float],
                      filed: Optional[float]) -> Optional[str]:
    """None when turnover did not move; otherwise 'toward_filed',
    'away_from_filed' or 'no_filed_figure'."""
    if _same(before, after):
        return None
    if filed is None or before is None or after is None:
        return "no_filed_figure"
    return "toward_filed" if abs(after - filed) < abs(before - filed) else "away_from_filed"


# ── one period ─────────────────────────────────────────────────────────


def reprocess_period(period: Dict[str, Any], *, apply: bool, force: bool = False,
                     filed_turnover: Optional[float] = None) -> Dict[str, Any]:
    """Plan (and with `apply`, write) one period. Returns the report row."""
    from engine.api import _supabase
    from engine.api import pipeline as P

    row = {"period_id": period["id"], "org_id": period.get("org_id"),
           "period_end": str(period.get("period_end") or "")[:10],
           "status": None, "reason": None}  # type: Dict[str, Any]

    with _supabase.admin() as client:
        docs = client.select("documents",
                             filters={"id": "eq.%s" % period.get("source_document_id")},
                             single=True) if period.get("source_document_id") else []
        doc = docs[0] if docs else None
        metric_rows = client.select("calculated_metrics",
                                    filters={"period_id": "eq.%s" % period["id"]}) or []
        org_rows = client.select("organizations",
                                 filters={"id": "eq.%s" % period.get("org_id")},
                                 single=True) or []
        valuation_rows = client.select("valuations",
                                       filters={"period_id": "eq.%s" % period["id"]}) or []
        user_rows = client.select("user_valuation_assumptions",
                                  filters={"period_id": "eq.%s" % period["id"]}) or []
    org = org_rows[0] if org_rows else {"id": period.get("org_id")}
    row["before"] = _stored_view(period, metric_rows)
    row["valuation"] = _stored_valuation(valuation_rows[0] if valuation_rows else None, user_rows)
    if doc is None or doc.get("deleted_at"):
        row.update(status=REFUSED, reason="document_missing")
        return row

    guard = _ModelGuard()
    try:
        with guard.installed():
            parsed = P.stage_extract(doc)
            assembled = P.stage_map(doc, parsed, org.get("industry_display_name") or org.get("industry_key"))
    except ModelRefused:
        row.update(status=REFUSED, reason="needs_model")
        return row
    except Exception as exc:  # noqa: BLE001 — reported, never guessed
        row.update(status=REFUSED, reason="needs_model" if guard.calls else "extract_failed",
                   detail="%s: %s" % (type(exc).__name__, str(exc)[:200]))
        return row
    if guard.calls:
        row.update(status=REFUSED, reason="needs_model")
        return row
    if not (parsed or {}).get("accounts"):
        row.update(status=REFUSED, reason="not_a_trial_balance")
        return row

    resolved_end, _why = P.resolve_period_end_for_persist(doc, parsed)
    # The inventory-days block the write would build (stage_persist builds it
    # once the period end sets the day count) — the SAME helper, on a copy of
    # the envelope, so the plan's metric rows are the ones the write persists.
    _env = assembled.get("assembled_canonical_v1")
    if isinstance(_env, dict):
        P._attach_inventory_days_at_persist(
            assembled, dict(_env, period_detection=_why), resolved_end)

    after, _metrics = _fresh_view(assembled)
    row["after"] = after
    row["turnover_move"] = _turnover_verdict(row["before"]["turnover"], after["turnover"], filed_turnover)
    row["filed_turnover"] = filed_turnover

    if str(resolved_end)[:10] != row["period_end"]:
        row.update(status=REFUSED, reason="period_end_moved", resolved_end=str(resolved_end)[:10])
        return row

    before = row["before"]
    # The row the rewrite persists carries the fresh one EBITDA (or None:
    # refused) — `_compute_and_persist_valuation` with no user override.
    row["valuation"]["ebitda_used_after"] = after["ebitda"]
    row["valuation"]["current"] = _valuation_current(row["valuation"], after["ebitda"])
    current = (before["has_evidence"] and before["definition_current"]
               and before["parser_current"]
               and before["has_inventory_evidence"]
               and _same(before["dio"], after["dio"])
               and _same(before["turnover"], after["turnover"])
               and _same(before["ebitda"], after["ebitda"])
               and _same(before["composite"], after["composite"])
               and row["valuation"]["current"])
    if current and not force:
        row.update(status=CURRENT)
        return row
    if not apply:
        row.update(status=WOULD_REPROCESS)
        return row

    # ── WRITE: the pipeline's own stages, the model still guarded ──────
    with _supabase.admin() as client:
        carried = [a for a in (client.select("alerts", filters={"period_id": "eq.%s" % period["id"]}) or [])
                   if str(a.get("alert_key") or "").startswith(_CARRIED_ALERT_PREFIXES)]
    with guard.installed():
        period_id = P.stage_persist(doc, parsed, assembled)
        if period_id != period["id"]:
            # stage_persist resolved another row: nothing more is written
            # against it, and the row is reported for the operator.
            row.update(status=REFUSED, reason="period_mismatch", resolved_period=period_id)
            return row
        P.stage_compute(doc, assembled, period_id)
        P._override_statutory_net_income_metric(doc, period_id, parsed)
        alerts = list(P.stage_validate(doc, assembled, period_id))
        for a in carried:
            payload = a.get("payload") if isinstance(a.get("payload"), dict) else {}
            alerts.append({"alert_key": a.get("alert_key"), "severity": a.get("severity"),
                           "category": a.get("category"), "title": a.get("title"),
                           "body": a.get("body"), "rule_key": payload.get("rule_key"),
                           "facts_cited": payload.get("facts_cited"),
                           "industry": payload.get("industry")})
        with _supabase.admin() as client:
            P._persist_period_alerts(client, doc["org_id"], doc["id"], period_id, alerts)
        P._compute_and_persist_valuation(doc, org, assembled, period_id)
        # READ BACK the valuations row (critic round 3, 2026-09-28):
        # `_compute_and_persist_valuation` swallows its failures as
        # non-fatal, so an apply that could not rewrite the row still said
        # REPROCESSED over a row on the previous EBITDA. The row must now
        # carry the fresh one EBITDA — None on a refused one.
        with _supabase.admin() as client:
            vrows = client.select("valuations", filters={"period_id": "eq.%s" % period_id}) or []
        v_after = vrows[0].get("ebitda_used") if vrows else None
        if not vrows or not _same(v_after, after["ebitda"]):
            row["valuation"]["ebitda_used_read_back"] = v_after
            row["valuation"]["row_read_back"] = bool(vrows)
            row.update(status=REFUSED, reason="valuation_not_rewritten")
            return row
    if guard.calls:
        # A write-path stage reached for the model after the plan did not.
        # Everything above is deterministic; say so rather than hide it.
        row["model_calls_refused_during_write"] = guard.calls
    row.update(status=REPROCESSED)
    return row


# ── the run ────────────────────────────────────────────────────────────


def select_periods(org: Optional[str] = None, period: Optional[str] = None) -> List[Dict[str, Any]]:
    from engine.api import _supabase

    filters = {}  # type: Dict[str, str]
    if org:
        filters["org_id"] = "eq.%s" % org
    if period:
        filters["id"] = "eq.%s" % period
    with _supabase.admin() as client:
        rows = client.select("financial_periods", filters=filters, order="period_end.asc") or []
    return [r for r in rows if r.get("source_document_id")]


def run(*, apply: bool, org: Optional[str] = None, period: Optional[str] = None,
        force: bool = False, filed: Optional[Dict[str, float]] = None) -> List[Dict[str, Any]]:
    out = []  # type: List[Dict[str, Any]]
    for p in select_periods(org, period):
        out.append(reprocess_period(p, apply=apply, force=force,
                                    filed_turnover=(filed or {}).get(str(p["id"]))))
    return out


def _fmt(v: Any) -> str:
    if v is None:
        return "—"
    if isinstance(v, float):
        return format(v, ",.2f")
    return str(v)


def render(rows: Sequence[Dict[str, Any]]) -> str:
    lines = []  # type: List[str]
    for r in rows:
        b, a = r.get("before") or {}, r.get("after") or {}
        lines.append("%s  %s  %s%s" % (r["period_id"], r["period_end"], r["status"],
                                       (" (%s)" % r["reason"]) if r.get("reason") else ""))
        if a:
            lines.append("  anchor %s · book %s · net 711 %s (%s) · net 72x %s"
                         % (a.get("anchor_status"), a.get("book_state"), _fmt(a.get("net_711")),
                            a.get("net_711_provenance") or a.get("net_711_refusal"),
                            _fmt(a.get("net_72x"))))
            lines.append("  reader %s -> %s%s" % (
                b.get("parser_version") or "unstamped", b.get("running_parser_version") or "—",
                "" if b.get("parser_current") else "  [G7: served as reprocess_required until rewritten]"))
            lines.append("  turnover %s -> %s%s" % (_fmt(b.get("turnover")), _fmt(a.get("turnover")),
                                                    ("  [TURNOVER MOVED: %s]" % r["turnover_move"])
                                                    if r.get("turnover_move") else ""))
            lines.append("  EBITDA %s -> %s%s" % (_fmt(b.get("ebitda")), _fmt(a.get("ebitda")),
                                                 (" (refused: %s)" % a["ebitda_refusal"])
                                                 if a.get("ebitda_refusal") else ""))
            lines.append("  inventory days %s -> %s (%s%s)"
                         % (_fmt(b.get("dio")), _fmt(a.get("dio")), a.get("inventory_days_basis") or "—",
                            (", refused: %s" % a["inventory_days_refusal"])
                            if a.get("inventory_days_refusal") else ""))
            lines.append("  credit %s %s z %s -> %s %s z %s"
                         % (_fmt(b.get("composite")), b.get("letter") or "—", _fmt(b.get("altman_z")),
                            _fmt(a.get("composite")), a.get("letter") or "—", _fmt(a.get("altman_z"))))
            v = r.get("valuation") or {}
            if v.get("has_row"):
                lines.append("  valuation EBITDA %s (%s) -> %s%s%s" % (
                    _fmt(v.get("ebitda_used")), v.get("primary_method") or "—",
                    _fmt(v.get("ebitda_used_after")),
                    (" (refused: %s)" % a["ebitda_refusal"]) if a.get("ebitda_refusal") else "",
                    "" if v.get("current") else "  [STORED ROW ON ANOTHER EBITDA: rewritten on apply]"))
                if v.get("user_ebitda") is not None:
                    lines.append("  user override EBITDA %s (the user's; not rewritten)"
                                 % _fmt(v.get("user_ebitda")))
    return "\n".join(lines)


def blocking(rows: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The rows whose turnover moved other than toward a known filed figure."""
    return [r for r in rows if r.get("turnover_move") not in (None, "toward_filed")]


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--apply", action="store_true", help="write (default: dry run)")
    ap.add_argument("--org")
    ap.add_argument("--period")
    ap.add_argument("--force", action="store_true", help="rewrite periods that are already current")
    ap.add_argument("--filed", action="append", default=[],
                    help="<period_id>=<filed turnover>, repeatable")
    ap.add_argument("--allow-turnover-change", action="store_true")
    ap.add_argument("--json", help="write the rows as JSON to this path")
    args = ap.parse_args(argv)
    filed = {}  # type: Dict[str, float]
    for item in args.filed:
        pid, _, value = item.partition("=")
        filed[pid.strip()] = float(value)

    blocked_before_apply = []  # type: List[Dict[str, Any]]
    if args.apply and not args.allow_turnover_change:
        # The turnover check runs on the dry-run rows BEFORE anything is
        # written — a moved turnover blocks the whole apply.
        blocked_before_apply = blocking(run(apply=False, org=args.org, period=args.period,
                                            force=args.force, filed=filed))
        if blocked_before_apply:
            print(render(blocked_before_apply))
            print("\nBLOCKED: %d period(s) move turnover other than toward a known filed "
                  "figure; nothing was written. Re-run with --filed or "
                  "--allow-turnover-change once each move is ruled." % len(blocked_before_apply))
            return 3
    rows = run(apply=args.apply, org=args.org, period=args.period, force=args.force, filed=filed)
    print(render(rows))
    counts = {}  # type: Dict[str, int]
    for r in rows:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    print("\n%s: %s" % ("APPLY" if args.apply else "DRY RUN",
                        ", ".join("%s %d" % kv for kv in sorted(counts.items())) or "no periods"))
    if args.json:
        Path(args.json).write_text(json.dumps(rows, indent=1, sort_keys=True, ensure_ascii=False),
                                   encoding="utf-8")
    if not args.apply and blocking(rows) and not args.allow_turnover_change:
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
