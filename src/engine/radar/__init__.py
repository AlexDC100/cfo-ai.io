"""engine.radar — RADAR, the retention surface: one source for every
findings surface.

Deterministic detection, quantification, materiality, ranking, the
surfaced cap and dismissal-with-reason all live UPSTREAM of this package
(``engine.api.findings`` + ``engine.api._finding_rank``). The modules
here serve those rows and, in a separate lane, explain them:

    explain   AI explanation, in its lane (``engine.radar.explain``).
              Prose fields only, attached from cache or after the rows,
              never awaited before them.

Deliberately thin: no imports. Each module is imported by its own
consumer so the explanation lane (which reaches ``engine.ai``) can never
be pulled in by a module that must stay model-free.

Python 3.9 — no `match`, no `X | Y` unions.
"""
