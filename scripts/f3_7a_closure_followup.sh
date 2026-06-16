#!/usr/bin/env bash
# F3.7a Option A — closure follow-up commands (SSH/VPS).
# Run as a single block after operator authorization in chat.
#
# Steps performed:
#   C. Briefing regeneration for EEI + Scandia Food + Scandia Sibiu
#   D. Register Scandia Sibiu in calibration_fixtures + write
#      calibration_results rows for v2.1+f3.7a engine version
#   E. Final gate sweep against VPS engine container
#
# Pre-condition: A1 destructive re-process already completed.
# Live API for the 3 periods reflects post-fix engine state.
# Period IDs from operator's session log:
#   EEI:            cb0c30f6
#   Scandia Food:   57f52f21
#   Scandia Sibiu:  92788026

set -euo pipefail

VPS_HOST="root@187.124.0.37"
SSH_KEY="$HOME/.ssh/scandia_vps_ed25519"
SSH="ssh -i ${SSH_KEY} ${VPS_HOST}"

EEI_PERIOD_ID="cb0c30f6"
SCANDIA_FOOD_PERIOD_ID="57f52f21"
SCANDIA_SIBIU_PERIOD_ID="92788026"
ENGINE_VERSION="v2.1+f3.7a"

echo "============================================================"
echo "F3.7a Option A — closure follow-up"
echo "============================================================"

# ─────────────────────────────────────────────────────────────
# Step C — Briefing regeneration for all 3 periods
# ─────────────────────────────────────────────────────────────
echo ""
echo "Step C — Briefing regeneration"
echo "------------------------------------------------------------"

for PERIOD_ID in "${EEI_PERIOD_ID}" "${SCANDIA_FOOD_PERIOD_ID}" "${SCANDIA_SIBIU_PERIOD_ID}"; do
  echo "  Regenerating briefing for period ${PERIOD_ID}..."
  $SSH "curl -sS -X POST http://127.0.0.1:8000/api/period/${PERIOD_ID}/briefing/regenerate \
    -H 'Content-Type: application/json' \
    --max-time 120" \
    | python3 -c "import sys, json; r = json.loads(sys.stdin.read()); print(f'    status={r.get(\"status\",\"?\")} briefing_id={r.get(\"briefing_id\",\"?\")}')"
done

# ─────────────────────────────────────────────────────────────
# Step D — Register Scandia Sibiu fixture + calibration_results
# ─────────────────────────────────────────────────────────────
echo ""
echo "Step D — Calibration fixture + results registration"
echo "------------------------------------------------------------"

$SSH "docker exec cfo-ai-backend python3 -c '
import psycopg2, os
from datetime import datetime

conn = psycopg2.connect(os.environ[\"DATABASE_URL\"])
cur = conn.cursor()

# Insert Scandia Sibiu calibration fixture (idempotent on coa_key+display_name)
cur.execute(\"\"\"
  INSERT INTO calibration_fixtures (coa_key, country_code, display_name, industry_key, provenance, created_at)
  VALUES (%s, %s, %s, %s, %s, NOW())
  ON CONFLICT (coa_key, display_name) DO NOTHING
  RETURNING id
\"\"\", (\"omfp_1802\", \"RO\", \"Scandia Sibiu FY2019\", \"hospitality_food_service\",
       \"operator-sourced WinMENTOR PDF export, F3.8c ingest, F3.7a signed-math fix\"))
row = cur.fetchone()
fixture_id = row[0] if row else None
print(f\"calibration_fixtures: Scandia Sibiu fixture_id={fixture_id}\")

# Insert calibration_results rows for v2.1+f3.7a
results = [
    # (period_id, fixture_label, drift_pct, residual_ron, notes)
    (\"${EEI_PERIOD_ID}\", \"EEI Dec 2025\", 0.0000, 0.00,
     \"byte-identical post-F3.7a; 1,529.41 RON loss vs pre-A1-retry due to F3.8c deterministic-vs-Claude precision trade-off (account 208 missed by PyMuPDF)\"),
    (\"${SCANDIA_FOOD_PERIOD_ID}\", \"Scandia Food FY2025\", 0.1389, -405878.01,
     \"signed-math fix improved drift 0.3698% to 0.1389% (62% closer to zero); 405,878 RON residual remains, separate root cause newly tracked\"),
    (\"${SCANDIA_SIBIU_PERIOD_ID}\", \"Scandia Sibiu FY2019\", None, -1073297.84,
     \"signed-math fix corrected 2.69M of 3.77M original equity inflation; 1,073,298 RON residual located at chart_of_accounts.py:869-876 defensive sign flip, F3.7b proposed fix awaiting authorization\"),
]
for period_id, label, drift, residual, notes in results:
    cur.execute(\"\"\"
      INSERT INTO calibration_results
        (period_id, fixture_label, engine_version, drift_pct, residual_ron, notes, measured_at)
      VALUES (%s, %s, %s, %s, %s, %s, NOW())
    \"\"\", (period_id, label, \"${ENGINE_VERSION}\", drift, residual, notes))
    print(f\"calibration_results: {label} drift={drift} residual={residual}\")

conn.commit()
cur.close()
conn.close()
print(\"All calibration rows committed.\")
'"

# ─────────────────────────────────────────────────────────────
# Step E — Final gate sweep against VPS engine container
# ─────────────────────────────────────────────────────────────
echo ""
echo "Step E — Final gate sweep (VPS container)"
echo "------------------------------------------------------------"

for GATE in \
  "/app/scripts/measure_bs_drift.py" \
  "/app/scripts/check_assembled_parity.py" \
  "/app/scripts/check_canonical_model.py" \
  "/app/scripts/check_detection.py" \
  "/app/scripts/check_pdf_ingester.py" \
  "/app/scripts/check_saga_contsal_parser.py"; do
  GATE_NAME=$(basename "$GATE" .py)
  echo ""
  echo "  Running: $GATE_NAME"
  $SSH "docker exec cfo-ai-backend python3 ${GATE} 2>&1 | tail -5"
done

echo ""
echo "============================================================"
echo "F3.7a Option A — closure follow-up COMPLETE"
echo "============================================================"
