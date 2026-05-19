// DataRulesCard.tsx — threshold sliders moved from the legacy
// CommandDrawer Rules tab into the Settings page.
//
// WHY THIS MOVED
// ──────────────
// The cleanup brief is explicit: "Rules, cost of capital, industry,
// benchmark assumptions, and financial assumptions belong in the full
// Settings page, not in Command Center. Command Center should be a
// quick-access control panel, not another sidebar."
//
// What we kept
//   · Same SPECS schema, same threshold storage (useThresholds + writeThresholds)
//   · Same calibrated-tick + snap-back interaction
//   · Same group structure (Protect · Watch · Liquidate-Scale)
//   · Same "edited drift" badge so the user can see how far they've roamed
//
// What changed
//   · Lives at /settings → "Data rules" section (not a drawer tab)
//   · No collapsible group state — full vertical scroll, all expanded
//     by default (the Settings page already scrolls; nested
//     expand/collapse felt fiddly)
//   · No toast on every reset — Settings has its own toast cadence
//
// Adding a new threshold: define the spec in `thresholdSchema.ts` and
// it appears here automatically (no change in this file).

import { useState } from "react";
import { ChevronDown, RotateCcw, Settings2 } from "lucide-react";

import { toast } from "@/components/ui/sonner";
import {
  DEFAULTS,
  type Thresholds,
  useThresholds,
  writeThresholds,
} from "@/lib/thresholds";
import {
  SPECS,
  type ThresholdSpec,
  isAtCalibrated,
} from "@/lib/thresholdSchema";

export function DataRulesCard() {
  const thresholds = useThresholds();
  // Three groups stay open by default — Settings page has the room.
  const [openGroups, setOpenGroups] = useState<Set<GroupKey>>(
    new Set(["protect", "watch", "liquidate"]),
  );

  function toggle(g: GroupKey) {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });
  }

  function resetAll() {
    writeThresholds({ ...DEFAULTS });
    toast.success("All thresholds reset to calibrated defaults");
  }

  return (
    <div className="rounded-xl border border-rule bg-surface" data-testid="settings-data-rules">
      <RuleGroup
        title="Protect"
        subtitle="Anchor thresholds — high-volume / good-margin SKUs"
        specs={SPECS.anchor}
        thresholds={thresholds}
        open={openGroups.has("protect")}
        onToggle={() => toggle("protect")}
      />
      <RuleGroup
        title="Watch · Fix · Reduce"
        subtitle="Margin + DIO gates for non-anchors"
        specs={SPECS.warning}
        thresholds={thresholds}
        open={openGroups.has("watch")}
        onToggle={() => toggle("watch")}
      />
      <RuleGroup
        title="Liquidate · Scale"
        subtitle="Capital-trap and scale-floor extremes"
        specs={[...SPECS.eliminate, ...SPECS.scale]}
        thresholds={thresholds}
        open={openGroups.has("liquidate")}
        onToggle={() => toggle("liquidate")}
      />

      <div className="px-4 py-3 border-t border-rule flex items-center justify-between gap-3">
        <p className="text-[11.5px] text-ink-mute">
          Changes apply locally and feed every recomputation on the next
          analysis run. Click any calibrated tick (small dot above the
          slider) to snap that threshold back to its default.
        </p>
        <button
          type="button"
          onClick={resetAll}
          className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-ink-soft hover:text-ink transition-colors shrink-0"
        >
          <RotateCcw size={11} strokeWidth={2} />
          Reset all
        </button>
      </div>
    </div>
  );
}

// ─── Helpers (mirror of the legacy CommandDrawer RuleGroup + ThresholdSlider) ───

type GroupKey = "protect" | "watch" | "liquidate";

function RuleGroup({
  title,
  subtitle,
  specs,
  thresholds,
  open,
  onToggle,
}: {
  title: string;
  subtitle: string;
  specs: ThresholdSpec[];
  thresholds: Thresholds;
  open: boolean;
  onToggle: () => void;
}) {
  const driftCount = specs.filter(
    (s) => !isAtCalibrated(s, (thresholds as Record<string, unknown>)[s.key] as number),
  ).length;

  return (
    <div className="border-b border-rule last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-bg-2/40 transition-colors"
      >
        <span className="w-7 h-7 rounded-md grid place-items-center bg-bg-2 border border-rule text-ink-soft shrink-0">
          <Settings2 size={14} strokeWidth={1.75} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[13.5px] text-ink leading-tight">{title}</div>
          <div className="text-[11.5px] text-ink-soft mt-0.5 leading-tight">{subtitle}</div>
        </div>
        {driftCount > 0 && (
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-300 font-semibold">
            {driftCount} edited
          </span>
        )}
        <ChevronDown
          size={13}
          strokeWidth={1.75}
          className={`text-ink-mute shrink-0 transition-transform ${open ? "" : "-rotate-90"}`}
        />
      </button>

      {open && (
        <div className="px-4 pb-4 pt-1 space-y-4 bg-bg-2/30">
          {specs.map((spec) => (
            <ThresholdSlider key={spec.key} spec={spec} thresholds={thresholds} />
          ))}
        </div>
      )}
    </div>
  );
}

function ThresholdSlider({
  spec,
  thresholds,
}: {
  spec: ThresholdSpec;
  thresholds: Thresholds;
}) {
  const current =
    ((thresholds as Record<string, unknown>)[spec.key] as number) ?? spec.calibrated;
  const formatted = spec.format ? spec.format(current) : current.toString();
  const calibratedFmt = spec.format ? spec.format(spec.calibrated) : spec.calibrated.toString();
  const drifted = !isAtCalibrated(spec, current);
  const calibratedPct = ((spec.calibrated - spec.min) / (spec.max - spec.min)) * 100;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={`th-${spec.key}`} className="text-[12.5px] text-ink font-medium leading-tight">
          {spec.label}
        </label>
        <span className={`font-mono text-[12px] tabular-nums ${drifted ? "text-brand-d" : "text-ink-soft"}`}>
          {formatted}
        </span>
      </div>
      <div className="relative mt-2">
        <input
          id={`th-${spec.key}`}
          type="range"
          min={spec.min}
          max={spec.max}
          step={spec.step}
          value={current}
          onChange={(e) => {
            const v = parseFloat(e.currentTarget.value);
            if (!Number.isFinite(v)) return;
            writeThresholds({ ...thresholds, [spec.key]: v });
          }}
          className="
            w-full h-1.5 rounded-full appearance-none cursor-pointer
            bg-rule
            [&::-webkit-slider-thumb]:appearance-none
            [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4
            [&::-webkit-slider-thumb]:rounded-full
            [&::-webkit-slider-thumb]:bg-brand
            [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-surface
            [&::-webkit-slider-thumb]:shadow
            [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4
            [&::-moz-range-thumb]:rounded-full
            [&::-moz-range-thumb]:bg-brand
            [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-surface
            [&::-moz-range-thumb]:cursor-pointer
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50
          "
        />
        <button
          type="button"
          onClick={() => writeThresholds({ ...thresholds, [spec.key]: spec.calibrated })}
          title={`Snap to calibrated (${calibratedFmt})`}
          aria-label={`Snap ${spec.label} to calibrated ${calibratedFmt}`}
          className="absolute -top-1 w-2 h-2 -ml-1 bg-ink-mute hover:bg-brand transition-colors rounded-full"
          style={{ left: `${calibratedPct}%` }}
        />
      </div>
      <div className="flex items-baseline justify-between mt-1.5">
        <p className="text-[11px] text-ink-soft leading-snug max-w-[420px]">{spec.caption}</p>
        <span className="font-mono text-[10px] text-ink-mute shrink-0 ml-2">cal. {calibratedFmt}</span>
      </div>
    </div>
  );
}
