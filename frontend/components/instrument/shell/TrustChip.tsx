// THE INSTRUMENT — TrustChip: the header's balance-verdict chip.
//
// Reads the SERVED envelope through lib/servedFacts (the one sanctioned
// gateway) and words the verdict with the engine's own presenter output.
// Nothing here recomputes or invents: no canonical envelope on the active
// period means NO chip — an unverified period must not wear a trust badge.
//
//   BALANCED            → success  "Balanced · machine-computed"
//   BALANCED + AI-read  → accent   "AI-read · verified"
//   RECONCILED          → caution  "Reconciled · auto-adjusted"
//   MINOR_DRIFT         → caution  (presenter wording)
//   MATERIAL_IMBALANCE  → alert    (presenter wording)
//
// Click opens the receipt sheet: the status detail the payload already
// carries (difference, mapping version, extraction lane, reconciliation
// receipt, diagnosis codes) — listed verbatim, row by row.

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import "./shellI18n";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";
import { Chip, type ChipTone } from "@/components/instrument/Panel";
import { Amount } from "@/components/instrument/Amount";
import { useActivePeriod } from "@/lib/activePeriod";
import { factsFrom, type ServedFacts } from "@/lib/servedFacts";

/** Tone -> dot colour. Mirrors the Chip tones so the dot and the
 *  receipt's chip can never disagree. */
const TONE_DOT: Record<ChipTone, string> = {
  neutral: "text-ink-mute",
  accent: "text-brand-d dark:text-brand-l",
  success: "text-success",
  caution: "text-caution",
  alert: "text-alert",
  info: "text-info",
};

export function TrustChip({ variant = "chip" }: { variant?: "chip" | "dot" } = {}) {
  const { t, i18n } = useTranslation();
  const period = useActivePeriod();
  const [open, setOpen] = useState(false);

  const facts: ServedFacts | null = useMemo(
    () => (period.statements ? factsFrom(period.statements) : null),
    [period.statements],
  );

  // No period, no envelope, or a legacy/public-summary lane → no chip.
  // Trust renders only where the engine actually issued a verdict.
  if (!facts || !facts.isCanonical) return null;

  const currency = period.statements?.currency ?? "RON";
  const presentation = facts.presentStatus(currency);
  const isRo = (i18n.language ?? "en").toLowerCase().startsWith("ro");
  const statusWord = isRo ? presentation.displayRo : presentation.displayEn;

  const extraction = facts.canonicalForRender()?.extraction ?? null;
  const aiRead = extraction?.method === "llm";

  let tone: ChipTone;
  let label: string;
  switch (presentation.band) {
    case "material_imbalance":
      tone = "alert";
      label = statusWord;
      break;
    case "reconciled":
      tone = "caution";
      label = `${statusWord} · ${t("shell.trust.suffixReconciled")}`;
      break;
    case "needs_review":
    case "minor_drift":
      tone = "caution";
      label = statusWord;
      break;
    case "balanced":
      if (aiRead) {
        tone = "accent";
        label = `${t("shell.trust.aiRead")} · ${t("shell.trust.suffixAiRead")}`;
      } else {
        tone = "success";
        label = `${statusWord} · ${t("shell.trust.suffixBalanced")}`;
      }
      break;
    default:
      // "unverified" cannot occur on the canonical lane; refuse to badge it.
      return null;
  }

  const rec = facts.reconciliation();
  const diagnosis = facts.diagnosis();

  return (
    <>
      {variant === "dot" ? (
        // CAPSULE DOT (2026-08-30): the verdict as a 7px dot, no text —
        // the full sentence rides aria-label so the information is not
        // lost, only the header real estate. Same receipt sheet below:
        // trust parity is structural here, never re-worded.
        //
        // ── THE `title` IS GONE, AND THIS ONE WAS A JUDGEMENT CALL ────
        //
        // It was flagged as "arguably deliberate", and the argument for
        // keeping it is real: this is an icon-only control, and its
        // tooltip was the only thing telling a sighted mouse user with no
        // screen reader what a coloured dot means. Removed anyway, for
        // three reasons stated so the next person can reverse it on
        // purpose rather than by accident:
        //
        //   1. The rule the owner set is ZERO, in every state. A rule
        //      with one exemption needs a list of exempt sites, and a
        //      list is what let the category column survive the round
        //      that removed it — the exemption ("it is identity, not
        //      category") was applied by hand, per row, and got it wrong.
        //   2. The string is a VERBATIM duplicate of `aria-label`. A
        //      `title` that differs from the accessible name is at least
        //      carrying something; this one renders the same sentence
        //      twice, once after a delay the design does not control.
        //   3. Nothing is lost that the surface does not already say.
        //      Clicking the dot opens the receipt, which states the
        //      verdict in full; and the Capsule's own context strip
        //      prints the verdict as a WORD, one keystroke away, which is
        //      strictly better than a tooltip that no touch device and no
        //      keyboard can reach.
        //
        // If the dot needs a hover affordance, it needs a real one — a
        // styled tooltip that works on focus as well as hover. That is a
        // component, not an attribute, and it is not this lane's to add.
        <button
          type="button"
          data-testid="trust-dot"
          aria-label={label}
          onClick={(e) => { e.stopPropagation(); setOpen(true); }}
          className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${TONE_DOT[tone]}`}
        >
          <span aria-hidden className="h-[7px] w-[7px] rounded-full bg-current" />
        </button>
      ) : (
        <button
          type="button"
          data-testid="trust-chip"
          aria-label={t("shell.trust.openReceipt")}
          onClick={() => setOpen(true)}
          className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-full"
        >
          <Chip tone={tone} dot className="cursor-pointer whitespace-nowrap">
            {label}
          </Chip>
        </button>
      )}

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          data-testid="trust-receipt"
          className="w-[min(400px,calc(100vw-2rem))] border-l border-rule bg-surface p-0 text-ink"
        >
          <div className="border-b border-rule-soft px-5 pb-4 pt-5">
            <SheetTitle className="text-[15px] font-semibold tracking-tight text-ink">
              {t("shell.trust.receiptTitle")}
            </SheetTitle>
            <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">
              {t("shell.trust.receiptSubtitle")}
            </p>
            <div className="mt-3">
              <Chip tone={tone} dot>{label}</Chip>
            </div>
          </div>

          <div className="overflow-y-auto px-5 py-4">
            <dl className="space-y-0">
              <ReceiptRow label={t("shell.trust.status")}>
                <span className="font-mono text-[11.5px] uppercase tracking-[0.08em]">
                  {presentation.machineStatus}
                </span>
              </ReceiptRow>
              <ReceiptRow label={t("shell.trust.difference")}>
                <Amount value={facts.difference()} kind="money" currency={currency} className="text-[12.5px]" />
              </ReceiptRow>
              {facts.mappingVersion() && (
                <ReceiptRow label={t("shell.trust.mapping")}>
                  <span className="font-mono text-[11.5px]">{facts.mappingVersion()}</span>
                </ReceiptRow>
              )}
              {extraction && (
                <ReceiptRow label={t("shell.trust.extraction")}>
                  <span className="font-mono text-[11.5px]">{extraction.method}</span>
                </ReceiptRow>
              )}
              {extraction?.model && (
                <ReceiptRow label={t("shell.trust.model")}>
                  <span className="font-mono text-[11.5px] break-all">{extraction.model}</span>
                </ReceiptRow>
              )}
            </dl>

            {rec && (
              <div className="mt-5">
                <h3 className="mb-1 text-[10px] font-medium uppercase tracking-[0.14em] text-ink-mute">
                  {t("shell.trust.reconciliation")}
                </h3>
                <dl>
                  {typeof rec.original_difference === "number" && (
                    <ReceiptRow label={t("shell.trust.originalDifference")}>
                      <Amount value={rec.original_difference} kind="money" currency={currency} className="text-[12.5px]" />
                    </ReceiptRow>
                  )}
                  {typeof rec.applied_delta === "number" && (
                    <ReceiptRow label={t("shell.trust.appliedDelta")}>
                      <Amount value={rec.applied_delta} kind="money" currency={currency} signed className="text-[12.5px]" />
                    </ReceiptRow>
                  )}
                  {rec.placement && (
                    <ReceiptRow label={t("shell.trust.placement")}>
                      {rec.placement === "pnl"
                        ? t("shell.trust.placementPnl")
                        : t("shell.trust.placementBs")}
                    </ReceiptRow>
                  )}
                  {rec.origin && (
                    <ReceiptRow label={t("shell.trust.origin")}>
                      {rec.origin === "llm_proposed"
                        ? t("shell.trust.originLlm")
                        : t("shell.trust.originDeterministic")}
                    </ReceiptRow>
                  )}
                  {rec.applied_at && (
                    <ReceiptRow label={t("shell.trust.appliedAt")}>
                      <span className="font-mono text-[11.5px]">{rec.applied_at}</span>
                    </ReceiptRow>
                  )}
                  {rec.rationale && (
                    <p className="mt-2 text-[12px] leading-relaxed text-ink-soft">
                      {rec.rationale}
                    </p>
                  )}
                </dl>
              </div>
            )}

            {diagnosis.length > 0 && (
              <div className="mt-5">
                <h3 className="mb-1 text-[10px] font-medium uppercase tracking-[0.14em] text-ink-mute">
                  {t("shell.trust.diagnosis")}
                </h3>
                <ul className="space-y-1.5">
                  {diagnosis.map((d) => (
                    <li key={d.code} className="text-[12px] leading-relaxed text-ink-soft">
                      <span className="font-mono text-[11px] text-ink">{d.code}</span>
                      {" — "}
                      {d.detail}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {presentation.exportDetail && (
              <p className="mt-5 border-t border-rule-soft pt-3 text-[11.5px] leading-relaxed text-ink-mute">
                {presentation.exportDetail}
              </p>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

function ReceiptRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-rule-soft py-2 last:border-b-0">
      <dt className="shrink-0 text-[12px] text-ink-soft">{label}</dt>
      <dd className="min-w-0 text-right text-[12.5px] text-ink">{children}</dd>
    </div>
  );
}
