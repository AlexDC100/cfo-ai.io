// THE ARTIFACTS — 5/8 DOCUMENT. Narrative assembled from the thread.
//
// Prose is the one artifact type where the model's own words ARE the
// content, so this is where the numeral law does its most visible work.
// Every paragraph is a TEMPLATE: figures appear as `{{money:fact}}`
// placeholders naming facts the retrieval returned, and `NarrativeText`
// resolves them through the money path — the same renderer the findings
// use, with the same all-or-nothing refusal. A paragraph naming a fact
// the evidence does not carry does not half-render; it renders the
// stored plain text instead, and if there is none it does not render.
//
// The export is where this gets tested for real. A .docx leaves the
// product and is read where there is no placeholder renderer and no rate
// table, so `documentExportSections` resolves each paragraph to its
// NATIVE-currency rendering before it crosses the wire. A document
// carrying `{{money:revenue}}` into a reader's inbox would be worse than
// one carrying a number, and a document silently converted to a display
// currency with no rate stamped on it would be worse than both.

import { useTranslation } from "react-i18next";

import { NarrativeText, parseNarrativeTemplate } from "@/lib/narrativeMoney";
import { formatMoneyFrom } from "@/lib/money";
import type { Currency, Rates } from "@/lib/rates";

import "./artifactI18n";
import { artifactLabel } from "./artifactI18n";
import type { DocumentSpec } from "./artifactSpec";
import { citationFrom, type ResolvedArtifact } from "./artifactResolve";
import type { CapsuleEvidence } from "@/components/instrument/shell/capsuleAnswer/capsuleAnswerTypes";

/** Unread on this path (see the call site) — never a rate source. */
const IDENTITY_RATES: Rates = { RON: 1, EUR: 1, USD: 1 };

export interface DocumentArtifactProps {
  spec: DocumentSpec;
  evidence: CapsuleEvidence;
}

export function DocumentArtifact({ spec, evidence }: DocumentArtifactProps) {
  const { t } = useTranslation();
  const currency: Currency = evidence.currency ?? "RON";
  return (
    <div data-testid="artifact-document" className="space-y-3">
      {spec.sections.map((section, i) => (
        <section key={i} data-testid="artifact-document-section">
          <h4 className="mb-1 text-[13px] font-semibold text-ink">
            {artifactLabel(t, section.heading)}
          </h4>
          <div className="space-y-1.5 text-[13px] leading-relaxed text-ink-soft">
            {section.paragraphs.map((para, pi) => (
              <p key={pi}>
                <NarrativeText
                  text={para}
                  template={para}
                  facts={evidence.facts}
                  factUnits={evidence.factUnits}
                  sourceCurrency={currency}
                />
              </p>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/**
 * Resolve every paragraph to NATIVE-currency text for the export.
 *
 * Native rather than display, deliberately. The display dial is a
 * SCREEN affordance backed by a rate the screen can name; a file has
 * nowhere to carry that rate, so a converted figure inside it is a
 * number whose basis has been lost. The source currency travels with
 * the document in its citation block instead.
 *
 * A paragraph whose template refuses (an absent fact, an undeclared
 * unit) falls back to the stored text exactly as `NarrativeText` does —
 * one refusal rule, two renderers.
 */
export function documentExportSections(
  spec: DocumentSpec,
  evidence: CapsuleEvidence,
): Array<{ heading: string; paragraphs: string[] }> {
  const currency: Currency = evidence.currency ?? "RON";
  return spec.sections.map((section) => ({
    heading: section.heading,
    paragraphs: section.paragraphs.map((para) => {
      const parts = parseNarrativeTemplate(para, evidence.facts, evidence.factUnits);
      if (!parts) return para;
      return parts
        .map((part) =>
          part.kind === "text"
            ? part.value
            : // from === to, so `convertFromTo` returns the value before it
              // reads the table at all. The identity map below exists to
              // satisfy the signature, NOT to stand in for a real rate —
              // there is no conversion happening on this path.
              formatMoneyFrom(part.value, currency, currency, IDENTITY_RATES, {
                fractionDigits: part.decimals,
              }),
        )
        .join("");
    }),
  }));
}

export function documentFrom(
  spec: DocumentSpec,
  evidence: CapsuleEvidence,
  trust: string | null = null,
): ResolvedArtifact {
  return { spec, citation: citationFrom(evidence, trust), unresolved: [] };
}
