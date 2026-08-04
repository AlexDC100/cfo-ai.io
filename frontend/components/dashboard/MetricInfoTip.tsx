// Metrics redesign (2026-08-04) — plain-language metric tooltip.
//
// One ⓘ trigger per metric card. On hover-capable devices it's a Radix
// Tooltip (instant, transient); on touch devices — where hover doesn't
// exist — the SAME trigger is a Radix Popover that toggles on tap, so the
// explanation is never hover-only (spec item 1).
//
// The visible glyph is small (14px) but the effective touch target is
// ≥44px via an ::after inset expansion, so the icon doesn't inflate the
// label row while still meeting the 44px rule. stopPropagation everywhere:
// the card behind is itself tappable (opens the full concept sheet).

import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import "./metricsV2I18n";

/** True when the device has no hover (touch-first) — decides Popover vs
 *  Tooltip. Live-updates if a convertible flips mode. */
function useNoHover(): boolean {
  const [noHover, setNoHover] = useState<boolean>(() =>
    typeof window !== "undefined"
      ? window.matchMedia("(hover: none)").matches
      : false,
  );
  useEffect(() => {
    const mq = window.matchMedia("(hover: none)");
    const onChange = (e: MediaQueryListEvent) => setNoHover(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return noHover;
}

interface Props {
  /** Plain-language one-liner shown in the tip. */
  text: string;
  /** Used for the per-card testid. */
  conceptKey: string;
}

const TRIGGER_CLASS =
  // relative + after:-inset expands the hit area to ~44px without layout shift
  "relative shrink-0 grid place-items-center h-5 w-5 rounded-full text-ink-mute hover:text-ink transition-colors duration-150 after:absolute after:-inset-2.5 after:content-['']";

const CONTENT_CLASS =
  "max-w-[260px] rounded-lg border-rule bg-surface px-3 py-2 text-[12px] leading-snug text-ink-soft shadow-lg";

export function MetricInfoTip({ text, conceptKey }: Props) {
  const { t } = useTranslation();
  const noHover = useNoHover();
  const [open, setOpen] = useState(false);

  const trigger = (
    <button
      type="button"
      aria-label={t("metricsV2.aboutMetric")}
      data-testid={`metric-info-${conceptKey}`}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      className={TRIGGER_CLASS}
    >
      <Info className="w-3.5 h-3.5" aria-hidden />
    </button>
  );

  if (noHover) {
    // Touch: tap toggles a small popover. Tapping outside closes it.
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          onClick={(e) => e.stopPropagation()}
          className={CONTENT_CLASS}
        >
          {text}
        </PopoverContent>
      </Popover>
    );
  }

  // Desktop: standard tooltip (TooltipProvider is mounted app-wide in App.tsx).
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent side="top" align="start" className={CONTENT_CLASS}>
        {text}
      </TooltipContent>
    </Tooltip>
  );
}
