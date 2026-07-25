// StateCard.tsx — live workspace state card at the top of Command Center.
//
// THIS REPLACES the legacy CommandDrawer's hardcoded "No dataset connected"
// string. The old card never read `useActivePeriod`, so it always said
// "no dataset" even when an analysis was loaded — exactly the user
// confusion the cleanup brief calls out.
//
// SOURCE OF TRUTH
//   `useActivePeriod()` returns the URL-keyed period:
//     · id              — the analysis id (uuid)
//     · label / company — display strings
//     · statements      — full extracted statements (presence = connected)
//     · metrics         — count of resolved KPIs
//     · briefing        — last narrative (proxy for "processed")
//   We derive `dataDepth` from the presence of statements vs metrics
//   alone — same fallback the dashboard uses.
//
// TWO RENDER STATES
//   CONNECTED      "Workspace · Scandia Food · Trial Balance · FY2025"
//                  "Data connected · 809 accounts · Last processed 12:51"
//   NOT CONNECTED  "Workspace · No dataset connected"
//                  "Upload a financial document to start analysis"
//
// Click the card → the /workspace page (workspace picker / management),
// closing the Command Center first (2026-07-24; it used to deep-link to
// the Dashboard or the upload flow).

import { Building2 } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { useActivePeriod } from "@/lib/activePeriod";
import { useWorkspaceName } from "@/lib/workspaceName";

interface Props {
  /** Close the Command Center before navigating. */
  onClose?: () => void;
}

export function StateCard({ onClose }: Props): JSX.Element {
  const period = useActivePeriod();
  const workspaceName = useWorkspaceName();
  const navigate = useNavigate();
  const connected = !!period.id && !!period.statements;
  const companyName = period.statements?.companyName ?? period.label ?? null;
  // The ACTIVE workspace's name leads the card; the period's company
  // name is the fallback for legacy sessions without a workspace name.
  const title = workspaceName || companyName;

  // Build the subtitle from whichever signals resolved. Order matters —
  // "Data connected · N accounts · Last processed HH:MM" is the spec's
  // canonical line; we only include components that actually have data.
  const subtitleBits: string[] = [];
  if (connected) {
    subtitleBits.push("Data connected");
    const metricCount = period.metrics?.length ?? 0;
    if (metricCount > 0) {
      subtitleBits.push(`${metricCount} KPI${metricCount === 1 ? "" : "s"}`);
    }
    // `briefing` is the last narrative; its existence is the closest
    // proxy we have to "the pipeline finished processing this period".
    if (period.briefing) {
      subtitleBits.push("Last processed");
    }
  } else {
    subtitleBits.push("Upload a financial document to start analysis");
  }

  return (
    <button
      type="button"
      data-testid="command-state-card"
      data-state={connected ? "connected" : "no-dataset"}
      onClick={() => {
        onClose?.();
        setTimeout(() => navigate("/workspace"), 220);
      }}
      className="
        w-full text-left rounded-xl border border-rule bg-bg-2 px-4 py-3
        hover:bg-bg-2/70 hover:border-brand/40 transition-colors cursor-pointer
      "
    >
      <div className="flex items-center gap-2.5">
        <span className="w-7 h-7 rounded-md bg-brand/15 grid place-items-center shrink-0">
          <Building2 size={14} strokeWidth={1.75} className="text-brand-d" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-ink leading-tight flex items-center gap-1.5 flex-wrap">
            <span>Workspace</span>
            {title && (
              <>
                <span className="text-ink-mute" aria-hidden>·</span>
                <span className="truncate max-w-[220px]">{title}</span>
              </>
            )}
            {connected && period.label && period.label !== title && (
              <>
                <span className="text-ink-mute" aria-hidden>·</span>
                <span className="text-ink-soft truncate">{period.label}</span>
              </>
            )}
            {!connected && !title && (
              <>
                <span className="text-ink-mute" aria-hidden>·</span>
                <span className="text-ink-soft">No dataset connected</span>
              </>
            )}
          </div>
          <div className="text-[11px] text-ink-soft mt-0.5 leading-tight">
            {subtitleBits.join(" · ")}
          </div>
        </div>
      </div>
    </button>
  );
}
