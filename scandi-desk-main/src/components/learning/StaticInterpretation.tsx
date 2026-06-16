// LEARN-FIX-1 follow-on (2026-06-13) — Static, composition-anchored
// interpretation block. Renders a 1-2 sentence "What it means" line
// directly above the Ask CFO AI footer, anchored to the dominant
// account's share. No backend Opus call — every popover gets an
// interpretation even when network / auth is unavailable. Future
// LEARN-FIX-2 may add an Opus-augmented variant; this primitive is
// the always-available baseline.
//
// Design:
//   · "Sparkle" leading icon (teal accent) so the block reads as
//     "insight" not "metadata"
//   · Background tint at the same teal hue as the rest of the
//     learning surfaces (consistent with LearningCoach + footer)
//   · Single short sentence — never longer than 35 words; that's
//     enforced by the template strings below, not the runtime.
//   · No interactive elements — this is a passive read.

import { Sparkles } from "lucide-react";
import type { ResolvedSourceAccount } from "@/lib/learning/sourceAccountMap";

interface Props {
  conceptKey: string;
  /** Composition rows for the active period, sorted descending. Must
   *  already be filtered + share-computed. */
  accounts: ResolvedSourceAccount[];
  locale?: "en" | "ro";
}

interface TemplateInput {
  /** Top contributor (largest magnitude). */
  top: ResolvedSourceAccount;
  /** Second-largest, when present. */
  second?: ResolvedSourceAccount;
  /** Top share as decimal (0..1). */
  topShare: number;
  /** Count of populated accounts. */
  populated: number;
}

/** Render-side templates per concept. Each returns a 1-2 sentence
 *  interpretation in the requested locale. Returns null when the
 *  composition is too thin to interpret (e.g. only one populated
 *  account) so the component can collapse rather than render a
 *  vacuous line. */
type Template = (input: TemplateInput, locale: "en" | "ro") => string | null;

const TEMPLATES: Record<string, Template> = {
  revenue: revenueTemplate,
  operating_revenue: revenueTemplate,
  cogs: cogsTemplate,
  operating_expenses: opexTemplate,
  cash: cashTemplate,
  total_debt: debtTemplate,
  short_term_debt: debtTemplate,
  long_term_debt: debtTemplate,
  inventory: inventoryTemplate,
  receivables: receivablesTemplate,
  ppe: ppeTemplate,
};

function pct(share: number): string {
  return `${(share * 100).toFixed(0)}%`;
}

function shortLabel(acc: ResolvedSourceAccount): string {
  // Use the first 4 words to keep templated sentences within budget.
  return acc.label.split(" ").slice(0, 4).join(" ").replace(/[(),.]$/, "");
}

function revenueTemplate(
  { top, second, topShare, populated }: TemplateInput,
  locale: "en" | "ro",
): string | null {
  if (populated < 2) return null;
  const dominant = topShare >= 0.6;
  if (locale === "ro") {
    return dominant
      ? `Veniturile sunt concentrate în ${shortLabel(top)} (${pct(topShare)}) — puterea de preț pe această linie contează cel mai mult.`
      : `Mix echilibrat: ${shortLabel(top)} (${pct(topShare)}) și ${shortLabel(second!)} sunt cele două surse principale.`;
  }
  return dominant
    ? `Revenue is concentrated in ${shortLabel(top)} (${pct(topShare)}) — pricing power on that line matters most.`
    : `Balanced mix: ${shortLabel(top)} at ${pct(topShare)} leads, with ${shortLabel(second!)} as the second line.`;
}

function cogsTemplate(
  { top, topShare, populated }: TemplateInput,
  locale: "en" | "ro",
): string | null {
  if (populated < 1) return null;
  if (locale === "ro") {
    return `${shortLabel(top)} reprezintă ${pct(topShare)} din cost — expunerea la prețuri input urmărește această linie.`;
  }
  return `${shortLabel(top)} is ${pct(topShare)} of cost — input-price exposure tracks this line.`;
}

function opexTemplate(
  { top, topShare, populated }: TemplateInput,
  locale: "en" | "ro",
): string | null {
  if (populated < 2) return null;
  if (locale === "ro") {
    return `${shortLabel(top)} (${pct(topShare)}) este principala categorie de costuri operaționale — orice levă de eficiență începe aici.`;
  }
  return `${shortLabel(top)} (${pct(topShare)}) is the largest operating-cost bucket — any efficiency lever starts here.`;
}

function cashTemplate(
  { top, topShare, populated }: TemplateInput,
  locale: "en" | "ro",
): string | null {
  if (populated === 0) return null;
  if (locale === "ro") {
    return `${pct(topShare)} din numerar este în ${shortLabel(top)} — verifică expunerea valutară și termenii bancari.`;
  }
  return `${pct(topShare)} of cash sits in ${shortLabel(top)} — check FX exposure and banking terms.`;
}

function debtTemplate(
  { top, topShare, populated }: TemplateInput,
  locale: "en" | "ro",
): string | null {
  if (populated === 0) return null;
  if (locale === "ro") {
    return `Datoria este dominată de ${shortLabel(top)} (${pct(topShare)}) — covenants și scadențele acestei linii determină profilul de risc.`;
  }
  return `Debt is dominated by ${shortLabel(top)} (${pct(topShare)}) — covenants and maturities on this line drive the risk profile.`;
}

function inventoryTemplate(
  { top, topShare, populated }: TemplateInput,
  locale: "en" | "ro",
): string | null {
  if (populated === 0) return null;
  if (locale === "ro") {
    return `${shortLabel(top)} reprezintă ${pct(topShare)} din stoc — DIO și provizioanele se concentrează aici.`;
  }
  return `${shortLabel(top)} is ${pct(topShare)} of inventory — DIO and provisioning focus here.`;
}

function receivablesTemplate(
  { top, topShare, populated }: TemplateInput,
  locale: "en" | "ro",
): string | null {
  if (populated === 0) return null;
  if (locale === "ro") {
    return `${pct(topShare)} din creanțe stă în ${shortLabel(top)} — concentrarea de clienți și ageing-ul sunt critice.`;
  }
  return `${pct(topShare)} of receivables sits in ${shortLabel(top)} — customer concentration and ageing matter.`;
}

function ppeTemplate(
  { top, topShare, populated }: TemplateInput,
  locale: "en" | "ro",
): string | null {
  if (populated === 0) return null;
  if (locale === "ro") {
    return `${shortLabel(top)} (${pct(topShare)}) este principala clasă de active fixe — planurile de capex se ancorează aici.`;
  }
  return `${shortLabel(top)} (${pct(topShare)}) is the largest fixed-asset class — capex plans anchor here.`;
}

export function StaticInterpretation({ conceptKey, accounts, locale = "en" }: Props) {
  const tmpl = TEMPLATES[conceptKey];
  if (!tmpl) return null;

  // Filter to the populated-positive cohort for the template input.
  const positives = accounts.filter((a) => a.amount > 0);
  if (positives.length === 0) return null;
  const [top, second] = positives;
  const topShare = top.share ?? 0;

  const sentence = tmpl(
    { top, second, topShare, populated: positives.length },
    locale,
  );
  if (!sentence) return null;

  return (
    <div
      data-testid="static-interpretation"
      className="px-5 py-4 border-b border-white/[0.06] bg-[hsl(165,75%,55%)]/[0.04]"
    >
      <div className="flex items-start gap-2.5">
        <Sparkles className="w-3.5 h-3.5 text-[hsl(165,80%,45%)] flex-shrink-0 mt-0.5" />
        <p className="text-[13px] leading-relaxed text-white/85">
          {sentence}
        </p>
      </div>
    </div>
  );
}
