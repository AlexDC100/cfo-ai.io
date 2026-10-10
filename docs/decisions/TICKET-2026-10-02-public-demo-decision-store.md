# Ticket 2026-10-02 — the public demo routes' shared decision store holds no real user data: confirm, then close the write path

**Status: TICKETED by owner ruling 2026-10-02** ("confirm the public demo
routes' shared SQLite store holds no real user data"). The confirmation is a
read-only check on production; the code change below is not started.

Found by the tenancy sweep of 2026-10-02
(`specs-durable/hotfix_overrides_tenancy/sweep_2026-10-02.json`; reproduced
against the real `create_app()` on in-memory SQLite, nothing written to disk —
locate by symbol).

## 1. What exists

`POST /api/cfo/today`, `GET /api/cfo/decisions` and
`POST /api/cfo/decisions/{id}/status` (`src/engine/api/cfo_ai.py`) are
unauthenticated by design (`tests/engine/test_identity_wall.py` classifies
them as public demo routes). They share ONE store: the `recommendations`
table of the adapter's SQLite file (`sqlite:////app/data/engine.db`, on the
`backend_data` volume, so it survives rebuilds). The table has no user, org or
company column.

- `today` persists by default (`persist_recommendations: bool = True`): any
  anonymous caller's SKU ids, titles and cash-impact figures are written;
- `decisions` returns every row to any caller, `limit` uncapped;
- `decisions/{id}/status` rewrites any row by its autoincrement integer id;
- one caller's `today` marks another caller's open rows `done`.

## 2. Why no customer data should be in it

Nothing in `frontend/` or `mobile/` calls `cfoApi.today`, `listDecisions` or
`setDecisionStatus` (zero call sites, re-measured 2026-10-02 on
`release/r-rulings2`); the path reads no Supabase table, no JWT, no org and no
period. By construction the store holds only what a direct API caller posted —
including any past test or probe run against production.

## 3. The confirmation the owner asked for (read-only)

On the production backend: row count of `recommendations` in
`/app/data/engine.db`, the distinct `target_id` / `title` values and their
created dates, read with a SELECT only. Recorded in
`specs-durable/ops_log.md` with the date. Any row that looks like a real
company's SKU is reported to the owner by name before anything is deleted.

## 4. Closing the write path (small, after the confirmation)

1. `today` becomes stateless: the flag defaults to False and is not honoured
   for an anonymous caller.
2. `decisions` and `decisions/{id}/status` go behind the fail-closed operator
   gate (`engine.public.refresh_shield.require_operator`), or are deleted with
   the three dead `cfoApi` wrappers; if kept, `limit` is capped.
3. `test_identity_wall.py`'s classification updated; a gate that reds when an
   anonymous `today` writes a row.
4. Operator step: clear the table (the rows survive rebuilds).

Per-tenant decisions (an `org_id` column and a verified JWT on all three
routes) would be a feature, not this ticket.
