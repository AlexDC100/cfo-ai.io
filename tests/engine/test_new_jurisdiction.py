"""N7 — THE NEW-JURISDICTION ACCEPTANCE GATE.

THE ARCHITECTURE RULE THIS FILE ENFORCES
────────────────────────────────────────
    Adding a minimal new jurisdiction is AUTHORING A PACK
    (+ optionally a front-end). It requires ZERO changes to src/engine.

That is a claim about the compiler restructure, and a claim is only as
good as the test that can falsify it. So this module actually admits a
brand-new fictional jurisdiction — ZZ, packs/test/zz-minimal-v1 — and
drives a ZZ trial balance all the way through the REAL production path:

    front-end parse        engine.frontends.registry.FRONT_ENDS["csv"]
      -> LedgerDoc IR      engine.ir (Money, ABSENT != ZERO, frozen)
      -> classify          engine.passes.classify.classify(doc, pack)
      -> validate          the pack's OWN checks.yaml bindings, run
                           through engine.packs.schema.CHECK_IMPLS
      -> canonical build   build_canonical_bs_v2 (the ONE builder)
      -> persist           engine.api.pipeline.stage_persist, which is
                           also the auto-reconcile seam
      -> serve             engine.api._reconcile.served_canonical_bs
      -> facts             engine.serving.FactsGateway

and then asserts the two properties that make the gate permanent rather
than decorative:

  (a) CHANGE-SET CONTAINMENT — every repo path the ZZ scenario
      introduced lives under packs/ or tests/. If a future contributor
      admits a jurisdiction by editing src/engine, this fails.
  (b) NO ZZ-SPECIFIC ENGINE BRANCH — src/engine contains zero
      occurrences of the ZZ token. The engine must reach ZZ through
      pack DATA (discovery, the pack's rules, the pack's statement map),
      never by name.

WHAT N7 ALREADY CAUGHT (kept here so the next reader knows the gate
works): the jurisdiction resolver's explicit-user-choice rung normalized
every code outside a hardcoded {RO, HU} set to "OTHER", so no new
jurisdiction could ever be named — a closed enum in engine code standing
in for the registry that packs/ actually is. Fixed data-driven:
``engine.ai_lane.jurisdiction_resolver`` now admits any code with a
DISCOVERABLE PACK (``selectable_jurisdictions`` / ``_has_pack``), and the
reextract route's jurisdiction allowlist reads that same function instead
of keeping its own copy. Behavior for every pre-existing value (RO / ROU
/ ROMANIA / HU / HUN / HUNGARY / INTL / unknown) is unchanged.

THE ONE THING THAT IS NOT PRODUCTION CODE HERE: ``_assemble_zz`` below.
The compiler restructure has a classify pass but not yet an ASSEMBLER
pass — today's assembly lives inside RomaniaPack (RO-specific) and
inside the AI lane's ``build_ai_envelope`` (which stamps method="llm"
and can therefore never be BALANCED). ``_assemble_zz`` is the ~40 lines
that gap costs a new jurisdiction. It is written to be entirely
PACK-DATA-DRIVEN — it reads sections and leaves off the ZZ pack's own
statement map and contains no ZZ-specific knowledge — so it would run
verbatim for any pack; when the assembler pass lands, this helper is
deleted and the test calls it instead. See docs/ADDING_A_JURISDICTION.md.
"""
from __future__ import annotations

import contextlib
import copy
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pytest

# Registers RomaniaPack; also the module that owns the shared canonical
# builder + the mapping_version derivation both lanes use.
import engine.country_packs.ro_romania  # noqa: F401
from engine.api import _reconcile
from engine.api import pipeline as _pipeline
from engine.canonical import schema_version
from engine.country_packs.ro_romania import chart_of_accounts as _coa
from engine.country_packs.ro_romania.canonical_adapter import build_canonical_bs_v2
from engine.frontends.legacy_adapter import derive_legacy
from engine.frontends.registry import FRONT_ENDS
from engine.ir import LedgerDoc, Money
from engine.packs import CHECK_IMPLS, CompiledPack, PackIssue, lint_pack, load_pack
from engine.packs.runtime import active_pack, default_packs_root
from engine.passes.classify import METHOD_RULE, ClassificationLayer, classify
from engine.serving import FactsGateway

REPO = Path(__file__).resolve().parents[2]
ZZ_PACK_DIR = REPO / "packs" / "test" / "zz-minimal-v1"
ZZ_FIXTURE = REPO / "tests" / "engine" / "fixtures" / "zz_minimal_tb.csv"
ENGINE_TREE = REPO / "src" / "engine"

#: The fictional jurisdiction + its currency. Both are ISO user-assigned
#: ("ZZ" alpha-2, "ZZK" alpha-3) so they can never collide with a real one.
ZZ = "ZZ"
ZZ_CURRENCY = "ZZK"


# ═══════════════════════════════════════════════════════════════════════
# (a) THE CHANGE-SET MANIFEST
# ═══════════════════════════════════════════════════════════════════════
#
# EVERY repo path the ZZ scenario introduced. Adding a jurisdiction is a
# pack + (test) fixture exercise; if admitting one ever needs an engine
# file, that file cannot be listed here and the containment assertion
# below fails. Keep this list exhaustive — it IS the claim.
ZZ_CHANGE_SET: Tuple[str, ...] = (
    # the pack — pure data, five required files + a "this is fictional" note
    "packs/test/zz-minimal-v1/pack.yaml",
    "packs/test/zz-minimal-v1/classification.yaml",
    "packs/test/zz-minimal-v1/statement_map.yaml",
    "packs/test/zz-minimal-v1/checks.yaml",
    "packs/test/zz-minimal-v1/reconcile.yaml",
    "packs/test/zz-minimal-v1/README.md",
    # the acceptance scenario itself
    "tests/engine/fixtures/zz_minimal_tb.csv",
    "tests/engine/test_new_jurisdiction.py",
)

#: The only two roots a jurisdiction change-set may touch.
ALLOWED_CHANGE_SET_ROOTS = ("packs/", "tests/")

#: Standalone `zz` / `ZZ` letter-run, case-insensitive, not part of a
#: longer word (so `fizzbuzz`, `Zzz`-in-a-string and base64 blobs do not
#: trip it, while `jurisdiction == "ZZ"` and `zz_pack` do).
ZZ_TOKEN_RE = re.compile(r"(?<![A-Za-z])[Zz][Zz](?![A-Za-z])")

#: Files under src/engine that are allowed to contain the token, with the
#: reason. EMPTY ON PURPOSE: the engine reaches ZZ through pack discovery
#: and pack data, never by name. An entry here is a design regression that
#: needs justifying in review, not a routine exemption.
ZZ_ENGINE_TOKEN_ALLOWLIST: Dict[str, str] = {}


# ═══════════════════════════════════════════════════════════════════════
# Fixtures + the pack-data-driven assembly helper
# ═══════════════════════════════════════════════════════════════════════


@pytest.fixture(scope="module")
def zz_pack() -> CompiledPack:
    """The ZZ pack, resolved through the PRODUCTION runtime against the
    REAL repo packs root — i.e. by discovery, exactly the way RO and HU
    are resolved. Not `load_pack(dir)`: pointing at the directory would
    prove the loader works, not that the jurisdiction is ADMITTED."""
    assert default_packs_root() == REPO / "packs", (
        "N7 must exercise the real packs root; ENGINE_PACKS_ROOT / "
        "SHADOW_PACK_ROOT appear to be pointing elsewhere"
    )
    return active_pack(ZZ)


@pytest.fixture(scope="module")
def zz_doc() -> LedgerDoc:
    """The ZZ trial balance parsed by an EXISTING front-end.

    The fixture is a 4-column delimited trial balance — a layout the
    deterministic `csv` front-end already understands. That is the other
    half of the architecture claim: a new jurisdiction needs a new
    FRONT-END only when its documents arrive in a layout nothing parses
    yet, never merely because the jurisdiction is new. Jurisdiction and
    currency ride in as hints; the front-end takes them as data."""
    data = ZZ_FIXTURE.read_bytes()
    doc, diagnostics = FRONT_ENDS["csv"].parse(
        data,
        {"filename": ZZ_FIXTURE.name, "jurisdiction": ZZ, "currency": ZZ_CURRENCY},
    )
    codes = [d.get("code") for d in diagnostics]
    assert "format_mismatch" not in codes, diagnostics
    return doc


def _leaf_placement(pack: CompiledPack) -> Dict[str, Tuple[str, str]]:
    """{leaf id -> (statement, top-level node id)} read off the PACK's own
    statement map. Top-level balance-sheet node ids are the canonical
    section ids; the `excluded` branch is not a section."""
    placement: Dict[str, Tuple[str, str]] = {}

    def walk(statement: str, top_id: str, node: Any) -> None:
        placement[node.id] = (statement, top_id)
        for child in node.children:
            walk(statement, top_id, child)

    for top in pack.balance_sheet:
        walk("balance_sheet", top.id, top)
    for top in pack.profit_loss:
        walk("profit_loss", top.id, top)
    return placement


#: Debit-natural balance-sheet sections. Leaf SIDE is schema-owned engine
#: placement logic (canonical_adapter._BS_V2_ASSET_SECTIONS), not
#: jurisdiction data — a pack never declares it.
_ASSET_SECTIONS = frozenset({"non_current_assets", "current_assets", "prepaid_expenses"})
_EXCLUDED_TOP = "excluded"


def _debit_signed_minor(atom: Any) -> int:
    """The atom's CLOSING balance as exact integer minor units, debit
    positive. ABSENT slots contribute nothing (they are not zero — the
    4-column layout simply has no opening/period columns)."""
    monies: List[Money] = [
        m for m in (atom.closing_debit, atom.closing_credit) if m is not None
    ]
    if not monies:
        return 0
    scale = max(m.scale for m in monies)

    def at(money: Optional[Money]) -> int:
        if money is None:
            return 0
        return money.amount_minor * (10 ** (scale - money.scale))

    assert scale == 2, "fixture is stated in whole minor units (cents)"
    return at(atom.closing_debit) - at(atom.closing_credit)


def _assemble_zz(
    doc: LedgerDoc, layer: ClassificationLayer, pack: CompiledPack
) -> Tuple[Dict[str, int], List[Dict[str, Any]], List[Dict[str, Any]]]:
    """THE NOT-YET-EXTRACTED ASSEMBLER PASS (see the module docstring).

    Pack-data-driven, zero ZZ knowledge: every decision below reads the
    pack's statement map or the classify layer.

      * a leaf on an asset-natural section takes the DEBIT-signed closing
        balance; every other balance-sheet section takes the credit-signed
        one — so a contra line whose balance sits on the side opposite its
        section arrives NEGATIVE and subtracts, and a side-flipped line
        lands positive on the section it was re-routed to;
      * profit-and-loss leaves net into the current-year result leaf
        (credit − debit), which is what lets a trial balance carrying
        class 6/7 closing balances add up as a balance sheet;
      * the statement map's `excluded` branch leaves the statement AND the
        balance judgment entirely.

    Returns (leaf cents, line items, excluded accounts).
    """
    placement = _leaf_placement(pack)
    leaves_cents: Dict[str, int] = {}
    line_items: List[Dict[str, Any]] = []
    excluded: List[Dict[str, Any]] = []
    pl_net_cents = 0

    for atom, entry in zip(doc.atoms, layer.entries):
        assert entry.atom_id == atom.atom_id
        signed = _debit_signed_minor(atom)
        if entry.line_id is None:
            # No rule matched. The canonical builder keeps such balances
            # in the totals via explicit Unclassified rows; the ZZ fixture
            # has none, so a miss here is a pack/fixture drift, not a
            # tolerated state.
            raise AssertionError(
                "account %r matched no ZZ rule — the fixture and the pack "
                "have drifted apart" % entry.account_code
            )
        statement, section = placement[entry.line_id]
        if section == _EXCLUDED_TOP:
            excluded.append({
                "code": entry.account_code,
                "name": atom.label,
                "reason": "excluded_by_pack_rule:%s" % entry.rule_id,
            })
            continue
        if statement == "profit_loss":
            pl_net_cents += -signed
            line_items.append({
                "statement": "PL", "bucket": entry.line_id,
                "canonical_bucket": entry.line_id,
                "ro_account_code": entry.account_code,
                "ro_account_name": atom.label,
                "amount": (-signed if signed < 0 else signed) / 100.0,
                "is_derived": False,
            })
            continue
        value = signed if section in _ASSET_SECTIONS else -signed
        leaves_cents[entry.line_id] = leaves_cents.get(entry.line_id, 0) + value
        line_items.append({
            "statement": "BS", "bucket": entry.line_id,
            "canonical_bucket": entry.line_id,
            "ro_account_code": entry.account_code,
            "ro_account_name": atom.label,
            "amount": value / 100.0,
            "is_derived": False,
        })

    if pl_net_cents:
        result_leaf = "current_year_profit" if pl_net_cents > 0 else "current_year_loss"
        leaves_cents[result_leaf] = leaves_cents.get(result_leaf, 0) + pl_net_cents
    return leaves_cents, line_items, excluded


def _zz_envelope(
    doc: LedgerDoc, layer: ClassificationLayer, pack: CompiledPack
) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    """Assembly -> the canonical envelope, THROUGH the production builder.

    `line_items=None` on purpose: the builder's line-item router resolves
    RO account prefixes and must never guess a foreign chart's codes. The
    envelope's leaves are the authority (the same call shape the AI lane
    uses for HU / INTL)."""
    leaves_cents, line_items, excluded = _assemble_zz(doc, layer, pack)
    legacy = derive_legacy(doc)  # production IR -> legacy bridge
    anchor = dict(legacy.tb_rows.source_anchor or {})
    extraction = dict(legacy.tb_rows.extraction or {})

    envelope: Dict[str, Any] = {
        "schema_version": schema_version(),
        "leaves": {
            name: {"ras_line_items_sum_signed": cents / 100.0}
            for name, cents in sorted(leaves_cents.items())
        },
        "aggregates": {},
        "unmapped": [],
        "source_data_quality": {
            "sum_closing_debit": (anchor.get("pairs", {}).get("sf") or {}).get(
                "extracted_debit"
            ),
            "sum_closing_credit": (anchor.get("pairs", {}).get("sf") or {}).get(
                "extracted_credit"
            ),
        },
        "round_trip_check": {"passed": True, "note": "N7 acceptance scenario"},
    }
    envelope["canonical_bs"] = build_canonical_bs_v2(
        envelope,
        line_items=None,
        source_anchor=anchor,
        unmapped=[],
        excluded=excluded,
        extraction=extraction,
        source_account_census=None,
    )
    # Pin the envelope to the pack that classified it. The vintage string
    # derives MECHANICALLY from the pack identity through the production
    # helper — no alias exists for ZZ, so it takes the generic form.
    envelope["pack_provenance"] = {
        "jurisdiction": pack.identity.jurisdiction,
        "pack": "%s@%s" % (pack.identity.pack_id, pack.identity.version),
        "pack_hash": pack.pack_hash,
        "mapping_version": _coa.mapping_version_for(pack.identity),
    }
    return envelope, line_items


# ── the stage_persist harness (pattern shared with
#    tests/engine/test_reconciliation.py and scripts/corpus_replay.py) ──


class _FakeAdminClient:
    """In-memory stand-in for _supabase.admin()'s client."""

    def __init__(self) -> None:
        self.period_rows: List[Dict[str, Any]] = []
        self.updates: List[Tuple[str, Dict[str, Any], Dict[str, Any]]] = []
        self.inserted_line_items: List[Dict[str, Any]] = []

    def select(self, table: str, *, filters: Optional[Dict[str, Any]] = None,
               columns: str = "*", limit: Optional[int] = None,
               order: Optional[str] = None, single: bool = False):
        if table != "financial_periods":
            return []

        def matches(row: Dict[str, Any]) -> bool:
            for key, value in (filters or {}).items():
                if not str(value).startswith("eq."):
                    return False
                if str(row.get(key)) != str(value)[3:]:
                    return False
            return True

        return [r for r in self.period_rows if matches(r)]

    def insert(self, table: str, rows: Any, returning: bool = True):
        rows_list = rows if isinstance(rows, list) else [rows]
        if table == "financial_periods":
            new = dict(rows_list[0])
            new["id"] = "period-zz-1"
            self.period_rows.append(new)
            return [new]
        if table == "statement_line_items":
            self.inserted_line_items.extend(rows_list)
        return rows_list if returning else []

    def update(self, table: str, patch: Dict[str, Any], *,
               filters: Optional[Dict[str, Any]] = None) -> None:
        self.updates.append((table, copy.deepcopy(patch), dict(filters or {})))
        if table == "financial_periods":
            for row in self.period_rows:
                if (filters or {}).get("id") == "eq.%s" % row.get("id"):
                    row.update(copy.deepcopy(patch))

    def delete(self, table: str, *, filters: Optional[Dict[str, Any]] = None) -> None:
        return None


@contextlib.contextmanager
def _fake_persist_seam():
    fake = _FakeAdminClient()

    @contextlib.contextmanager
    def _fake_admin():
        yield fake

    prior = _pipeline._supabase.admin
    _pipeline._supabase.admin = _fake_admin
    try:
        yield fake
    finally:
        _pipeline._supabase.admin = prior


def _persist(envelope: Dict[str, Any], line_items: List[Dict[str, Any]]) -> Dict[str, Any]:
    """The REAL pipeline.stage_persist — which is also the auto-reconcile
    seam (carry_forward_reconciliation + auto_reconcile_envelope run
    between the canonical build and the single envelope write). Returns
    the persisted envelope."""
    doc = {
        "id": "doc-zz-n7",
        "org_id": "org-n7",
        "original_filename": ZZ_FIXTURE.name,
        "content_hash": "sha256-n7-zz-minimal",
        "period_end_hint": "2025-12-31",
    }
    parsed = {
        "currency": ZZ_CURRENCY,
        "confidence": 0.95,
        "period_end": "2025-12-31",
        "detected_type": "trial_balance",
    }
    assembled = {
        "lineItems": line_items,
        "assembled_canonical_v1": envelope,
    }
    with _fake_persist_seam() as fake:
        period_id = _pipeline.stage_persist(doc, parsed, assembled)
        assert period_id == "period-zz-1"
        writes = [
            patch["assembled_canonical_v1"]
            for table, patch, _f in fake.updates
            if table == "financial_periods" and "assembled_canonical_v1" in patch
        ]
    assert writes, "stage_persist wrote no canonical envelope for ZZ"
    return writes[-1]


@pytest.fixture(scope="module")
def zz_run(zz_pack, zz_doc):
    """The whole ZZ scenario, once: classify -> assemble -> build ->
    persist -> serve -> facts."""
    layer = classify(zz_doc, zz_pack)
    envelope, line_items = _zz_envelope(zz_doc, layer, zz_pack)
    persisted = _persist(envelope, line_items)
    served = _reconcile.served_canonical_bs(persisted)
    gateway = FactsGateway.from_envelope(persisted, currency=ZZ_CURRENCY)
    return {
        "layer": layer,
        "envelope": persisted,
        "served": served,
        "gateway": gateway,
    }


def _rows_by_id(served: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    return {r["id"]: r for r in served.get("rows") or []}


def _sections(served: Dict[str, Any]) -> Dict[str, float]:
    return {s["id"]: s["subtotal"] for s in served.get("sections") or []}


# ═══════════════════════════════════════════════════════════════════════
# 1. The pack is ADMITTED by discovery, and it is clean data
# ═══════════════════════════════════════════════════════════════════════


def test_new_jurisdiction_is_admitted_by_pack_discovery(zz_pack):
    """No engine edit made ZZ resolvable — a directory under packs/ did.

    If this fails with NoPackFoundError, discovery stopped being the
    registry: something is enumerating jurisdictions in code again."""
    assert zz_pack.identity.jurisdiction == ZZ
    assert zz_pack.identity.pack_id == "zz-minimal"
    assert zz_pack.identity.version == "v1"
    # effective-dated resolution reaches the same pack for a real period
    assert active_pack(ZZ, period_end="2025-12-31").pack_hash == zz_pack.pack_hash
    # content-addressed: the pack directory and the resolved pack agree
    assert load_pack(ZZ_PACK_DIR).pack_hash == zz_pack.pack_hash


def test_new_jurisdiction_pack_lints_clean():
    """A jurisdiction pack must pass pack_lint with ZERO findings —
    warnings included. Warnings here are shadowed/dead rules, i.e. rules
    whose author believed they were classifying something."""
    report = lint_pack(ZZ_PACK_DIR)
    findings: List[PackIssue] = list(report.findings)
    assert findings == [], "\n".join(f.render() for f in findings)


def test_new_jurisdiction_pack_exercises_every_rule_kind(zz_pack):
    """The worked example has to stay a worked example: if a rule kind
    disappears from it, docs/ADDING_A_JURISDICTION.md stops being backed
    by anything."""
    kinds = {r.kind for r in zz_pack.rules}
    assert kinds == {"exact", "prefix", "range"}
    assert any(r.contra for r in zz_pack.rules), "no contra rule left"
    assert any(r.side_flip is not None for r in zz_pack.rules), "no side_flip rule left"
    # exact > longest-prefix: code 100 is claimed by BOTH the exact rule
    # and the "10" prefix rule; the exact one must win.
    assert zz_pack.match("100").rule_id == "zz.100"
    assert zz_pack.match("109").rule_id == "zz.1xx"
    # prefix > range: 9xx is a prefix rule, and no range may cover it
    assert zz_pack.match("900").rule_id == "zz.9xx"
    # range band semantics: first-L-digits inside [from, to]
    assert zz_pack.match("600").rule_id == "zz.expenses"
    assert zz_pack.match("649").rule_id == "zz.expenses"
    assert zz_pack.match("650") is None
    assert zz_pack.match("700").rule_id == "zz.revenue"


def test_new_jurisdiction_checks_only_reference_registered_impls(zz_pack):
    """A pack is DATA. It may name an engine check implementation; it may
    never supply one. Every `impl` it names must be in the registry —
    which is also why the loader would have refused this pack outright if
    checks.yaml invented an id."""
    named = {c.impl for c in zz_pack.checks if c.impl}
    assert named, "the ZZ pack binds no check impl at all"
    assert named <= set(CHECK_IMPLS), sorted(named - set(CHECK_IMPLS))


# ═══════════════════════════════════════════════════════════════════════
# 2. The jurisdiction resolver REACHES the new jurisdiction
# ═══════════════════════════════════════════════════════════════════════


def test_resolver_reaches_new_jurisdiction_via_explicit_hint():
    """The explicit-user-choice rung must be able to NAME a jurisdiction
    that has a pack. This is the rung N7 originally found closed: a
    hardcoded {RO, HU} set sent every other code to "OTHER", so a new
    pack was unreachable no matter what the user chose."""
    from engine.ai_lane import resolve_jurisdiction
    from engine.ai_lane import jurisdiction_resolver as jr

    assert jr.resolve({}, b"", ZZ) == {
        "jurisdiction": ZZ, "source": "user", "confidence": 1.0,
    }
    # the documented contract path: documents.jurisdiction_hint
    assert resolve_jurisdiction({"jurisdiction_hint": "zz"}, b"anything")[
        "jurisdiction"
    ] == ZZ
    # …and it is admitted BY DISCOVERY, not by name
    assert ZZ in jr.selectable_jurisdictions()


def test_resolver_admission_is_data_driven_not_an_allowlist():
    """Every pre-existing value keeps its exact meaning; a code with no
    pack still resolves OTHER. Admission moved from a literal set in
    engine code to 'does packs/ contain this jurisdiction'."""
    from engine.ai_lane import jurisdiction_resolver as jr

    assert jr._normalize_choice("RO") == "RO"
    assert jr._normalize_choice("romania") == "RO"
    assert jr._normalize_choice("HU") == "HU"
    assert jr._normalize_choice("HUNGARY") == "HU"
    # INTL is the generic pack's wire code, not a jurisdiction
    assert jr._normalize_choice("INTL") == "OTHER"
    # a country with no pack is not selectable
    assert jr._normalize_choice("DE") == "OTHER"
    assert "DE" not in jr.selectable_jurisdictions()


def test_reextract_route_offers_every_packed_jurisdiction():
    """The API's jurisdiction override read from its own hardcoded set,
    so a deployed pack was still unselectable. It now reads the resolver's
    data-driven answer — one source of truth, no drift."""
    from engine.ai_lane.routes import _allowed_jurisdictions

    allowed = _allowed_jurisdictions()
    assert ZZ in allowed
    # the pre-existing offer is unchanged
    assert {"RO", "HU", "INTL"} <= set(allowed)


# ═══════════════════════════════════════════════════════════════════════
# 3. The FULL pipeline serves a sane, balanced ZZ statement
# ═══════════════════════════════════════════════════════════════════════


def test_front_end_parses_the_new_jurisdiction_without_a_new_front_end(zz_doc):
    """A supported LAYOUT carries the data, so no front-end was written.
    The header takes jurisdiction + currency as DATA."""
    assert zz_doc.header.jurisdiction == ZZ
    assert zz_doc.header.currency == ZZ_CURRENCY
    assert zz_doc.header.source_meta["extraction"]["source_format"] == "generic_4_col"
    assert len(zz_doc.atoms) == 12
    # a 4-column layout HAS no opening/period columns: ABSENT, not zero
    assert all(a.opening_debit is None and a.period_debit is None for a in zz_doc.atoms)
    # the file's own totals row, copied verbatim by the front-end
    totals = zz_doc.header.document_totals
    assert totals.closing_debit.amount_minor == 21_100_000
    assert totals.closing_credit.amount_minor == 21_100_000


def test_classify_runs_the_new_pack_over_the_ir(zz_run, zz_pack):
    """Every atom is classified by a ZZ RULE — deterministic table
    lookup, confidence 1.0 — and the layer is stamped with the ZZ pack's
    content hash."""
    layer = zz_run["layer"]
    assert layer.pack_hash == zz_pack.pack_hash
    assert layer.unclassified_count == 0
    assert layer.classified_count == 12
    assert {e.method for e in layer.entries} == {METHOD_RULE}
    by_code = {e.account_code: e for e in layer.entries}
    assert by_code["100"].line_id == "share_capital"      # exact
    assert by_code["200"].line_id == "ppe_buildings"      # prefix
    assert by_code["600"].line_id == "other_operating_expenses"  # range
    assert by_code["700"].line_id == "revenue_products"          # range
    assert by_code["900"].line_id == "excluded_control"


def test_pack_bound_checks_run_on_the_new_jurisdiction(zz_run):
    """The VALIDATE seam: the pack's checks.yaml binds engine impls by
    id, and those impls actually run on a ZZ envelope. Debits = Credits
    is the strongest trial-balance signal and must pass."""
    envelope = zz_run["envelope"]
    identities = CHECK_IMPLS["builtin.reconciliation_identities"]({
        "statements": {},
        "source_data_quality": envelope.get("source_data_quality"),
        "assembled_canonical_v1": envelope,
    })
    by_id = {c.id: c for c in identities}
    assert by_id["debits_credits"].passed, by_id["debits_credits"]
    # the diagnosis impl is reachable too, and finds nothing to report on
    # a statement that closes exactly
    diagnosis = CHECK_IMPLS["builtin.bs_diagnosis"](
        envelope["canonical_bs"], [], envelope["canonical_bs"]["source_anchor"],
    )
    assert diagnosis == [], diagnosis


def test_served_statement_is_balanced_and_reconciles_exactly(zz_run):
    """The headline assertion: a fictional jurisdiction, admitted by a
    pack alone, produces a BALANCED statement whose totals close to the
    cent — through the real persist/auto-reconcile/serve path."""
    served = zz_run["served"]
    assert served is not None
    assert served["schema"] == "bs_v2"
    assert served["status"] == "BALANCED"
    assert served["difference"] == 0.0
    totals = served["totals"]
    assert totals["assets"] == 150_000.0
    assert totals["equity"] == 127_000.0
    assert totals["liabilities"] == 23_000.0
    assert totals["equity_plus_liabilities"] == 150_000.0
    assert totals["assets"] == totals["equity_plus_liabilities"]
    # the identity is asserted by the builder, not plugged
    invariants = served["invariants"]
    assert invariants["assets_eq_row_sum"] is True
    assert invariants["el_eq_row_sum"] is True
    assert invariants["identity_holds"] is True
    # nothing needed reconciling, so nothing was offered
    assert served.get("needs_review") is False
    assert served.get("reconcile_offer") is False
    assert "reconciliation" not in zz_run["envelope"]


def test_sections_and_rows_follow_the_packs_statement_map(zz_run):
    sections = _sections(zz_run["served"])
    assert sections["non_current_assets"] == 80_000.0   # 100k gross − 20k contra
    assert sections["current_assets"] == 70_000.0       # 15k + 30k + 25k
    assert sections["equity"] == 127_000.0              # 80k capital + 47k result
    assert sections["current_liabilities"] == 23_000.0  # 18k AP + 5k overdraft
    rows = _rows_by_id(zz_run["served"])
    assert rows["ppe_buildings"]["amount"] == 100_000.0
    assert rows["inventory_raw_materials"]["amount"] == 15_000.0
    assert rows["ar_trade_gross"]["amount"] == 30_000.0
    assert rows["share_capital"]["amount"] == 80_000.0
    assert rows["ap_trade"]["amount"] == 18_000.0
    # the P&L nets into the current-year result leaf: 87k − 40k
    assert rows["current_year_profit"]["amount"] == 47_000.0
    # no value leaked into an Unclassified row
    assert "unclassified_debit" not in rows
    assert "unclassified_credit" not in rows


def test_contra_rule_reduces_its_asset_side(zz_run, zz_pack):
    """A contra rule SUBTRACTS from its section. 28x accumulated
    depreciation carries `contra: true` in the pack and lands negative on
    the non-current asset side, so PP&E is presented net."""
    rule = zz_pack.match("280")
    assert rule.rule_id == "zz.28x"
    assert rule.contra is True
    assert rule.line_id == "accumulated_depreciation_ppe"
    rows = _rows_by_id(zz_run["served"])
    contra_row = rows["accumulated_depreciation_ppe"]
    assert contra_row["section"] == "non_current_assets"
    assert contra_row["amount"] == -20_000.0
    gross = rows["ppe_buildings"]["amount"]
    assert _sections(zz_run["served"])["non_current_assets"] == gross - 20_000.0


def test_side_conditional_rule_flips_on_the_closing_credit_side(zz_run, zz_pack):
    """The side_flip rule re-routes ONLY on the closing side it names.
    Two accounts share the 51x rule: 510 closes DEBIT and stays cash;
    511 closes CREDIT and becomes short-term bank debt — an overdraft is
    a liability, never negative cash."""
    rule = zz_pack.match("511")
    assert rule.rule_id == "zz.51x"
    assert rule.line_id == "cash_operating"
    assert rule.side_flip.side == "credit"
    assert rule.side_flip.line_id == "st_debt_bank"

    by_code = {e.account_code: e for e in zz_run["layer"].entries}
    assert by_code["510"].closing_side == "debit"
    assert by_code["510"].side_flipped is False
    assert by_code["510"].line_id == "cash_operating"
    assert by_code["511"].closing_side == "credit"
    assert by_code["511"].side_flipped is True
    assert by_code["511"].line_id == "st_debt_bank"

    rows = _rows_by_id(zz_run["served"])
    assert rows["cash_operating"]["amount"] == 25_000.0   # NOT 20 000 net
    assert rows["st_debt_bank"]["amount"] == 5_000.0
    assert rows["st_debt_bank"]["section"] == "current_liabilities"
    # …and the pack's own lookup agrees with what classify did
    assert zz_pack.target_line("511", "credit") == "st_debt_bank"
    assert zz_pack.target_line("511", "debit") == "cash_operating"


def test_excluded_accounts_stay_out_of_every_total(zz_run):
    """The statement map's `excluded` branch is not a section. The two
    memo accounts self-balance in the source, so dropping them keeps the
    statement's identity intact — and they stay listed, never silently
    vanished."""
    served = zz_run["served"]
    excluded_codes = {e["code"] for e in served.get("excluded") or []}
    assert excluded_codes == {"900", "901"}
    rows = _rows_by_id(served)
    assert "excluded_control" not in rows
    assert served["totals"]["assets"] == 150_000.0  # 1 000 memo debit not in it


def test_envelope_is_pinned_to_the_new_pack(zz_run, zz_pack):
    """pack_provenance stamps id@version + the content-addressed hash, so
    a stored ZZ period can always be tied to the exact pack data that
    classified it. The mapping_version derives mechanically — a new
    jurisdiction needs no alias-table entry."""
    provenance = zz_run["envelope"]["pack_provenance"]
    assert provenance == {
        "jurisdiction": "ZZ",
        "pack": "zz-minimal@v1",
        "pack_hash": zz_pack.pack_hash,
        "mapping_version": "zz_zz-minimal_pack_v1",
    }
    # additive-only: the stamp lives at the envelope ROOT and never
    # reaches the served payload
    assert "pack_provenance" not in (zz_run["envelope"].get("canonical_bs") or {})
    assert "pack_provenance" not in zz_run["served"]


def test_facts_gateway_serves_the_new_jurisdiction(zz_run):
    """The gateway is the ONE legal source of financial facts. It reads a
    ZZ envelope with no jurisdiction knowledge at all, in the fictional
    currency, in exact integer minor units."""
    gateway = zz_run["gateway"]
    assert gateway is not None
    assert gateway.tier == FactsGateway.TIER_CANONICAL
    assert gateway.total_assets().amount_minor == 15_000_000
    assert gateway.equity().amount_minor == 12_700_000
    assert gateway.net_result().amount_minor == 4_700_000
    assert gateway.total_assets().currency == ZZ_CURRENCY


# ═══════════════════════════════════════════════════════════════════════
# 4. WHAT MAKES N7 PERMANENT — the change-set assertions
# ═══════════════════════════════════════════════════════════════════════


def test_the_whole_change_set_lives_under_packs_and_tests():
    """(a) CONTAINMENT.

    Adding a jurisdiction is authoring DATA. Every path the ZZ scenario
    introduced must live under packs/ (the jurisdiction data) or tests/
    (the fixture + this gate). Nothing under src/, frontend/, scripts/ or
    supabase/.

    IF THIS FAILS you have almost certainly just admitted a jurisdiction
    by editing engine code. That is the thing N7 exists to stop: the
    engine must learn a jurisdiction from a pack, not from a branch. Move
    the knowledge into packs/<jur>/... and make whatever engine mechanism
    forced your hand read pack DATA instead — then this list stays two
    roots long forever.
    """
    # The allowlist is PINNED. Without this, the cheapest way to silence a
    # containment failure is to append the offending root to
    # ALLOWED_CHANGE_SET_ROOTS — a one-token edit that turns the gate off
    # for good while leaving it green. Widening it must be a deliberate,
    # reviewed change to THIS assertion, not a quiet edit to a constant.
    assert ALLOWED_CHANGE_SET_ROOTS == ("packs/", "tests/"), (
        "the containment allowlist was widened to %s. Adding a jurisdiction "
        "is authoring data: it may touch packs/ and tests/ and nothing else. "
        "If an engine root truly belongs here, that is a finding to argue in "
        "review — not a constant to edit." % (list(ALLOWED_CHANGE_SET_ROOTS),)
    )
    for rel in ZZ_CHANGE_SET:
        path = REPO / rel
        assert path.exists(), "manifest lists a path that does not exist: %s" % rel
        assert rel.startswith(ALLOWED_CHANGE_SET_ROOTS), (
            "%s is outside %s — see this test's docstring"
            % (rel, list(ALLOWED_CHANGE_SET_ROOTS))
        )
    # and the manifest is exhaustive for the pack itself
    on_disk = sorted(
        str(p.relative_to(REPO)).replace("\\", "/")
        for p in ZZ_PACK_DIR.rglob("*") if p.is_file()
    )
    listed = sorted(r for r in ZZ_CHANGE_SET if r.startswith("packs/"))
    assert on_disk == listed, (
        "the ZZ pack directory and the change-set manifest disagree; add "
        "new pack files to ZZ_CHANGE_SET so containment stays checkable"
    )


def test_engine_tree_has_no_new_jurisdiction_specific_branch():
    """(b) NO SPECIAL CASE.

    src/engine must contain ZERO occurrences of the ZZ token. The engine
    reaches ZZ the same way it reaches every jurisdiction: pack discovery
    admits it, the pack's rules classify it, the pack's statement map
    places it. A `if jurisdiction == "ZZ"` anywhere would mean N7 is
    testing a special case instead of the architecture.

    IF THIS FAILS: delete the branch and express the same intent as pack
    data or as a generic, name-free mechanism (that is exactly how the
    resolver's closed {RO, HU} choice-set was replaced by pack-discovery
    admission). Only add to ZZ_ENGINE_TOKEN_ALLOWLIST with a reviewed
    reason — it is empty on purpose.
    """
    offenders: List[str] = []
    for path in sorted(ENGINE_TREE.rglob("*")):
        if not path.is_file() or path.suffix not in (".py", ".yaml", ".yml", ".json"):
            continue
        rel = str(path.relative_to(REPO)).replace("\\", "/")
        if rel in ZZ_ENGINE_TOKEN_ALLOWLIST:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for lineno, line in enumerate(text.splitlines(), 1):
            if ZZ_TOKEN_RE.search(line):
                offenders.append("%s:%d: %s" % (rel, lineno, line.strip()))
    assert offenders == [], (
        "src/engine names the test jurisdiction directly:\n  "
        + "\n  ".join(offenders)
        + "\n\nSee this test's docstring: the engine must learn a "
          "jurisdiction from pack DATA, never by name."
    )
