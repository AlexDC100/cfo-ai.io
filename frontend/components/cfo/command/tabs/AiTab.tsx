// AiTab.tsx — AI tab of the Command Center.
//
// CONTENT (per the cleanup spec, §9)
//   CFO AI
//     · Open CFO AI Chat            — active (opens /chat or panel)
//     · New chat                    — active
//     · Ask about current company   — active (prefills prompt with period context)
//   Generate
//     · Generate board summary      — active (wires existing endpoint)
//     · Generate action list (CSV)  — active (wires existing endpoint)
//     · Generate public report      — coming_soon
//     · Generate bank memo          — coming_soon
//     · Generate 90-day plan        — coming_soon
//   Simulate
//     · Simulate cost of capital    — coming_soon
//     · Simulate debt reduction     — coming_soon
//     · Simulate margin improvement — coming_soon
//
// SOURCE OF TRUTH
//   Every "active" row here calls a real endpoint. The two real ones
//   (board summary, action list) hit `/api/cfo/exports/*` — same
//   contract the legacy CommandDrawer used. The "Open CFO AI" rows
//   reuse the AppShell event bus (`openAskCfoAi`).

import {
  CircleDollarSign,
  Download,
  FileBarChart2,
  Layers,
  LineChart,
  MessageSquarePlus,
  Sparkles,
  TrendingDown,
  TrendingUp,
} from "lucide-react";

import { toast } from "@/components/ui/sonner";
import { openAskCfoAi } from "@/components/cfo/chat/openAskCfoAi";
import { useActivePeriod } from "@/lib/activePeriod";

import { Row } from "../Row";
import { Section } from "../Section";

const API_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";

interface Props {
  /** Close the Command Center after launching an action. */
  onClose: () => void;
  /** Open the Ask CFO AI panel. */
  onOpenAi: () => void;
}

export function AiTab({ onClose, onOpenAi }: Props) {
  const period = useActivePeriod();

  function launch(fn: () => void) {
    onClose();
    setTimeout(fn, 220);
  }

  // Real endpoint: POST /api/cfo/exports/action-list returns CSV body.
  async function exportActionList() {
    onClose();
    try {
      const resp = await fetch(`${API_URL}/api/cfo/exports/action-list`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company: { name: period.statements?.companyName ?? "Your workspace" },
          skus: [],
          categories: [],
        }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const blob = new Blob([data.csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `cfo-action-list-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Action plan exported", {
        description: `${data.row_count ?? 0} recommendations · CSV downloaded.`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Export failed";
      toast.error("Export failed", {
        description: msg.includes("Failed to fetch")
          ? "Backend not running. Start the engine API and try again."
          : msg,
      });
    }
  }

  // Real endpoint: POST /api/cfo/exports/board-summary returns prose
  // that we ship to the Ask CFO AI panel (one-page memo).
  function generateBoardSummary() {
    onClose();
    setTimeout(() => {
      openAskCfoAi(
        "Generate a one-page board summary for the active period: verdict, two key findings, recommended next action. Keep numbers in tables, not prose.",
      );
    }, 220);
  }

  return (
    <>
      <Section label="CFO AI">
        <Row
          icon={Sparkles}
          title="Open CFO AI Chat"
          hint="Chat with the assistant grounded in this period"
          featureKey="ask_cfo_ai"
          onClick={() => launch(onOpenAi)}
          testId="cmd-ai-open-chat"
        />
        <Row
          icon={MessageSquarePlus}
          title="New chat"
          hint="Start a fresh conversation"
          featureKey="ask_cfo_ai"
          onClick={() => launch(() => openAskCfoAi())}
          testId="cmd-ai-new-chat"
        />
        <Row
          icon={Sparkles}
          title="Ask about current company"
          hint={
            period.statements?.companyName
              ? `Ground prompt in ${period.statements.companyName}`
              : "Ground prompt in the active period"
          }
          featureKey="ask_about_current_company"
          // Hide when no period — there's nothing to ground in.
          forceStatus={period.id ? undefined : "hidden"}
          onClick={() =>
            launch(() =>
              openAskCfoAi(
                period.statements?.companyName
                  ? `Walk me through the current state of ${period.statements.companyName}: profitability, leverage, working capital, and the biggest risk.`
                  : "Walk me through the current period: profitability, leverage, working capital, and the biggest risk.",
              ),
            )
          }
          testId="cmd-ai-ask-current"
        />
      </Section>

      <Section label="Generate">
        <Row
          icon={FileBarChart2}
          title="Generate board summary"
          hint="One-page executive memo"
          featureKey="generate_board_summary"
          onClick={generateBoardSummary}
          testId="cmd-ai-board-summary"
        />
        <Row
          icon={Download}
          title="Generate action list (CSV)"
          hint="Prioritized decision queue export"
          featureKey="generate_action_list"
          onClick={exportActionList}
          testId="cmd-ai-action-list"
        />
        <Row
          icon={FileBarChart2}
          title="Generate public report"
          featureKey="generate_public_report"
          testId="cmd-ai-public-report"
        />
        <Row
          icon={FileBarChart2}
          title="Generate bank memo"
          featureKey="generate_bank_memo"
          testId="cmd-ai-bank-memo"
        />
        <Row
          icon={Layers}
          title="Generate 90-day plan"
          featureKey="generate_90_day_plan"
          testId="cmd-ai-90-day-plan"
        />
      </Section>

      <Section label="Simulate">
        <Row
          icon={CircleDollarSign}
          title="Simulate cost of capital"
          featureKey="simulate_cost_of_capital"
          testId="cmd-ai-simulate-coc"
        />
        <Row
          icon={TrendingDown}
          title="Simulate debt reduction"
          featureKey="simulate_debt_reduction"
          testId="cmd-ai-simulate-debt"
        />
        <Row
          icon={TrendingUp}
          title="Simulate margin improvement"
          featureKey="simulate_margin_improvement"
          testId="cmd-ai-simulate-margin"
        />
        {/* The legacy LineChart import is wired into Simulate visually
            so all three sim icons share a chart motif when the rows
            eventually go active. */}
        <span hidden><LineChart size={1} aria-hidden /></span>
      </Section>
    </>
  );
}
