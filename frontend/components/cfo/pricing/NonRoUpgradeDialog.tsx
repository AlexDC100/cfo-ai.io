// NonRoUpgradeDialog.tsx — friendly upgrade prompt for the typed
// non-RO refusal from the upload/scan path.
//
// 2026-08 tier restructure: documents whose jurisdiction resolves to
// anything other than RO are only analysable on the Multi-Country tier.
// The backend refuses them with `{ error: "non_ro_not_included",
// upgrade_to: "multi" }` (see lib/uploadRefusals.ts). This dialog is
// how the FE renders that refusal — an upgrade prompt with a direct
// path to /pricing, NOT a destructive error toast: the user did
// nothing wrong, the plan just doesn't include the capability.

import { Globe2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Optional server-supplied detail line, shown under the standard copy. */
  serverMessage?: string | null;
}

export function NonRoUpgradeDialog({ open, onClose, serverMessage }: Props) {
  const navigate = useNavigate();
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent data-testid="non-ro-upgrade-dialog" className="max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="text-[18px] font-serif text-ink flex items-center gap-2">
            <Globe2 size={16} strokeWidth={2} className="text-brand shrink-0" />
            {t("pricing.nonRoBlockedTitle")}
          </DialogTitle>
          <DialogDescription className="text-[13px] text-ink-soft leading-relaxed pt-1">
            {t("pricing.nonRoBlockedDesc")}
          </DialogDescription>
        </DialogHeader>

        {serverMessage && (
          <p
            data-testid="non-ro-server-message"
            className="text-[12px] text-ink-mute leading-relaxed"
          >
            {serverMessage}
          </p>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          <button
            type="button"
            onClick={onClose}
            data-testid="non-ro-dismiss"
            className="inline-flex items-center justify-center h-10 px-4 rounded-xl border border-rule text-[13px] font-medium text-ink-soft hover:text-ink hover:bg-bg-2/50 transition-colors"
          >
            {t("pricing.nonRoBlockedDismiss")}
          </button>
          <button
            type="button"
            onClick={() => { onClose(); navigate("/pricing"); }}
            data-testid="non-ro-upgrade-cta"
            className="inline-flex items-center justify-center h-10 px-4 rounded-xl bg-brand text-paper text-[13px] font-medium hover:bg-brand-d transition-colors"
          >
            {t("pricing.nonRoBlockedCta")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
