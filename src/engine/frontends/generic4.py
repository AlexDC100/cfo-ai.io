"""Generic 4-column front-end (cont / denumire / one closing D-C pair).

Thin format-id shell over the shared machinery in `saga10`. A
generic_4_col export carries ONLY the closing pair, so the atoms'
opening and period slots are ABSENT (the format lacks those columns —
never fabricated as zero) and there is no cumulative side-channel.
"""
from __future__ import annotations

from .saga10 import _DeterministicTbFrontEnd


__all__ = ["Generic4FrontEnd"]


class Generic4FrontEnd(_DeterministicTbFrontEnd):
    format_id = "generic_4_col"
