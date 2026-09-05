"""pytest plugin: NO OUTBOUND SOCKET may be opened by a test run.

Usage:  python -m pytest tests/engine -q -p netblock

Referenced by design_review/firm/GATES.md ("every pytest run below with
`-p netblock` (any outbound socket connect raises)") but never committed —
on 2026-09-05 no module of this name existed anywhere in the tree or its
history, so the documented verification line raised ImportError. This is
the plugin those lines describe, at the only path ``-p netblock`` can
import from under ``python -m pytest`` (the repo root is sys.path[0]).

What it does, for the whole session:

  · ``socket.getaddrinfo`` for any host that is not loopback raises
    ``socket.gaierror`` — DNS never leaves the machine either.
  · ``socket.socket.connect`` / ``connect_ex`` / ``socket.create_connection``
    to any non-loopback, non-UNIX address raise ``OSError``.

Loopback (127.0.0.0/8, ::1, "localhost") and AF_UNIX stay open on purpose:
they are not egress, and a test that starts a local server is entitled to
reach it. Every refusal is RECORDED on ``netblock.ATTEMPTS`` so a suite
can assert the count is zero, and each refusal message names the address.

A test that patches the socket functions itself (the public egress gate
does, to record rather than merely refuse) layers over this and restores
to it — the two compose.
"""

from __future__ import annotations

import functools
import socket
from typing import Any, List

ATTEMPTS: List[str] = []

_LOOPBACK_NAMES = {"localhost", "localhost.localdomain", "testserver", "::1", "0.0.0.0", "::"}


def _is_loopback(host: Any) -> bool:
    if host is None:
        return True
    if isinstance(host, bytes):
        host = host.decode("ascii", "replace")
    h = str(host).strip("[]").lower()
    if h in _LOOPBACK_NAMES or h.startswith("127."):
        return True
    if h.startswith("::ffff:127."):
        return True
    return False


def _host_of_address(address: Any) -> Any:
    if isinstance(address, (tuple, list)) and address:
        return address[0]
    if isinstance(address, (str, bytes)):
        return None          # AF_UNIX path — not egress
    return address


def _install() -> None:
    real_gai = socket.getaddrinfo
    real_connect = socket.socket.connect
    real_connect_ex = socket.socket.connect_ex
    real_create = socket.create_connection

    @functools.wraps(real_gai)
    def _gai(host, port, *a, **kw):
        if _is_loopback(host):
            return real_gai(host, port, *a, **kw)
        ATTEMPTS.append("getaddrinfo:%s:%s" % (host, port))
        raise socket.gaierror(-2, "NETBLOCK: outbound DNS refused for %s:%s" % (host, port))

    @functools.wraps(real_connect)
    def _connect(self, address):
        if self.family == getattr(socket, "AF_UNIX", object()) or _is_loopback(_host_of_address(address)):
            return real_connect(self, address)
        ATTEMPTS.append("connect:%r" % (address,))
        raise OSError("NETBLOCK: outbound connect refused: %r" % (address,))

    @functools.wraps(real_connect_ex)
    def _connect_ex(self, address):
        if self.family == getattr(socket, "AF_UNIX", object()) or _is_loopback(_host_of_address(address)):
            return real_connect_ex(self, address)
        ATTEMPTS.append("connect_ex:%r" % (address,))
        raise OSError("NETBLOCK: outbound connect refused: %r" % (address,))

    @functools.wraps(real_create)
    def _create(address, *a, **kw):
        if _is_loopback(_host_of_address(address)):
            return real_create(address, *a, **kw)
        ATTEMPTS.append("create_connection:%r" % (address,))
        raise OSError("NETBLOCK: outbound connect refused: %r" % (address,))

    # functools.wraps on purpose: each wrapper carries the wrapped function's
    # __module__ / __name__ / __wrapped__, so a gate that checks "the real
    # socket function is in place" (test_public_market_gates PM5) sees a socket
    # function with a decorator on it, which is what it is.
    socket.getaddrinfo = _gai              # type: ignore[assignment]
    socket.socket.connect = _connect       # type: ignore[assignment]
    socket.socket.connect_ex = _connect_ex  # type: ignore[assignment]
    socket.create_connection = _create     # type: ignore[assignment]


def pytest_configure(config):
    _install()
    config.addinivalue_line(
        "markers", "netblock: this session refuses every outbound socket (plugin netblock)")


def pytest_terminal_summary(terminalreporter, exitstatus, config):
    if ATTEMPTS:
        terminalreporter.write_line(
            "netblock: REFUSED %d outbound socket attempt(s): %s"
            % (len(ATTEMPTS), sorted(set(ATTEMPTS))[:20]))
    else:
        terminalreporter.write_line("netblock: 0 outbound socket attempts")
