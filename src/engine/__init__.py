"""SKU Decision Engine — legacy."""

__version__ = "0.1.0"

# ── identity-linked Anthropic keys (2026-08-29) ────────────────────────
# Newer Console API keys can be "identity-linked": every request must
# carry an `anthropic-workspace-id` header or the API answers 400. The
# engine constructs Anthropic clients in 13 places across 12 modules, so
# the header is injected ONCE here — the earliest import every AI lane
# shares — by wrapping the SDK constructor. Strictly env-gated: with
# ANTHROPIC_WORKSPACE_ID unset this block changes nothing, and a caller
# who passes their own default_headers keeps them (the workspace id is
# merged in only when the caller didn't set one).


def _install_anthropic_workspace_header() -> None:
    import os

    workspace = (os.environ.get("ANTHROPIC_WORKSPACE_ID") or "").strip()
    if not workspace:
        return
    try:
        import anthropic
    except Exception:  # noqa: BLE001 — SDK absent: AI lanes are dark anyway
        return
    if getattr(anthropic.Anthropic, "_cfo_workspace_wrapped", False):
        return

    original_init = anthropic.Anthropic.__init__

    def _init(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        headers = dict(kwargs.get("default_headers") or {})
        headers.setdefault("anthropic-workspace-id", workspace)
        kwargs["default_headers"] = headers
        original_init(self, *args, **kwargs)

    anthropic.Anthropic.__init__ = _init  # type: ignore[method-assign]
    anthropic.Anthropic._cfo_workspace_wrapped = True  # type: ignore[attr-defined]


_install_anthropic_workspace_header()
