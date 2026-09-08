// RADAR STRIP — one line on the dashboard saying what the scan found.
//
// ── WHY IT IS A SUMMARY AND NOT A PANEL ─────────────────────────────────
//
// The dashboard ALREADY renders `<FindingsPanel>` over the period's
// persisted alerts (`FinancialStatements.tsx`, the contract path). Adding
// a second findings panel beside it — reading a different source, ranked
// by a different cap — would put two answers to "what is wrong with this
// book" on one screen, and a reader with two answers has none.
//
// So this strip states COUNTS and hands over. It never restates a
// finding: the finding lives on `/radar`, rendered by the same
// `FindingsPanel` the statements page uses, so a finding looks identical
// wherever a reader meets it.
//
// ── WHAT IT RENDERS WHEN THERE IS NOTHING ───────────────────────────────
//
// Nothing at all, in three cases, and the distinction matters:
//
//   · the feature is not `active` in the registry — the surface does not
//     exist for this workspace and a strip advertising it would be a dead
//     affordance;
//   · the engine answers 404 — `ANOMALY_RADAR_ENABLED` is unset, so
//     NOTHING HAS LOOKED at this book. Rendering "0 findings" there would
//     tell the reader their book is clean when nothing scanned it, which
//     is the one substitution this product exists to refuse;
//   · the query has not resolved.
//
// A scan that RAN and found nothing does render — as "no findings", which
// is a measurement and reads as one.

import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import { useActivePeriod } from "@/lib/activePeriod";
import { cfoApi } from "@/lib/cfoApi";
import { useFeatureStatus } from "@/lib/features";

interface RadarCounts {
  surfaced: number;
  bySeverity: Record<string, number>;
  cap: number | null;
  heldBack: number;
}

function readCounts(payload: unknown): RadarCounts | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (!Array.isArray(p.surfaced)) return null;
  const bySeverity: Record<string, number> = {};
  for (const row of p.surfaced as Array<Record<string, unknown>>) {
    const sev =
      typeof row.effective_severity === "string"
        ? row.effective_severity
        : typeof row.severity === "string"
          ? row.severity
          : "unknown";
    bySeverity[sev] = (bySeverity[sev] ?? 0) + 1;
  }
  const counts = (p.counts ?? {}) as Record<string, unknown>;
  return {
    surfaced: p.surfaced.length,
    bySeverity,
    cap: typeof p.cap === "number" ? p.cap : null,
    heldBack: typeof counts.held_back === "number" ? counts.held_back : 0,
  };
}

/** Severity order as a reader reads it, not as an object iterates. */
const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"];

export function RadarStrip({ className = "" }: { className?: string }) {
  const { t } = useTranslation();
  const period = useActivePeriod();
  const status = useFeatureStatus("anomaly_radar");
  const active = status === "active";

  const query = useQuery({
    queryKey: ["radar", period.id],
    queryFn: () => cfoApi.radar(period.id as string),
    enabled: active && !!period.id,
    refetchOnWindowFocus: false,
    retry: false,
  });

  if (!active || !period.id) return null;
  if (query.isPending || query.isError) return null;

  const counts = readCounts(query.data);
  if (!counts) return null;

  const severities = SEVERITY_ORDER.filter((s) => counts.bySeverity[s]);

  return (
    <section
      data-testid="radar-strip"
      data-radar-surfaced={counts.surfaced}
      className={`flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-rule bg-surface px-4 py-3 ${className}`}
    >
      <span className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
        {t("radar.strip.eyebrow", "Radar")}
      </span>

      {counts.surfaced === 0 ? (
        <span className="text-[13px] text-ink-soft">
          {t("radar.strip.clear", "Scanned — nothing surfaced.")}
        </span>
      ) : (
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink">
          {severities.map((sev) => (
            <span key={sev} data-testid={`radar-strip-${sev}`} className="tabular-nums">
              <b className="font-semibold">{counts.bySeverity[sev]}</b>{" "}
              <span className="text-ink-soft">{t(`radar.severity.${sev}`, sev)}</span>
            </span>
          ))}
        </span>
      )}

      {counts.heldBack > 0 ? (
        <span
          data-testid="radar-strip-held"
          className="text-[12px] text-ink-mute"
          // The cap is the reader's attention budget. Saying how many rows
          // it withheld is what keeps "7 findings" from reading as "7
          // problems exist".
          title={t(
            "radar.strip.heldTitle",
            "The cap surfaces the highest-ranked findings; the rest are on the Radar page.",
          )}
        >
          {t("radar.strip.held", "{{count}} held back by the cap", {
            count: counts.heldBack,
          })}
        </span>
      ) : null}

      <Link
        to={`/radar?period=${encodeURIComponent(period.id)}`}
        data-testid="radar-strip-link"
        className="ml-auto font-mono text-[11px] uppercase tracking-wider text-brand transition-colors hover:text-brand-dark"
      >
        {t("radar.strip.open", "Open Radar")}
      </Link>
    </section>
  );
}

export default RadarStrip;
