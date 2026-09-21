// THE SLIDERS — each with its basis in small text beneath it.
//
// The four the spec names first (revenue growth, inflation, raw-material
// price against the base year, wage growth) are always on screen; energy,
// EUR/RON on imported inputs (and the imported share it reaches), DSO/DIO/
// DPO, capex, the interest rate and dividends sit behind "Mai multe". Which
// lever is which, its range and step, the value in force, where that value
// came from, and the sentence beneath it all come from the ENGINE
// (`levers[]`). A lever the book cannot measure says so in its basis; a lever
// that cannot move on this book is disabled with the engine's reason; a lever
// whose move reaches nothing yet says why — never a silent default.
//
// A slider position is an integer count of TICKS at the lever's served
// decimal scale. While the reader drags, the value beside the slider is their
// position; once the engine answers it is the ENGINE's own display of the
// value in force. Moving a slider asks the engine (debounced, useCockpit);
// this component computes no figure.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw } from "lucide-react";

import { pick, type CockpitLever, type LeverPositions } from "@/lib/forecastCockpit";
import { leverText } from "./format";

function Slider({
  lever,
  position,
  locale,
  lang,
  onMove,
  onReset,
  refused,
}: {
  lever: CockpitLever;
  /** The reader's own position, when they moved this lever. */
  position: number | undefined;
  locale: string;
  lang: string;
  onMove: (lever: CockpitLever, ticks: number) => void;
  onReset: (lever: CockpitLever) => void;
  refused: boolean;
}) {
  const { t } = useTranslation();
  const days = t("forecast.cockpit.levers.days", "days");
  const id = `cockpit-lever-${lever.id}`;
  const label = pick(lever.label, lang);
  // Where the thumb sits: the reader's move, else the value in force, else
  // (a lever with no value on this book) the nearest in-range tick to no move.
  const resting = lever.value ?? (lever.min <= 0 && lever.max >= 0 ? 0 : lever.min);
  const ticks = position ?? resting;
  const pending = position !== undefined && position !== lever.value;
  const moved = position !== undefined || lever.origin === "user";
  const served = pick(lever.display, lang);
  const shown = pending
    ? leverText(lever, ticks, locale, days)
    : served || t("forecast.cockpit.levers.notMeasured", "not measured");
  const disabled = lever.locked !== null;
  return (
    <div
      data-testid={id}
      data-lever-id={lever.id}
      data-origin={lever.origin}
      data-locked={disabled ? "true" : "false"}
      data-moved={moved ? "true" : "false"}
      className={`min-w-0 rounded-lg border px-3.5 py-3 ${
        refused ? "border-alert/50 bg-alert/5" : "border-rule bg-surface"
      }`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={`${id}-input`} className="min-w-0 text-[13px] font-medium leading-snug text-ink">
          {label}
        </label>
        <span className="flex shrink-0 items-center gap-1.5">
          <span
            data-testid={`${id}-value`}
            data-pending={pending ? "true" : "false"}
            className={`text-[13px] font-semibold tabular-nums ${pending ? "text-ink-soft" : "text-ink"}`}
          >
            {shown}
          </span>
          {lever.path && !pending ? (
            <span
              data-testid={`${id}-path`}
              className="rounded-sm border border-rule px-1 font-mono text-[9px] uppercase tracking-wider text-ink-mute"
            >
              {t("forecast.cockpit.levers.path", "path")}
            </span>
          ) : null}
          {moved ? (
            <button
              type="button"
              onClick={() => onReset(lever)}
              data-testid={`${id}-reset`}
              title={t("forecast.cockpit.levers.reset", "Back to the case's value")}
              aria-label={t("forecast.cockpit.levers.resetAria", "Reset {{lever}}", { lever: label })}
              className="rounded p-0.5 text-ink-mute transition-colors hover:text-ink"
            >
              <RotateCcw size={12} strokeWidth={2} aria-hidden />
            </button>
          ) : null}
        </span>
      </div>
      <input
        id={`${id}-input`}
        data-testid={`${id}-input`}
        type="range"
        min={lever.min}
        max={lever.max}
        step={lever.step}
        value={ticks}
        disabled={disabled}
        aria-valuetext={shown}
        onChange={(e) => {
          const next = Number.parseInt(e.target.value, 10);
          if (Number.isInteger(next)) onMove(lever, next);
        }}
        className="cockpit-range mt-2 w-full accent-[hsl(var(--brand))] disabled:opacity-40"
      />
      <p data-testid={`${id}-basis`} className="mt-1.5 text-[11.5px] leading-snug text-ink-mute">
        {pick(lever.basis, lang)}
      </p>
      {lever.locked ? (
        <p data-testid={`${id}-locked`} className="mt-1 text-[11.5px] leading-snug text-alert">
          {lever.locked}
        </p>
      ) : null}
      {lever.inert ? (
        <p data-testid={`${id}-inert`} className="mt-1 text-[11.5px] leading-snug text-caution">
          {pick(lever.inert, lang)}
        </p>
      ) : null}
    </div>
  );
}

export function LeverSliders({
  levers,
  positions,
  locale,
  lang,
  onMove,
  onReset,
  onResetAll,
  refusedId,
}: {
  levers: readonly CockpitLever[];
  positions: LeverPositions;
  locale: string;
  lang: string;
  onMove: (lever: CockpitLever, ticks: number) => void;
  onReset: (lever: CockpitLever) => void;
  onResetAll: () => void;
  refusedId: string | null;
}) {
  const { t } = useTranslation();
  const [more, setMore] = useState(false);
  const primary = levers.filter((l) => l.group === "primary");
  const rest = levers.filter((l) => l.group === "more");
  const anyMoved = Object.keys(positions).length > 0 || levers.some((l) => l.origin === "user");
  // A lever the engine refused is never hidden behind "Mai multe".
  const showMore = more || rest.some((l) => l.id === refusedId);
  const slider = (l: CockpitLever) => (
    <Slider
      key={l.id}
      lever={l}
      position={positions[l.id]}
      locale={locale}
      lang={lang}
      onMove={onMove}
      onReset={onReset}
      refused={refusedId === l.id}
    />
  );
  return (
    <section data-testid="cockpit-levers" className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-mono text-[11px] uppercase tracking-wider text-ink-mute">
          {t("forecast.cockpit.levers.title", "Assumptions")}
        </h2>
        {anyMoved ? (
          <button
            type="button"
            data-testid="cockpit-levers-reset-all"
            onClick={onResetAll}
            className="text-[12px] text-ink-soft underline-offset-2 hover:text-ink hover:underline"
          >
            {t("forecast.cockpit.levers.resetAll", "Back to the case")}
          </button>
        ) : null}
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">{primary.map(slider)}</div>
      {rest.length > 0 ? (
        <div>
          <button
            type="button"
            data-testid="cockpit-levers-more"
            aria-expanded={showMore}
            onClick={() => setMore((m) => !m)}
            className="text-[12.5px] font-medium text-ink-soft hover:text-ink"
          >
            {showMore
              ? t("forecast.cockpit.levers.less", "Fewer")
              : t("forecast.cockpit.levers.more", "More ({{count}})", { count: rest.length })}
          </button>
          {showMore ? (
            <div data-testid="cockpit-levers-more-panel" className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
              {rest.map(slider)}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
