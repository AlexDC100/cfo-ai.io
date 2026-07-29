// CFO AI design tokens — single source of truth for the names that
// components, Tailwind config, and the theme/ helpers all agree on.
//
// The actual color values live in src/index.css under :root (light) and
// .dark (dark mode). Components consume tokens via:
//   · Tailwind classes — `bg-bg`, `text-ink`, `border-rule`, `bg-surface`, …
//   · `var(--token)` directly when arbitrary inline styles are needed
//
// NEVER hard-code hex values inside components. If a new shade is needed,
// add it here AND register the CSS variable AND the Tailwind alias.

export type SurfaceToken =
  | "bg"
  | "bg-2"
  | "surface"
  | "surface-soft"
  | "surface-hi"
  | "surface-hover";

export type InkToken =
  | "ink"
  | "ink-2"
  | "ink-soft"
  | "ink-mute"
  | "ink-faint"
  | "text"
  | "text-muted"
  | "text-soft";

export type BorderToken = "rule" | "rule-soft" | "rule-strong" | "border" | "border-strong";

export type BrandToken =
  | "brand"
  | "brand-d"
  | "brand-l"
  | "brand-tint"
  | "primary"
  | "primary-hover"
  | "brand-2"
  | "gold"
  | "gold-soft";

export type StateToken =
  | "success"
  | "success-tint"
  | "caution"
  | "caution-tint"
  | "alert"
  | "alert-tint"
  | "danger"
  | "info"
  | "info-tint"
  | "warning";

export type Token = SurfaceToken | InkToken | BorderToken | BrandToken | StateToken;

/** Resolve a token name to its CSS `var(--…)` form. Useful for inline style
 *  fallbacks when Tailwind classes don't fit (e.g., dynamic gradients). */
export function tokenVar(name: Token): string {
  return `var(--${name})`;
}

/** Resolve to `hsl(var(--token))` — matches the format Tailwind uses
 *  internally for our color aliases. */
export function tokenHsl(name: Token): string {
  return `hsl(var(--${name}))`;
}
