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
// Data / Account surfaces down. The AiTab file was removed in the
// 2026-07 dead-code cleanup (recoverable from git history).
import { DataTab } from "./tabs/DataTab";

// Retained for API compatibility (re-exported from ./index) even though the
// panel no longer uses a tab switcher.
export type CommandCenterTab = "workspace" | "data" | "account";

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
  const close = () => onOpenChange(false);

  return (
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
            Radix's default close, and would hide this one too if unwrapped. */}
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

        {/* ── Content ───────────────────────────────────────────────────
            Stacked in one scroll column: Account (profile + plan + actions)
            at the top, then the Workspace state card, then Data. */}
        <div
          className="px-5 pt-3 pb-6 overflow-y-auto flex-1 divide-y divide-rule"
          data-testid="command-content"
        >
          <div className="pb-6">
            <AccountTab onClose={close} />
          </div>
          {/* Workspace section — live workspace state (single source of
              truth via useActivePeriod). Sits under the account block. */}
          <div className="py-6">
            <StateCard onUpload={() => { close(); setTimeout(onOpenUpload, 220); }} />
          </div>
          <div className="pt-6">
            <DataTab onClose={close} onOpenUpload={onOpenUpload} />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
