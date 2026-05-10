// Re-export of next-themes' useTheme hook so app code imports from a stable
// path under @/theme. If we ever swap themes infra, callers don't change.

import { useTheme as useNextTheme } from "next-themes";
import { useEffect, useState } from "react";

export type Theme = "light" | "dark" | "system";

export interface UseThemeResult {
  theme: Theme | undefined;
  /** The resolved theme — "light" or "dark" — taking system preference into account. */
  resolvedTheme: "light" | "dark" | undefined;
  setTheme: (t: Theme) => void;
  /** True after first render in the browser. Avoids hydration mismatch when
   *  rendering theme-dependent UI before the cookie/localStorage value is read. */
  mounted: boolean;
}

export function useTheme(): UseThemeResult {
  const { theme, resolvedTheme, setTheme } = useNextTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return {
    theme: theme as Theme | undefined,
    resolvedTheme: resolvedTheme as "light" | "dark" | undefined,
    setTheme: (t) => setTheme(t),
    mounted,
  };
}
