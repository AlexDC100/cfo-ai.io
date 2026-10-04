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

    python tests/engine/_figure_compose.py          # prints the digest NOW
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Callable, Dict, List, Tuple

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "ai_figures" / "compose.json"
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


def digest_of(spec: Dict[str, Any], normalise: Callable[[str, str, List[float]], Tuple[str, Dict[str, Any]]]) -> str:
    h = hashlib.sha256()
    for i in range(spec["count"]):
        text, lang, anchors = compose(spec, i)
        out, report = normalise(text, lang, anchors)
        left = "\x1e".join("%s\x1d%s" % (token, why) for token, why in report["left"])
        h.update(("%s\x1f%s\x1f%d\x1f%s\n" % (lang, out, report["rewritten"], left)).encode("utf-8"))
    return h.hexdigest()


if __name__ == "__main__":
    from engine.ai import figure_format

    print(digest_of(json.loads(FIXTURE.read_text(encoding="utf-8")), figure_format.normalise_figures))
