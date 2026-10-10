// Why a document's analysis was refused — on the row of the failed document.
//
// A re-run can be refused by the company's plan (a non-Romanian document on
// a plan without it, the month's non-Romanian allowance used up, the meter
// unreachable). The refusal happens in the pipeline, after the re-run was
// accepted, so the only thing the Documents panel showed was "· failed".
// The engine stores a NEUTRAL CODE in `documents.error` (owner ruling
// 2026-10-02 — the row is shared by every member, so it never names
// anyone's plan); each viewer's browser prints the sentence for that code in
// that viewer's language (lib/uploadRefusals). Printed with `t()`, so it
// follows a language switch.
//
// Only a plan refusal is printed here. Any other stored error stays behind
// "· failed": it is a diagnostic string, not a sentence written for a row.

import { useTranslation } from "react-i18next";

import { documentRefusalKey } from "@/lib/uploadRefusals";

export function DocRefusalReason({
  status,
  error,
}: {
  status: string;
  error: string | null | undefined;
}) {
  const { t } = useTranslation();
  if (status !== "failed") return null;
  const key = documentRefusalKey(error);
  if (!key) return null;
  return (
    <p
      data-testid="doc-refusal-reason"
      className="basis-full pl-[15px] text-[10.5px] leading-snug text-alert"
    >
      {t(key)}
    </p>
  );
}
