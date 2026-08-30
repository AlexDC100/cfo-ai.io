// THE CAPSULE — THE ANSWER CANVAS.
//
// The same overlay the reader was typing in, grown. No route change, no
// second window, no chat page: the question was asked from here, so it
// is answered here, and Escape puts them back exactly where they were
// with the thread intact.
//
// ── The anatomy, in the order it is read ──────────────────────────────
//
//   1  QUESTION CHIP     the question, pinned as one compact line. It is
//                        context, not content, so it wears a chip and not
//                        a heading
//   2  FACT CARD         the number, large, in mono, with its delta chip
//                        and a provenance dot that JUMPS to the source
//                        cell. See CapsuleFactCard for why this is first
//   3  MICRO-VISUAL      a sparkline or a three-row comparison — drawn
//                        FROM FACTS by `capsuleAnswerVisuals`, never
//                        parsed out of model text
//   4  INTERPRETATION    the streamed prose, plain-language, mode-aware,
//                        through `NarrativeText` so every figure inside a
//                        sentence resolves on the money path
//   5  CITATION          period, snapshot, source file, trust verdict
//   6  ACTIONS           evidence · chat · copy · pack
//   7  FOLLOW-UP CHIPS   the next question, computed from THIS answer's
//                        evidence (`capsuleFollowUps`). Nearest the
//                        composer, because that is where the next
//                        question happens
//
// ── Motion, and what "no layout shift" actually means here ────────────
//
// The overlay is `position: fixed`, so growing it moves NOTHING behind
// it: the page's layout shift is zero by construction rather than by
// measurement. That is the easy half.
//
// The hard half is INSIDE. The reveal used to mount blocks one at a
// time, which meant the citation, the actions and the follow-ups were
// pushed down the screen once per block — every already-painted line
// moved, repeatedly, under the reader's eye. Now every block of a
// finished turn is in the DOM from the first frame and reveals by
// OPACITY on a stagger. The container reaches its final height
// immediately; nothing that has been painted is ever moved again.
//
// While the answer is still being written, the prose region reserves the
// height of the skeleton it is showing, and a cursor glyph marks the
// live edge. Under `prefers-reduced-motion` the stagger is skipped and
// the answer is simply there.
//
// ── The streamed text is not shown raw ────────────────────────────────
//
// Model output is unverified until the guard has run on the COMPLETE
// text: a half-arrived sentence cannot be checked for invented numerals,
// and a placeholder that has only half-arrived renders as literal
// braces. So the surface shows the retrieval trace, then a writing
// shimmer, then the checked answer. `firstTokenMs` is still measured at
// the transport's first chunk — the honest number for the latency
// contract, independent of what the surface chooses to paint.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, MessageSquare, Package, RotateCw } from "lucide-react";

import { Chip } from "@/components/instrument/Panel";
import { NarrativeText } from "@/lib/narrativeMoney";
import type { Currency } from "@/lib/rates";
import type { TraceableSource } from "@/lib/traceableSource";

import "./capsuleAnswerI18n";
import { codeCopy, hasCopy, metricLabel } from "./capsuleAnswerI18n";
import { answerToNativeText, type CapsuleTurn } from "./capsuleAnswerClient";
import type { CapsuleEvidence } from "./capsuleAnswerTypes";
import { CapsuleFactCard, pickHeadline } from "./CapsuleFactCard";
import { CapsuleVisuals, FigureList } from "./CapsuleFigures";
import { buildFollowUps, type CapsuleFollowUp } from "./capsuleFollowUps";
import { inPack, subscribePack, togglePack } from "./capsuleExportPack";

/** Host-supplied citation context — the palette knows the active period,
 *  its source document and the engine's balance verdict; the panel does
 *  not re-derive any of it. */
export interface HostCitation {
  periodLabel: string | null;
  sourceFile: string | null;
  /** The served presenter's own wording. Null when this period carries
   *  no canonical envelope — an unverified period wears no badge. */
  trustLabel: string | null;
  trustTone: "success" | "caution" | "alert" | "neutral";
}

export interface CapsuleAnswerPanelProps {
  turns: readonly CapsuleTurn[];
  busy: boolean;
  citation: HostCitation;
  onAsk: (question: string) => void;
  onRetry: (turn: CapsuleTurn) => void;
  onJump: (source: TraceableSource) => void;
  onOpenInChat: () => void;
  /** Bottom padding the host reserves for its own chrome. */
  className?: string;
}

// ── reduced motion ─────────────────────────────────────────────────────

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduced(mq.matches);
    apply();
    mq.addEventListener?.("change", apply);
    return () => mq.removeEventListener?.("change", apply);
  }, []);
  return reduced;
}

/**
 * Reveal blocks by OPACITY, on a stagger, without moving anything.
 *
 * Returns the number of blocks currently opaque. Every block is mounted
 * either way — the caller renders all of them and dims the ones this
 * count has not reached yet. That distinction is the whole point: a
 * mount-based stagger changes the container's height on every tick, and
 * this one cannot.
 */
function useBlockReveal(count: number, enabled: boolean): number {
  const [shown, setShown] = useState(enabled ? 0 : count);
  useEffect(() => {
    if (!enabled) {
      setShown(count);
      return;
    }
    setShown(count > 0 ? 1 : 0);
    if (count <= 1) return;
    let i = 1;
    const timer = window.setInterval(() => {
      i += 1;
      setShown(i);
      if (i >= count) window.clearInterval(timer);
    }, 70);
    return () => window.clearInterval(timer);
  }, [count, enabled]);
  return Math.min(shown, count);
}

// ── the retrieval trace ────────────────────────────────────────────────

function RetrievalTrace({ turn }: { turn: CapsuleTurn }) {
  const { t } = useTranslation();
  if (turn.trace.length === 0) {
    return (
      <div className="text-[12px] text-ink-soft" data-testid="capsule-trace">
        {t("capsuleAnswer.trace.none")}
      </div>
    );
  }
  return (
    <ul className="space-y-1" data-testid="capsule-trace">
      {turn.trace.map((line) => {
        // A trace line whose period is unknown must not read
        // "Reading revenue · " with a dangling separator — every tool
        // that names a period has a `_noPeriod` twin for exactly that.
        const hasPeriod = Boolean(line.params.period);
        const noPeriodKey = `${line.key}_noPeriod`;
        const key = !hasPeriod && hasCopy(noPeriodKey) ? noPeriodKey : line.key;
        const label = t(key, line.params);
        return (
          <li key={line.id} className="flex items-center gap-2 text-[12px]">
            <span
              aria-hidden
              className={`h-1 w-1 shrink-0 rounded-full ${
                line.state === "ok"
                  ? "bg-success"
                  : line.state === "missing"
                  ? "bg-caution"
                  : "bg-ink-mute animate-pulse motion-reduce:animate-none"
              }`}
            />
            <span className={line.state === "missing" ? "text-ink-soft line-through" : "text-ink-soft"}>
              {label}
            </span>
            {line.state === "missing" && (
              <span className="text-[11px] text-ink-soft">{t("capsuleAnswer.trace.missing")}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ── absences ───────────────────────────────────────────────────────────

function Absences({ evidence }: { evidence: CapsuleEvidence }) {
  const { t } = useTranslation();
  const gaps = dedupe(evidence.gaps.map((g) => g.code));
  const limits = dedupe(evidence.limitations.map((l) => l.rule));
  if (gaps.length === 0 && limits.length === 0) return null;
  return (
    <div className="mt-2 space-y-1.5" data-testid="capsule-absences">
      {gaps.length > 0 && (
        <div>
          <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-ink-soft">
            {t("capsuleAnswer.gapsTitle")}
          </div>
          <ul className="mt-0.5 space-y-0.5">
            {gaps.map((code) => (
              <li key={code} className="text-[12px] text-ink-soft">
                {codeCopy(t, "gap", code)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {limits.length > 0 && (
        <div>
          <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-ink-soft">
            {t("capsuleAnswer.limitsTitle")}
          </div>
          <ul className="mt-0.5 space-y-0.5">
            {limits.map((rule) => (
              <li key={rule} className="text-[12px] text-ink-soft">
                {codeCopy(t, "limitation", rule)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function dedupe(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

// ── citation footer ────────────────────────────────────────────────────

function Citation({
  turn,
  citation,
}: {
  turn: CapsuleTurn;
  citation: HostCitation;
}) {
  const { t } = useTranslation();
  const periods = turn.evidence.periods.map((p) => p.label).filter(Boolean);
  const snapshot = turn.evidence.snapshots[0] ?? null;
  const periodText = periods.length
    ? periods.join(", ")
    : citation.periodLabel ?? t("capsuleAnswer.citation.noPeriod");

  return (
    <div
      className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-rule-soft pt-2 text-[11px] text-ink-soft"
      data-testid="capsule-citation"
    >
      <span>
        {t(periods.length > 1 ? "capsuleAnswer.citation.period_other" : "capsuleAnswer.citation.period_one")}
        {" · "}
        <span className="text-ink-soft">{periodText}</span>
      </span>
      {citation.sourceFile && (
        <span className="min-w-0 max-w-[45%] truncate">
          {t("capsuleAnswer.citation.file")} · <span className="text-ink-soft">{citation.sourceFile}</span>
        </span>
      )}
      {snapshot && (
        <span className="font-mono">
          {t("capsuleAnswer.citation.snapshot")} · {snapshot.slice(0, 8)}
        </span>
      )}
      {/* Trust is the ENGINE's verdict, rendered verbatim. No canonical
          envelope → the surface says "not verified" rather than wearing
          a badge it did not earn. */}
      {citation.trustLabel ? (
        <Chip tone={citation.trustTone}>{citation.trustLabel}</Chip>
      ) : (
        <span>{t("capsuleAnswer.citation.trustUnverified")}</span>
      )}
    </div>
  );
}

// ── per-answer actions ─────────────────────────────────────────────────

function Actions({
  turn,
  citation,
  onOpenInChat,
  showEvidence,
  onToggleEvidence,
  hasEvidence,
}: {
  turn: CapsuleTurn;
  citation: HostCitation;
  onOpenInChat: () => void;
  showEvidence: boolean;
  onToggleEvidence: () => void;
  hasEvidence: boolean;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [packed, setPacked] = useState(() => inPack(turn.id));

  useEffect(() => subscribePack(() => setPacked(inPack(turn.id))), [turn.id]);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const nativeText = useCallback(
    () => answerToNativeText(turn.blocks, turn.evidence),
    [turn.blocks, turn.evidence],
  );

  const doCopy = async () => {
    const body = `${turn.question}\n\n${nativeText()}`;
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
    } catch {
      /* clipboard denied — the button simply does not confirm */
    }
  };

  const doPack = () => {
    togglePack({
      id: turn.id,
      question: turn.question,
      answer: nativeText(),
      currency: turn.evidence.currency,
      periods: turn.evidence.periods.map((p) => p.label),
      snapshot: turn.evidence.snapshots[0] ?? null,
      trust: citation.trustLabel,
      addedAt: Date.now(),
    });
  };

  const btn =
    "inline-flex items-center gap-1.5 rounded-sm px-2 py-1 text-[11.5px] text-ink-soft " +
    "transition-colors duration-micro hover:bg-bg-2 hover:text-ink " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <div className="mt-2 flex flex-wrap items-center gap-0.5" data-testid="capsule-actions">
      {/* Evidence leads: it is the only action that answers a question
          about the answer. It is also the only one that renders
          conditionally — a turn with nothing further to show would
          otherwise offer a button that expands into the same list. */}
      {hasEvidence && (
        <button
          type="button"
          className={btn}
          onClick={onToggleEvidence}
          aria-expanded={showEvidence}
          data-testid="capsule-evidence-toggle"
        >
          {showEvidence ? t("capsuleAnswer.hideEvidence") : t("capsuleAnswer.showEvidence")}
        </button>
      )}
      <button type="button" className={btn} onClick={onOpenInChat} data-testid="capsule-open-chat">
        <MessageSquare size={13} strokeWidth={1.75} />
        {t("capsuleAnswer.actions.openInChat")}
      </button>
      <button type="button" className={btn} onClick={doCopy} data-testid="capsule-copy">
        {copied ? <Check size={13} strokeWidth={1.75} /> : <Copy size={13} strokeWidth={1.75} />}
        {copied ? t("capsuleAnswer.actions.copied") : t("capsuleAnswer.actions.copy")}
      </button>
      <button type="button" className={btn} onClick={doPack} data-testid="capsule-pack">
        <Package size={13} strokeWidth={1.75} />
        {packed ? t("capsuleAnswer.actions.inPack") : t("capsuleAnswer.actions.addToPack")}
      </button>
    </div>
  );
}

// ── follow-up chips ────────────────────────────────────────────────────

function FollowUps({
  followUps,
  onPick,
}: {
  followUps: readonly CapsuleFollowUp[];
  onPick: (f: CapsuleFollowUp) => void;
}) {
  const { t } = useTranslation();
  if (followUps.length === 0) return null;
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-1.5" data-testid="capsule-followups">
      {followUps.map((f) => (
          <button
            key={f.id}
            type="button"
            data-testid="capsule-followup-chip"
            data-kind={f.kind}
            data-local={f.local ? "true" : undefined}
            onClick={() => onPick(f)}
            className="
              rounded-full border border-rule bg-bg-2/60 px-2.5 py-1 text-[11.5px]
              text-ink-soft transition-colors duration-micro
              hover:border-brand/40 hover:bg-bg-2 hover:text-ink
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
            "
          >
            {t(f.labelKey, f.labelParams)}
          </button>
      ))}
    </div>
  );
}

// ── one turn ───────────────────────────────────────────────────────────

function Turn({
  turn,
  citation,
  onJump,
  onOpenInChat,
  onRetry,
  onAsk,
  reduced,
}: {
  turn: CapsuleTurn;
  citation: HostCitation;
  onJump: (source: TraceableSource) => void;
  onOpenInChat: () => void;
  onRetry: (turn: CapsuleTurn) => void;
  onAsk: (question: string) => void;
  reduced: boolean;
}) {
  const { t } = useTranslation();
  const [showEvidence, setShowEvidence] = useState(false);
  const done = turn.status === "done";
  const revealed = useBlockReveal(turn.blocks.length, !reduced && done);
  const evidence = turn.evidence;
  const currency = (evidence.currency ?? "RON") as Currency;

  // Which fact the CARD is already showing at 26px. The list must not
  // print it again at 12px under a heading — one answer, one number.
  const headlineFact = useMemo(
    () => (done && !turn.degraded ? pickHeadline(evidence, turn.visuals)?.meta.fact ?? null : null),
    [done, turn.degraded, evidence, turn.visuals],
  );

  const shownFacts = useMemo(() => {
    // "Show evidence" is the one place EVERYTHING appears, headline
    // included — that is what the reader asked for.
    if (showEvidence) return Object.keys(evidence.factMeta);
    // Deterministic answers lead with the figures; a prose answer shows
    // only what it actually cited, so the list is a receipt for the
    // sentence above it rather than a second, competing answer.
    const base = turn.deterministic ? Object.keys(evidence.factMeta) : turn.citedFacts;
    const rest = base.filter((f) => f !== headlineFact);
    // If the headline WAS the whole list, the list has nothing left to
    // say and does not render — heading included.
    return rest;
  }, [showEvidence, turn.deterministic, turn.citedFacts, evidence.factMeta, headlineFact]);

  const followUps = useMemo(
    () =>
      done
        ? buildFollowUps({
            evidence,
            citedFacts: turn.citedFacts,
            deterministic: turn.deterministic,
            degraded: Boolean(turn.degraded),
          })
        : [],
    [done, evidence, turn.citedFacts, turn.deterministic, turn.degraded],
  );

  // The toggle renders whenever there IS evidence. A zero-fact turn
  // hides it rather than offering a button that expands into nothing.
  const hasEvidence = Object.keys(evidence.factMeta).length > 0;

  const pickFollowUp = (f: CapsuleFollowUp) => {
    // A LOCAL chip costs nothing — it expands what is already here. Only
    // the others reach `onAsk`, which is the one path that can spend.
    if (f.local) {
      setShowEvidence(true);
      return;
    }
    // The chip says "vs last year?"; the QUESTION says which metric.
    // A model handed the chip's own text would have to guess the
    // subject, and guessing the subject is how an answer ends up about
    // the wrong number.
    const metric = f.metricKey ? metricLabel(t, f.metricKey, f.metricKey) : "";
    onAsk(t(`capsuleAnswer.followUp.ask.${f.kind}`, { ...f.labelParams, metric }));
  };

  return (
    <article className="px-4 py-3" data-testid="capsule-turn">
      {/* The question is CONTEXT for what follows, so it wears a chip and
          not a heading. One line, truncated, with the full text in
          `title` — a three-line question restated at full size above its
          own answer pushes the answer off the first screen. */}
      {/* HUGS ITS TEXT. Full-width, bordered and rounded, it read as a
          disabled input — something you could click into and type. A
          chip is the size of what it says. */}
      <div className="flex items-start">
        <span
          data-testid="capsule-question-chip"
          title={turn.question}
          className="
            max-w-full truncate rounded-full border border-rule bg-bg-2/70
            px-2.5 py-1 text-[12px] text-ink-soft
          "
        >
          {turn.question}
        </span>
      </div>

      {!done && (
        <div className="mt-2 space-y-2">
          <RetrievalTrace turn={turn} />
          {turn.status === "generating" && (
            // The reserved region. Two skeleton lines and a cursor at the
            // live edge occupy the height the prose will occupy, so the
            // swap from shimmer to sentence moves nothing below it.
            <div
              className="space-y-1.5"
              style={{ minHeight: 40 }}
              data-testid="capsule-skeleton"
            >
              <div className="h-2 w-[85%] rounded-sm bg-bg-2 animate-pulse motion-reduce:animate-none" />
              <div className="flex items-center gap-1">
                <div className="h-2 w-[62%] rounded-sm bg-bg-2 animate-pulse motion-reduce:animate-none" />
                <span
                  aria-hidden
                  data-testid="capsule-cursor"
                  className="inline-block h-3 w-[2px] bg-brand animate-pulse motion-reduce:animate-none"
                />
              </div>
              <span className="sr-only">{t("capsuleAnswer.writing")}</span>
            </div>
          )}
        </div>
      )}

      {/* 2 — THE FACT CARD. Before the prose, because it is the answer
          and the prose is the commentary. */}
      {done && !turn.degraded && (
        <CapsuleFactCard evidence={evidence} visuals={turn.visuals} onJump={onJump} />
      )}

      {done && turn.degraded && (
        <div
          className="mt-2 rounded-sm border border-rule bg-bg-2/50 px-3 py-2"
          data-testid="capsule-degraded"
        >
          <div className="text-[12.5px] text-ink">{t("capsuleAnswer.degraded.title")}</div>
          <p className="mt-0.5 text-[12px] text-ink-soft">
            {t(`capsuleAnswer.degraded.${turn.degraded}`)}
          </p>
          <p className="mt-0.5 text-[11.5px] text-ink-soft">{t("capsuleAnswer.degraded.note")}</p>
          <button
            type="button"
            onClick={() => onRetry(turn)}
            className="mt-1.5 inline-flex items-center gap-1.5 rounded-sm border border-rule px-2 py-1 text-[11.5px] text-ink-soft hover:bg-bg-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <RotateCw size={12} strokeWidth={1.75} />
            {t("capsuleAnswer.actions.retry")}
          </button>
        </div>
      )}

      {/* 3 — the micro-visual, from facts. */}
      {done && <CapsuleVisuals visuals={turn.visuals} evidence={evidence} onJump={onJump} />}

      {done && !turn.degraded && turn.deterministic && (
        <p className="mt-2 text-[12px] italic text-ink-soft" data-testid="capsule-fallback-note">
          {t("capsuleAnswer.fallbackNote")}
        </p>
      )}

      {/* 4 — the interpretation. Every block is mounted; the stagger is
          opacity only, so nothing below this region ever moves once it
          has been painted. */}
      {done && turn.blocks.length > 0 && (
        <div className="mt-2 space-y-1.5" data-testid="capsule-answer-body">
          {turn.blocks.map((block, i) => (
            <div
              key={i}
              style={{ transitionDelay: reduced ? undefined : `${i * 70}ms` }}
              className={`
                transition-opacity duration-overlay motion-reduce:transition-none
                ${i < revealed ? "opacity-100" : "opacity-0"}
                ${block.kind === "bullet"
                  ? "flex gap-2 text-[13px] leading-relaxed text-ink-soft"
                  : "text-[13px] leading-relaxed text-ink-soft"}
              `}
            >
              {block.kind === "bullet" && (
                <span aria-hidden className="select-none text-ink-soft">
                  ·
                </span>
              )}
              <NarrativeText
                text={answerToNativeText([block], evidence)}
                template={block.template}
                facts={evidence.facts}
                factUnits={evidence.factUnits}
                sourceCurrency={currency}
              />
            </div>
          ))}
        </div>
      )}

      {done && shownFacts.length > 0 && (
        <>
          <div className="mt-2.5 text-[10px] font-medium uppercase tracking-[0.14em] text-ink-soft">
            {showEvidence ? t("capsuleAnswer.evidenceTitle") : t("capsuleAnswer.figures")}
          </div>
          <FigureList facts={shownFacts} evidence={evidence} onJump={onJump} />
        </>
      )}

      {/* Only when nothing else already said it. A gap list, a degraded
          panel and the answer's own sentence all state the absence in
          more useful words; three of them stacked reads as a stutter. */}
      {done &&
        shownFacts.length === 0 &&
        !headlineFact &&
        turn.blocks.length === 0 &&
        evidence.gaps.length === 0 &&
        !turn.degraded && (
          <p className="mt-2 text-[12px] text-ink-soft">{t("capsuleAnswer.evidenceNone")}</p>
        )}

      {done && <Absences evidence={evidence} />}
      {done && <Citation turn={turn} citation={citation} />}
      {done && (
        <Actions
          turn={turn}
          citation={citation}
          onOpenInChat={onOpenInChat}
          showEvidence={showEvidence}
          onToggleEvidence={() => setShowEvidence((v) => !v)}
          hasEvidence={hasEvidence}
        />
      )}
      {done && <FollowUps followUps={followUps} onPick={pickFollowUp} />}
    </article>
  );
}

// ── the panel ──────────────────────────────────────────────────────────

export function CapsuleAnswerPanel({
  turns,
  busy,
  citation,
  onAsk,
  onRetry,
  onJump,
  onOpenInChat,
  className,
}: CapsuleAnswerPanelProps) {
  const { t } = useTranslation();
  const reduced = usePrefersReducedMotion();
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // The follow-up input keeps focus: the thread continues from the
  // bottom, so the caret must already be where the next question goes.
  useEffect(() => {
    if (!busy) inputRef.current?.focus();
  }, [busy, turns.length]);

  // New content appends downward; keep the newest turn in view without
  // yanking the reader off something they are mid-read of.
  //
  // NOT ON THE FIRST TURN. There is nothing above it to scroll past, so
  // the scroll has no destination — but it still ANIMATES, and it
  // animates over the fact card at exactly the moment the reader is
  // trying to read the number. Caught in the r3 screenshots: the mobile
  // captures show the headline figure ghosted mid-scroll, in a frame the
  // desktop (short enough not to scroll) never produced. The first
  // answer should simply be there.
  useEffect(() => {
    if (turns.length <= 1) return;
    const el = scrollRef.current;
    if (!el) return;
    // `scrollTo` is absent in jsdom and in a couple of embedded WebViews;
    // the assignment fallback keeps the thread pinned to the bottom
    // everywhere.
    if (typeof el.scrollTo === "function") {
      el.scrollTo({ top: el.scrollHeight, behavior: reduced ? "auto" : "smooth" });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, [turns.length, reduced]);

  const submit = () => {
    const q = draft.trim();
    if (!q || busy) return;
    setDraft("");
    onAsk(q);
  };

  return (
    <div className={`flex min-h-0 flex-col ${className ?? ""}`} data-testid="capsule-answer">
      <div
        ref={scrollRef}
        className="chat-scroll min-h-0 flex-1 divide-y divide-rule-soft overflow-y-auto"
        role="log"
        aria-live="polite"
        aria-busy={busy}
      >
        {turns.map((turn) => (
          <Turn
            key={turn.id}
            turn={turn}
            citation={citation}
            onJump={onJump}
            onOpenInChat={onOpenInChat}
            onRetry={onRetry}
            onAsk={onAsk}
            reduced={reduced}
          />
        ))}
      </div>

      {/* The composer docks at the bottom of the canvas — the thread
          scrolls above it, and the caret never leaves the place the next
          question goes. */}
      <div className="border-t border-rule-soft px-4 py-2.5">
        <textarea
          ref={inputRef}
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={t("capsuleAnswer.followUpPlaceholder")}
          aria-label={t("capsuleAnswer.followUpPlaceholder")}
          data-testid="capsule-followup"
          className="
            max-h-24 w-full resize-none bg-transparent text-[13px] text-ink
            placeholder:text-ink-soft outline-none
          "
        />
        <div className="mt-1 flex items-center justify-between text-[10.5px] text-ink-soft">
          <span>{t("capsuleAnswer.followUpHint")}</span>
          <span>{t("capsuleAnswer.openChatHint")}</span>
        </div>
      </div>
    </div>
  );
}
