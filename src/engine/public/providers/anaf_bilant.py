"""ANAF Bilanț provider — official statutory financials for Romanian
companies, free, no auth.

Endpoint: ``GET https://webservicesp.anaf.ro/bilant?an=<year>&cui=<cui>``
Returns the company's filed annual statement summary as labeled
indicators, e.g.::

    {"an":2023, "cui":1590082, "deni":"OMV PETROM SA", "caen":610,
     "den_caen":"Extractia petrolului brut",
     "i":[{"indicator":"I13","val_indicator":33828196866,
           "val_den_indicator":"Cifra de afaceri neta"}, ...]}

Design notes:

* **stdlib only** (urllib) — this runs both inside the engine container
  and from the operator's ``scripts/backfill_bvb_anaf.py`` on a machine
  with no third-party deps installed.
* **Label-based parsing.** The indicator CODES (I1..I40) differ between
  filing forms (standard vs. micro vs. bank/IFRS), but the labels are
  stable Romanian accounting terms. We normalize diacritics and match on
  the label, with two documented code-based fallbacks for a known ANAF
  labeling bug (I19 carries the label "Pierdere bruta" but is the NET
  loss on the standard form; I17 is the gross loss).
* **Statutory standalone, not consolidated.** ANAF bilanț is the parent
  entity's RAS filing. For groups (banks, DIGI, holdings) it differs from
  the consolidated annual report — callers must treat these values as
  gap-fillers, never as overrides for curated consolidated figures
  (see bvb_seed._apply_anaf_cache: it only fills fields that are None).
* **Field mapping is deliberately conservative.** "DATORII" is TOTAL
  liabilities (incl. trade payables), NOT financial debt — mapping it to
  grossDebt would wildly overstate leverage, so it is exposed as
  ``total_liabilities`` and NOT pushed into the snapshot's debt fields.
* The name echo (``deni``) doubles as CUI verification: callers should
  sanity-check it against the expected company name before trusting the
  numbers (see scripts/backfill_bvb_anaf.py).

Rate limits: ANAF tolerates ~1 request/second. The backfill script
sleeps between calls; do NOT fan this out in parallel.
"""

from __future__ import annotations

import json
import unicodedata
import urllib.error
import urllib.request
from typing import Any, Dict, Optional

ANAF_BILANT_URL = "https://webservicesp.anaf.ro/bilant?an={year}&cui={cui}"

_UA = "cfo-ai.io BVB enrichment (contact: support@cfo-ai.io)"


def _norm(label: str) -> str:
    """Uppercase, strip diacritics and collapse whitespace/punctuation."""
    s = unicodedata.normalize("NFKD", label)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return " ".join(s.upper().replace(",", " ").replace(":", " ").split())


def fetch_bilant(cui: int | str, year: int, timeout: float = 20.0) -> Optional[Dict[str, Any]]:
    """Fetch one company-year filing. Returns the raw payload, or None
    when the company has no filing for that year (ANAF returns an empty
    body or ``"i": null``) or on transport error."""
    url = ANAF_BILANT_URL.format(year=year, cui=str(cui).upper().removeprefix("RO"))
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 — fixed https host
            body = resp.read().decode("utf-8", errors="replace").strip()
    except (urllib.error.URLError, TimeoutError, OSError):
        return None
    if not body:
        return None
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict) or not payload.get("i"):
        return None
    return payload


# Normalized-label → parsed-field. Prefix matching ("startswith") because
# ANAF appends qualifiers like "- TOTAL din care".
_LABEL_MAP = [
    ("CIFRA DE AFACERI NETA", "revenue"),
    ("VENITURI TOTALE", "total_income"),
    ("CHELTUIELI TOTALE", "total_expenses"),
    ("PROFIT NET", "profit_net"),
    ("PROFITUL NET", "profit_net"),
    ("PIERDERE NETA", "loss_net"),
    ("PROFIT BRUT", "profit_gross"),
    ("PROFITUL BRUT", "profit_gross"),
    ("CAPITALURI - TOTAL", "equity"),
    ("CAPITALURI PROPRII", "equity"),
    ("CASA SI CONTURI LA BANCI", "cash"),
    ("ACTIVE IMOBILIZATE - TOTAL", "fixed_assets"),
    ("ACTIVE CIRCULANTE - TOTAL", "current_assets"),
    ("STOCURI", "inventories"),
    ("CREANTE", "receivables"),
    ("DATORII", "total_liabilities"),
    ("PROVIZIOANE", "provisions"),
    ("NUMAR MEDIU DE SALARIATI", "employees"),
]


def parse_bilant(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize a raw bilant payload into named fields (RON units)."""
    out: Dict[str, Any] = {
        "cui": payload.get("cui"),
        "year": payload.get("an"),
        "company_name": (payload.get("deni") or "").strip(),
        "caen": payload.get("caen"),
        "caen_label": (payload.get("den_caen") or "").strip(),
    }
    for item in payload.get("i") or []:
        label = _norm(str(item.get("val_den_indicator") or ""))
        code = str(item.get("indicator") or "")
        val = item.get("val_indicator")
        if not isinstance(val, (int, float)):
            continue
        # Known ANAF labeling bug on the standard form: I19 repeats the
        # label "Pierdere bruta" but holds the NET loss (I17 is gross).
        if label == "PIERDERE BRUTA":
            out["loss_gross" if code == "I17" else "loss_net"] = val
            continue
        for prefix, field in _LABEL_MAP:
            if label.startswith(prefix):
                out.setdefault(field, val)
                break

    profit = out.get("profit_net") or 0
    loss = out.get("loss_net") or 0
    if "profit_net" in out or "loss_net" in out:
        out["net_income"] = profit - loss
    return out


def snapshot_fields_from_bilant(parsed: Dict[str, Any]) -> Dict[str, Any]:
    """The partial PublicCompanyFinancialSnapshot overlay a parsed filing
    supports. Only fields the statutory summary genuinely carries —
    conservative on purpose (no debt fields: "DATORII" ≠ financial debt).
    """
    revenue = parsed.get("revenue")
    net_income = parsed.get("net_income")
    fields: Dict[str, Any] = {}
    if revenue is not None and revenue > 0:
        fields["revenue"] = float(revenue)
    if net_income is not None:
        fields["netIncome"] = float(net_income)
        if revenue:
            fields["netMargin"] = round(net_income / revenue * 100, 2)
    if parsed.get("equity") is not None:
        fields["equity"] = float(parsed["equity"])
    if parsed.get("cash") is not None:
        fields["cash"] = float(parsed["cash"])

    # Balance-sheet ratios the statutory summary DOES support:
    #  · ROA — net income over total assets (fixed + current), both from
    #    the same standalone filing, so the ratio is internally consistent.
    #  · Debt / Equity — statutory basis: DATORII (total liabilities,
    #    incl. trade payables) over CAPITALURI. Broader than the
    #    financial-debt-only convention, which the summary can't isolate;
    #    still the leverage read Romanian statutory analysis uses.
    fixed_a = parsed.get("fixed_assets")
    current_a = parsed.get("current_assets")
    equity = parsed.get("equity")
    liabilities = parsed.get("total_liabilities")
    if fixed_a is not None and current_a is not None:
        total_assets = float(fixed_a) + float(current_a)
        if total_assets > 0 and net_income is not None:
            fields["roa"] = round(net_income / total_assets * 100, 2)
    if liabilities is not None and equity and equity > 0:
        fields["debtToEquity"] = round(float(liabilities) / float(equity), 2)

    if fields and parsed.get("year"):
        fields["latestPeriod"] = f"FY{parsed['year']}"
        fields["latestPeriodEnd"] = f"{parsed['year']}-12-31"
    return fields
