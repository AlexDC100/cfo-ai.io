// IosSpinner — the iOS activity indicator (12 radial bars, fading in turn)
// drawn in CSS so it can take the app's theme colour via `currentColor`.
// Used by the drawer's pull-to-refresh (2026-09-08 per operator: "the
// default iOS spinner, coloured by my theme"). Pass `progress` (0–1) while
// the user is still pulling: the bars light up in order instead of
// spinning, like UIRefreshControl before release.

interface Props {
  size?: number;
  /** 0–1 while pulling (bars fill in order); omit to spin. */
  progress?: number;
  className?: string;
}

const BARS = 12;

export function IosSpinner({ size = 24, progress, className = "" }: Props) {
  const spinning = progress === undefined;
  return (
    <span
      aria-hidden
      className={`relative inline-block ${className}`}
      style={{ width: size, height: size }}
      data-testid="ios-spinner"
    >
      {Array.from({ length: BARS }, (_, i) => {
        const lit = spinning ? 1 : i / (BARS - 1) <= progress ? 1 : 0.25;
        return (
          <span
            key={i}
            className={spinning ? "ios-spinner-bar" : undefined}
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              width: size * 0.09,
              height: size * 0.28,
              marginLeft: -(size * 0.09) / 2,
              marginTop: -(size * 0.5),
              borderRadius: size * 0.05,
              background: "currentColor",
              transformOrigin: `50% ${size * 0.5}px`,
              transform: `rotate(${(360 / BARS) * i}deg)`,
              opacity: lit,
              animationDelay: spinning ? `${-(BARS - i) * (1 / BARS)}s` : undefined,
            }}
          />
        );
      })}
    </span>
  );
}
