"""FAMILY REGISTRY — id in the pack, implementation in the engine.

The pack declares WHICH detectors exist and with what parameters; the
engine owns the ARITHMETIC each family performs. This module is the only
join between the two, and it is a dictionary lookup: no import of a
detector module by name, no scan of a package, no branch on a
jurisdiction.

A pack naming a family this build does not carry REFUSES at run, loudly,
with the registered names listed. Silently skipping it would mean a
detector the operator believes is running is not.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Tuple

#: family name -> callable(spec, series, context) -> List[DetectorResult]
_FAMILIES = {}  # type: Dict[str, Callable[..., Any]]


class UnknownFamilyError(KeyError):
    """The pack names a family this build does not implement."""


def register(name: str) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    def _decorate(fn: Callable[..., Any]) -> Callable[..., Any]:
        if name in _FAMILIES:
            raise ValueError("family %r is already registered" % name)
        _FAMILIES[name] = fn
        return fn
    return _decorate


def family(name: str) -> Callable[..., Any]:
    try:
        return _FAMILIES[name]
    except KeyError:
        raise UnknownFamilyError(
            "no detector family %r in this build. Registered families: %s. A "
            "pack row naming an unknown family is refused rather than skipped "
            "— a detector an operator believes is running must be running."
            % (name, ", ".join(sorted(_FAMILIES)) or "none"))


def registered() -> Tuple[str, ...]:
    return tuple(sorted(_FAMILIES))


def has(name: str) -> bool:
    return name in _FAMILIES


__all__ = ["UnknownFamilyError", "family", "has", "register", "registered"]
