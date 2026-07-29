// DioPersistenceBanner — surfaces backend's "DIO silently dropped" state.
//
// 2026-05-26 — the upload pipeline's defensive retry path silently
// dropped every DIO value when sku_aggregates lacked the columns, and
// the warning log scrolled past unnoticed for weeks. The backend
// exposes the degraded state on /api/health under
// `checks.dio_persistence` (degraded: true | false plus diagnostics).
// This banner polls the endpoint every 60s and surfaces a loud red
// callout on the Products page when degradation is live, with the
// exact remediation step. Clears automatically when the next upload
// succeeds without a drop.
//
// Render policy: ONLY shown on /products. Other surfaces don't depend
// on DIO and the banner would be noise there. Auto-hides when ok.

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";

interface HealthDioPersistence {
  ok: boolean;
  degraded?: boolean;
  reason?: string;
  last_drop_at?: string | null;
  last_dataset_id?: string | null;
  total_rows_dropped?: number;
  drop_event_count?: number;
}

interface HealthResponse {
  ok: boolean;
  checks?: {
    dio_persistence?: HealthDioPersistence;
  };
}

async function fetchHealth(): Promise<HealthResponse | null> {
  const apiUrl =
    (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";
  try {
    const res = await fetch(`${apiUrl}/api/health`, { cache: "no-store" });
    return (await res.json()) as HealthResponse;
  } catch {
    return null;
  }
}

export function DioPersistenceBanner() {
  // 60s poll — fast enough that operator running the migration sees
  // the banner disappear without a manual refresh, slow enough that
  // /api/health (which pings DB + Stripe + FX) doesn't hammer prod.
  const { data } = useQuery({
    queryKey: ["health", "dio-persistence"],
    queryFn: fetchHealth,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
  });
  const state = data?.checks?.dio_persistence;
  if (!state || !state.degraded) return null;

  const lastDropAgo = state.last_drop_at
    ? humanizeAgo(state.last_drop_at)
    : null;

  return (
    <section
      data-testid="dio-persistence-banner"
      className="
        rounded-2xl border-2 border-red-400/60 bg-red-50/70 dark:bg-red-500/[0.08]
        px-5 py-4 mb-4
      "
    >
      <div className="flex items-start gap-3">
        <AlertTriangle
          size={18}
          strokeWidth={2}
          className="text-red-700 dark:text-red-300 shrink-0 mt-0.5"
        />
        <div className="flex-1 min-w-0 space-y-2">
          <h3 className="text-[14px] font-semibold text-red-900 dark:text-red-100">
            DIO data dropped on recent upload
          </h3>
          <p className="text-[12.5px] text-red-900/85 dark:text-red-100/85 leading-relaxed">
            The <code className="font-mono text-[11.5px] bg-red-100/60 dark:bg-red-500/20 px-1 rounded">sku_aggregates</code> table is
            missing the DIO columns. Uploads are succeeding but the parsed DIO values
            are being silently discarded on insert — that's why every category card
            shows <span className="font-mono">—</span> instead of real DIO days.
          </p>
          <p className="text-[12.5px] text-red-900/85 dark:text-red-100/85 leading-relaxed">
            <strong>Fix:</strong> run{" "}
            <code className="font-mono text-[11.5px] bg-red-100/60 dark:bg-red-500/20 px-1 rounded">
              supabase/schema_phase_sku_dio_columns.sql
            </code>{" "}
            in Supabase Studio (one-shot, idempotent). Then re-classify the active
            dataset in the Datasets panel — backend will re-extract DIO from the
            source XLSX and this banner will disappear within 60s.
          </p>
          <details className="text-[11.5px] text-red-900/70 dark:text-red-100/70">
            <summary className="cursor-pointer font-medium">Diagnostics</summary>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 mt-2 font-mono">
              {lastDropAgo && (
                <>
                  <dt>Last drop:</dt>
                  <dd>{lastDropAgo}</dd>
                </>
              )}
              {state.total_rows_dropped != null && (
                <>
                  <dt>Total rows dropped:</dt>
                  <dd className="tabular-nums">{state.total_rows_dropped.toLocaleString("en-US")}</dd>
                </>
              )}
              {state.drop_event_count != null && (
                <>
                  <dt>Drop events:</dt>
                  <dd className="tabular-nums">{state.drop_event_count}</dd>
                </>
              )}
              {state.last_dataset_id && (
                <>
                  <dt>Last affected dataset:</dt>
                  <dd className="truncate">{state.last_dataset_id}</dd>
                </>
              )}
            </dl>
          </details>
        </div>
      </div>
    </section>
  );
}

function humanizeAgo(iso: string): string {
  try {
    const then = new Date(iso).getTime();
    const now = Date.now();
    const seconds = Math.floor((now - then) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  } catch {
    return iso;
  }
}
