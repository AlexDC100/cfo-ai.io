// CFO AI brand mark — angular hexagonal monogram.
//
// Geometry (matches the brand reference):
//   · Left half — a chunky teal "C" rendered as a hexagonal frame with
//     the right side cut out. Six vertices outside, four vertices inside
//     forming the inner notch.
//   · Right half — a forward-leaning angular "A" peak. The apex points
//     up at the same height as the C's top-right; the wing splays down
//     to the bottom-right, mirroring the C's chevron silhouette.
//
// Color rules:
//   · The C is always teal (--brand). It's the brand-primary signal —
//     never themed away.
//   · The A inherits `currentColor`, so it flips to ink in light mode
//     and ivory in dark mode automatically.
//   · `monochrome=true` collapses both shapes to currentColor — used by
//     the favicon SVG and any single-ink contexts.
//
// The mark is filled (no strokes) so it stays crisp at every size from
// 16px favicon to 80px hero. The viewBox (0 0 64 64) keeps it square.

interface Props {
  size?: number;
  /** Use a single color for both shapes — favicon, monochrome contexts. */
  monochrome?: boolean;
  className?: string;
  /** Override the C fill (otherwise uses --brand). */
  cFill?: string;
  /** Override the A fill (otherwise uses currentColor → theme ink). */
  aFill?: string;
}

export function Mark({ size = 32, monochrome = false, className = "", cFill, aFill }: Props) {
  const cColor = monochrome ? "currentColor" : (cFill ?? "hsl(var(--brand))");
  const aColor = monochrome ? "currentColor" : (aFill ?? "currentColor");

  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      role="img"
      aria-label="CFO AI"
      className={`shrink-0 ${className}`}
    >
      {/* Teal C — angular hexagonal frame with right side notched out.
          Outer goes clockwise from top-right; inner goes counter-clockwise
          to carve the negative space that lets the A read through. */}
      <path
        d="
          M 30 4
          L 4 20
          L 4 44
          L 30 60
          L 30 50
          L 14 41
          L 14 23
          L 30 14
          Z
        "
        fill={cColor}
      />

      {/* A peak — apex aligned with the C's upper inner notch, splaying
          to the bottom-right corner. Single filled wedge so it stays
          razor-sharp across sizes. The shape reads as "the right half
          of an A" alongside the C, completing the CA monogram. */}
      <path
        d="
          M 38 14
          L 60 60
          L 48 60
          L 38 38
          Z
        "
        fill={aColor}
      />
      {/* A crossbar — short horizontal segment sitting where an A's
          horizontal would land. Subtle but it's the cue that locks the
          letter reading. */}
      <rect
        x="34"
        y="34"
        width="14"
        height="3"
        fill={aColor}
      />
    </svg>
  );
}
