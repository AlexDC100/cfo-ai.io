// THE LEVER RAIL — the levers the reader may move, each standing on a stated
// basis, and the ones this engine does not serve, listed rather than faked.
//
// ── WHAT IS SHOWN IS WHAT THE ENGINE DECLARES ───────────────────────────
//
// Every control below is built from the served driver: its unit, its shape
// (one value per plan year, or one scalar), its bounds, its step, its tier and
// its basis sentence all come off the wire. A lever the engine does not
// declare gets no control — `gross_margin` and `opex_growth` both answer 422
// `unknown_driver`, so the rail names them as unavailable BY CHECKING the
// payload for them, not by carrying a sentence somebody typed here.
//
// ── THE FIGURES MOVE WHEN THE SERVER ANSWERS ────────────────────────────
//
// The control's own text is local while the reader types. Nothing else on the
// page is. There is no optimistic projection: a second model computed here to
// fill the wait would be a different model wearing the same labels, and the
// reader would have no way to tell which one they were looking at.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  displayBound,
  displayStep,
  displaySuffix,
  displayToWire,
  planYearLabels,
  wireToDisplay,
  OFFERED_LEVERS,
  REQUESTED_BUT_UNDECLARED,
  type LeverEdit,
} from "@/lib/forecastLevers";
import type { LeverRef, ProjectionView } from "@/lib/forecastFacts";

export interface LeverRailProps {
  readonly view: ProjectionView;
  readonly edits: readonly LeverEdit[];
  readonly recomputing: boolean;
  readonly error: string | null;
  /** The lever the engine's refusal NAMES, so the cell the reader must undo is
   *  marked instead of left to be found by re-reading the sentence. */
  readonly refusedKey: string | null;
  onChange(key: string, index: number, text: string): void;
  onReset(key: string): void;
  onAdopt(key: string, values: readonly string[]): void;
}

function TierChip({ tier, testid }: { tier: string | null; testid: string }) {
  const { t } = useTranslation();
  if (!tier) return null;
  return (
    <span
      data-testid={testid}
      data-tier={tier}
      className="rounded-full border border-rule px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-ink-mute"
    >
      {t(`forecast.tier.${tier}`, tier)}
    </span>
  );
}

/** ONE EDITABLE CELL. The typed text is local — and ONLY the typed text.
 *
 *  The re-sync effect fires on the SERVED value, so the field is not clobbered
 *  mid-recompute (the served value has not moved yet) and does adopt whatever
 *  the engine answers — including a value the engine clamped or refused to
 *  take, which the reader then sees rather than being left looking at their own
 *  number as though it had been accepted. Same shape as `ValuationSection`,
 *  the page in this product that already round-trips an input to the server. */
function LeverCell({
  lever,
  index,
  yearLabel,
  served,
  refused,
  onChange,
}: {
  lever: LeverRef;
  index: number;
  yearLabel: string | null;
  served: string;
  refused: boolean;
  onChange: LeverRailProps["onChange"];
}) {
  const [text, setText] = useState(served);
  useEffect(() => {
    setText(served);
  }, [served]);
  return (
    <label
      className={`flex min-w-0 items-center gap-1 rounded border px-2 py-1 ${
        refused ? "border-alert bg-alert/5" : "border-rule"
      }`}
    >
      {yearLabel ? (
        <span className="font-mono text-[9px] uppercase tracking-wider text-ink-mute">
          {yearLabel}
        </span>
      ) : null}
      {/* NOT DISABLED WHILE THE SERVER ANSWERS. The debounce already coalesces
          keystrokes and a stale answer is dropped by the query key, so the only
          thing disabling buys is dropped characters: the first keystroke fires
          the debounce, the field goes dead for the round trip, and "12.5"
          arrives as "1". In a real browser it also BLURS, because disabling a
          focused element blurs it. The MIN and MAX are the engine's own served
          bounds, so the refusal it would answer with is one the control does
          not let the reader reach in the first place. */}
      <input
        type="number"
        inputMode="decimal"
        data-testid={`forecast-lever-input-${lever.key}-${index}`}
        data-refused={refused ? "true" : undefined}
        aria-invalid={refused || undefined}
        value={text}
        min={displayBound(lever, "min")}
        max={displayBound(lever, "max")}
        step={displayStep(lever)}
        onChange={(e) => {
          setText(e.target.value);
          onChange(lever.key, index, e.target.value);
        }}
        className="w-[5.5rem] bg-transparent text-right text-[13px] tabular-nums text-ink outline-none"
      />
      {displaySuffix(lever) ? (
        <span className="font-mono text-[10px] text-ink-mute">
          {displaySuffix(lever)}
        </span>
      ) : null}
    </label>
  );
}

function LeverRow({
  lever,
  edit,
  years,
  busy,
  refused,
  onChange,
  onReset,
  onAdopt,
}: {
  lever: LeverRef;
  edit: LeverEdit | undefined;
  years: readonly string[];
  /** A recompute is in flight. It holds back the controls that replace the
   *  WHOLE lever in one click — reset and adopt — because a second set queued
   *  behind the first is a request the reader did not mean to make. It does not
   *  hold back the number cells. */
  busy: boolean;
  refused: boolean;
  onChange: LeverRailProps["onChange"];
  onReset: LeverRailProps["onReset"];
  onAdopt: LeverRailProps["onAdopt"];
}) {
  const { t } = useTranslation();
  const count = lever.shape === "scalar" ? 1 : years.length;
  const isUser = lever.basis.tier === "user";
  // The value the reader is looking at: their own edit if they have made one,
  // otherwise the engine's served value for that plan year.
  const cellValue = (i: number): string => {
    const own = edit?.values[i];
    if (own !== undefined && own !== null) return wireToDisplay(own, lever);
    return wireToDisplay(lever.valueTexts[i] ?? null, lever);
  };

  return (
    <div
      data-testid={`forecast-lever-${lever.key}`}
      className="border-b border-rule-soft/60 px-4 py-3 last:border-0"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] text-ink">
          {t(`forecast.lever.${lever.key}`, lever.label)}
        </span>
        <TierChip tier={lever.basis.tier} testid={`forecast-lever-tier-${lever.key}`} />
        {isUser ? (
          <button
            type="button"
            data-testid={`forecast-lever-reset-${lever.key}`}
            disabled={busy}
            onClick={() => onReset(lever.key)}
            className="rounded border border-rule px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-ink-mute hover:text-ink"
          >
            {/* Reset goes back to the tier the engine had BEFORE this reader
                touched it — `basis.original` carries that whole basis, so the
                button names the real destination rather than saying "book"
                for a value that was never a book measurement. */}
            {t("forecast.lever.resetTo", "Reset to {{tier}}", {
              tier: t(
                `forecast.tier.${lever.original?.basis.tier ?? "convention"}`,
                lever.original?.basis.tier ?? "",
              ),
            })}
          </button>
        ) : null}
      </div>

      <div className="mt-2 flex flex-wrap gap-2">
        {Array.from({ length: count }, (_, i) => (
          <LeverCell
            key={i}
            lever={lever}
            index={i}
            yearLabel={count > 1 ? (years[i] ?? String(i + 1)) : null}
            served={cellValue(i)}
            refused={refused}
            onChange={onChange}
          />
        ))}
      </div>

      <p
        data-testid={`forecast-lever-basis-${lever.key}`}
        className="mt-1.5 text-[11px] leading-snug text-ink-soft"
      >
        {lever.basis.sentence}
      </p>

      {/* THE ONE-TAP OFFER. Rendered from `alternatives`, each labelled with
          the source it stands on. There is no sector source wired into this
          engine — `basis.sector`, `alternatives.sector` and
          `pins.sector_snapshot_id` are null on every driver of every book — so
          a sector offer appears here the day one is served and never before. */}
      {lever.alternatives
        .filter((alt) => alt.tier !== lever.basis.tier && alt.values.length > 0)
        .map((alt) => (
          <button
            key={alt.tier}
            type="button"
            disabled={busy}
            data-testid={`forecast-lever-adopt-${lever.key}-${alt.tier}`}
            onClick={() => onAdopt(lever.key, alt.values)}
            className="mt-1.5 block text-left text-[11px] leading-snug text-brand hover:underline"
          >
            {t("forecast.lever.useTier", "Use the {{tier}} figure", {
              tier: t(`forecast.tier.${alt.tier}`, alt.tier),
            })}
            <span className="text-ink-soft"> — {alt.sentence}</span>
          </button>
        ))}

      {lever.inert ? (
        <p className="mt-1 text-[11px] leading-snug text-ink-mute">{lever.inert}</p>
      ) : null}
    </div>
  );
}

export function LeverRail({
  view,
  edits,
  recomputing,
  error,
  refusedKey,
  onChange,
  onReset,
  onAdopt,
}: LeverRailProps) {
  const { t } = useTranslation();
  const years = planYearLabels(view.horizon, view.horizonAnnual);
  const offered = OFFERED_LEVERS.map((key) => view.lever(key)).filter(
    (l): l is LeverRef => l !== null,
  );
  // MEASURED, not asserted: the keys the product asked for that this payload
  // does not declare. If a later build serves one, this list shortens itself.
  const undeclared = REQUESTED_BUT_UNDECLARED.filter((key) => !view.lever(key));
  const editByKey = new Map(edits.map((e) => [e.key, e]));

  return (
    <section
      data-testid="forecast-levers"
      className="rounded-xl border border-rule bg-surface"
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-rule px-4 py-3">
        <div>
          <h2 className="font-mono text-[11px] uppercase tracking-wider text-ink-mute">
            {t("forecast.levers.title", "Levers")}
          </h2>
          <p className="mt-1 text-[12px] leading-snug text-ink-soft">
            {t(
              "forecast.levers.lead",
              "Move one and the whole projection is rebuilt on the server. Nothing on this page changes until it answers.",
            )}
          </p>
        </div>
        <span
          data-testid="forecast-recompute-state"
          data-recomputing={recomputing ? "true" : "false"}
          className="font-mono text-[10px] uppercase tracking-wider text-ink-mute"
        >
          {recomputing
            ? t("forecast.levers.recomputing", "Recomputing…")
            : t("forecast.levers.settled", "Up to date")}
        </span>
      </header>

      {error ? (
        <p
          data-testid="forecast-recompute-error"
          className="border-b border-rule bg-alert/5 px-4 py-2 text-[12px] leading-snug text-ink"
        >
          {/* The engine's refusal, in its own words: it names the lever and
              why it would not take the value. */}
          {error}
        </p>
      ) : null}

      <div>
        {offered.map((lever) => (
          <LeverRow
            key={lever.key}
            lever={lever}
            edit={editByKey.get(lever.key)}
            years={years}
            busy={recomputing}
            refused={refusedKey === lever.key}
            onChange={onChange}
            onReset={onReset}
            onAdopt={onAdopt}
          />
        ))}
      </div>

      <div className="border-t border-rule px-4 py-3">
        <p className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
          {t("forecast.levers.notServed", "Not served by this engine")}
        </p>
        <ul className="mt-1 space-y-1 text-[11px] leading-snug text-ink-soft">
          {undeclared.map((key) => (
            <li key={key} data-testid={`forecast-lever-undeclared-${key}`}>
              {t(`forecast.lever.${key}`, key.replace(/_/g, " "))} —{" "}
              {t(
                "forecast.levers.undeclared",
                "this projection declares no such driver, so there is no honest control for it",
              )}
            </li>
          ))}
          {/* The engine's OWN list of levers it was asked for and does not
              model, each with the sentence it states. */}
          {view.client.unserved.map((row) => (
            <li key={row.key} data-testid={`forecast-lever-unserved-${row.key}`}>
              {row.sentence}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export default LeverRail;

/** The wire value for one typed cell, or `null` when the text is not a
 *  number. Exported so the page's edit state and the row agree on one
 *  conversion. */
export function cellToWire(text: string, lever: LeverRef): string | null {
  return displayToWire(text, lever);
}
