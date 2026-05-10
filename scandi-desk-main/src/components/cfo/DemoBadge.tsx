// DemoBadge — small chip that appears whenever a page is rendering mock or
// demo-seeded data instead of the user's own uploaded numbers. Honest about
// data provenance per master prompt rule #1: "Do not ship mock data behind
// real-looking UI."
//
// Render variants:
//   <DemoBadge />            — inline pill, "Demo data"
//   <DemoBadge tone="info" />  — softer blue treatment for cards/tooltips
//   <DemoBadge label="Mock alerts" /> — custom label
//
// On click, opens a tiny popover explaining why and offers an "Exit demo"
// CTA when the user is in demo mode (otherwise just dismisses).

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Sparkle, X } from "lucide-react";
import { useAuth } from "@/lib/auth";

interface Props {
  /** Override label. Default: "Demo data". */
  label?: string;
  /** Visual treatment — `default` is amber, `info` is blue. */
  tone?: "default" | "info";
  /** Compact = no chevron, no click target. Use inside dense rows. */
  compact?: boolean;
}

export function DemoBadge({ label = "Demo data", tone = "default", compact = false }: Props) {
  const [open, setOpen] = useState(false);
  const { demoActive, exitDemo } = useAuth();
  const navigate = useNavigate();

  const palette =
    tone === "info"
      ? "bg-blue-50 text-blue-700 border-blue-200"
      : "bg-amber-50 text-amber-700 border-amber-200";

  if (compact) {
    return (
      <span
        className={`inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-[0.06em] px-1.5 py-0.5 rounded border ${palette}`}
        title="This page is rendering demo data — your own numbers will replace it after you upload."
      >
        <Sparkle size={9} strokeWidth={2.25} />
        {label}
      </span>
    );
  }

  return (
    <div className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] px-2.5 py-1 rounded-full border ${palette} hover:opacity-90 transition-opacity`}
      >
        <Sparkle size={11} strokeWidth={2.25} />
        {label}
      </button>
      {open && (
        <div className="absolute z-50 top-[calc(100%+8px)] left-0 w-[280px] rounded-xl border border-rule bg-surface shadow-lg p-4 text-left">
          <div className="flex items-start justify-between gap-2 mb-2">
            <div className="text-[11px] uppercase tracking-[0.1em] text-ink-mute font-medium">
              About this view
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-ink-mute hover:text-ink transition-colors"
              aria-label="Close"
            >
              <X size={13} strokeWidth={2} />
            </button>
          </div>
          <p className="text-[12.5px] text-ink-soft leading-snug">
            Numbers on this page come from the bundled sample dataset, not your
            uploads. Drop a real workbook or balance sheet and we'll replace
            this with your own analysis.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                navigate("/dashboard");
              }}
              className="text-[12px] font-medium text-brand-d hover:text-brand transition-colors"
            >
              Upload data →
            </button>
            {demoActive && (
              <button
                type="button"
                onClick={() => {
                  exitDemo();
                  navigate("/", { replace: true });
                }}
                className="ml-auto text-[12px] font-medium text-ink-soft hover:text-ink transition-colors"
              >
                Exit demo
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
