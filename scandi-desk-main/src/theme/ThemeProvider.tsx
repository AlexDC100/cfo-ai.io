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

import {
  ThemeProvider as NextThemesProvider,
  type ThemeProviderProps,
} from "next-themes";

export type CFOThemeProviderProps = Omit<ThemeProviderProps, "attribute" | "enableSystem"> & {
  attribute?: ThemeProviderProps["attribute"];
  enableSystem?: boolean;
};

export function ThemeProvider({
  attribute = "class",
  enableSystem = true,
  defaultTheme = "system",
  disableTransitionOnChange = false,
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
