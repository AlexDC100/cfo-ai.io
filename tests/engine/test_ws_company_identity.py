"""Company identity of a stored document — read from its own bytes.

Synthetic files only (built here); invented companies and CUIs.

WHAT THESE RED ON, with the module correct (TC-11):
  * a number with a wrong control digit accepted as a CUI;
  * a customer's name in an analytic account row read as the book's owner;
  * a company KEY minted from a filename alone;
  * the filename overriding a period the document states;
  * a registry name match on an ambiguous or unsure lookup;
  * an operator rule overriding a CUI the document prints.
"""
from __future__ import annotations

import hashlib

import pytest

from engine.public_ro.store import PublicRoStore
from engine.workspaces.company_identity import (
    REGISTRY_SEARCH_LIMIT,
    CompanyIdentity,
    apply_known_identity,
    cui_control_digit,
    filename_company_name,
    identify_document,
    industry_key_for_caen,
    match_known_identity,
    normalize_company_name,
    normalize_cui,
    registry_match_name,
)

from ws_migration_fixture import balance_pdf, balance_xlsx, itinerary_pdf, text_pdf, valid_cui


# ── CUI checksum (key 753217532) ───────────────────────────────────────

def test_a_hand_computed_cui_checks_out():
    # 0*7+0*5+1*3+2*2+3*1+4*7+5*5+6*3+7*2 = 95; 950 mod 11 = 4
    assert cui_control_digit("1234567") == 4
    assert normalize_cui("12345674") == "12345674"
    assert normalize_cui("12345675") is None


@pytest.mark.parametrize("raw", ["RO12345674", "ro 12345674", " 12345674 ", "RO 1234 5674", "012345674"])
def test_printed_shapes_normalize_to_digits(raw):
    assert normalize_cui(raw) == "12345674"


@pytest.mark.parametrize("raw", [None, "", "RO", "1", "12a45674", "123456789012", "12345670", "-12345674"])
def test_non_cuis_are_refused(raw):
    assert normalize_cui(raw) is None


def test_a_remainder_of_ten_maps_to_control_digit_zero():
    body = next(str(n) for n in range(100000, 200000)
                if (sum(int(d) * int(k) for d, k in zip(str(n).rjust(9, "0"), "753217532")) * 10) % 11 == 10)
    assert cui_control_digit(body) == 0
    assert normalize_cui(body + "0") == body + "0"
    assert normalize_cui(body + "1") is None


def test_every_generated_cui_round_trips():
    for body in ("21", "2000001", "999999999", "100000000"):
        assert normalize_cui(valid_cui(body)) == valid_cui(body)


# ── names ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("a,b", [
    ("OMEGA'S FOOD FACTORY SRL", "Omegas Food Factory"),
    ("S.C. Alfa Food S.R.L.", "ALFA FOOD"),
    ("ALFA FOOD S. R. L.", "alfa food srl"),
    ("ROMÂNĂ DEZVOLTARE SRL", "Romana Dezvoltare"),
    ("Beta-Imobiliare SA", "BETA IMOBILIARE"),
])
def test_names_normalize_alike(a, b):
    assert normalize_company_name(a) == normalize_company_name(b)


def test_filename_names_drop_dates_and_balance_vocabulary():
    assert filename_company_name("Balanta Alfa Food_FY2025.xls") == "Alfa Food"
    assert filename_company_name("Trial_Balance_Alfa_Dev_31.12.2025.xlsx") == "Alfa Dev"
    assert filename_company_name("balanta verificare BETA dec 2025.pdf") == "BETA"
    assert filename_company_name("Balanta decembrie 2024_extern .xlsx") is None


# ── workbooks ──────────────────────────────────────────────────────────

CUI_A = valid_cui("2000001")
CUI_B = valid_cui("3000002")


def test_a_workbook_header_gives_cui_name_and_the_documents_own_period():
    content = balance_xlsx(["Alfa Food SRL", "Sibiu   Balanta de Verificare - Decembrie 2024",
                            "Cod fiscal: %s" % CUI_A])
    # the filename says 2025; the document says December 2024 — the document wins
    ident = identify_document(content, "Balanta Alfa Food_FY2025.xlsx")
    assert ident.cui == CUI_A
    assert ident.sources["cui"]["signal"] == "document_header_cui"
    assert ident.company_name == "Alfa Food SRL"
    assert ident.period_end == "2024-12-31"
    assert ident.sources["period_end"]["signal"] == "closing_balance"
    assert ident.document_kind == "trial_balance"
    assert ident.company_key == "cui:" + CUI_A


def test_a_customer_named_in_an_analytic_account_is_never_the_owner():
    """balance_xlsx always carries 'Clienti OMEGA TRADING SRL' in a 4111
    row; with no header, nothing may be read from the rows."""
    ident = identify_document(balance_xlsx([]), "export.xlsx")
    assert ident.company_name is None and ident.cui is None and ident.company_key is None


def test_a_wrong_control_digit_in_the_header_is_not_a_cui():
    bad = CUI_A[:-1] + str((int(CUI_A[-1]) + 1) % 10)
    ident = identify_document(balance_xlsx(["Alfa Food SRL", "Cod fiscal: %s" % bad]), "x.xlsx")
    assert ident.cui is None
    assert ident.company_key == "name:ALFA FOOD"   # the printed name still keys it


def test_a_sheet_name_keys_a_company_without_cui_and_generic_sheets_do_not():
    ident = identify_document(balance_xlsx([], sheet="Carnex"), "Carnex Trial Balance_FY2025.xlsx")
    assert ident.company_key == "name:CARNEX" and ident.sources["company_name"]["signal"] == "sheet_name"
    assert ident.period_end == "2025-12-31" and ident.sources["period_end"]["signal"] == "filename"
    for generic in ("Sheet1", "Document_CH14", "Foaie1", "Balanta"):
        assert identify_document(balance_xlsx([], sheet=generic), "Alfa Food 2025.xlsx").company_key is None


def test_a_filename_alone_never_mints_a_company_key():
    ident = identify_document(balance_xlsx([]), "Balanta Alfa Food_FY2025.xlsx")
    assert ident.company_name == "Alfa Food" and ident.sources["company_name"]["signal"] == "filename"
    assert ident.company_key is None


# ── PDFs ───────────────────────────────────────────────────────────────

def test_a_pdf_header_cf_and_its_period_line():
    content = balance_pdf(["BETA IMOBILIARE SRL c.f. %s r.c. J40/1/2004" % CUI_B, "BUCURESTI",
                           "Balanta de verificare", "01.12.2025 -- 31.12.2025"])
    ident = identify_document(content, "balanta.pdf")
    assert ident.cui == CUI_B and ident.company_name == "BETA IMOBILIARE SRL"
    assert ident.period_end == "2025-12-31" and ident.sources["period_end"]["signal"] == "closing_balance"
    assert ident.document_kind == "trial_balance"


def test_a_labelled_company_and_ro_prefixed_cui():
    content = balance_pdf(["Balanta analitica", "Societate: GAMMA AGRO SRL",
                           "Adresa: Str. X 25", "C.U.I: RO%s" % valid_cui("4000003")])
    ident = identify_document(content, "Balanta GAMMA_FY2025.pdf")
    assert ident.cui == valid_cui("4000003") and ident.company_name == "GAMMA AGRO SRL"


@pytest.mark.parametrize("line,name", [
    ("Welcome dinner hosted by Scandia Food S.R.L", "Scandia Food S.R.L"),
    ("Firma ALFA FOOD SRL", "ALFA FOOD SRL"),
    ("Casa de Ajutor Reciproc Scandia SA", "Casa de Ajutor Reciproc Scandia SA"),
    ("BETA IMOBILIARE SRL c.f. 30000024", "BETA IMOBILIARE SRL"),
])
def test_a_title_line_yields_the_company_name_not_the_sentence(line, name):
    """Verifier finding (2026-09-21): the title pattern matched lazily from the leftmost
    capital, so 'Welcome dinner hosted by Scandia Food S.R.L' keyed the
    company 'WELCOME DINNER HOSTED BY SCANDIA FOOD' and an itinerary was
    archived away from the company it names."""
    ident = identify_document(balance_xlsx([line, "Balanta de verificare la 31.12.2025"]), "x.xlsx")
    assert ident.company_name == name
    assert ident.sources["company_name"]["signal"] == "document_header_title"


def test_an_itinerary_is_not_a_balance_but_names_its_host():
    ident = identify_document(itinerary_pdf(), "Delegation_Itinerary.pdf")
    assert ident.document_kind == "not_a_balance"
    assert ident.company_key == "name:ALFA FOOD"
    assert ident.period_end is None


@pytest.mark.parametrize("content", [b"", b"%PDF-1.4 garbage", text_pdf([])])
def test_unreadable_bytes_are_unreadable_not_not_a_balance(content):
    ident = identify_document(content, "balanta verificare dec 2025.pdf")
    assert ident.document_kind == "unreadable"
    assert ident.period_end == "2025-12-31"   # the filename still speaks, weakly


# ── the registry (a real PublicRoStore on disk) ────────────────────────

def _company(store, cui, name, caen="1013"):
    store.set_identification(int(cui), name=name, county="SB", locality="Sibiu", reg_number="J32/1/2000",
                             tip_contrib="PJ", publishable=True, name_source="test")
    store.ensure_company_stub(int(cui), caen)
    store.upsert_filing(cui=int(cui), year=2024, family="UU", dataset_id="ds-test", indicators={},
                        total_assets=1, net_result=1, caen=caen)


@pytest.fixture
def registry(tmp_path):
    st = PublicRoStore(tmp_path / "public_ro.db")
    _company(st, CUI_A, "ALFA FOOD SRL", "1013")
    _company(st, valid_cui("4000003"), "GAMMA' AGRO SRL", "1011")
    _company(st, valid_cui("8000001"), "TWIN CO SRL", "4120")
    _company(st, valid_cui("8000002"), "TWIN CO S.A.", "4120")
    yield st
    st.close()


def test_a_header_cui_takes_the_registered_name_and_caen(registry):
    ident = identify_document(balance_xlsx(["Alfa Food", "Cod fiscal: %s" % CUI_A]), "x.xlsx", registry=registry)
    assert ident.company_name == "ALFA FOOD SRL" and ident.sources["company_name"]["signal"] == "registry"
    assert ident.caen_code == "1013"
    assert ident.industry_key == industry_key_for_caen("1013") == "packaged_canned_meat_prepared_foods"


def test_a_sheet_name_resolves_to_a_unique_registered_company(registry):
    ident = identify_document(balance_xlsx([], sheet="Gamma Agro"), "Gamma 2025.xlsx", registry=registry)
    assert ident.cui == valid_cui("4000003")
    assert ident.sources["cui"]["signal"] == "registry_name_match"


def test_an_ambiguous_name_resolves_to_nothing(registry):
    ident = identify_document(balance_xlsx([], sheet="Twin Co"), "Twin Co 2025.xlsx", registry=registry)
    assert ident.cui is None and ident.company_key == "name:TWIN CO"


def test_a_short_filename_word_is_never_looked_up(registry):
    _company(registry, valid_cui("9000001"), "BETA SRL")
    ident = identify_document(balance_xlsx([]), "balanta verificare BETA dec 2025.xlsx", registry=registry)
    assert ident.cui is None


def test_a_filename_registry_match_is_only_a_hint_unless_the_document_prints_the_cui(registry):
    """Verifier finding (2026-09-21): a filename matched to the registry used to mint a CUI —
    and so a company key — on its own ('trial Balance Scandia Sibiu
    12.2019.PDF' -> 13068741, a live workspace created from the filename
    alone). It is a hint unless the document prints that CUI."""
    ident = identify_document(balance_xlsx([]), "Balanta Alfa Food_FY2025.xlsx", registry=registry)
    assert ident.cui is None and ident.company_key is None
    assert ident.sources["cui_hint"]["cui"] == CUI_A
    assert ident.sources["cui_hint"]["signal"] == "filename_registry_match"
    # corroborated: the header prints the CUI (unlabelled)
    ident = identify_document(balance_xlsx(["Balanta de verificare", "RO%s" % CUI_A]),
                              "Balanta Alfa Food_FY2025.xlsx", registry=registry)
    assert ident.cui == CUI_A and ident.sources["cui"]["signal"] == "filename_registry_match"


def test_a_second_company_with_the_name_is_found_past_a_full_search_page(tmp_path):
    """Verifier finding (p6_ambig.py, 2026-09-21): ALFA FOOD SRL and ALFA-FOOD
    S.R.L. normalize to the same name; 130 other "ALFA …" companies fill the
    first-token search page before the second one. The prefix search saw
    one hit on a full page and handed the book that CUI. Uniqueness is now
    decided over every registered name: ambiguous -> no CUI."""
    st = PublicRoStore(tmp_path / "public_ro.db")
    try:
        _company(st, valid_cui("3100001"), "ALFA FOOD SRL")
        _company(st, valid_cui("3100002"), "ALFA-FOOD S.R.L.")
        for i in range(130):
            _company(st, valid_cui(str(3200000 + i)), "ALFA CONSTRUCT%03d SRL" % i)
        assert registry_match_name(st, "ALFA FOOD SRL") is None
        ident = identify_document(balance_xlsx(["Societate: ALFA FOOD SRL",
                                                "Balanta de verificare la 31.12.2025"]), "b.xlsx", registry=st)
        assert ident.cui is None and ident.company_key == "name:ALFA FOOD"
    finally:
        st.close()


def test_a_punctuation_variant_of_the_registered_name_is_found(tmp_path):
    """The prefix LIKE never reached "AGRA`S FOOD FACTORY S.R.L." from a
    printed "Agras Food Factory"; the normalized index does — and only
    because it is the ONE company with that name."""
    st = PublicRoStore(tmp_path / "public_ro.db")
    try:
        cui = valid_cui("4635509")
        _company(st, cui, "AGRA`S FOOD FACTORY S.R.L.", "1011")
        _company(st, valid_cui("3881501"), "ROM AGRA FOODS S.R.L.", "4623")
        hit = registry_match_name(st, "Agras Food Factory SRL")
        assert hit is not None and hit[0] == cui and hit[1]["name"] == "AGRA`S FOOD FACTORY S.R.L."
    finally:
        st.close()


class _SearchOnlyRegistry:
    """A registry that can only answer capped prefix searches."""

    def __init__(self, rows):
        self.rows = rows

    def get_company(self, cui):
        return next((dict(r) for r in self.rows if r["cui"] == int(cui)), None)

    def search_companies(self, q, limit=20):
        hits = [r for r in sorted(self.rows, key=lambda r: r["name"]) if r["name"].lower().startswith(q.lower())]
        return [dict(r) for r in hits[:limit]]


def test_a_search_only_registry_refuses_on_any_full_page():
    """Without a name listing, a FULL page is unsure even when it holds one
    exact hit — the next page may hold a second company with the name."""
    rows = [{"cui": int(valid_cui("3100001")), "name": "ALFA FOOD SRL", "caen": "1013"}]
    rows += [{"cui": int(valid_cui(str(3300000 + i))), "name": "ALFA FOOD %03d SRL" % i, "caen": None}
             for i in range(REGISTRY_SEARCH_LIMIT)]
    assert registry_match_name(_SearchOnlyRegistry(rows), "ALFA FOOD SRL") is None
    assert registry_match_name(_SearchOnlyRegistry(rows[:3]), "ALFA FOOD SRL")[0] == valid_cui("3100001")


# ── operator-verified identities ───────────────────────────────────────

def test_rules_match_by_hash_before_glob_and_only_for_their_user():
    rules = [{"user_id": "u1", "filename_glob": "*.xlsx", "cui": CUI_A},
             {"content_sha256": "ab" * 32, "cui": CUI_B}]
    assert match_known_identity(rules, user_id="u1", content_sha256="AB" * 32, filename="x.xlsx")["cui"] == CUI_B
    assert match_known_identity(rules, user_id="u1", content_sha256=None, filename="X.XLSX")["cui"] == CUI_A
    assert match_known_identity(rules, user_id="u2", content_sha256=None, filename="x.xlsx") is None


def test_a_rule_never_overrides_a_cui_the_document_prints():
    content = balance_xlsx(["Alfa Food SRL", "Cod fiscal: %s" % CUI_A])
    ident = identify_document(content, "x.xlsx")
    got, conflict = apply_known_identity(ident, {"cui": CUI_B, "evidence": "e"})
    assert got.cui == CUI_A and conflict and "the document wins" in conflict


def test_a_rule_fills_a_cui_the_document_does_not_print(registry):
    ident = identify_document(balance_xlsx([]), "export.xlsx")
    got, conflict = apply_known_identity(ident, {"cui": CUI_A, "evidence": "filing match"}, registry=registry)
    assert conflict is None
    assert got.cui == CUI_A and got.company_name == "ALFA FOOD SRL" and got.caen_code == "1013"
    assert got.sources["cui"] == {"signal": "operator_verified", "evidence": "filing match"}


def test_a_name_only_rule_pins_a_company_without_cui(registry):
    """Blocks a registry NAME match (a stranger's CUI) on purpose."""
    ident = identify_document(balance_xlsx([], sheet="Gamma Agro"), "g.xlsx", registry=registry)
    assert ident.cui is not None
    got, conflict = apply_known_identity(ident, {"cui": None, "company_name": "Gamma Agro (group)",
                                                 "evidence": "no filing"})
    assert conflict is None and got.cui is None and got.company_key == "name:GAMMA AGRO GROUP"


def test_a_rules_caen_layers_on_even_when_the_document_prints_the_same_cui():
    """Verifier finding (2026-09-21): apply_known_identity returned the document identity
    unchanged when the CUIs agreed, so the operator's CAEN (EEI's 6820) was
    never used. The document keeps its CUI; the verified CAEN layers on."""
    ident = identify_document(balance_xlsx(["Alfa Food SRL", "Cod fiscal: %s" % CUI_A]), "x.xlsx")
    assert ident.caen_code is None
    got, conflict = apply_known_identity(ident, {"cui": CUI_A, "caen_code": "6820", "evidence": "verified"})
    assert conflict is None and got.cui == CUI_A and got.company_name == ident.company_name
    assert got.caen_code == "6820" and got.sources["caen_code"]["signal"] == "operator_verified"
    assert got.sources["cui"]["signal"] == "document_header_cui"
    assert got.industry_key == industry_key_for_caen("6820")


def test_a_rule_with_a_bad_cui_is_refused():
    ident = CompanyIdentity()
    got, conflict = apply_known_identity(ident, {"cui": "12345675"})
    assert got is ident and "control digit" in conflict


def test_identity_round_trips_through_json():
    ident = identify_document(balance_xlsx(["Alfa Food SRL", "Cod fiscal: %s" % CUI_A]), "x.xlsx")
    assert CompanyIdentity.from_dict(ident.to_dict()) == ident
    assert hashlib.sha256(repr(ident.to_dict()).encode()).hexdigest()  # plain data, printable
