// Skeleton — placeholder loading surface.
//
// Cleo-style refresh: instead of a flat muted pulse, we paint a moving
// gradient sheen across the surface (1.6s loop). The motion telegraphs
// "loading" in a way that feels intentional rather than waiting-room.
//
// Implementation: a 200%-wide gradient background that pans -200% → 100%
// via the cfo-skeleton-shimmer keyframes defined in index.css. Falls back
// to animate-pulse via prefers-reduced-motion (see the @media block in
// index.css that flattens animation-duration).

import { cn } from "@/lib/utils";

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-md bg-muted/60",
        "before:absolute before:inset-0 before:-translate-x-full",
        "before:animate-[cfo-shimmer_1.6s_ease-in-out_infinite]",
        "before:bg-gradient-to-r before:from-transparent before:via-white/10 before:to-transparent",
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
