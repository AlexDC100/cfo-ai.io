// IconButton — unified primitive for icon-only control buttons.
//
// Spec: all icon-only buttons across the app should go through this so
// they have identical box dimensions, identical inner icon sizing,
// identical hover/active/focus behavior. The original sidebar footer
// rendered three separate inline `<button>`s for theme / language /
// sidebar-toggle, each with its own classes — over time those drifted
// (different padding, different icon size props, different wrappers
// for popover anchoring) and the visual result was three icons that
// looked "bolted together" rather than a unified control group.
//
// Box & icon dimensions
// ─────────────────────
// • `md` (default): 40×40 button, 18×18 icon container
// • `sm`:           32×32 button, 16×16 icon container
//
// The inner `<span>` forces every SVG child to fill its container via
// `[&>svg]:w-full [&>svg]:h-full`, so the icon renders at exactly the
// container size regardless of the source SVG's viewBox or default
// width/height. Centering via `grid place-items-center` (no flex
// baseline ambiguity).
//
// Forward-ref so popover/tooltip primitives that need a DOM ref work
// transparently.

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** The icon to render — a Lucide / Heroicon / raw SVG element. */
  icon: ReactNode;
  /** Accessible label. Also used as the native tooltip via `title`. */
  label: string;
  /** Active state — applies brand-tint background. Used e.g. when a
   *  popover anchored on this button is open. */
  active?: boolean;
  /** Button box size. Default `md` (40×40). */
  size?: "sm" | "md";
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ icon, label, active, size = "md", className, ...rest }, ref) => {
    const box = size === "md" ? "h-10 w-10" : "h-8 w-8";
    const iconSlot = size === "md" ? "w-[18px] h-[18px]" : "w-[16px] h-[16px]";
    return (
      <button
        ref={ref}
        type="button"
        title={label}
        aria-label={label}
        className={cn(
          // Layout: fixed box, icon perfectly centered via grid
          box,
          "grid place-items-center rounded-lg",
          // Color: muted by default, ink on hover, brand-tint when active
          active
            ? "bg-brand-tint text-brand-d"
            : "text-ink-soft hover:text-ink hover:bg-bg-2 active:bg-bg-2/60",
          "transition-colors",
          // Focus ring (keyboard only via :focus-visible base CSS)
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          className,
        )}
        {...rest}
      >
        {/* Force every child SVG to exactly the icon-slot size, regardless
         *  of its native viewBox or default dimensions. This is what
         *  prevents mixed-library icons (Lucide vs Heroicons vs raw SVG)
         *  from rendering at different visual sizes. */}
        <span className={cn(iconSlot, "grid place-items-center [&>svg]:w-full [&>svg]:h-full")}>
          {icon}
        </span>
      </button>
    );
  },
);
IconButton.displayName = "IconButton";
