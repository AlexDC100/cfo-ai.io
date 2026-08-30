// THE CAPSULE — the calm state (C7 / A2).
//
// Two components, one rule: NO RAW PAYLOAD REACHES THE DOM.
//
// Everything rendered here is an i18n key. The block object arrives from
// `useCapsuleAskAvailability`, which builds it from `lib/aiDegraded`'s
// mapper — the one place that has ever seen a status code, a request id
// or a provider error slug, and which logs them to console.debug and
// nowhere else. There is deliberately NO prop on either component that
// could carry an error string: a caller cannot leak what it cannot pass.
//
//   CapsuleAskRowNotice   the Ask ROW's replacement line, in place:
//                         "CFO AI is unavailable — search still works"
//   CapsuleAskUnavailable the panel under the rows: headline, the
//                         reassurance that search/navigation/actions and
//                         the figures are untouched, a quiet reason, and
//                         Retry when the host can offer one.

import { useTranslation } from "react-i18next";

import "./capsuleEmptyI18n";
import "@/components/cfo/chat/chatDegradedI18n";
import type { CapsuleAskBlock } from "./useCapsuleAsk";

export interface CapsuleAskNoticeProps {
  block: CapsuleAskBlock;
}

/** The one line the Ask row shows instead of "Ask about …". */
export function CapsuleAskRowNotice({ block }: CapsuleAskNoticeProps) {
  const { t } = useTranslation();
  return (
    <span
      data-testid="capsule-ask-row-notice"
      data-block={block.kind}
      className="min-w-0 flex-1 truncate text-[13px] text-ink-soft"
    >
      {t(block.rowLabelKey)}
    </span>
  );
}

export interface CapsuleAskUnavailableProps extends CapsuleAskNoticeProps {
  /** Offered only when the host has something to retry. Omitted, no
   *  button renders — a Retry that does nothing is worse than none. */
  onRetry?: () => void;
}

/** The panel. Calm, specific, and free of anything the wire said. */
export function CapsuleAskUnavailable({ block, onRetry }: CapsuleAskUnavailableProps) {
  const { t } = useTranslation();
  const degraded = block.kind === "degraded";

  return (
    <div
      data-testid="capsule-ask-unavailable"
      data-block={block.kind}
      role="status"
      className="border-t border-rule-soft px-4 py-3"
    >
      <p className="text-[12.5px] font-medium text-ink">
        {t(degraded ? "capsuleEmpty.degraded.heading" : "capsuleEmpty.throttle.heading")}
      </p>
      <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-soft">
        {t(degraded ? "capsuleEmpty.degraded.body" : "capsuleEmpty.throttle.body")}
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        {block.kind === "degraded" ? (
          // The human-readable reason, from the mapper's fixed three.
          <span className="text-[11px] text-ink-soft">
            {t("capsuleEmpty.degraded.detailsLabel")}
            {": "}
            {t(block.reasonKey)}
          </span>
        ) : (
          <span data-testid="capsule-throttle-countdown" className="text-[11px] text-ink-soft tabular-nums">
            {t("capsuleEmpty.throttle.ready", { seconds: block.secondsRemaining })}
          </span>
        )}
        {degraded && onRetry && (
          <button
            type="button"
            data-testid="capsule-ask-retry"
            onClick={onRetry}
            className="
              rounded-sm border border-rule bg-bg-2 px-2 py-0.5 text-[11px] text-ink
              transition-colors duration-micro hover:bg-bg-2/70
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
            "
          >
            {t("capsuleEmpty.degraded.retry")}
          </button>
        )}
      </div>
    </div>
  );
}
