# Ticket 2026-10-02 — journal chains are keyed by (org, content hash) before `ENGINE_JOURNAL_DIR` is ever set

**Status: TICKETED by owner ruling 2026-10-02** ("journal asof chain keyed by
(org, content hash) before ENGINE_JOURNAL_DIR is ever set"). Not designed, not
started. **Precondition, not a schedule:** `ENGINE_JOURNAL_DIR` stays UNSET in
production until this ticket is closed and its gate is green.

Found by the tenancy sweep of 2026-10-02
(`specs-durable/hotfix_overrides_tenancy/sweep_2026-10-02.json`; code read at
`e043845c`, nothing executed against production — line numbers have drifted,
locate by symbol).

## 1. The defect (cross-workspace, unreachable today)

A journal chain is keyed by `documents.content_hash` ALONE
(`journal/hooks.py` `_file_hash_of` → `begin_run(file_hash=…)` →
`index/<file_hash>.jsonl`). That hash is the SHA-256 of the file bytes, sent
by the browser, and duplicate detection is per (org, uploader, hash, scope), so
two workspaces can hold the same hash.

- **Path A — same bytes in two workspaces.** `GET /api/period/{id}/asof?t=…`
  passes its RLS check on the caller's own period, then `journal.asof` takes
  the last `SNAPSHOT_PERSISTED` with `ts <= t` across EVERY run on the chain.
  No period, document or org is compared: workspace A is served workspace B's
  stored envelope (period id, document id, filename, the inventory-days block,
  reconciliation receipts carrying B's member ids). The sample trial balances
  offered on the dashboard are static downloads — every workspace that tries
  the product with one lands on one chain.
- **Path B — a planted reference.** The route falls back to
  `provenance.content_hash` read from the caller's own period row, which a
  member can write through PostgREST (`financial_periods` has member INSERT /
  UPDATE policies), and `resolve_chain` accepts a file hash, a document id or a
  period id. Knowing one identifier of a victim is enough.

**Why it is not live:** the route answers 404 for everyone while
`ENGINE_JOURNAL_DIR` is unset (measured unset on the production backend,
2026-10-02), and no frontend code calls `/asof`.

## 2. What closing it requires

1. Chains keyed by **(org_id, content_hash)**; the client-supplied
   `documents.content_hash` is no longer trusted as a chain key on its own.
   Existing chains, resume and the duplicate short-circuit are in scope.
2. `_journal_routes`: delete the file-hash fallback.
3. `journal.asof` takes the RLS-verified period id and its source document and
   keeps only snapshots of that period; serve-observed snapshots carry a period
   id (thread it through `on_served` / `observe_serving`).
4. Gate, red today: two documents with the same content hash in two orgs —
   `asof(period A, t after B's run)` returns A's snapshot; a period whose
   envelope names another chain in `provenance.content_hash` is a 404. Real
   store, no mirror double; plant-proven per the Engine Book.

## 3. Out of scope
The CLI's unfiltered `asof` (operator tool) keeps its behaviour.
