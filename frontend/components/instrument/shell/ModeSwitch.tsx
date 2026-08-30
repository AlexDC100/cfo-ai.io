// THE DIAL — the Simple | Pro switcher (Prompt 12, Part A).
//
// Presentation only: flipping the dial re-arranges, re-labels and
// re-discloses — it never changes a value (Gate M1 asserts cent-identical
// figures in both modes). lib/viewMode owns all persistence (localStorage
// as source of first paint + user_prefs mirror via setPref); this
// component is a dumb radiogroup over useViewMode()/setViewMode().
//
// It also seats the remote-adoption hook: mounted on every authed route
// (TopHeader) it is the one place that watches user_prefs.view_mode, so a
// choice made on another device lands here without a reload — the same
// contract AppearanceSection follows for density.
//
// Two labels, 11px mono caps, accent underline on the active segment —
// quiet enough for the command deck, reused as-is in Settings > Appearance.

import { useTranslation } from "react-i18next";

import { usePrefSync } from "@/lib/prefs";
import { cn } from "@/lib/utils";
import {
  adoptRemoteViewMode,
  setViewMode,
  useViewMode,
  type ViewMode,
} from "@/lib/viewMode";
import "./modeI18n";

const OPTIONS: Array<{ value: ViewMode; labelKey: string }> = [
  { value: "simple", labelKey: "modes.switch.simple" },
  { value: "pro", labelKey: "modes.switch.pro" },
];

/** Cross-device adoption for the view mode, with NO UI.
 *
 *  The switch itself moved out of the header into the avatar menu
 *  (2026-08-30 Capsule directive), and that menu's content only mounts
 *  while the dropdown is OPEN — so the sync had to be re-seated
 *  somewhere always-mounted. TopHeader calls this hook directly. */
export function useViewModeSync(): void {
  const mode = useViewMode();
  // Hands a differing remote value to the lib, which re-notifies every
  // useViewMode() subscriber. adoptRemoteViewMode validates and
  // deliberately does NOT echo back via setPref.
  usePrefSync<string>("user", "view_mode", mode, adoptRemoteViewMode);
}

export function ModeSwitch({ className }: { className?: string }) {
  const { t } = useTranslation();
  const mode = useViewMode();
  useViewModeSync();

  return (
    <div
      role="radiogroup"
      aria-label={t("modes.switch.label")}
      data-testid="mode-switch"
      className={cn(
        "inline-flex items-center rounded-sm border border-rule bg-bg-2 p-0.5",
        className,
      )}
    >
      {OPTIONS.map((opt) => {
        const active = opt.value === mode;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            data-testid={`mode-switch-${opt.value}`}
            onClick={() => setViewMode(opt.value)}
            className={cn(
              // 40px touch target on phones (Settings is the only <sm
              // mount); 28px inside the header rail on sm+ — matching the
              // Settings SegmentedControl's responsive pattern.
              "relative inline-flex h-10 items-center rounded-[3px] px-2.5 font-mono text-[11px] uppercase tracking-[0.1em] transition-colors duration-micro sm:h-7",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active ? "bg-surface text-ink" : "text-ink-soft hover:text-ink",
            )}
          >
            {t(opt.labelKey)}
            {/* Accent underline — the active marker. */}
            {active ? (
              <span
                aria-hidden
                className="absolute inset-x-2 bottom-[3px] h-[2px] rounded-full bg-brand"
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
