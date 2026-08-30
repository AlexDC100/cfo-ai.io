// F8 — SILENCE IS VALID.
//
// When nothing met the contract, the screen says exactly that and then
// proves it: the engine's own `silence_statement()` sentence, verbatim,
// followed by every rule that ran with its parameter, its limit and the
// value it saw. Not "you're all good", not a green tick, not an
// encouraging paragraph. A quiet period is a RESULT, and a result has
// evidence behind it.
//
// The statement string is passed through untouched. Re-wording it here
// would make the screen and the engine two sources for one claim, and
// the screen is not the one that ran the checks.

import { useTranslation } from "react-i18next";
import { CheckCircle2 } from "lucide-react";

import type { FindingsReport } from "@/lib/findings";

import { AllChecksList } from "./AllChecksList";
import "./findingsI18n";

export function SilenceCard({
  report,
  currency,
}: {
  report: FindingsReport;
  currency?: string;
}) {
  const { t } = useTranslation();
  const silence = report.silence;

  return (
    <div className="space-y-3" data-testid="fnd-silence">
      <section className="rounded-md border border-rule bg-surface p-5">
        <div className="flex items-start gap-3">
          <CheckCircle2
            size={18}
            strokeWidth={1.8}
            className="mt-[2px] shrink-0 text-brand"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <h3 className="text-[15px] font-medium text-ink">{t("fnd.silence.title")}</h3>
            {silence ? (
              <p
                className="mt-1.5 max-w-[70ch] text-[13px] leading-relaxed text-ink-soft"
                data-testid="fnd-silence-statement"
              >
                {silence.statement}
              </p>
            ) : null}
            <p className="mt-2 max-w-[70ch] text-[12.5px] leading-relaxed text-ink-mute">
              {t("fnd.silence.note")}
            </p>
            {silence?.profile_id ? (
              <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-mute">
                {t("fnd.profile")} {silence.profile_id}
              </p>
            ) : null}
          </div>
        </div>
      </section>

      <AllChecksList report={report} currency={currency} defaultOpen />
    </div>
  );
}
