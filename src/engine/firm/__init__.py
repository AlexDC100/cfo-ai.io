"""engine.firm — the FIRM COCKPIT backend (accounting firms, one view
over every client). The unit is the ATTENTION ITEM, not the client card.

Two lanes share this package and meet at data, not at code:

  THE BOARD (attention lane)
  model      the AttentionItem type, ClientRecord / PeriodRecord inputs,
             typed EvidenceFact with provenance.
  pack       packs/firm/attention.yaml — every kind, ladder and threshold.
  facts      the cached facts half (FactsGateway reads per period).
  attention  one detector per kind + `compute_firm_attention`.
  severity   the ladder walk (materiality per client, deadline, age).
  suppress   Dismissal-with-a-reason; a critical item is never hidden.
  dedup      one client, one row; the deterministic sort key.
  calendar   packs/firm/calendar_<jurisdiction>.yaml — statutory deadlines.

  CADENCE, DIGEST, REQUESTS, BRIEF (this lane)
  cadence    per-client filing cadence (monthly / quarterly, DATA in
             packs/firm/cadence.yaml): expected period ends, each one's
             deadline, the current / stale / never-filed verdict and the
             auto-nudge schedule. No clock inside — `as_of` everywhere.
             Consumed by attention.py for MISSING_FILE / STALE_PERIOD.
  digest     the read-only item view over model.AttentionItem, the ONE
             flat priority order (the board's own key, flattened), the
             daily digest per accountant and its branded email body.

The routes live in engine.api._firm (firms, roles, clients, invites,
import), engine.api._firm_requests (file-request flow, cadence, digest
preferences + cron, email drain) and engine.api._firm_brief (the "brief
me" role — the ONE place a model enters, advisory only, numeral-guarded).
cadence.py and digest.py import no AI subsystem;
digest.assert_no_model_in_critical_path asserts that structurally.

Python 3.9 — no `match`, no `X | Y` unions.
"""
from __future__ import annotations

__all__ = ["attention", "cadence", "calendar", "dedup", "digest", "facts",
           "model", "pack", "severity", "suppress"]
