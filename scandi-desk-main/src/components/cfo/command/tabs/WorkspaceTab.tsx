// WorkspaceTab.tsx — Workspace tab of the Command Center.
//
// CONTENT (per the cleanup spec, §7)
//   · Current analysis — company / doc type / period (read from useActivePeriod)
//   · Quick actions    — Open analysis, Open reports, Open benchmarks, Ask CFO AI
//   · Upload entry     — surfaced when no dataset connected
//   · Switch workspace — coming_soon (badge)
//
// What this tab is NOT
//   · Not a duplicate sidebar. We do not list every page.
//   · Not the place for cost-of-capital / financial assumptions —
//     those moved to /settings.
//   · Not the place for thresholds / Rules — also moved to /settings.

import {
  BarChart3,
  Building2,
  FileBarChart2,
  LayoutDashboard,
  Sparkles,
  UploadCloud,
} from "lucide-react";
import { useNavigate } from "react-router-dom";

import { useActivePeriod } from "@/lib/activePeriod";

import { Row } from "../Row";
import { Section } from "../Section";

interface Props {
  /** Close the Command Center after launching a navigation/action. */
  onClose: () => void;
  /** Open the Ask CFO AI panel. */
  onOpenAi: () => void;
  /** Open the upload flow. */
  onOpenUpload: () => void;
}

export function WorkspaceTab({ onClose, onOpenAi, onOpenUpload }: Props) {
  const period = useActivePeriod();
  const navigate = useNavigate();
  const connected = !!period.id && !!period.statements;

  /** Close drawer then run an action — keeps animation smooth. */
  function launch(fn: () => void) {
    onClose();
    setTimeout(fn, 220);
  }

  // Path with `?period=<id>` preserved so deep links keep working when
  // the user navigates from the Command Center.
  const periodQs = period.id ? `?period=${period.id}` : "";

  return (
    <>
      <Section label="Current analysis">
        {connected ? (
          <Row
            icon={LayoutDashboard}
            title="Open analysis"
            hint={
              [
                period.statements?.companyName,
                period.label,
              ].filter(Boolean).join(" · ") || "Open the dashboard for the active period"
            }
            featureKey="dashboard"
            onClick={() => launch(() => navigate(`/dashboard${periodQs}`))}
            testId="cmd-workspace-open-analysis"
          />
        ) : (
          <Row
            icon={UploadCloud}
            title="Upload document"
            hint="Drop a trial balance or financial statement to start analysis"
            featureKey="upload_trial_balance"
            onClick={() => launch(onOpenUpload)}
            testId="cmd-workspace-upload"
          />
        )}
      </Section>

      <Section label="Quick actions">
        <Row
          icon={Sparkles}
          title="Ask CFO AI"
          hint="Open the assistant panel"
          featureKey="ask_cfo_ai"
          onClick={() => launch(onOpenAi)}
          testId="cmd-workspace-ask-ai"
        />
        <Row
          icon={BarChart3}
          title="Open benchmarks"
          hint="Industry percentile comparison"
          featureKey="benchmarks"
          // Hide when no dataset connected — there's nothing to benchmark.
          forceStatus={connected ? undefined : "hidden"}
          onClick={() => launch(() => navigate(`/benchmark${periodQs}`))}
          testId="cmd-workspace-open-benchmarks"
        />
        <Row
          icon={FileBarChart2}
          title="Open reports"
          hint="Comprehensive analysis report"
          featureKey="reports"
          forceStatus={connected ? undefined : "hidden"}
          onClick={() => launch(() => navigate(`/report${periodQs}`))}
          testId="cmd-workspace-open-reports"
        />
        <Row
          icon={UploadCloud}
          title="Upload another document"
          hint="Replace or add a period"
          featureKey="upload_trial_balance"
          // When already connected the upload still belongs here as a
          // secondary action; when disconnected it's the primary CTA up
          // top, so hide the duplicate.
          forceStatus={connected ? undefined : "hidden"}
          onClick={() => launch(onOpenUpload)}
          testId="cmd-workspace-upload-secondary"
        />
      </Section>

      <Section label="Workspace">
        <Row
          icon={Building2}
          title="Switch workspace"
          hint="Multi-tenant org switching"
          featureKey="workspace_switcher"
          testId="cmd-workspace-switch"
        />
      </Section>
    </>
  );
}
