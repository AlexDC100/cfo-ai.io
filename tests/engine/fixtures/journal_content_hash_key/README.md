# A run journal written under the retired chain key (content hash alone)

`journal/` is a REAL journal directory, written on 2026-10-02 by the
unchanged journal code at `main` @ `72a29c72` — before the chain key became
`(org_id, content hash)`. Nothing in it is hand-made.

How it was written (the hooks are the production seams):

```python
# ENGINE_JOURNAL_DIR=<this dir>/journal, engine at 72a29c72
content = b"cont;denumire;sold_final_D;sold_final_C\n5121;Conturi la banci in lei;100.00;0.00\n1012;Capital subscris varsat;0.00;100.00\n"
fh = "sha256-" + hashlib.sha256(content).hexdigest()
for org in ("org-a", "org-b"):                      # two invented organisations, identical bytes
    doc = {"id": "doc-of-%s" % org, "org_id": org,
           "original_filename": "balanta.csv", "content_hash": fh}
    hooks.on_run_started(doc, industry=None)
    hooks.on_snapshot_persisted(doc, "period-of-%s" % org, {
        "provenance": {"content_hash": fh, "source_document_id": doc["id"]},
        "canonical_bs": {"status": "BALANCED", "mapping_version": "fixture"}})
```

What it holds — the defect itself, on disk:

- `index/sha256-143b…25f9.jsonl` — ONE chain for both organisations, keyed by
  the content hash alone; `doc-of-org-b`'s run names `doc-of-org-a`'s run as
  its `prev_run_id`;
- `runs/` — the two runs; org-b's `RUN_STARTED.prev_event_hash` is org-a's
  tail hash; neither `RUN_STARTED` names an organisation;
- `objects/` — the two document rows and the two envelopes;
- no `LAYOUT.json` (the old code never wrote one).

What it is for: `tests/engine/test_journal_chain_key.py` copies it to a
temporary directory and requires that the current code REFUSES it —
`Journal(root)`, the pipeline hooks, the as-of route, the CLI, and the boot
check (`boot_verify.verify_journal_layout`, the real `create_app()`) — and
writes nothing into it. Do not regenerate it with current code: the point is
that it was written by the code that had the defect.
