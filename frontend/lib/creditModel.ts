// creditModel.ts — THE BAND-SENTENCE COMPOSER, AND NOTHING ELSE.
//
// A LEAF MODULE ON PURPOSE. `financialReport.ts` renders the printed
// board pack and must spell the same ladder the reader banded with, but
// `financialValuation.ts` imports values FROM `financialReport.ts`, so a
// value import back would be a runtime cycle (the type-only import at the
// top of that file says exactly this). Both files therefore import the
// spelling from here, which imports nothing. One spelling of a band
// table, reachable from every surface without a cycle.

export type CreditModelId = "engine-canonical-v1" | "client-fallback-v1";

// ── NO CUTOFF IS EVER WRITTEN AS PROSE ─────────────────────────────
//
// ⚠ THE REPLICA LADDER THAT WAS DELETED FROM THE CODE SURVIVED AS A
// SENTENCE, AND THIS PROGRAMME MADE IT WORSE. `CREDIT_MODEL_LABEL` was a
// frozen `Record<CreditModelId, string>` reading "AAA≥90 … CC<25", and
// the engine caveat below it spelled the whole F1.h ladder out longhand
// ("AAA ≥ 90, AA ≥ 80, A ≥ 70, BBB ≥ 60, BB ≥ 50, B ≥ 40, CCC ≥ 25,
// CC < 25"). Both are band tables; neither moved when the engine
// re-banded. Measured on the real Scandia envelope with the gate's own
// re-band plant applied, read back out of the PRODUCED document bytes:
//
//   data-report-credit-ladder  "… B ≥ 20 · CCC ≥ 10 · CC ≥ 0"   MOVED
//   credit.modelLabel          "… AAA≥90 … CC<25"               FROZEN
//   credit.caveat              "… B ≥ 40, CCC ≥ 25, CC < 25 …"  FROZEN
//
// three claims within three lines of one another, in one section: the
// letter is B, the ladder puts B at 20, and two lines later B is at 40.
// The workbook carried the frozen sentence on TWO sheets. It printed in
// MORE places than the deleted replica ever did, because this programme
// made the model sentence mandatory beside every letter on every
// surface — a correct rule applied to a frozen string multiplies it.
//
// The rule now: A SENTENCE THAT NAMES A CUTOFF IS COMPOSED FROM THE SAME
// ARRAY THE LETTER WAS BANDED WITH. `spellLadder` is the only spelling of
// a band table in this product, and `creditModelLabel` / `creditCaveat`
// are the only two sentences that carry one, so a re-band moves the words
// on the same render as the number.

/** The model's NAME — the one part of the sentence that is a constant,
 *  because it names an AUTHORITY, not a cutoff. */
export const CREDIT_MODEL_NAME: Record<CreditModelId, string> = {
  "engine-canonical-v1": "Engine canonical model",
  "client-fallback-v1": "Client fallback model",
};

/** THE spelling of a band ladder. Highest band first, so the sentence
 *  reads in the same direction the reader scans. NULL — never a default
 *  ladder — when the authority shipped none. */
export function spellLadder(
  bands: Array<{ min: number; grade: string }> | null | undefined,
): string | null {
  if (!Array.isArray(bands) || bands.length === 0) return null;
  const clean = bands.filter(
    (b) => typeof b?.min === "number" && Number.isFinite(b.min) && typeof b?.grade === "string",
  );
  if (clean.length === 0) return null;
  return clean
    .slice()
    .sort((a, b) => b.min - a.min)
    .map((b) => `${b.grade} ≥ ${b.min}`)
    .join(" · ");
}

/** THE spelling of a weight vector — composed from the weights the
 *  components were actually scored with, in their own order, so a
 *  re-weight moves the sentence exactly as a re-band does. NULL when any
 *  component carries no weight (a partial vector is not a vector). */
export function spellWeights(
  components: ReadonlyArray<{ weight: number | null }>,
): string | null {
  if (components.length === 0) return null;
  if (components.some((c) => c.weight === null || !Number.isFinite(c.weight))) return null;
  return components.map((c) => Math.round((c.weight as number) * 100)).join("/");
}

/** The sentence that travels WITH the letter on every surface that
 *  prints one — composed, never frozen. A reader must never have to know
 *  which fields arrived in order to know which model answered, and must
 *  never be shown a ladder the letter was not banded with. */
export function creditModelLabel(
  model: CreditModelId,
  bands: Array<{ min: number; grade: string }> | null,
  components: ReadonlyArray<{ weight: number | null }>,
): string {
  const parts = [CREDIT_MODEL_NAME[model]];
  const w = spellWeights(components);
  if (w) parts.push(`weights ${w}`);
  const ladder = spellLadder(bands);
  parts.push(ladder ? `ladder ${ladder}` : "no band ladder reported for this period");
  const s = parts.join(" · ");
  return model === "client-fallback-v1"
    ? `${s} — no engine credit envelope for this period`
    : s;
}

/** The long-form methodology note, composed from the SAME two inputs as
 *  the label above. It used to spell the locked F1.h ladder longhand and
 *  therefore contradicted the letter beside it on any re-band. */
export function creditCaveat(
  model: CreditModelId,
  bands: Array<{ min: number; grade: string }> | null,
  components: ReadonlyArray<{ weight: number | null }>,
  altmanVariant: string,
): string {
  const w = spellWeights(components);
  const ladder = spellLadder(bands);
  const ladderSentence = ladder
    ? `The letter grade is banded with the ladder this model reported for this period: ${ladder}.`
    : "This model reported no band ladder for this period, so no letter is minted here.";
  const notARating =
    "This is a quantitative model output, not a regulated credit rating. A formal lender " +
    "internal rating or BNR-supervised model may weight other factors (sector outlook, " +
    "management quality, parent-group support, ESG) and produce a different result — a " +
    "defensible analytical anchor for lender conversations, not a substitute for a formal " +
    "rating opinion.";
  if (model === "engine-canonical-v1") {
    return (
      `Engine canonical credit score (Romanian SME calibration). Weighted composite` +
      `${w ? ` (${w})` : ""} with Altman ${altmanVariant} as the dominant signal. ` +
      `${ladderSentence} ${notARating}`
    );
  }
  return (
    `Scored by the CLIENT FALLBACK model${w ? ` (${w})` : ""} because no engine credit ` +
    `envelope was available for this period. ${ladderSentence} The engine's own model uses ` +
    `different weights and a different band ladder and can produce a different letter for ` +
    `the same company. ${notARating}`
  );
}


/** Z" zone thresholds (locked — single variant). ONE object: both Altman
 *  readers, every zone word, the printed benchmark line and the ratio
 *  drawer's explanation all read it, so a threshold cannot be applied two
 *  ways or explained with a third number. */
export const ALTMAN_ZPP_THRESHOLDS_SHARED = { safe: 2.6, distress: 1.1 };
