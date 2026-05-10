// Apple-modern theme toggle. Three states: light → dark → system.
// Persists via next-themes (localStorage); first paint avoids the flash of
// wrong theme by reading the resolved theme on mount.

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Sun, Moon, Monitor } from "lucide-react";

const ORDER = ["light", "dark", "system"] as const;
type Mode = (typeof ORDER)[number];

const ICON: Record<Mode, typeof Sun> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
};
const LABEL: Record<Mode, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted) {
    // Reserve layout space; avoids hydration flicker.
    return <span className={compact ? "w-8 h-8" : "w-[112px] h-8"} aria-hidden />;
  }

  const current = (theme as Mode) ?? "system";

  function cycle() {
    const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];
    setTheme(next);
  }

  if (compact) {
    const Icon = ICON[current];
    return (
      <button
        onClick={cycle}
        aria-label={`Theme: ${LABEL[current]}. Click to change.`}
        title={`Theme: ${LABEL[current]}`}
        className="
          inline-flex items-center justify-center
          h-8 w-8 rounded-md
          text-ink-soft hover:text-ink
          hover:bg-bg-2 transition-colors
        "
      >
        <Icon size={15} strokeWidth={1.75} />
      </button>
    );
  }

  // Segmented control — Apple-style. Sun / Moon / Monitor pills.
  return (
    <div
      role="tablist"
      aria-label="Theme"
      className="inline-flex items-center gap-0.5 p-0.5 rounded-md bg-bg-2 border border-rule/40"
    >
      {ORDER.map((mode) => {
        const Icon = ICON[mode];
        const active = current === mode;
        return (
          <button
            key={mode}
            role="tab"
            aria-selected={active}
            aria-label={LABEL[mode]}
            title={LABEL[mode]}
            onClick={() => setTheme(mode)}
            className={`
              inline-flex items-center justify-center
              h-7 w-8 rounded
              transition-colors duration-150
              ${active
                ? "bg-surface text-ink shadow-1"
                : "text-ink-mute hover:text-ink-soft"}
            `}
          >
            <Icon size={13} strokeWidth={1.75} />
          </button>
        );
      })}
    </div>
  );
}
