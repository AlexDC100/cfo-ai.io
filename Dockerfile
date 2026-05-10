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
      "pyarrow>=15.0" \
      "python-multipart>=0.0.20"

# Copy source + the canonical workbook + config
COPY src/ ./src/
COPY config.yaml ./
COPY files/ ./files/

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
