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
import { Download, FileSpreadsheet, ExternalLink, Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useState } from "react";

import { Panel, PanelBody, PanelHeader } from "@/components/instrument/Panel";

// Module-level i18n instance — previewWorkbookInNewTab runs outside the React
// tree (it writes into a raw window.open tab), so it can't use the hook.
import i18n from "@/i18n";
import { previewBackButtonHtml } from "@/lib/previewChrome";

type Variant = "compact" | "prominent";

/** Which surface hosts the card — flips the sheet summary's emphasis.
 *  Products: Trading + DIO required, Trial Balance optional. Dashboard:
 *  the Trial Balance sheet is THE required input (the full analysis is
 *  rebuilt from it); Trading/DIO only feed /products. Same workbook
 *  either way. */
type TemplateContext = "products" | "dashboard";

interface Props {
  variant?: Variant;
  context?: TemplateContext;
  /** Track downloads — caller can wire this to analytics. */
  onDownload?: () => void;
  /** Extra content rendered at the card's foot (prominent variant only)
   *  — e.g. the dashboard's example-trial-balance downloads. */
  extra?: React.ReactNode;
  /** Replaces the default Download/View action row (prominent variant
   *  only) — the dashboard renders its example trial balances here
   *  instead of the template buttons. */
  actions?: React.ReactNode;
}

const TEMPLATE_HREF = "/templates/cfo_ai_upload_template.xlsx";
const TEMPLATE_FILENAME = "cfo_ai_upload_template.xlsx";

// Open the template workbook in a NEW TAB as a rendered table — same approach
// as the dashboard's example-trial-balance "View" button. A plain
// <a href="*.xlsx" target="_blank"> just triggers a download (browsers can't
// render xlsx inline), so we parse every sheet with SheetJS and write an HTML
// preview instead. The tab is opened synchronously inside the click gesture
// (before the first await) so it isn't popup-blocked, then filled once parsed.
async function previewWorkbookInNewTab(
  href: string,
  filename: string,
  subtitle: string,
): Promise<void> {
  const loadingText = i18n.t("tmpl.previewLoading");
  const tab = window.open("", "_blank");
  if (tab) {
    tab.document.write(
      `<!doctype html><title>${loadingText}</title>` +
      `<body style="font:14px system-ui;padding:24px">${loadingText}</body>`,
    );
  }
  try {
    const res = await fetch(href);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    const XLSX = await import("xlsx");
    const wb = XLSX.read(buf, { type: "array" });
    const sections = wb.SheetNames
      .map((name) => `<h2>${name}</h2>${XLSX.utils.sheet_to_html(wb.Sheets[name])}`)
      .join("");
    // Standalone generated HTML document written into a raw tab — the app's
    // CSS variables do not exist there, so this document carries literal
    // colors by necessity (sanctioned design-lint escape, per entry below).
    const doc =
      `<!doctype html><html><head><meta charset="utf-8"><title>${filename}</title><style>` +
      /* design-lint-allow-hex — generated standalone document, no CSS vars */
      "body{font:13px/1.4 system-ui,Segoe UI,Arial,sans-serif;margin:0;padding:24px;color:#0f172a;background:#fff}" +
      /* design-lint-allow-hex — generated standalone document, no CSS vars */
      "h1{font-size:15px;margin:0 0 4px;color:#1B7268}" +
      /* design-lint-allow-hex — generated standalone document, no CSS vars */
      "h2{font-size:13px;margin:20px 0 8px;color:#1B7268}" +
      "table{border-collapse:collapse;font-variant-numeric:tabular-nums;margin-bottom:8px}" +
      /* design-lint-allow-hex — generated standalone document, no CSS vars */
      "td,th{border:1px solid #d6dde6;padding:4px 8px;white-space:nowrap;text-align:right}" +
      /* design-lint-allow-hex — generated standalone document, no CSS vars */
      "tr:first-child td{background:#1B7268;color:#fff;font-weight:600;text-align:left}" +
      `</style></head><body>${previewBackButtonHtml()}<h1>${filename} — ${subtitle}</h1>${sections}</body></html>`;
    if (tab) {
      tab.document.open();
      tab.document.write(doc);
      tab.document.close();
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "error";
    if (tab) {
      tab.document.open();
      tab.document.write(
        /* design-lint-allow-hex — generated standalone document, no CSS vars */
        `<!doctype html><body style="font:14px system-ui;padding:24px;color:#b91c1c">${previewBackButtonHtml()}${i18n.t("tmpl.previewError", { msg })}</body>`,
      );
      tab.document.close();
    }
  }
}

function previewTemplateInNewTab(): Promise<void> {
  return previewWorkbookInNewTab(TEMPLATE_HREF, TEMPLATE_FILENAME, i18n.t("tmpl.previewSubtitle"));
}

export function TemplateDownloadCard({
  variant = "compact",
  context = "products",
  onDownload,
  extra,
  actions,
}: Props) {
  const { t } = useTranslation();
  // Inline "what's in the template" disclosure — kept collapsed by
  // default so the card stays small. Operators who care about the
  // schema open it once; everyone else just clicks Download.
  const [showFormat, setShowFormat] = useState(false);

  if (variant === "prominent") {
    // THE INSTRUMENT — a resting Panel (hairline border, no glow, no
    // animated gradient, no shadow) with a standard header row and one
    // file-affordance row per artifact: spreadsheet mark, name + meta on
    // the left, View / Download on the right.
    return (
      <Panel data-testid="template-download-card-prominent">
        <PanelHeader title={t("upload.template.title")} />
        <PanelBody className="space-y-3">
          <p className="text-[12.5px] text-ink-soft leading-relaxed">
            {t("upload.template.description")}
          </p>

          {/* Default action — one file row per artifact. Callers can still
              override via `actions` (the dashboard renders its example
              trial balances here instead). */}
          {actions ?? (
            <div className="space-y-2">
              <FileAffordanceRow
                name={t("tmpl.officialTemplate")}
                meta={t("tmpl.officialTemplateDesc")}
                onView={() => void previewTemplateInNewTab()}
                viewTestid="template-view"
                href={TEMPLATE_HREF}
                downloadName={TEMPLATE_FILENAME}
                downloadTestid="template-download-link"
                onDownload={onDownload}
              />
              {/* Sales-analysis example — relocated here from the
                  "Expected format" card (2026-07-24). */}
              <FileAffordanceRow
                name={t("tmpl.salesExample")}
                meta={t("expectedFormat.exampleCaption")}
                onView={() =>
                  void previewWorkbookInNewTab(
                    "/examples/example_products_trading.xlsx",
                    "example_products_trading.xlsx",
                    t("tmpl.previewSalesSubtitle"),
                  )
                }
                viewTestid="view-sales-template"
                href="/examples/example_products_trading.xlsx"
                downloadName="example_products_trading.xlsx"
                downloadTestid="download-sales-template"
              />
            </div>
          )}

          {/* "What's inside" — always shown now (no longer behind a toggle). */}
          <FormatSummary context={context} />
          {extra}
        </PanelBody>
      </Panel>
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
                text-[11.5px] text-ink-soft hover:text-ink
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
              <FormatSummary compact context={context} />
            </motion.div>
          )}
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// FileAffordanceRow — one downloadable artifact as a proper file row:
// spreadsheet mark, name + meta, View / Download actions. The prominent
// template Panel renders one per file.
// ──────────────────────────────────────────────────────────────────────

function FileAffordanceRow({
  name,
  meta,
  onView,
  viewTestid,
  href,
  downloadName,
  downloadTestid,
  onDownload,
}: {
  name: string;
  meta: string;
  onView: () => void;
  viewTestid: string;
  href: string;
  downloadName: string;
  downloadTestid: string;
  onDownload?: () => void;
}) {
  const { t } = useTranslation();
  const actionCls =
    "inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-[12px] font-medium text-ink bg-surface hover:bg-bg-2 ring-1 ring-inset ring-rule transition-colors";
  return (
    // flex-wrap: at phone widths the action pair drops below the name
    // instead of crushing it to a few characters.
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-md border border-rule bg-bg-2/40 px-3 py-2">
      <div className="flex items-center gap-2.5 min-w-[200px] flex-1">
        <span className="shrink-0 grid place-items-center h-8 w-8 rounded border border-rule bg-surface text-ink-soft">
          <FileSpreadsheet size={14} strokeWidth={1.75} />
        </span>
        <div className="min-w-0">
          <div className="text-[12.5px] font-medium text-ink truncate">
            {name} <span className="font-mono text-[10.5px] text-ink-soft font-normal">XLSX</span>
          </div>
          {/* No truncate here — a nowrap meta line inflates the max-content
              of implicit grid columns hosting this card and clips whole
              heroes at phone widths (caught by the 390px sweep). */}
          <div className="text-[10.5px] text-ink-soft">{meta}</div>
        </div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <button type="button" onClick={onView} data-testid={viewTestid} className={actionCls}>
          <ExternalLink size={12} strokeWidth={2} />
          {t("tmpl.view")}
        </button>
        <a
          href={href}
          download={downloadName}
          onClick={onDownload}
          data-testid={downloadTestid}
          className={actionCls}
        >
          <Download size={12} strokeWidth={2} />
          {t("common.download")}
        </a>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// FormatSummary — bullet list of what the template contains. Two density
// modes match the parent variants. Content matches the generator script
// (scripts/generate_upload_template.py); update both together.
// ──────────────────────────────────────────────────────────────────────

function FormatSummary({
  compact = false,
  context = "products",
}: {
  compact?: boolean;
  context?: TemplateContext;
}) {
  const { t } = useTranslation();
  const padClass = compact ? "mt-2 pt-2.5" : "mt-3 pt-3";
  const textClass = compact ? "text-[11px]" : "text-[12px]";
  const labelClass = compact ? "text-[10.5px]" : "text-[11.5px]";

  // Surface-specific content. Products describes the multi-sheet upload
  // template's sheets. The Dashboard card's actions are the two EXAMPLE
  // trial-balance files, so its summary describes what those files
  // actually contain (their column structures) — no required/optional
  // tags, both are equivalent examples of accepted formats.
  const sheets: Array<{
    name: string;
    /** null = no Required/Optional tag (file rows, not sheet rows). */
    required: boolean | null;
    key: string;
    fallback?: string;
  }> =
    context === "dashboard"
      ? [
          {
            name: t("tmpl.formatMultiCol"),
            required: null,
            key: "exampleMultiCol",
            fallback:
              "Account code + account name, then Debit/Credit column pairs for opening balances, period movements, cumulative totals, and closing balances — the 10-column layout SAGA and most Romanian systems export.",
          },
          {
            name: t("tmpl.formatSaga"),
            required: null,
            key: "exampleSaga",
            fallback:
              "The compact SAGA export: account code + account name with Debit/Credit column pairs for opening balances, period movements, and closing balances.",
          },
        ]
      : [
          { name: "Trading",       required: true,  key: "trading" },
          { name: "DIO",           required: true,  key: "dio" },
          { name: "Trial Balance", required: false, key: "trialBalance" },
        ];

  return (
    <div className={`${padClass} border-t border-rule/60 space-y-2`}>
      <div className={`flex items-center gap-1.5 ${labelClass} uppercase tracking-wide text-ink-soft font-medium`}>
        <Info size={compact ? 10 : 11} strokeWidth={2} />
        {context === "dashboard"
          ? t("upload.template.insideExamples", "Inside the example files")
          : t("upload.template.whatsInside")}
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
              {s.required !== null && (
                <>
                  <span
                    className={
                      s.required
                        ? "text-brand-d font-medium"
                        : "text-ink-soft italic"
                    }
                  >
                    {s.required
                      ? t("upload.template.required")
                      : t("upload.template.optional")}
                  </span>
                  {" — "}
                </>
              )}
              {t(`upload.template.sheets.${s.key}`, s.fallback ?? "")}
            </span>
          </li>
        ))}
      </ul>
      <p className={`${textClass} text-ink-soft pt-1 leading-snug`}>
        {context === "dashboard"
          ? t(
              "upload.template.fallbackNoteDashboard",
              "Your accounting system's own export works too, as long as it follows one of these column structures.",
            )
          : t("upload.template.fallbackNote")}
      </p>
    </div>
  );
}
