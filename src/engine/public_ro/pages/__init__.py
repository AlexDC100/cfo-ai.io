"""engine.public_ro.pages — server-rendered public HTML surfaces.

FastAPI-rendered HTML via python string templates (repo precedent:
board_report_renderer) — NO jinja2, inline CSS, zero JS except the one
inline beacon owned by the shell template. Modules:

  - templates.py — page_shell(...) + shared fragments (lane 3)
  - company.py   — per-CUI public summary pages (lane 3)
  - hubs.py      — sector / county hub pages + directory indexes (lane 4)
"""
