# Backend image — FastAPI engine.
# Runs on port 8000 inside the docker network. Caddy reverse-proxies to it.

FROM python:3.11-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

# System deps for pyarrow (parquet) and openpyxl
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential libffi-dev \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency manifest first so this layer caches across code changes
COPY pyproject.toml ./
RUN pip install \
      "pandas>=2.0" \
      "pydantic>=2.0" \
      "pyyaml>=6.0" \
      "openpyxl>=3.1" \
      "sqlalchemy>=2.0" \
      "fastapi>=0.110" \
      "uvicorn[standard]>=0.27" \
      "anthropic>=0.30" \
      "stripe>=8.0" \
      "pyarrow>=15.0" \
      "python-multipart>=0.0.20"

# Copy source + the canonical workbook + config
COPY src/ ./src/
COPY config.yaml ./
COPY files/ ./files/
# F4.2 — methodology YAML files (declarative EBITDA + ratio recipes).
# Required at runtime by engine.methodology.loader.load_methodology().
COPY methodology/ ./methodology/
# F3.16-3b.6-A (2026-05-26) — regression gates live alongside engine
# code. Pre-3b.6-A these were available in the running container only
# because of leftover docker-cp residue; the first clean rebuild
# wiped them and surfaced the gap. Adding here so future rebuilds
# carry the F4.2-PARITY / F-A3.1 / F-A3.2 / F-A3.3 gate scripts
# without manual docker-cp's. Sibling _pgrst_visibility helper +
# measure_bs_drift fixtures all live in scripts/.
COPY scripts/ ./scripts/
# F3.16-3b.2 — EEI JSON fixture source-of-truth lives in the FE tree
# (`scandi-desk-main/e2e/fixtures/...`) which is excluded by
# .dockerignore. To make the F-A3.2-CROSS-PATH gate run GREEN on EEI
# in-container, the fixture is also kept at `files/eei_expected_extraction.json`
# (already inside the build context). `files/` COPY above grabs it.
# Both copies must stay in sync — if the FE fixture changes,
# re-copy via: `cp scandi-desk-main/e2e/fixtures/.../expected_extraction.json files/eei_expected_extraction.json`

# Install the engine package itself so `python -m engine` resolves
RUN pip install -e .

# Persistent SQLite lives here (mounted as a named volume in compose)
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 8000

# Single CMD — Caddy is the public-facing TLS terminator, so we bind to 0.0.0.0
# inside the docker network only.
CMD ["python", "-m", "engine", "serve", \
     "--config", "/app/config.yaml", \
     "--canonical-excel", "/app/files/Trading_analysis_YTDOct'25_LV.xlsx", \
     "--host", "0.0.0.0", \
     "--port", "8000", \
     "--db-url", "sqlite:////app/data/engine.db"]
