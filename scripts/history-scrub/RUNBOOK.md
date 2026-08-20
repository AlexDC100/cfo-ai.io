# RUNBOOK — scrubbing the Sibiu plaintext blob from git history

**Operator-only. Human-invoked. Never automated.**

Decision record: [`docs/decisions/ADR-corpus-history-sibiu.md`](../../docs/decisions/ADR-corpus-history-sibiu.md)
Script: [`scrub_sibiu.sh`](./scrub_sibiu.sh)

> `scripts/check_scrub_tooling_unreachable.py` proves on every CI run
> that nothing in this repository's automation can reach this directory.
> Keep it that way. If you ever find yourself adding a `run:` line that
> mentions it, you have misunderstood what this is for.

---

## Before you start: what this does and does not achieve

**It reduces exposure. It does not erase it.** Two facts that must be
understood before, not after:

1. **Every clone that already exists keeps the plaintext.** A rewrite
   changes this repository and the remote. It cannot reach a laptop that
   cloned last month. Anyone who already has the object has it forever.
2. **The hosting provider keeps unreachable objects addressable by
   SHA.** After the force-push the blob is unreachable from any ref, but
   on GitHub (and similar hosts) a URL of the form
   `https://github.com/<org>/<repo>/blob/cdba88b9…` can still serve it,
   because forks, pull-request refs and internal caches share the object
   store. **Removing that requires a support request** (step 7). The
   rewrite alone does not do it.

If the reason you are here is a client or legal obligation, say this
plainly in whatever you report: the scrub is a **mitigation**, not a
remedy.

---

## Step 0 — Confirm a trigger actually fired

Run the script with no arguments. It refuses, and prints the review
trigger list:

```bash
./scripts/history-scrub/scrub_sibiu.sh
```

Tick the trigger in the ADR. If none of them fired, stop — you do not
need to be doing this, and a rewrite has real costs.

Also settle the open question at the top of the ADR
(`[OWNER TO CONFIRM: EEI own document | client document]`). It changes
whether step 7 is optional diligence or a duty.

---

## Step 1 — Freeze pushes

Nothing may land while history is being rewritten; any commit pushed
mid-flight is silently lost when you force-push.

- Enable a branch protection rule on `main` that blocks pushes, or
  temporarily restrict push access to yourself.
- Note the current tip so you can prove nothing moved:

```bash
git fetch --all --prune
git rev-parse origin/main
```

- Confirm no CI job is mid-run against `main`.

---

## Step 2 — Announce, and inventory the clones

This repository has **two** people with access. Both must acknowledge
**before** the rewrite, not after — a re-clone that arrives as a
surprise is how people "fix" it by force-pushing the old history back.

Tell each holder:

- the rewrite window,
- that they must **re-clone** afterwards (step 6), and
- that any **in-flight branch** must be rebased onto the new history
  (step 6b) — so they should push or bundle their work now.

Inventory what exists, so nothing is discovered later:

```bash
git branch -a
git for-each-ref --format='%(refname) %(committerdate:short)' refs/
gh pr list --state open        # open PRs carry refs/pull/*, which the host keeps
```

Open PRs matter: their refs live on the host and are **not** rewritten
by your local run. Merge or close them first where you can.

---

## Step 3 — Back up

The script writes a `git bundle` of all refs into `.git/` automatically,
but keep an independent copy **outside** the repository too:

```bash
git clone --mirror . /tmp/pre-rewrite-mirror.git
```

Do not delete either backup until step 6 is finished for every holder.

---

## Step 4 — Run the scrub

```bash
./scripts/history-scrub/scrub_sibiu.sh \
    --i-understand-force-push \
    --maintainer "Your Name"
```

Both flags are mandatory, and the script additionally refuses to run
without a terminal. It will:

1. print the ADR path and the trigger list;
2. verify `git-filter-repo` is installed and the tree is clean;
3. verify **HEAD does not still carry a target blob** — if the redaction
   has not been committed yet, it stops, because stripping the blob at
   that point would delete the file instead of rewinding it to the
   redacted version;
4. bundle all refs;
5. ask you to type `REWRITE HISTORY`;
6. run `git filter-repo --strip-blobs-with-ids`.

Blobs are stripped **by id, not by path**, so the redacted files at HEAD
survive. Defaults come from the ADR's blob table; override with
`--blob` / `--path` if that record has changed.

---

## Step 5 — Post-check: prove the blobs are unreachable

Do this **before** force-pushing. If it fails, you force-push a rewrite
that did not achieve anything.

```bash
# 1. Not reachable from any ref (the authoritative check).
git rev-list --objects --all | grep -F cdba88b9deb61a9b96f6ce2a1b841b6f6657bced && echo "STILL REACHABLE" || echo "unreachable — good"

# 2. Same for the baseline blobs (R4 in the ADR).
for b in 78ae5b1e9e08fff3c8f822a913215f5eaf566904 \
         d6319e2831604072ea4849efcd9ab435c0deb44b \
         ed877592dbb6186f8a6b6e77cbb7d6380eba4027; do
  git rev-list --objects --all | grep -qF "$b" && echo "STILL REACHABLE $b" || echo "unreachable $b"
done

# 3. The redacted files are still present and correct at HEAD.
git cat-file -s HEAD:corpus/pdf_positional/input.pdf
python3 scripts/check_corpus_policy.py

# 4. Expire the local reflog and drop the loose objects.
git reflog expire --expire=now --all
git gc --prune=now --aggressive
```

`git cat-file -e <sha>` may still succeed locally right after the
rewrite — that is the *local* object store, not reachability. Step 4
above is what removes them locally; the ref-reachability check in step 1
is the one that matters for what the remote will accept.

---

## Step 6 — Force-push, then re-clone everywhere

```bash
git push --force --all
git push --force --tags
```

If branch protection blocked you in step 1, lift it just long enough for
this push, then put it straight back.

### 6a. Every clone holder re-clones

The safe instruction, for both people, is: **delete and re-clone.**

```bash
cd .. && rm -rf <repo> && git clone <url> <repo>
```

A `git pull` after a rewrite does **not** converge — it merges the old
history back in, and the next push re-uploads the blob you just removed.
Say this explicitly; it is the single most common way a scrub is undone.

### 6b. Rebasing in-flight branches onto the rewritten history

Work that only exists on someone's laptop is not lost, but it cannot be
merged as-is: its parent commits no longer exist.

For each in-flight branch, in the **old** clone (keep it until this is
done):

```bash
# In the OLD clone: export just your own commits as patches.
git fetch origin                       # old origin state, pre-rewrite
git format-patch origin/main..my-branch -o /tmp/my-branch-patches
```

Then in the **fresh** clone:

```bash
git checkout -b my-branch origin/main
git am /tmp/my-branch-patches/*.patch
```

`format-patch` + `am` is the reliable route because it carries only the
diffs and re-parents them onto whatever history now exists.

If a branch is long-lived and you would rather rebase directly, add the
old clone as a remote and rebase with `--onto`:

```bash
git remote add old /path/to/old-clone
git fetch old
git rebase --onto origin/main old/main old/my-branch
```

Expect conflicts only where the rewrite actually changed content — i.e.
in commits that touched the stripped files.

**Check the result before pushing:** a rebased branch must not
reintroduce the blob.

```bash
git rev-list --objects my-branch | grep -F cdba88b9deb61a9b96f6ce2a1b841b6f6657bced && echo "STOP — branch reintroduces the blob"
```

### 6c. Delete stale server-side refs

Open PR refs (`refs/pull/*`) are host-managed and survive the rewrite.
Close and reopen the PRs from the rebased branches, or the old objects
stay reachable through them.

---

## Step 7 — The host-side cache purge (do not skip)

After the force-push the blob is unreachable from refs but may remain
**addressable by SHA** through the provider's caches and fork object
pools. Verify:

```
https://github.com/<org>/<repo>/blob/cdba88b9deb61a9b96f6ce2a1b841b6f6657bced
https://github.com/<org>/<repo>/commit/c81456e
```

If either still resolves, open a **GitHub Support request** and ask
explicitly for:

- garbage collection / purge of unreachable objects on the repository,
- removal of any cached views of the listed commits and blob SHAs,
- confirmation that no fork retains the objects (list forks first;
  a fork keeps the shared object store alive).

Keep the ticket reference. If this was a client document, that reference
is the evidence that the mitigation was carried through rather than
assumed.

---

## Step 8 — Close the loop

1. Update `docs/decisions/ADR-corpus-history-sibiu.md`:
   - flip **Status** to `Superseded — scrub executed <date>`,
   - set `Accepted-Plaintext-Blobs: 0` (the corpus-policy notice reads
     this number; leaving it at 1 makes the gate keep reporting an
     exposure that no longer exists),
   - record which trigger fired, who ran it, the new HEAD, and the
     support-ticket reference from step 7.
2. Re-run the gates from a **fresh clone**:
   ```bash
   python3 scripts/check_corpus_policy.py
   python3 scripts/check_scrub_tooling_unreachable.py --verbose
   python3 scripts/corpus_replay.py
   python3 scripts/verify_determinism.py
   python3 scripts/measure_bs_drift.py
   ```
   `measure_bs_drift.py` matters here: it is the gate that would notice
   if a stripped blob took a fixture with it.
3. Unfreeze pushes and restore branch protection.
4. Delete the backups from step 3 only once **both** holders have
   confirmed a successful re-clone.
