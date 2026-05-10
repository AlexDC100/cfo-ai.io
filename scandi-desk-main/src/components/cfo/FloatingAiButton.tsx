// Bottom-right floating AI launcher — Vitalis-style.
//
// Shows on every page; clicks open the CFO AI chat drawer. Includes a
// keyboard-shortcut hint badge so power users discover ⌘K via the chrome
// (search palette also binds ⌘K, but the button doubles as an entry point).

import { Sparkles } from "lucide-react";

interface Props {
  onClick: () => void;
}

export function FloatingAiButton({ onClick }: Props) {
  return (
    <button
      onClick={onClick}
      className="
        fixed right-5 bottom-5 sm:right-6 sm:bottom-6 z-30
        inline-flex items-center gap-2
        h-11 pl-3.5 pr-2 rounded-full
        bg-brand text-white text-[13px] font-medium
        shadow-[0_10px_28px_-12px_hsl(var(--brand)/0.6),0_2px_6px_hsl(var(--brand)/0.25)]
        hover:bg-brand-d
        ring-1 ring-brand-d/30
        transition-colors
      "
      aria-label="Open CFO AI"
    >
      <Sparkles size={14} strokeWidth={2} />
      Ask CFO AI
      <span className="hidden sm:inline-flex items-center px-1.5 py-0.5 rounded-md bg-white/15 text-white/90 text-[10px] tracking-wider font-mono">
        ⌘K
      </span>
    </button>
  );
}
