// TemplateDownloadCard — surfaces the canonical Excel upload template
// alongside every "upload your data" surface.
//
// Why this card exists
// --------------------
// Before today, users uploaded random Excel files and the parser tried
// to figure them out. That produced the "DIO didn't extract because the
// sheet name is YTD Oct'25 instead of YTD Mar'26" class of bug — silent,
// brittle, expensive to diagnose.
//
// The fix is a canonical template — a clean .xlsx with the exact sheet
// names, column headers, and row offsets the parser expects. Users
// download it, fill in their rows, re-upload. Parser now has a
// guaranteed-shape input.
//
// The .xlsx itself lives at /templates/cfo_ai_upload_template.xlsx
// (committed under scandi-desk-main/public/) and is regenerated on
// every build by scripts/generate_upload_template.py — so the artifact
// never drifts from the parser.
//
// Surfaces that use this card
// ---------------------------
// · UploadDialog — the small modal opened from the sidebar
// · Products empty-state — the big hero shown when no dataset is loaded
//
// Layout intentionally compact so it fits both surfaces without
// dominating. Two variants: `compact` (modal) and `prominent` (page).

import { motion } from "framer-motion";
import { Download, FileSpreadsheet, ArrowRight, Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useState } from "react";

type Variant = "compact" | "prominent";

interface Props {
  variant?: Variant;
  /** Track downloads — caller can wire this to analytics. */
  onDownload?: () => void;
}

const TEMPLATE_HREF = "/templates/cfo_ai_upload_template.xlsx";
const TEMPLATE_FILENAME = "cfo_ai_upload_template.xlsx";

export function TemplateDownloadCard({ variant = "compact", onDownload }: Props) {
  const { t } = useTranslation();
  // Inline "what's in the template" disclosure — kept collapsed by
  // default so the card stays small. Operators who care about the
  // schema open it once; everyone else just clicks Download.
  const [showFormat, setShowFormat] = useState(false);

  if (variant === "prominent") {
    return (
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
        data-testid="template-download-card-prominent"
        className="
          relative overflow-hidden rounded-2xl
          border border-brand/25 bg-gradient-to-br from-brand/[0.06] to-bg-2/40
          px-5 py-4 sm:px-6 sm:py-5
        "
      >
        {/* Soft glow blob — Apple-style background accent */}
        <div
          aria-hidden
          className="pointer-events-none absolute -top-12 -right-12 h-40 w-40 rounded-full bg-brand/10 blur-3xl"
        />

        <div className="relative flex items-start gap-4">
          <div className="
            shrink-0 h-11 w-11 rounded-xl
            bg-gradient-to-br from-brand/20 to-brand-d/20
            text-brand-d grid place-items-center
            ring-1 ring-brand/20
          ">
            <FileSpreadsheet size={20} strokeWidth={1.75} />
          </div>

          <div className="flex-1 min-w-0">
            <h3 className="text-[14.5px] font-semibold text-ink leading-tight">
              {t("upload.template.title")}
            </h3>
            <p className="mt-1.5 text-[12.5px] text-ink-soft leading-relaxed">
              {t("upload.template.description")}
            </p>

            <div className="mt-3.5 flex flex-wrap items-center gap-2">
              <a
                href={TEMPLATE_HREF}
                download={TEMPLATE_FILENAME}
                onClick={onDownload}
                data-testid="template-download-link"
                className="
                  inline-flex items-center gap-1.5
                  h-9 px-3.5 rounded-lg
                  bg-brand text-bg font-medium text-[12.5px]
                  shadow-[0_6px_16px_-6px_rgba(45,191,179,0.55)]
                  hover:brightness-110 hover:shadow-[0_8px_20px_-6px_rgba(45,191,179,0.7)]
                  transition-all
                  ring-1 ring-inset ring-white/15
                "
              >
                <Download size={13} strokeWidth={2.25} />
                {t("upload.template.download")}
              </a>
              <button
                type="button"
                onClick={() => setShowFormat((v) => !v)}
                data-testid="template-format-toggle"
                aria-expanded={showFormat}
                className="
                  inline-flex items-center gap-1
                  h-9 px-2.5 rounded-lg
                  text-[12.5px] text-ink-soft hover:text-ink
                  transition-colors
                "
              >
                {t("upload.template.formatDocs")}
                <ArrowRight
                  size={11}
                  strokeWidth={2}
                  className={`transition-transform ${showFormat ? "rotate-90" : ""}`}
                />
              </button>
            </div>

            {showFormat && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden"
              >
                <FormatSummary />
              </motion.div>
            )}
          </div>
        </div>
      </motion.div>
    );
  }

  // ─── compact variant — fits inside UploadDialog ──────────────────
  return (
    <div
      data-testid="template-download-card-compact"
      className="
        rounded-lg border border-brand/25 bg-brand/[0.04]
        px-3.5 py-3 mb-4
      "
    >
      <div className="flex items-start gap-3">
        <div className="
          shrink-0 h-8 w-8 rounded-md
          bg-brand/10 text-brand-d
          grid place-items-center
        ">
          <FileSpreadsheet size={15} strokeWidth={1.75} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[12.5px] font-medium text-ink leading-tight">
            {t("upload.template.titleCompact")}
          </div>
          <p className="mt-0.5 text-[11.5px] text-ink-soft leading-snug">
            {t("upload.template.descriptionCompact")}
          </p>
          <div className="mt-2 flex items-center gap-3">
            <a
              href={TEMPLATE_HREF}
              download={TEMPLATE_FILENAME}
              onClick={onDownload}
              data-testid="template-download-link"
              className="
                inline-flex items-center gap-1
                text-[11.5px] font-medium text-brand-d
                hover:text-brand transition-colors
              "
            >
              <Download size={11} strokeWidth={2.25} />
              {t("upload.template.download")}
            </a>
            <button
              type="button"
              onClick={() => setShowFormat((v) => !v)}
              aria-expanded={showFormat}
              className="
                text-[11.5px] text-ink-mute hover:text-ink
                transition-colors
              "
            >
              {showFormat
                ? t("upload.template.hideFormat")
                : t("upload.template.showFormat")}
            </button>
          </div>
          {showFormat && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <FormatSummary compact />
            </motion.div>
          )}
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// FormatSummary — bullet list of what the template contains. Two density
// modes match the parent variants. Content matches the generator script
// (scripts/generate_upload_template.py); update both together.
// ──────────────────────────────────────────────────────────────────────

function FormatSummary({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const padClass = compact ? "mt-2 pt-2.5" : "mt-3 pt-3";
  const textClass = compact ? "text-[11px]" : "text-[12px]";
  const labelClass = compact ? "text-[10.5px]" : "text-[11.5px]";

  const sheets: Array<{ name: string; required: boolean; key: string }> = [
    { name: "Trading",       required: true,  key: "trading" },
    { name: "DIO",           required: true,  key: "dio" },
    { name: "Trial Balance", required: false, key: "trialBalance" },
  ];

  return (
    <div className={`${padClass} border-t border-rule/60 space-y-2`}>
      <div className={`flex items-center gap-1.5 ${labelClass} uppercase tracking-wide text-ink-mute font-medium`}>
        <Info size={compact ? 10 : 11} strokeWidth={2} />
        {t("upload.template.whatsInside")}
      </div>
      <ul className={`space-y-1.5 ${textClass} text-ink-soft leading-snug`}>
        {sheets.map((s) => (
          <li key={s.name} className="flex items-start gap-2">
            <span className="
              shrink-0 inline-flex items-center
              font-mono text-ink rounded px-1.5 py-px
              bg-bg-2 border border-rule
            ">
              {s.name}
            </span>
            <span className="flex-1">
              <span
                className={
                  s.required
                    ? "text-brand-d font-medium"
                    : "text-ink-mute italic"
                }
              >
                {s.required
                  ? t("upload.template.required")
                  : t("upload.template.optional")}
              </span>
              {" — "}
              {t(`upload.template.sheets.${s.key}`)}
            </span>
          </li>
        ))}
      </ul>
      <p className={`${textClass} text-ink-mute pt-1 leading-snug`}>
        {t("upload.template.fallbackNote")}
      </p>
    </div>
  );
}
