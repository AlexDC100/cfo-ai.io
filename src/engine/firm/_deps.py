"""DEFERRED handles on ``engine.api`` — the ONE way this package reaches it.

WHY. ``engine/api/__init__.py`` imports ``.server`` eagerly, and the
server mounts ``_firm_attention`` / ``_firm_brief`` / ``_firm_requests``,
which import THIS package. So a module-level ``from engine.api import
_company_profile`` inside ``engine.firm`` is a cycle: in a fresh process
``import engine.firm.facts`` ran ``engine.api.__init__`` -> ``server`` ->
``_firm_attention`` -> ``engine.firm.attention`` -> ``from .facts import
AttentionCache`` against a ``facts`` module still stuck on its own line 26.
Five of the ten firm modules could not be imported first (facts, pack,
severity, suppress, calendar); the suite passed only because
``test_firm_attention.py`` happened to import ``engine.api`` earlier.

THE RULE. No module under ``engine.firm`` imports ``engine.api`` at module
level. It takes a handle from here — ``from ._deps import company_profile
as CP`` — and the real module is imported on the FIRST ATTRIBUTE ACCESS,
by which time every module body involved has finished executing. The
call sites read exactly as before (``CP.load_catalog()``,
``R.MaterialityPolicy``); only the moment of import moves.
Two tests hold it: ``tests/engine/test_firm_attention.py`` scans the
package's AST for a module-level ``engine.api`` import, and
``tests/engine/test_firm_imports.py`` imports EVERY firm module first in
a fresh subprocess.

WHAT THIS DOES NOT DO. It does not decide what ``engine.api.__init__``
loads when a handle is first touched — that is the API package's own
business (it now exposes ``create_app`` lazily, PEP 562, so touching a
handle imports only the leaf module; ``tests/engine/test_firm_imports.py``
holds it there). This module only guarantees the firm package is
importable in ANY order and that importing it loads no ``engine.api``
module and no AI subsystem at all.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

import importlib
from types import ModuleType
from typing import Any, Optional


class LazyModule(object):
    """A module handle that imports its target on first attribute access.

    Attribute reads are forwarded to the real module; the handle itself
    holds nothing else, so ``isinstance(x, CP.CompanyProfile)`` and
    ``R.SCOPE_ANY`` behave exactly as on the module.
    """

    __slots__ = ("_name", "_module")

    def __init__(self, name: str) -> None:
        object.__setattr__(self, "_name", str(name))
        object.__setattr__(self, "_module", None)

    def _load(self) -> ModuleType:
        module = object.__getattribute__(self, "_module")  # type: Optional[ModuleType]
        if module is None:
            module = importlib.import_module(object.__getattribute__(self, "_name"))
            object.__setattr__(self, "_module", module)
        return module

    def __getattr__(self, attr: str) -> Any:
        if attr.startswith("__") and attr.endswith("__"):
            raise AttributeError(attr)
        return getattr(self._load(), attr)

    def __setattr__(self, attr: str, value: Any) -> None:
        # A test that monkeypatches `CP.build_company_profile` must hit the
        # real module, never a shadow on the handle.
        setattr(self._load(), attr, value)

    def __repr__(self) -> str:
        loaded = object.__getattribute__(self, "_module") is not None
        return "<LazyModule %s (%s)>" % (object.__getattribute__(self, "_name"),
                                         "loaded" if loaded else "not loaded")


company_profile = LazyModule("engine.api._company_profile")
finding_rank = LazyModule("engine.api._finding_rank")
ratio_units = LazyModule("engine.api._ratio_units")

__all__ = ["LazyModule", "company_profile", "finding_rank", "ratio_units"]
