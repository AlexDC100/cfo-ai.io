// RADAR — the ranked findings for the loaded period, on screen.
//
// The third "complete and unreachable" surface this session found.
// `src/engine/api/_radar.py` had four routes, a dismissal lane and an
// explanation lane, and was referenced nowhere in `server.py`;
// `components/cfo/findings/` had a whole rendering library —
// FindingsPanel, FindingCard, EvidenceLine, ThresholdMeter,
// AllChecksList, SilenceCard — and no page mounted it over a radar
// payload. Both halves finished, joined to nothing.
//
// ── WHY THIS PAGE IS SHORT ──────────────────────────────────────────────
//
// Because it should be. `buildFindingsReport` in `lib/findings.ts` already
// parses exactly the shape the engine serves (`surfaced` / `info` /
// `demoted` / `checks` / the cap decision / the materiality basis), and
// `<FindingsPanel>` already renders it — the same component the statements
// page mounts, so a finding looks identical wherever a reader meets it.
// Anything longer than this would be a second renderer, and this repo has
// already paid for a second renderer four times.
//
// ── THE PART THAT IS NOT DELEGATED ──────────────────────────────────────
//
// The 404. `/api/radar/*` is mounted only when `ANOMALY_RADAR_ENABLED` is
// truthy on the engine, which is its state nowhere today. A page that
// rendered "no findings" over that 404 would tell the reader their book is
// clean when nothing has looked at it — the difference between "measured
// and clear" and "not measured" is the one this whole product is built to
// keep. So the surface-absent case is a NAMED state with its own copy, not
// an empty list.

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";

import { FindingsPanel } from "@/components/cfo/findings";
import { PageHeader as InstrumentPageHeader, Chip } from "@/components/instrument/Panel";
import { PageHeader } from "@/components/cfo/ui/PageHeader";
import { useActivePeriod } from "@/lib/activePeriod";
import { cfoApi, CfoApiError } from "@/lib/cfoApi";
import { buildFindingsReport } from "@/lib/findings";

/** The lane a row came from, as the payload states it. Surfaced so a
 *  reader can tell an engine rule from a pack-declared detector without
 *  reading the rule id — they are different kinds of claim and the
 *  payload has always said which. */
function laneCounts(payload: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const rows =
    payload && typeof payload === "object" && Array.isArray((payload as { surfaced?: unknown[] }).surfaced)
      ? ((payload as { surfaced: unknown[] }).surfaced as Array<{ lane?: unknown }>)
      : [];
  for (const row of rows) {
    const lane = typeof row.lane === "string" ? row.lane : "unknown";
    out[lane] = (out[lane] ?? 0) + 1;
  }
  return out;
}

export default function Radar() {
  const { t } = useTranslation();
  const period = useActivePeriod();

  const query = useQuery({
    queryKey: ["radar", period.id],
    queryFn: () => cfoApi.radar(period.id as string),
    enabled: !!period.id,
    // The payload is deterministic in its inputs and the engine caches it
    // on its own key; refetching on focus spends a request to be told the
    // same thing.
    refetchOnWindowFocus: false,
    retry: false,
  });

  const report = useMemo(
    () => (query.data ? buildFindingsReport(query.data) : null),
    [query.data],
  );
  const lanes = useMemo(() => laneCounts(query.data), [query.data]);

  if (!period.id) {
    return (
      <PageHeader
        eyebrow={t("radar.eyebrow", "Radar")}
        title={t("radar.empty.title", "Load a period to scan")}
        subtitle={t(
          "radar.empty.subtitle",
          "Radar reads one period against the periods before it. Upload or open a period and the scan opens with it.",
        )}
      />
    );
  }

  const status = query.error instanceof CfoApiError ? query.error.status : null;
  // 404 IS NOT "NOTHING FOUND". The surface is mounted behind a flag, and
  // an unmounted route must never render as a clean book.
  const surfaceAbsent = status === 404;

  return (
    <div className="space-y-4 pb-16">
      <InstrumentPageHeader
        eyebrow={t("radar.eyebrow", "Radar")}
        title={t("radar.title", "Findings")}
        context={
          period.label ? <Chip>{period.label}</Chip> : null
        }
      />

      {query.isPending ? (
        <p className="px-1 text-[13px] text-ink-mute" data-testid="radar-loading">
          {t("radar.loading", "Scanning…")}
        </p>
      ) : null}

      {surfaceAbsent ? (
        <div
          data-testid="radar-surface-absent"
          className="rounded-xl border border-rule bg-surface px-4 py-3 text-[13px] leading-snug"
        >
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
            {t("radar.absent.eyebrow", "Not scanned")}
          </span>
          <p className="mt-1 text-ink-soft">
            {t(
              "radar.absent.body",
              "Radar is not enabled for this workspace, so nothing has looked at this period. That is different from a clean book, and this page will not show one until a scan has actually run.",
            )}
          </p>
        </div>
      ) : null}

      {query.isError && !surfaceAbsent ? (
        <div
          data-testid="radar-error"
          className="rounded-xl border border-rule bg-surface px-4 py-3 text-[13px] leading-snug"
        >
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
            {t("radar.failed", "Scan unavailable")}
          </span>
          <p className="mt-1 text-ink-soft" data-testid="radar-error-detail">
            {(query.error as Error)?.message}
          </p>
        </div>
      ) : null}

      {report ? (
        <>
          <div className="flex flex-wrap items-center gap-2" data-testid="radar-lanes">
            {Object.entries(lanes)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([lane, count]) => (
                <Chip key={lane}>
                  {t(`radar.lane.${lane}`, lane.replace(/_/g, " "))} · {count}
                </Chip>
              ))}
          </div>
          <FindingsPanel report={report} currency={period.statements?.currency} />
        </>
      ) : null}
    </div>
  );
}
