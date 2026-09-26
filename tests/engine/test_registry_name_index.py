"""THE REGISTRY'S NAMES ARE NORMALIZED ONCE — not on every upload.

Live walkthrough, 2026-09-26: identify took ~20 s on a 149 KB SAGA .xls and
~15 s on a 20 KB .xlsx in production. Profiled: 97% of it was
`company_identity._normalized_name_index` pushing EVERY registered name
(~1M) through `normalize_company_name`, because the upload route opens a new
registry per request and the map was memoised per registry OBJECT — every
identify, and the commit after it, rebuilt it. The map is now persisted
beside the registry (`engine.workspaces.registry_names`) and read with one
indexed query per name; it is rebuilt only when the registry's names (or
the normalizer) change.

WHAT IT REDS ON (with the fix in place):
  · a request that re-normalizes the registry when its names have not
    changed (the latency defect itself, counted — not timed);
  · the persisted map answering anything the in-memory map would not
    (exactly one / several / none — the identity rules ride on it);
  · a registry rename, or a changed normalizer, still served from the old
    map;
  · a map built while the registry was changing being persisted;
  · a registry that cannot say where it lives or what its names are (a test
    double) being indexed on disk instead of in memory;
  · the operator CLI's ident, or the server's start, leaving the map stale.

Real `PublicRoStore`s on tmp SQLite; invented names and CUIs. Python 3.9.
"""
from __future__ import annotations

import itertools
from pathlib import Path
from typing import Any

import pytest

from engine.public_ro.store import PublicRoStore
from engine.workspaces import company_identity as CI
from ws_migration_fixture import balance_xlsx, valid_cui


@pytest.fixture
def RN():
    from engine.workspaces import registry_names

    return registry_names

ROOTS = ("ALFA", "BETA", "GAMA", "DELTA", "OMEGA", "NOVA", "TERRA", "AGRO", "CARPAT", "DUNAREA")
KINDS = ("FOOD", "GRUP", "TRADING", "LOGISTIC", "DESIGN", "CONSULT", "IMPEX", "BUILD", "FARM", "SOFT")
FORMS = ("SRL", "S.R.L.", "SA", "S.A.")


def _company(store: PublicRoStore, cui: str, name: str) -> None:
    store.set_identification(int(cui), name=name, county="SB", locality="Sibiu", reg_number="J32/1/2000",
                             tip_contrib="PJ", publishable=True, name_source="test")
    store.ensure_company_stub(int(cui), "1013")
    store.upsert_filing(cui=int(cui), year=2024, family="UU", dataset_id="ds-test", indicators={},
                        total_assets=1, net_result=1, caen="1013")


def _registry(path: Path, n: int = 2000) -> PublicRoStore:
    """`n` invented companies, among them punctuation and diacritic variants
    of one name (ambiguous once normalized) and one unique name."""
    store = PublicRoStore(path)
    names = itertools.cycle("%s %s %d %s" % (r, k, i, f) for i, (r, k, f) in
                            enumerate(itertools.product(ROOTS, KINDS, FORMS)))
    for i in range(n):
        store.set_identification(int(valid_cui(str(5000000 + i))), name=next(names) + " %d" % i, county="B",
                                 locality="B", reg_number="J40/%d/2010" % i, tip_contrib="PJ",
                                 publishable=False, name_source="test")
    _company(store, valid_cui("3100001"), "ALFA FOOD SRL")
    _company(store, valid_cui("3100002"), "ALFA-FOOD S.R.L.")          # the same name, normalized
    _company(store, valid_cui("3100003"), "ȘTEFĂNESCU AGRO S.R.L.")      # diacritics
    _company(store, valid_cui("4000003"), "GAMMA' AGRO SRL")
    return store


_REAL = CI.normalize_company_name


class _Counting(object):
    """`normalize_company_name`, counted (the same answers)."""

    def __init__(self) -> None:
        self.calls = 0

    def __call__(self, name: Any) -> str:
        self.calls += 1
        return _REAL(name)


def test_an_upload_never_renormalizes_an_unchanged_registry(tmp_path, monkeypatch):
    """The latency defect, counted rather than timed: two uploads, each
    opening its OWN registry object (as `_uploads._open_registry` does per
    request). The first may build the map; the second must not touch the
    registry's names at all — only the document's own few candidates."""
    path = tmp_path / "public_ro.db"
    _registry(path).close()
    if hasattr(CI, "normalizer_tag"):
        CI.normalizer_tag()   # the real normalizer's fingerprint, before it is counted
    counting = _Counting()
    monkeypatch.setattr(CI, "normalize_company_name", counting)
    book = balance_xlsx([], sheet="Gamma Agro")

    first = PublicRoStore(path)
    try:
        ident = CI.identify_document(book, "b.xlsx", registry=first)
    finally:
        first.close()
    assert ident.cui == valid_cui("4000003"), ident
    built = counting.calls
    assert built >= 2000, "the first upload never read the registry's names (%d)" % built

    counting.calls = 0
    second = PublicRoStore(path)
    try:
        again = CI.identify_document(book, "b.xlsx", registry=second)
    finally:
        second.close()
    assert again.cui == ident.cui
    assert counting.calls < 50, (
        "the second upload re-normalized the registry: %d names through the normalizer" % counting.calls)


def test_the_persisted_map_is_the_in_memory_map(RN, tmp_path):
    store = _registry(tmp_path / "public_ro.db")
    try:
        expected = RN.build_name_map(store.iter_company_names(), CI.normalize_company_name)
        persisted = RN.registry_name_index(store, CI.normalize_company_name, CI.normalizer_tag())
        assert isinstance(persisted, RN.PersistedNameIndex), type(persisted)
        assert len(persisted) == len(expected)
        for norm, cui in expected.items():
            assert persisted.get(norm) == cui, norm
        assert persisted.get("NO SUCH COMPANY") is None
        assert expected["ALFA FOOD"] == RN.AMBIGUOUS == persisted.get("ALFA FOOD")
        # The identity rules, through the persisted map.
        assert CI.registry_match_name(store, "Alfa Food SRL") is None                  # several
        hit = CI.registry_match_name(store, "Stefanescu Agro")                           # diacritics
        assert hit is not None and hit[0] == valid_cui("3100003"), hit
        assert CI.registry_match_name(store, "Gamma Agro")[0] == valid_cui("4000003")    # punctuation
    finally:
        store.close()


def test_a_renamed_company_is_never_answered_from_the_old_map(tmp_path):
    path = tmp_path / "public_ro.db"
    store = _registry(path)
    try:
        assert CI.registry_match_name(store, "Gamma Agro") is not None
    finally:
        store.close()
    store = PublicRoStore(path)
    try:
        store.set_identification(int(valid_cui("4000003")), name="ZETA MEAT SRL", county="SB", locality="Sibiu",
                                 reg_number="J32/1/2000", tip_contrib="PJ", publishable=True, name_source="test")
    finally:
        store.close()
    store = PublicRoStore(path)
    try:
        assert CI.registry_match_name(store, "Gamma Agro") is None
        assert CI.registry_match_name(store, "Zeta Meat")[0] == valid_cui("4000003")
    finally:
        store.close()


def test_another_normalizer_never_reads_this_ones_map(RN, tmp_path):
    store = _registry(tmp_path / "public_ro.db", n=50)
    try:
        first = RN.registry_name_index(store, CI.normalize_company_name, "tag-a")
        assert first.get("GAMMA AGRO") is not None
        upper_only = RN.registry_name_index(store, lambda s: str(s or "").upper(), "tag-b")
        assert upper_only.get("GAMMA AGRO") is None and upper_only.get("GAMMA' AGRO SRL") is not None
        assert RN.registry_name_index(store, CI.normalize_company_name, "tag-a").get("GAMMA AGRO") is not None
    finally:
        store.close()


def test_a_map_built_while_the_registry_changed_is_not_persisted(RN, tmp_path):
    class _Moving(object):
        path = tmp_path / "moving.db"
        _n = itertools.count()

        def names_fingerprint(self) -> str:
            return "state-%d" % next(self._n)

        def iter_company_names(self):
            return iter([(123, "ALFA SRL")])

    got = RN.registry_name_index(_Moving(), CI.normalize_company_name, "t")
    assert dict(got) == {"ALFA": 123}
    assert not RN.sidecar_path(_Moving.path).exists()


def test_a_registry_that_cannot_say_where_it_lives_is_indexed_in_memory(RN, tmp_path):
    class _Double(object):
        def iter_company_names(self):
            return iter([(123, "ALFA SRL"), (124, "ALFA S.R.L.")])

        def get_company(self, cui):
            return None

    assert RN.registry_name_index(_Double(), CI.normalize_company_name, "t") is None
    assert CI._normalized_name_index(_Double()) == {"ALFA": RN.AMBIGUOUS}
    assert list(tmp_path.iterdir()) == []


def test_the_server_start_and_the_ident_cli_leave_the_map_current(RN, tmp_path, monkeypatch):
    path = tmp_path / "public_ro.db"
    _registry(path, n=20).close()
    # The server's start: warmed in the background, from the default path.
    monkeypatch.setenv("PUBLIC_RO_DB_PATH", str(path))
    from engine.api import _uploads

    thread = _uploads.start_name_index_warmup()
    assert thread is not None
    thread.join(timeout=60)
    side = RN.sidecar_path(path)
    assert side.is_file()
    # The operator CLI's ident renames a company: the map is rebuilt before
    # the command returns, never by the next upload.
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "public_ingest_cli", str(Path(__file__).resolve().parents[2] / "scripts" / "public_ingest.py"))
    cli = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cli)  # type: ignore[union-attr]
    from test_public_ingest_fixes import _ident_bytes, _ident_row

    snapshot = tmp_path / "ident.txt"
    snapshot.write_bytes(_ident_bytes([_ident_row(int(valid_cui("4000003")), "SC ZETA MEAT SRL", "PJ", "J32")]))
    assert cli.main(["--db", str(path), "ident", "--path", str(snapshot)]) == 0
    store = PublicRoStore(path)
    try:
        live = "%s|%s" % (store.names_fingerprint(), CI.normalizer_tag())
        assert RN._recorded(side).get("fingerprint") == live, "the CLI left the map stale"
    finally:
        store.close()


def test_no_registry_no_warmup_and_nothing_created(tmp_path, monkeypatch):
    from engine.api import _uploads

    missing = tmp_path / "nope" / "public_ro.db"
    monkeypatch.setenv("PUBLIC_RO_DB_PATH", str(missing))
    assert _uploads.start_name_index_warmup() is None
    assert not missing.parent.exists()
