// THE CAPSULE — the snapshot hook.
//
// The ONE place that reads live app state for the suggestion engine. It
// exists so `lib/capsuleSuggestions.ts` can stay a pure function of its
// arguments: everything impure (React Query, the router's `?period=`,
// the served gateway, the active locale) is gathered here and handed
// down as flat primitives.
//
// Reads, and only reads:
//   · `useActivePeriod()`  — the period, its alerts (the contract rows)
//                            and its server-computed metrics
//   · `usePeriodStepper()` — the workspace's period list, for the
//                            unattached prompt
//   · `lib/servedFacts`    — the balance verdict, through the ONE
//                            sanctioned gateway (the import-boundary
//                            gate enforces this; nothing here touches
//                            `statements.canonical_bs` directly)
//   · `lib/findings`       — the contract report, demote-only
//
// No writes, no fetches of its own, no model call.

import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { useActivePeriod } from "@/lib/activePeriod";
import { usePeriodStepper } from "@/lib/usePeriodStepper";
import { useActiveLocale } from "@/lib/locale";
import { formatPeriodMonth } from "@/lib/orgPeriods";
import { factsFrom } from "@/lib/servedFacts";
import { buildFindingsReport } from "@/lib/findings";
import {
  EMPTY_SNAPSHOT,
  pickLabel,
  seedFindings,
  type CapsuleMetricSeed,
  type CapsuleUnattachedPeriod,
  type CapsuleWorkspaceSnapshot,
} from "@/lib/capsuleSuggestions";

export interface CapsuleSnapshotResult {
  snapshot: CapsuleWorkspaceSnapshot;
  /** The engine presenter's own verdict wording in the active language,
   *  passed through verbatim. Null when there is no verdict. */
  trustLabel: string | null;
}

export function useCapsuleSnapshot(): CapsuleSnapshotResult {
  const { i18n } = useTranslation();
  const period = useActivePeriod();
  const { periods } = usePeriodStepper();
  const locale = useActiveLocale();
  const isRo = (i18n.language ?? "en").toLowerCase().startsWith("ro");

  // ONE report per rows identity — `buildFindingsReport` parses and ranks
  // every contract row, so building it twice for two derived values would
  // double that work on every render of an open palette.
  const { findings, silence } = useMemo(() => {
    const report = buildFindingsReport(period.alerts);
    return {
      findings: seedFindings(report),
      // Silence is a RESULT: the contract ran, produced checks, and
      // surfaced nothing. A period with no contract rows at all is not
      // silent — it is unanalysed, and says so elsewhere.
      silence:
        report.hasContractRows && report.surfaced.length === 0 && report.silence !== null,
    };
  }, [period.alerts]);

  const trust = useMemo(() => {
    if (!period.statements) return { band: null, label: null };
    const facts = factsFrom(period.statements);
    // The TrustChip render-nothing rule: a legacy or public-summary lane
    // carries no verdict, so it gets no band and no wording.
    if (!facts.isCanonical) return { band: null, label: null };
    const presentation = facts.presentStatus(period.statements.currency ?? "RON");
    return {
      band: presentation.band,
      // Guarded like every other label: a presenter string carrying a
      // figure would put an unprovenanced amount in the palette.
      label: pickLabel([isRo ? presentation.displayRo : presentation.displayEn]),
    };
  }, [period.statements, isRo]);

  const unattached = useMemo<CapsuleUnattachedPeriod[]>(() => {
    const out: CapsuleUnattachedPeriod[] = [];
    for (const p of periods) {
      // Zero documents is the unambiguous case: the period container
      // exists but nothing was ever uploaded into it. A period holding
      // only a Products dataset is deliberately NOT counted — that is a
      // partial-coverage question, not a missing-file one.
      if ((p.documents?.length ?? 0) > 0) continue;
      const label = pickLabel([formatPeriodMonth(p.period_end, locale), p.period_label]);
      if (!label) continue;
      out.push({ periodId: p.period_id, label });
    }
    return out;
  }, [periods, locale]);

  const metrics = useMemo<CapsuleMetricSeed[]>(
    () =>
      period.metrics.map((m) => ({
        name: m.name,
        value: m.value,
        unit: m.unit,
      })),
    [period.metrics],
  );

  const snapshot = useMemo<CapsuleWorkspaceSnapshot>(() => {
    if (!period.id || period.notFound) {
      // No period, or a stale URL — the workspace list is still real, so
      // the unattached prompt survives; nothing else does.
      return { ...EMPTY_SNAPSHOT, unattached };
    }
    return {
      hasPeriod: true,
      periodLabel: pickLabel([formatPeriodMonth(period.periodEnd, locale), period.label]),
      trustBand: trust.band,
      findings,
      silence,
      metrics,
      unattached,
    };
  }, [
    period.id,
    period.notFound,
    period.periodEnd,
    period.label,
    locale,
    trust.band,
    findings,
    silence,
    metrics,
    unattached,
  ]);

  return { snapshot, trustLabel: trust.label };
}
