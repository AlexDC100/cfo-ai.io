// CFO AI app shell — enterprise layout (Vitalis pattern).
//
//   ┌──────────────────────────────────────────────────────────────┐
//   │ TopHeader (64px, fixed)                                       │
//   ├──────────┬───────────────────────────────────────────────────┤
//   │ Sidebar  │   Main content                                     │
//   │ 240px    │   (pages render here)                              │
//   │ fixed    │                                                    │
//   │          │                                              ✦ AI  │
//   └──────────┴───────────────────────────────────────────────────┘
//
// Sidebar collapses into a Sheet drawer below lg. The floating "Ask CFO AI"
// pill sits bottom-right on every viewport.

import { ReactNode, useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";
import { TopHeader } from "./TopHeader";
import { UploadResumeProvider } from "./UploadResumeProvider";
import { Sidebar } from "./Sidebar";
// FloatingAiButton import removed — see comment in JSX below.
// App-shell cleanup Phase 4 — the legacy CommandDrawer is replaced by
// CommandCenter (4 tabs: Workspace / Data / AI / Account, live state
// card, registry-driven row gating, single sign-out). The old file
// was removed in the 2026-07 dead-code cleanup (recoverable from git history).
import { CommandCenter } from "./command";
// NOTE: `ChatCopilot` is intentionally NOT imported here any more.
// The new chat experience ships in two surfaces that share the same
// components: the full `/chat` page (Chat.tsx → CFOChatShell variant=page)
// and a right-anchored slide-over panel (CFOChatPanel) mounted here so
// every other route can summon "Ask CFO AI" without losing context.
// ChatCopilot.tsx was removed in the 2026-07 dead-code cleanup (git history has it).
import { SearchDialog } from "./SearchDialog";
import { UploadDialog } from "./UploadDialog";
import { DocsPanel } from "./DocsPanel";
import { DatasetsPanel } from "./DatasetsPanel";
import { CFOChatPanel } from "./chat/CFOChatPanel";
import { getChatShellRef } from "./chat/sharedShellRef";
import { OPEN_ASK_CFO_AI_EVENT, type OpenAskCfoAiDetail } from "./chat/openAskCfoAi";
import { useActivePeriod } from "@/lib/activePeriod";
import { useAuth } from "@/lib/auth";
import { useDocsPanelOpen } from "@/lib/docsPanel";
import { useDatasetsPanelOpen } from "@/lib/datasetsPanel";
import { useToast } from "@/hooks/use-toast";
import { UsageWarningBanner } from "./UsageWarningBanner";

interface Props {
  children: ReactNode;
  companyName?: string;
}

export function AppShell({ children }: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [chatPanelOpen, setChatPanelOpen] = useState(false);
  // Optional prefill payload — pages can dispatch the
  // `cfo-ai-open-ask` event with a prompt to drop the composer into
  // an "already typed for you, hit Enter" state.
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);

  // Cross-page listener: any page can `openAskCfoAi("Which SKUs…")`
  // and the panel pops open with the text waiting in the composer.
  // The handler dispatches even when already on /chat — in that case
  // the shell's focusComposer + setText path is what runs (see
  // openAskCfoAi handler below).
  useEffect(() => {
    function onEvt(e: Event) {
      const ce = e as CustomEvent<OpenAskCfoAiDetail>;
      const prompt = ce.detail?.prompt ?? null;
      if (location.pathname.startsWith("/chat")) {
        // Already on the chat page — push the prefill into the live
        // composer and focus it. No panel mount, no overlay.
        const handle = getChatShellRef();
        if (handle) {
          if (prompt) handle.setComposer(prompt);
          else handle.focusComposer();
          return;
        }
      }
      // Not on /chat — open the slide-over panel with the prompt
      // queued; CFOChatPanel will deliver it on first render.
      if (prompt) setPendingPrompt(prompt);
      setChatPanelOpen(true);
    }
    window.addEventListener(OPEN_ASK_CFO_AI_EVENT, onEvt as EventListener);
    return () => window.removeEventListener(OPEN_ASK_CFO_AI_EVENT, onEvt as EventListener);
  }, [location.pathname]);

  // Active-period context for the slide-over panel. The full /chat
  // page already pulls this directly; mounting the same hook here lets
  // the panel ground answers in the user's loaded period from any route.
  const activePeriod = useActivePeriod();
  const panelSnapshot = activePeriod.id ? buildPanelSnapshot(activePeriod) : undefined;

  // Mirror the sidebar's collapsed-rail flag (persisted in localStorage
  // by Sidebar.tsx under key `cfo-ai-sidebar-collapsed-v1`). The main
  // content's left padding follows the rail width so the content
  // doesn't get clipped (240px expanded → 68px collapsed). Reactive to
  // both localStorage changes from this tab (custom event) and other
  // tabs (`storage` event).
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try { return window.localStorage.getItem("cfo-ai-sidebar-collapsed-v1") === "1"; }
    catch { return false; }
  });
  useEffect(() => {
    function read() {
      if (typeof window === "undefined") return;
      try { setSidebarCollapsed(window.localStorage.getItem("cfo-ai-sidebar-collapsed-v1") === "1"); }
      catch { /* private mode */ }
    }
    function onStorage(e: StorageEvent) {
      if (e.key === "cfo-ai-sidebar-collapsed-v1") read();
    }
    // Custom in-tab event so the same tab's collapse-toggle click also
    // updates the main padding without waiting for a re-render race.
    function onCustom() { read(); }
    window.addEventListener("storage", onStorage);
    window.addEventListener("cfo-ai-sidebar-collapsed", onCustom);
    // Re-read on focus too — covers edge cases where the page was hidden.
    window.addEventListener("focus", read);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("cfo-ai-sidebar-collapsed", onCustom);
      window.removeEventListener("focus", read);
    };
  }, []);

  // "Ask CFO AI" smart-open:
  //   · On /chat: focus the live composer (no nav, no overlay — the user
  //     is already in the assistant). Falls back to opening the panel
  //     only if the shell ref hasn't published yet (first paint).
  //   · Elsewhere: open the right-anchored slide-over panel that mounts
  //     the SAME conversation engine + history + composer as /chat.
  const openAskCfoAi = useCallback(() => {
    if (location.pathname.startsWith("/chat")) {
      const handle = getChatShellRef();
      if (handle) {
        handle.focusComposer();
        return;
      }
    }
    setChatPanelOpen(true);
  }, [location.pathname]);

  // The previous behaviour was to fully navigate the user from any
  // surface to /chat. That broke flow — opening a side panel keeps the
  // benchmark / dashboard / products page they were on. The expanded
  // "Open page" affordance inside the panel header still lets them
  // jump to the full surface when they want it. ?period= is preserved
  // there.
  void params; // (param-preservation handled by CFOChatPanel.expandToPage)
  // Slide-out panels — when either is open on wide screens, main
  // content reflows left to avoid being covered.
  const [docsOpen] = useDocsPanelOpen();
  const [datasetsOpen] = useDatasetsPanelOpen();
  const anySlideoutOpen = docsOpen || datasetsOpen;

  // Cmd/Ctrl+K opens the search palette anywhere
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Sidebar handlers. `onOpenCommandCenter` is the relocated CC trigger
  // (System group below Settings). `onSignOut` USED to drive a Sidebar
  // sign-out row; the row was removed in the May 2026 redesign and the
  // THE single sign-out now lives in the top-right <AccountMenu/>
  // (`data-testid="account-menu-sign-out"`). The handler is still wired
  // through to Sidebar so a future revert is one-line JSX restore, not
  // a propagating prop change.
  const { signOut } = useAuth();
  const { toast } = useToast();
  const sidebarHandlers = {
    onSettings: () => navigate("/settings"),
    onOpenCommandCenter: () => setDrawerOpen(true),
    onSignOut: async () => {
      const { error } = await signOut();
      if (error) {
        toast({
          title: "Sign-out failed",
          description: error.message,
          variant: "destructive",
        });
        return;
      }
      toast({ title: "Signed out" });
      navigate("/login", { replace: true });
    },
  };

  return (
    <div className="min-h-screen bg-bg text-ink">
      {/* Resumes polling on any persisted in-flight upload when the app
          shell mounts (page refresh during an analysis). Renders nothing. */}
      <UploadResumeProvider />
      <TopHeader
        onOpenAi={openAskCfoAi}
        onOpenSidebar={() => setSidebarOpen(true)}
        onOpenAccount={() => setDrawerOpen(true)}
      />

      {/* Persistent sidebar (lg+) */}
      <Sidebar {...sidebarHandlers} />

      {/* Mobile sidebar — slide-over drawer */}
      <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
        <SheetContent
          side="left"
          className="
            w-[min(280px,calc(100vw-3rem))] p-0
            bg-bg
            border-r border-rule
            [&>button.absolute]:hidden
            overflow-y-auto overscroll-contain
          "
          style={{
            paddingTop: "env(safe-area-inset-top)",
            paddingBottom: "env(safe-area-inset-bottom)",
            paddingLeft: "env(safe-area-inset-left)",
          }}
        >
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <div className="h-16 border-b border-rule" />
          <Sidebar
            {...sidebarHandlers}
            inDrawer
            onItemClick={() => setSidebarOpen(false)}
          />
        </SheetContent>
      </Sheet>

      {/* Slide-out panels — right-anchored, available across every
          authenticated page. Two distinct panels with distinct shortcuts:
            · Docs (Cmd/Ctrl+D)        — financial-statement documents
            · Datasets (Cmd/Ctrl+⇧+D)  — sales/SKU datasets
          Only one renders at a time visually because the URL doesn't
          trigger both pills simultaneously, but if both are open the
          Datasets panel z-stacks on top via the same fixed positioning. */}
      <DocsPanel />
      <DatasetsPanel />

      {/* Main content — offset for the fixed header + sidebar. When any
          slide-out is open on wide screens (≥1280px) the content shifts
          left by the panel's width so nothing is hidden. */}
      <main className={`pt-16 ${sidebarCollapsed ? "lg:pl-[92px]" : "lg:pl-[268px]"} ${anySlideoutOpen ? "xl:pr-[360px]" : ""} transition-[padding] duration-200 ease-out`}>
        {/* WS1 — sticky usage warning when caller is at 80%+ of any
            cap. Renders null when under threshold, off, dismissed, or
            no plan state. Stays at top of the main scroll region so it
            doesn't fight with the fixed TopHeader. */}
        <UsageWarningBanner />
        {/* Site-wide content-width clamp. Every in-app page renders through
            this wrapper, so the max-width here is the single rule that keeps
            content from stretching across ultra-wide monitors. Left-anchored
            (no mx-auto) so content aligns to the left edge just under the
            sidebar. Individual pages should NOT re-clamp — they inherit this.
            /chat renders here too now (document-level scroll, same as every
            other tab) — its shell cancels this wrapper's bottom padding. */}
        <div
          className="px-4 sm:px-8 lg:px-10 py-6 sm:py-10 lg:py-12 relative isolate max-w-[1760px]"
          style={{ paddingBottom: "max(8rem, calc(env(safe-area-inset-bottom) + 6rem))" }}
        >
          {/* Shared atmospheric brand glow behind every page's content — the
              "dashboard background" applied app-wide so all tabs read with the
              exact same subtle backdrop. -z-10 keeps it behind content. */}
          <div
            aria-hidden
            className="pointer-events-none absolute -top-12 -left-12 h-72 w-72 rounded-full bg-brand/10 blur-3xl z-[-10]"
          />
          {children}
        </div>
      </main>

      {/* Floating Ask CFO AI launcher removed per the operator's
          directive. `openAskCfoAi` is still wired below for the
          slide-over panel — invoked by Command Center → Workspace
          tab, by in-page chips that dispatch OPEN_ASK_CFO_AI_EVENT,
          and by the keyboard shortcut. Component file
          FloatingAiButton.tsx was removed in the 2026-07 cleanup (git history has it). */}

      {/* Slide-over Ask CFO AI panel — shown from any non-/chat route.
       *  Reuses CFOChatShell (variant="panel") which mounts the same
       *  conversation store, history sidebar, message components, and
       *  composer as the /chat page. */}
      <CFOChatPanel
        open={chatPanelOpen}
        onClose={() => { setChatPanelOpen(false); setPendingPrompt(null); }}
        workspaceSnapshot={panelSnapshot}
        periodId={activePeriod.id}
        periodLabel={activePeriod.label}
        companyName={activePeriod.statements?.companyName ?? null}
        prefillPrompt={pendingPrompt}
        onPrefillConsumed={() => setPendingPrompt(null)}
      />

      {/* Overlays */}
      <CommandCenter
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        onOpenAi={openAskCfoAi}
        onOpenUpload={() => setUploadOpen(true)}
      />
      <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
      <UploadDialog open={uploadOpen} onOpenChange={setUploadOpen} />
    </div>
  );
}

// ─── Workspace snapshot for the slide-over ────────────────────────
// Compact serialisation of the active period so the panel can ground
// answers from any route. Mirrors the format used by the /chat page
// (intentionally identical so an answer asked from the panel matches
// what /chat would return for the same prompt). No engine recompute —
// pure formatting of values the engine already emits.
type ActivePeriod = ReturnType<typeof useActivePeriod>;
function buildPanelSnapshot(p: ActivePeriod): string | undefined {
  if (!p.id) return undefined;
  const lines: string[] = [];
  lines.push(`Period: ${p.label ?? p.id}`);
  if (p.statements?.companyName) lines.push(`Company: ${p.statements.companyName}`);
  if (p.industry) lines.push(`Industry: ${p.industry}`);
  if (p.metrics && p.metrics.length > 0) {
    lines.push("\nHeadline metrics:");
    for (const m of p.metrics) {
      if (m.value === null || m.value === undefined) continue;
      lines.push(`  · ${m.name}: ${m.value}${m.unit ? " " + m.unit : ""}`);
    }
  }
  if (p.briefing) {
    lines.push("\nPrior briefing:");
    lines.push(p.briefing.trim());
  }
  return lines.join("\n");
}
