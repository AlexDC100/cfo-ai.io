// Bottom-right floating AI launcher — Vitalis-style.
//
// Shows on every page; clicks open the CFO AI chat drawer. Includes a
// keyboard-shortcut hint badge so power users discover ⌘K via the chrome
// (search palette also binds ⌘K, but the button doubles as an entry point).
//
// Cleo-style refresh: gradient background + spring hover lift + subtle
// breathing halo behind the icon to telegraph "AI is alive and ready".

import { Sparkles } from "lucide-react";
import { motion } from "framer-motion";
import { springSnappy } from "@/lib/motion";

interface Props {
  onClick: () => void;
}

export function FloatingAiButton({ onClick }: Props) {
  return (
    <motion.button
      onClick={onClick}
      whileHover={{ scale: 1.03, y: -1.5 }}
      whileTap={{ scale: 0.97 }}
      transition={springSnappy}
      className="
        fixed right-5 bottom-5 sm:right-6 sm:bottom-6 z-30
        inline-flex items-center gap-2
        h-11 pl-3.5 pr-2 rounded-full
        bg-gradient-to-r from-brand to-brand-d
        text-paper text-[13px] font-medium
        shadow-[0_12px_28px_-12px_rgba(45,191,179,0.6)]
        ring-1 ring-inset ring-white/15
        hover:shadow-[0_16px_32px_-12px_rgba(45,191,179,0.75)]
        transition-shadow
        group
      "
      aria-label="Open CFO AI"
      data-testid="floating-ask-cfo-ai"
    >
      {/* Quiet halo behind the icon — gentle, not gimmicky. */}
      <span aria-hidden className="relative inline-flex h-5 w-5 items-center justify-center">
        <span className="absolute inset-0 rounded-full bg-white/25 blur-[3px] animate-breathe opacity-70" />
        <Sparkles size={14} strokeWidth={2.25} className="relative" />
      </span>
      Ask CFO AI
      <span className="hidden sm:inline-flex items-center justify-center h-5 px-1.5 rounded-md bg-black/15 text-paper/90 text-[10px] font-semibold tracking-[0.04em] border border-white/15">
        ⌘K
      </span>
    </motion.button>
  );
}
