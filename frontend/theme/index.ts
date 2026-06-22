// Public surface of the theme module — import from here, not subpaths.

export { ThemeProvider } from "./ThemeProvider";
export type { CFOThemeProviderProps } from "./ThemeProvider";
export { useTheme } from "./useTheme";
export type { Theme, UseThemeResult } from "./useTheme";
export { lightTheme, darkTheme, paletteFor } from "./theme";
export type { ThemePalette, ThemeName } from "./theme";
export { tokenVar, tokenHsl } from "./tokens";
export type { Token, SurfaceToken, InkToken, BorderToken, BrandToken, StateToken } from "./tokens";
