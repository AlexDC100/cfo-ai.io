"""READ-ONLY sweep: which persisted alerts would render with two currencies?

Part A of the narrative-numerics sweep (design_review/narrative/SWEEP.md).
This script NEVER writes. It reads the `alerts` table and re-implements —
in Python — the exact matching contract of
`frontend/lib/linkifyAlertBody.tsx::parseLinkifiedBody` as it stands AFTER
the containment commit c05eab2:

  * regex        /(?:RON\\s+)?(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)(?:\\s+RON)?/g
  * skip         parsed < 1000
  * match        |fact - parsed| < max(1, parsed * 0.005)  (first fact wins)
  * MATCHED      -> rendered through the currency path (converted to display)
  * NOT matched  -> left as literal text, KEEPING any adjacent "RON" label

A rendered claim therefore carries TWO currencies when the same string
contains at least one MATCHED figure (which becomes EUR for a EUR-display
user) and at least one UNMATCHED figure that is money (which stays "RON N").

Two render surfaces are evaluated separately, because they differ:

  · pages/cfo/Alerts.tsx        title AND body both go through linkify
  · components/cfo/StatementNotes.tsx
                                body goes through linkify; the TITLE is
                                rendered raw (line 283) — so a title that
                                carries any money figure is already a second
                                currency next to a converted body.

Usage (read-only, from the repo or piped into the prod container):
    python3 scripts/sweep_alert_currency_unity.py
"""

from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from typing import Any, Dict, List, Optional, Tuple

RX = re.compile(r"(?:RON\s+)?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s+RON)?")

# Numeric tokens that are demonstrably NOT money even though they clear the
# 1000 floor. Kept deliberately tiny — over-excluding would hide findings.
_NON_MONEY_CONTEXT = re.compile(r"(?:account|acct|cont)\s*$", re.IGNORECASE)


def classify_string(text: str, facts: Dict[str, float]) -> Dict[str, Any]:
    """Return {matched:[...], unmatched_money:[...], mixes: bool}."""
    value_to_fact: Dict[int, str] = {}
    for name, value in (facts or {}).items():
        if isinstance(value, (int, float)):
            r = round(float(value))
            value_to_fact.setdefault(r, name)

    matched: List[Tuple[str, float]] = []
    unmatched: List[str] = []

    for m in RX.finditer(text or ""):
        full = m.group(0)
        num = m.group(1)
        try:
            parsed = float(num.replace(",", ""))
        except ValueError:
            continue
        if parsed < 1000:
            continue

        hit: Optional[str] = None
        for fv, fname in value_to_fact.items():
            tol = max(1.0, parsed * 0.005)
            if abs(fv - parsed) < tol:
                hit = fname
                break

        if hit:
            matched.append((hit, parsed))
        else:
            # Money only when the token itself carries a RON label, OR the
            # 3-digit-grouped shape the engine's `{x:,.0f}` always emits.
            labelled = "RON" in full
            grouped = "," in num
            preceding = (text or "")[max(0, m.start() - 12):m.start()]
            if (labelled or grouped) and not _NON_MONEY_CONTEXT.search(preceding):
                unmatched.append(full.strip())

    return {
        "matched": matched,
        "unmatched_money": unmatched,
        "mixes": bool(matched) and bool(unmatched),
    }


def money_tokens(text: str) -> List[str]:
    """Any money-looking token in a string, regardless of facts_cited."""
    out: List[str] = []
    for m in RX.finditer(text or ""):
        num = m.group(1)
        try:
            parsed = float(num.replace(",", ""))
        except ValueError:
            continue
        if parsed < 1000:
            continue
        if "RON" in m.group(0) or "," in num:
            out.append(m.group(0).strip())
    return out


def analyse(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    per_key_alerts_surface: Counter = Counter()
    per_key_notes_surface: Counter = Counter()
    per_key_title_unmatched: Counter = Counter()
    examples: Dict[str, Dict[str, Any]] = {}
    no_facts: Counter = Counter()

    total = 0
    for r in rows:
        total += 1
        payload = r.get("payload") or {}
        if isinstance(payload, str):
            try:
                payload = json.loads(payload)
            except Exception:  # noqa: BLE001
                payload = {}
        facts = payload.get("facts_cited") or {}
        rule_key = payload.get("rule_key") or (r.get("alert_key") or "").split(":")[0]
        title = r.get("title") or ""
        body = r.get("body") or ""

        if not facts:
            if money_tokens(title) or money_tokens(body):
                no_facts[rule_key] += 1

        b = classify_string(body, facts)
        t = classify_string(title, facts)

        # SURFACE 1 — Alerts.tsx: title and body each linkified independently.
        if b["mixes"] or t["mixes"]:
            per_key_alerts_surface[rule_key] += 1
            examples.setdefault(rule_key, {
                "alert_key": r.get("alert_key"),
                "title": title,
                "body": body,
                "facts_cited": facts,
                "body_matched": [n for n, _ in b["matched"]],
                "body_unmatched": b["unmatched_money"],
                "title_matched": [n for n, _ in t["matched"]],
                "title_unmatched": t["unmatched_money"],
            })

        # SURFACE 2 — StatementNotes.tsx: title rendered RAW; body linkified.
        # Any money in the title + any conversion in the body = two currencies
        # in one card.
        if money_tokens(title) and b["matched"]:
            per_key_notes_surface[rule_key] += 1

        if t["unmatched_money"]:
            per_key_title_unmatched[rule_key] += 1

    return {
        "total": total,
        "alerts_surface": per_key_alerts_surface,
        "notes_surface": per_key_notes_surface,
        "title_unmatched": per_key_title_unmatched,
        "no_facts_but_money": no_facts,
        "examples": examples,
    }


def main() -> None:
    from engine.api import _supabase  # type: ignore

    with _supabase.admin() as c:
        rows = c.select("alerts", columns="id,alert_key,severity,title,body,payload")

    res = analyse(rows)
    print("TOTAL_ALERT_ROWS", res["total"])
    print()
    print("== SURFACE 1 — /alerts (title + body linkified) — rows that MIX ==")
    for k, n in res["alerts_surface"].most_common():
        print(f"  {n:>4}  {k}")
    print("  SUBTOTAL", sum(res["alerts_surface"].values()))
    print()
    print("== SURFACE 2 — Statements > Notes (title RAW next to converted body) ==")
    for k, n in res["notes_surface"].most_common():
        print(f"  {n:>4}  {k}")
    print("  SUBTOTAL", sum(res["notes_surface"].values()))
    print()
    print("== Titles carrying an UNMATCHED money figure (stays RON even where linkified) ==")
    for k, n in res["title_unmatched"].most_common():
        print(f"  {n:>4}  {k}")
    print()
    print("== Rows with money in text but NO facts_cited (never convertible) ==")
    for k, n in res["no_facts_but_money"].most_common():
        print(f"  {n:>4}  {k}")
    print()
    print("== EXAMPLES ==")
    print(json.dumps(res["examples"], indent=2, ensure_ascii=False, default=str)[:6000])


if __name__ == "__main__":
    main()
