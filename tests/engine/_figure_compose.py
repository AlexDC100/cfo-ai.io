"""THE COMPOSED SET of the gates ai-figures-engine and ai-figures.

`tests/engine/fixtures/ai_figures/compose.json` holds PARTS — currency
heads, numbers in both notations, magnitudes, units, joiners, words — and a
count. Text `i` is composed from them by the integer arithmetic below (a
Park-Miller generator: every product stays under 2**53, so the browser's
twin composes the same bytes with plain numbers —
frontend/lib/__tests__/readerFigures.test.ts). Nothing here is random at
run time and nothing is a model's reply: it is what a rule set meets when a
figure stands against something the corpus did not think of.

Both runtimes normalise all of it and must reproduce the fixture's `digest`
(sha256 over every output, its rewritten count and every token left). A
rule changed in ONE runtime moves that runtime's digest: red. A rule
changed in BOTH on purpose moves both: the failure prints the new digest,
and committing it is the deliberate act.

THE LABEL GRAMMAR (`labels.json`, round 2) is the same idea for what is NOT
a figure: a label, an id, a separator, an amount — every combination, in the
file's order (`label_texts`). Its digest is held the same way.

    python tests/engine/_figure_compose.py          # prints both digests NOW
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Tuple

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "ai_figures" / "compose.json"
LABELS = Path(__file__).resolve().parent / "fixtures" / "ai_figures" / "labels.json"
MODULUS = 2147483647
MULTIPLIER = 48271


def compose(spec: Dict[str, Any], i: int) -> Tuple[str, str, List[float]]:
    """Text `i` of the set, the language it is read in, the figures handed with it."""
    state = ((i + 1) * 7919) % MODULUS

    def step() -> int:
        nonlocal state
        state = (state * MULTIPLIER) % MODULUS
        return state

    def pick(items: List[Any]) -> Any:
        return items[step() % len(items)]

    parts: List[str] = []
    for _ in range(1 + step() % 4):
        if step() % 4 == 0:
            parts.append(pick(spec["words"]))
            parts.append(pick(["", " "]))
        parts.append(pick(spec["pre"]) + pick(spec["nums"]) + pick(spec["post"]))
        if step() % 5 < 3:
            parts.append(pick(spec["nums"]) + pick(spec["post"]))
        parts.append(pick(spec["seps"]))
    lang = "ro" if step() % 2 == 0 else "en"
    return "".join(parts), lang, list(pick(spec["anchor_sets"]))


def _line(lang: str, out: str, report: Dict[str, Any]) -> bytes:
    left = "\x1e".join("%s\x1d%s" % (token, why) for token, why in report["left"])
    return ("%s\x1f%s\x1f%d\x1f%s\n" % (lang, out, report["rewritten"], left)).encode("utf-8")


def digest_of(spec: Dict[str, Any], normalise: Callable[[str, str, List[float]], Tuple[str, Dict[str, Any]]]) -> str:
    h = hashlib.sha256()
    for i in range(spec["count"]):
        text, lang, anchors = compose(spec, i)
        out, report = normalise(text, lang, anchors)
        h.update(_line(lang, out, report))
    return h.hexdigest()


def label_texts(spec: Dict[str, Any]) -> Iterator[Tuple[str, str, str, str, str]]:
    """Every text of the label grammar: (language, class, what stands before
    the id, the id, the whole text) — in the file's order."""
    for lang in ("ro", "en"):
        for cls in spec["classes"]:
            for label in cls["labels"][lang]:
                for ident in cls["ids"]:
                    for sep in cls["seps"]:
                        for amount in spec["amounts"]:
                            yield lang, cls["name"], label, ident, label + ident + sep + amount + spec["tail"][lang]


def label_digest_of(spec: Dict[str, Any],
                    normalise: Callable[[str, str, List[float]], Tuple[str, Dict[str, Any]]]) -> str:
    h = hashlib.sha256()
    for lang, _cls, _label, _ident, text in label_texts(spec):
        out, report = normalise(text, lang, [])
        h.update(_line(lang, out, report))
    return h.hexdigest()


if __name__ == "__main__":
    from engine.ai import figure_format

    print("compose.json", digest_of(json.loads(FIXTURE.read_text(encoding="utf-8")), figure_format.normalise_figures))
    print("labels.json ", label_digest_of(json.loads(LABELS.read_text(encoding="utf-8")), figure_format.normalise_figures))
