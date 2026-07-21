// Reusable source badge — one component, three variants.
//
// Per-row / per-card pill that surfaces the data provenance: Demo /
// Nasdaq / Estimated. Used in:
//   · Watchlist table rows
//   · Snapshot panel header
//   · Benchmark tiles (when applicable)
//   · Chat context cards
//
// Tiny by design — sits next to the data it describes, never the
// dominant visual element.

import { Database, Sparkles, AlertCircle, Landmark } from "lucide-react";

// BVB Phase 2 (2026-06-01) — added "bvb" variant + "seed_bvb" alias.
// The backend tags BVB seed rows with source="seed_bvb" (FY2024 issuer
// disclosure). Callers historically pass the raw row.source value
// through `variant`. We accept BOTH spellings so the universe table
// (which passes "seed_bvb" via `row.source`) and the drawer (which
// explicitly maps to "bvb") both render correctly.
//
// CRITICAL: also fall back to a neutral "estimated" config for any
// variant we don't recognise. The previous code path returned
// `undefined` for unknown variants, and the next-line `config.icon`
// access threw — crashed the entire universe table when BVB rows
// rendered after "Browse all" was clicked.
type Variant = "demo" | "nasdaq" | "estimated" | "bvb" | "seed_bvb";

interface Props {
  variant: Variant | string;
  className?: string;
  /** Override the default label. Useful for "Nasdaq · SF1 ARY" specificity. */
  label?: string;
}

export function PublicCompanySourceBadge({ variant, label, className = "" }: Props) {
  // Normalize source-string aliases to their badge variant.
  const normalized: Variant =
    variant === "seed_bvb" ? "bvb"
    : (variant === "demo" || variant === "nasdaq" || variant === "estimated" || variant === "bvb")
      ? variant
      : "estimated";  // neutral fallback for unknown source strings

  const config = {
    demo: {
      icon: Sparkles,
      label: label ?? "Demo",
      tone: "bg-[#5CD3C5]/10 text-[#2AA89B] dark:text-[#8FE3D9] border-[#5CD3C5]/20",
    },
    nasdaq: {
      icon: Database,
      label: label ?? "Nasdaq",
      tone: "bg-brand/10 text-brand-d border-brand/20",
    },
    estimated: {
      icon: AlertCircle,
      label: label ?? "Estimated",
      tone: "bg-bg-2 text-ink-mute border-rule",
    },
    bvb: {
      icon: Landmark,
      label: label ?? "BVB · FY2024",
      tone: "bg-[#5CD3C5]/10 text-[#2AA89B] dark:text-[#8FE3D9] border-[#5CD3C5]/20",
    },
    // Kept for type-completeness — never reached after normalization.
    seed_bvb: {
      icon: Landmark,
      label: label ?? "BVB · FY2024",
      tone: "bg-[#5CD3C5]/10 text-[#2AA89B] dark:text-[#8FE3D9] border-[#5CD3C5]/20",
    },
  }[normalized];
  const Icon = config.icon;
  return (
    <span
      data-testid={`public-company-source-badge-${variant}`}
      className={`
        inline-flex items-center gap-1
        h-5 px-1.5 rounded
        text-[10px] uppercase tracking-[0.06em] font-semibold
        border ${config.tone}
        ${className}
      `}
    >
      <Icon size={9} strokeWidth={2.25} />
      {config.label}
    </span>
  );
}
