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

import { ReactNode, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { IosSpinner } from "./IosSpinner";
import { useChatStore } from "./chat/useChatStore";
import { refreshFeatures } from "@/lib/features";
import { queryClient } from "@/lib/queryClient";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";
import { TopHeader } from "./TopHeader";
import { PreviewSheet } from "./PreviewSheet";
import { closePreviewSheet, getPreviewSheet, subscribePreviewSheet } from "@/lib/previewSheet";
import { getOnboardingOpen, subscribeOnboarding } from "@/lib/onboarding";
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
// SearchDialog was the pre-Instrument ⌘K surface; the CommandPalette
// (instrument/shell) replaces it — same search domains plus pages,
// actions, recent periods and companies. The old file stays for git
// archaeology but is no longer mounted.
import { CommandPalette } from "@/components/instrument/shell/CommandPalette";
import { SIDEBAR_TOGGLE_EVENT } from "./Sidebar";
import { DocsPanel } from "./DocsPanel";
import { CouncilSphereHost } from "./CouncilSphereHost";
import { DatasetsPanel } from "./DatasetsPanel";
import { getChatShellRef } from "./chat/sharedShellRef";
import { OPEN_ASK_CFO_AI_EVENT, type OpenAskCfoAiDetail } from "./chat/openAskCfoAi";
import { useAuth } from "@/lib/auth";
import {
  isNativeShell,
  postToNativeShell,
  NATIVE_ACTION_EVENT,
  openNativeSheet,
} from "@/lib/nativeShell";
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
  // /chat owns the viewport: the document must not scroll behind its
  // fixed-height column (index.css `html.chat-page-open`).
  const chatPage = location.pathname.startsWith("/chat");
  useEffect(() => {
    document.documentElement.classList.toggle("chat-page-open", chatPage);
    return () => document.documentElement.classList.remove("chat-page-open");
  }, [chatPage]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const drawerSwipe = useRef<{ x: number; y: number; dx: number; axis: "h" | "v" | null; t: number } | null>(null);
  const onDrawerSwipeStart = useCallback((e: React.TouchEvent) => {
    const t = e.touches[0];
    if (!t) return;
    drawerSwipe.current = { x: t.clientX, y: t.clientY, dx: 0, axis: null, t: Date.now() };
  }, []);
  const onDrawerSwipeMove = useCallback((e: React.TouchEvent) => {
    const s = drawerSwipe.current;
    const t = e.touches[0];
    if (!s || !t) return;
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    if (!s.axis) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      s.axis = Math.abs(dx) > Math.abs(dy) ? "h" : "v";
    }
    if (s.axis !== "h") return;
    s.dx = Math.min(0, dx);
    const el = drawerRef.current;
    if (el) {
      el.style.transition = "none";
      el.style.transform = `translateX(${s.dx}px)`;
    }
  }, []);
  const onDrawerSwipeEnd = useCallback(() => {
    const s = drawerSwipe.current;
    drawerSwipe.current = null;
    if (!s || s.axis !== "h") return;
    const el = drawerRef.current;
    const width = el?.offsetWidth ?? 280;
    const flick = Date.now() - s.t < 300 && s.dx < -40;
    if (flick || -s.dx > width / 3) {
      // Leave the inline offset in place: the exit animation only declares
      // its end keyframe, so it slides out from where the finger left it.
      setSidebarOpen(false);
      return;
    }
    if (el) {
      el.style.transition = "transform 180ms ease-out";
      el.style.transform = "";
      window.setTimeout(() => {
        el.style.transition = "";
      }, 200);
    }
  }, []);
  // Opening the drawer dismisses the on-screen keyboard (2026-09-08 per
  // operator): blur whatever input has focus (the chat composer, a search
  // field) before the sheet slides in, so the keyboard doesn't stay up
  // behind it.
  const openDrawer = useCallback(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) active.blur();
    setSidebarOpen(true);
  }, []);


  // ── iOS/Android native shell integration (see frontend/lib/nativeShell.ts
  // and mobile/README.md). Inside the shell the TopHeader isn't rendered at
  // all; navigation is the shell's NATIVE floating burger (native because a
  // web-fixed button drifts during fling scrolls/overscroll). `inNativeShell`
  // is stable for the page's lifetime — the WebView injects the marker
  // before any script runs.
  const inNativeShell = isNativeShell();
  // An in-app preview sheet (lib/previewSheet.ts) is open — in the shell the
  // native button becomes "back" for as long as it is.
  const previewOpen = useSyncExternalStore(subscribePreviewSheet, getPreviewSheet, () => null) !== null;
  // The first-run onboarding covers the whole screen — no burger over it.
  const onboardingOpen = useSyncExternalStore(subscribeOnboarding, getOnboardingOpen, () => false);

  // Tell the shell when to show its burger: on while AppShell is mounted,
  // off while the drawer is open (the native button would float above the
  // open drawer) and off when AppShell unmounts (sign-out → /login). While
  // a preview sheet is open the same button shows as BACK instead
  // (2026-09-08 per operator).
  useEffect(() => {
    if (!inNativeShell) return undefined;
    postToNativeShell({
      source: "cfo-ai",
      type: "chrome",
      burger: !sidebarOpen && !previewOpen && !onboardingOpen,
      back: previewOpen && !onboardingOpen,
    });
    return () => {
      postToNativeShell({ source: "cfo-ai", type: "chrome", burger: false, back: false });
    };
  }, [inNativeShell, sidebarOpen, previewOpen, onboardingOpen]);

  // Shell: the Command Center bottom sheet rises OVER the open drawer, so a
  // jump launched from it (Workspace, Settings…) must also dismiss the
  // drawer underneath — close it whenever the route changes.
  useEffect(() => {
    if (inNativeShell) setSidebarOpen(false);
  }, [inNativeShell, location.pathname]);

  // A native button tap arrives as a `cfo:native-action` CustomEvent —
  // "menu" opens the drawer, "back" closes the preview sheet.
  useEffect(() => {
    if (!inNativeShell) return undefined;
    function onAction(e: Event) {
      const detail = (e as CustomEvent<{ action?: string; path?: string }>).detail;
      const action = detail?.action;
      if (action === "menu") openDrawer();
      else if (action === "back") closePreviewSheet();
      // A jump launched inside a native sheet (Workspace, Settings…) — the
      // shell dismissed the sheet and forwards the route here.
      else if (action === "navigate" && typeof detail?.path === "string") navigate(detail.path);
    }
    window.addEventListener(NATIVE_ACTION_EVENT, onAction as EventListener);
    return () =>
      window.removeEventListener(NATIVE_ACTION_EVENT, onAction as EventListener);
  }, [inNativeShell]);

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

  // Global command-deck shortcuts:
  //   ⌘K — command palette · ⌘J — Ask CFO AI · ⌘. — toggle the rail.
  // ⌘D (docs) and ⌘⇧D (datasets) are registered by their own panel hooks;
  // nothing else in the app binds K / J / period with the modifier.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      if (key === "k") {
        e.preventDefault();
        setSearchOpen(true);
      } else if (key === "j" && !e.shiftKey) {
        e.preventDefault();
        openAskCfoAi();
      } else if (e.key === ".") {
        e.preventDefault();
        try { window.dispatchEvent(new Event(SIDEBAR_TOGGLE_EVENT)); } catch { /* SSR */ }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openAskCfoAi]);

  // Sidebar handlers. `onOpenCommandCenter` is the relocated CC trigger
  // (System group below Settings). `onSignOut` USED to drive a Sidebar
  // sign-out row; the row was removed in the May 2026 redesign and the
  // THE single sign-out now lives in the top-right <AccountMenu/>
  // (`data-testid="account-menu-sign-out"`). The handler is still wired
  // through to Sidebar so a future revert is one-line JSX restore, not
  // a propagating prop change.
  const { signOut, isAuthenticated } = useAuth();
  const { toast } = useToast();

  // No workspaces yet (fresh signup, or the user deleted them all) → the app
  // has nothing to navigate between, so the whole left nav is hidden and the
  // content runs full-width until they create one. Gated on !loading so the
  // sidebar doesn't flash out during the initial workspace resolve.
  const { workspaces, loading: wsLoading, refresh: refreshWorkspaces } = useWorkspaces();

  // Pull-to-refresh on the drawer (2026-09-08 per operator, replacing a
  // refresh button): pulling the drawer's content down from its top
  // reveals the indicator; releasing past the threshold refreshes the
  // SIDEBAR's data only — conversations, workspaces, the feature registry
  // and every cached query — never the open tab. The drawer is its own
  // scroller, so the WebView's native pull-to-refresh (which watches the
  // document) never fires inside it.
  const PULL_THRESHOLD = 64;
  const chatStore = useChatStore();
  const [drawerPull, setDrawerPull] = useState(0);
  const [drawerRefreshing, setDrawerRefreshing] = useState(false);
  // The indicator fades out when the refresh is done (2026-09-09 per
  // operator) before its row collapses.
  const [drawerFading, setDrawerFading] = useState(false);
  const pullStartY = useRef<number | null>(null);
  const drawerScrollerRef = useRef<HTMLDivElement>(null);
  const onDrawerTouchStart = useCallback((e: React.TouchEvent) => {
    const scroller = drawerScrollerRef.current?.querySelector<HTMLElement>("[data-drawer-scroller]");
    pullStartY.current =
      scroller && scroller.scrollTop <= 0 ? e.touches[0].clientY : null;
  }, []);
  const onDrawerTouchMove = useCallback((e: React.TouchEvent) => {
    if (pullStartY.current === null || drawerRefreshing) return;
    const scroller = drawerScrollerRef.current?.querySelector<HTMLElement>("[data-drawer-scroller]");
    if (scroller && scroller.scrollTop > 0) { pullStartY.current = null; setDrawerPull(0); return; }
    const dy = e.touches[0].clientY - pullStartY.current;
    // Dead zone: a tap always carries a few px of travel; growing the
    // indicator for those shifted the top rows under the finger, so the
    // first tap on Dashboard sometimes missed (2026-09-08 per operator).
    // Beyond it: half the finger travel, capped a little past the threshold.
    const PULL_SLACK = 12;
    setDrawerPull(dy > PULL_SLACK ? Math.min((dy - PULL_SLACK) * 0.5, PULL_THRESHOLD + 24) : 0);
  }, [drawerRefreshing]);
  const onDrawerTouchEnd = useCallback(() => {
    if (pullStartY.current === null) return;
    pullStartY.current = null;
    if (drawerPull < PULL_THRESHOLD) {
      setDrawerPull(0);
      return;
    }
    setDrawerRefreshing(true);
    const started = Date.now();
    void Promise.allSettled([
      chatStore.refresh(),
      refreshWorkspaces(),
      refreshFeatures(),
      queryClient.invalidateQueries(),
    ]).then(() => {
      // Keep the spinner up at least briefly so a fast refresh still reads
      // as one.
      const rest = Math.max(0, 600 - (Date.now() - started));
      window.setTimeout(() => {
        setDrawerFading(true);
        window.setTimeout(() => {
          setDrawerRefreshing(false);
          setDrawerPull(0);
          setDrawerFading(false);
        }, 260);
      }, rest);
    });
  }, [drawerPull, chatStore, refreshWorkspaces]);
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
  // 2026-09-04 (guest mode): signed-in only. A guest trivially has zero
  // workspaces, but every tab must stay browsable for them (per operator:
  // "all tabs accessible, actions guarded") — the sign-in gate lives at the
  // action, not the navigation.
  const noWorkspaces = isAuthenticated && !wsLoading && workspaces.length === 0;
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
    // Native shell (2026-09-08 per operator): NO canvas paint here — the
    // shell draws the canvas + spotlight natively behind a transparent
    // WebView, and this root must let it through so the page and the
    // overscroll area share one continuous background. Browsers paint bg-bg.
    <div className={`min-h-screen text-ink ${inNativeShell ? "" : "bg-bg"}`}>
      {/* Resumes polling on any persisted in-flight upload when the app
          shell mounts (page refresh during an analysis). Renders nothing. */}
      <UploadResumeProvider />
      {/* Full-screen veil while switching months from the tab-bar stepper. */}
      <MonthSwitchOverlay />
      {/* In-app preview documents (native shell) — renders nothing until a
          preview is opened; see lib/previewSheet.ts. */}
      <PreviewSheet />
      {/* Native shell only (2026-09-08 per operator): the page renders
          edge-to-edge under the status bar, so content scrolling beneath
          the clock fades out into the page background. Theme-aware via the
          bg token; sits above content, below the drawer/preview sheet
          (z-50); the native burger/back button is drawn by the shell on top. */}
      {inNativeShell && (
        <div
          aria-hidden
          data-testid="shell-top-fade"
          className="shell-top-fade pointer-events-none fixed inset-x-0 top-0 z-30 transition-opacity duration-200"
          style={{
            height: "calc(env(safe-area-inset-top) + 28px)",
            // Paints the SAME background the shell draws natively (canvas +
            // spotlight at the same viewport spot), then masks it out
            // towards the bottom — so content fades into the real
            // background instead of into a flat colour edge.
            background:
              "radial-gradient(circle at 96px 96px, hsl(var(--brand) / 0.10), transparent 230px), hsl(var(--bg))",
            WebkitMaskImage: "linear-gradient(to bottom, black 30%, transparent)",
            maskImage: "linear-gradient(to bottom, black 30%, transparent)",
          }}
        />
      )}
      {/* No TopHeader inside the native shell (2026-08-18 per operator) —
          the shell's native floating burger owns navigation and the drawer
          carries currency + account, so the header would only duplicate
          chrome on a small screen. Browsers are unchanged. */}
      {!inNativeShell && (
        <TopHeader
          onOpenAi={openAskCfoAi}
          onOpenSidebar={openDrawer}
          onOpenPalette={() => setSearchOpen(true)}
          // onOpenAccount removed 2026-08-04 (header redesign): the avatar
          // opens the AccountMenu dropdown again — it now hosts the
          // Learning-mode picker, Billing, Settings and sign-out. The
          // Command Center drawer stays reachable via its other triggers.
        />
      )}

      {/* Persistent sidebar (lg+). With no workspace yet, it stays visible but
          every destination that needs workspace data is disabled — only
          Workspaces, Settings, the website link, the collapse toggle and the
          disclaimer stay live (see `noWorkspace` prop in Sidebar). */}
      <Sidebar {...sidebarHandlers} noWorkspace={noWorkspaces} />

      {/* Mobile sidebar — slide-over drawer */}
      <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
        <SheetContent
          ref={drawerRef}
          side="left"
          // Swipe left to close (2026-09-09 per operator): the drawer follows
          // the finger once the gesture is clearly horizontal, then closes
          // past a third of its width or on a quick flick; otherwise it
          // springs back. `touch-pan-y` keeps vertical scrolling native and
          // hands horizontal movement to these handlers.
          onTouchStart={onDrawerSwipeStart}
          onTouchMove={onDrawerSwipeMove}
          onTouchEnd={onDrawerSwipeEnd}
          onTouchCancel={onDrawerSwipeEnd}
          // No auto-focus on open (2026-09-08): Radix would focus the first
          // control — now the drawer's close (X) button — and, opened from
          // the native burger (no pointer event on the page), it rendered
          // with a keyboard focus ring. Esc / the X / the backdrop still close.
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="
            w-[min(280px,calc(100vw-3rem))] p-0
            bg-bg
            border-r border-rule
            [&>button.absolute]:hidden
            flex flex-col overflow-hidden overscroll-contain touch-pan-y
          "
          style={{
            paddingTop: "env(safe-area-inset-top)",
            // No bottom inset HERE (2026-09-08 per operator, "push the
            // account row lower"): the sheet's pinned bottom block (account
            // row when signed in, theme/Sign in footer for guests) carries
            // the home-indicator inset itself, so it sits flush with the
            // bottom edge instead of floating a safe-area above it.
            paddingLeft: "env(safe-area-inset-left)",
          }}
        >
          <SheetTitle className="sr-only">{t("panels.navigation")}</SheetTitle>
          {/* Header-height spacer — only where the fixed TopHeader exists;
              in the native shell the drawer content starts at the top. */}
          {!inNativeShell && <div className="h-14 border-b border-rule" />}
          {/* Touch surface for pull-to-refresh (covers header, nav and
              footer; the nav inside is the scroller — see the
              data-drawer-scroller lookup in the handlers). */}
          <div
            ref={drawerScrollerRef}
            className="relative flex-1 min-h-0 flex flex-col"
            onTouchStart={onDrawerTouchStart}
            onTouchMove={onDrawerTouchMove}
            onTouchEnd={onDrawerTouchEnd}
            onTouchCancel={onDrawerTouchEnd}
          >
          <Sidebar
            {...sidebarHandlers}
            inDrawer
            // Pull-to-refresh indicator — the iOS activity indicator in the
            // theme's accent colour, nothing else (2026-09-09 per operator):
            // it spins as it comes into view with the pull, and fades out
            // once the refresh is done. Rendered at the top of the nav
            // SCROLLER, under the fixed header.
            navTop={
              (drawerPull > 0 || drawerRefreshing) && (
                <div
                  aria-hidden={!drawerRefreshing}
                  role={drawerRefreshing ? "status" : undefined}
                  data-testid="drawer-pull-refresh"
                  className="flex items-end justify-center overflow-hidden text-brand"
                  style={{
                    height: drawerRefreshing ? PULL_THRESHOLD : drawerPull,
                    opacity: drawerFading ? 0 : drawerRefreshing ? 1 : Math.min(1, drawerPull / PULL_THRESHOLD),
                    transition: drawerRefreshing ? "height 120ms ease-out, opacity 250ms ease" : undefined,
                  }}
                >
                  <IosSpinner size={24} className="mb-3" />
                </div>
              )
            }
            noWorkspace={noWorkspaces}
            onItemClick={() => setSidebarOpen(false)}
            // Drawer account row (2026-08-18) — no header inside the native
            // shell, so the drawer's credentials row opens the Command
            // Center account surface. In the shell (2026-09-08 per operator)
            // it rises as a BOTTOM SHEET over the still-open drawer; in a
            // browser the right panel replaces the drawer as before.
            onOpenAccount={() => {
              // iOS shell: a NATIVE sheet over the drawer (2026-09-08).
              if (openNativeSheet("account")) return;
              if (!inNativeShell) setSidebarOpen(false);
              setDrawerOpen(true);
            }}
          />
          </div>
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
        // Rail widths (THE INSTRUMENT): 232px expanded / 64px collapsed,
        // flush left — keep in sync with Sidebar's widthClass.
        className={`${inNativeShell ? "" : "pt-14"} ${sidebarCollapsed ? "lg:pl-[64px]" : "lg:pl-[232px]"} ${anySlideoutOpen ? "xl:pr-[360px]" : ""} transition-[padding] duration-200 ease-out`}
        // Notch devices: keep content clear of the home indicator. In the
        // native shell the page is edge-to-edge under the status bar, so the
        // content starts below it plus a little breathing room (2026-09-08
        // per operator: "more top padding on all pages").
        style={{
          // /chat paints to the very bottom edge (2026-09-10 per operator);
          // its composer keeps its own home-indicator inset.
          paddingBottom: chatPage ? 0 : "env(safe-area-inset-bottom)",
          ...(inNativeShell ? { paddingTop: "env(safe-area-inset-top)" } : {}),
        }}
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
          // Shell: content starts right under the status bar (2026-09-08 per
          // operator) — a 24px gap under the status-bar inset.
          // /chat (2026-09-10 redo): no padding and exactly the viewport
          // below the header — the chat is a fixed-height column whose
          // message list is the only scroller, so the document never
          // scrolls and nothing on it needs to be fixed. In the shell the
          // box also takes the status-bar strip (the thread scrolls under
          // the shell's top fade).
          className={
            chatPage
              ? "relative isolate w-full overflow-hidden"
              : `px-4 sm:px-8 lg:px-10 ${inNativeShell ? "pt-6 pb-6" : "py-6"} sm:py-10 lg:py-12 relative isolate max-w-[1760px]`
          }
          style={
            chatPage
              ? inNativeShell
                ? { height: "100dvh", marginTop: "calc(-1 * env(safe-area-inset-top))" }
                : { height: "calc(100dvh - 3.5rem)" }
              : { paddingBottom: "max(8rem, calc(env(safe-area-inset-bottom) + 6rem))" }
          }
        >
          {/* Shared atmospheric brand glow behind every page's content — the
              "dashboard background" applied app-wide so all tabs read with the
              exact same subtle backdrop. -z-10 keeps it behind content.
              Native shell (2026-09-08 per operator): FIXED to the viewport so
              the glow stays put while the page scrolls — it is part of the
              background, not the content. Browsers keep it in flow. */}
          {/* Not painted in the native shell (2026-09-08 per operator): the
              shell draws this same spotlight NATIVELY behind a transparent
              WebView, so it is the whole app's background and never moves
              with a scroll or a pull. */}
          {!inNativeShell && (
            <div
              aria-hidden
              data-testid="shell-brand-glow"
              className="pointer-events-none absolute -top-12 -left-12 h-72 w-72 rounded-full bg-brand/10 blur-3xl z-[-10]"
            />
          )}
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
        presentation={inNativeShell ? "bottom" : "side"}
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
      <CommandPalette
        open={searchOpen}
        onOpenChange={setSearchOpen}
        onOpenAi={openAskCfoAi}
      />
    </div>
  );
}

// buildPanelSnapshot (the slide-over's workspace serialisation) was
// removed with CFOChatPanel — /chat builds its own grounding context.
