// TikTok logo — lucide doesn't ship one, so we render a clean monochrome
// path that visually matches the other 20px lucide social icons.
//
// Stroke widths and proportions are tuned so this sits next to LinkedIn /
// X / YouTube / Instagram without looking heavier than the others.

interface Props {
  size?: number;
  className?: string;
  strokeWidth?: number;
}

export default function TikTokIcon({ size = 20, className, strokeWidth = 1.75 }: Props) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {/* TikTok music-note + person silhouette, simplified to single-stroke */}
      <path d="M15 4v9.5a3.5 3.5 0 1 1-3.5-3.5" />
      <path d="M15 4c.5 2.5 2.5 4.5 5 5" />
    </svg>
  );
}
