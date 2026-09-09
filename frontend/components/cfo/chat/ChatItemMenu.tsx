// ChatItemMenu — the floating menu for one conversation (2026-09-10 per
// operator, modelled on the Claude app's held chat row): Rename and Delete.
//
// Two ways in, one menu:
//   · `anchor.kind === "row"` — a chat row held in the burger drawer. The
//     row is lifted out of the list (a copy drawn at its exact spot) and the
//     menu hangs under it; the rest of the drawer dims.
//   · `anchor.kind === "corner"` — the chat page's top-right "…" disc. The
//     menu drops from that corner with the chat's title as its header.
//
// Rename edits in place (the lifted row / the header becomes an input);
// Delete confirms through DeleteChatDialog (native alert in the shell).
//
// INSIDE THE SHELL none of that is drawn (2026-09-10 per operator: "use the
// native iOS feature"): the menu is a native action sheet — Rename / Delete
// chat / Cancel — Rename continues in a native text prompt, Delete in the
// native confirm. The page's own "…" disc is native too (a SwiftUI Menu in
// the shell), so this component only ever sees the DRAWER's held row there.
// Rendered INSIDE its host (absolute, filling it) rather than portalled:
// the drawer is a modal sheet whose focus trap and outside-tap dismissal
// would fight a portal.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MessageSquareText, Pencil, Trash2 } from "lucide-react";
import { isNativeShell, showNativeDialog, showNativePrompt } from "@/lib/nativeShell";
import { DeleteChatDialog } from "./DeleteChatDialog";
import type { ChatConversation } from "./types";

export type ChatItemMenuAnchor =
  | { kind: "row"; rect: DOMRect }
  | { kind: "corner"; top: string | number; right: string | number };

interface Props {
  conversation: ChatConversation | null;
  anchor: ChatItemMenuAnchor | null;
  onClose: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}

const MENU_W = 200;
const MENU_H = 92;
const GAP = 8;

export function ChatItemMenu({ conversation, anchor, onClose, onRename, onDelete }: Props) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [confirm, setConfirm] = useState(false);
  // The held row's box, in the host's coordinates (the host is positioned).
  const [row, setRow] = useState<{ top: number; left: number; width: number; height: number; below: boolean } | null>(null);
  const open = !!conversation && !!anchor;
  const native = isNativeShell();

  // Shell: native action sheet → native prompt / native confirm.
  const latest = useRef({ onClose, onRename });
  latest.current = { onClose, onRename };
  useEffect(() => {
    if (!native || !open || !conversation) return undefined;
    let cancelled = false;
    void (async () => {
      const index = await showNativeDialog("actionSheet", {
        title: conversation.title,
        options: [t("chatX.rename"), t("chatX.deleteChat"), t("common.cancel")],
        destructiveIndex: 1,
        cancelIndex: 2,
      });
      if (cancelled) return;
      if (index === 1) { setConfirm(true); return; }
      if (index === 0) {
        const text = await showNativePrompt({ title: t("chatX.rename"), defaultValue: conversation.title, options: [t("common.cancel"), t("common.save")] });
        if (cancelled) return;
        const title = (text ?? "").trim();
        if (title && title !== conversation.title) latest.current.onRename(conversation.id, title);
      }
      latest.current.onClose();
    })();
    return () => { cancelled = true; };
  }, [native, open, conversation, t]);

  useLayoutEffect(() => {
    if (!open || anchor?.kind !== "row" || !rootRef.current) { setRow(null); return; }
    const host = rootRef.current.getBoundingClientRect();
    const r = anchor.rect;
    const top = r.top - host.top;
    setRow({ top, left: r.left - host.left, width: r.width, height: r.height, below: top + r.height + GAP + MENU_H <= host.height - 8 });
  }, [open, anchor]);

  useEffect(() => {
    if (!open) { setRenaming(false); setConfirm(false); }
  }, [open]);
  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open || !conversation || !anchor) return null;

  if (native) {
    return (
      <DeleteChatDialog
        open={confirm}
        onOpenChange={(o) => { setConfirm(o); if (!o) onClose(); }}
        onConfirm={() => {
          setConfirm(false);
          onDelete(conversation.id);
          onClose();
        }}
      />
    );
  }

  const startRename = () => { setDraft(conversation.title); setRenaming(true); };
  const commitRename = () => {
    const title = draft.trim();
    if (title && title !== conversation.title) onRename(conversation.id, title);
    onClose();
  };
  const renameInput = (
    <input
      ref={inputRef}
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); commitRename(); }
        if (e.key === "Escape") { e.preventDefault(); onClose(); }
      }}
      onBlur={commitRename}
      enterKeyHint="done"
      aria-label={t("chatX.rename")}
      data-testid="chat-item-rename-input"
      className="min-w-0 flex-1 bg-transparent outline-none text-ink"
    />
  );
  const menu = (
    <div
      role="menu"
      data-testid="chat-item-menu"
      className="chat-item-menu-in overflow-hidden rounded-xl border border-rule bg-surface/95 backdrop-blur-xl"
      style={{ width: MENU_W }}
    >
      {anchor.kind === "corner" && (
        <div className="flex items-center gap-2 border-b border-rule px-3.5 py-2.5 text-[12.5px] text-ink-soft">
          {renaming ? renameInput : <span className="truncate">{conversation.title}</span>}
        </div>
      )}
      {!renaming && (
        <>
          <button
            type="button"
            role="menuitem"
            onClick={startRename}
            data-testid="chat-item-rename"
            className="flex w-full items-center gap-3 px-3.5 py-3 text-left text-[14px] text-ink active:bg-bg-2 transition-colors duration-micro"
          >
            <Pencil size={15} strokeWidth={1.75} className="shrink-0 text-ink-soft" />
            {t("chatX.rename")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => setConfirm(true)}
            data-testid="chat-item-delete"
            className="flex w-full items-center gap-3 border-t border-rule px-3.5 py-3 text-left text-[14px] text-red-600 active:bg-bg-2 transition-colors duration-micro"
          >
            <Trash2 size={15} strokeWidth={1.75} className="shrink-0" />
            {t("chatX.deleteChat")}
          </button>
        </>
      )}
    </div>
  );

  return (
    <div
      ref={rootRef}
      className="absolute inset-0 z-[60]"
      data-testid="chat-item-menu-root"
    >
      {/* Dim + blur everything but the held row and the menu. */}
      <button
        type="button"
        aria-label={t("common.cancel")}
        onClick={onClose}
        data-testid="chat-item-menu-backdrop"
        className="absolute inset-0 bg-bg/55 backdrop-blur-[2px] cursor-default"
      />
      {anchor.kind === "row" && row && (
        <>
          <div
            data-testid="chat-item-lifted"
            className="chat-item-menu-in absolute flex items-center gap-2 rounded-lg border border-rule bg-surface px-3 text-[12.5px] text-ink"
            style={{ top: row.top, left: row.left, width: row.width, height: row.height }}
          >
            <MessageSquareText size={13} strokeWidth={1.75} className="shrink-0 text-ink-mute" />
            {renaming ? renameInput : <span className="truncate">{conversation.title}</span>}
          </div>
          <div
            className="absolute"
            style={row.below
              ? { top: row.top + row.height + GAP, left: row.left }
              : { bottom: `calc(100% - ${row.top - GAP}px)`, left: row.left }}
          >
            {menu}
          </div>
        </>
      )}
      {anchor.kind === "corner" && (
        <div className="absolute" style={{ top: anchor.top, right: anchor.right }}>
          {menu}
        </div>
      )}
      <DeleteChatDialog
        open={confirm}
        onOpenChange={setConfirm}
        onConfirm={() => {
          setConfirm(false);
          onDelete(conversation.id);
          onClose();
        }}
      />
    </div>
  );
}
