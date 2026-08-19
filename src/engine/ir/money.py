"""Exact integer money for the LedgerDoc IR (compiler restructure, Phase 0).

`Money` is the ONLY numeric carrier inside the IR: an immutable
(currency, amount_minor, scale) triple where `amount_minor` is an exact
integer count of minor units (cents, bani, fils) and `scale` is the
ISO-4217 minor-unit exponent (2 for RON -> 100 bani per leu, 0 for HUF,
3 for KWD).

NO FLOATS, EVER, ON THE VALUE PATH. This module deliberately contains no
float-constructor call and no `decimal` import: construction happens from
integers (`from_minor`) or from decimal STRINGS parsed by string math
(`from_decimal_str`), display happens by string math (`to_decimal_str`),
and serialization round-trips {currency, amount_minor, scale} verbatim.
`tests/engine/test_ir_types.py` locks the guarantee grep-style by
inspecting this module's source for float construction.

Arithmetic (add / sub / neg / ordering) is defined ONLY between two
Money values with identical currency AND identical scale — anything
mixed raises `MoneyCurrencyMismatch`. Equality (`==`) never raises:
values of different currency or scale are simply unequal (safe for dict
and set membership); scale is part of identity, so 0 RON @ scale 2 and
0 RON @ scale 0 are distinct representations.

CURRENCY SCALE DATA — `CURRENCY_SCALES` below maps ISO-4217 alphabetic
codes to minor-unit exponents. Source: the ISO 4217 currency registry
maintained by SIX Financial Services ("List One: Current currency & funds
code list", 2024 edition), with ONE deliberate deviation:

  * HUF is ISO-listed with exponent 2, but the filler has been out of
    circulation since 1999 and every Hungarian ledger states whole
    forints. We follow bookkeeping practice (and the operator spec):
    HUF scale 0.

Codes not in the table default to `DEFAULT_SCALE` = 2 (the exponent of
the overwhelming majority of world currencies). Per-document override
hook: every constructor takes an explicit `scale` argument that WINS
over the table — a document that demonstrably states, e.g., HUF with two
decimals can carry scale 2 without touching the table.

NOTE the distinction from `ai_lane.FormatDetectResult.scale` (a document
MAGNITUDE multiplier: figures stated in thousands). That is an ingestion
concern resolved BEFORE Money construction; `Money.scale` is strictly
the minor-unit exponent.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Dict, Optional


__all__ = [
    "Money",
    "MoneyError",
    "MoneyCurrencyMismatch",
    "MoneyParseError",
    "CURRENCY_SCALES",
    "DEFAULT_SCALE",
    "scale_for_currency",
]


# --- Errors -----------------------------------------------------------------


class MoneyError(ValueError):
    """Base class for every Money construction / parse failure."""


class MoneyCurrencyMismatch(MoneyError):
    """Arithmetic or ordering attempted across different currency or
    different scale. Money algebra is closed over ONE (currency, scale)."""


class MoneyParseError(MoneyError):
    """A decimal string / dict could not be parsed EXACTLY into minor
    units. This type never rounds: inexact input is an error."""


# --- Currency scale data ----------------------------------------------------

# ISO-4217 minor-unit exponents (see module docstring for source + the
# documented HUF deviation). Keep alphabetical within each group.
CURRENCY_SCALES: Dict[str, int] = {
    # 0-decimal currencies.
    "CLP": 0,
    "HUF": 0,  # ISO says 2; ledger practice is whole forints — see docstring.
    "ISK": 0,
    "JPY": 0,
    "KRW": 0,
    "VND": 0,
    # 2-decimal currencies (explicit for the jurisdictions the platform
    # actually meets; everything unlisted also defaults to 2).
    "AUD": 2,
    "BGN": 2,
    "CAD": 2,
    "CHF": 2,
    "CZK": 2,
    "DKK": 2,
    "EUR": 2,
    "GBP": 2,
    "MDL": 2,
    "NOK": 2,
    "PLN": 2,
    "RON": 2,
    "RSD": 2,
    "SEK": 2,
    "TRY": 2,
    "UAH": 2,
    "USD": 2,
    # 3-decimal currencies.
    "BHD": 3,
    "IQD": 3,
    "JOD": 3,
    "KWD": 3,
    "LYD": 3,
    "OMR": 3,
    "TND": 3,
}

#: Sensible default for any ISO code missing from the table.
DEFAULT_SCALE = 2

#: Sanity ceiling for scales (largest real-world exponent is 4 — CLF).
_MAX_SCALE = 9

_CURRENCY_RE = re.compile(r"^[A-Z]{3}$")
_DECIMAL_STR_RE = re.compile(r"^([+-]?)(\d+)(?:\.(\d+))?$")


def _check_int(value: Any, what: str) -> int:
    """Reject non-int (including bool and any float) with a typed error."""
    if isinstance(value, bool) or not isinstance(value, int):
        raise MoneyParseError(
            "%s must be an int, got %s — floats/bools never enter Money"
            % (what, type(value).__name__)
        )
    return value


def _check_scale(scale: Any) -> int:
    scale = _check_int(scale, "scale")
    if not (0 <= scale <= _MAX_SCALE):
        raise MoneyParseError("scale must be within 0..%d, got %d" % (_MAX_SCALE, scale))
    return scale


def _check_currency(currency: Any) -> str:
    if not isinstance(currency, str):
        raise MoneyParseError(
            "currency must be a str ISO-4217 code, got %s" % type(currency).__name__
        )
    code = currency.strip().upper()
    if not _CURRENCY_RE.match(code):
        raise MoneyParseError(
            "currency must be a 3-letter ISO-4217 code, got %r" % (currency,)
        )
    return code


def scale_for_currency(currency: str, override: Optional[int] = None) -> int:
    """Minor-unit exponent for `currency`.

    Per-document override hook: an explicitly passed `override` WINS over
    the `CURRENCY_SCALES` table (and over the default), so a document
    whose own layout proves a nonstandard exponent can carry it. Unknown
    codes fall back to `DEFAULT_SCALE`.
    """
    if override is not None:
        return _check_scale(override)
    return CURRENCY_SCALES.get(_check_currency(currency), DEFAULT_SCALE)


# --- The type ---------------------------------------------------------------


@dataclass(frozen=True)
class Money:
    """Exact amount of one currency, held as integer minor units.

    Construct via `from_minor` / `from_decimal_str` / `zero` (they apply
    the currency-scale table); direct construction demands all three
    fields and validates them. Instances are frozen: attribute
    assignment raises `dataclasses.FrozenInstanceError`.
    """

    currency: str
    amount_minor: int
    scale: int

    def __post_init__(self) -> None:
        # Normalize-then-validate; object.__setattr__ is the sanctioned
        # escape hatch inside a frozen dataclass's __post_init__.
        object.__setattr__(self, "currency", _check_currency(self.currency))
        object.__setattr__(
            self, "amount_minor", _check_int(self.amount_minor, "amount_minor")
        )
        object.__setattr__(self, "scale", _check_scale(self.scale))

    # -- constructors --------------------------------------------------------

    @classmethod
    def from_minor(
        cls, currency: str, amount_minor: int, scale: Optional[int] = None
    ) -> "Money":
        """Money from an integer count of minor units. `scale` explicit
        wins; otherwise the currency table / default applies."""
        return cls(currency, amount_minor, scale_for_currency(currency, scale))

    @classmethod
    def zero(cls, currency: str, scale: Optional[int] = None) -> "Money":
        """The ZERO of one (currency, scale) — semantically distinct from
        ABSENT (`None`) everywhere in the IR."""
        return cls.from_minor(currency, 0, scale)

    @classmethod
    def from_decimal_str(
        cls, currency: str, text: str, scale: Optional[int] = None
    ) -> "Money":
        """Parse a plain decimal string ('1234.56', '-0.05', '1250') by
        STRING MATH — no float is ever constructed.

        Grammar: optional sign, digits, optional '.' + digits. No
        grouping separators, no locale forms — locale normalization is
        the parsers' job upstream of the IR. Fraction digits beyond the
        scale are accepted ONLY when they are all zeros (still exact);
        any nonzero excess digit raises `MoneyParseError` — this type
        never rounds.
        """
        if not isinstance(text, str):
            raise MoneyParseError(
                "from_decimal_str takes a str, got %s" % type(text).__name__
            )
        eff_scale = scale_for_currency(currency, scale)
        m = _DECIMAL_STR_RE.match(text.strip())
        if not m:
            raise MoneyParseError(
                "not a plain decimal string: %r (grouping separators and "
                "locale formats must be normalized before the IR)" % (text,)
            )
        sign, int_part, frac_part = m.group(1), m.group(2), m.group(3) or ""
        if len(frac_part) < eff_scale:
            frac_part = frac_part.ljust(eff_scale, "0")
        elif len(frac_part) > eff_scale:
            excess = frac_part[eff_scale:]
            if excess.strip("0"):
                raise MoneyParseError(
                    "%r has nonzero digits beyond scale %d for %s — Money "
                    "never rounds" % (text, eff_scale, currency)
                )
            frac_part = frac_part[:eff_scale]
        minor = int(int_part + frac_part)  # pure string -> int, exact
        if sign == "-":
            minor = -minor
        return cls(currency, minor, eff_scale)

    @classmethod
    def from_dict(cls, payload: Dict[str, Any]) -> "Money":
        """Exact inverse of `to_dict`. Strict: exactly the three keys
        {currency, amount_minor, scale}; ints must be real ints."""
        if not isinstance(payload, dict):
            raise MoneyParseError(
                "Money payload must be a dict, got %s" % type(payload).__name__
            )
        expected = {"currency", "amount_minor", "scale"}
        keys = set(payload.keys())
        if keys != expected:
            raise MoneyParseError(
                "Money payload keys must be exactly %s, got %s"
                % (sorted(expected), sorted(keys))
            )
        return cls(payload["currency"], payload["amount_minor"], payload["scale"])

    # -- serialization -------------------------------------------------------

    def to_dict(self) -> Dict[str, Any]:
        """Exact serialization — fixed key order, integers verbatim."""
        return {
            "currency": self.currency,
            "amount_minor": self.amount_minor,
            "scale": self.scale,
        }

    def to_decimal_str(self) -> str:
        """Display/export helper, by string math: '1234.56', '-0.05',
        '1250' (scale 0 has no point). Round-trips through
        `from_decimal_str` exactly."""
        sign = "-" if self.amount_minor < 0 else ""
        digits = str(abs(self.amount_minor))
        if self.scale == 0:
            return sign + digits
        digits = digits.rjust(self.scale + 1, "0")
        return sign + digits[: -self.scale] + "." + digits[-self.scale :]

    # -- algebra (closed over ONE currency+scale) ----------------------------

    def _require_same_unit(self, other: Any, op: str) -> "Money":
        if not isinstance(other, Money):
            raise MoneyCurrencyMismatch(
                "%s is defined between Money values only, got %s"
                % (op, type(other).__name__)
            )
        if other.currency != self.currency or other.scale != self.scale:
            raise MoneyCurrencyMismatch(
                "%s across units: %s/scale%d vs %s/scale%d"
                % (op, self.currency, self.scale, other.currency, other.scale)
            )
        return other

    def __add__(self, other: "Money") -> "Money":
        other = self._require_same_unit(other, "add")
        return Money(self.currency, self.amount_minor + other.amount_minor, self.scale)

    def __sub__(self, other: "Money") -> "Money":
        other = self._require_same_unit(other, "sub")
        return Money(self.currency, self.amount_minor - other.amount_minor, self.scale)

    def __neg__(self) -> "Money":
        return Money(self.currency, -self.amount_minor, self.scale)

    # Ordering raises on mixed units; __eq__/__hash__ stay the
    # dataclass-generated field comparisons (never raise — different
    # currency or scale is simply unequal).

    def __lt__(self, other: "Money") -> bool:
        return self.amount_minor < self._require_same_unit(other, "compare").amount_minor

    def __le__(self, other: "Money") -> bool:
        return self.amount_minor <= self._require_same_unit(other, "compare").amount_minor

    def __gt__(self, other: "Money") -> bool:
        return self.amount_minor > self._require_same_unit(other, "compare").amount_minor

    def __ge__(self, other: "Money") -> bool:
        return self.amount_minor >= self._require_same_unit(other, "compare").amount_minor

    def is_zero(self) -> bool:
        return self.amount_minor == 0
