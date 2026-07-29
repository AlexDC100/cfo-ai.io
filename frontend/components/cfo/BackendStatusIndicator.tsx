// Small connection dot in the TopHeader — reflects whether the FastAPI
// engine (Today/Cash/Profit/Products/pipeline/etc) is reachable. Ask CFO AI
// chat runs independently on a Supabase Edge Function, so this dot going
// red does NOT mean chat is broken — see useBackendStatus.ts.

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useBackendStatus } from "@/lib/useBackendStatus";
import { cn } from "@/lib/utils";

const LABEL: Record<ReturnType<typeof useBackendStatus>, string> = {
  checking: "Checking backend…",
  connected: "Backend connected",
  disconnected: "Backend unreachable",
};

const DETAIL: Record<ReturnType<typeof useBackendStatus>, string> = {
  checking: "Probing the analysis engine…",
  connected: "The analysis engine is reachable.",
  disconnected:
    "The analysis engine isn't responding — Today/Cash/Profit/Products and uploads won't work. Ask CFO AI chat is unaffected.",
};

export function BackendStatusIndicator() {
  const status = useBackendStatus();

  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <div
          className="hidden sm:inline-flex items-center gap-1.5 px-1"
          aria-label={LABEL[status]}
          data-testid="backend-status-indicator"
          data-status={status}
        >
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              status === "connected" && "bg-success",
              status === "disconnected" && "bg-alert",
              status === "checking" && "bg-ink-mute animate-pulse",
            )}
          />
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[240px] text-xs">
        <p className="font-medium">{LABEL[status]}</p>
        <p className="text-ink-soft mt-0.5">{DETAIL[status]}</p>
      </TooltipContent>
    </Tooltip>
  );
}
