// Row.tsx — single row in a Command Center section.
//
// One file owns the visual contract for every row across Workspace / Data
// / AI / Account so we never re-implement disabled vs active styling in
// each tab. Three rendering modes:
//
//   · active        — clickable, chevron, hover state. onClick required.
//   · coming_soon   — visible-but-inactive looking, BUT clickable: a
//                     press fires a toast ("Coming soon — <title>…")
//                     so the user gets explicit confirmation that the
//                     row is on the roadmap and isn't broken. The
//                     caller's onClick is ignored. `aria-disabled` is
//                     not set because the row IS interactive (it shows
//                     the toast); we use `data-status="coming_soon"`
//                     so tests + analytics can still distinguish.
//   · hidden        — caller is expected to short-circuit BEFORE
//                     rendering this Row. We accept the prop and
//                     return null defensively.
//
// HOW THE FEATURE REGISTRY DRIVES THIS
//   Pass `featureKey` and the row looks up its status via
//   `useFeatureStatus`. Override with `forceStatus` for cases the
//   registry can't model (e.g., "Search dataset" hidden when no
//   dataset is loaded — that's a runtime condition, not a feature
//   status). When both are absent, status defaults to `active`.

import type { ReactNode } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";

import { toast } from "@/components/ui/sonner";
import {
  type FeatureKey,
  type FeatureStatus,
  useFeatureStatus,
} from "@/lib/features";

export interface RowProps {
  icon: LucideIcon;
  title: string;
  hint?: string;
  /** Registry-driven status. Pass `featureKey` and the row reads its
   *  status from `useFeatureStatus`. */
  featureKey?: FeatureKey;
  /** Override the registry — only when the row's availability depends
   *  on runtime state (e.g., "no dataset loaded → hidden"). */
  forceStatus?: FeatureStatus;
  /** Run when an `active` row is clicked. Ignored when status is
   *  `coming_soon` or `hidden`. */
  onClick?: () => void;
  /** Optional custom trailing element — defaults to chevron / badge. */
  trailing?: ReactNode;
  /** Test ID — useful for the menu-cleanliness E2E. */
  testId?: string;
}

export function Row(props: RowProps): JSX.Element | null {
  const registryStatus = useFeatureStatus(props.featureKey ?? ("__unused__" as FeatureKey));
  const status: FeatureStatus = props.forceStatus
    ?? registryStatus
    ?? "active";

  if (status === "hidden") return null;

  const isComingSoon = status === "coming_soon";
  const Icon = props.icon;

  // coming_soon press → toast feedback so the row never feels "dead".
  // The caller's onClick is intentionally ignored: caller may have
  // wired a real action that would 500 against a missing backend; the
  // toast is the safe equivalent for an unshipped feature.
  const handleClick = isComingSoon
    ? () => {
        toast(`${props.title} — coming soon`, {
          description: props.hint
            ? `${props.hint}. We'll switch this on when the backend ships.`
            : "This feature isn't available yet. We'll switch it on when the backend ships.",
        });
      }
    : props.onClick;

  return (
    <button
      type="button"
      onClick={handleClick}
      data-testid={props.testId}
      data-status={status}
      className={`
        w-full flex items-center gap-3 px-4 py-3 text-left
        transition-colors
        ${isComingSoon
          ? "opacity-80 hover:opacity-100 hover:bg-surface/60 cursor-pointer"
          : "hover:bg-surface cursor-pointer"}
      `}
    >
      <span
        className={`
          w-7 h-7 rounded-md grid place-items-center
          border border-rule text-ink-soft shrink-0
          ${isComingSoon ? "bg-bg-2/40" : "bg-surface"}
        `}
      >
        <Icon size={14} strokeWidth={1.75} />
      </span>
      <div className="flex-1 min-w-0">
        <div
          className={`text-[13.5px] leading-tight ${
            isComingSoon ? "text-ink-soft" : "text-ink"
          }`}
        >
          {props.title}
        </div>
        {props.hint && (
          <div className="text-[11.5px] text-ink-mute mt-0.5 leading-tight">
            {props.hint}
          </div>
        )}
      </div>
      {props.trailing ?? (
        isComingSoon ? (
          <span
            className="
              inline-flex items-center h-5 px-2 rounded-full
              text-[9.5px] uppercase tracking-[0.1em] font-semibold
              bg-bg-2/60 border border-rule text-ink-mute
              shrink-0
            "
            data-testid="coming-soon-badge"
          >
            Coming soon
          </span>
        ) : (
          <ChevronRight size={13} strokeWidth={1.75} className="text-ink-mute shrink-0" />
        )
      )}
    </button>
  );
}
