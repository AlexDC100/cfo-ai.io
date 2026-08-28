"""Lane 1 — public RO data spine (store / specs / ckan / ingest /
identification / anaf / snapshot) + the journal_cli run_kind guard.

All tests are OFFLINE: fetchers/transports are injected, fixtures are
synthetic rows mirroring the VERIFIED data.gov.ro schemas (header
``CUI,CAEN,I1..I20``, CRLF, empty=missing, whole-RON ints) and tiny
spec-csv snippets (public column labels — not personal data).
"""
from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SRC = REPO / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

FIXTURES = Path(__file__).parent / "fixtures" / "public_ro"


# ─────────────────────────────────────────────────────────────────────
# journal_cli run_kind guard (RED-FIRST — owned existing file)
# ─────────────────────────────────────────────────────────────────────


def _load_journal_cli():
    from tests.engine.conftest import load_module_from_path  # type: ignore

    return load_module_from_path(
        "journal_cli_under_test", REPO / "scripts" / "journal_cli.py"
    )


def _dead_letter_public_ingest_run(tmp_path):
    from engine.journal import Journal

    journal = Journal(tmp_path / "journal")
    handle = journal.begin_run(
        file_hash="f" * 64,
        document_id="public_ro:2024:UU",
        engine_version="test@0",
        run_kind="public_ingest",
        extra_payload={"year": 2024, "family": "UU"},
    )
    journal.record_failure(
        handle,
        stage="public_ingest_parse",
        error_type="ParseError",
        message="synthetic dead letter",
    )
    return journal, handle.run_id


def test_journal_cli_dlq_replay_refuses_public_ingest_run_kind(tmp_path, capsys):
    """A public_ingest dead letter must be REFUSED by the pipeline-shaped
    dlq replay (stage_map/stage_persist do not apply) with a typed
    run_kind message — not driven through the wrong stages and not
    refused for an incidental pipeline-shaped reason."""
    cli = _load_journal_cli()
    journal, run_id = _dead_letter_public_ingest_run(tmp_path)

    rc = cli.main(["--journal-root", str(journal.root), "dlq", "replay", run_id])
    out = capsys.readouterr().out
    assert rc == 4
    assert "wrong_run_kind" in out
    assert "public_ingest" in out


def test_journal_cli_resume_refuses_public_ingest_run_kind(tmp_path, capsys):
    cli = _load_journal_cli()
    journal, run_id = _dead_letter_public_ingest_run(tmp_path)

    rc = cli.main(["--journal-root", str(journal.root), "resume", run_id])
    out = capsys.readouterr().out
    assert rc == 4
    assert "wrong_run_kind" in out


def test_journal_cli_pipeline_run_kind_still_reaches_resume_machinery(
    tmp_path, capsys
):
    """The guard must NOT swallow pipeline runs: a pipeline-kind run with
    no checkpoints is still refused, but by the resume machinery's own
    typed reason (cannot_resume), not by the run_kind guard."""
    from engine.journal import Journal

    cli = _load_journal_cli()
    journal = Journal(tmp_path / "journal")
    handle = journal.begin_run(
        file_hash="a" * 64,
        document_id="doc-1",
        engine_version="test@0",
        run_kind="pipeline",
    )
    journal.record_failure(
        handle, stage="map", error_type="Boom", message="synthetic"
    )
    rc = cli.main(
        ["--journal-root", str(journal.root), "dlq", "replay", handle.run_id]
    )
    out = capsys.readouterr().out
    assert rc == 4
    assert "wrong_run_kind" not in out
    assert "cannot_resume" in out


# ─────────────────────────────────────────────────────────────────────
# specs.py — i-code resolution incl. the FY2015 drift + typo
# ─────────────────────────────────────────────────────────────────────


def _spec(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def test_spec_resolution_stable_2019_2025_layout():
    from engine.public_ro.specs import resolve_spec

    mapping = resolve_spec(_spec("spec_2024_uu.csv"), year=2024, family="UU")
    # Diacritic-bearing labels resolve; the stable layout is identity.
    assert mapping["I13"] == "i13"
    assert mapping["I18"] == "i18"
    assert mapping["I20"] == "i20"
    assert len(mapping) == 20


def test_spec_resolution_fy2015_bl_patrimoniul_public_shift():
    from engine.public_ro.specs import resolve_spec

    mapping = resolve_spec(_spec("spec_2015_bl.csv"), year=2015, family="BL")
    # Patrimoniul public inserted at source i13 shifts everything after.
    assert mapping["I13"] == "i21"  # the extra slot
    assert mapping["I14"] == "i13"  # CA
    assert mapping["I19"] == "i18"  # Profit net
    assert mapping["I21"] == "i20"  # employees
    assert len(mapping) == 21


def test_spec_resolution_fy2015_uu_typo_repair():
    from engine.public_ro.specs import resolve_spec

    mapping = resolve_spec(_spec("spec_2015_uu.csv"), year=2015, family="UU")
    # "Pierdere neta;i16" is the verified spec TYPO — it means
    # Pierdere bruta (it directly follows Profit brut).
    assert mapping["I15"] == "i16"  # Profit brut
    assert mapping["I16"] == "i17"  # repaired: Pierdere bruta
    assert mapping["I17"] == "i18"  # Profit net
    assert mapping["I18"] == "i19"  # Pierdere neta (the real one)
    assert mapping["I19"] == "i20"  # employees
    assert len(mapping) == 19


def test_spec_resolution_refuses_unknown_label():
    from engine.public_ro.specs import SpecResolutionError, resolve_spec

    bad = _spec("spec_2024_uu.csv") + "Indicator misterios;I99\n"
    with pytest.raises(SpecResolutionError) as exc:
        resolve_spec(bad, year=2017, family="UU")
    assert "unrecognized" in str(exc.value)


def test_spec_resolution_refuses_incomplete_spec():
    from engine.public_ro.specs import SpecResolutionError, resolve_spec

    # Only three lines — required canonical concepts missing.
    partial = "CUI;CUI\nCAEN;CAEN\nCifra de afaceri neta;I1\n"
    with pytest.raises(SpecResolutionError) as exc:
        resolve_spec(partial, year=2016, family="UU")
    assert "required canonical" in str(exc.value)


# ─────────────────────────────────────────────────────────────────────
# strict bilanț parsing
# ─────────────────────────────────────────────────────────────────────

HEADER_2024 = "CUI,CAEN," + ",".join("I%d" % n for n in range(1, 21))


def _uu_2024_bytes() -> bytes:
    rows = [
        HEADER_2024,
        # cui, caen, I1..I20 (whole RON; empty = missing; negatives ok)
        "123456,1071,1000,2000,300,700,1000,50,1200,0,10,1840,200,,"
        "5000,5200,4800,400,,340,,12",
        "222222,6201,10,20,,,20,,300,,,-270,5,,1000,1100,1150,,50,,50,3",
        "333333,1085,500,800,100,200,500,,400,,,900,90,,3000,3100,2900,"
        "200,,168,,7",
    ]
    return ("\r\n".join(rows) + "\r\n").encode("ascii")


def test_parse_bilant_strict_empty_null_junk_typed_negative_ok():
    from engine.public_ro.ingest import ParseError, parse_bilant

    codes, rows_iter = parse_bilant(_uu_2024_bytes().decode("ascii"))
    rows = list(rows_iter)
    assert codes[0] == "I1" and len(codes) == 20
    r1 = rows[0]["values"]
    assert r1["I12"] is None          # empty -> NULL, never 0
    assert r1["I18"] == 340
    assert rows[1]["values"]["I10"] == -270  # negative capital is real

    junk = HEADER_2024 + "\r\n123,1071," + ",".join(["x"] + [""] * 19) + "\r\n"
    with pytest.raises(ParseError) as exc:
        list(parse_bilant(junk)[1])
    assert "not an integer" in str(exc.value)

    with pytest.raises(ParseError):
        list(parse_bilant(HEADER_2024 + "\r\nabc,1071," + "," * 19 + "\r\n")[1])


def test_derive_fields_total_assets_and_net_result():
    from engine.public_ro.ingest import derive_fields

    d = derive_fields({"i1": 1000, "i2": 2000, "i6": 50, "i18": 340, "i19": None})
    assert d["total_assets"] == 3050
    assert d["net_result"] == 340
    d2 = derive_fields({"i1": None, "i2": None, "i6": None,
                        "i18": None, "i19": 50})
    assert d2["total_assets"] is None  # honest absence
    assert d2["net_result"] == -50
    d3 = derive_fields({"i18": None, "i19": None})
    assert d3["net_result"] is None


# ─────────────────────────────────────────────────────────────────────
# ckan.py — fuzzy discovery on a messy portal (offline fixture pkg)
# ─────────────────────────────────────────────────────────────────────


def _messy_package() -> dict:
    return {
        "name": "situatii_financiare_2024",
        "license_id": "CC-BY-4.0",
        "license_title": "Creative Commons Attribution 4.0",
        "resources": [
            {"id": "junk1", "name": "test", "format": "XLSX",
             "url": "https://data.gov.ro/x/test.docx"},
            {"id": "junk2", "name": "fisier_test",
             "url": "https://data.gov.ro/x/fisier_test.txt"},
            {"id": "ong", "name": "WEB_ONG_AN2024;",
             "url": "https://data.gov.ro/x/web_ong_an2024.txt"},
            {"id": "uu-old", "name": "WEB_UU_AN2024",
             "created": "2025-01-01T00:00:00",
             "url": "https://data.gov.ro/old/web_uu_an2024.txt"},
            {"id": "uu-new", "name": "WEB_UU_AN2024",
             "created": "2025-06-01T00:00:00",
             "url": "https://data.gov.ro/new/web_uu_an2024.txt"},
            {"id": "uu-spec", "name": "WEB_UU_AN2024 specificatie",
             "url": "https://data.gov.ro/new/web_uu_an2024.csv"},
            {"id": "bl", "name": "WEB_BL_BS_SL_AN2024",
             "url": "https://data.gov.ro/x/web_bl_bs_sl_an2024.txt"},
        ],
    }


def test_ckan_fuzzy_resource_matching_prefers_newest_and_right_family():
    from engine.public_ro.ckan import find_resources

    found = find_resources(_messy_package(), year=2024, family="UU")
    assert found["data"]["id"] == "uu-new"  # newest re-upload wins
    assert found["spec"]["id"] == "uu-spec"


def test_ckan_refuses_when_companion_spec_missing():
    from engine.public_ro.ckan import ResourceNotFound, find_resources

    pkg = _messy_package()
    pkg["resources"] = [r for r in pkg["resources"] if r["id"] != "uu-spec"]
    with pytest.raises(ResourceNotFound) as exc:
        find_resources(pkg, year=2024, family="UU")
    assert "spec" in str(exc.value)


def test_ckan_slug_exceptions():
    from engine.public_ro.ckan import ACTUALIZAT_SLUGS, slug_for_year

    assert slug_for_year(2023) == "situatii_financiare2023"
    assert slug_for_year(2024) == "situatii_financiare_2024"
    assert ACTUALIZAT_SLUGS[2024] == "situatii_financiare_2024_actualizat"


# ─────────────────────────────────────────────────────────────────────
# ingest end-to-end (synthetic fixtures, zero network)
# ─────────────────────────────────────────────────────────────────────


def _fresh_store(tmp_path):
    from engine.public_ro.store import PublicRoStore

    return PublicRoStore(tmp_path / "public_ro.db")


def _ident_2026_bytes() -> bytes:
    header = (
        "COD_FISCAL^DENUMIRE^COD_FISCAL_PARINTE^TIP_UNITATE^TIP_CONTRIB^"
        "LOCALITATE^JUDET^JUDET_COMERT^NR_COMERT^AN_COMERT^STARE"
    )
    rows = [
        header,
        "123456^SC MĂR VERDE SRL^^Sediu central^PJ^Bucureşti^Bucureşti^"
        "J40^123^2005^INREGISTRAT",
        "222222^POPESCU ION PFA-LIKE SRL^^Sediu central^PJ^Cluj-Napoca^"
        "Cluj^F12^99^2019^INREGISTRAT",
        "333333^LACTATE ARDEAL SA^^Sediu central^PJ^Sibiu^Sibiu^J32^5^"
        "2010^INREGISTRAT",
        "999999^IONESCU MARIA^^Sediu central^PF^Iaşi^Iaşi^^^^INREGISTRAT",
        "123456^SC MĂR VERDE SRL - SUCURSALA^^Sucursala^PJ^Braşov^Braşov^"
        "J40^123^2005^INREGISTRAT",
    ]
    return ("\r\n".join(rows) + "\r\n").encode("iso-8859-2")


def _ingest_2024(store):
    from engine.public_ro.ingest import ingest_year

    return ingest_year(
        store,
        year=2024,
        family="UU",
        data_bytes=_uu_2024_bytes(),
        spec_text=_spec("spec_2024_uu.csv"),
        source_url="https://data.gov.ro/new/web_uu_an2024.txt",
        resource_id="uu-new",
        license_id="CC-BY-4.0",
    )


def test_ingest_end_to_end_with_identification_join(tmp_path):
    from engine.public_ro.identification import ingest_identification

    store = _fresh_store(tmp_path)
    summary = _ingest_2024(store)
    assert summary["rows"] == 3 and summary["skipped"] is False

    counts = ingest_identification(
        store, _ident_2026_bytes(), source_label="ident_snapshot:2026a"
    )
    assert counts["pj_upserted"] == 3
    assert counts["pf_discarded"] == 1
    assert counts["non_sediu_skipped"] == 1

    # PF CUI never stored anywhere (PS7).
    assert store.get_company(999999) is None

    # PJ + J-series -> publishable; ISO-8859-2 diacritics survive.
    c = store.get_company(123456)
    assert c["publishable"] is True
    assert c["name"] == "SC MĂR VERDE SRL"
    assert c["county"] == "Bucureşti"
    assert c["reg_number"] == "J40/123/2005"

    # PJ but F-series register -> NEVER publishable (belt-and-braces).
    assert store.get_company(222222)["publishable"] is False

    # Filings normalized + derived, provenance-carrying.
    filings = store.get_filings(123456)
    assert len(filings) == 1
    f = filings[0]
    assert f["i13"] == 5000 and f["i18"] == 340 and f["i12"] is None
    assert f["total_assets"] == 3050 and f["net_result"] == 340
    assert f["provenance"]["source"] == "data.gov.ro/mfp"
    assert f["provenance"]["license_id"] == "cc-by-4.0"
    assert f["provenance"]["dataset_sha256"]

    # Search is publishable-only; sitemap iteration too.
    assert [r["cui"] for r in store.search_companies("SC M")] == [123456]
    assert store.search_companies("POPESCU") == []
    shard = store.companies_for_sitemap(0, shard_size=10)
    assert [r["cui"] for r in shard] == [123456, 333333]
    assert store.latest_year() == 2024

    # Hub ranking by revenue among publishable companies.
    top = store.hub_top_companies(year=2024, caen2="10", limit=10)
    assert [t["cui"] for t in top] == [123456, 333333]


def test_ingest_sha_dedupe_skips_known_bytes(tmp_path):
    store = _fresh_store(tmp_path)
    first = _ingest_2024(store)
    second = _ingest_2024(store)
    assert second["skipped"] is True
    assert second["dataset_id"] == first["dataset_id"]
    assert len(store.dataset_registry()) == 1


def test_ingest_refuses_unlicensed_unless_env_override(tmp_path, monkeypatch):
    from engine.public_ro.ingest import LicenseRefused, ingest_year

    store = _fresh_store(tmp_path)
    monkeypatch.delenv("PUBLIC_INGEST_UNLICENSED_OK", raising=False)
    with pytest.raises(LicenseRefused):
        ingest_year(
            store, year=2025, family="UU",
            data_bytes=_uu_2024_bytes(),
            spec_text=_spec("spec_2024_uu.csv"),
            license_id=None,
        )
    monkeypatch.setenv("PUBLIC_INGEST_UNLICENSED_OK", "1")
    summary = ingest_year(
        store, year=2025, family="UU",
        data_bytes=_uu_2024_bytes(),
        spec_text=_spec("spec_2024_uu.csv"),
        license_id=None,
    )
    assert summary["rows"] == 3
    reg = store.dataset_registry()[0]
    assert "UNLICENSED" in (reg["license_note"] or "")


def test_ingest_refuses_ong_family_and_unknown_header_codes(tmp_path):
    from engine.public_ro.ingest import IngestError, ingest_year
    from engine.public_ro.specs import SpecResolutionError

    store = _fresh_store(tmp_path)
    with pytest.raises(IngestError):
        ingest_year(store, year=2024, family="ONG",
                    data_bytes=b"", spec_text="", license_id="CC-BY-4.0")

    # A 21-column data header against the 20-slot spec must refuse.
    data21 = ("CUI,CAEN," + ",".join("I%d" % n for n in range(1, 22))
              + "\r\n1,1071," + ",".join(["1"] * 21) + "\r\n").encode("ascii")
    with pytest.raises(SpecResolutionError):
        ingest_year(store, year=2024, family="UU", data_bytes=data21,
                    spec_text=_spec("spec_2024_uu.csv"),
                    license_id="CC-BY-4.0")


# ─────────────────────────────────────────────────────────────────────
# percentiles — hand-computed
# ─────────────────────────────────────────────────────────────────────


def test_percentiles_hand_computed(tmp_path):
    store = _fresh_store(tmp_path)
    _ingest_2024(store)  # recomputes percentiles as part of ingest

    # caen2 "10": revenues [3000, 5000] -> linear interpolation
    p = store.get_percentiles(year=2024, metric="revenue", caen2="10")
    assert p["n"] == 2
    assert p["p10"] == pytest.approx(3200.0)   # 3000*0.9 + 5000*0.1
    assert p["p50"] == pytest.approx(4000.0)
    assert p["p90"] == pytest.approx(4800.0)

    # all-sector row (caen2=None): revenues [1000, 3000, 5000]
    p_all = store.get_percentiles(year=2024, metric="revenue")
    assert p_all["n"] == 3
    assert p_all["p50"] == pytest.approx(3000.0)
    assert p_all["p25"] == pytest.approx(2000.0)  # (n-1)*0.25=0.5 between 1000,3000

    # net_result includes the negative company: [-50, 168, 340]
    nr = store.get_percentiles(year=2024, metric="net_result")
    assert nr["p50"] == pytest.approx(168.0)

    # single-member group: caen2 "62" -> every percentile is the value
    solo = store.get_percentiles(year=2024, metric="employees", caen2="62")
    assert solo["n"] == 1 and solo["p10"] == solo["p90"] == 3.0


# ─────────────────────────────────────────────────────────────────────
# snapshot PS3 — byte identity + status outside the machine ladder
# ─────────────────────────────────────────────────────────────────────


def test_public_summary_byte_identity_and_hash_excludes_fetch_date(tmp_path):
    from engine.public_ro.snapshot import (
        build_public_summary,
        serialize_public_summary,
    )

    store = _fresh_store(tmp_path)
    _ingest_2024(store)

    env1 = build_public_summary(123456, 2024, store=store)
    env2 = build_public_summary(123456, 2024, store=store)
    assert serialize_public_summary(env1) == serialize_public_summary(env2)

    ps = env1["public_summary"]
    assert ps["version"] == "ps1"
    assert ps["status"] == "PUBLIC_SUMMARY"
    assert ps["indicators"]["cifra_de_afaceri_neta"] == 5000
    assert "patrimoniul_regiei" not in ps["indicators"]  # NULL stays absent
    assert ps["derived"] == {"total_assets": 3050, "net_result": 340}
    assert ps["provenance"]["content_hash"]

    # Mutate the volatile fetch date out-of-band: identity must hold.
    store._conn.execute("UPDATE datasets SET fetched_at='1999-01-01T00:00:00Z'")
    store._conn.commit()
    env3 = build_public_summary(123456, 2024, store=store)
    assert (env3["public_summary"]["provenance"]["fetch_date"]
            != ps["provenance"]["fetch_date"])
    assert (env3["public_summary"]["provenance"]["content_hash"]
            == ps["provenance"]["content_hash"])


def test_public_summary_status_never_in_machine_ladder(tmp_path):
    from engine.public_ro.snapshot import PUBLIC_SUMMARY_STATUS
    from engine.serving.status import MACHINE_STATUSES

    assert PUBLIC_SUMMARY_STATUS not in MACHINE_STATUSES

    from engine.public_ro.snapshot import PublicSummaryNotFound, build_public_summary

    store = _fresh_store(tmp_path)
    with pytest.raises(PublicSummaryNotFound):
        build_public_summary(1, 2024, store=store)


# ─────────────────────────────────────────────────────────────────────
# identification format refusals
# ─────────────────────────────────────────────────────────────────────


def test_identification_refuses_pre2026_comma_format(tmp_path):
    from engine.public_ro.identification import (
        IdentificationFormatError,
        ingest_identification,
    )

    store = _fresh_store(tmp_path)
    legacy = b"COD_FISCAL,DENUMIRE,JUDET\r\n123,ACME,ALBA\r\n"
    with pytest.raises(IdentificationFormatError) as exc:
        ingest_identification(store, legacy, source_label="x")
    assert "caret" in str(exc.value)


# ─────────────────────────────────────────────────────────────────────
# ANAF politeness — fake clock, zero network
# ─────────────────────────────────────────────────────────────────────


class _FakeTime:
    def __init__(self):
        self.now = 0.0
        self.sleeps = []

    def clock(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


def test_anaf_batches_of_100_and_hard_1rps_spacing():
    import json as _json

    from engine.public_ro.anaf_client import AnafClient

    fake = _FakeTime()
    posted = []

    def post(url, body):
        posted.append(_json.loads(body.decode("utf-8")))
        fake.now += 0.05  # request latency well under the interval
        return b'{"cod":200,"found":[],"notFound":[]}'

    client = AnafClient(post=post, clock=fake.clock, sleeper=fake.sleep)
    client.lookup(list(range(1, 102)), date="2026-08-28")  # 101 CUIs

    assert len(posted) == 2
    assert len(posted[0]) == 100 and len(posted[1]) == 1
    assert posted[0][0] == {"cui": 1, "data": "2026-08-28"}
    # Never less than 1s between request starts (published penalty clause).
    starts = client.request_times
    assert len(starts) == 2
    assert starts[1] - starts[0] >= 1.0


def test_anaf_refresh_updates_pj_only(tmp_path):
    from engine.public_ro.anaf_client import AnafClient, refresh_company
    from engine.public_ro.identification import ingest_identification

    store = _fresh_store(tmp_path)
    _ingest_2024(store)
    ingest_identification(store, _ident_2026_bytes(), source_label="ident")

    fake = _FakeTime()

    def post(url, body):
        import json as _json

        batch = _json.loads(body.decode("utf-8"))
        found = [
            {"date_generale": {"cui": item["cui"],
                               "denumire": "REFRESHED %d" % item["cui"],
                               "nrRegCom": "J40/1/2005",
                               "cod_CAEN": "1071"}}
            for item in batch
        ]
        return _json.dumps({"cod": 200, "found": found,
                            "notFound": []}).encode("utf-8")

    client = AnafClient(post=post, clock=fake.clock, sleeper=fake.sleep)
    # 999999 is unknown (PF was discarded) — must be skipped pre-network.
    counts = refresh_company(store, [123456, 999999], client=client,
                             date="2026-08-28")
    assert counts == {"requested": 1, "updated": 1, "skipped_non_pj": 1}
    c = store.get_company(123456)
    assert c["name"] == "REFRESHED 123456"
    assert c["name_source"] == "anaf_v9"
    assert store.get_company(999999) is None


# ─────────────────────────────────────────────────────────────────────
# journal integration — durable public_ingest runs + DLQ on failure
# ─────────────────────────────────────────────────────────────────────


def test_ingest_journals_run_and_dead_letters_failures(tmp_path):
    from engine.journal import Journal
    from engine.public_ro.ingest import ParseError, ingest_year, sha256_hex

    journal = Journal(tmp_path / "journal")
    store = _fresh_store(tmp_path)

    from engine.public_ro.ingest import ingest_year as _iy

    summary = _iy(
        store, year=2024, family="UU", data_bytes=_uu_2024_bytes(),
        spec_text=_spec("spec_2024_uu.csv"), license_id="CC-BY-4.0",
        journal=journal,
    )
    sha = summary["sha256"]
    events = journal.chain_events(sha)
    types = [e["type"] for e in events]
    assert types[0] == "RUN_STARTED"
    assert (events[0]["payload"]["run_kind"] == "public_ingest"
            and events[0]["payload"]["year"] == 2024)
    assert "PASS_DONE" in types
    assert journal.dlq_depth() == 0

    junk = (HEADER_2024 + "\r\n123,1071,x," + ",".join([""] * 19)
            + "\r\n").encode("ascii")
    with pytest.raises(ParseError):
        ingest_year(
            store, year=2024, family="UU", data_bytes=junk,
            spec_text=_spec("spec_2024_uu.csv"), license_id="CC-BY-4.0",
            journal=journal,
        )
    assert journal.dlq_depth() == 1
    entry = journal.dlq_entries()[0]
    assert entry["run_kind"] == "public_ingest"
    assert entry["file_hash"] == sha256_hex(junk)


# ─────────────────────────────────────────────────────────────────────
# operator CLI smoke (offline paths only)
# ─────────────────────────────────────────────────────────────────────


def test_public_ingest_cli_local_ingest_and_status(tmp_path, capsys):
    from tests.engine.conftest import load_module_from_path  # type: ignore

    cli = load_module_from_path(
        "public_ingest_cli_under_test", REPO / "scripts" / "public_ingest.py"
    )
    data = tmp_path / "web_uu_an2024.txt"
    data.write_bytes(_uu_2024_bytes())
    spec = tmp_path / "web_uu_an2024.csv"
    spec.write_text(_spec("spec_2024_uu.csv"), encoding="utf-8")
    db = tmp_path / "cli.db"

    rc = cli.main([
        "--db", str(db), "ingest", "--year", "2024", "--family", "UU",
        "--path", str(data), "--spec", str(spec),
        "--license-id", "CC-BY-4.0",
    ])
    assert rc == 0
    out = capsys.readouterr().out
    assert '"rows": 3' in out

    rc = cli.main(["--db", str(db), "status"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "datasets: 1" in out

    # Local ingest with no license id refuses (exit 0, NOTICE'd).
    # Different bytes (extra blank line) — otherwise the sha dedupe
    # short-circuits before the license gate, which is correct (those
    # exact bytes already passed the gate once).
    data2 = tmp_path / "web_uu_an2025.txt"
    data2.write_bytes(_uu_2024_bytes() + b"\r\n")
    rc = cli.main([
        "--db", str(db), "ingest", "--year", "2025", "--family", "UU",
        "--path", str(data2), "--spec", str(spec),
    ])
    assert rc == 0
    out = capsys.readouterr().out
    assert "REFUSED (license)" in out
