"""OG images for public company pages — Pillow, 1200x630, deterministic.

Font choice (documented per the mission brief): NO new binary assets are
shipped. Pillow >= 10.1 embeds a scalable default font served through
``ImageFont.load_default(size=...)`` (the repo lock pins pillow==11.3.0,
where this returns a FreeTypeFont); the bytes are therefore deterministic
per (inputs, Pillow version) — exactly the invariant the determinism test
pins. On an exotic build without FreeType we fall back to the bitmap
default font (still deterministic, just small); we deliberately do NOT
probe OS font paths, because /Library vs /usr/share fonts would make the
PNG host-dependent.

Disk cache: data/public_og/ (override: PUBLIC_RO_OG_DIR), keyed by
(cui, year, dataset_version) — a new dataset version is a new file, so
stale images are never served for fresh data.
"""
from __future__ import annotations

import io
import os
import re
import threading
from pathlib import Path
from typing import Any, Dict, Optional

WIDTH, HEIGHT = 1200, 630

_ENV_OG_DIR = "PUBLIC_RO_OG_DIR"
_DEFAULT_OG_DIR = Path("data") / "public_og"

_BG = (11, 22, 38)         # navy canvas (product dark)
_TEAL = (20, 184, 166)
_FG = (240, 245, 249)
_MUT = (150, 166, 184)

_lock = threading.Lock()


def og_dir(path: Optional[Path] = None) -> Path:
    if path is not None:
        return Path(path)
    override = os.environ.get(_ENV_OG_DIR)
    return Path(override) if override else _DEFAULT_OG_DIR


def _font(size: int):
    from PIL import ImageFont

    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # pragma: no cover — pre-10.1 Pillow (not in lock)
        return ImageFont.load_default()


def _truncate(draw, text: str, font, max_width: int) -> str:
    if draw.textlength(text, font=font) <= max_width:
        return text
    while text and draw.textlength(text + "…", font=font) > max_width:
        text = text[:-1]
    return text + "…"


def render_og_png(
    *,
    name: str,
    cui: int,
    year: int,
    kpis: Dict[str, Optional[str]],
    lang: str = "ro",
) -> bytes:
    """Compose the 1200x630 card. ``kpis`` maps display label -> already
    formatted display value (None values are skipped) — formatting stays
    in model.py so the PNG and the HTML can never disagree."""
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (WIDTH, HEIGHT), _BG)
    draw = ImageDraw.Draw(img)

    # teal accent bar, left edge
    draw.rectangle([0, 0, 14, HEIGHT], fill=_TEAL)

    f_name = _font(64)
    f_meta = _font(30)
    f_lbl = _font(24)
    f_val = _font(44)
    f_mark = _font(28)

    x = 70
    draw.text((x, 80), _truncate(draw, name, f_name, WIDTH - x - 60),
              font=f_name, fill=_FG)
    draw.text((x, 170), "CUI %d · %d" % (int(cui), int(year)),
              font=f_meta, fill=_MUT)

    y = 280
    for label, value in kpis.items():
        if value is None:
            continue
        draw.text((x, y), label, font=f_lbl, fill=_MUT)
        draw.text((x, y + 32), value, font=f_val, fill=_FG)
        y += 110
        if y > HEIGHT - 140:
            break

    # wordmark, bottom-right
    mark = "CFO AI · cfo-ai.io"
    w = draw.textlength(mark, font=f_mark)
    draw.text((WIDTH - w - 50, HEIGHT - 70), mark, font=f_mark, fill=_TEAL)

    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def _safe_token(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", s)[:80] or "0"


def cached_og_png(
    *,
    name: str,
    cui: int,
    year: int,
    dataset_version: str,
    kpis: Dict[str, Optional[str]],
    lang: str = "ro",
    directory: Optional[Path] = None,
) -> bytes:
    """Disk-cached render keyed by (cui, year, dataset_version, lang)."""
    d = og_dir(directory)
    fname = "%d-%d-%s-%s.png" % (int(cui), int(year),
                                 _safe_token(str(dataset_version)), lang)
    path = d / fname
    try:
        return path.read_bytes()
    except OSError:
        pass
    data = render_og_png(name=name, cui=cui, year=year, kpis=kpis, lang=lang)
    with _lock:
        try:
            d.mkdir(parents=True, exist_ok=True)
            tmp = path.with_name(".tmp-" + fname)
            tmp.write_bytes(data)
            os.replace(tmp, path)
        except OSError:  # pragma: no cover — cache write is best-effort
            pass
    return data
