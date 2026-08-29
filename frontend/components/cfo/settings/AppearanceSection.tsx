// Settings → Appearance — theme (Paper / Terminal) + density.
//
// Theme rides the existing next-themes pipeline via @/theme's useTheme:
// values stay "light" / "dark" (storage, prefs sync and the .dark class
// strategy all keep working); only the LABELS say Paper / Terminal.
//
// Density is a new personal preference:
//   · applied as `data-density="comfortable|compact"` on <html>. Table
//     surfaces opt in with CSS like
//       [data-density="compact"] .some-row { … }
//     Nothing consumes it yet — the attribute is the contract.
//   · localStorage (DENSITY_STORAGE_KEY) is the source of first paint,
//     mirrored to user prefs (key "density") through lib/prefs so the
//     choice follows the user to other devices. The attribute is applied
//     at module load, so any screen that imports this file (Settings
//     today) restores it without waiting for React.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useTheme } from "@/theme";
import { setPref, usePrefSync } from "@/lib/prefs";
import { SegmentedControl } from "./SegmentedControl";

export type Density = "comfortable" | "compact";

const DENSITY_STORAGE_KEY = "cfo-density-v1";
const DENSITY_PREF_KEY = "density";

function isDensity(v: unknown): v is Density {
  return v === "comfortable" || v === "compact";
}

export function readStoredDensity(): Density {
  try {
    const v = localStorage.getItem(DENSITY_STORAGE_KEY);
    if (isDensity(v)) return v;
  } catch {
    /* private mode */
  }
  return "comfortable";
}

/** Stamp the attribute table consumers read. Safe to call repeatedly. */
export function applyDensityAttr(d: Density): void {
  try {
    document.documentElement.dataset.density = d;
  } catch {
    /* SSR / detached */
  }
}

// Restore on module load so a reload doesn't lose the attribute before
// the section mounts.
applyDensityAttr(readStoredDensity());

export function AppearanceSection() {
  const { t } = useTranslation();
  const { theme, setTheme, mounted } = useTheme();
  const [density, setDensity] = useState<Density>(() => readStoredDensity());

  useEffect(() => {
    applyDensityAttr(density);
  }, [density]);

  const pickDensity = useCallback((d: Density) => {
    setDensity(d);
    applyDensityAttr(d);
    try {
      localStorage.setItem(DENSITY_STORAGE_KEY, d);
    } catch {
      /* private mode */
    }
    setPref("user", DENSITY_PREF_KEY, d);
  }, []);

  // Adopt a density chosen on another device. localStorage + attribute are
  // re-written locally; setPref is NOT called back (that would echo).
  const adoptDensity = useCallback((remote: Density) => {
    if (!isDensity(remote)) return;
    setDensity(remote);
    applyDensityAttr(remote);
    try {
      localStorage.setItem(DENSITY_STORAGE_KEY, remote);
    } catch {
      /* private mode */
    }
  }, []);
  usePrefSync<Density>("user", DENSITY_PREF_KEY, density, adoptDensity);

  // next-themes resolves after first client render; render the control
  // only once mounted so the active segment can't flash the wrong theme.
  const themeValue: "light" | "dark" = theme === "dark" ? "dark" : "light";

  return (
    <div className="space-y-5">
      <div>
        <div className="mb-1.5 text-[10.5px] font-medium uppercase tracking-[0.08em] text-ink-mute">
          {t("settingsX.appearance.theme_label")}
        </div>
        {mounted ? (
          <SegmentedControl
            value={themeValue}
            onChange={(v) => setTheme(v)}
            ariaLabel={t("settingsX.appearance.theme_label")}
            options={[
              {
                value: "light",
                label: t("settingsX.appearance.theme_paper"),
                testId: "settings-theme-paper",
              },
              {
                value: "dark",
                label: t("settingsX.appearance.theme_terminal"),
                testId: "settings-theme-terminal",
              },
            ]}
          />
        ) : (
          <div className="h-9 sm:h-8" aria-hidden />
        )}
        <p className="mt-1.5 text-[11px] text-ink-mute">
          {t("settingsX.appearance.theme_hint")}
        </p>
      </div>

      <div>
        <div className="mb-1.5 text-[10.5px] font-medium uppercase tracking-[0.08em] text-ink-mute">
          {t("settingsX.appearance.density_label")}
        </div>
        <SegmentedControl
          value={density}
          onChange={pickDensity}
          ariaLabel={t("settingsX.appearance.density_label")}
          options={[
            {
              value: "comfortable",
              label: t("settingsX.appearance.density_comfortable"),
              testId: "settings-density-comfortable",
            },
            {
              value: "compact",
              label: t("settingsX.appearance.density_compact"),
              testId: "settings-density-compact",
            },
          ]}
        />
        <p className="mt-1.5 text-[11px] text-ink-mute">
          {t("settingsX.appearance.density_hint")}
        </p>
      </div>
    </div>
  );
}
