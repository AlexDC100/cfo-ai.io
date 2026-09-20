// FailedUploadBanner.tsx — the failed state of an upload, as a banner ABOVE
// the dashboard, never instead of it (2026-09-20 P0).
//
// Before this, a `failed` entry in the upload store took over the whole
// dashboard with the scan view — five steps, "Analysis failed", and a Cancel
// button positioned below the fold on short viewports. The entry is persisted
// in localStorage, so a reload restored the dead end forever: a period that
// the server was serving correctly became unreachable from the UI.
//
// The contract, enforced by __tests__/FailedUploadBanner.test.tsx: a failed
// upload ALWAYS offers Retry · Replace file · Manage files · View error, and
// a way to dismiss. It never blocks the period behind it.

import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";

import type { UploadDoc } from "@/lib/uploadStore";
import { formatDateTime } from "@/lib/locale";

const ACTION =
  "inline-flex items-center justify-center h-8 px-3 rounded-lg border border-rule bg-surface " +
  "text-[12.5px] font-medium text-ink hover:bg-bg-2/60 hover:border-rule-strong transition-colors " +
  "disabled:opacity-50 disabled:pointer-events-none";

export function FailedUploadBanner({
  upload,
  periodId,
  onRetry,
  onReplace,
  onDismiss,
  retrying = false,
}: {
  upload: UploadDoc;
  /** The period the user is looking at (or the one the upload targeted) —
   *  scopes the Manage files link. Null → the workspace root. */
  periodId: string | null;
  /** Re-run the analysis for the same document. When the upload never
   *  produced a document row the host wires this to the file picker. */
  onRetry: () => void;
  onReplace: () => void;
  onDismiss: () => void;
  retrying?: boolean;
}) {
  const { t } = useTranslation();
  const [showError, setShowError] = useState(false);
  const manageHref = periodId ? `/workspace?period=${encodeURIComponent(periodId)}` : "/workspace";
  const when = (() => {
    try { return formatDateTime(new Date(upload.updatedAt || upload.startedAt).toISOString()); } catch { return ""; }
  })();

  return (
    <section
      role="alert"
      data-testid="failed-upload-banner"
      className="mb-5 rounded-xl border border-red-500/35 bg-red-500/[0.06] px-4 py-3.5"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-300" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-semibold text-ink break-words">
            {upload.filename
              ? t("scan.failedTitle", { filename: upload.filename })
              : t("scan.failedTitleNoFile")}
          </p>
          <p className="mt-0.5 text-[12.5px] text-ink-2">{t("scan.failedBody")}</p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" className={ACTION} onClick={onRetry} disabled={retrying} data-testid="failed-upload-retry">
              {retrying ? t("scan.failedRetrying") : t("scan.failedRetry")}
            </button>
            <button type="button" className={ACTION} onClick={onReplace} data-testid="failed-upload-replace">
              {t("scan.failedReplace")}
            </button>
            <Link to={manageHref} className={ACTION} data-testid="failed-upload-manage">
              {t("scan.failedManage")}
            </Link>
            <button
              type="button"
              className={ACTION}
              onClick={() => setShowError((v) => !v)}
              aria-expanded={showError}
              aria-controls="failed-upload-error"
              data-testid="failed-upload-view-error"
            >
              {showError ? t("scan.failedHideError") : t("scan.failedViewError")}
            </button>
            <button
              type="button"
              onClick={onDismiss}
              data-testid="failed-upload-dismiss"
              className="ml-auto inline-flex items-center h-8 px-2 text-[12.5px] font-medium text-ink-2 hover:text-ink transition-colors"
            >
              {t("scan.failedDismiss")}
            </button>
          </div>

          {showError && (
            <div
              id="failed-upload-error"
              data-testid="failed-upload-error"
              className="mt-3 rounded-lg border border-rule bg-surface px-3 py-2.5 text-[12px] text-ink-2"
            >
              <p className="whitespace-pre-wrap break-words font-mono text-[11.5px] text-ink">
                {upload.error?.trim() ? upload.error : t("scan.failedErrorNone")}
              </p>
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-[11px]">
                {upload.filename && (<><dt>{t("scan.failedDetailFile")}</dt><dd className="break-all">{upload.filename}</dd></>)}
                {upload.docId && (<><dt>{t("scan.failedDetailDoc")}</dt><dd className="break-all">{upload.docId}</dd></>)}
                {when && (<><dt>{t("scan.failedDetailWhen")}</dt><dd>{when}</dd></>)}
              </dl>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
