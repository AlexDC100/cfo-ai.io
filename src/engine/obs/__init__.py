"""engine.obs — observability & drift sentinels (Part D, Wave 2).

Three read-side surfaces over machinery that already exists — nothing in
here adds a pipeline hook, a daemon, a datastore, or a serving branch:

  tracing.py    One trace per pipeline run, spans per stage. Subscribes
                to the SAME stage boundaries the run journal uses by
                decorating ``engine.journal.hooks`` at runtime (zero new
                pipeline.py lines). NO-OP by default; OpenTelemetry is
                an OPTIONAL extra (``pip install .[obs]``) and every
                import of it is guarded — the engine boots without it.

  metrics.py    In-process counters/histograms (JSON-dumpable, no
                Prometheus) + an on-demand collector that computes the
                engine health mix (imbalance ratios, reconcile causes,
                front-end mix, AI agreement, cache hits, cost-per-doc,
                DLQ depth, chain verification) from the persisted
                journal + envelopes + breaker state. A collector, not a
                daemon: it runs when asked and touches nothing.

  sentinels.py  Drift detection against a rolling baseline persisted at
                ``data/obs/baseline.json`` — unclassified rate,
                AI-proposal rate, front-end fallback rate. Departures
                print alert-level NOTICES (corpus_replay style, never
                red): the "new SAGA variant in the wild" detector.

  status.py     ``ops_snapshot()`` — the one-glance engine health dict
                served by GET /api/ops and ``scripts/engine_ops.py``:
                last battery result per gate, deploy versions (engine +
                packs + model registry), spend vs caps, DLQ depth,
                drift notices, journal verification.

Failure policy everywhere: NEVER raise into a caller, NEVER block.
Every section of every snapshot degrades to an honest
``{"error": ...}`` / ``"not recorded"`` instead of taking anything
down. The golden corpus and the determinism gate run with all of this
inert (no env flags set), so serving bytes cannot move.
"""
from .metrics import MetricsRegistry, collect_metrics  # noqa: F401
from .sentinels import evaluate_sentinels  # noqa: F401
from .status import ops_snapshot  # noqa: F401
from .tracing import install as install_tracing  # noqa: F401
from .tracing import uninstall as uninstall_tracing  # noqa: F401

__all__ = [
    "MetricsRegistry",
    "collect_metrics",
    "evaluate_sentinels",
    "ops_snapshot",
    "install_tracing",
    "uninstall_tracing",
]
