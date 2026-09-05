"""HTTP API — n8n posts to /run-daily, gets the JSON contract back.

`create_app` is exposed LAZILY (PEP 562 module `__getattr__`), on purpose.
An eager `from .server import create_app` here made EVERY import of a
leaf helper in this package (`engine.api._company_profile`,
`_finding_rank`, `_ratio_units` — pure data modules) run the whole
server import graph first: every router, the AI subsystem, httpx. Two
consequences, both measured in tests/engine/test_firm_imports.py:

  · a CYCLE — `engine.firm.facts` imports `_company_profile`, which ran
    this init, which imported `server`, which mounted `_firm_attention`,
    which imported `engine.firm.attention`, which imported the
    half-initialised `engine.firm.facts` (ImportError in any process that
    imported a firm module first; the suite only passed because one test
    happened to import `_company_profile` before the package);
  · `engine.ai` loaded transitively into the deterministic attention path
    — presence, not use, but presence a line-scan guard cannot see.

`from engine.api import create_app` / `engine.api.create_app` resolve
exactly as before; the server module is imported on first access.
"""

from typing import Any

__all__ = ["create_app"]


def __getattr__(name: str) -> Any:
    if name == "create_app":
        from .server import create_app as _create_app
        globals()["create_app"] = _create_app
        return _create_app
    # Anything else must raise AttributeError, or `from engine.api import
    # <submodule>` would never fall through to the submodule import.
    raise AttributeError("module %r has no attribute %r" % (__name__, name))
