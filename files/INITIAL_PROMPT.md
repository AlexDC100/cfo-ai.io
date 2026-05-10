# Initial Prompt for Claude Code

Copy-paste this as your first message to Claude Code after placing CLAUDE.md, config.yaml, and VALIDATION_FIXTURE.md in the project root, with Trading_analysis_YTDOct_25_LV.xlsx in ./data/.

---

Read these files in order before doing anything else:
1. `CLAUDE.md` — full project brief with business logic, formulas, calibrated thresholds
2. `config.yaml` — calibrated configuration values (do not change)
3. `VALIDATION_FIXTURE.md` — the golden dataset; the engine's correctness contract
4. `data/Trading_analysis_YTDOct_25_LV.xlsx` — the development input (Analysis sheet for categories, "YTD Oct'25" sheet for SKUs)

Before writing any code, do these three things in order:

**Step 1 — Confirm understanding.** Summarize back to me in 7-10 bullets:
- What the system does
- The real_margin formula and why DIO matters
- The hybrid granularity model (DIO at category level, P&L at SKU level, inheritance rules)
- The anchor protection logic (and the special case of Macrou's high-volume floor)
- The MURATURI decision (warning, not strategic)
- The deliverable order (Phase 1 only)
- The validation contract (validate.py must reproduce the fixture exactly)

If anything in CLAUDE.md is ambiguous or contradicts itself, list questions now — do not guess.

**Step 2 — Propose Phase 1 file structure.** Show me the exact tree (directories + files) you intend to create, with one-line purpose for each file. Do not create files yet. Include test files alongside source files.

**Step 3 — Identify the first 3 tasks** in order, with complexity (S/M/L):
- Task 1: scaffolding + config loader + Excel loader (proves you can read both sheets correctly)
- Task 2: metrics module with unit tests (math is the product — tests first)
- Task 3: anchor classifier (both SKU and category level)

Wait for my approval after these three steps before writing any code.

---

Once approved, proceed with Phase 1 only. Use Python 3.11, pandas, pydantic for config, pytest for tests. Type hints everywhere, mypy strict.

For the metrics module, write the unit tests **first** with worked examples from CLAUDE.md (5% margin, 100 DIO, 6.5% cost of capital → real_margin should be 5 - (100/365)*6.5 = 3.22%). Tests must pass before you consider the module done.

Phase 1 is ONLY DONE when `python -m engine validate` runs against the YTD Oct dataset and produces the exact classifications in VALIDATION_FIXTURE.md. If you can't reproduce the fixture, the engine is wrong — don't change the fixture.

Do NOT touch Phase 2 or Phase 3.

Begin with Step 1.
