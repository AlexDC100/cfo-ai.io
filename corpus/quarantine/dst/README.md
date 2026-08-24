# DST failure-seed archive (`corpus/quarantine/dst/`)

Failure artifacts from the deterministic simulation & fault harness
(`src/engine/dst/`, driven by `scripts/dst_explore.py` and
`tests/engine/test_dst.py`). Same discipline as the property-suite
quarantine one level up (`corpus/quarantine/<sha16>/`, written by
`tests/engine/test_properties.py`).

**This directory is an archive of failures, not corpus data.** It holds
no goldens and no case inputs; `scripts/corpus_replay.py` ignores it
(no `meta.yaml`), and nothing under it feeds any gate. Artifacts name
corpus fixtures only by case id — corpus inputs are synthetic or
anonymized, so nothing sensitive can land here.

## Layout

One directory per failure identity, keyed
`sha256("dst\n<fault>\n<fixture>\n<boundary>")[:16]`:

```
corpus/quarantine/dst/<sha16>/
  config.json   {fault, fixture, boundary, seed, profile,
                 minimized_from}   — the MINIMIZED failing configuration
                 (smallest lane-compatible fixture that still fails);
                 `minimized_from` names the config that failed first,
                 null when nothing smaller failed
  fault         the fault-class name, one line
  seed          {seed, profile, note} — the schedule seed; the seed only
                 permutes matrix run order, so re-running the exact
                 config from config.json reproduces the failure without it
  traceback     the full Python traceback of the K-invariant violation
```

Re-runs of the same failure identity overwrite in place (stable sha16),
so the archive never accumulates duplicates of one bug.

## Reproducing

```
.venv/bin/python scripts/dst_explore.py \
    --fault <fault> --fixture <fixture> --seed <seed>
```

or run the single config in-process:

```python
from engine.dst import run_config
from engine.dst.explorer import DstConfig
print(run_config(DstConfig("<fault>", "<fixture>", "<boundary>")))
```

Fault classes, boundaries and the K-invariants each scenario asserts are
documented in `src/engine/dst/faults.py` (including `GAPS` — faults the
harness cannot inject through an existing seam, surfaced as NOTICE lines
on every explorer run).
