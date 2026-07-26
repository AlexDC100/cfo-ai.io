// CommandCenter — 4-tab control panel (NOT a second navigation system).
//
// ┌──────────────────────────────────────────────────────────────────┐
// │ Command Center                                                ×  │
// ├──────────────────────────────────────────────────────────────────┤
// │ ┌──────────────────────────────────────────────────────────────┐ │
// │ │ Workspace · Scandia Food · Trial Balance · FY2025            │ │  ← StateCard
// │ │ Data connected · 12 KPIs · Last processed                    │ │     (live, useActivePeriod)
// │ └──────────────────────────────────────────────────────────────┘ │
// │                                                                  │
// │ [ Workspace ][ Data ][ AI ][ Account ]                           │  ← 4 tabs, no Rules
// │                                                                  │
// │ (per-tab content)                                                │
// └──────────────────────────────────────────────────────────────────┘
//
// REPLACES `CommandDrawer.tsx`. The old drawer had a Rules tab that
// owned the threshold sliders + a top card hardcoded to "No dataset
// connected" + duplicate sign-outs and other broken-clickable items.
// All gone here. Rules lives in /settings now.
//
// The shell is intentionally minimal — its job is layout + state-card
// + tab switcher. Each tab is its own file (WorkspaceTab / DataTab /
// AiTab / AccountTab) so renames / additions stay surgical.

import { useEffect, useState } from "react";
import { BookOpen, Building2, Settings2, X, type LucideIcon } from "lucide-react";
import { useNavigate } from "react-router-dom";

import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";
import { GlossaryContent } from "@/components/learning/MetricGlossaryDrawer";
import { CONCEPTS_BY_KEY } from "@/lib/learning/concepts";
import { useWorkspaceName } from "@/lib/workspaceName";

import { DecisionRulesModal } from "./DecisionRulesModal";
import { AccountTab } from "./tabs/AccountTab";
// AiTab removed from the Command Center per the operator's directive:
// "Ask CFO AI" is reachable from the always-visible TopHeader pill and
// the floating bottom-right button, so giving it a dedicated tab here
// duplicated the affordance and pushed the more actionable Workspace /
// Data / Account surfaces down. The AiTab file was removed in the
// 2026-07 dead-code cleanup (recoverable from git history).
import { DataTab } from "./tabs/DataTab";

// Retained for API compatibility (re-exported from ./index) even though the
// panel no longer uses a tab switcher.
export type CommandCenterTab = "workspace" | "data" | "account";

// Registered learning concepts — the Glossary quick-action's subtitle.
const GLOSSARY_TERM_COUNT = Object.keys(CONCEPTS_BY_KEY).length;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Open the Ask CFO AI panel. */
  onOpenAi: () => void;
  /** Open the upload flow. */
  onOpenUpload: () => void;
}

export function CommandCenter({
  open,
  onOpenChange,
  // onOpenAi is still accepted (AppShell passes it) but no longer used
  // here — the Workspace section that hosted "Ask CFO AI" was removed.
  onOpenUpload,
}: Props) {
  const navigate = useNavigate();
  // Live data behind the quick-action subtitles.
  const workspaceName = useWorkspaceName();
  // Decision-rules modal — opened by its quick action after the panel
  // closes, so it lives OUTSIDE the Sheet (it survives the close).
  const [rulesOpen, setRulesOpen] = useState(false);
  // In-sheet view — the Glossary quick action swaps THIS sheet's
  // content to the glossary (2026-07-24) instead of opening the
  // standalone glossary sidebar on top.
  const [view, setView] = useState<"main" | "glossary">("main");
  // Fresh open always lands on the main view (reset on open, not close,
  // so the exit animation doesn't flash the swap).
  useEffect(() => {
    if (open) setView("main");
  }, [open]);
  const close = () => onOpenChange(false);
  // Close the panel, then run the action once the exit animation has
  // mostly played — same 220ms convention the tabs use.
  const launch = (fn: () => void) => {
    close();
    setTimeout(fn, 220);
  };

  return (
    <>
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        data-testid="command-center"
        className="
          w-[calc(100vw-16px)] sm:w-[440px] sm:max-w-[460px]
          p-0 m-2 sm:m-3 h-[calc(100dvh-16px)] sm:h-[calc(100dvh-24px)]
          rounded-2xl sm:rounded-3xl
          bg-surface dark:bg-bg-2
          border border-rule-strong
          text-ink
          shadow-4
          [&>button.absolute]:hidden
          flex flex-col
        "
        style={{
          marginTop: "calc(env(safe-area-inset-top) + 0.5rem)",
          marginBottom: "calc(env(safe-area-inset-bottom) + 0.5rem)",
          marginRight: "calc(env(safe-area-inset-right) + 0.5rem)",
          maxHeight: "calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 1rem)",
        }}
      >
        {/* ── Header ──────────────────────────────────────────
            The close button is absolutely positioned (top-right) so it no
            longer occupies its own row — the account credentials below sit at
            the same vertical level as the X. */}
        <SheetTitle className="sr-only">Command Center</SheetTitle>
        {/* Wrapped in a div so the button is NOT a direct child button.absolute
            of SheetContent — that selector ([&>button.absolute]:hidden) hides
            Radix's default close, and would hide this one too if unwrapped.
            Hidden in the glossary view — GlossaryContent's header carries
            its own back + close controls in the same corner. */}
        {view === "main" && (
        <div className="absolute top-2 right-2 sm:top-3 sm:right-3 z-10">
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="inline-flex items-center justify-center text-ink-mute hover:text-ink active:bg-bg-2/60 h-11 w-11 sm:h-7 sm:w-7 rounded-md transition-colors"
          >
            <X size={18} className="sm:hidden" strokeWidth={1.75} />
            <X size={16} className="hidden sm:block" strokeWidth={1.75} />
          </button>
        </div>
        )}

        {/* ── Glossary view — swapped IN this sheet (no second sidebar).
            Back returns to the main view; X closes the sheet. */}
        {view === "glossary" ? (
          <div className="flex flex-col flex-1 min-h-0" data-testid="command-glossary">
            <GlossaryContent onClose={close} onBack={() => setView("main")} />
          </div>
        ) : (
        <div
          className="px-5 pt-3 pb-6 overflow-y-auto flex-1 divide-y divide-rule"
          data-testid="command-content"
        >
          <div className="pb-6">
            <AccountTab onClose={close} />
          </div>
          {/* Quick actions — one-tap grid to the most common jumps.
              (The separate Workspace state card that sat above this was
              removed 2026-07-24 — the Workspace tile's subtitle now
              carries the active workspace's name.) Each subtitle
              reflects live data behind its action. */}
          <div className="py-6" data-testid="command-quick-actions">
            <div className="text-[11px] uppercase tracking-[0.08em] text-ink-mute font-semibold mb-2.5">
              Quick actions
            </div>
            <div className="grid grid-cols-2 gap-2">
              <QuickAction
                icon={Building2}
                label="Workspace"
                sub={workspaceName || "None selected"}
                onClick={() => launch(() => navigate("/workspace"))}
                testId="command-quick-workspace"
              />
              <QuickAction
                icon={BookOpen}
                label="Glossary"
                sub={`${GLOSSARY_TERM_COUNT} terms`}
                onClick={() => setView("glossary")}
                testId="command-quick-glossary"
              />
              {/* "Upload files" was removed 2026-07-26 per operator. The
                  Data tab below this grid already carries the upload
                  affordance, and every surface that needs a file has its own
                  dropzone. */}
              <QuickAction
                icon={Settings2}
                label="Decision rules"
                sub="Protect · Watch · Wind down"
                onClick={() => launch(() => setRulesOpen(true))}
                testId="command-quick-rules"
              />
            </div>
          </div>
          <div className="pt-6">
            <DataTab onClose={close} onOpenUpload={onOpenUpload} />
          </div>
        </div>
        )}
      </SheetContent>
    </Sheet>
    {/* Outside the Sheet so it stays mounted (and visible) after the
        panel closes — the quick action closes the panel, then opens
        this. */}
    {/* returnTo={null} — the quick action opens this from ANY page, so
        dismissing must keep the user where they are (the "/products"
        default exists for the Products-page flow). */}
    <DecisionRulesModal open={rulesOpen} onOpenChange={setRulesOpen} returnTo={null} />
    </>
  );
}

// ─── Quick-action tile ─────────────────────────────────────────────────
// Icon-over-label button used by the Quick actions grid above.

function QuickAction({
  icon: Icon,
  label,
  sub,
  onClick,
  testId,
}: {
  icon: LucideIcon;
  label: string;
  /** One-line live-data subtitle (workspace name, term count, …). */
  sub?: string;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="
        flex items-center gap-2.5
        rounded-xl border border-rule bg-surface px-3 py-3
        text-[12px] font-medium text-ink text-left
        hover:bg-bg-2/60 hover:border-rule-strong transition-colors
      "
    >
      <Icon size={16} strokeWidth={1.75} className="shrink-0 text-brand-d" />
      <span className="min-w-0">
        <span className="block truncate">{label}</span>
        {sub && (
          <span className="block truncate text-[10.5px] font-normal text-ink-mute leading-tight">
            {sub}
          </span>
        )}
      </span>
    </button>
  );
}
