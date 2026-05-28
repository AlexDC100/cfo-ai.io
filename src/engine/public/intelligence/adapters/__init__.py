"""Signal-feed adapters.

Provider-agnostic per brief §6: every signal source — manual paste, RSS,
news API, commodity feed, rates feed — implements the SignalAdapter
Protocol. When an adapter's env var isn't set, the adapter returns
configured=False and the routes surface that state instead of fabricating
data. Per brief §21: "Do not show fake live news."
"""

from .base import AdapterHealth, SignalAdapter
from .manual_signal_adapter import ManualSignalAdapter

__all__ = ["AdapterHealth", "SignalAdapter", "ManualSignalAdapter"]
