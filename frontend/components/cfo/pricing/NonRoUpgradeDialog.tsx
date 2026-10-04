// NonRoUpgradeDialog.tsx — what the user is told when a document resolves
// to a country other than Romania.
//
// IT IS NOT AN UPGRADE PROMPT ANY MORE (2026-10-01). Until then this dialog
// read "This document needs Multi-Country" over a button to /pricing. No
// file from another country is analysed correctly today, on any plan
// (frontend/data/coverage.json, row `other_countries`), so selling a plan
// here sold something the product cannot do. The dialog now says that
// other countries are not supported yet and offers the coverage table —
// the same data the landing page and the upload zone show.
//
// The component and file keep their names: the typed refusal
// (`non_ro_not_included`, lib/uploadRefusals.ts) and its callers are
// unchanged.
//
// It prints the refusal CODE's own copy and nothing else (owner ruling
// 2026-10-02: the message is rendered per viewer from the code). The
// server's message named a plan in English whatever the reader's language;
// the dialog takes no such prop, so there is nothing of the server's to show.

import { useState } from "react";
import { Globe2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CoverageTable } from "@/components/cfo/CoverageTable";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function NonRoUpgradeDialog({ open, onClose }: Props) {
  const { t } = useTranslation();
  const [showCoverage, setShowCoverage] = useState(false);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) { setShowCoverage(false); onClose(); } }}>
      <DialogContent
        data-testid="non-ro-upgrade-dialog"
        className={showCoverage ? "max-w-[760px] max-h-[86vh] overflow-y-auto" : "max-w-[440px]"}
      >
        <DialogHeader>
          <DialogTitle className="text-[16px] font-semibold text-ink flex items-center gap-2">
            <Globe2 size={16} strokeWidth={2} className="text-brand shrink-0" />
            {t("pricing.nonRoBlockedTitle")}
          </DialogTitle>
          <DialogDescription className="text-[13px] text-ink-soft leading-relaxed pt-1">
            {t("pricing.nonRoBlockedDesc")}
          </DialogDescription>
        </DialogHeader>

        {showCoverage && <CoverageTable />}

        <DialogFooter className="gap-2 sm:gap-2">
          {!showCoverage && (
            <button
              type="button"
              onClick={() => setShowCoverage(true)}
              data-testid="non-ro-see-coverage"
              className="inline-flex items-center justify-center h-10 px-4 rounded-xl border border-rule text-[13px] font-medium text-ink-soft hover:text-ink hover:bg-bg-2/50 transition-colors"
            >
              {t("pricing.nonRoBlockedCta")}
            </button>
          )}
          <button
            type="button"
            onClick={() => { setShowCoverage(false); onClose(); }}
            data-testid="non-ro-dismiss"
            className="inline-flex items-center justify-center h-10 px-4 rounded-xl bg-ink text-paper text-[13px] font-medium hover:bg-ink/90 transition-colors"
          >
            {t("pricing.nonRoBlockedDismiss")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
