// DeleteChatDialog — the one confirm step before a conversation is deleted
// (2026-09-10 per operator): states that the chat is removed for good and
// cannot be undone. Used by the chat page's top-right delete disc and by the
// drawer's long-press action sheet.

import { useTranslation } from "react-i18next";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function DeleteChatDialog({ open, onOpenChange, onConfirm }: Props) {
  const { t } = useTranslation();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      {/* Same treatment as the sign-out confirm (AccountTab): no panel of
          its own — the backdrop blurs the page beneath and the question
          floats on it. */}
      <AlertDialogContent
        data-testid="chat-delete-confirm"
        overlayClassName="bg-bg/70 backdrop-blur-2xl"
        className="bg-transparent border-0 shadow-none"
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{t("chatX.deleteChatTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("chatX.deleteChatBody")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="chat-delete-cancel">{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            data-testid="chat-delete-confirm-yes"
            className="bg-red-600 text-white hover:bg-red-600/90"
            onClick={onConfirm}
          >
            {t("chatX.deleteChatConfirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
