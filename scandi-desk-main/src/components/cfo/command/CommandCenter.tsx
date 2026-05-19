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

import { useState } from "react";
import { X } from "lucide-react";

import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";

import { StateCard } from "./StateCard";
import { AccountTab } from "./tabs/AccountTab";
// AiTab removed from the Command Center per the operator's directive:
// "Ask CFO AI" is reachable from the always-visible TopHeader pill and
// the floating bottom-right button, so giving it a dedicated tab here
// duplicated the affordance and pushed the more actionable Workspace /
// Data / Account surfaces down. The AiTab file remains on disk for
// revert (`./tabs/AiTab.tsx`).
import { DataTab } from "./tabs/DataTab";
import { WorkspaceTab } from "./tabs/WorkspaceTab";

export type CommandCenterTab = "workspace" | "data" | "account";

const TABS: { id: CommandCenterTab; label: string }[] = [
  { id: "workspace", label: "Workspace" },
  { id: "data",      label: "Data" },
  { id: "account",   label: "Account" },
];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Open the Ask CFO AI panel. */
  onOpenAi: () => void;
  /** Open the upload flow. */
  onOpenUpload: () => void;
  /** Initial tab to land on. Defaults to "workspace". */
  initialTab?: CommandCenterTab;
}

export function CommandCenter({
  open,
  onOpenChange,
  onOpenAi,
  onOpenUpload,
  initialTab = "workspace",
}: Props) {
  const [tab, setTab] = useState<CommandCenterTab>(initialTab);
  const close = () => onOpenChange(false);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        data-testid="command-center"
        className="
          w-[calc(100vw-24px)] sm:w-[440px] sm:max-w-[460px]
          p-0 m-3 h-[calc(100vh-24px)]
          rounded-3xl
          bg-surface dark:bg-bg-2
          border border-rule-strong
          text-ink
          shadow-4
          [&>button.absolute]:hidden
          flex flex-col
        "
      >
        {/* ── Header ────────────────────────────────────────── */}
        <div className="px-5 pt-5 pb-4">
          <div className="flex items-center justify-between mb-4">
            <SheetTitle className="text-[15px] font-medium text-ink">
              Command Center
            </SheetTitle>
            <button
              type="button"
              onClick={close}
              aria-label="Close"
              className="text-ink-mute hover:text-ink p-1 -m-1 rounded-md transition-colors"
            >
              <X size={16} strokeWidth={1.75} />
            </button>
          </div>

          {/* Live workspace state — single source of truth via
              useActivePeriod. Replaces the legacy hardcoded
              "No dataset connected" string the user complained about. */}
          <StateCard onUpload={() => { close(); setTimeout(onOpenUpload, 220); }} />

          {/* Segmented control — 4 tabs only. The previous CommandDrawer
              had 5 (with a Rules tab). Rules moved to /settings. */}
          <div
            role="tablist"
            aria-label="Command Center tabs"
            data-testid="command-tabs"
            className="mt-4 grid grid-cols-3 gap-0.5 p-0.5 rounded-lg bg-bg-2 border border-rule"
          >
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                aria-controls={`command-panel-${t.id}`}
                data-testid={`command-tab-${t.id}`}
                onClick={() => setTab(t.id)}
                className={`
                  rounded-md py-1.5 text-[12px] font-medium transition-colors
                  ${tab === t.id
                    ? "bg-surface text-ink shadow-1"
                    : "text-ink-soft hover:text-ink"}
                `}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* ── Content ───────────────────────────────────────── */}
        <div
          className="px-5 pb-6 overflow-y-auto flex-1"
          id={`command-panel-${tab}`}
          role="tabpanel"
        >
          {tab === "workspace" && (
            <WorkspaceTab
              onClose={close}
              onOpenAi={onOpenAi}
              onOpenUpload={onOpenUpload}
            />
          )}
          {tab === "data" && (
            <DataTab onClose={close} onOpenUpload={onOpenUpload} />
          )}
          {tab === "account" && (
            <AccountTab onClose={close} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
