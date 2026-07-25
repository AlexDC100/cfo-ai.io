// BVBBadge — tiny exchange/currency pill for BVB-listed rows.
//
// 2026-05-31 — BVB Phase 1.
//
// Used in two places:
//   1. Inline next to a ticker in tables and cards, so the reader can
//      tell at a glance which exchange a row comes from. We previously
//      had no exchange badge at all because the universe was 100%
//      US-listed; mixing in BVB rows demands explicit disambiguation.
//   2. Romanian Listed card header — a single instance acts as the
//      section icon, communicating "this whole card is RON-denominated,
//      BVB-listed" without repeating the badge per row.
//
// The badge intentionally does NOT contain a clickable handler. It's
// purely informational. The whole card / row clickability is handled
// by the parent.
//
// Color choice: emerald-tinted to avoid colliding with the existing
// status pills (amber for warning, sky for info, red for negative). RON
// is the Romanian leu — picked emerald because the BNR (Banca Națională
// a României) brand mark is teal-emerald and most Romanian-listed
// dashboards use that hue. Subtle enough to not visually shout.

interface Props {
  /** Visual variant. "inline" is the compact 11px pill for tables;
   *  "section" is the slightly larger 12px variant used in card headers. */
  variant?: "inline" | "section";
  /** Override the displayed label. Default: "BVB · RON". */
  label?: string;
}

export function BVBBadge({ variant = "inline", label = "BVB · RON" }: Props) {
  // Section variant (page-title placement) is larger and set in the
  // app's mono face — matching the uppercase mono eyebrows/labels —
  // per the 2026-07-24 directive. Inline rows keep the compact sans.
  const sizeCls =
    variant === "section"
      ? "text-[14px] px-2.5 py-1 font-mono"
      : "text-[10.5px] px-1.5 py-px";
  return (
    <span
      data-testid="bvb-badge"
      className={`
        inline-flex items-center gap-1 rounded-full
        font-medium tracking-[0.02em] uppercase
        ask-ai-anim-fill [animation-duration:10s]
        border border-brand/40 text-ink
        ${sizeCls}
      `}
    >
      {label}
    </span>
  );
}
