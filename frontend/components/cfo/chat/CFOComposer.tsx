// Sticky chat composer — flat hairline panel (THE INSTRUMENT), single
// source of truth for input across both the /chat page and the
// slide-over panel.
//
// Features:
//   · multi-line textarea, two lines at rest, grows up to a sane cap
//   · Send on Enter or ⌘↵ / newline on Shift+Enter
//   · attach button (UI only — populates the local attachments list,
//     backend wiring is out of scope; chips render via CFOFilePreview)
//   · quiet ⌘↵ send hint beside the send button
//   · while a turn is generating: typing stays enabled, SENDING is
//     blocked, and the send button becomes a Stop button (Claude-style
//     square) that interrupts the reply via `onStop`
//   · A2 degraded state: everything stays visible but is disabled with
//     a tooltip until Retry succeeds (see lib/aiDegraded.ts)
//
// The composer exposes a `focus()` method via forwardRef so the
// "Ask CFO AI" entry point (when already on /chat) can focus the
// existing composer instead of routing somewhere new.

import { AnimatePresence } from "framer-motion";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Paperclip, ArrowUp, Square } from "lucide-react";
import { CFOFilePreview } from "./CFOFilePreview";
import { readDraft, writeDraft } from "./chatDrafts";
import "./chatDegradedI18n";
import type { ChatAttachment } from "./types";

export interface CFOComposerHandle {
  focus: () => void;
  /** Replace the current composer content (used by prompt-card clicks). */
  setText: (text: string) => void;
}

interface Props {
  /** A reply is generating for the open conversation. Typing stays
   *  enabled; sending is blocked and the send button becomes Stop. */
  pending: boolean;
  /** Fired when the user submits (Enter or Send click). */
  onSubmit: (text: string, attachments: ChatAttachment[]) => void;
  /** Fired by the Stop button while `pending` — interrupts the reply. */
  onStop?: () => void;
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
  /** A2 degraded state — when set, input/attach/send are disabled with
   *  this tooltip (no banner: the failed turn's panel in the thread is
   *  the surface, and its Retry button is the way back). Auto-clears on
   *  the next successful turn. */
  degradedReason?: string | null;
  /** Per-conversation draft persistence (2026-07-25). When set, the
   *  composer initializes from the saved draft for this key and saves
   *  every keystroke back, so switching conversations (the shell keys
   *  the composer by conversation id) restores each chat's unsent text.
   *  Sending or clearing the text removes the draft. */
  draftKey?: string | null;
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
    onStop,
    placeholder,
    contextLine,
    disclosure,
    compact = false,
    blockedReason = null,
    degradedReason = null,
    draftKey = null,
  },
  ref,
) {
  const { t } = useTranslation();
  const resolvedPlaceholder = placeholder ?? t("chatX.askAnythingPlaceholder");
  // Hard-disable when a chat cap has been hit OR while the assistant is
  // degraded (A2): input, attach, and send are all locked. `pending` is
  // softer — the user can keep typing their next question while the answer
  // generates; only SENDING is blocked (and the send button becomes Stop).
  // While degraded there is no banner — the failed turn's panel carries
  // Retry; the tooltip on the locked controls points there.
  const hardDisabled = !!blockedReason || !!degradedReason;
  const lockTooltip = degradedReason ?? undefined;
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // Restore this conversation's unsent draft on mount. The shell keys the
  // composer by conversation id, so switching chats remounts with the
  // right draft — no cross-conversation state to reconcile here.
  const [text, setText] = useState(() => (draftKey ? readDraft(draftKey) : ""));
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);

  // Persist the draft on every change. Writing "" removes the entry, so
  // sent/cleared messages don't linger as phantom drafts.
  useEffect(() => {
    if (draftKey) writeDraft(draftKey, text);
  }, [draftKey, text]);

  // Expose imperative handle so external callers (e.g. AppShell's
  // openAskCfoAi when already on /chat) can focus the live composer
  // without remounting it.
  useImperativeHandle(ref, () => ({
    // preventScroll — programmatic focus fires on TAB ENTRY (openAskCfoAi
    // navigates here then focuses); the composer is sticky-bottom and
    // already on screen, so letting the browser scroll it into view just
    // makes the page visibly move the moment the tab opens.
    focus: () => taRef.current?.focus({ preventScroll: true }),
    setText: (t: string) => {
      setText(t);
      // Defer focus until React commits the value so the cursor lands
      // at the end of the inserted text instead of position 0.
      window.setTimeout(() => {
        taRef.current?.focus({ preventScroll: true });
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
    // Page composer rests at TWO lines (the input reads as a place to
    // write, not a search field); the compact slide-over keeps the tighter
    // 40px floor that matches its 36px buttons.
    ta.style.height = `${Math.max(compact ? 40 : 62, next)}px`;
  }, [text, compact]);

  function submit() {
    const trimmed = text.trim();
    // No sending while a reply is generating — Enter is a no-op and the
    // send button is replaced by Stop for the duration.
    if (!trimmed || pending || hardDisabled) return;
    onSubmit(trimmed, attachments);
    setText("");
    // Clear the draft synchronously too — the first message of a new
    // session changes the conversation id (remounting this composer),
    // which can unmount us before the persist effect sees text = "".
    if (draftKey) writeDraft(draftKey, "");
    setAttachments([]);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends (existing behavior, unchanged); ⌘↵ / Ctrl+↵ also send,
    // matching the hint beside the send button. Shift+Enter = newline.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  // ONE attachment at a time (2026-07-26 per operator — single-file uploads
  // app-wide). A new pick REPLACES the current attachment rather than adding
  // to it; the attachments array shape is unchanged so the preview chips and
  // remove button keep working.
  function onFiles(files: FileList | null) {
    const f = files?.[0];
    if (!f) return;
    setAttachments([
      {
        id: `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        name: f.name,
        size: f.size,
        type: f.type || "application/octet-stream",
        // UI-only state for now; a future backend hookup will move this
        // through uploading → reading → extracting → ready.
        status: "queued",
      },
    ]);
    if (fileRef.current) fileRef.current.value = "";
  }

  function removeAttachment(id: string) {
    setAttachments((cur) => cur.filter((a) => a.id !== id));
  }

  return (
    <div className={`w-full ${compact ? "px-3 pb-3" : "pb-2"}`}>
      {/* The full /chat page provides its own horizontal padding + max-width on
          the wrapper around this composer, so here we DON'T re-pad (that would
          push the input box right of the context pill + messages). The compact
          panel keeps its own padding + full width. */}
      <div className="w-full">
      {contextLine && (
        <div className="mb-2 text-[11.5px] text-ink-soft text-left selection:bg-transparent">
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
            mb-2 rounded-md border border-rule bg-caution-tint px-3 py-2
            text-[12px] text-ink flex items-start gap-2
          "
        >
          <span className="font-medium text-caution">{blockedReason.headline}.</span>
          <span className="flex-1 text-ink-soft">{blockedReason.body}</span>
          {blockedReason.href && (
            <a
              href={blockedReason.href}
              className="font-medium text-brand-dark dark:text-brand-light underline underline-offset-2 hover:opacity-80 shrink-0"
            >
              {t("chatX.seePlans")}
            </a>
          )}
        </div>
      )}

      {/* Single-line arrangement (2026-08-18 per operator): attach · input ·
          send on ONE row, buttons bottom-aligned so the textarea can still
          grow into multiple lines above them. The old layout stacked the
          textarea over a second toolbar row (attach + shortcut hint + send);
          the hint went away with the row. */}
      <div
        title={lockTooltip}
        data-degraded={degradedReason ? "true" : undefined}
        className={`
        relative rounded-md border border-rule bg-surface
        transition-colors duration-micro focus-within:border-rule-strong
        ${compact ? "px-2 py-1.5" : "px-2.5 py-2"}
        ${hardDisabled ? "opacity-70" : ""}
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

        <div className="flex items-end gap-1.5">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={hardDisabled}
            data-testid="chat-attach"
            aria-label={t("chatX.attachAria")}
            title={lockTooltip}
            className="
              inline-flex items-center justify-center h-9 w-9 shrink-0 mb-0.5 rounded-sm
              text-ink-soft hover:text-ink hover:bg-bg-2/70
              disabled:opacity-50 transition-colors duration-micro
            "
          >
            <Paperclip size={15} strokeWidth={1.75} />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT}
            onChange={(e) => onFiles(e.target.files)}
            className="hidden"
            data-testid="chat-file-input"
          />

          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={(e) => {
              // iOS Safari: when the virtual keyboard opens, the composer can
              // be pushed off-screen. Wait a tick for the keyboard animation
              // to settle, then scroll the textarea into view. TOUCH DEVICES
              // ONLY — on desktop there is no keyboard, and this smooth
              // scroll fired on the programmatic focus that happens when the
              // Ask CFO AI button opens the tab, visibly gliding the page on
              // entry (2026-07-25 probe).
              if (!window.matchMedia("(pointer: coarse)").matches) return;
              const el = e.currentTarget;
              window.setTimeout(() => {
                try { el.scrollIntoView({ block: "center", behavior: "smooth" }); }
                catch { /* older browsers — ignore */ }
              }, 250);
            }}
            placeholder={blockedReason ? t("chatX.pausedPlaceholder") : resolvedPlaceholder}
            rows={1}
            disabled={hardDisabled}
            data-testid="chat-input"
            aria-label={t("topbar.askCfoAi")}
            title={lockTooltip}
            className={`
              flex-1 min-w-0 resize-none bg-transparent py-2
              text-[16px] sm:text-[14.5px] leading-[1.55] text-ink
              placeholder:text-ink-soft focus:outline-none focus-visible:shadow-none
              disabled:opacity-60
              ${compact ? "min-h-[40px]" : "min-h-[62px]"} max-h-[170px]
            `}
          />

          {/* Quiet ⌘↵ hint — desktop page composer only (compact panel and
              touch layouts don't have the room; Enter still sends there). */}
          {!compact && (
            <span
              aria-hidden
              className="hidden sm:inline-flex items-baseline gap-1 shrink-0 self-end mb-2 mr-0.5 text-[10.5px] font-mono text-ink-soft select-none"
            >
              ⌘↵ <span className="text-ink-soft">{t("chatDegraded.sendHint")}</span>
            </span>
          )}
          {pending ? (
            <button
              type="button"
              onClick={onStop}
              data-testid="chat-stop"
              aria-label={t("chatX.stopGenerating")}
              title={t("chatX.stopGenerating")}
              className="
                inline-flex items-center justify-center h-9 w-9 shrink-0 mb-0.5 rounded-sm
                bg-brand text-paper transition-colors duration-micro
              "
            >
              <Square size={10} strokeWidth={0} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!text.trim() || hardDisabled}
              data-testid="chat-send"
              aria-label={t("chatX.sendMessage")}
              title={lockTooltip}
              className="
                inline-flex items-center justify-center h-9 w-9 shrink-0 mb-0.5 rounded-sm
                bg-brand text-paper hover:bg-brand/90 transition-colors duration-micro
                disabled:bg-bg-2 disabled:text-ink-soft disabled:cursor-not-allowed
              "
            >
              <ArrowUp size={14} strokeWidth={2.25} />
            </button>
          )}
        </div>
      </div>

      {disclosure && (
        <div className="mt-2 text-[11px] text-ink-soft text-center leading-snug">
          {disclosure}
        </div>
      )}
      </div>
    </div>
  );
});
