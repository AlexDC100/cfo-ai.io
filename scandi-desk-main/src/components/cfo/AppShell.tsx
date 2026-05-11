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

import { ReactNode, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";
import { TopHeader } from "./TopHeader";
import { Sidebar } from "./Sidebar";
import { FloatingAiButton } from "./FloatingAiButton";
import { CommandDrawer } from "./CommandDrawer";
import { ChatCopilot } from "./ChatCopilot";
import { SearchDialog } from "./SearchDialog";
import { UploadDialog } from "./UploadDialog";
import { DocsPanel } from "./DocsPanel";
import { useDocsPanelOpen } from "@/lib/docsPanel";

interface Props {
  children: ReactNode;
  companyName?: string;
}

export function AppShell({ children }: Props) {
  const navigate = useNavigate();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // DocsPanel state — when open on wide screens, main content reflows
  // left to avoid being covered by the slide-out.
  const [docsOpen] = useDocsPanelOpen();

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

  // Sidebar footer — only Settings remains; Upload was removed in the
  // upload-consolidation pass. Upload entry points now live exclusively on
  // /dashboard (empty-state zone + Replace dropdown).
  const sidebarHandlers = {
    onSettings: () => navigate("/settings"),
  };

  return (
    <div className="min-h-screen bg-bg text-ink">
      <TopHeader
        onOpenAi={() => setChatOpen(true)}
        onOpenCommand={() => setDrawerOpen(true)}
        onOpenSidebar={() => setSidebarOpen(true)}
      />

      {/* Persistent sidebar (lg+) */}
      <Sidebar {...sidebarHandlers} />

      {/* Mobile sidebar — slide-over drawer */}
      <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
        <SheetContent
          side="left"
          className="
            w-[280px] p-0
            bg-bg
            border-r border-rule
            [&>button.absolute]:hidden
          "
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

      {/* Documents slide-out panel — right-anchored, available across
          every authenticated page. Closed by default; opens via the
          Docs pill in the dashboard header or Cmd/Ctrl+D shortcut. */}
      <DocsPanel />

      {/* Main content — offset for the fixed header + sidebar. When the
          docs panel is open on wide screens (≥1280px) the content shifts
          left by the panel's width so nothing is hidden. */}
      <main className={`pt-16 lg:pl-[240px] ${docsOpen ? "xl:pr-[360px]" : ""} transition-[padding] duration-200 ease-out`}>
        <div className="px-5 sm:px-8 lg:px-10 py-8 sm:py-10 lg:py-12 pb-32">
          {children}
        </div>
      </main>

      <FloatingAiButton onClick={() => setChatOpen(true)} />

      {/* Overlays */}
      <CommandDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        onOpenAi={() => setChatOpen(true)}
        onOpenSearch={() => setSearchOpen(true)}
        onOpenUpload={() => setUploadOpen(true)}
      />
      <ChatCopilot open={chatOpen} onOpenChange={setChatOpen} />
      <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
      <UploadDialog open={uploadOpen} onOpenChange={setUploadOpen} />
    </div>
  );
}
