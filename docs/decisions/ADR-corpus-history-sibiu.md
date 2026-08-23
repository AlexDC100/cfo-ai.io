# ADR — Non-anonymized Sibiu trial-balance PDF in git history

**Status:** Accepted (risk accepted, remediation deferred)
**Date:** 2026-08-20
**Supersedes:** nothing
**Referenced by:** `corpus/pdf_positional/meta.yaml`,
`scripts/check_scrub_tooling_unreachable.py`,
`scripts/check_corpus_policy.py`, the tier1 `corpus-policy` job,
`src/engine/country_packs/ro_romania/fixtures/regression_baselines/BASELINE_HISTORY.md`

Machine-readable, parsed by `scripts/check_corpus_policy.py` for its
non-blocking history notice — keep the format exactly as written (bare
line, no bold, no list marker):

Accepted-Plaintext-Blobs: 4

That is **one** blob for the plaintext PDF plus **three** for the
regression baselines that carried the legal name (R4 below). It is
deliberately the same set of four the scrub tooling targets and the
runbook post-checks, so the notice, the script defaults and the
verification steps cannot drift apart. Set it to `0` after a successful
scrub, or the gate keeps reporting an exposure that no longer exists.

---

## Context

### What happened

The platform's only real positional-PDF fixture is a Romanian trial
balance (WinMENTOR export, FY2019, 249 atoms). It was committed **in the
clear** — carrying the operator's legal name, its Reg-Com number and
CUI, four trading-site names and the preparer's personal name in both
the PDF content streams and the document-info dictionary.

On 2026-08-20 the file was redacted in place by `scripts/pdf_scrambler.py`
and the numeric IR was proven identical across all 249 atoms before the
swap. **The working tree therefore carries only the redacted file.** The
plaintext version remains in this repository's object store.

### Blob identification

Computed read-only (`git log --follow`, `git rev-list --objects --all`,
`git cat-file`). No history was rewritten to produce it.

**The document itself**

| | |
|---|---|
| **Blob** | `cdba88b9deb61a9b96f6ce2a1b841b6f6657bced` |
| **Size** | 188,048 bytes |
| **Distinct blobs for the PDF** | **1** — one blob, addressable from two paths |

**The regression baselines that carried the legal name** (R4 below).
Each has exactly one historical blob, all introduced by the same commit:

| Blob | Path |
|---|---|
| `78ae5b1e9e08fff3c8f822a913215f5eaf566904` | `…/regression_baselines/sibiu_dec_2019.json` |
| `d6319e2831604072ea4849efcd9ab435c0deb44b` | `…/regression_baselines/archive/sibiu_dec_2019_pre_f3.7d.json` |
| `ed877592dbb6186f8a6b6e77cbb7d6380eba4027` | `…/regression_baselines/archive/sibiu_dec_2019_pre_f3.8.json` |

**Four blobs total.** `scripts/history-scrub/scrub_sibiu.sh` defaults to
exactly this set.

**Paths and commit range**

| Path | Introduced | Last touched |
|---|---|---|
| `src/engine/country_packs/ro_romania/fixtures/pdf_samples/scandia_sibiu_2019.pdf` | `c81456e` (2026-06-16) | HEAD |
| `corpus/pdf_positional/input.pdf` | `375bf55` (2026-08-19) | HEAD |

Effective range: **`c81456e..HEAD`** (`4d65125` at the time of writing).
Both paths resolve to the same blob at every commit that touches them,
so a scrub has exactly one object to remove — not two.

**Three corrections to the assumption this ADR was opened under:**

1. `files/scandia_sibiu_tb_2019.pdf` is **not** in history. `files/` is
   gitignored (`.gitignore:36`), so that copy was never committed. The
   scrub scope is narrower than assumed.
2. There is **one** blob, not one per path. Git deduplicates by content,
   and the two paths have always held identical bytes.
3. The redaction is currently **uncommitted**. At `HEAD` the plaintext
   blob is still the committed content of both paths; it becomes
   history-only once the working tree is committed. Until then, "the
   tree is clean" is a statement about the working tree, which is
   exactly the scope `scripts/check_corpus_policy.py` checks.

The commit that introduced the blob is titled *"chore: snapshot before
opening to coder collaborator"*. **A review trigger below has therefore
already fired once, before this record existed.** That is the strongest
argument for writing the triggers down rather than relying on judgement
in the moment.

### Document owner — UNCONFIRMED, conservative default applied

**Owner: UNCONFIRMED — conservatively treated as CLIENT DOCUMENT; all
review triggers below are BINDING.** (D1 autonomous closure, 2026-08-22:
zero-owner mode forbids blocking on this answer, and the conservative
reading is the only safe default — treating a client's document as one's
own would silently relax live notification duties, while the reverse
merely keeps prudent hygiene binding.)

To flip when the owner answers, one command from the repo root:

    make adr-confirm OWNER=eei      # EEI's own document — triggers stay
                                    # prudent hygiene, acted on at will
    make adr-confirm OWNER=client   # confirmed client document — the
                                    # "client or legal request" trigger is
                                    # a live notification duty

The target rewrites only this Owner line (audited in git like any edit).

This is the single unresolved input, and it is not cosmetic: if the
trial balance is EEI's own document, the residual is self-inflicted and
the triggers below are prudent hygiene the owner may act on at their own
pace; if it is a **client's** document, the residual is a third party's
confidential financial data held without their knowledge, the "client or
legal request" trigger becomes a live notification duty rather than a
reactive one, and the deferral rationale below (a two-person private
repo) stops being sufficient on its own.

Until this is answered, treat the triggers as **binding**, not advisory.

---

## Decision

**History is retained. The scrub is deferred, not cancelled.**

No rewrite, no force-push, no re-clone. Existing clones and in-flight
branches are completely unaffected.

Rationale:

- The repository is **private, with two people holding access**. The
  realistic exposure population is exactly those two people, both of
  whom have legitimate access to the plaintext anyway.
- **HEAD is redacted.** Every future clone, every CI checkout and every
  new collaborator sees only the scrambled file. The exposure is limited
  to people who deliberately go looking in the object store.
- A history rewrite has a **blast radius of every clone and every open
  branch in existence**. At the current access level that coordination
  cost is not justified by the marginal risk reduction — and, per the
  residual below, a rewrite does not fully remove the exposure anyway.
- Deferral is only defensible **with the triggers written down and the
  tooling ready to run**. Both now exist (`scripts/history-scrub/`), so
  the decision can be reversed in minutes rather than re-litigated.

### What was explicitly NOT done, and why

A gate that scans git history was considered and **rejected as a
defect**. Given this decision, such a gate would be red on every run
forever, by design. A control that can only ever be red teaches people
to ignore controls. `scripts/check_corpus_policy.py` therefore judges
the **working tree only** and is structurally incapable of history
archaeology (its single git entry point refuses any subcommand other
than `ls-files`). The historical exposure surfaces as a NOTICE sourced
from *this file*, never from a scan.

---

## Consequences

### Accepted residual — the primary one

1. **The plaintext is permanently recoverable from every existing
   clone.** Anyone who already has a copy of this repository can run
   `git cat-file -p cdba88b9…` and get the unredacted PDF. Nothing in
   the working tree changes that.

2. **A future scrub REDUCES exposure; it does not ERASE it.** This is
   the part most easily assumed away. After `git-filter-repo` and a
   force-push, the blob becomes unreachable from any ref — but the
   hosting provider keeps unreachable objects addressable **by SHA**
   through its own caching and its fork/PR object pools. On GitHub, a
   URL of the form `…/blob/cdba88b9…` can continue to serve the object
   after the rewrite. **Purging that cache requires a support request to
   the provider**; it is not something the rewrite itself accomplishes,
   and it is not something the runbook can do unattended. Any plan that
   treats "we ran filter-repo" as "the data is gone" is wrong.

3. Consequently, if the document turns out to be a **client** document
   and a disclosure duty attaches, the scrub is a mitigation step, not a
   remedy, and should not be reported as one.

### Other accepted residuals (found by sweeping all 1,307 tracked files, not just the PDFs)

| # | Residual | Disposition |
|---|---|---|
| R1 | `scripts/measure_bs_drift.py` carries the legal name in the F3.7c registration docstring and as the display label handed to `assemble_statements`. | **Retained.** Reviewed provenance reference in a gate script outside this stream's ownership. Exempted by category in `scripts/corpus_policy_allowlist.txt`; no numeric effect. |
| R2 | The two-token short form of the name (legal suffix omitted) appears in 26 tracked files (independently re-counted on token boundaries by the verifier; an earlier estimate of ~8 undercounted) — notably `pyproject.toml`, `docs/ADR-F3.16-closure.md`, `docs/SAGA-CALIBRATION-2026Q2.md`, `scripts/check_detection.py`, `scripts/check_pdf_ingester.py`, `src/engine/country_packs/ro_romania/chart_of_accounts.py`, and this file's siblings. | **Retained.** The scrambler's lexicon deliberately scopes the term to the full legal name, so the short form is not a lexicon member and not a gate violation. Removing it would be a repo-wide rename touching files this stream does not own, for a disclosure strictly smaller than the one already accepted above. |
| R3 | Three tracked regression baselines carried the legal name at `/_meta/company` and `/assembled/statements/companyName`; `BASELINE_HISTORY.md` carried it twice plus three site names in prose. | **FIXED 2026-08-20.** Rewritten with the same scrambler, seed and lexicon as the PDF redaction. Verified first that nothing asserts those strings: `check_assembled_parity.py` iterates only `eei_dec_2025` and `scandia_fy2025`, and `measure_bs_drift.py` does not read the baselines at all. Only named-entity spans were rewritten — identifier- and number-shaped spans were excluded by construction, so nothing numeric moved. |
| R4 | The **prior** blobs of those three baselines remain in history with the legal name in the clear (`78ae5b1e…`, `d6319e28…`, `ed877592…`), one blob each, all from `c81456e`. | **Accepted, same rationale as the PDF**, and **counted** in `Accepted-Plaintext-Blobs` above rather than quietly folded into it. They disclose strictly less than the PDF blob — a name, not a financial document — but a counter that silently excluded them would make the register disagree with the tooling that has to remove them. |
| R5 | `scripts/pdf_scrambler.py`'s `normalize_term` docstring spelled one of the site names it exists to remove. | **FIXED 2026-08-20** — replaced with a fabricated example, with a note explaining why the example must stay fictional. |
| R6 | The baselines' `_meta.engine_module` records an absolute path containing the operator's local home directory. | **Retained.** Discloses a local username, not client data. Noted so it is a decision rather than an oversight. |
| R7 | The scrambler produces different ciphertext for different casings of one term, so a single entity can appear under more than one scrambled spelling (this is already true inside the redacted PDF itself). | **Accepted, by design.** Documented at the head of `BASELINE_HISTORY.md` so the variants are not misread as different entities. |
| R8 | **Latent detector gap.** `pdf_scrambler.find_sensitive_spans` tokenizes raw text with `[0-9A-Za-z]+` *before* folding diacritics, so an accented character acts as a token separator. A SINGLE-word accented term is still caught (the character slice spans the accent); a MULTI-WORD term containing an accent is **missed**, because the extra tokens push the phrase past `MAX_TERM_TOKENS`. | **Accepted, tracked.** Does not bite the shipped lexicon: its multi-word terms are ASCII as printed in the source document, and its accented term is a single word. Verified empirically in both directions and locked by `tests/engine/test_corpus_policy.py::test_known_limitation_multi_word_diacritics_are_missed`, which fails loudly if the gap is ever closed upstream (delete the test and this row then). Closing it means folding before tokenizing in the redactor — a change to `pdf_scrambler.py` beyond this stream's docstring-only ownership of that file. **Re-check this row before adding any accented multi-word term to the lexicon.** |

### Review triggers — ANY ONE requires running the runbook BEFORE proceeding

This is a **pre-condition checklist, not a notification list**. If any
box would become true, run `scripts/history-scrub/RUNBOOK.md` to
completion *first*, then proceed.

- [ ] **A new collaborator gains read access** to this repository —
      employee, contractor, reviewer, or auditor. (Already fired once at
      `c81456e`; treat the next one as non-negotiable.)
- [ ] **A new CI system, bot, or third-party integration gains repo read
      access** — including code scanners, coverage services and AI
      review tools, all of which clone full history by default.
- [ ] **Repository visibility changes** — private → internal, internal →
      public, or the org's default visibility changes underneath it.
- [ ] **The repository is migrated, forked, mirrored or transferred** —
      to another host, another org, or another owner. Forks inherit the
      object store and forks cannot be un-forked.
- [ ] **The client or their counsel requests deletion, or any legal or
      regulatory duty attaches** — this is the trigger whose urgency
      depends on the unresolved owner question above.
- [ ] **A leak is suspected or confirmed** by any route.

If a trigger fires and the scrub is *still* deliberately deferred, that
is a new decision: amend this record with the date, who decided, and
why. Do not leave the checklist silently unticked.

---

## Remediation tooling

`scripts/history-scrub/` — operator-only, human-invoked, never
automated. `scripts/check_scrub_tooling_unreachable.py` proves on every
CI run that no automation surface in the tree can reach it, and
`tests/engine/test_corpus_policy.py` proves the script refuses to act
when invoked without its two explicit confirmation flags.

Read `scripts/history-scrub/RUNBOOK.md` before touching anything: the
rewrite is the *last* step, after freezing pushes, announcing to both
clone holders, and agreeing the re-clone and branch-rebase plan.
