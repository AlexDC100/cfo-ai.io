import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// Three-type button system per UI_V2_POLISH brief.
//
//   primary   — most important action on a screen. ≤ 1 per view.
//   secondary — supporting actions (cancel, revert).
//   tertiary  — low-emphasis text button (links, "view full history").
//
// Legacy variants (default, destructive, outline, ghost, link, secondary) are
// kept as aliases so existing callers don't break, but new code should use
// "primary" / "secondary" / "tertiary".

const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap",
    "text-[15px] leading-none",
    "transition-[background-color,box-shadow,color,border-color] duration-[160ms] ease-quint",
    "disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
    "focus-visible:outline-none",
  ].join(" "),
  {
    variants: {
      variant: {
        // ─── New three-type system ───
        primary: [
          "rounded-sm bg-burgundy text-white font-semibold",
          "shadow-[0_1px_2px_hsl(var(--brand)/0.24)]",
          "hover:bg-burgundy-dark hover:shadow-2",
          "active:bg-burgundy-dark active:shadow-inset",
          "disabled:bg-ink-mute disabled:text-ink-faint disabled:shadow-none",
        ].join(" "),
        secondary: [
          "rounded-sm bg-surface text-ink font-medium",
          "border border-rule",
          "hover:bg-bg-2 hover:border-rule-strong",
          "active:bg-rule",
        ].join(" "),
        tertiary: [
          "h-auto px-0 py-0 bg-transparent text-ink-soft font-medium",
          "underline underline-offset-[3px] decoration-ink-faint decoration-1",
          "hover:text-ink hover:decoration-ink-soft",
        ].join(" "),
        danger: [
          "rounded-sm bg-alert text-white font-semibold",
          "shadow-[0_1px_2px_hsl(var(--alert)/0.24)]",
          "hover:opacity-90 hover:shadow-2",
          "active:shadow-inset",
          "disabled:bg-alert/30 disabled:text-white/70 disabled:shadow-none",
        ].join(" "),

        // ─── Legacy aliases — kept for compatibility with existing callers ───
        default: [
          "rounded-sm bg-burgundy text-white font-semibold",
          "shadow-[0_1px_2px_hsl(var(--brand)/0.24)]",
          "hover:bg-burgundy-dark hover:shadow-2",
        ].join(" "),
        destructive: [
          "rounded-sm bg-alert text-white font-semibold",
          "hover:opacity-90",
        ].join(" "),
        outline: [
          "rounded-sm bg-surface text-ink",
          "border border-rule hover:bg-bg-2 hover:border-rule-strong",
        ].join(" "),
        ghost: "rounded-sm hover:bg-bg-2 text-ink",
        link: "text-burgundy underline-offset-[3px] hover:underline",
      },
      size: {
        default: "h-9 px-4",     // 36px tall
        sm: "h-8 px-3 text-[14px]",
        lg: "h-11 px-6 text-[15px]",  // 44px CTA
        icon: "h-9 w-9",
      },
    },
    defaultVariants: { variant: "primary", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
