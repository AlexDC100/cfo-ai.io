// CFOChatPanel — slide-over wrapper around CFOChatShell (variant="panel").
//
// Opens from the right edge on non-/chat pages when the user clicks
// "Ask CFO AI" in the top header. Reuses the exact same conversation
// engine, history, message components, and composer as the full page
// — no second assistant.
//
// Layout: right-anchored, 440px wide on desktop, full-width on mobile.
// Backdrop dims the page but stays click-to-dismiss; Escape also closes.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { X } from "lucide-react";
import { CFOChatShell, type CFOChatShellHandle } from "./CFOChatShell";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Same workspace context fields that CFOChatShell needs. */
  workspaceSnapshot?: string | undefined;
  periodLabel?: string | null;
  periodId?: string | null;
  companyName?: string | null;
  /** Optional prefill — when set, the panel pushes it into the
   *  composer after the shell mounts. AppShell clears it via
   *  `onPrefillConsumed` so the same string isn't re-applied on
   *  re-open. */
  prefillPrompt?: string | null;
  onPrefillConsumed?: () => void;
}

export function CFOChatPanel({
  open, onClose, workspaceSnapshot, periodLabel, periodId, companyName,
  prefillPrompt, onPrefillConsumed,
}: Props) {
  const navigate = useNavigate();
  const shellRef = useRef<CFOChatShellHandle | null>(null);

  // Deliver the prefill once the shell has rendered. The shell's
  // setComposer() inserts the text into the live composer and focuses
  // it. Consume the prefill (clear it upstream) so re-opening the
  // panel later doesn't re-apply the same text.
  useEffect(() => {
    if (!open || !prefillPrompt) return;
    const t = window.setTimeout(() => {
      shellRef.current?.setComposer(prefillPrompt);
      onPrefillConsumed?.();
    }, 60); // wait one frame past the spring's first commit
    return () => window.clearTimeout(t);
  }, [open, prefillPrompt, onPrefillConsumed]);

  // Escape closes the panel.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Lock body scroll while open so the page doesn't scroll behind.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  function expandToPage() {
    onClose();
    // Preserve ?period= on the route.
    const params = new URLSearchParams(window.location.search);
    const period = params.get("period");
    navigate(period ? `/chat?period=${encodeURIComponent(period)}` : "/chat");
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            key="chat-panel-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={onClose}
            className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[2px]"
            aria-hidden
          />

          {/* Panel */}
          <motion.aside
            key="chat-panel"
            role="dialog"
            aria-modal="true"
            aria-label="Ask CFO AI"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", stiffness: 320, damping: 34 }}
            className="
              fixed top-0 right-0 z-50 h-full
              w-full sm:w-[440px] lg:w-[480px]
              bg-bg border-l border-rule
              flex flex-col
              shadow-2xl
            "
            style={{
              paddingTop: "env(safe-area-inset-top)",
              paddingBottom: "env(safe-area-inset-bottom)",
            }}
            data-testid="chat-slide-over"
          >
            <button
              type="button"
              onClick={onClose}
              aria-label="Close Ask CFO AI"
              className="absolute top-2 right-2 sm:top-2.5 sm:right-3 z-10 inline-flex h-11 w-11 sm:h-7 sm:w-7 items-center justify-center rounded-md text-ink-mute hover:text-ink hover:bg-bg-2/60 active:bg-bg-2/40 transition-colors"
              style={{ top: "calc(env(safe-area-inset-top) + 0.5rem)" }}
            >
              <X size={18} className="sm:hidden" strokeWidth={1.75} />
              <X size={14} className="hidden sm:block" strokeWidth={1.75} />
            </button>

            <CFOChatShell
              ref={shellRef}
              variant="panel"
              workspaceSnapshot={workspaceSnapshot}
              periodLabel={periodLabel}
              periodId={periodId}
              companyName={companyName}
              onExpandToPage={expandToPage}
              onPickConversationFromHistory={onClose}
            />
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
