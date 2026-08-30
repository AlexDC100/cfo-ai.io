"""THE GATE-CANARY LAW — a gate must be provably capable of failing.

NOTE ON INVARIANT IDS. This file deliberately claims NO bare invariant
marker. `scripts/generate_engine_book.py` discovers families by scanning
tests/engine for bare `[IKMNPV]<digits>` tokens, so an id written here
would list this file as an enforcing test for someone else's invariant —
a first draft opened with a K-id already owned by the journal suite and
the regenerated catalog duly credited this file with as-of time travel.
The battery's own register is docs/engine_book/gates.md.

This suite is the antibody against the class of defect that made every
"gate green" claim in this project's history retroactively meaningless.

THE INCIDENT. ``npx tsc --noEmit`` sat in ``scripts/run_battery.py`` and
was pasted as proof by every lane for months. It checked ZERO FILES: the
root ``tsconfig.json`` is solution-style (``"files": []`` plus
``references``), so without ``-b`` tsc obeys the empty file list, finds
nothing, and exits 0 in 0.2 s. It hid 102 real type errors across 32
files. The 0.2 s-versus-9 s runtime was the tell, and nobody read it,
because a green gate invites no reading.

THREE SIBLINGS, all real, all here:

  * ``scripts/check_metric_declared.py``, first draft — scanned KEYWORD
    arguments only, reported "0 metrics" for a package containing
    dozens, and PRINTED A PASS.
  * ``scripts/check_stale_gates.mjs``, first draft — matched
    ``data-testid=`` attributes only, and called 20 live sidebar ids
    stale because they are declared in a config array as ``testId:``.
  * ``e2e/design/capsule.spec.ts`` — three gates passed VACUOUSLY: one
    stubbed an answer never requested, one a gap payload never fetched,
    one watched an endpoint never called. Each would have kept passing
    with its invariant deleted.

WHAT THIS SUITE ENFORCES. Every gate registered in the battery must
carry, mechanically:

  1. a WORK COUNT source and a FLOOR above zero — so a census that finds
     nothing FAILS instead of reporting clean;
  2. at least one CANARY — a literal the gate must emit, so broken
     discovery is loud rather than serene;
  3. a documented PLANT in ``docs/engine_book/gates.md`` — the defect
     that gate exists to catch, observed RED and reverted.

A NEW gate added without those three fails here. That is the mechanism
that stops the class from coming back; the prose in gates.md is the
evidence, and this file is what makes the prose non-optional.

Related: docs/engine_book/testing_conventions.md TC-2 (a gate must be
proven to fail) and TC-3 (a census that finds nothing is a broken gate).
"""

from __future__ import annotations

import importlib.util
import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
BATTERY = REPO / "scripts" / "run_battery.py"
GATES_DOC = REPO / "docs" / "engine_book" / "gates.md"


def _load_battery():
    spec = importlib.util.spec_from_file_location("run_battery", BATTERY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


@pytest.fixture(scope="module")
def battery():
    return _load_battery()


@pytest.fixture(scope="module")
def gates(battery):
    """Every gate the FULL battery runs (engine + frontend)."""
    return battery.gate_specs(engine_only=False)


@pytest.fixture(scope="module")
def doc_text():
    assert GATES_DOC.is_file(), (
        "docs/engine_book/gates.md is missing — it is the plant log every "
        "gate's proven-RED transcript lives in. Without it no gate in the "
        "battery has evidence that it can fail."
    )
    return GATES_DOC.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def doc_sections(doc_text):
    """{gate name: section body} from the `## <name>` headings."""
    sections = {}
    current = None
    buf = []
    for line in doc_text.splitlines():
        m = re.match(r"^##\s+(?:gate:\s*)?`?([A-Za-z0-9][A-Za-z0-9_-]*)`?\s*$", line)
        if m:
            if current:
                sections[current] = "\n".join(buf)
            current = m.group(1)
            buf = []
        elif current:
            buf.append(line)
    if current:
        sections[current] = "\n".join(buf)
    return sections


# ── 1. The registry itself is non-empty and discoverable ──────────────

def test_the_battery_registry_is_discoverable_and_non_empty(gates):
    """DISCOVERY CANARY for this suite.

    Every assertion below loops over `gates`. An empty list satisfies all
    of them, and this file would report a serene pass while enforcing
    nothing — which is precisely the defect it exists to prevent. So the
    roster is asserted before it is trusted, and three gates that must be
    in it are named.
    """
    assert len(gates) >= 25, (
        "the battery reports only %d gate(s) — the registry is not being "
        "read. Every check in this file loops over it, so an empty or "
        "truncated roster makes this whole suite vacuous." % len(gates)
    )
    names = {g.name for g in gates}
    for canary in ("pytest", "tsc", "corpus-replay"):
        assert canary in names, (
            "gate %r is not in the battery registry. Either it was removed "
            "(update this canary deliberately, in the same commit) or the "
            "registry reader is broken and this suite is enforcing nothing."
            % canary
        )


# ── 2. Every gate declares work, with a floor above zero ──────────────

def test_every_gate_declares_a_work_count_source(gates):
    missing = [
        g.name for g in gates
        if not (g.work_rx or g.work_count_rx or g.work_junit or g.work_glob)
    ]
    assert not missing, (
        "these gates declare no way to count what they examined: %s\n"
        "A gate whose only output is an exit code cannot be distinguished "
        "from `npx tsc --noEmit` checking zero files. Give it a work_rx "
        "over a count it already prints, a work_count_rx over its per-item "
        "lines, work_junit for a pytest gate, or — only when the script is "
        "not this lane's to edit — a work_glob proxy with an "
        "external_reason." % ", ".join(sorted(missing))
    )


def test_every_gate_declares_a_floor_above_zero(gates):
    bad = [(g.name, g.floor) for g in gates if g.floor < 1]
    assert not bad, (
        "these gates declare a floor of zero or less: %s\n"
        "A floor of zero permits the exact failure this whole mechanism "
        "exists to catch: a clean run over nothing at all." % bad
    )


def test_only_declared_gates_use_an_external_work_proxy(gates):
    """An EXTERNAL count is measured beside the gate, not by it.

    It is a weaker guarantee than a self-reported count and is allowed
    only where the gate's script belongs to another lane. Every use must
    say so, so the debt stays visible instead of spreading.
    """
    for g in gates:
        if g.work_glob:
            assert g.external_reason, (
                "gate %r counts its work with an EXTERNAL glob proxy but "
                "gives no external_reason. A proxy is a stand-in for the "
                "gate's own report; it must name why the gate cannot make "
                "one." % g.name
            )


# ── 3. Every gate names a canary ──────────────────────────────────────

def test_every_gate_names_at_least_one_canary(gates):
    missing = [g.name for g in gates if not g.canaries]
    assert not missing, (
        "these gates name nothing they MUST find: %s\n"
        "A gate that works by discovery has to fail LOUDLY when discovery "
        "breaks — check_metric_declared.py reported '0 metrics' for a "
        "package with dozens and printed a pass, and check_stale_gates.mjs "
        "called 20 live ids stale. Both were censuses wearing a gate's "
        "clothing. Name a fixture, a rule id, a test id, or a verdict line "
        "the gate cannot legitimately omit." % ", ".join(sorted(missing))
    )


def test_no_canary_is_a_trivially_true_substring(gates):
    """A canary must be specific enough to fall when discovery falls.

    "PASS", "OK" or "0" would be printed by an empty run too, so they
    would prove nothing while looking like proof.
    """
    banned = {"pass", "ok", "fail", "0", "1", "yes", "no", "true", "done"}
    offenders = []
    for g in gates:
        for c in g.canaries:
            if len(c) < 4 or c.strip().lower() in banned:
                offenders.append((g.name, c))
    assert not offenders, (
        "these canaries are too generic to detect broken discovery: %s\n"
        "An empty run prints them too." % offenders
    )


# ── 4. Every gate has a documented, observed RED ──────────────────────

def test_every_gate_has_a_section_in_the_plant_log(gates, doc_sections):
    missing = [g.name for g in gates if g.name not in doc_sections]
    assert not missing, (
        "no section in docs/engine_book/gates.md for: %s\n"
        "Every gate ships with a plant that trips it, observed RED, "
        "reverted, and observed GREEN again (TC-2). A gate that has never "
        "been seen red is an untested assertion about an assertion — add "
        "a '## <gate>' section with the plant, the red output, and the "
        "revert. If the gate CANNOT be made to fail, say that in the "
        "section and say which it is: measuring nothing, or measuring "
        "something unreachable." % ", ".join(sorted(missing))
    )


REQUIRED_SECTION_MARKERS = ("PLANT", "RED", "REVERT")


def test_every_plant_log_section_records_plant_red_and_revert(gates, doc_sections):
    """The three parts of the proof, each mandatory.

    A section naming a plant without showing the RED proves the author
    intended to check; only the observed red output proves they did.
    """
    thin = []
    for g in gates:
        body = doc_sections.get(g.name, "")
        absent = [m for m in REQUIRED_SECTION_MARKERS if m not in body]
        if absent:
            thin.append((g.name, absent))
    assert not thin, (
        "these plant-log sections are missing required parts %s: %s\n"
        "Plant -> observe RED -> revert -> observe GREEN. Record the plant "
        "diff and the exact red output; a section that only asserts the "
        "gate works is the thing this file exists to refuse."
        % (list(REQUIRED_SECTION_MARKERS), thin)
    )


def test_the_plant_log_states_the_incident_it_descends_from(doc_text):
    """The page must carry its own reason for existing.

    Documentation that states a rule without the incident that produced
    it gets edited away by the next person who finds it inconvenient.
    """
    for marker in ("tsc", "zero files", "DISCOVERY BROKEN"):
        assert marker in doc_text, (
            "docs/engine_book/gates.md never mentions %r. The page is the "
            "record of why exit-zero is not evidence here; without the "
            "incident it reads as ceremony." % marker
        )


# ── 5. The battery's own enforcement is wired, not merely declared ────

def test_the_battery_fails_a_gate_whose_work_is_below_its_floor(battery):
    """The enforcement path itself, exercised.

    Declaring floors in a table is worth nothing if the runner does not
    act on them — that would be a gate-checking mechanism with the same
    defect as the gates it checks.
    """
    g = battery.Gate("probe", ["true"], floor=10, units="things",
                     work_rx=r"examined (\d+) things", canaries=())
    units, hay = battery._extract_work(g, "examined 3 things\n", None)
    assert units == 3
    assert units < g.floor

    units, hay = battery._extract_work(g, "nothing to report\n", None)
    assert units is None, (
        "a gate that printed no count must yield None (a FAIL), never 0 "
        "silently treated as 'it ran and found nothing'."
    )


def test_the_battery_detects_a_missing_canary(battery):
    g = battery.Gate("probe", ["true"], floor=1, units="things",
                     work_rx=r"(\d+)", canaries=("must-appear",))
    assert battery._missing_canaries(g, ["all quiet"]) == ["must-appear"]
    assert battery._missing_canaries(g, ["... must-appear ..."]) == []


def test_the_battery_sums_and_line_counts_correctly(battery):
    summed = battery.Gate("s", ["true"], floor=1, work_rx=r"on (\d+) fields",
                          work_sum=True)
    units, _ = battery._extract_work(
        summed, "on 10 fields\non 5 fields\n", None)
    assert units == 15

    counted = battery.Gate("c", ["true"], floor=1, work_count_rx=r"^ROW ")
    units, _ = battery._extract_work(counted, "ROW a\nROW b\nnope\n", None)
    assert units == 2


def test_a_gate_returning_exit_zero_over_no_output_is_not_green(battery, tmp_path):
    """END-TO-END: the historical defect, replayed.

    `true` is the perfect stand-in for `npx tsc --noEmit` against a
    solution-style tsconfig: instant, silent, exit 0. The battery must
    call it a FAIL, and the reason must name the missing work count.
    """
    monkey = battery._gates
    try:
        battery._gates = lambda engine_only: [
            battery.Gate("tsc-lookalike", ["true"], floor=400,
                         units="project files",
                         work_rx=r"GATE-WORK tsc units=(\d+)",
                         canaries=("tsconfig",))
        ]
        log = tmp_path / "record.json"
        import os
        os.environ["ENGINE_BATTERY_LOG"] = str(log)
        rc = battery.main([])
    finally:
        battery._gates = monkey
        import os
        os.environ.pop("ENGINE_BATTERY_LOG", None)

    assert rc == 1, (
        "a gate that exits 0 having printed no evidence of work was "
        "accepted as green. That is the tsc incident, reproduced."
    )
    import json
    record = json.loads(log.read_text(encoding="utf-8"))
    entry = record["gates"]["tsc-lookalike"]
    assert entry["state"] == "FAIL"
    assert entry["exit_code"] == 0, (
        "the point of the test is that the COMMAND SUCCEEDED and the gate "
        "still failed. If the command errored, this proves nothing."
    )
    assert entry["work_units"] is None
