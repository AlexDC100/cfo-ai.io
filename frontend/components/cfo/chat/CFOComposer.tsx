// Sticky chat composer — premium, glass-style, single source of truth
// for input across both the /chat page and the slide-over panel.
//
// Features:
//   · multi-line textarea that grows up to a sane cap
//   · Send on Enter / newline on Shift+Enter
//   · attach button (UI only — populates the local attachments list,
//     backend wiring is out of scope; chips render via CFOFilePreview)
//   · focus glow + keyboard-shortcut hint
//   · disabled while a turn is pending
//
// The composer exposes a `focus()` method via forwardRef so the
// "Ask CFO AI" entry point (when already on /chat) can focus the
// existing composer instead of routing somewhere new.

import { AnimatePresence } from "framer-motion";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Paperclip, ArrowUp, CornerDownLeft } from "lucide-react";
import { CFOFilePreview } from "./CFOFilePreview";
import type { ChatAttachment } from "./types";

export interface CFOComposerHandle {
  focus: () => void;
  /** Replace the current composer content (used by prompt-card clicks). */
  setText: (text: string) => void;
}

interface Props {
  /** Disable input + send while a turn is in flight. */
  pending: boolean;
  /** Fired when the user submits (Enter or Send click). */
  onSubmit: (text: string, attachments: ChatAttachment[]) => void;
  /** Placeholder copy — page sets this based on whether a period is loaded. */
  placeholder?: string;
  /** Optional context line rendered above the textarea (e.g. "Grounded in …"). */
  contextLine?: React.ReactNode;
  /** Persistent general-answer disclosure rendered below the composer. */
  disclosure?: React.ReactNode;
  /** Tighter padding when used inside the slide-over panel. */
  compact?: boolean;
  /** Pricing V3 (refined spec §14) — when set, the input is hard-disabled
   *  and a small banner is rendered above the textarea. Used when the
   *  Ask CFO AI daily or monthly cap has been reached. Spec literal:
   *  "disable + message if blocked, no generic error". */
  blockedReason?: { headline: string; body: string; href?: string } | null;
}

const ACCEPT = [
  ".pdf", ".xlsx", ".xls", ".csv", ".doc", ".docx", ".txt",
  ".png", ".jpg", ".jpeg", ".webp",
  "application/pdf",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/*",
].join(",");

export const CFOComposer = forwardRef<CFOComposerHandle, Props>(function CFOComposer(
  {
    pending,
    onSubmit,
    placeholder = "Ask CFO AI anything…",
    contextLine,
    disclosure,
    compact = false,
    blockedReason = null,
  },
  ref,
) {
  // Hard-disable when a chat cap has been hit. The composer treats this as
  // a stronger version of `pending`: input, attach, and send are all locked.
  const hardDisabled = pending || !!blockedReason;
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);

  // Expose imperative handle so external callers (e.g. AppShell's
  // openAskCfoAi when already on /chat) can focus the live composer
  // without remounting it.
  useImperativeHandle(ref, () => ({
    focus: () => taRef.current?.focus(),
    setText: (t: string) => {
      setText(t);
      // Defer focus until React commits the value so the cursor lands
      // at the end of the inserted text instead of position 0.
      window.setTimeout(() => {
        taRef.current?.focus();
        if (taRef.current) {
          taRef.current.selectionStart = taRef.current.selectionEnd = taRef.current.value.length;
        }
      }, 0);
    },
  }));

  // Auto-grow the textarea up to ~7 lines, then scroll inside it.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const next = Math.min(ta.scrollHeight, 7 * 22);  // ~7 lines @ 22px line-height
    ta.style.height = `${Math.max(48, next)}px`;
  }, [text]);

  function submit() {
    const trimmed = text.trim();
    if (!trimmed || hardDisabled) return;
    onSubmit(trimmed, attachments);
    setText("");
    setAttachments([]);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function onFiles(files: FileList | null) {
    if (!files) return;
    const next: ChatAttachment[] = [];
    for (const f of Array.from(files)) {
      next.push({
        id: `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        name: f.name,
        size: f.size,
        type: f.type || "application/octet-stream",
        // UI-only state for now; a future backend hookup will move this
        // through uploading → reading → extracting → ready.
        status: "queued",
      });
    }
    setAttachments((cur) => [...cur, ...next]);
    if (fileRef.current) fileRef.current.value = "";
  }

  function removeAttachment(id: string) {
    setAttachments((cur) => cur.filter((a) => a.id !== id));
  }

  return (
    <div className={`w-full ${compact ? "px-3 pb-3" : "px-4 sm:px-6 pb-5 sm:pb-6"}`}>
      {contextLine && (
        <div className="mb-2 text-[11.5px] text-ink-mute text-center">
          {contextLine}
        </div>
      )}

      {/* Chat-cap banner — rendered above the composer when blockedReason is
          set. Spec §14: "disable + message if blocked, no generic error".
          The 429 chat card still appears in the message thread; this banner
          stops the user from retyping into a locked composer. */}
      {blockedReason && (
        <div
          data-testid="chat-blocked-banner"
          className="
            mb-2 rounded-xl border border-amber-300/70 bg-amber-50 px-3 py-2
            text-[12px] text-amber-900 flex items-start gap-2
            dark:bg-amber-900/20 dark:text-amber-200 dark:border-amber-700/50
          "
        >
          <span className="font-medium">{blockedReason.headline}.</span>
          <span className="flex-1">{blockedReason.body}</span>
          {blockedReason.href && (
            <a
              href={blockedReason.href}
              className="font-medium underline underline-offset-2 hover:opacity-80 shrink-0"
            >
              See plans
            </a>
          )}
        </div>
      )}

      <div className={`
        relative rounded-2xl border border-rule
        bg-surface/85 dark:bg-bg-2/60 backdrop-blur-md
        shadow-[0_2px_10px_-4px_rgba(0,0,0,0.08)]
        focus-within:border-brand/40 focus-within:ring-2 focus-within:ring-brand/15
        transition-all
        ${compact ? "px-3 pt-2 pb-2" : "px-4 pt-3 pb-2.5"}
        ${blockedReason ? "opacity-70" : ""}
      `}>
        {/* Attachments row */}
        <AnimatePresence>
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pb-2 mb-1 border-b border-rule/60">
              {attachments.map((a) => (
                <CFOFilePreview
                  key={a.id}
                  attachment={a}
                  onRemove={() => removeAttachment(a.id)}
                />
              ))}
            </div>
          )}
        </AnimatePresence>

        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={(e) => {
            // iOS Safari: when virtual keyboard opens, the composer can be
            // pushed off-screen. Wait a tick for the keyboard animation to
            // settle, then scroll the textarea into view.
            const el = e.currentTarget;
            window.setTimeout(() => {
              try { el.scrollIntoView({ block: "center", behavior: "smooth" }); }
              catch { /* older browsers — ignore */ }
            }, 250);
          }}
          placeholder={blockedReason ? "Chat is paused — see banner above" : placeholder}
          rows={1}
          disabled={hardDisabled}
          data-testid="chat-input"
          aria-label="Ask CFO AI"
          className="
            w-full resize-none bg-transparent
            text-[16px] sm:text-[14.5px] leading-[1.55] text-ink
            placeholder:text-ink-mute focus:outline-none
            disabled:opacity-60
            min-h-[48px] max-h-[170px]
          "
        />

        <div className="mt-1.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={hardDisabled}
              data-testid="chat-attach"
              aria-label="Attach a document"
              className="
                inline-flex items-center justify-center h-8 w-8 rounded-lg
                text-ink-mute hover:text-ink hover:bg-bg-2/70
                disabled:opacity-50 transition-colors
              "
            >
              <Paperclip size={15} strokeWidth={1.75} />
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept={ACCEPT}
              onChange={(e) => onFiles(e.target.files)}
              className="hidden"
              data-testid="chat-file-input"
            />
            <span className="hidden sm:inline-flex items-center gap-1 text-[10.5px] text-ink-mute pl-1">
              <CornerDownLeft size={10} strokeWidth={2} />
              <span>Enter to send · Shift+Enter for newline</span>
            </span>
          </div>

          <button
            type="button"
            onClick={submit}
            disabled={!text.trim() || hardDisabled}
            data-testid="chat-send"
            aria-label="Send message"
            className="
              inline-flex items-center justify-center h-8 w-8 rounded-lg
              bg-ink text-paper
              hover:bg-ink-soft
              disabled:bg-bg-2 disabled:text-ink-mute disabled:cursor-not-allowed
              transition-colors
            "
          >
            <ArrowUp size={14} strokeWidth={2.25} />
          </button>
        </div>
      </div>

      {disclosure && (
        <div className="mt-2 text-[11px] text-ink-mute text-center leading-snug">
          {disclosure}
        </div>
      )}
    </div>
  );
});
