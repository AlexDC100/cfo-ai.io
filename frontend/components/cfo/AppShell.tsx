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
import { useTranslation } from "react-i18next";
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
import { useEnsureCurrentPeriod } from "@/hooks/useEnsureCurrentPeriod";
import { useActivePeriod } from "@/lib/activePeriod";
import { ContentLoader } from "./AppLoader";
import { UsageWarningBanner } from "./UsageWarningBanner";
import { MonthSwitchOverlay } from "./MonthSwitchOverlay";

interface Props {
  children: ReactNode;
  companyName?: string;
}

export function AppShell({ children }: Props) {
  const { t } = useTranslation();
  // A workspace always has at least one period — if the active one has none,
  // this creates an empty container for the current month. Lives here (one
  // mount, app-wide) so two surfaces can't race to create the same month.
  useEnsureCurrentPeriod();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  // Content-region loader (2026-07-26 per operator). Pages render straight
  // from the period payload, which is EMPTY while its fetch is in flight — so
  // a tab painted its no-data layout for a frame and then swapped in the real
  // numbers. Hold the region until the payload lands so it's one paint.
  //
  // Only a genuine fetch triggers this: navigating between tabs on a period
  // already in the query cache resolves synchronously and never flips
  // `isLoading`. /chat is exempt — it's useful with no period at all, so
  // covering it would be a regression, not a fix.
  const activePeriod = useActivePeriod();
  const contentLoading = activePeriod.isLoading && location.pathname !== "/chat";
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Navigate to the full /chat page (the slide-over panel is gone,
  // 2026-07-24), preserving ?period= and delivering the prompt into the
  // composer once the chat shell has mounted and published its ref.
  const goToChat = useCallback(
    (prompt: string | null, opts?: { newChat?: boolean; focus?: boolean }) => {
      const period = params.get("period");
      navigate(period ? `/chat?period=${encodeURIComponent(period)}` : "/chat");
      if (!prompt && !opts?.newChat && !opts?.focus) return;
      let tries = 0;
      const deliver = () => {
        const handle = getChatShellRef();
        if (handle) {
          if (opts?.newChat) handle.newChat();
          if (prompt) {
            // newChat() changes the active conversation, which REMOUNTS the
            // composer (its React key is the conversation id). Setting the
            // text synchronously here would land it on the composer that's
            // about to unmount — the fresh one then reads an empty draft and
            // the prompt is lost. Defer to the next tick so it lands on the
            // newly-mounted composer instead.
            setTimeout(() => getChatShellRef()?.setComposer(prompt), 0);
          } else {
            handle.focusComposer();
          }
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
          // Defer the text so it lands on the composer freshly remounted by
          // newChat() (its key is the conversation id), not the unmounting one.
          if (prompt) setTimeout(() => getChatShellRef()?.setComposer(prompt), 0);
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

  // "Ask CFO AI" nav entry — RESUMES the conversation the user last had open
  // (2026-07-26 per operator), rather than starting a fresh one. Leaving the
  // tab to check a number on another page and coming back is the common move,
  // and forcing a new conversation each time (the 2026-07-24 directive this
  // replaces) meant the thread you were mid-way through slid into history and
  // you landed on a blank composer. The store already persists the open
  // conversation id (useChatStore's CHAT_CURRENT_KEY), so simply NOT creating
  // one restores it — on /chat we just focus the composer.
  //
  // Starting a new conversation is still one click away: "New chat" in the
  // history sidebar. And a PROMPT-carrying entry (a page's suggestion chip,
  // via the event listener above) still forces a fresh thread, since a
  // question asked from another surface shouldn't append to an unrelated one.
  const openAskCfoAi = useCallback(() => {
    if (location.pathname.startsWith("/chat")) {
      const handle = getChatShellRef();
      if (handle) {
        handle.focusComposer();
        return;
      }
    }
    goToChat(null, { focus: true });
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
  // Also true when a workspace EXISTS but hasn't been set up yet — the state
  // a brand-new account lands in, since signup auto-creates an org with no
  // industry_key. AuthGuard already bounces every data route back to
  // /workspace in that state (`needsOnboarding`), so leaving those tabs
  // looking live meant every click silently ricocheted back to the wizard.
  // Dimming them makes the rail describe what the guard will actually do.
  // `ALWAYS_ENABLED` in Sidebar keeps Workspaces, Settings, Ask CFO AI and
  // the website clickable throughout.
  // 2026-08-02 (workspace-flow fix): dropped `|| needsOnboarding` — a fresh
  // signup's workspace has no industry_key yet, and dimming the whole rail for
  // that re-walled the app the AuthGuard change just un-walled. Only a genuine
  // zero-live-workspace state dims navigation now (industry is optional and
  // set later from Workspace settings or the Benchmark picker).
  const noWorkspaces = !wsLoading && workspaces.length === 0;
  const sidebarHandlers = {
    onSettings: () => navigate("/settings"),
    onOpenCommandCenter: () => setDrawerOpen(true),
    onSignOut: async () => {
      const { error } = await signOut();
      if (error) {
        toast({
          title: t("account.signOutFailed"),
          description: error.message,
          variant: "destructive",
        });
        return;
      }
      toast({ title: t("account.signedOut") });
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
        // onOpenAccount removed 2026-08-04 (header redesign): the avatar
        // opens the AccountMenu dropdown again — it now hosts the
        // Learning-mode picker, Billing, Settings and sign-out. The
        // Command Center drawer stays reachable via its other triggers.
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
          <SheetTitle className="sr-only">{t("panels.navigation")}</SheetTitle>
          <div className="h-14 border-b border-rule" />
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
      <main
        className={`pt-14 ${sidebarCollapsed ? "lg:pl-[80px]" : "lg:pl-[268px]"} ${anySlideoutOpen ? "xl:pr-[360px]" : ""} transition-[padding] duration-200 ease-out`}
        // Notch devices: keep content clear of the home indicator.
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
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

        {/* Held until the period payload lands — see `contentLoading` above.
            Inside <main> but fixed-positioned, so it covers the content
            region while the header and rail stay live and navigable. */}
        {contentLoading && <ContentLoader sidebarCollapsed={sidebarCollapsed} />}
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
        // 2026-08-02: routes to the Dashboard's upload flow instead of the
        // legacy UploadDialog. That dialog posted to /api/upload-excel — the
        // SKU-trading parser — so a trial balance dropped there died with the
        // cryptic "missing Categ_Pr / Volume(to) / NIV (kRon)" error (the
        // operator hit exactly this). The dashboard dropzone runs the real
        // financial pipeline; SKU files have their own uploader on /products.
        onOpenUpload={() => {
          const period = params.get("period");
          navigate(period ? `/dashboard?period=${encodeURIComponent(period)}` : "/dashboard");
        }}
      />
      <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
    </div>
  );
}

// buildPanelSnapshot (the slide-over's workspace serialisation) was
// removed with CFOChatPanel — /chat builds its own grounding context.
