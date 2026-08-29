// Static palette objects for the two themes — useful for places that can't
// read CSS variables (canvas drawing, SVG generation, server-rendered emails).
// For runtime UI styling, prefer Tailwind classes that resolve through the
// CSS vars in index.css; this file is the escape hatch.
//
// Values mirror the token sheet (index.css): Paper (light) / Terminal (dark),
// hand-converted from the HSL tokens. If a token changes there, re-derive here.

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

// Paper — mirrors :root in index.css.
export const lightTheme: ThemePalette = {
  bg:           "#FAFAF7", // --bg
  surface:      "#FDFDFB", // --surface
  surfaceSoft:  "#F4F4F0", // --surface-soft
  surfaceHover: "#F4F4F0", // --surface-hover
  border:       "#E1E2DF", // --rule
  borderStrong: "#D4D5D2", // --rule-strong
  text:         "#0B0E0D", // --ink
  textMuted:    "#5C6662", // --ink-soft
  textSoft:     "#808A85", // --ink-mute
  primary:      "#0E7C6B", // --brand
  primaryHover: "#0B6B5C", // --primary-hover
  gold:         "#0E7C6B", // --brand-2 (aliases brand)
  goldSoft:     "#3D8F83", // --brand-l
  danger:       "#AF261D", // --alert
  warning:      "#915F08", // --caution
  success:      "#107061", // --success
  info:         "#5A6672", // --info
};

// Terminal — mirrors .dark in index.css.
export const darkTheme: ThemePalette = {
  bg:           "#080D0B", // --bg
  surface:      "#0F1513", // --surface
  surfaceSoft:  "#141A18", // --surface-soft
  surfaceHover: "#1B2220", // --surface-hover
  border:       "#222A27", // --rule
  borderStrong: "#343D39", // --rule-strong
  text:         "#E9EDEB", // --ink
  textMuted:    "#9EA9A4", // --ink-soft
  textSoft:     "#798680", // --ink-mute
  primary:      "#4EBCA6", // --brand
  primaryHover: "#60C7B3", // --primary-hover
  gold:         "#4EBCA6", // --brand-2 (aliases brand)
  goldSoft:     "#81CFBD", // --brand-l
  danger:       "#E0655C", // --alert
  warning:      "#DAAB4E", // --caution
  success:      "#4EBCA6", // --success
  info:         "#90A1AD", // --info
};

export function paletteFor(theme: Exclude<ThemeName, "system">): ThemePalette {
  return theme === "dark" ? darkTheme : lightTheme;
}
