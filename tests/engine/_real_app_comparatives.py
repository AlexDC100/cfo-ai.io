"""The comparatives route on the REAL app, over the tenancy double — shared
by the route gate and the capture script.

`test_comparatives_route_real_app.py` gates `GET /api/period/{id}/comparatives`
un-intercepted; `scripts/capture_comparatives_pair.py --current/--prior`
drives the very same world for an owner's local books (offline, never
committed). One module, so the capture a local walk renders is produced by
exactly the path the gate proves.

What is real: `engine.api.create_app()` (the object `python -m engine serve`
runs), every route, middleware and wall on the request path, the production
write seam each book is carried through (parse -> `stage_map` ->
`stage_persist`), and ES256 bearer verification (the double's session JWKS).
What is doubled: PostgREST (`firm_postgrest_double.PostgrestDouble`, which
refuses a table or column no migration declares) and the network.
"""
from __future__ import annotations

import contextlib
import copy
import glob
import hashlib
import re
import types
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Sequence, Tuple

import firm_postgrest_double as D

REPO = Path(__file__).resolve().parents[2]

#: The tables the route and the get_period calls inside it read that the
#: double does not declare itself.
EXTRA_TABLES = ("memberships", "calculated_metrics", "documents", "briefings",
                "recommendations", "alerts", "org_coa_mappings_overrides")

_ALTER_RX = re.compile(r"alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?(\w+)\s+(.*?);", re.I | re.S)
_ADD_RX = re.compile(r"add\s+column\s+(?:if\s+not\s+exists\s+)?(\w+)", re.I)


def migration_columns() -> Dict[str, List[str]]:
    """`create table` columns (the double's own parser) plus every `alter
    table … add column` in `supabase/*.sql`, comments stripped, for
    `EXTRA_TABLES`."""
    cols: Dict[str, List[str]] = {}
    for path in sorted(glob.glob(str(REPO / "supabase" / "*.sql"))):
        text = Path(path).read_text(encoding="utf-8")
        for table, names in D.parse_table_columns(text).items():
            have = cols.setdefault(table, [])
            have += [n for n in names if n not in have]
        bare = "\n".join(line.split("--", 1)[0] for line in text.splitlines())
        for m in _ALTER_RX.finditer(bare):
            have = cols.setdefault(m.group(1).lower(), [])
            have += [n for n in _ADD_RX.findall(m.group(2)) if n not in have]
    out = {t: cols[t] for t in EXTRA_TABLES if t in cols}
    # `valuations` and `user_valuation_assumptions` are read by get_period
    # and exist in production, but no migration in this repository creates
    # either (schema_phase6_dedupe.sql only names them): declared with the
    # columns the route filters on and nothing more, so the double still
    # refuses any other projection.
    out.setdefault("valuations", ["id", "period_id", "org_id"])
    out.setdefault("user_valuation_assumptions", ["user_id", "period_id"])
    return out


def build_app():
    """`create_app()` with a test-manifest Supabase URL, boot verification
    skipped, and no test-mode bypass, scheduler token or model key."""
    import pytest

    mp = pytest.MonkeyPatch()
    try:
        mp.setenv("VITE_SUPABASE_URL", "https://test.supabase.co")
        mp.setenv("VITE_SUPABASE_ANON_KEY", "test-anon")
        mp.setenv("SUPABASE_SERVICE_ROLE_KEY", "test-service")
        mp.setenv("CFO_AI_SKIP_BOOT_VERIFY", "1")
        for key in ("PUBLIC_TEST_MODE", "ENGINE_TEST_MODE", "ENGINE_API_TOKEN", "ANTHROPIC_API_KEY"):
            mp.delenv(key, raising=False)
        from engine.api.server import create_app
        return create_app(config_path=REPO / "config.yaml")
    finally:
        mp.undo()


def book_from_workbook(path: Path, *, period_end: str, industry: Optional[str] = None,
                       key: str = "") -> Any:
    """One trial balance carried through the REAL production write path —
    parse -> `stage_map` -> `stage_persist` over the fake persist seam — the
    steps `test_rebuild_net_income_anchor._Book` runs for a corpus case,
    for a workbook at any path. Exposes what a served route reads back."""
    import test_rebuild_net_income_anchor as ANCHOR
    from engine.api import pipeline as P

    replay = ANCHOR.corpus_replay
    pack = replay.get_pack("RO")
    content = path.read_bytes()
    tb_rows = (pack.parse_trial_balance_csv(content, path.name) if path.suffix.lower() == ".csv"
               else pack.parse_trial_balance(content, path.name))
    _tb, shaped, _assembled = pack.assemble_parsed_tb(tb_rows, company_name=path.stem,
                                                      period_label="Imported period")
    doc = {"id": "doc-%s" % (key or hashlib.sha256(content).hexdigest()[:12]),
           "org_id": "org-local", "original_filename": path.name,
           "content_hash": "sha256-%s" % hashlib.sha256(content).hexdigest(),
           "period_end_hint": period_end}
    parsed = P._deterministic_tb_parsed(doc, tb_rows, shaped,
                                        pack.compute_statutory_net_profit_anchor(tb_rows),
                                        pack.compute_source_imbalance(tb_rows))
    assembled = P.stage_map(doc, parsed, industry)
    with replay.fake_persist_seam() as fake:
        period_id = P.stage_persist(doc, parsed, assembled)
        line_items = [dict(r) for r in fake.inserted_line_items]
        period = dict(fake.period_rows[0])
    return types.SimpleNamespace(period=period, line_items=line_items, period_id=period_id,
                                 persist_assembled=assembled)


def metric_rows(app, double, period_id: str, org_id: str, bearer: str) -> List[Dict[str, Any]]:
    """The rows `stage_compute` persists for an analysed period: the
    credit-model rows over the statements the route serves for it."""
    from engine.ratios.credit_model import compute_period_metrics

    resp = get(app, "/api/period/%s" % period_id, bearer, org_id)
    assert resp.status_code == 200, (resp.status_code, resp.text[:400])
    body = resp.json()
    return [dict(m, period_id=period_id, org_id=org_id)
            for m in compute_period_metrics(copy.deepcopy(body["statements"]))]


def seed_double(*, orgs: Sequence[Dict[str, Any]], memberships: Sequence[Dict[str, Any]],
                periods: Sequence[Tuple[Any, str, str, str, str]]) -> D.PostgrestDouble:
    """A double holding `orgs`, `memberships` and one financial_periods row
    per `(book, period_id, org_id, period_start, period_end)`, each with the
    book's persisted envelope and line items. Only declared columns are
    written (the double refuses any other)."""
    double = D.PostgrestDouble(columns=migration_columns())
    for org in orgs:
        double.add("organizations", dict(org))
    for m in memberships:
        double.add("memberships", dict(m))
    fp_cols = set(double.columns["financial_periods"])
    li_cols = set(double.columns["statement_line_items"])
    for bk, pid, org_id, start, end in periods:
        row = {k: v for k, v in bk.period.items() if k in fp_cols}
        row.update(id=pid, org_id=org_id, period_start=start, period_end=end)
        double.add("financial_periods", row)
        for li in bk.line_items:
            double.add("statement_line_items", {k: v for k, v in dict(li, period_id=pid).items() if k in li_cols})
    return double


def seed_metrics(app, double, period_ids: Sequence[str], org_id: str, bearer: str) -> None:
    """Persist each period's analysed metric rows, as `stage_compute` does."""
    mcols = set(double.columns["calculated_metrics"])
    for pid in period_ids:
        for m in metric_rows(app, double, pid, org_id, bearer):
            double.add("calculated_metrics", {k: v for k, v in m.items() if k in mcols})


@contextlib.contextmanager
def installed(double: D.PostgrestDouble) -> Iterator[None]:
    """`_supabase.per_user` / `_supabase.admin` -> the double, and bearer
    verification against the session's test JWKS, for the duration."""
    import pytest

    from engine.api import _supabase

    mp = pytest.MonkeyPatch()
    try:
        mp.setattr(_supabase, "per_user", lambda jwt: double)
        mp.setattr(_supabase, "admin", lambda: double)
        D.install_test_jwks(mp)
        yield
    finally:
        mp.undo()


def get(app, path: str, bearer: str, org: str = ""):
    from fastapi.testclient import TestClient

    headers = {"Authorization": "Bearer " + bearer}
    if org:
        headers["X-Org-Id"] = org
    return TestClient(app, raise_server_exceptions=False).get(path, headers=headers)
