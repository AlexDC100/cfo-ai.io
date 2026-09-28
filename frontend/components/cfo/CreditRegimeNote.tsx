// CreditRegimeNote — the stock-build credit regime, printed ONCE beside the
// grade (credit model revision 5, owner ruling R1, 2026-09-28).
//
// A projection of the SERVED block (`lib/creditRegime.readCreditRegime`):
// the regime's label, the finding (the owner's sentence — Romanian verbatim —
// and its English equivalent, severity as served) with its served figures,
// why the regime applies (each trigger test: the share the book reached
// against the pack share, both as served), the cash basis the components
// were graded on (and, when it is not measured, the engine's own words for
// why the letter is refused), and what Altman X3 was computed on. It computes
// nothing: money prints in the currency it was served in, with that
// currency's code (lib/money formatMoneyFrom, source = display, no rate), and
// a figure the engine did not measure prints its status, never 0.

import { useTranslation } from "react-i18next";

import {
  printAtLeast,
  printRegimeAmount as servedAmount,
  printShare,
  regimeLang,
  type CreditRegime,
} from "@/lib/creditRegime";

export function CreditRegimeNote({
  regime,
  testid = "credit-regime",
}: {
  regime: CreditRegime;
  testid?: string;
}) {
  const { i18n } = useTranslation();
  const lang = regimeLang(i18n.language);
  const finding = regime.finding;
  const notMeasured = lang === "ro" ? "nemăsurat" : "not measured";
  return (
    <div
      className="mt-3 rounded-md border border-rule bg-caution-tint p-4 text-[13px] leading-relaxed"
      data-testid={testid}
      data-regime={regime.code}
    >
      <div className="text-[11px] uppercase tracking-[0.1em] font-medium text-caution" data-testid={`${testid}-label`}>
        {regime.label[lang]}
      </div>
      {finding ? (
        <div className="mt-2" data-testid={`${testid}-finding`} data-severity={finding.severity}>
          <p className="font-medium text-ink">{finding.text[lang]}</p>
          {finding.figures.length > 0 ? (
            <ul className="mt-1.5 space-y-0.5 text-[12.5px] text-ink-soft">
              {finding.figures.map((f) => (
                <li key={f.key} data-testid={`${testid}-figure-${f.key}`}>
                  {f.label[lang]}:{" "}
                  <span className="font-mono tabular-nums text-ink">
                    {f.value === null ? notMeasured : servedAmount(f.value, f.unit)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {regime.tests.length > 0 ? (
        <ul className="mt-2 space-y-0.5 text-[12px] text-ink-soft" data-testid={`${testid}-trigger`}>
          {regime.tests.map((t) => (
            <li key={t.key}>
              {t.label[lang]}:{" "}
              <span className="font-mono tabular-nums">{printShare(t.share, lang) ?? notMeasured}</span>
              {" "}≥ <span className="font-mono tabular-nums">{printAtLeast(t.atLeast, lang)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {regime.cash ? (
        <p className="mt-2 text-[12px] text-ink-soft" data-testid={`${testid}-cash`} data-status={regime.cash.status}>
          {regime.cash.refusal
            ? regime.cash.refusal.text[lang]
            : `${regime.cash.label[lang]}: ${regime.cash.value === null ? notMeasured : servedAmount(regime.cash.value, finding?.figures[0]?.unit ?? null)}`}
        </p>
      ) : null}
      {regime.altmanX3Label ? (
        <p className="mt-1 text-[12px] text-ink-soft" data-testid={`${testid}-x3`}>
          {regime.altmanX3Label[lang]}
        </p>
      ) : null}
      {regime.weightsWhy ? (
        <p className="mt-1 text-[12px] text-ink-mute" data-testid={`${testid}-weights`}>
          {regime.weightsWhy[lang]}
        </p>
      ) : null}
    </div>
  );
}
