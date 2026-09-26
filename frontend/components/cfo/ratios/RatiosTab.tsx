// The dashboard's Ratios tab: band movements first, then the ratio tiles
// by group, then every served ratio in one six-column table.
//
// Extracted from pages/cfo/FinancialStatements.tsx (RatiosTabContent,
// RatioGroupSection, RatioTile) so a test can render the real tab. The
// `data-guide` anchors are carried verbatim: the learning page guides
// (components/learning/pageGuides.tsx, e2e/learning-page-guides.spec.ts)
// point at them.
//
// ── WHO SAYS WHAT ─────────────────────────────────────────────────────
//
// The ENGINE says every number, band, change and band movement: the tile
// headline, badge, ladder line and prior line read the served rows
// through `printRatioRow` / `ladderText` (lib/ratioCompareView.ts), from
// `RatioCompareCtx`. The badge text, badge colour and ladder line all read
// ONE side, `bandSideOf`: with a comparison loaded that is the
// comparison's current side, so the badge states the same sector decision
// as the band-now, band-prior and movement cells beside it.
// `computeRatios` still supplies the prose around them (the formula the
// drawer explains), and its commentary line prints beside a served row
// only when it cannot contradict it (`commentaryAgreesWithServed`). Its
// arithmetic prints only for a period the engine served no table for
// (sample datasets, pre-table engines), where there is nothing else.
//
// The prior period's figures used to be recomputed here: the page ran
// computeRatios over the prior's statements, flattened the result to a Map
// of key to number, and the tile subtracted and formatted the change
// inline. That path, and its three formats of its own, is deleted; a
// grep gate in ratioCompareTab.test.tsx reds if it returns.

import { useEffect, useRef, useState } from "react";
import { useInRouterContext, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { useRatioCompareView } from "@/components/cfo/ComparativesPanel";
import { useSectorBenchmarkDoc } from "@/components/cfo/benchmark/SectorBenchmarkSection";
import { bandSourceOf, bandSourceText } from "@/lib/sectorBenchmark";
import { RatioDetailDrawer } from "@/components/cfo/RatioDetailDrawer";
import { absenceSentence } from "@/components/cfo/ratioAbsenceI18n";
import { BandMovementLists } from "@/components/cfo/ratios/BandMovementLists";
import { BADGE_BY_TONE, RatioComparisonTable, toneText } from "@/components/cfo/ratios/RatioComparisonTable";
import { LearnableNumber } from "@/components/learning/LearnableNumber";
import { formatRatio, type Ratio, type RatioBundle, type Statements } from "@/lib/financialReport";
import {
  bandSideOf,
  bandTone,
  commentaryAgreesWithServed,
  currentSideOf,
  engineKeyOf,
  ladderText,
  printRatioRow,
  ratioCmpHandleOf,
  serializePrintedRow,
  servedIdentityOf,
} from "@/lib/ratioCompareView";
import { RATIO_DELTA_SECONDARY_CLOSE, RATIO_DELTA_SECONDARY_OPEN } from "@/lib/ratioTable";

/** EVIDENCE RECEIVER (design C4): `?ratio=<key>` on the ratios tab opens
 *  that ratio's detail drawer — the command bar's Răspuns and "Ce contează
 *  acum" items open the row they were read from. Closing the drawer drops
 *  the parameter, so Back and a second open behave. Mounted only inside a
 *  router.
 *
 *  Not every served key has a tile: the ratio table serves rows the tiles
 *  do not carry (net_debt_to_ebitda, debt_to_assets, operating_margin, …)
 *  and the composites (credit_composite, letter_grade). Their evidence is
 *  their row in the ratio table, which renders every served key: that row
 *  is highlighted (`onWanted`) and scrolled into view, so no key lands on a
 *  tab with nothing marked. */
function RatioParam({ ratios, selected, onOpen, onWanted }: {
  ratios: Ratio[];
  selected: Ratio | null;
  onOpen: (r: Ratio) => void;
  onWanted: (key: string | null) => void;
}) {
  const [params, setParams] = useSearchParams();
  const wanted = params.get("ratio");
  const opened = useRef<string | null>(null);
  const hasTile = !!wanted && ratios.some((r) => r.key === wanted);
  useEffect(() => {
    onWanted(wanted);
    if (!wanted || hasTile) return;
    const id = window.setTimeout(() => {
      const el = document.querySelector<HTMLElement>(
        `[data-testid="ratio-compare-row"][data-ratio-key="${CSS.escape(wanted)}"]`);
      el?.scrollIntoView?.({ block: "center" });
    }, 60);
    return () => window.clearTimeout(id);
  }, [wanted, hasTile, onWanted]);
  // Whether the drawer this receiver opened has actually been SEEN open —
  // the open is a state update, so in the commit that requests it
  // `selected` is still null, and reading that as "closed" would drop the
  // parameter the same instant it was honoured.
  const shown = useRef(false);
  useEffect(() => {
    if (!wanted || opened.current === wanted) return;
    const hit = ratios.find((r) => r.key === wanted);
    if (hit) {
      opened.current = wanted;
      shown.current = false;
      onOpen(hit);
    }
  }, [wanted, ratios, onOpen]);
  useEffect(() => {
    if (!opened.current) return;
    if (selected !== null) {
      shown.current = true;
      return;
    }
    if (!shown.current || wanted !== opened.current) return;
    opened.current = null;
    shown.current = false;
    const next = new URLSearchParams(params);
    next.delete("ratio");
    setParams(next, { replace: true });
  }, [selected, wanted, params, setParams]);
  return null;
}

// Wrapper around all 6 RatioGroupSections that owns the selected-ratio
// state and renders the premium explainer drawer. Owning state here
// keeps the Ratios surface self-contained — no upstream prop drilling,
// no global store for an interaction that's scoped to this tab.
export function RatiosTabContent({
  ratios,
  statements,
  // ── THE BANKRUPTCY ROW IS NOT PART OF THE BUNDLE ANY MORE ─────────
  // It used to be `ratios.bankruptcy` — a Z″ computed by an arithmetic
  // that exists nowhere else, banded by a ladder that used `>=` where
  // every other surface uses `>`. The row is the credit reader's own,
  // handed down from the page, so it cannot be computed a second way here.
  altman,
}: {
  ratios: RatioBundle;
  statements: Statements | null;
  /** `altmanRatio(credit)` — NULL only when the page has no statements
   *  to score, in which case there is no Ratios tab either. */
  altman: Ratio | null;
}) {
  const { t } = useTranslation();
  const view = useRatioCompareView();
  const [selected, setSelected] = useState<Ratio | null>(null);
  const [evidenceKey, setEvidenceKey] = useState<string | null>(null);
  const inRouter = useInRouterContext();
  const allRatios = [
    ...ratios.liquidity, ...ratios.profitability, ...ratios.leverage,
    ...ratios.coverage, ...ratios.efficiency, ...(altman ? [altman] : []),
  ];
  return (
    <>
      {inRouter ? <RatioParam ratios={allRatios} selected={selected} onOpen={setSelected} onWanted={setEvidenceKey} /> : null}
      {view ? <BandMovementLists view={view} /> : null}
      <RatioGroupSection title={t("dash.ratioLiquidity")}            ratios={ratios.liquidity}     onPick={setSelected} />
      <div data-guide="ratios-profitability">
        <RatioGroupSection title={t("dash.ratioProfitability")}      ratios={ratios.profitability} onPick={setSelected} />
      </div>
      <div data-guide="ratios-leverage">
        <RatioGroupSection title={t("dash.ratioLeverage")}           ratios={ratios.leverage}      onPick={setSelected} />
        <div className="mt-8">
          <RatioGroupSection title={t("dash.ratioCoverage")}         ratios={ratios.coverage}      onPick={setSelected} />
        </div>
      </div>
      <div data-guide="ratios-efficiency">
        <RatioGroupSection title={t("dash.ratioEfficiency")}          ratios={ratios.efficiency}    onPick={setSelected} />
      </div>
      <div data-guide="ratios-risk">
        <RatioGroupSection title={t("dash.ratioBankruptcy")}         ratios={altman ? [altman] : []} onPick={setSelected} />
      </div>

      {view ? <RatioComparisonTable view={view} highlightKey={evidenceKey} /> : null}

      {/* Premium explainer drawer — 8 sections + related-ratio pivot.
       *  See `components/cfo/RatioDetailDrawer.tsx` and the knowledge map
       *  at `lib/ratioKnowledge.ts`. */}
      <RatioDetailDrawer
        ratio={selected}
        bundle={ratios}
        /* The Altman row travels separately because it belongs to the
           credit reader, not to `computeRatios` — the drawer needs it in
           its key index so "related ratio" pivots still reach it. */
        extraRatios={altman ? [altman] : undefined}
        statements={statements}
        onClose={() => setSelected(null)}
        onPickRelated={setSelected}
      />
    </>
  );
}

export function RatioGroupSection({
  title, ratios, onPick,
}: {
  title: string;
  ratios: Ratio[];
  /** Click on any ratio tile opens the premium explainer drawer. */
  onPick?: (r: Ratio) => void;
}) {
  return (
    <div>
      <h2 className="text-[10.5px] uppercase tracking-[0.14em] text-ink-soft font-semibold mb-3">
        {title}
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {ratios.map((r) => (
          <RatioTile key={r.key} ratio={r} onPick={onPick} />
        ))}
      </div>
    </div>
  );
}


function legacyBadgeClass(verdict: Ratio["verdict"]): string {
  return verdict === "unknown" || verdict === "ungraded"
    ? BADGE_BY_TONE.neutral
    : verdict === "critical"
      ? BADGE_BY_TONE.alert
      : verdict === "watch"
        ? BADGE_BY_TONE.caution
        : BADGE_BY_TONE.success;
}

export function RatioTile({
  ratio, onPick,
}: {
  ratio: Ratio;
  onPick?: (r: Ratio) => void;
}) {
  const { t, i18n } = useTranslation();
  const clickable = typeof onPick === "function";
  const view = useRatioCompareView();
  const engineKey = engineKeyOf(ratio.key);
  const sectorDoc = useSectorBenchmarkDoc();
  // THE SERVED ROW, when the engine served one for this key. `side` is the
  // current period's served Side; `printed` is every string the tile shows.
  const side = currentSideOf(view, engineKey);
  const printed = side ? printRatioRow(view, engineKey, i18n.language) : null;
  // The side whose band the badge and ladder print: the same side
  // `printed.bandNow` was formatted from.
  const bandSide = bandSideOf(view, engineKey);
  const identity = servedIdentityOf(view, engineKey);
  // The tile becomes a button when clickable, keeping keyboard focus,
  // Enter/Space activation, and an aria role for AT users.
  const Tag = (clickable ? "button" : "div") as "button" | "div";
  return (
    <Tag
      type={clickable ? "button" : undefined}
      onClick={clickable ? () => onPick!(ratio) : undefined}
      data-testid="ratio-tile"
      data-ratio-key={ratio.key}
      data-engine-key={engineKey}
      data-source={printed ? "served" : "client"}
      data-ratio-cmp-json={printed ? ratioCmpHandleOf(view, engineKey) : undefined}
      data-ratio-printed-json={printed ? serializePrintedRow(printed) : undefined}
      aria-label={clickable ? t("dash.openRatioDetail", { label: printed?.label ?? ratio.label }) : undefined}
      className={`
        group relative w-full text-left
        rounded-md border border-rule bg-surface p-4
        transition-colors duration-150
        ${clickable
          ? "hover:border-rule-strong hover:bg-bg-2/40 focus:outline-none focus:ring-2 focus:ring-brand/30 cursor-pointer"
          : ""}
      `}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="text-[11px] uppercase tracking-[0.1em] text-ink-mute font-medium">
          {printed ? printed.label : ratio.label}
        </div>
        <span
          data-testid="ratio-band-now"
          className={`text-[9.5px] font-semibold uppercase tracking-[0.06em] px-2 py-0.5 rounded-full border text-ink anim-fill-verdict ${
            printed ? BADGE_BY_TONE[bandTone(bandSide)] ?? BADGE_BY_TONE.neutral : legacyBadgeClass(ratio.verdict)
          }`}
        >
          {printed
            ? printed.bandNow
            : ratio.verdict === "strong"
              ? t("dashV2.ratioVerdictStrong")
              : ratio.verdict === "healthy"
                ? t("dashV2.ratioVerdictHealthy")
                : ratio.verdict === "watch"
                  ? t("dashV2.ratioVerdictWatch")
                  : ratio.verdict === "unknown"
                    ? t("dashV2.ratioVerdictUnknown")
                    : ratio.verdict === "ungraded"
                      ? t("dashV2.ratioVerdictUngraded")
                      : t("dashV2.ratioVerdictCritical")}
        </span>
      </div>
      {/* A REFUSED RATIO IS NOT A NUMBER, so it does not get the number
          treatment: no `<LearnableNumber>` (its popover would explain a
          value nobody computed) and no 22px mono figure. On a served row
          the reason is the engine's, in the reader's language. */}
      {printed ? (
        printed.currentStatus === "refused" ? (
          <div className="text-[13px] text-ink-mute leading-snug" data-testid="ratio-unavailable">
            {printed.current}
          </div>
        ) : (
          <div
            className="font-mono text-[22px] font-medium text-ink leading-tight tabular-nums tracking-[-0.005em]"
            data-testid="ratio-current"
          >
            <LearnableNumber conceptKey={ratio.key} value={side?.value ?? null}>
              {printed.current}
            </LearnableNumber>
          </div>
        )
      ) : ratio.value === null ? (
        <div className="text-[13px] text-ink-mute leading-snug" data-testid="ratio-unavailable">
          {t("dashV2.ratioVerdictUnknown")}
        </div>
      ) : (
        <div className="font-mono text-[22px] font-medium text-ink leading-tight tabular-nums tracking-[-0.005em]">
          <LearnableNumber conceptKey={ratio.key} value={ratio.value}>
            {formatRatio(ratio)}
          </LearnableNumber>
        </div>
      )}
      <div className="text-[11px] text-ink-mute mt-1" data-testid="ratio-ladder">
        {printed && identity ? ladderText(bandSide, identity.higher_is_better, identity.display_unit, i18n.language) : ratio.benchmark}
      </div>
      {/* WHERE THE BAND COMES FROM — a sibling of the ladder, never inside
          it. A served ratio says either "sector filings: CAEN, size band,
          n, FY, source" beside the general ladder, or that the ladder is
          the general SME fallback and why no sector band exists. */}
      {printed && identity ? (
        <div
          className="text-[10.5px] leading-snug text-ink-mute mt-1 break-words"
          data-testid="ratio-band-source"
          data-band-source={bandSourceOf(sectorDoc, engineKey ?? "")}
        >
          {bandSourceText(sectorDoc, engineKey ?? "", i18n.language)}
        </div>
      ) : null}
      {/* COMPARATIVES — the served prior, change, prior band and band
          movement for this key. A prior the engine could not compute
          prints its reason. */}
      {printed && printed.priorStatus !== "no_comparison" ? (
        <div
          className="mt-1.5 text-[11.5px] text-ink-soft space-y-0.5"
          data-testid="ratio-prior"
          data-ratio-prior={printed.priorStatus}
          data-movement={printed.movementStatus ?? "none"}
        >
          <div className="font-mono tabular-nums">
            <span className="text-ink-mute uppercase tracking-[0.06em] text-[10px] mr-1">
              {t("statements.ratioCmp.ui.priorEyebrow", { label: view?.priorLabel ?? "" })}
            </span>
            <span data-col="prior">{printed.prior}</span>
            {/* ONE change cell: "+0.28× (+15.4%)", the same bytes the
                table, the lists, the report and the workbook print
                (`joinRatioDelta`) — not two strings a margin apart. */}
            <span className="ml-2" data-cell="delta">
              <span className={toneText(printed.deltaTone)} data-col="delta">{printed.delta}</span>
              {printed.deltaSecondary ? (
                <span className="text-ink-mute">
                  {RATIO_DELTA_SECONDARY_OPEN}
                  <span data-col="delta_secondary">{printed.deltaSecondary}</span>
                  {RATIO_DELTA_SECONDARY_CLOSE}
                </span>
              ) : null}
            </span>
          </div>
          <div>
            <span className="text-ink-mute" data-col="band_prior">{printed.bandPrior}</span>
            <span aria-hidden className="mx-1 text-ink-mute">·</span>
            <span className={toneText(printed.movementTone)} data-col="movement">{printed.movement}</span>
          </div>
        </div>
      ) : null}
      {/* A REFUSAL IS RENDERED IN THE READER'S LANGUAGE. On a served row
          the reason already sits where the figure would; the commentary
          prose is shown only beside a figure. */}
      {printed ? (
        printed.currentStatus === "present" && commentaryAgreesWithServed(ratio.commentary, ratio.verdict, bandSide) ? (
          <p className="text-[12px] text-ink-soft leading-snug mt-2 line-clamp-3" data-testid="ratio-commentary">{ratio.commentary}</p>
        ) : null
      ) : (
        <p className="text-[12px] text-ink-soft leading-snug mt-2 line-clamp-3">
          {ratio.unavailable ? absenceSentence(t, ratio.unavailable) : ratio.commentary}
        </p>
      )}
      {clickable && (
        <div className="mt-2 inline-flex items-center gap-1 text-[10.5px] text-ink-mute group-hover:text-brand-d transition-colors">
          <span>{t("dash.openExplainer")}</span>
          <span aria-hidden>→</span>
        </div>
      )}
    </Tag>
  );
}
