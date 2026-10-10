// One authority for "what the financial pipeline accepts as a document".
//
// This used to be a module-local const in FinancialStatements.tsx, whose own
// comment said it was shared by two consumers "so the two can't drift". A
// third consumer then appeared — the workspace onboarding wizard — and it did
// drift: the wizard hard-coded `.xlsx,.csv` and rejected `.xls` client-side,
// so a Crystal Reports balanță (a real, parseable, saga_10_col file the engine
// reads fine via xlrd) could not even be selected. Anything that feeds
// uploadDocument({scope:"financial"}) must import from here.

//
// ONLY WHAT A READER OPENS (2026-10-02). This list used to offer .pptx and
// .ppt. The engine refuses a PowerPoint file on every branch, by name
// (`engine/api/_upload_type.REACHES_NO_READER`) — the picker was inviting a
// refusal. An extension is offered here only when its own file type reaches
// a reader; the engine law `test_the_upload_picker_offers_no_type_the_engine
// _refuses_by_name` reads this file and reds on one that does not.

/** `accept` attribute for any input/dropzone feeding the financial pipeline. */
export const FINANCIAL_UPLOAD_ACCEPT =
  ".pdf,.xlsx,.xls,.csv,.jpg,.jpeg,.png,.heic,.heif,image/heic,image/heif";

/** The extensions above, for validating a dropped File (drag-and-drop bypasses
 *  the `accept` attribute entirely, so a dropzone must re-check). */
export const FINANCIAL_UPLOAD_EXTENSIONS = [
  ".pdf", ".xlsx", ".xls", ".csv",
  ".jpg", ".jpeg", ".png", ".heic", ".heif",
] as const;

/** True when `filename`'s extension is one the financial pipeline accepts. */
export function isAcceptedFinancialUpload(filename: string): boolean {
  const lower = filename.toLowerCase();
  return FINANCIAL_UPLOAD_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
