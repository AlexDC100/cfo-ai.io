"""AI structural interpreter (Part A of the AI-first-reader mission).

The interpreter asks a model to describe a financial document's
STRUCTURE — which column means what, where the header/totals/subtotal
rows sit, how analytic account codes are shaped, which number locale the
figures use — and returns a typed, strictly validated
:class:`~engine.interp.structmap.StructuralMap`.

The one hard rule (E1): a StructuralMap carries coordinates, indices,
enums and short strings ONLY. It NEVER carries a monetary amount or any
other cell value — the schema validator rejects any numeric field
outside an explicit whitelist of index/scale/digit-count fields. The
model reads the document; the map lets a MECHANICAL reader extract the
numbers deterministically.

Jurisdiction-blindness (N7): nothing in this package branches on a
jurisdiction or embeds account-code / header-label literals. The
jurisdiction string is passed through to the prompt as a hint only.

Modules:
  structmap.py    — frozen dataclasses + strict JSON (de)serialization
  interpreter.py  — run_structural_interpretation (two prompt framings,
                    registry-guarded, breaker-armored, injectable client)
  cache.py        — content-addressed StructuralMap cache (E2 seed)
"""
from .structmap import (  # noqa: F401
    COLUMN_SEMANTICS,
    MAP_VERSION,
    AnalyticStructure,
    ColumnSpec,
    NumberLocale,
    StructMapError,
    StructuralMap,
)
from .interpreter import (  # noqa: F401
    InterpError,
    InterpUnavailable,
    role_for_framing,
    run_structural_interpretation,
)
from .cache import (  # noqa: F401
    FileCacheStore,
    MemoryCacheStore,
    cache_key,
    interpret_with_cache,
)
