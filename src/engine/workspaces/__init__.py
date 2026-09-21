"""One company per workspace.

The owner's rule (2026-09-21): a workspace (``organizations`` row) holds ONE
company, keyed by its CUI (Romanian fiscal code). This package holds the
pieces that establish and restore that shape on existing data:

  * ``company_identity`` — who (CUI, name, CAEN) and when (period end) a
    stored document is about, read from the document's OWN bytes, with the
    evidence for every field. Pure.
  * ``rowstore`` — the row-level vocabulary shared by the snapshot, the
    restore and the planner: primary keys, canonical hashing, applying a
    list of row operations to an in-memory copy of the tables, and the
    restore diff. Pure.
  * ``migration_plan`` — the planner: from a snapshot of the tables plus an
    identity per document, the exact list of row operations that splits
    every workspace into one-company workspaces and archives what is left
    over, never hard-deleting anything. Pure.
  * ``pgrest_io`` — the only module here that talks to Supabase (PostgREST
    paging, storage copy). Used by the three operator scripts
    ``scripts/db_snapshot.py``, ``scripts/db_restore.py`` and
    ``scripts/workspace_migration.py``.
"""
