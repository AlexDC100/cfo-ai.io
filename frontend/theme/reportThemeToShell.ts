import { isNativeShell, postToNativeShell } from "@/lib/nativeShell";

/** Post the page's CURRENT theme colours to the shell (reads the live
 *  `--bg` / `--brand` tokens). Also used by full-screen overlays to hand
 *  the real theme back when they close. */
export function reportThemeToShell(dark: boolean, mode: "system" | "explicit"): void {
  if (!isNativeShell()) return;
  // The `--bg` token is "h s% l%" (Tailwind hsl-var form); RN wants
  // "hsl(h, s%, l%)".
  const token = (name: string): string | undefined => {
    const parts = getComputedStyle(document.documentElement).getPropertyValue(name).trim().split(/\s+/);
    return parts.length === 3 ? `hsl(${parts[0]}, ${parts[1]}, ${parts[2]})` : undefined;
  };
  postToNativeShell({
    source: "cfo-ai",
    type: "theme",
    theme: dark ? "dark" : "light",
    bg: token("--bg"),
    accent: token("--brand"),
    mode,
  });
}
