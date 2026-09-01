// THE CANVAS — THE ARTIFACT CARD.
//
// The card is the unit of the document. It has a title, a body, and its
// own actions — pin it, copy it, recompute it — and it BREATHES: the
// thread around it is tight (4px rhythm) so that the cards are the thing
// the eye lands on. That contrast is the whole layout idea. A thread
// that breathes as much as its artifacts reads as a chat log; a thread
// that is tighter than its artifacts reads as a document with figures in
// it, which is what this is.
//
// ══ WHAT THE CARD OWNS, AND WHAT IT DOES NOT ═══════════════════════════
//
// OWNS: the frame. Title, actions, pin state, the Pro disclosure, the
// stale state, the empty state.
//
// DOES NOT OWN: the body. `canvasArtifactRenderer(kind)` is asked first,
// and a lane that registers a chart renderer takes over this space
// without touching this file. When nothing is registered the card falls
// back to the FIGURES body — `CapsuleFactCard` + `CapsuleVisuals` +
// `FigureList`, the same components the answer surface uses, driven by
// the same evidence.
//
// The fallback is not a placeholder. The engine returned these facts,
// with provenance, and they are shown. What is missing is the SHAPE, and
// one line of reviewed copy says so. An empty card would imply there was
// nothing to say, which is a lie about the data.
//
// ══ EVERY NUMERAL IN HERE ══════════════════════════════════════════════
//
// …arrives through `<Amount>` from `evidence.factMeta`, or through
// `NarrativeText` binding a `{{money:FACT}}` placeholder against
// `evidence.facts`. There is no third path, and there is no prop on this
// component through which a formatted string could arrive — `turn` and
// `evidence` are the only figure-bearing inputs and both are typed
// engine output.

import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { CapsuleFactCard } from "@/components/instrument/shell/capsuleAnswer/CapsuleFactCard";
import {
  CapsuleVisuals,
  FigureList,
} from "@/components/instrument/shell/capsuleAnswer/CapsuleFigures";
import { answerToNativeText, type CapsuleTurn } from "@/components/instrument/shell/capsuleAnswer/capsuleAnswerClient";
import { NarrativeText } from "@/lib/narrativeMoney";
import type { CanvasArtifactKind, CanvasArtifactRef } from "@/lib/canvasThread";
import type { TraceableSource } from "@/lib/traceableSource";
import type { ViewMode } from "@/lib/viewMode";

import "./canvasI18n";
import { canvasArtifactRenderer } from "./canvasArtifactRegistry";

export interface CanvasArtifactCardProps {
  artifact: CanvasArtifactRef;
  /** Null when the entry is stale (restored from a previous session, or
   *  answered against a different period). The card then shows its title
   *  and a recompute action and NOT ONE DIGIT. */
  turn: CapsuleTurn | null;
  stale: boolean;
  mode: ViewMode;
  pinned: boolean;
  onPin: (artifact: CanvasArtifactRef) => void;
  onRecompute: () => void;
  onJump: (source: TraceableSource) => void;
  /** Period name for the stale action's label. */
  periodLabel: string | null;
  /**
   * For an EXPORT card: the titles of the artifacts this pack contains,
   * in the order they were built. An export is a thing you take away,
   * not a thing you read, so what it needs to show is its CONTENTS —
   * and it must not re-query to find them out, because a pack that
   * re-queried would be a different pack from the one the reader just
   * watched being assembled.
   */
  manifest?: readonly string[];
}

export function CanvasArtifactCard({
  artifact,
  turn,
  stale,
  mode,
  pinned,
  onPin,
  onRecompute,
  onJump,
  periodLabel,
  manifest,
}: CanvasArtifactCardProps) {
  const { t } = useTranslation();
  const [showSpec, setShowSpec] = useState(false);
  const [copied, setCopied] = useState(false);

  const evidence = turn?.evidence ?? null;
  const factNames = useMemo(
    () => (evidence ? Object.keys(evidence.factMeta) : []),
    [evidence],
  );
  const renderer = canvasArtifactRenderer(artifact.kind);
  const rendered =
    renderer && turn && !stale
      ? renderer({
          kind: artifact.kind,
          evidence: turn.evidence,
          visuals: turn.visuals,
          turn,
          onJump,
          mode,
          pinned,
          onPin: () => onPin(artifact),
        })
      : null;

  /**
   * ONE CARD, NOT TWO.
   *
   * A registered renderer brings the artifacts lane's own `<Artifact>`,
   * which IS a card: title, action row (pin, export, refine) and a
   * citation footer. Wrapping that in this component's frame produced
   * two borders, two titles and two pin buttons pointing at the same
   * store — so where a renderer answers, this component drops its own
   * chrome and contributes only what the renderer does not have: the
   * model's guarded prose as a caption, and the Pro metric-id
   * disclosure.
   *
   * Where no renderer answers, the frame below is the floor and carries
   * everything.
   */
  const delegated = rendered !== null;

  const copy = useCallback(() => {
    if (!turn || !evidence) return;
    const text = turn.blocks.length
      ? answerToNativeText(turn.blocks, evidence)
      : factNames.join(", ");
    try {
      void navigator.clipboard?.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked — the action simply does nothing visible */
    }
  }, [turn, evidence, factNames]);

  const title = t(artifact.titleKey, artifact.titleParams);

  return (
    <article
      data-testid="canvas-artifact"
      data-artifact-kind={artifact.kind}
      data-artifact-stale={stale ? "1" : "0"}
      data-artifact-delegated={delegated ? "1" : "0"}
      className={
        delegated
          ? ""
          : "rounded-[14px] border border-rule bg-surface px-4 pb-4 pt-3"
      }
    >
      {!delegated && (
      <header className="flex items-start gap-2">
        <h4 className="min-w-0 flex-1 truncate text-[11px] font-medium uppercase tracking-[0.14em] text-ink-soft">
          {title}
        </h4>
        <div className="flex shrink-0 items-center gap-1">
          {!stale && turn && (
            <button
              type="button"
              data-testid="canvas-artifact-copy"
              onClick={copy}
              className="
                rounded-[8px] px-2 py-1 text-[11px] text-ink-soft
                hover:bg-surface-hi hover:text-ink
                focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand
              "
            >
              {copied ? t("canvas.artifact.copied") : t("canvas.artifact.copy")}
            </button>
          )}
          <button
            type="button"
            data-testid="canvas-artifact-pin"
            aria-pressed={pinned}
            onClick={() => onPin(artifact)}
            className={`
              rounded-[8px] px-2 py-1 text-[11px]
              focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand
              ${pinned
                ? "bg-brand-tint text-brand-d dark:text-brand-l"
                : "text-ink-soft hover:bg-surface-hi hover:text-ink"}
            `}
          >
            {pinned ? t("canvas.artifact.pinned") : t("canvas.artifact.pin")}
          </button>
        </div>
      </header>
      )}

      {/* ── STALE ─────────────────────────────────────────────────────
          The one branch in this component that renders no figure. It is
          reached whenever the entry was answered against a different
          period, or restored from storage where no figure was ever
          written. Both are the same thing to the reader: a question they
          asked, whose answer is not on screen because it would not be
          about what is on screen. */}
      {stale ? (
        <div className="mt-3" data-testid="canvas-artifact-stale">
          <p className="text-[12.5px] leading-relaxed text-ink-soft">
            {t("canvas.entry.stale")}
          </p>
          <button
            type="button"
            data-testid="canvas-artifact-recompute"
            onClick={onRecompute}
            className="
              mt-2 rounded-[10px] border border-rule px-3 py-1.5
              text-[12px] text-ink
              hover:bg-surface-hi
              focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand
            "
          >
            {periodLabel
              ? t("canvas.entry.staleAction", { period: periodLabel })
              : t("canvas.entry.staleActionNoPeriod")}
          </button>
        </div>
      ) : !turn || turn.status === "retrieving" || turn.status === "generating" ? (
        /* ── IN FLIGHT ───────────────────────────────────────────────
           NOT the same branch as "done, and empty", and the difference
           is not cosmetic. Before r2 this card only checked `!turn`, so
           a turn that EXISTED but had not finished fell through to the
           body and rendered "The engine returned no figures for this
           one." — a false statement about the data, shown on every
           model answer for as long as it took to arrive.
           The capture gate found it: the streaming shutter asserted
           this testid and it was not on screen.
           The two states also say different things: `retrieving` is the
           ENGINE reading, `generating` is the model composing over
           figures already in hand. */
        <p className="mt-3 text-[12.5px] text-ink-soft" data-testid="canvas-artifact-pending">
          {!turn
            ? t("canvas.artifact.pending")
            : turn.status === "generating"
            ? t("canvas.state.composing")
            : t("canvas.state.thinking")}
        </p>
      ) : (
        <div className="mt-2">
          {/* A registered renderer may REFUSE by returning null — a
              chart of one point, a table of no facts. That is not an
              error and it must not paint an empty box where the figure
              list belongs, so a null body falls through to the fallback
              exactly as an unregistered kind does. */}
          {rendered ?? (
            <FallbackBody
              kind={artifact.kind}
              turn={turn}
              factNames={factNames}
              onJump={onJump}
              manifest={manifest}
            />
          )}

          {/* ── PROSE AS CAPTION ────────────────────────────────────
              Part E, and it is a real inversion: on a chat surface the
              sentence leads and the figures illustrate it. Here the
              artifact leads and the sentence explains it. Same content,
              opposite reading order, and the second one is what a
              financial document does. */}
          {turn.blocks.length > 0 && (
            <div className="mt-3 space-y-1" data-testid="canvas-artifact-caption">
              {turn.blocks.map((block, i) => (
                <p key={i} className="text-[12.5px] leading-relaxed text-ink-soft">
                  <NarrativeText
                    text={answerToNativeText([block], turn.evidence)}
                    template={block.template}
                    facts={turn.evidence.facts}
                    factUnits={turn.evidence.factUnits}
                    // `?? undefined` so the prop's own default ("RON")
                    // applies when the evidence carries no money at all.
                    // Passing null would override the default with a
                    // value the resolver has no rate for.
                    sourceCurrency={turn.evidence.currency ?? undefined}
                  />
                </p>
              ))}
            </div>
          )}

          {/* ── PRO ─────────────────────────────────────────────────
              Simple mode gets plain labels and stops here. Pro gets the
              metric ids the artifact was built from — the vocabulary you
              need to ask a sharper question, and the vocabulary that
              tells you whether the card answered what you meant. */}
          {mode === "pro" && factNames.length > 0 && (
            <div className="mt-3 border-t border-rule-soft pt-2">
              <button
                type="button"
                data-testid="canvas-artifact-spec-toggle"
                onClick={() => setShowSpec((v) => !v)}
                className="
                  text-[11px] uppercase tracking-[0.12em] text-ink-soft
                  hover:text-ink
                  focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand
                "
              >
                {showSpec ? t("canvas.pro.hide") : t("canvas.pro.show")}
              </button>
              {showSpec && (
                <dl className="mt-2 space-y-1" data-testid="canvas-artifact-spec">
                  <div className="flex gap-2">
                    <dt className="w-24 shrink-0 text-[11px] text-ink-mute">
                      {t("canvas.pro.metrics")}
                    </dt>
                    <dd className="min-w-0 flex-1 break-words font-mono text-[11px] text-ink-soft">
                      {factNames.join(" · ")}
                    </dd>
                  </div>
                  {turn.evidence.tools.length > 0 && (
                    <div className="flex gap-2">
                      <dt className="w-24 shrink-0 text-[11px] text-ink-mute">
                        {t("canvas.pro.spec")}
                      </dt>
                      <dd className="min-w-0 flex-1 break-words font-mono text-[11px] text-ink-soft">
                        {turn.evidence.tools.join(" · ")}
                      </dd>
                    </div>
                  )}
                </dl>
              )}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

/**
 * The body when no lane has registered a renderer for this kind.
 *
 * Figures for anything figure-shaped; a manifest for an export (which is
 * a thing you take away, not a thing you read). Both are honest about
 * what they are.
 */
function FallbackBody({
  kind,
  turn,
  factNames,
  onJump,
  manifest,
}: {
  kind: CanvasArtifactKind;
  turn: CapsuleTurn;
  factNames: string[];
  onJump: (source: TraceableSource) => void;
  manifest?: readonly string[];
}) {
  const { t } = useTranslation();

  if (kind === "export") {
    return (
      <div data-testid="canvas-artifact-manifest">
        {manifest && manifest.length > 0 ? (
          <ul className="space-y-0.5">
            {manifest.map((title, i) => (
              <li key={`${title}-${i}`} className="flex items-baseline gap-2">
                <span aria-hidden className="text-[11px] text-ink-mute">
                  {i + 1}
                </span>
                <span className="truncate text-[12.5px] text-ink-soft">{title}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12.5px] leading-relaxed text-ink-soft">
            {t("canvas.artifact.renderer")}
          </p>
        )}
      </div>
    );
  }

  if (factNames.length === 0) {
    return (
      <p className="text-[12.5px] text-ink-soft" data-testid="canvas-artifact-empty">
        {t("canvas.artifact.empty")}
      </p>
    );
  }

  return (
    <div data-testid="canvas-artifact-figures">
      <CapsuleFactCard evidence={turn.evidence} visuals={turn.visuals} onJump={onJump} />
      <CapsuleVisuals visuals={turn.visuals} evidence={turn.evidence} onJump={onJump} />
      <FigureList facts={factNames} evidence={turn.evidence} onJump={onJump} />
      {/* The reader asked for a CHART and is looking at a figure list.
          Saying so is the difference between a graceful floor and a
          silent substitution — and a silent substitution is how a
          surface teaches people not to trust its labels.
          TWO KINDS NEED NO NOTE, for opposite reasons: `figures` because
          the fallback IS the artifact, and `explain` because an
          explanation's artifact is exactly "grounded prose over the
          figures it cites" — which is what the body plus the caption
          below already are. Apologising there would be apologising for
          rendering the thing correctly. */}
      {kind !== "figures" && kind !== "explain" && (
        <p className="mt-2 text-[11px] text-ink-mute" data-testid="canvas-artifact-renderer-note">
          {t("canvas.artifact.renderer")}
        </p>
      )}
    </div>
  );
}
