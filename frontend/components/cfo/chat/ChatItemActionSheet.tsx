// ChatItemActionSheet — iOS-style action sheet for a held chat item in the
// burger drawer (2026-09-10 per operator): the conversation's title, one
// destructive "Delete chat" action, and Cancel. Delete asks once more
// through DeleteChatDialog before anything is removed.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { DeleteChatDialog } from "./DeleteChatDialog";
import type { ChatConversation } from "./types";

interface Props {
  /** The held conversation; null = closed. */
  conversation: ChatConversation | null;
  onClose: () => void;
  onDelete: (id: string) => void;
}

export function ChatItemActionSheet({ conversation, onClose, onDelete }: Props) {
  const { t } = useTranslation();
  const [confirm, setConfirm] = useState(false);
  const open = conversation !== null;
  return (
    <>
      <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
        <SheetContent
          side="bottom"
          data-testid="chat-item-action-sheet"
          // The sheet is only the two floating groups — no panel, no close X.
          className="border-0 bg-transparent p-2 shadow-none [&>button.absolute]:hidden"
          style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}
        >
          <SheetTitle className="sr-only">{conversation?.title ?? ""}</SheetTitle>
          <div className="mx-auto w-full max-w-md">
            <div className="overflow-hidden rounded-2xl border border-rule bg-surface/95 backdrop-blur-xl">
              <div className="px-4 py-3 text-center text-[12.5px] text-ink-soft truncate">{conversation?.title}</div>
              <button
                type="button"
                onClick={() => setConfirm(true)}
                data-testid="chat-item-delete"
                className="w-full border-t border-rule py-3.5 text-center text-[17px] text-red-600 active:bg-bg-2 transition-colors duration-micro"
              >
                {t("chatX.deleteChat")}
              </button>
            </div>
            <button
              type="button"
              onClick={onClose}
              data-testid="chat-item-cancel"
              className="mt-2 w-full rounded-2xl border border-rule bg-surface/95 backdrop-blur-xl py-3.5 text-center text-[17px] font-semibold text-ink active:bg-bg-2 transition-colors duration-micro"
            >
              {t("common.cancel")}
            </button>
          </div>
        </SheetContent>
      </Sheet>
      <DeleteChatDialog
        open={confirm}
        onOpenChange={setConfirm}
        onConfirm={() => {
          setConfirm(false);
          if (conversation) onDelete(conversation.id);
          onClose();
        }}
      />
    </>
  );
}
