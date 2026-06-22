// CFO AI logo — SVG mark + typographic wordmark.
//
// Mark is pure SVG (renders crisply from 16px favicon to 80px hero) and
// theme-aware via currentColor. The wordmark uses ink for "CFO" and brand
// teal for "AI" to match the reference brand sheet.

import { Mark } from "./Mark";

interface Props {
  /** Mark edge length in px. */
  size?: number;
  className?: string;
  /** Hide the wordmark — useful in compact spots like the favicon mark. */
  iconOnly?: boolean;
  /** Slightly smaller wordmark for nav contexts. */
  compact?: boolean;
  /** Show the "INVENTORY INTELLIGENCE" tagline beneath the wordmark. */
  withTagline?: boolean;
}

export function Logo({
  size = 32,
  className = "",
  iconOnly = false,
  compact = false,
  withTagline = false,
}: Props) {
  return (
    <span className={`inline-flex items-center gap-2.5 select-none text-ink ${className}`}>
      <Mark size={size} />
      {!iconOnly && (
        <span className="inline-flex flex-col leading-none">
          <span
            className={`font-medium tracking-[-0.005em] text-ink ${
              compact ? "text-[14px]" : "text-[15px]"
            }`}
          >
            CFO <span className="text-brand">AI</span>
          </span>
          {withTagline && (
            <span className="mt-1 text-[9px] uppercase tracking-[0.18em] text-ink-mute font-medium">
              Financial Intelligence
            </span>
          )}
        </span>
      )}
    </span>
  );
}
