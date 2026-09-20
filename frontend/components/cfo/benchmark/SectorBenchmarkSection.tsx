// "Company vs sector" — the sourced block of the /benchmark page.
//
// Prints `printSectorRows` (lib/sectorBenchmark.ts), the same printer the
// report section uses. A row is either a lawful sourced figure — company,
// range bar, median, middle half, n, FY, position, with the source line
// under the table — or a sentence saying why it is not compared. There is
// no "—" and no empty bar: absent is words.

import { createContext, useContext } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { SectorRangeBar } from "@/components/cfo/benchmark/SectorRangeBar";
import {
  fetchSectorBenchmark,
  printSectorMovements,
  printSectorRows,
  sectorContextText,
  type PrintedMovement,
  type SectorBenchmarkDoc,
} from "@/lib/sectorBenchmark";

export function useSectorBenchmark(periodId: string | null | undefined) {
  return useQuery({
    queryKey: ["sector-benchmark", periodId ?? null],
    enabled: Boolean(periodId),
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<SectorBenchmarkDoc | null> => {
      const res = await fetchSectorBenchmark(periodId as string);
      return res.kind === "ok" ? res.data : null;
    },
  });
}

/** The served sector document for the period on screen, for the ratio
 *  cards. `null` = none served: the cards say "general band". */
export const SectorBenchmarkCtx = createContext<SectorBenchmarkDoc | null>(null);

export function useSectorBenchmarkDoc(): SectorBenchmarkDoc | null {
  return useContext(SectorBenchmarkCtx);
}

function toneOf(vs: "better" | "worse" | "inside" | null): string {
  return vs === "better" ? "text-success" : vs === "worse" ? "text-alert" : "text-ink-soft";
}

function MovementList({ title, tone, items, empty }: {
  title: string; tone: string; items: PrintedMovement[]; empty: string;
}) {
  return (
    <div>
      <h3 className={`text-[10.5px] font-mono uppercase tracking-[0.08em] ${tone}`}>{title}</h3>
      {items.length === 0 ? (
        <p className="mt-1.5 text-[12px] text-ink-mute">{empty}</p>
      ) : (
        <ul className="mt-1">
          {items.map((it) => (
            <li key={it.key} className="py-1.5 border-t border-rule-soft first:border-t-0" data-testid="sector-movement-item" data-ratio-key={it.key}>
              <div className="text-[12.5px] text-ink">{it.label}</div>
              <div className="mt-0.5 text-[11.5px] text-ink-soft">
                {it.text} <span className="font-mono tabular-nums text-ink-mute">· {it.cite}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function SectorBenchmarkView({ doc }: { doc: SectorBenchmarkDoc }) {
  const { t, i18n } = useTranslation();
  const loc = i18n.language;
  const rows = printSectorRows(doc, loc);
  const moves = printSectorMovements(doc, loc);
  const refusedLabels = doc.refused.map((r) => t(`benchmarkPage.sector.refusedRatio.${r.key}`));
  return (
    <section className="mt-6 space-y-4" data-testid="sector-benchmark" data-status={doc.status}>
      <header>
        <h2 className="text-[13px] font-medium uppercase tracking-[0.08em] text-ink-soft">{t("benchmarkPage.sector.title")}</h2>
        <p className="mt-1 text-[12.5px] text-ink-2" data-testid="sector-context">{sectorContextText(doc, loc)}</p>
        {doc.status === "ok" ? <p className="mt-0.5 text-[11.5px] text-ink-mute">{t("benchmarkPage.sector.subtitle")}</p> : null}
        {doc.status === "ok" && doc.sector_disputed ? (
          <p className="mt-1 text-[11.5px] text-caution" data-testid="sector-disputed">{t("benchmarkPage.sector.disputed")}</p>
        ) : null}
      </header>

      {doc.status === "ok" ? (
        <>
          <div className="rounded-md border border-rule bg-surface">
            <div className="hidden sm:grid grid-cols-[minmax(0,1.5fr)_minmax(0,0.8fr)_minmax(0,1.4fr)_minmax(0,1.3fr)] gap-3 px-4 py-2 text-[10.5px] uppercase tracking-[0.08em] text-ink-mute">
              <span>{t("benchmarkPage.sector.col.ratio")}</span>
              <span className="text-right">{t("benchmarkPage.sector.col.company")}</span>
              <span>{t("benchmarkPage.sector.col.range")}</span>
              <span>{t("benchmarkPage.sector.col.position")}</span>
            </div>
            {rows.map((r) => (
              <div
                key={r.key}
                data-testid="sector-row"
                data-sector-row={r.key}
                data-status={r.status}
                className="grid grid-cols-1 sm:grid-cols-[minmax(0,1.5fr)_minmax(0,0.8fr)_minmax(0,1.4fr)_minmax(0,1.3fr)] gap-x-3 gap-y-1.5 border-t border-rule-soft px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="text-[12.5px] text-ink" data-cell="label">{r.label}</div>
                  {r.note ? <div className="mt-0.5 text-[11px] text-ink-mute" data-cell="note">{r.note}</div> : null}
                </div>
                <div className="sm:text-right font-mono tabular-nums text-[13px] text-ink" data-cell="company">{r.company}</div>
                {r.status === "sourced" && r.bar ? (
                  <>
                    <div className="min-w-0">
                      <SectorRangeBar
                        bar={r.bar}
                        vsSector={r.vsSector}
                        ariaLabel={t("benchmarkPage.sector.barAria", { label: r.label, company: r.company, median: r.median, iqr: r.iqr })}
                      />
                      <div className="mt-1 font-mono tabular-nums text-[11px] text-ink-soft">
                        <span data-cell="median">{r.median}</span>
                        <span className="mx-1 text-ink-mute">·</span>
                        <span data-cell="iqr">{r.iqr}</span>
                      </div>
                    </div>
                    <div className="min-w-0">
                      <div className={`text-[12px] ${toneOf(r.vsSector)}`} data-cell="position">{r.position}</div>
                      <div className="mt-0.5 font-mono tabular-nums text-[11px] text-ink-mute">
                        n=<span data-cell="n">{r.n}</span> · <span data-cell="fy">{r.fy}</span>
                        {r.level ? " · " : ""}<span data-cell="level">{r.level}</span>
                      </div>
                      <div className="mt-0.5 text-[10.5px] leading-snug text-ink-mute break-words" data-cell="source">{r.source}</div>
                    </div>
                  </>
                ) : (
                  <div className="sm:col-span-2 text-[12px] text-ink-soft" data-cell="reason">
                    {r.reason}
                    {r.n ? (
                      <span className="block mt-0.5 text-[10.5px] text-ink-mute break-words">n={r.n} · {r.fy} · {r.source}</span>
                    ) : null}
                  </div>
                )}
              </div>
            ))}
          </div>

          <p className="text-[11px] leading-snug text-ink-mute break-words" data-testid="sector-source">
            {doc.source ? t("benchmarkPage.sector.sourceLine", { source: doc.source, min: doc.min_peers }) : null}
            {doc.peer_set ? <> {t("benchmarkPage.sector.peerSet", { peerSet: doc.peer_set })}</> : null}
            {doc.period.period_end ? <> {t("benchmarkPage.sector.yearNote", { year: doc.year, periodEnd: doc.period.period_end })}</> : null}
          </p>

          <div className="rounded-md border border-rule bg-surface p-4 space-y-3" data-testid="sector-movements" data-status={moves.status}>
            {moves.status === "ok" ? (
              <>
                <div className="grid gap-4 md:grid-cols-2">
                  <MovementList title={t("benchmarkPage.sector.improvedTitle")} tone="text-success" items={moves.improved} empty={t("benchmarkPage.sector.improvedEmpty")} />
                  <MovementList title={t("benchmarkPage.sector.deterioratedTitle")} tone="text-alert" items={moves.deteriorated} empty={t("benchmarkPage.sector.deterioratedEmpty")} />
                </div>
                <p className="text-[11px] text-ink-mute">{moves.counts}</p>
              </>
            ) : (
              <p className="text-[12px] text-ink-soft">
                <span className="text-ink">{t("benchmarkPage.sector.improvedTitle")} / {t("benchmarkPage.sector.deterioratedTitle")}: </span>
                {moves.reason}
              </p>
            )}
          </div>

          {refusedLabels.length > 0 ? (
            <div className="rounded-md border border-rule bg-bg-2 p-4" data-testid="sector-refused">
              <h3 className="text-[10.5px] font-mono uppercase tracking-[0.08em] text-ink-soft">{t("benchmarkPage.sector.refusedTitle")}</h3>
              <p className="mt-1 text-[12px] text-ink-soft">{t("benchmarkPage.sector.refusedIntro")}</p>
              <p className="mt-1 text-[11.5px] text-ink-mute break-words">{refusedLabels.join(" · ")}</p>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/** The page section: fetches the served document for the active period. */
export function SectorBenchmarkSection({ periodId }: { periodId: string | null | undefined }) {
  const { t } = useTranslation();
  const q = useSectorBenchmark(periodId);
  if (!periodId) return null;
  if (q.isLoading) return <p className="mt-6 text-[12px] text-ink-mute">{t("benchmarkPage.sector.loading")}</p>;
  if (!q.data) return <p className="mt-6 text-[12px] text-ink-mute" data-testid="sector-unavailable">{t("benchmarkPage.sector.unavailable")}</p>;
  return <SectorBenchmarkView doc={q.data} />;
}
