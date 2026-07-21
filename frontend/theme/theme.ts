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
  bg:           "#F7F7F7",
  surface:      "#FFFFFF",
  surfaceSoft:  "#F2F2F2",
  surfaceHover: "#ECECEC",
  border:       "#E0E0E0",
  borderStrong: "#CCCCCC",
  text:         "#151515",
  textMuted:    "#6A6A6A",
  textSoft:     "#979797",
  primary:      "#5CD3C5",
  primaryHover: "#2AA89B",
  gold:         "#5CD3C5",
  goldSoft:     "#8FE3D9",
  danger:       "#B83A2A",
  warning:      "#5CD3C5",
  success:      "#2AA89B",
  info:         "#2AA89B",
};

export const darkTheme: ThemePalette = {
  bg:           "#0A0A0A",
  surface:      "#141414",
  surfaceSoft:  "#1B1B1B",
  surfaceHover: "#242424",
  border:       "rgba(255,255,255,0.08)",
  borderStrong: "rgba(255,255,255,0.14)",
  text:         "#F5F5F5",
  textMuted:    "#ABABAB",
  textSoft:     "#8A8A8A",
  primary:      "#5CD3C5",
  primaryHover: "#2AA89B",
  gold:         "#5CD3C5",
  goldSoft:     "#8FE3D9",
  danger:       "#FF5A5A",
  warning:      "#5CD3C5",
  success:      "#5CD3C5",
  info:         "#78DCD0",
};

export function paletteFor(theme: Exclude<ThemeName, "system">): ThemePalette {
  return theme === "dark" ? darkTheme : lightTheme;
}
