// THE CAPSULE — the Tier-0 preview: an answer that arrives while you type.
//
// Some questions do not need a model, a tool call or a network hop. "What
// is revenue" is a LOOKUP: the fact is already in the period the reader
// has open, already carries its unit, its currency and its provenance,
// and the only work left is to render it. The speed lane resolves those
// locally (`lib/capsuleTier0`); this file is the surface for the result.
//
// ── Why a preview and not an answer ───────────────────────────────────
//
// It renders in the SEARCH state, above the rows, before Enter. The
// reader gets the number without committing to anything, and Enter still
// opens the full canvas with the interpretation, the citation and the
// follow-ups. So this is the fast half of the answer, shown early —
// never a replacement for it.
//
// ── The two rules this surface cannot bend ────────────────────────────
//
// 1. NO MODEL, NO NETWORK. `resolveTier0` is a pure local lookup. Nothing
//    in this file dispatches anything, and the gate that counts network
//    requests per keystroke (C4) is what keeps that true.
// 2. EVERY FIGURE THROUGH THE MONEY PATH. A `FactRef` carries a raw
//    `value` and a DECLARED `unit`. That declaration is the whole point:
//    money goes to `NarrativeText` with a `{{money:…}}` template, and a
//    dimensionless fact goes to `<Amount>` with its own kind. There is no
//    branch here that formats a number itself, and none that decides
//    from a magnitude what a number is.

import { useTranslation } from "react-i18next";

import { Amount } from "@/components/instrument/Amount";
import { formatMoneyFrom } from "@/lib/money";
import { NarrativeText } from "@/lib/narrativeMoney";
import type { Currency, Rates } from "@/lib/rates";
import { plainFor } from "@/lib/glossary";
import type { FactRef } from "@/lib/capsuleFactIndex";
import { NOTE_DEFINITION, type Tier0Answer } from "@/lib/capsuleTier0";

import "./capsuleAnswerI18n";
import { hasCopy, metricLabel } from "./capsuleAnswerI18n";

/** One fact, rendered through whichever path its DECLARED unit names. */
function Tier0Value({ fact, className }: { fact: FactRef; className?: string }) {
  if (fact.unit !== "money") {
    const kind =
      fact.unit === "percent" ? "percent" : fact.unit === "ratio" ? "multiple" : "count";
    return (
      <Amount
        value={fact.value}
        kind={kind}
        provenance={
          fact.provenance || fact.periodLabel
            ? { source: fact.periodLabel || fact.provenance?.docId }
            : undefined
        }
        className={className}
      />
    );
  }

  // Money renders through the SAME renderer the prose and the figure
  // list use, bound to a one-entry facts map. The alternative — calling
  // a formatter here — would give this surface its own spelling of a
  // number the canvas below is about to spell differently.
  const currency = (fact.currency ?? "RON") as Currency;
  return (
    <NarrativeText
      // Same fallback text the figure list builds, for the same reason:
      // when no rate exists the renderer refuses the conversion and
      // falls back to NATIVE — and the native spelling has to already
      // be the right one, not an empty string.
      text={formatMoneyFrom(fact.value, currency, currency, {} as Rates, { fractionDigits: 2 })}
      template={`{{money:${fact.factKey}}}`}
      facts={{ [fact.factKey]: fact.value }}
      factUnits={{ [fact.factKey]: "money" }}
      sourceCurrency={currency}
      className={className}
    />
  );
}

/**
 * The resolver's note key → copy, or NOTHING.
 *
 * Two guards, both of which fired on real output in the r2 loop:
 *
 * 1. NO COPY → no note. The resolver is allowed to grow notes ahead of
 *    this bundle, and a key on screen is worse than silence.
 * 2. NO UNRESOLVED PLACEHOLDER. `capsuleTier0.note.absent` interpolates
 *    `{{metric}}`, and a refusal that arrives without that param
 *    rendered the literal string "No figure for {{metric}} in this
 *    period" into the surface. Braces on screen are the same defect
 *    class as a half-arrived `{{money:…}}` — the answer lane refuses to
 *    paint one, and so does this.
 *
 * The metric param is a FACT KEY (`revenue`), so it is resolved through
 * the same `metricLabel` the figure list uses. Otherwise the refusal
 * says "No figure for net_result", naming an engine identifier at a
 * reader.
 */
function resolveNote(
  t: (key: string, opts?: Record<string, unknown>) => string,
  lang: string,
  answer: Tier0Answer,
): string | null {
  if (!answer.note || !hasCopy(answer.note)) return null;
  const params: Record<string, string> = { ...(answer.noteParams ?? {}) };

  // A metric param is a FACT KEY (`net_result`). It goes through the
  // same resolver the figure list uses, so the refusal and the figures
  // can never call one metric two names.
  if (params.metric) params.metric = metricLabel(t, params.metric, params.metric);

  // A DEFINITION's answer is the glossary's own reviewed sentence, in
  // the reader's language. This lane frames it; it does not rewrite it —
  // `lib/glossary` owns that copy in both languages and is the only
  // place it should exist. An id with no entry yields no note.
  if (answer.note === NOTE_DEFINITION) {
    const plain = params.glossaryId ? plainFor(params.glossaryId, lang) : null;
    if (!plain) return null;
    params.definition = plain;
  }

  const text = t(answer.note, params);
  if (!text || text.includes("{{")) return null;
  return text;
}

export interface CapsuleTier0PreviewProps {
  answer: Tier0Answer | null;
  /** Open the full canvas on this question. */
  onOpen: () => void;
}

/** Renders nothing when there is no Tier-0 resolution — which is the
 *  common case, and is why this component may never own a heading of its
 *  own that would flash on every keystroke. */
export function CapsuleTier0Preview({ answer, onOpen }: CapsuleTier0PreviewProps) {
  const { t, i18n } = useTranslation();
  if (!answer) return null;

  const note = resolveNote(t, i18n.language ?? "en", answer);

  // A REFUSAL IS AN ANSWER, and it is the one the reader most needs
  // before they spend a question: "only one period is loaded" is why the
  // comparison they are typing cannot be made. It renders as a statement,
  // not a button — there is nothing to open.
  if (answer.refused || answer.facts.length === 0) {
    if (!note) return null;
    return (
      <div
        data-testid="capsule-tier0"
        data-kind={answer.kind}
        data-refused="true"
        className="border-b border-rule-soft px-4 py-2.5 text-[12px] leading-relaxed text-ink-soft"
      >
        {note}
      </div>
    );
  }

  const facts = answer.facts.slice(0, 2);
  const lead = facts[0];

  return (
    <button
      type="button"
      data-testid="capsule-tier0"
      data-kind={answer.kind}
      onClick={onOpen}
      className="
        flex w-full items-center gap-3 border-b border-rule-soft px-4 py-2.5
        text-left transition-colors duration-micro hover:bg-bg-2/60
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset
        focus-visible:ring-ring
      "
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-[10px] font-medium uppercase tracking-[0.14em] text-ink-soft">
          {metricLabel(t, lead.factKey, lead.label)}
          {/* Full `ink-soft`, not `ink-soft/70` — see CapsuleFactCard:
              the same label at 70% measures below AA on the glass. */}
          {lead.periodLabel && (
            <span className="text-ink-soft"> · {lead.periodLabel}</span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2.5">
          {facts.map((f) => (
            // `data-fact` for the same reason the fact card carries it:
            // a dimensionless figure renders as a bare span, and C3
            // walks the DOM looking for an ancestor that names the fact.
            <span key={`${f.factKey}:${f.periodId}`} data-fact={f.factKey}>
              <Tier0Value fact={f} className="text-[17px] leading-none text-ink" />
            </span>
          ))}
          {/* The delta is the resolver's own number. This file does not
              subtract two facts to produce one — a client-side delta on
              possibly-converted operands is the defect the native-unit
              rule exists to prevent. */}
          {typeof answer.deltaPct === "number" && Number.isFinite(answer.deltaPct) && (
            <Amount
              value={answer.deltaPct}
              kind="percent"
              className="text-[12px] text-ink-soft"
            />
          )}
        </div>
        {note && (
          <div className="mt-0.5 truncate text-[11px] text-ink-soft">{note}</div>
        )}
      </div>
      <span className="shrink-0 text-[10.5px] uppercase tracking-[0.12em] text-ink-soft">
        {t("capsuleAnswer.tier0.open")}
      </span>
    </button>
  );
}
