import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";

import { cn } from "@/lib/utils";

const THUMB_CLASS =
  "block h-5 w-5 rounded-full border-2 border-primary bg-background ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50";

/**
 * Radix renders ONE thumb per <Thumb/> element — it does not derive them from
 * the value array. This wrapper hard-coded a single thumb, so every range
 * slider in the app (the decision-rule cutoffs pass `value={[lo, hi]}`) showed
 * and moved only its LOWER bound: the upper cutoff could be changed only
 * through the numeric input beside it, and the filled track read as a progress
 * bar rather than a band. 2026-07-26: render one thumb per value so a
 * two-value slider actually behaves as a range.
 */
const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ className, ...props }, ref) => {
  const thumbCount = Array.isArray(props.value)
    ? props.value.length
    : Array.isArray(props.defaultValue)
      ? props.defaultValue.length
      : 1;
  return (
    <SliderPrimitive.Root
      ref={ref}
      className={cn("relative flex w-full touch-none select-none items-center", className)}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-2 w-full grow overflow-hidden rounded-full bg-secondary">
        {/* The selected band sits on a solid brand fill with the animated
            sweep over it, at raised alphas (2026-07-26 per operator). The
            gradient alone tops out at 0.26 alpha over the track colour, which
            on a 8px bar read as barely-tinted grey — the one part of the
            control that has to say "this is your range" was the faintest
            thing on it. */}
        <SliderPrimitive.Range className="absolute h-full bg-brand ask-ai-anim-fill [animation-duration:10s] [--af-a1:0.55] [--af-a2:0.25]" />
      </SliderPrimitive.Track>
      {Array.from({ length: Math.max(1, thumbCount) }, (_, i) => (
        <SliderPrimitive.Thumb key={i} className={THUMB_CLASS} />
      ))}
    </SliderPrimitive.Root>
  );
});
Slider.displayName = SliderPrimitive.Root.displayName;

export { Slider };
