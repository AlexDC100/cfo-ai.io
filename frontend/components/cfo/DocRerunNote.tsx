// What happened to a file's last "Re-run analysis" — on the file's own row.
//
// A re-run is STAGED beside the file's month (engine gate rerun-data-loss):
// the month keeps being served while the run goes, and a run that fails
// leaves the file `analyzed` over the analysis it had. The row would look as
// if nothing had been tried. The engine says so in `documents.error` with a
// prefix (lib/rerunRefusals RERUN_FAILED_PREFIX) and this component prints
// one of three sentences for it, in the reader's language:
//
//   · interrupted — the run died while it was replacing the analysis; the
//     month may be mid-replacement until the file is re-run (the engine
//     completes the replacement first);
//   · the file now reads as a month that has its own analysis — not applied;
//   · anything else — the previous analysis is still the one served.
//
// What follows the prefix is a code or the run's diagnostic text: it is
// NEVER printed. When it carries a plan refusal's code (a non-Romanian file
// on a plan without it — lib/uploadRefusals), that code's sentence follows —
// unless the row is `failed`, where DocRefusalReason already prints it.
//
// Rendered beside DocRefusalReason, which is untouched: that one speaks for a
// FAILED row; this one for a row whose re-run did not finish.

import { useTranslation } from "react-i18next";

import { rerunFailedKey, rerunFailedKind, rerunFailedRemainder } from "@/lib/rerunRefusals";
import { documentRefusalKey } from "@/lib/uploadRefusals";

export function DocRerunNote({
  status,
  error,
}: {
  status: string;
  error: string | null | undefined;
}) {
  const { t } = useTranslation();
  const kind = rerunFailedKind(error);
  if (!kind) return null;
  const planKey =
    kind === "kept" && status !== "failed" ? documentRefusalKey(rerunFailedRemainder(error)) : null;
  return (
    <p
      data-testid="doc-rerun-note"
      data-kind={kind}
      className="basis-full pl-[15px] text-[10.5px] leading-snug text-alert"
    >
      {t(rerunFailedKey(kind))}
      {planKey ? ` ${t(planKey)}` : null}
    </p>
  );
}
