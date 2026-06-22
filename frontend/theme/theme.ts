// Static palette objects for the two themes — useful for places that can't
// read CSS variables (canvas drawing, SVG generation, server-rendered emails).
// For runtime UI styling, prefer Tailwind classes that resolve through the
// CSS vars in index.css; this file is the escape hatch.

export type ThemeName = "light" | "dark" | "system";

export interface ThemePalette {
  bg: string;
  surface: string;
  surfaceSoft: string;
  surfaceHover: string;
  border: string;
  borderStrong: string;
  text: string;
  textMuted: string;
  textSoft: string;
  primary: string;
  primaryHover: string;
  gold: string;
  goldSoft: string;
  danger: string;
  warning: string;
  success: string;
  info: string;
}

export const lightTheme: ThemePalette = {
  bg:           "#FAFAF7",
  surface:      "#FFFFFF",
  surfaceSoft:  "#F5F3EE",
  surfaceHover: "#F1EFEA",
  border:       "#E7E1D7",
  borderStrong: "#D7D1C5",
  text:         "#14141A",
  textMuted:    "#6E6A63",
  textSoft:     "#9B978E",
  primary:      "#2DBFB3",
  primaryHover: "#23A89D",
  gold:         "#C9A24A",
  goldSoft:     "#D6B770",
  danger:       "#B83A2A",
  warning:      "#B7791F",
  success:      "#257A4F",
  info:         "#2F5F8F",
};

export const darkTheme: ThemePalette = {
  bg:           "#05070A",
  surface:      "#0D131A",
  surfaceSoft:  "#111A24",
  surfaceHover: "#18222E",
  border:       "rgba(255,255,255,0.08)",
  borderStrong: "rgba(255,255,255,0.14)",
  text:         "#F4F6F8",
  textMuted:    "#A2ACB8",
  textSoft:     "#7F8B99",
  primary:      "#2ED3C6",
  primaryHover: "#20BEB2",
  gold:         "#D6A84F",
  goldSoft:     "#E5BE72",
  danger:       "#FF5A5A",
  warning:      "#F6B44A",
  success:      "#35C77B",
  info:         "#4AA3FF",
};

export function paletteFor(theme: Exclude<ThemeName, "system">): ThemePalette {
  return theme === "dark" ? darkTheme : lightTheme;
}
