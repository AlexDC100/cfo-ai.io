"""HTTP API — n8n posts to /run-daily, gets the JSON contract back."""

from .server import create_app

__all__ = ["create_app"]
