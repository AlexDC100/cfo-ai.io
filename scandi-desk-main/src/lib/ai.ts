// AI analysis adapter — calls the Python engine backend's /api/analyze.
// Previously hit a Supabase function; we keep the same function signature
// so callers don't need to change.

import type { DailyRun } from "@/data/dailyRun";
import type { RawSkuRow, EngineConfig } from "@/lib/engine";
import type { Analysis } from "@/lib/runStore";
import { analyzeRunOnBackend, rawRowsToBackend } from "@/lib/api";

export async function analyzeRun(
  run: DailyRun,
  fileName?: string,
  rowCount?: number,
  rows?: RawSkuRow[],
  _cfg?: EngineConfig,
): Promise<Analysis> {
  // Forward raw rows so the backend can drill into ELIMINATE/WARNING categories
  // and surface specific SKU-level removal recommendations.
  return analyzeRunOnBackend(
    run,
    fileName,
    rowCount,
    "en",
    rows ? rawRowsToBackend(rows) : undefined,
  );
}
