// EbitdaReconciliationPanel — THE ONE EBITDA, explained by the engine's own
// reconciliation (design A5, owner ruling 2026-09-26).
//
// Three parts, every figure and every line name SERVED
// (`statements.assembled_pl.ebitda_reconciliation`, read through
// lib/servedOneEbitda.ts) — nothing here is added, subtracted or divided:
//
//   1. THE CHAIN — net turnover → other operating income → own work
//      capitalised (72x) → cost of sales, with "Variația stocurilor de
//      produse" (711) beside it, signed and with its provenance → other
//      operating expenses → EBITDA → D&A → net provisions (6812 + 6814 −
//      7812 − 7814, outside EBITDA — owner ruling R2, 2026-09-28) →
//      operating result → financial result → tax → net result = account
//      121 (or "not anchored"). On a
//      closed book the 711 line is DERIVED from account 121, so the chain
//      closes by construction; the engine's note says so.
//   2. THE ONE-LINE BRIDGE — EBITDA before the stock variation and own work
//      capitalised · the stock variation · own work capitalised = EBITDA,
//      then the served lines OUTSIDE EBITDA after it (net provisions).
//   3. EBITDA → CORE EBITDA (the valuation basis): the served 758 and 781
//      strips and the served core figure — on the one EBITDA.
//
// A refused figure prints the engine's typed reason, never a zero. The
// Romanian line names stay in the English UI, with the engine's English
// gloss beside them (CLAUDE.md §11).
//
// It replaces the "Reported → Core, one company, two valid EBITDAs" panel:
// under the ruling there is ONE EBITDA, and the old panel's margins divided
// by total operating revenue — a denominator the ruling retired.

import { Info } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { Statements } from "@/lib/financialReport";
import { pickMargin, type MarginBilingual } from "@/lib/marginMeaning";
import {
  netProvisionsEffectAccounts,
  pickLang,
  readServedOneEbitda,
  type Bilingual,
  type ServedReconLine,
  type ServedRefusal,
} from "@/lib/servedOneEbitda";
import { formatAmountFrom } from "@/lib/money";
import type { Currency } from "@/lib/rates";
import { useCurrency } from "@/stores/currency";

interface Props {
  /** The period's served statements — the panel reads `assembled_pl`. */
  statements: Pick<Statements, "assembled_pl"> | null | undefined;
  currency?: string;
  testid?: string;
  /** The ENGINE's refusal of every margin over turnover for this period
   *  (`statements.margin_meaning`): stated in the footer. */
  marginRefusal?: MarginBilingual | null;
}

/** The Romanian name, with the English gloss beside it in the English UI. */
function NameWithGloss({ label, lang }: { label: Bilingual; lang: string | undefined }) {
  const isRo = (lang ?? "").toLowerCase().startsWith("ro");
  return (
    <>
      {label.ro}
      {!isRo && label.en !== label.ro && (
        <span className="text-ink-mute font-normal"> — {label.en}</span>
      )}
    </>
  );
}

export function EbitdaReconciliationPanel({
  statements,
  currency = "RON",
  testid = "ebitda-reconciliation-panel",
  marginRefusal = null,
}: Props) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  // The display currency and rates, read the way every report surface reads
  // them (`useCurrency` + `formatAmountFrom`), so the panel prints the same
  // converted figure as the table beside it.
  const { display, rates } = useCurrency();
  const fmt = (v: number, opts: { sign?: "positive" | "negative" } = {}) =>
    formatAmountFrom(v, ((currency as Currency) || "RON"), display, rates.rates, opts);
  const served = readServedOneEbitda(statements?.assembled_pl);
  const recon = served?.reconciliation ?? null;

  const money = (v: number | null, signed = false): string => {
    if (v === null) return t("statements.pl.refused");
    if (Math.abs(v) < 0.005) return "0";
    return signed ? fmt(v, { sign: v > 0 ? "positive" : "negative" }) : fmt(v);
  };
  const reason = (r: ServedRefusal | null | undefined) => (r ? pickLang(r.text, lang) : null);
  // NET PROVISIONS ON ONE CONVENTION PER SURFACE (review 2026-10-01). The
  // engine serves the bridge's after-EBITDA part EFFECT-signed, under a label
  // whose arithmetic is the CHARGE ("6812 + 6814 − 7812 − 7814"): the P&L tab
  // prints that part as the row's served charge, and this panel printed the
  // opposite sign under the same label (agras "−131,394.66" here, "131,394.66"
  // there; Scandia's release "+6,372,805" here). The bridge after EBITDA is not
  // a term of a sum, so it prints THE ROW'S served figure, unsigned and
  // uncoloured, exactly as PLStatementView does — a block with no readable
  // net-provisions figure prints no after-part rather than a second
  // convention. The CHAIN above it IS a sum (EBITDA − D&A − net provisions =
  // the operating result, every cost negative), so its row keeps the effect
  // and states the effect's arithmetic instead (`netProvisionsEffectAccounts`:
  // "7812 + 7814 − 6812 − 6814"), so the label evaluates to the printed figure.
  const np = served?.netProvisions ?? null;
  const npEffectAccounts = np ? netProvisionsEffectAccounts(np) : null;
  const afterParts = (recon?.bridge.afterEbitda ?? []).flatMap((p) => {
    if (p.key !== "net_provisions") return [{ ...p, signed: true }];
    return np ? [{ ...p, value: np.value as number | null, signed: false }] : [];
  });

  return (
    <section
      data-testid={testid}
      data-definition={recon?.definition ?? undefined}
      className="rounded-2xl border border-rule bg-surface p-5 sm:p-6"
    >
      <header className="mb-4">
        <div className="text-[10.5px] uppercase tracking-[0.14em] text-ink-mute font-semibold inline-flex items-center gap-1.5">
          <Info size={11} strokeWidth={2} className="text-brand-d" />
          {t("statements.ebitdaRecon.eyebrow")}
        </div>
        <h3 className="mt-1.5 text-[16px] font-semibold text-ink leading-tight">
          {t("statements.ebitdaRecon.title")}
        </h3>
        <p className="mt-1 text-[12.5px] text-ink-soft leading-relaxed max-w-[680px]">
          {t("statements.ebitdaRecon.lead")}
        </p>
      </header>

      {!recon ? (
        <p className="text-[12.5px] text-ink-soft" data-testid="ebitda-recon-not-served">
          {t("statements.ebitdaRecon.notServed")}
        </p>
      ) : (
        <>
          {/* 1. THE CHAIN, as served. */}
          <ol className="space-y-0.5 text-[13px]" data-testid="ebitda-reconciliation-rows">
            {recon.lines.map((l) => (
              <ReconRow
                key={l.key}
                line={l}
                lang={lang}
                money={money}
                reason={reason}
                effectAccounts={l.key === "net_provisions" ? npEffectAccounts : null}
                nameOnly={l.key === "net_provisions" && np ? np.name : null}
              />
            ))}
          </ol>

          {/* 2. THE ONE-LINE BRIDGE, as served. */}
          {recon.bridge.parts.length > 0 && (
            <div className="mt-4 rounded-md bg-bg-2 px-3 py-2 text-[12.5px] text-ink-soft" data-testid="ebitda-recon-bridge">
              {recon.bridge.parts.map((p, i) => {
                const signed = p.key === "inventory_variation" || p.key === "capitalized_own_work";
                return (
                  <span key={p.key} data-bridge-part={p.key}>
                    {i > 0 && <span className="text-ink-mute">{p.key === "ebitda" ? " = " : " · "}</span>}
                    {pickLang(p.label, lang)}{" "}
                    <span className="tabular-nums text-ink">{money(p.value, signed)}</span>
                  </span>
                );
              })}
              {/* After EBITDA, outside it — the engine's label says so; net
                  provisions on the P&L tab's convention (see `afterParts`). */}
              {afterParts.map((p) => (
                <span key={p.key} data-bridge-after={p.key}>
                  <span className="text-ink-mute">{" · "}</span>
                  {pickLang(p.label, lang)}{" "}
                  <span
                    className="tabular-nums text-ink"
                    data-bridge-value={p.value === null ? "none" : String(p.value)}
                  >
                    {money(p.value, p.signed)}
                  </span>
                </span>
              ))}
              {recon.bridge.refusal && (
                <div className="mt-1 text-alert" data-testid="ebitda-recon-bridge-refused">
                  {reason(recon.bridge.refusal)}
                </div>
              )}
            </div>
          )}
          {recon.identityNote && (
            <p className="mt-2 text-[11.5px] text-ink-mute" data-testid="ebitda-recon-identity-note">
              {pickLang(recon.identityNote, lang)}
            </p>
          )}
          {recon.splitAssumption && (
            <p className="mt-1 text-[11.5px] text-ink-mute" data-testid="ebitda-recon-split-assumption">
              {pickLang(recon.splitAssumption, lang)}
            </p>
          )}

          {/* 3. EBITDA → CORE EBITDA (valuation basis), on the one EBITDA. */}
          {served && (served.coreEbitda !== null || served.ebitda === null) && (
            <div className="mt-5 pt-3 border-t border-rule/60" data-testid="ebitda-recon-core">
              <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-semibold mb-1.5">
                {t("statements.ebitdaRecon.coreHeading")}
              </div>
              <ol className="space-y-0.5 text-[13px]">
                <CoreRow label={t("statements.pl.ebitda")} value={money(served.ebitda)} strong />
                {served.otherIncome758 !== null && Math.abs(served.otherIncome758) >= 0.005 && (
                  <CoreRow label={t("statements.ebitdaRecon.less758")} account="758" value={money(-served.otherIncome758, true)} />
                )}
                {served.reversals781 !== null && Math.abs(served.reversals781) >= 0.005 && (
                  <CoreRow label={t("statements.ebitdaRecon.less781")} account="781" value={money(-served.reversals781, true)} />
                )}
                <CoreRow
                  label={t("statements.ebitdaRecon.coreTotal")}
                  value={money(served.coreEbitda)}
                  strong
                  testid="ebitda-recon-core-total"
                />
              </ol>
              {served.ebitda === null && served.refusal && (
                <p className="mt-1 text-[11.5px] text-alert" data-testid="ebitda-recon-core-refused">
                  {reason(served.refusal)}
                </p>
              )}
            </div>
          )}
        </>
      )}

      <footer className="mt-4 pt-3 border-t border-rule/60 flex items-center justify-between gap-3 flex-wrap text-[11.5px] text-ink-mute">
        {marginRefusal && (
          <span data-testid="ebitda-recon-margin-refused" className="text-ink-soft">
            {pickMargin(marginRefusal, lang)}
          </span>
        )}
        <span className="text-ink-mute">{t("statements.ebitdaRecon.footer")}</span>
      </footer>
    </section>
  );
}

function ReconRow({
  line,
  lang,
  money,
  reason,
  effectAccounts = null,
  nameOnly = null,
}: {
  line: ServedReconLine;
  lang: string | undefined;
  money: (v: number | null, signed?: boolean) => string;
  reason: (r: ServedRefusal | null | undefined) => string | null;
  /** Net provisions only: its accounts as the arithmetic of the EFFECT this
   *  chain prints (reversals − charges), in place of the engine's charge
   *  arithmetic, which the printed figure contradicts. */
  effectAccounts?: string | null;
  /** Net provisions only: the served block's NAME, without accounts, in
   *  place of the chain line's label. That label is the engine's full
   *  "… (6812 + 6814 − 7812 − 7814)" — the charge arithmetic — and beside
   *  the effect chip it made ONE ROW state two opposite arithmetics (review
   *  2026-10-02: "… (6812 + 6814 − 7812 − 7814) 7812 + 7814 − 6812 − 6814
   *  −131,394.66"). The name carries no arithmetic; the chip carries the
   *  one this row's figure is. */
  nameOnly?: Bilingual | null;
}) {
  const { t } = useTranslation();
  // Signed as its effect on the result: the two components inside EBITDA
  // and net provisions outside it (a net release prints "+").
  const component =
    line.key === "inventory_variation" || line.key === "capitalized_own_work" || line.key === "net_provisions";
  // The account codes in the reader's language ("fără" / "excl."), where
  // the engine words them apart — a code string, never a figure.
  const accountCodes =
    effectAccounts ??
    ((lang ?? "").toLowerCase().startsWith("ro") ? line.accounts : line.accountsEn ?? line.accounts);
  const notAnchored = line.key === "account_121" && line.status === "not_anchored";
  const refusal = line.value === null ? reason(line.refusal) : null;
  return (
    <li
      data-recon-line={line.key}
      data-recon-value={line.value === null ? "none" : String(line.value)}
      className={`grid grid-cols-[1fr_auto] gap-3 items-baseline py-1 ${
        line.subtotal || line.key === "account_121" ? "border-t border-rule/60 font-semibold text-ink" : "text-ink-soft"
      } ${line.key === "inventory_variation" ? "pl-4" : ""}`}
    >
      <span>
        <NameWithGloss label={nameOnly ?? line.label} lang={lang} />
        {accountCodes && (
          <span className="ml-1.5 font-mono text-[10px] text-ink-mute" data-recon-accounts={line.key}>
            {accountCodes}
          </span>
        )}
        {component && line.key !== "net_provisions" && line.provenanceLabel && (
          <span className="block text-[11.5px] font-normal text-ink-mute" data-testid="ebitda-recon-provenance">
            {pickLang(line.provenanceLabel, lang)}
          </span>
        )}
        {refusal && (
          <span className="block text-[11.5px] font-normal text-alert" data-testid="ebitda-recon-refused">
            {refusal}
          </span>
        )}
        {notAnchored && (
          <span className="block text-[11.5px] font-normal text-ink-mute">
            {t("statements.ebitdaRecon.notAnchored")}
          </span>
        )}
      </span>
      <span className="text-right tabular-nums">
        {notAnchored ? "—" : money(line.value, component)}
      </span>
    </li>
  );
}

function CoreRow({
  label,
  value,
  account,
  strong = false,
  testid,
}: {
  label: string;
  value: string;
  account?: string;
  strong?: boolean;
  testid?: string;
}) {
  return (
    <li
      className={`grid grid-cols-[1fr_auto] gap-3 items-baseline py-1 ${strong ? "font-semibold text-ink" : "text-ink-soft"}`}
      data-testid={testid}
    >
      <span>
        {label}
        {account && <span className="ml-1.5 font-mono text-[10px] text-ink-mute">{account}</span>}
      </span>
      <span className="text-right tabular-nums">{value}</span>
    </li>
  );
}
