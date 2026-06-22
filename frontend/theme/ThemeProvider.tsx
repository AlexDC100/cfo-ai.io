// CFO AI ThemeProvider — wraps next-themes with the project's defaults.
//
// next-themes already handles:
//   · system theme detection (`enableSystem`)
//   · localStorage persistence
//   · setting the `class` (or `data-theme`) attribute on <html>
//   · prefers-color-scheme observation
//
// This wrapper just centralises the configuration so App.tsx and any test
// harness import a single component. It also gives us a place to hang the
// brief `theme-flipping` class trick if we ever want to coordinate a more
// elaborate transition than the 220ms CSS rule in index.css.

import { ComponentProps } from "react";
import { ThemeProvider as NextThemesProvider } from "next-themes";

// next-themes ≥0.3 removed the named `ThemeProviderProps` export; derive
// the prop type from the component itself so we don't break on upgrades.
type ThemeProviderProps = ComponentProps<typeof NextThemesProvider>;

export type CFOThemeProviderProps = Omit<ThemeProviderProps, "attribute" | "enableSystem"> & {
  attribute?: ThemeProviderProps["attribute"];
  enableSystem?: boolean;
};

export function ThemeProvider({
  attribute = "class",
  enableSystem = true,
  defaultTheme = "system",
  // 2026-05-24 — flipped from false → true to fix a stale-transition
  // cache bug. When `disableTransitionOnChange=false`, any element with
  // `transition-colors` or similar would keep its OLD computed color
  // across the theme switch because the CSS transition kept the cached
  // start value. Visible symptoms: body bg stayed light-cream after
  // switch to dark (showed through 40% modal backdrops), buttons with
  // `bg-ink text-paper` showed inverted colors (dark-mode tokens in
  // light mode). next-themes' built-in fix injects a momentary
  // `* { transition: none !important }` <style> tag during the swap,
  // forces a paint with the new var values, then removes the override.
  disableTransitionOnChange = true,
  storageKey = "cfoai_theme",
  children,
  ...rest
}: CFOThemeProviderProps) {
  return (
    <NextThemesProvider
      attribute={attribute}
      enableSystem={enableSystem}
      defaultTheme={defaultTheme}
      disableTransitionOnChange={disableTransitionOnChange}
      storageKey={storageKey}
      {...rest}
    >
      {children}
    </NextThemesProvider>
  );
}
