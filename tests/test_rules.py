"""Tests for the rules engine.

Each test maps to a specific calibration case from VALIDATION_FIXTURE.md.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from engine.config import Config, load_config
from engine.metrics import real_margin
from engine.models import CategoryMetrics
from engine.rules import classify


@pytest.fixture
def cfg() -> Config:
    return load_config(Path(__file__).parent.parent / "config.yaml")


def _cm(category: str, vol: float, niv: float, gm_pct: float, dio: int) -> CategoryMetrics:
    rm = real_margin(gm_pct, dio, 6.5)
    return CategoryMetrics(
        category=category,
        business_unit=None,
        volume_tons=vol,
        niv_kron=niv,
        gm_pct=gm_pct,
        dio_days=dio,
        ccc_days=None,
        real_margin_pct=rm,
        abs_profit_kron=rm / 100.0 * niv,
    )


# ─────────── ELIMINATE cases ───────────


def test_calamar_negative_real_margin_eliminate(cfg: Config) -> None:
    flag, reason, _ = classify(_cm("Calamar", 0.2, 3.4, -90.7, 100), cfg, is_anchor=False)
    assert flag == "ELIMINATE"
    assert reason == "real_margin_negative"


def test_pastrav_healthy_margin_NOT_eliminated(cfg: Config) -> None:
    """Pastrav: small volume (0.7 t) but ~7% real margin → NOT eliminated.

    Pre-fix this fired micro_volume_micro_profit just because vol < 5 and
    abs_profit < 5. The margin gate now protects niche items with healthy
    per-unit economics. Pastrav lands as KEEP — small but profitable, no
    rule promotes or demotes it.
    """
    flag, _, _ = classify(_cm("Pastrav", 0.7, 28.2, 8.7, 100), cfg, is_anchor=False)
    assert flag != "ELIMINATE", "Pastrav has 6.9% real margin — must not be eliminated"


def test_plachie_healthy_margin_NOT_eliminated(cfg: Config) -> None:
    """Plachie: 0.4 t, 13.7% gross GM → ~11.9% real margin → NOT eliminated."""
    flag, _, _ = classify(_cm("Plachie", 0.4, 6.0, 13.7, 100), cfg, is_anchor=False)
    assert flag != "ELIMINATE", "Plachie has 11.9% real margin — must not be eliminated"


def test_micro_eliminate_only_when_thin_margin(cfg: Config) -> None:
    """Confirm the legitimate cull case: tiny volume + tiny profit AND thin
    margin together still ELIMINATE via micro_volume_micro_profit.
    """
    # vol=1, niv=80, gm=2% → real_margin ≈ 2 - 100/365*6.5 = 0.22%
    # abs_profit ≈ 0.22/100 * 80 = 0.18 kRON. All three gates fail → eliminate.
    flag, reason, _ = classify(_cm("Truly micro", 1.0, 80.0, 2.0, 100), cfg, is_anchor=False)
    assert flag == "ELIMINATE"
    assert reason == "micro_volume_micro_profit"


def test_capital_trap_eliminate(cfg: Config) -> None:
    """Manufactured: high DIO + thin margin (not anchor) = capital trap."""
    flag, reason, _ = classify(_cm("Trapped", 20, 100, 6.0, 200), cfg, is_anchor=False)
    assert flag == "ELIMINATE"
    assert reason == "capital_trap"


# ─────────── WARNING cases ───────────


def test_muraturi_thin_margin_warning(cfg: Config) -> None:
    """MURATURI: 185t volume + thin margin → WARNING with high-volume escalation.

    Volume (185t) is above warning.max_volume_tons=150 so the rule fires the
    urgent renegotiation reason rather than the plain thin-margin one. NOT an
    anchor (this run uses is_anchor=False).
    """
    flag, reason, rec = classify(_cm("MURATURI", 185.4, 1401.0, 1.1, 40), cfg, is_anchor=False)
    assert flag == "WARNING"
    assert reason == "thin_margin_high_volume"
    assert rec is not None
    assert "renegotiate" in rec


def test_pet_food_thin_margin_warning(cfg: Config) -> None:
    """PET FOOD: 152t (just above the 150t ceiling) → high-volume escalation."""
    flag, reason, _ = classify(_cm("PET FOOD", 152.3, 969.3, 2.8, 50), cfg, is_anchor=False)
    assert flag == "WARNING"
    assert reason == "thin_margin_high_volume"


def test_thin_margin_micro_volume_eliminates(cfg: Config) -> None:
    """Below warning.min_volume_tons=5 with thin margin → ELIMINATE.

    NIV chosen so abs_profit clears the eliminate.micro_profit_kron=5 floor —
    otherwise the older micro_volume_micro_profit rule would fire first.
    """
    flag, reason, _ = classify(_cm("Tiny", 3.0, 500.0, 2.0, 40), cfg, is_anchor=False)
    assert flag == "ELIMINATE"
    assert reason == "thin_margin_micro_volume"


def test_thin_margin_mid_volume_stays_warning(cfg: Config) -> None:
    """Volume in the [5, 150] band keeps the original thin_real_margin reason."""
    flag, reason, _ = classify(_cm("MidBand", 50.0, 500.0, 2.5, 40), cfg, is_anchor=False)
    assert flag == "WARNING"
    assert reason == "thin_real_margin"


def test_jeleuri_long_dio_warning(cfg: Config) -> None:
    """JELEURI: 180-day DIO triggers long_dio WARNING (review for turnover)."""
    flag, reason, _ = classify(_cm("JELEURI", 8.7, 380.4, 21.8, 180), cfg, is_anchor=False)
    assert flag == "WARNING"
    assert reason == "long_dio"


def test_compot_long_dio_warning(cfg: Config) -> None:
    flag, reason, _ = classify(_cm("COMPOT", 79.5, 728.7, 9.4, 180), cfg, is_anchor=False)
    assert flag == "WARNING"
    assert reason == "long_dio"


def test_gommy_high_margin_low_volume_NEVER_eliminates(cfg: Config) -> None:
    """High-margin niche premium product must NOT be ELIMINATED by volume alone.

    THE GOMMY S Mini bomboane gumate ursuleti 80g — JELEURI parent (DIO 180):
        volume 1.05 t · gross GM 16.8% · profit 7.3 kRON
        → real margin ≈ 13.6%, healthy enough that the volume is irrelevant
          to a kill decision.

    Pre-fix, the long_dio_micro_volume escalation auto-eliminated this for
    being small. After fix: the long_dio rule still fires (review signal)
    but the result is WARNING, never ELIMINATE.
    """
    flag, reason, _ = classify(_cm("GOMMY S Mini bomb", 1.05, 43.5, 16.8, 180), cfg, is_anchor=False)
    assert flag != "ELIMINATE", (
        f"GOMMY S regression: 16.8% gross margin niche product was eliminated "
        f"on volume alone (got {flag} / {reason})"
    )
    # Today this lands as WARNING long_dio — review the inventory cycle, don't cut.
    assert flag == "WARNING"
    assert reason == "long_dio"


def test_low_vol_thin_margin_still_eliminates(cfg: Config) -> None:
    """Confirm the protection didn't break the legitimate cull case: a SKU
    that is BOTH low-volume AND thin-margin still goes to ELIMINATE via
    thin_margin_micro_volume. Volume only kills when paired with a thin
    margin, never on its own.
    """
    flag, reason, _ = classify(_cm("Tiny thin", 3.0, 500.0, 2.0, 40), cfg, is_anchor=False)
    assert flag == "ELIMINATE"
    assert reason == "thin_margin_micro_volume"


# ─────────── SCALE cases ───────────


def test_suc_volume_play_scale(cfg: Config) -> None:
    """SUC: 205t at 9.3% real margin → SCALE (volume play rule)."""
    flag, reason, _ = classify(_cm("SUC", 205.2, 881.7, 10.1, 30), cfg, is_anchor=False)
    assert flag == "SCALE"
    assert reason == "volume_play"


# ─────────── KEEP cases ───────────


def test_caras_at_warning_boundary_keeps(cfg: Config) -> None:
    """Caras: real_margin = 5 - (100/365)*6.5 = 3.22 → just above 3.0 warning floor."""
    flag, _, _ = classify(_cm("Caras", 4.8, 184.7, 5.0, 100), cfg, is_anchor=False)
    assert flag == "KEEP"


def test_somon_high_margin_low_volume_keeps(cfg: Config) -> None:
    """Somon: 14.5% real margin but only 10t volume — high margin but below 30t SCALE floor."""
    flag, _, _ = classify(_cm("Somon", 10.4, 585.6, 16.3, 100), cfg, is_anchor=False)
    assert flag == "KEEP"


def test_sosuri_high_margin_low_volume_keeps(cfg: Config) -> None:
    """SOSURI: 27.5% real margin but only 8.6t volume — KEEP, not SCALE."""
    flag, _, _ = classify(_cm("SOSURI", 8.6, 297.9, 28.4, 40), cfg, is_anchor=False)
    assert flag == "KEEP"


def test_hering_file_just_above_warning_threshold_keeps(cfg: Config) -> None:
    """Hering file: real_margin 3.3 — just above 3.0 warning boundary, KEEP."""
    flag, _, _ = classify(_cm("Hering file", 19.8, 538.0, 4.9, 90), cfg, is_anchor=False)
    assert flag == "KEEP"


# ─────────── ANCHOR cases ───────────


def test_macrou_anchor_alert(cfg: Config) -> None:
    """Macrou as anchor → real margin 3.6% < 5% high-vol floor → ANCHOR_ALERT."""
    flag, reason, rec = classify(_cm("Macrou", 352.8, 7455.4, 5.2, 90), cfg, is_anchor=True)
    assert flag == "ANCHOR_ALERT"
    assert reason == "high_volume_anchor_below_floor"
    assert rec is not None
    assert "review" in rec or "renegotiate" in rec


def test_ton_clean_anchor(cfg: Config) -> None:
    """Ton: 12.4% real margin, no breach → ANCHOR (clean)."""
    flag, _, _ = classify(_cm("Ton", 306.9, 10118.2, 14.2, 90), cfg, is_anchor=True)
    assert flag == "ANCHOR"


def test_legume_anchor_at_margin_floor(cfg: Config) -> None:
    """LEGUME: real margin 5.23% — clears 5% floor, clean ANCHOR."""
    flag, _, _ = classify(_cm("LEGUME CONSERVATE", 1383.9, 12915.9, 6.3, 60), cfg, is_anchor=True)
    assert flag == "ANCHOR"


def test_anchor_never_eliminated_even_with_thin_margin(cfg: Config) -> None:
    """Confirm the anchor branch never returns ELIMINATE."""
    # Construct a category that would otherwise be ELIMINATE: high DIO + thin margin
    flag, _, _ = classify(_cm("Hypothetical", 100, 1000, 6.0, 200), cfg, is_anchor=True)
    assert flag != "ELIMINATE"
