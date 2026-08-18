// Shell chrome colors, mirroring the web app's design tokens
// (frontend/index.css): brand teal #5CD3C5, ink/soft-ink neutrals.
// The WebView content themes itself; these only style the native frame.

import type { ColorSchemeName } from "react-native";

export const BRAND = "#5CD3C5";

export type Palette = {
  background: string;
  surface: string;
  text: string;
  textMute: string;
  border: string;
  tabActive: string;
  tabInactive: string;
};

export function palette(scheme: ColorSchemeName): Palette {
  const dark = scheme === "dark";
  return {
    background: dark ? "#0C1210" : "#FFFFFF",
    surface: dark ? "#101816" : "#FFFFFF",
    text: dark ? "#E8F1EE" : "#0B1220",
    textMute: dark ? "#8FA39D" : "#5B6B66",
    border: dark ? "#1E2A26" : "#E4EAE8",
    // Brand teal is too light for an active tint on white — darken in light mode.
    tabActive: dark ? BRAND : "#0E8E7F",
    tabInactive: dark ? "#748881" : "#93A29D",
  };
}
