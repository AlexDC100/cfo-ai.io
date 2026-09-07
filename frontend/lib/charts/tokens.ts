// THE PRINT PALETTE FOR CHARTS — one accent, a tone ramp, red for breaches.
//
// The standalone report is a generated document: it cannot read the app's
// token sheet (`frontend/index.css`), so the values are baked here, once,
// for every chart in the document. Every literal below carries the
// `design-lint-allow-hex` escape the D5 rule defines for exactly this
// case (a document rendered outside the app's CSS).
//
// GREYSCALE IS THE DESIGN CONSTRAINT, not an afterthought. A board pack
// is printed on a mono laser more often than it is read on a screen, so:
//
//   1. the categorical ramp is a LIGHTNESS ramp, not a hue wheel — the
//      five tones stay distinguishable when hue is thrown away;
//   2. every segment/bar carries its own text label and its own printed
//      figure, so colour is never the only channel carrying meaning;
//   3. the one semantic colour (red) is reserved for a BREACH and is
//      doubled by a glyph, so a greyscale reader still sees it.
//
// `ACCENT` is the document's single accent (the same teal the report's
// `--accent` uses). It marks the SUBJECT of a chart — the current
// period's total, the measured value on a band track — and nothing else.

/* design-lint-allow-hex — standalone generated report document (whole file) */

export const INK = "#0B0E0D"; /* design-lint-allow-hex standalone generated report document */
export const INK_SOFT = "#454B56"; /* design-lint-allow-hex standalone generated report document */
export const INK_MUTE = "#6B7280"; /* design-lint-allow-hex standalone generated report document */
export const RULE = "#C9CDD2"; /* design-lint-allow-hex standalone generated report document */
export const RULE_SOFT = "#E5E7EB"; /* design-lint-allow-hex standalone generated report document */
export const PAPER = "#FFFFFF"; /* design-lint-allow-hex standalone generated report document */
export const ACCENT = "#0E7C6B"; /* design-lint-allow-hex standalone generated report document */
export const ACCENT_SOFT = "#B9DBD4"; /* design-lint-allow-hex standalone generated report document */
/** Semantic red — a BREACH only. Never a category, never "negative". */
export const BREACH = "#8B1A1A"; /* design-lint-allow-hex standalone generated report document */
export const BREACH_SOFT = "#E8D6D6"; /* design-lint-allow-hex standalone generated report document */

/**
 * The categorical ramp, ordered dark → light. Read as five distinct
 * greys at 0 % saturation; each step is ≥ 12 points of L* from its
 * neighbour, which is the smallest gap a 600-dpi mono laser resolves
 * reliably on a 4 mm bar.
 */
export const RAMP: readonly string[] = [
  "#2F3A38", /* design-lint-allow-hex standalone generated report document */
  "#55635F", /* design-lint-allow-hex standalone generated report document */
  "#7E8B87", /* design-lint-allow-hex standalone generated report document */
  "#A9B3B0", /* design-lint-allow-hex standalone generated report document */
  "#D2D8D6", /* design-lint-allow-hex standalone generated report document */
];

/** A deterministic ramp pick — never a random or index-out-of-range read. */
export function rampTone(i: number): string {
  return RAMP[((i % RAMP.length) + RAMP.length) % RAMP.length];
}

/**
 * Waterfall step tones. A DELTA is read by direction, not by hue: the
 * `+`/`−` prefix on its own label carries the sign, the tone only
 * separates it from the anchors it sits between.
 */
export const STEP_ANCHOR = "#2F3A38"; /* design-lint-allow-hex standalone generated report document */
export const STEP_UP = "#55635F"; /* design-lint-allow-hex standalone generated report document */
export const STEP_DOWN = "#A9B3B0"; /* design-lint-allow-hex standalone generated report document */

/**
 * Hatch pattern for a bar whose value is an APPROXIMATION the engine
 * flagged (`assembled_cf.is_approximated`). A hatched bar is visibly not
 * a measured one, in colour and in greyscale alike.
 */
export const HATCH_ID = "cfoai-hatch-approx";

export function hatchDefs(): string {
  return (
    `<defs><pattern id="${HATCH_ID}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
    `<rect width="6" height="6" fill="${PAPER}"/>` +
    `<line x1="0" y1="0" x2="0" y2="6" stroke="${INK_MUTE}" stroke-width="2.4"/>` +
    `</pattern></defs>`
  );
}
