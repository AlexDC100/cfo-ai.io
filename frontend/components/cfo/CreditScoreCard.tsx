// Credit Score Card — surfaces the deterministic Altman Z″ + composite
// 0-100 score + letter grade computed server-side in `stage_compute`
// (see src/engine/api/pipeline.py — Stage 2 of the build plan).
//
// This card is the single trust signal on the Dashboard / Report header
// that says "we ran the numbers, here's the grade." It DOES NOT do its
// own arithmetic — the backend is the source of truth.
//
// ⚠ THE LINE ABOVE USED TO END "…The FE only maps the composite to a
// letter grade for display consistency." That sentence was the defect,
// written down as if it were a design: mapping a composite to a LETTER
// is not display, it is the verdict, and doing it here made this card a
// second scoring model that drifted from the engine's the moment the
// engine re-banded. The card maps NOTHING now — it reads the engine's
// `letter_grade` / `letter_grade_bands`, and where the engine did not
// speak it says so.
//
// Inputs come from `calculated_metrics` rows persisted by stage_compute:
//   credit_composite              0-100 score
//   altman_z_score                raw Z″ value
//   altman_x1..x4                 Z″ components
//   credit_subscore_*             7 weighted sub-scores
//
// Renders three blocks:
//   1. Big composite + grade (the headline)
//   2. Altman Z″ value + zone (safe / grey / distress)
//   3. Component breakdown (sub-scores as horizontal bars)

import { formatRON } from "@/lib/formatRon";
import { LearnableNumber } from "@/components/learning/LearnableNumber";
import {
  altmanZoneOf,
  engineCreditResult,
  spellLadder,
  type CreditEnvelope,
  type CreditModelId,
  type CreditScoreResult,
} from "@/lib/financialValuation";

export interface CreditScoreData {
  composite: number;          // 0-100
  altmanZ: number;            // raw Z″
  // ── THE LETTER, AND WHO MINTED IT ───────────────────────────────────
  //
  // ⚠ THIS CARD USED TO MINT ITS OWN. `compositeToGrade()` was a
  // hardcoded copy of the engine's F1.h band table living in this file;
  // the card banded `calculated_metrics.credit_composite` with it and
  // never read `assembled_metrics.credit.letter_grade` or the
  // envelope's own `letter_grade_bands`. Measured in the DOM on the real
  // Scandia period, same app, same period, with the engine re-banded to
  // letter_grade "B" and shipping its own ladder:
  //
  //     /dashboard Risks tab · hero · workbook   B
  //     /report Section 7                        CC
  //
  // and with the engine's credit envelope absent entirely, the Risks tab
  // printed CCC (naming `client-fallback-v1`) against this card's CC
  // (naming nothing at all). A replica ladder is a second model by
  // another name. The replica is gone: the letter now comes from the
  // engine's envelope or it does not come.
  /** NULL when the engine's credit envelope carried neither a letter nor
   *  a ladder — including the case where the engine spoke only through
   *  `calculated_metrics`, which carries no band table at all. A letter
   *  is never invented from a frontend band table. */
  letter: string | null;
  /** Which model minted the figures on this card. NULL only when there is
   *  no card. It is NOT null-when-`letter`-is: the engine can state a
   *  composite and a Z" for a period it shipped no ladder for, and that
   *  period still has a named model — naming none was the F2 defect. */
  model: CreditModelId | null;
  /** `creditModelLabel(model, ladder, components)` off the shared
   *  reader — the sentence that travels with the letter on every surface
   *  that prints one, COMPOSED from the same ladder shown beside it.
   *  It used to be a frozen constant reading "AAA≥90 … CC<25" and
   *  therefore contradicted the ladder on any re-band. */
  modelLabel: string | null;
  /** Which field of the engine's envelope the letter came out of, so the
   *  DOM says whether the engine stated it or the ladder banded it. */
  letterSource: "letter_grade" | "letter_grade_bands" | "absent";
  /** The ENGINE'S OWN ladder, when it sent one. Rendered, so a re-band
   *  is visible on the page and not only inside the letter. */
  ladder: Array<{ min: number; grade: string }> | null;
  /** Z″ components. NULL when `calculated_metrics` did not carry the row
   *  — an unmeasured component is not a component of 0.00. */
  altmanX1: number | null;
  altmanX2: number | null;
  altmanX3: number | null;
  altmanX4: number | null;
  /** The seven weighted sub-scores, 0-100 each.
   *
   *  ⚠ ABSENT-CAPABLE, and this is the whole point. They were read as
   *  `metrics.credit_subscore_* ?? 0` and rendered as
   *  `<ScoreBar value={0} weight={30}/>` — an empty red bar reading
   *  "0" against a 30% weight. Zero is the WORST POSSIBLE SCORE on this
   *  scale, so a subscore the engine never emitted was painted as the
   *  worst reading a company can get on it, in the same red the genuinely
   *  distressed band uses, on the card whose entire job is to be a trust
   *  signal. `null` renders as a stated absence with no bar and no
   *  number. */
  subscores: {
    altman: number | null;
    profitability: number | null;
    leverage: number | null;
    coverage: number | null;
    dscr: number | null;
    liquidity: number | null;
    equity: number | null;
  };
}

// ── `compositeToGrade()` LIVED HERE AND IS DELETED ──────────────────
//
// It was a hardcoded mirror of `_composite_to_letter_grade` in
// src/engine/api/pipeline.py, kept in sync by a comment ("The FE's
// compositeToGrade() in CreditScoreCard.tsx MUST mirror these exact
// bands"). A comment is not a mechanism: the engine ships its ladder on
// every period as `assembled_metrics.credit.letter_grade_bands`, so the
// card can READ the ladder instead of copying it, and a re-band moves
// this surface on the same deploy as every other one. The mapping lives
// in `engineLetterGrade` / `letterFromEngineBands` in
// lib/financialValuation.ts — the same functions `computeCreditScore`
// calls, so the Risks tab, the hero, the workbook and this card cannot
// mint different letters from one envelope.

/** The sentence a reader gets INSTEAD of a letter. No engine envelope
 *  means no engine ladder, and this card mints nothing of its own. It
 *  deliberately carries no digits — the absence is a sentence, not a
 *  score. */
const LETTER_ABSENT_NOTE =
  "Letter grade not reported for this period — the model that produced the figures above " +
  "shipped no band ladder for it. The grade is minted only by that model's own ladder, " +
  "never by this page.";

/** A Z″ component, or the stated absence. Never "0.00" for a row the
 *  engine did not emit. */
function fmtComponent(v: number | null): string {
  return v === null ? "not reported" : v.toFixed(2);
}

/** Map Z″ to the 3 zones from the methodology — by DELEGATION.
 *
 *  ⚠ THIS WAS A FOURTH LADDER, AND IT DISAGREED. It read
 *  `z >= 2.60 → safe; z >= 1.10 → grey`, while `zoneFor` in
 *  lib/financialValuation.ts — the mapping behind the Risks tab's zone
 *  chip, the credit component row's sentence and the workbook — uses
 *  `>`, per Appendix A (`Z" > 2.60 → SAFE`, `1.10 ≤ Z" ≤ 2.60 → GREY`).
 *  Measured across the boundaries:
 *
 *      Z" = 2.60 exactly   /report "Safe"    Risks tab "Grey"
 *      Z" = 1.10 exactly   /report "Grey"    Risks tab "Distress"
 *
 *  Two words for one company on the two values where the word carries
 *  the most weight, and the copy of the ladder was the one that was
 *  wrong. It now calls the original. */
export function altmanZone(z: number): "safe" | "grey" | "distress" {
  // `altmanZoneOf` refuses a non-finite score; this reader is only ever
  // handed the finite `credit_composite`-gated Z" from the map above,
  // and a non-finite one is treated as the worst case rather than
  // silently painted safe.
  return altmanZoneOf(z) ?? "distress";
}

/** THE CARD, AS A PROJECTION OF THE ONE READER — no arithmetic, no
 *  precedence, no ladder and no refusal rule of its own.
 *
 *  ⚠ THIS FILE HELD A SECOND READER UNTIL F2. `readCreditFromMetrics`
 *  had its own `pick(calculated_metrics, envelope)` precedence, its own
 *  "no envelope ⇒ no model" rule, and its own "composite or Z" absent ⇒
 *  no card" refusal. That produced ONE PERIOD WITH TWO COMPOSITES in the
 *  exact production shape CLAUDE.md §14 documents — `assembled_metrics`
 *  null on every period, `calculated_metrics` intact:
 *
 *      /report Section 7   24.4 · Z" 0.22    · no letter · NAMED NO MODEL
 *      dashboard hero      36   · Z" 0.20131 · CCC       · client-fallback-v1
 *
 *  The card now takes whatever `engineCreditResult` returned and renders
 *  it. `letterSource` is the one field it derives, and it derives it from
 *  the same result. */
export function creditCardData(result: CreditScoreResult | null): CreditScoreData | null {
  if (!result) return null;
  const composite = result.score;
  const altmanZ = result.altman.score;
  // The card's headline is a composite AND a Z"; with either absent there
  // is no card to draw, and the page states that instead. This is the one
  // refusal it keeps, and it reads off the shared result rather than off a
  // second set of operands.
  if (composite === null || altmanZ === null) return null;
  const ladder = result.letterBands;
  const letter = result.rating;
  // The seven weighted rows, in the reader's own order.
  const [altman, profitability, leverage, coverage, dscr, liquidity, equity] =
    result.components;
  return {
    composite,
    altmanZ,
    letter,
    model: result.model,
    modelLabel: result.modelLabel,
    letterSource: letter === null ? "absent" : ladder ? "letter_grade_bands" : "letter_grade",
    ladder,
    altmanX1: result.altman.components.x1_wc_to_assets,
    altmanX2: result.altman.components.x2_re_to_assets,
    altmanX3: result.altman.components.x3_ebit_to_assets,
    altmanX4: result.altman.components.x4_equity_to_liabilities,
    // The bars render the 0–100 WEIGHTED INPUTS, which is `subscore` on
    // every row — not `value`, because the Altman row's value is the Z"
    // itself. Stated by the reader, never recovered here by dividing a
    // contribution back out by its weight.
    subscores: {
      altman: altman?.subscore ?? null,
      profitability: profitability?.subscore ?? null,
      leverage: leverage?.subscore ?? null,
      coverage: coverage?.subscore ?? null,
      dscr: dscr?.subscore ?? null,
      liquidity: liquidity?.subscore ?? null,
      equity: equity?.subscore ?? null,
    },
  };
}

/** The `/report` entry point: the engine's two emission paths in, the ONE
 *  reader's answer out. Returns null when the engine spoke through
 *  neither, which is when the page says so. */
export function readCreditFromMetrics(
  metrics: Record<string, number | null>,
  creditEnvelope?: CreditEnvelope | null,
): CreditScoreData | null {
  return creditCardData(
    engineCreditResult(creditEnvelope ?? undefined, undefined, metrics),
  );
}

interface Props {
  data: CreditScoreData;
  /** Kept on the prop so the one call site (`ComprehensiveReport.tsx`)
   *  still reads `variant="full"`, and so a future second variant has to
   *  be added deliberately rather than by defaulting. There is one
   *  rendering: the expanded card with sub-score bars. */
  variant?: "full";
}

export function CreditScoreCard({ data }: Props) {
  const grade = data.letter;
  const zone = altmanZone(data.altmanZ);
  /** The engine's ladder, spelled — by `spellLadder`, the ONE spelling of
   *  a band table in this product. It was spelled inline here (sort, map,
   *  join) and inline again in the printed document; two spellings of one
   *  ladder is how the two drift apart in wording while agreeing in
   *  numbers. A re-band changes this line, so the page shows WHICH ladder
   *  produced the letter, not just the letter. */
  const ladderText = spellLadder(data.ladder);

  // Semantic band color from tokens only — red stays reserved for the
  // genuinely distressed band.
  const gradeColor =
    data.composite >= 70 ? "text-success"
    : data.composite >= 50 ? "text-caution"
    : "text-alert";

  const zoneLabel = zone === "safe" ? "Safe" : zone === "grey" ? "Grey" : "Distress";
  const zoneClass =
    zone === "safe" ? "bg-success-tint text-success border-transparent"
    : zone === "grey" ? "bg-caution-tint text-caution border-transparent"
    : "bg-alert-tint text-alert border-transparent";

  // ── THE `compact` VARIANT IS DELETED ────────────────────────────────
  //
  // ⚠ IT WAS ENUMERATED AS A LIVE SURFACE AND HAD ZERO CALLERS. The
  // "dashboard hero" in every surface census of this programme is
  // `HeroVerdictCard` (frontend/pages/cfo/FinancialStatements.tsx), which
  // is a projection of `computeCreditScore` and has nothing to do with
  // this file. `<CreditScoreCard variant="compact">` was never mounted
  // anywhere: the single caller in the app is
  // `ComprehensiveReport.tsx:480`, and it passes `variant="full"`.
  //
  // It was carrying a comment reading "Unmounted in the app today — and
  // it names its model anyway", i.e. it was knowingly kept as a
  // defensive shell. That is the wrong instinct here: an unmounted
  // branch is not defended by any gate that renders a surface, so it
  // drifts freely and then gets counted as coverage. Its one honest
  // job — "the letter never appears without its model" — is discharged
  // by `CreditModelNote` below, which the LIVE branch renders.

  return (
    <section data-testid="credit-score-card" className="rounded-md border border-rule bg-surface p-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium">
            Credit score
          </div>
          <div className="mt-2 flex items-baseline gap-2 sm:gap-3 flex-wrap">
            <span className={`font-mono tabular-nums text-[clamp(30px,7vw,44px)] font-medium leading-none ${gradeColor}`}>
              <LearnableNumber conceptKey="composite_credit_score" value={data.composite}>
                {Math.round(data.composite)}
              </LearnableNumber>
            </span>
            <span className="text-[16px] sm:text-[20px] text-ink-mute">/ 100</span>
            {grade !== null && (
              <span
                className={`font-mono tabular-nums text-[clamp(22px,5vw,32px)] font-medium leading-none ${gradeColor}`}
                data-testid="report-credit-letter"
                data-model={data.model ?? "none"}
                data-letter-source={data.letterSource}
              >
                <LearnableNumber conceptKey="credit_grade" value={data.composite}>{grade}</LearnableNumber>
              </span>
            )}
          </div>
          <div className="mt-2 text-[12px] text-ink-soft">
            Composite score · weighted average of 7 risk dimensions
          </div>
          {/* THE LETTER NEVER APPEARS WITHOUT ITS MODEL — the same rule
              the Risks tab, the hero card and the workbook already
              carry, now on the fourth surface. When there is no letter,
              this states why instead. */}
          <CreditModelNote data={data} ladderText={ladderText} className="mt-1.5 max-w-[440px]" />
        </div>
        <div className="rounded-md border border-rule bg-bg-2/40 p-4 min-w-[220px]">
          <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium">
            Altman Z″ score
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="font-mono tabular-nums text-[26px] font-medium text-ink">
              <LearnableNumber conceptKey="altman_z_score" value={data.altmanZ}>{data.altmanZ.toFixed(2)}</LearnableNumber>
            </span>
            <span className={`text-[11px] uppercase tracking-[0.08em] font-medium px-2 py-0.5 rounded-md border ${zoneClass}`}>
              {zoneLabel}
            </span>
          </div>
          {/* A Z″ COMPONENT THAT WAS NOT EMITTED IS NOT 0.00. `0.00` is a
              readable, plausible component value — a reader has no way to
              tell it from a measured one. */}
          <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-[11.5px] tabular-nums">
            <span className="text-ink-mute">X1 (working capital)</span>
            <span className="text-right">{fmtComponent(data.altmanX1)}</span>
            <span className="text-ink-mute">X2 (retained / assets)</span>
            <span className="text-right">{fmtComponent(data.altmanX2)}</span>
            <span className="text-ink-mute">X3 (EBIT / assets)</span>
            <span className="text-right">{fmtComponent(data.altmanX3)}</span>
            <span className="text-ink-mute">X4 (equity / liab)</span>
            <span className="text-right">{fmtComponent(data.altmanX4)}</span>
          </div>
        </div>
      </div>

      {/* Sub-score breakdown — horizontal bars showing each weighted input */}
      <div className="mt-6">
        <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium mb-3">
          Component breakdown
        </div>
        <div className="space-y-2">
          <ScoreBar label="Altman Z″"          value={data.subscores.altman}        weight={30} />
          <ScoreBar label="Profitability"      value={data.subscores.profitability} weight={20} />
          <ScoreBar label="Leverage"           value={data.subscores.leverage}      weight={15} />
          <ScoreBar label="Interest coverage"  value={data.subscores.coverage}      weight={10} />
          <ScoreBar label="DSCR"               value={data.subscores.dscr}          weight={10} />
          <ScoreBar label="Liquidity"          value={data.subscores.liquidity}     weight={10} />
          <ScoreBar label="Equity ratio"       value={data.subscores.equity}        weight={5} />
        </div>
      </div>
    </section>
  );
}

/** THE MODEL, BESIDE THE LETTER — one node, both variants, always
 *  rendered.
 *
 *  It is unconditional on purpose: a reader who only ever meets periods
 *  the engine scored still learns that a model identity exists, so the
 *  day they meet a period without one, the difference is legible rather
 *  than invisible. `data-model` is machine-readable so a gate can assert
 *  it; the ladder is spelled out so an engine RE-BAND is visible on the
 *  page and not only inside the letter. */
function CreditModelNote({
  data,
  ladderText,
  className = "",
}: {
  data: CreditScoreData;
  ladderText: string | null;
  className?: string;
}) {
  return (
    <div
      className={`text-[10.5px] leading-snug text-ink-mute ${className}`}
      data-testid="report-credit-model"
      data-model={data.model ?? "none"}
      data-letter-source={data.letterSource}
    >
      {data.model === null ? LETTER_ABSENT_NOTE : data.modelLabel}
      {data.model !== null && data.letter === null ? (
        <>
          {" · "}
          <span data-testid="report-credit-letter-absent">{LETTER_ABSENT_NOTE}</span>
        </>
      ) : null}
      {ladderText ? (
        <>
          {" · "}
          <span data-testid="report-credit-ladder">Ladder: {ladderText}</span>
        </>
      ) : null}
    </div>
  );
}

function ScoreBar({
  label,
  value,
  weight,
}: {
  label: string;
  value: number | null;
  weight: number;
}) {
  // AN UNMEASURED SUB-SCORE IS NOT A ZERO SCORE. No bar (an empty track
  // reads as "scored 0"), no number, and the neutral rule colour rather
  // than the distress red the `< 50` branch would otherwise pick.
  if (value === null) {
    return (
      <div
        className="grid grid-cols-[140px_1fr_56px_44px] items-center gap-3 text-[12px]"
        data-testid={`score-bar-absent-${label}`}
      >
        <div className="text-ink-mute">{label}</div>
        <div className="h-1.5 rounded-full bg-bg-2 overflow-hidden" aria-hidden />
        <div className="text-right text-[11px] text-ink-mute">not scored</div>
        <div className="text-right text-[11px] text-ink-mute tabular-nums">{weight}%</div>
      </div>
    );
  }
  const pct = Math.max(0, Math.min(100, value));
  const color =
    value >= 70 ? "bg-success"
    : value >= 50 ? "bg-caution"
    : "bg-alert";
  return (
    <div className="grid grid-cols-[140px_1fr_56px_44px] items-center gap-3 text-[12px]">
      <div className="text-ink">{label}</div>
      <div className="h-1.5 rounded-full bg-bg-2 overflow-hidden">
        <div className={`h-full transition-all duration-500 ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="text-right text-ink tabular-nums">{Math.round(value)}</div>
      <div className="text-right text-[11px] text-ink-mute tabular-nums">{weight}%</div>
    </div>
  );
}

// Unused export to keep formatRON imported (referenced for future $-value
// rendering in the expanded card).
void formatRON;
