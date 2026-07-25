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
import { CouncilSphereHost } from "./CouncilSphereHost";
import { DatasetsPanel } from "./DatasetsPanel";
import { getChatShellRef } from "./chat/sharedShellRef";
import { OPEN_ASK_CFO_AI_EVENT, type OpenAskCfoAiDetail } from "./chat/openAskCfoAi";
import { useAuth } from "@/lib/auth";
import { useWorkspaces } from "@/lib/workspaces";
import { useDocsPanelOpen } from "@/lib/docsPanel";
import { useDatasetsPanelOpen } from "@/lib/datasetsPanel";
import { useToast } from "@/hooks/use-toast";
import { UsageWarningBanner } from "./UsageWarningBanner";
import { MonthSwitchOverlay } from "./MonthSwitchOverlay";

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

  // Navigate to the full /chat page (the slide-over panel is gone,
  // 2026-07-24), preserving ?period= and delivering the prompt into the
  // composer once the chat shell has mounted and published its ref.
  const goToChat = useCallback(
    (prompt: string | null, opts?: { newChat?: boolean }) => {
      const period = params.get("period");
      navigate(period ? `/chat?period=${encodeURIComponent(period)}` : "/chat");
      if (!prompt && !opts?.newChat) return;
      let tries = 0;
      const deliver = () => {
        const handle = getChatShellRef();
        if (handle) {
          if (opts?.newChat) handle.newChat();
          if (prompt) handle.setComposer(prompt);
          else handle.focusComposer();
          return;
        }
        if (++tries < 40) setTimeout(deliver, 50);
      };
      setTimeout(deliver, 50);
    },
    [navigate, params],
  );

  // Cross-page listener: any page can `openAskCfoAi("Which SKUs…")`.
  // EVERY Ask CFO AI entry starts a FRESH conversation (2026-07-24
  // directive) — with the prompt pre-typed when one was supplied. On
  // /chat that happens in place; from anywhere else we navigate to
  // /chat and deliver there.
  useEffect(() => {
    function onEvt(e: Event) {
      const ce = e as CustomEvent<OpenAskCfoAiDetail>;
      const prompt = ce.detail?.prompt ?? null;
      if (location.pathname.startsWith("/chat")) {
        const handle = getChatShellRef();
        if (handle) {
          handle.newChat();
          if (prompt) handle.setComposer(prompt);
          else handle.focusComposer();
          return;
        }
      }
      goToChat(prompt, { newChat: true });
    }
    window.addEventListener(OPEN_ASK_CFO_AI_EVENT, onEvt as EventListener);
    return () => window.removeEventListener(OPEN_ASK_CFO_AI_EVENT, onEvt as EventListener);
  }, [location.pathname, goToChat]);

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

  // "Ask CFO AI" smart-open — always lands the user in a FRESH
  // conversation (2026-07-24 directive), on /chat directly or after
  // navigating there. (The store's createNew reuses an existing empty
  // conversation rather than stacking blanks.) Prompt-carrying chips go
  // through the event path above and keep the current conversation.
  const openAskCfoAi = useCallback(() => {
    if (location.pathname.startsWith("/chat")) {
      const handle = getChatShellRef();
      if (handle) {
        handle.newChat();
        handle.focusComposer();
        return;
      }
    }
    goToChat(null, { newChat: true });
  }, [location.pathname, goToChat]);
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

  // No workspaces yet (fresh signup, or the user deleted them all) → the app
  // has nothing to navigate between, so the whole left nav is hidden and the
  // content runs full-width until they create one. Gated on !loading so the
  // sidebar doesn't flash out during the initial workspace resolve.
  const { workspaces, loading: wsLoading } = useWorkspaces();
  const noWorkspaces = !wsLoading && workspaces.length === 0;
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
      {/* Full-screen veil while switching months from the tab-bar stepper. */}
      <MonthSwitchOverlay />
      <TopHeader
        onOpenAi={openAskCfoAi}
        onOpenSidebar={() => setSidebarOpen(true)}
        onOpenAccount={() => setDrawerOpen(true)}
      />

      {/* Persistent sidebar (lg+). With no workspace yet, it stays visible but
          every destination that needs workspace data is disabled — only
          Workspaces, Settings, the website link, the collapse toggle and the
          disclaimer stay live (see `noWorkspace` prop in Sidebar). */}
      <Sidebar {...sidebarHandlers} noWorkspace={noWorkspaces} />

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
            noWorkspace={noWorkspaces}
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

      {/* Council sphere — ONE persistent instance for the lifetime of a
          scan, mounted here (not per-page) so switching tabs never
          resets its animation; it hides off-dashboard and keeps
          evolving. See CouncilSphereHost. */}
      <CouncilSphereHost sidebarCollapsed={sidebarCollapsed} />

      {/* Main content — offset for the fixed header + sidebar. When any
          slide-out is open on wide screens (≥1280px) the content shifts
          left by the panel's width so nothing is hidden. */}
      <main className={`pt-16 ${sidebarCollapsed ? "lg:pl-[80px]" : "lg:pl-[268px]"} ${anySlideoutOpen ? "xl:pr-[360px]" : ""} transition-[padding] duration-200 ease-out`}>
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

      {/* The slide-over Ask CFO AI panel (CFOChatPanel) was removed
          2026-07-24 per operator directive — every Ask CFO AI entry
          point now navigates to the full /chat page, carrying the
          prompt into the composer. */}

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

// buildPanelSnapshot (the slide-over's workspace serialisation) was
// removed with CFOChatPanel — /chat builds its own grounding context.
