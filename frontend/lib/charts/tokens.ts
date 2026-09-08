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

// ── INK ON A GROUND ────────────────────────────────────────────────────
//
// A label printed INSIDE a filled shape has two colours, and only one of
// them was ever chosen: the ink was a constant and the ground was
// whatever the ramp handed the slice. `primitives.ts` set every
// in-segment label to `PAPER` unconditionally, and the ramp runs dark to
// light, so the two lightest tones carried white text.
//
// MEASURED on the delivered Agras PDF, at 300 dpi, before this helper
// existed (`RECEIVABLES` and `PAYABLES` are the two working-capital
// lines of the balance sheet, and the first graphic in the pack):
//
//     Receivables  ground RAMP[4]  ink PAPER      1.44 : 1   ~5.9 pt
//     Payables     ground RAMP[4]  ink PAPER      1.44 : 1   ~5.9 pt
//     Inventory    ground RAMP[3]  ink PAPER      2.15 : 1   ~5.9 pt
//     "strong"     ground RAMP[1]  ink INK_SOFT   1.39 : 1   ~5.2 pt
//     "healthy"    ground RAMP[2]  ink INK_SOFT   2.48 : 1   ~5.2 pt
//
// WCAG AA is 4.5 : 1 for text this size; 3 : 1 is the LARGE-text floor
// and these are nowhere near even that. The file's own header claims
// "colour is never the only channel" — on those slices there was no
// channel at all.
//
// The ink is now DERIVED FROM THE GROUND. Every ramp tone clears 4.5 : 1
// against one of the document's two inks, so the derivation always has
// an answer:
//
//     RAMP[0] → PAPER 11.78   RAMP[1] → PAPER 6.29   RAMP[2] → INK  5.49
//     RAMP[3] → INK    9.03   RAMP[4] → INK   13.45

/** The floor a printed label must clear against what it sits on. */
export const MIN_TEXT_CONTRAST = 4.5;

/** WCAG relative luminance of a `#rrggbb` literal. */
export function relativeLuminance(hex: string): number {
  const ch = (at: number): number => {
    const v = parseInt(hex.slice(at, at + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(1) + 0.7152 * ch(3) + 0.0722 * ch(5);
}

/** WCAG contrast ratio between two `#rrggbb` literals. Always ≥ 1. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * The ink to print ON `ground`.
 *
 * `preferred` is the design's first choice — white inside a dark slice,
 * the muted slate on a band zone. It is honoured WHEN IT IS LEGIBLE and
 * dropped when it is not, in favour of whichever of the document's two
 * inks contrasts more. Legibility wins over the preference; it does not
 * negotiate with it.
 *
 * Passing no preference asks for the most legible ink outright.
 */
export function inkOn(ground: string, ...preferred: string[]): string {
  for (const p of preferred) {
    if (contrastRatio(p, ground) >= MIN_TEXT_CONTRAST) return p;
  }
  return contrastRatio(PAPER, ground) >= contrastRatio(INK, ground) ? PAPER : INK;
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
