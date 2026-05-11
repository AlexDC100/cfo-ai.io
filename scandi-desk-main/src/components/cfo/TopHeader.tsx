// Fixed top header — Vitalis-style enterprise navbar.
//
//   ┌────────────────────────────────────────────────────────────────────┐
//   │ ☰  CFO AI │ Demo workspace      Ask CFO AI · 🔔 · ⋮ · ⓤ Profile   │
//   └────────────────────────────────────────────────────────────────────┘
//
// 64px tall, semi-transparent white with thin warm border. Hamburger only
// appears on small viewports (sidebar collapses there). The workspace label
// shows the user's company name when signed in, or "Demo workspace" when in
// demo mode — replaces the static "Financial Intelligence" brand line.

import { useNavigate } from "react-router-dom";
import { Bell, CreditCard, LogOut, MoreHorizontal, Settings as SettingsIcon, Sparkles, Menu, User as UserIcon } from "lucide-react";
import { Logo } from "./Logo";
import { useAuth } from "@/lib/auth";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";

interface Props {
  onOpenAi: () => void;
  onOpenCommand: () => void;
  /** Mobile-only: opens the sidebar as a slide-over drawer. */
  onOpenSidebar: () => void;
}

export function TopHeader({ onOpenAi, onOpenCommand, onOpenSidebar }: Props) {
  const { status, displayName, initials, user, workspaceLabel, signOut } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();

  return (
    <header
      className="
        fixed top-0 inset-x-0 z-40 h-16
        bg-[hsl(var(--surface)/0.86)]
        backdrop-blur-md
        border-b border-rule
      "
    >
      <div className="h-full px-4 sm:px-6 flex items-center gap-3">
        {/* Mobile hamburger */}
        <button
          onClick={onOpenSidebar}
          aria-label="Open navigation"
          className="lg:hidden inline-flex items-center justify-center h-9 w-9 rounded-md text-ink-soft hover:text-ink hover:bg-bg-2 transition-colors"
        >
          <Menu size={17} strokeWidth={1.75} />
        </button>

        {/* Brand + workspace label */}
        <button
          onClick={() => navigate("/dashboard")}
          className="flex items-center gap-3 shrink-0"
          aria-label="Go to dashboard"
        >
          <Logo size={26} compact />
        </button>
        <div className="hidden sm:flex items-center gap-2.5 pl-3 border-l border-rule h-7">
          <span className="text-[11px] uppercase tracking-[0.14em] text-ink-mute font-medium truncate max-w-[180px]">
            {workspaceLabel ?? "Financial Intelligence"}
          </span>
        </div>

        <div className="flex-1" />

        {/* Right actions */}
        <button
          onClick={onOpenAi}
          className="
            inline-flex items-center gap-1.5
            h-9 px-3 rounded-full
            text-[13px] font-medium text-brand-d
            hover:bg-brand-tint
            transition-colors
          "
        >
          <Sparkles size={14} strokeWidth={2} />
          Ask CFO AI
        </button>

        <button
          aria-label="Notifications"
          className="
            inline-flex items-center justify-center h-9 w-9 rounded-md
            text-ink-soft hover:text-ink hover:bg-bg-2 transition-colors
          "
        >
          <Bell size={15} strokeWidth={1.75} />
        </button>

        <button
          onClick={onOpenCommand}
          aria-label="Open command center"
          className="
            inline-flex items-center justify-center h-9 w-9 rounded-md
            text-ink-soft hover:text-ink hover:bg-bg-2 transition-colors
          "
        >
          <MoreHorizontal size={16} strokeWidth={1.75} />
        </button>

        {/* Auth — profile menu when signed in or in demo mode, else Sign in link */}
        {status === "signed_in" && user ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                aria-label="Account menu"
                className="ml-1 inline-flex items-center justify-center h-9 px-2.5 rounded-full bg-brand-tint text-brand-d hover:bg-brand-tint/80 transition-colors gap-1.5 text-[12px] font-medium"
              >
                <span className="inline-flex items-center justify-center h-6 w-6 rounded-full bg-brand text-paper text-[10.5px] font-semibold tracking-tight">
                  {initials ?? <UserIcon size={12} strokeWidth={1.75} />}
                </span>
                <span className="hidden sm:inline max-w-[120px] truncate">
                  {displayName ?? user.email}
                </span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="bg-surface border-rule-strong w-56">
              <DropdownMenuLabel className="text-[11px] uppercase tracking-[0.08em] text-ink-mute font-medium">
                Signed in as
              </DropdownMenuLabel>
              <div className="px-2 pb-1.5 text-[12px] text-ink truncate">{user.email}</div>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-[13px] cursor-pointer"
                onClick={() => navigate("/settings")}
              >
                <SettingsIcon size={14} strokeWidth={1.75} className="mr-2" />
                Settings
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-[13px] cursor-pointer"
                onClick={() => navigate("/pricing")}
              >
                <CreditCard size={14} strokeWidth={1.75} className="mr-2" />
                Plan & billing
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-[13px] cursor-pointer"
                onClick={async () => {
                  const { error } = await signOut();
                  toast({
                    title: error ? "Couldn't sign out" : "Signed out",
                    description: error?.message,
                    variant: error ? "destructive" : undefined,
                  });
                  if (!error) navigate("/", { replace: true });
                }}
              >
                <LogOut size={14} strokeWidth={1.75} className="mr-2" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <button
            onClick={() => navigate("/login")}
            className="ml-1 inline-flex items-center h-9 px-3 rounded-md text-[13px] font-medium text-ink-soft hover:text-ink hover:bg-bg-2 transition-colors"
          >
            Sign in
          </button>
        )}
      </div>
    </header>
  );
}
