// Three-way theme picker — System · Paper · Terminal — as explicit radio
// buttons. Lives in the sidebar for guests (no account menu there) and, since
// 2026-09-08 (per operator), inside the account bottom sheet under Settings ·
// Log out for signed-in users in the shell.

import { useTranslation } from "react-i18next";
import { Monitor, Moon, SunMedium } from "lucide-react";
import { useTheme } from "@/theme";

type Props = {
  /** Icon-only column (collapsed desktop rail). */
  collapsed?: boolean;
  testIdPrefix?: string;
  className?: string;
  /** Fixed button height in px (overrides the 44px touch-target default) —
   *  the account sheet matches its Settings · Log out row. */
  buttonHeight?: number;
};

export function ThemePicker({ collapsed = false, testIdPrefix = "theme", className = "", buttonHeight }: Props) {
  const { t } = useTranslation();
  const { theme, setTheme, mounted } = useTheme();
  return (
    <div
      role="radiogroup"
      aria-label={t("account.theme")}
      data-testid={`${testIdPrefix}-picker`}
      className={`flex gap-1 ${collapsed ? "flex-col" : ""} ${className}`}
    >
      {([
        ["system", Monitor],
        ["light", SunMedium],
        ["dark", Moon],
      ] as const).map(([m, Icon]) => {
        const active = mounted && theme === m;
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={active}
            data-testid={`${testIdPrefix}-${m}`}
            title={collapsed ? t(`account.theme_${m}`) : undefined}
            onClick={() => setTheme(m)}
            style={buttonHeight ? { height: buttonHeight, minHeight: 0 } : undefined}
            className={`flex-1 flex items-center justify-center gap-1.5 rounded-md ${buttonHeight ? "" : "min-h-[44px] sm:min-h-0 sm:h-8"} px-1 text-[12px] transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              active
                ? "bg-bg-2 text-ink font-medium"
                : "text-ink-soft hover:text-ink hover:bg-bg-2/60"
            }`}
          >
            <Icon size={14} strokeWidth={1.75} className="shrink-0" />
            {!collapsed && <span className="whitespace-nowrap">{t(`account.theme_${m}`)}</span>}
          </button>
        );
      })}
    </div>
  );
}
