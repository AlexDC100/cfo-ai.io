"""Confirmed defects of the public-data acquisition lane (ingest /
identification / snapshot), each pinned by a test that FAILED first.

All offline: synthetic rows mirroring the VERIFIED data.gov.ro schemas
(bilanț ``CUI,CAEN,I1..I20`` ASCII/CRLF, empty = missing; identification
caret-delimited ISO-8859-2 2026 snapshot). No real party data — the CUIs
are placeholders.

  D1  derive_fields summed OVER A HOLE: I1 present with I2/I6 empty
      persisted a total only one component supports (ABSENT != ZERO).
  D2  a CUI reclassified PJ -> PF by a NEWER identification snapshot kept
      publishable=1 — re-classification could grant but never REVOKE.
  D3  publishability was ``series != "F"`` while the documented rule is
      "J or C only"; an unknown/absent series granted a public page.
  D4  the ps1 envelope keyed ``indicators`` by Romanian labels while its
      consumer (engine.serving.facts.FactsGateway summary tier, the FE
      gateway, and the golden corpus) reads I-CODES — a REAL envelope was
      unreadable by its own reader.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SRC = REPO / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

FIXTURES = Path(__file__).parent / "fixtures" / "public_ro"

HEADER_2024 = "CUI,CAEN," + ",".join("I%d" % n for n in range(1, 21))


def _spec_2024() -> str:
    return (FIXTURES / "spec_2024_uu.csv").read_text(encoding="utf-8")


def _fresh_store(tmp_path):
    from engine.public_ro.store import PublicRoStore

    return PublicRoStore(tmp_path / "public_ro.db")


def _bilant_bytes(rows) -> bytes:
    return ("\r\n".join([HEADER_2024] + list(rows)) + "\r\n").encode("ascii")


#: CUI 700001 — every I1..I20 populated (the honest, complete filing).
_ROW_COMPLETE = (
    "700001,1071,1000,2000,300,700,1000,50,1200,0,10,1840,200,0,"
    "5000,5200,4800,400,0,340,0,12"
)
#: CUI 700002 — I1 alone on the asset side; I2 and I6 EMPTY (the hole).
_ROW_ASSET_HOLE = (
    "700002,1071,30000000,,300,700,1000,,1200,0,10,1840,200,0,"
    "5000,5200,4800,400,0,340,0,12"
)


def _ingest(store, data_bytes, *, year=2024):
    from engine.public_ro.ingest import ingest_year

    return ingest_year(
        store,
        year=year,
        family="UU",
        data_bytes=data_bytes,
        spec_text=_spec_2024(),
        source_url="https://data.gov.ro/x/web_uu_an2024.txt",
        resource_id="uu-fix",
        license_id="CC-BY-4.0",
    )


# ── identification fixtures ───────────────────────────────────────────

_IDENT_HEADER = (
    "COD_FISCAL^DENUMIRE^COD_FISCAL_PARINTE^TIP_UNITATE^TIP_CONTRIB^"
    "LOCALITATE^JUDET^JUDET_COMERT^NR_COMERT^AN_COMERT^STARE"
)


def _ident_bytes(rows) -> bytes:
    return ("\r\n".join([_IDENT_HEADER] + list(rows)) + "\r\n").encode(
        "iso-8859-2"
    )


def _ident_row(cui, name, tip, judet_comert, *, nr="1", an="2005",
               unitate="Sediu central"):
    return "%s^%s^^%s^%s^Bucureşti^Bucureşti^%s^%s^%s^INREGISTRAT" % (
        cui, name, unitate, tip, judet_comert, nr if judet_comert else "",
        an if judet_comert else "",
    )


# ══ D1 — ABSENT != ZERO in derive_fields ══════════════════════════════


def test_derive_fields_refuses_a_total_assembled_over_a_hole():
    """I1 present, I2/I6 absent must yield None — a sum over a hole is a
    guess. The all-absent early-out was never the whole invariant."""
    from engine.public_ro.ingest import derive_fields

    partial = derive_fields({"i1": 30_000_000, "i2": None, "i6": None})
    assert partial["total_assets"] is None

    # Any single missing component is enough to make the total unknown.
    assert derive_fields(
        {"i1": 1000, "i2": 2000, "i6": None})["total_assets"] is None
    assert derive_fields(
        {"i1": None, "i2": 2000, "i6": 50})["total_assets"] is None
    assert derive_fields({})["total_assets"] is None

    # Complete components still derive (a zero component is a MEASUREMENT).
    assert derive_fields(
        {"i1": 1000, "i2": 2000, "i6": 0})["total_assets"] == 3000


def test_derive_fields_net_result_pair_semantics_are_deliberate():
    """The audit's other derived field: I18/I19 are a MUTUALLY EXCLUSIVE
    pair, not additive components, so one-side-absent is a fact ("no loss
    reported"), not a hole. Locked here so the D1 fix is not over-applied
    to it — the FactsGateway summary tier and the golden corpus both read
    the same or-semantics."""
    from engine.public_ro.ingest import derive_fields

    assert derive_fields({"i18": 340, "i19": None})["net_result"] == 340
    assert derive_fields({"i18": None, "i19": 50})["net_result"] == -50
    assert derive_fields({"i18": None, "i19": None})["net_result"] is None


def test_ingest_never_persists_a_fabricated_total(tmp_path):
    """End-to-end: the hole row must land with total_assets NULL, and the
    ps1 envelope must OMIT derived.total_assets exactly as its indicators
    block omits the missing components."""
    from engine.public_ro.snapshot import build_public_summary

    store = _fresh_store(tmp_path)
    _ingest(store, _bilant_bytes([_ROW_COMPLETE, _ROW_ASSET_HOLE]))

    holed = [f for f in store.get_filings(700002) if f["year"] == 2024][0]
    assert holed["i1"] == 30_000_000
    assert holed["i2"] is None and holed["i6"] is None
    assert holed["total_assets"] is None

    summary = build_public_summary(700002, 2024, store=store)["public_summary"]
    assert "total_assets" not in summary["derived"]
    assert summary["derived"]["net_result"] == 340

    complete = [f for f in store.get_filings(700001) if f["year"] == 2024][0]
    assert complete["total_assets"] == 3050


# ══ D2 — re-classification must be able to REVOKE ═════════════════════


def test_pj_to_pf_reclassification_revokes_publishability(tmp_path):
    """The identification source is an annual June snapshot, so re-running
    it is the documented operational path. A CUI that becomes a natural
    person form must LOSE its public page — and its stored identity, which
    is now a natural person's."""
    from engine.public_ro.identification import ingest_identification

    store = _fresh_store(tmp_path)
    _ingest(store, _bilant_bytes([_ROW_COMPLETE]))

    ingest_identification(
        store,
        _ident_bytes([_ident_row(700001, "SC MĂR VERDE SRL", "PJ", "J40")]),
        source_label="ident:2025",
    )
    assert store.get_company(700001)["publishable"] is True

    counts = ingest_identification(
        store,
        _ident_bytes([_ident_row(700001, "POPESCU ION", "PF", "")]),
        source_label="ident:2026",
    )

    revoked = store.get_company(700001)
    assert revoked["publishable"] is False
    assert revoked["tip_contrib"] == "PF"
    # The stored identity belonged to the company; it is now a person's.
    assert revoked["name"] is None
    assert revoked["reg_number"] is None
    assert counts["pf_revoked"] == 1
    # Revocation must reach every publishable-gated read.
    assert store.search_companies("SC M") == []
    assert [r["cui"] for r in store.companies_for_sitemap(0)] == []


def test_pf_row_for_an_unknown_cui_is_still_never_stored(tmp_path):
    """Revocation must not become a back door that CREATES a row for a
    natural person the store has never seen (PS7)."""
    from engine.public_ro.identification import ingest_identification

    store = _fresh_store(tmp_path)
    counts = ingest_identification(
        store,
        _ident_bytes([_ident_row(999999, "IONESCU MARIA", "PF", "")]),
        source_label="ident:2026",
    )
    assert store.get_company(999999) is None
    assert counts["pf_discarded"] == 1
    assert counts["pf_revoked"] == 0


# ══ D3 — the documented rule is "J or C only" (fail closed) ═══════════


def test_publishability_requires_a_J_or_C_series_not_merely_not_F(tmp_path):
    """``series != "F"`` granted a public page to every unknown series and
    to PJ rows with no trade register at all. The documented rule is a
    WHITELIST; an unknown series must fail closed."""
    from engine.public_ro.identification import ingest_identification

    store = _fresh_store(tmp_path)
    rows = [_ROW_COMPLETE.replace("700001", str(cui), 1)
            for cui in (700010, 700011, 700012, 700013, 700014)]
    _ingest(store, _bilant_bytes(rows))

    ingest_identification(
        store,
        _ident_bytes([
            _ident_row(700010, "ALFA SRL", "PJ", "J40"),
            _ident_row(700011, "BETA COOP", "PJ", "C12"),
            _ident_row(700012, "GAMA PFA-LIKE", "PJ", "F12"),
            _ident_row(700013, "DELTA NO REGISTER", "PJ", ""),
            # Digits-first malformation: compliance._register_series scans
            # for the first alpha and sees F — this side must too.
            _ident_row(700014, "EPSILON MALFORMED", "PJ", "40F"),
        ]),
        source_label="ident:2026",
    )

    assert store.get_company(700010)["publishable"] is True   # J
    assert store.get_company(700011)["publishable"] is True   # C
    assert store.get_company(700012)["publishable"] is False  # F
    assert store.get_company(700013)["publishable"] is False  # no series
    assert store.get_company(700014)["publishable"] is False  # "40F"


def test_identification_series_reading_matches_the_compliance_predicate():
    """The two _register_series implementations must not disagree: a
    series this side misses but compliance catches means a page published
    and then refused (or worse, published and never refused)."""
    from engine.public_ro.compliance import _register_series as compliance_series
    from engine.public_ro.identification import _register_series as ident_series

    for judet, nr in (("J40", "J40/123/2005"), ("F12", "F12/99/2019"),
                      ("C12", "C12/1/2001"), ("40F", "40F/1/2001"),
                      ("", None)):
        assert ident_series(judet) == compliance_series(nr)


# ══ D4 — the ps1 envelope must speak its consumer's vocabulary ════════


def test_public_summary_indicators_are_keyed_by_icode(tmp_path):
    from engine.public_ro.snapshot import build_public_summary

    store = _fresh_store(tmp_path)
    _ingest(store, _bilant_bytes([_ROW_COMPLETE]))

    summary = build_public_summary(700001, 2024, store=store)["public_summary"]
    indicators = summary["indicators"]

    assert indicators["I13"] == 5000        # Cifra de afaceri netă
    assert indicators["I7"] == 1200         # DATORII
    assert indicators["I10"] == 1840        # CAPITALURI TOTAL
    assert indicators["I20"] == 12          # Număr mediu salariați
    assert set(indicators) <= {"I%d" % n for n in range(1, 22)}
    assert "I21" not in indicators          # absent slot stays absent


def test_real_ps1_envelope_round_trips_through_facts_gateway(tmp_path):
    """The contract test: feed the REAL producer's envelope to the REAL
    consumer. Every summary-tier accessor must answer from values that
    are present, not raise MissingFactError."""
    from engine.serving import FactsGateway
    from engine.public_ro.snapshot import build_public_summary

    store = _fresh_store(tmp_path)
    _ingest(store, _bilant_bytes([_ROW_COMPLETE]))
    envelope = build_public_summary(700001, 2024, store=store)

    gw = FactsGateway.from_envelope(envelope, currency="RON")
    assert gw is not None
    assert gw.tier == FactsGateway.TIER_SUMMARY
    assert gw.revenue().amount_minor == 5000 * 100          # I13
    assert gw.total_liabilities().amount_minor == 1200 * 100  # I7
    assert gw.equity().amount_minor == 1840 * 100           # I10
    assert gw.expenses().amount_minor == 4800 * 100         # I15
    assert gw.total_assets().amount_minor == 3050 * 100     # derived
    assert gw.net_result().amount_minor == 340 * 100        # derived
    assert gw.employees() == 12                             # I20 (plain int)


@pytest.mark.xfail(
    strict=True,
    reason=(
        "CROSS-LANE: the same hole-sum lives in the CONSUMER. "
        "engine.serving.facts.FactsGateway._summary_totals_cents falls "
        "back to sum(present components) when derived.total_assets is "
        "absent, so the fabricated total this lane stopped persisting is "
        "re-created one layer down. src/engine/serving/facts.py is not "
        "this lane's file — delete this marker when its owner requires "
        "all three of I1/I2/I6."
    ),
)
def test_gateway_refuses_rather_than_reconstructing_a_holed_total(tmp_path):
    """With D1 fixed the producer omits derived.total_assets on the hole
    row. The gateway must then REFUSE — a partial I1+I2+I6 reconstruction
    would re-create the fabricated total one layer down."""
    from engine.serving import FactsGateway, MissingFactError
    from engine.public_ro.snapshot import build_public_summary

    store = _fresh_store(tmp_path)
    _ingest(store, _bilant_bytes([_ROW_ASSET_HOLE]))
    envelope = build_public_summary(700002, 2024, store=store)

    gw = FactsGateway.from_envelope(envelope, currency="RON")
    assert gw is not None
    with pytest.raises(MissingFactError):
        gw.total_assets()


# ── real-world July-2026 snapshot regression (found in go-live, 2026-08-29) ──

def test_ident_accepts_the_utf8_bom_july_variant(tmp_path):
    """The July-updated identification files on data.gov.ro are UTF-8
    WITH A BOM, not the ISO-8859-2 the June format documented. Decoded
    as latin, the BOM mojibake glues onto the first column name and the
    required-column check refuses with "header lacks COD_FISCAL" — which
    is exactly what happened in the production go-live run. The ingester
    must detect the BOM and decode utf-8-sig; BOM-less files keep the
    documented ISO-8859-2 path.
    """
    import os
    from engine.public_ro.identification import ingest_identification
    from engine.public_ro.store import PublicRoStore

    db = tmp_path / "p.db"
    os.environ["PUBLIC_RO_TAKEDOWN_DB"] = str(db)
    st = PublicRoStore(db)
    st.register_dataset(
        dataset_id="d1", year=2024, family="UU", sha256="d" * 64,
        source_url="u", resource_id="r", license_id="CC-BY-4.0",
        license_note=None, row_count=1, fetched_at="2026-06-15T00:00:00Z")
    st.ensure_company_stub(930001, "1071")
    st.upsert_filing(cui=930001, year=2024, family="UU", dataset_id="d1",
                     caen="1071", total_assets=1, net_result=1,
                     indicators={"i13": 100})

    header = ("COD_FISCAL^DENUMIRE^TIP_UNITATE^TIP_CONTRIB^LOCALITATE^"
              "JUDET_COMERT^NR_COMERT^AN_COMERT^JUDET")
    row = ("930001^Brutăria Țării SRL^Sediu central^PJ^Cluj-Napoca^"
           "J12^55^2013^Cluj")
    data = ("﻿" + header + "\r\n" + row + "\r\n").encode("utf-8")

    counts = ingest_identification(st, data, source_label="ident-2026-07")
    assert counts["pj_upserted"] == 1, counts
    c = st.get_company(930001)
    # Diacritics must survive — proof the utf-8 path actually decoded.
    assert c["name"] == "Brutăria Țării SRL"
    assert bool(c["publishable"]) is True
    st.close()
