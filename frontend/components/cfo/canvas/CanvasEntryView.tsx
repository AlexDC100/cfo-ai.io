// THE CANVAS — ONE ENTRY.
//
// An entry is: what the reader asked, what the plan did about it, and
// the artifacts that came back.
//
// ══ THE ASYMMETRY IS DELIBERATE (Part E) ═══════════════════════════════
//
// The question renders COMPACT and RIGHT-ALIGNED — a small marker of
// "you said this", not a speech bubble competing with the answer. The
// output renders ARTIFACT-FIRST and full width. On a chat surface the
// two are symmetric because both are messages; here they are not the
// same kind of object at all. One is a prompt, the other is a document
// section.
//
// ══ THE STEPS ══════════════════════════════════════════════════════════
//
// A multi-step plan renders its steps as a checklist that fills in while
// it runs. It is not a progress bar: each line names a real piece of
// work and each one produces an artifact below that the reader can open.
// The list stays after the run, because "what did this pack contain" is
// a question people ask a week later.

import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { CanvasArtifactRef, CanvasEntry } from "@/lib/canvasThread";
import type { TraceableSource } from "@/lib/traceableSource";
import type { ViewMode } from "@/lib/viewMode";

import "./canvasI18n";
import { CanvasArtifactCard } from "./CanvasArtifactCard";
import { getLiveTurn, useLiveTurnVersion } from "./canvasLiveTurns";

export interface CanvasEntryViewProps {
  entry: CanvasEntry;
  /** The scope on screen. An entry answered against another one is
   *  stale, and stale means no figures. */
  scope: string;
  mode: ViewMode;
  periodLabel: string | null;
  pinnedIds: (entryId: string, kind: CanvasArtifactRef["kind"]) => boolean;
  onPin: (entry: CanvasEntry, artifact: CanvasArtifactRef) => void;
  onRecompute: (entry: CanvasEntry) => void;
  onJump: (source: TraceableSource) => void;
}

const STEP_DOT: Record<string, string> = {
  pending: "border-rule bg-transparent",
  running: "border-brand bg-brand/40",
  done: "border-brand bg-brand",
  failed: "border-alert bg-alert/40",
};

export function CanvasEntryView({
  entry,
  scope,
  mode,
  periodLabel,
  pinnedIds,
  onPin,
  onRecompute,
  onJump,
}: CanvasEntryViewProps) {
  const { t } = useTranslation();
  // Subscribed HERE rather than passed down as a prop. A streaming turn
  // mutates while `entry` stays byte-identical, so a parent-only
  // subscription lets React bail out of re-rendering this subtree and
  // the answer appears to stall. The version counter is read for its
  // side effect on reconciliation; `getLiveTurn` below is the read.
  useLiveTurnVersion();
  const scopeMatches = entry.scope === scope;

  // What an EXPORT card in this entry contains: every artifact built
  // BEFORE it, by title. The card is handed the answer rather than
  // asking for it, because the entry is the only thing that knows the
  // order the pack was assembled in.
  const manifest = useMemo(
    () =>
      entry.artifacts
        .filter((a) => a.kind !== "export")
        .map((a) => t(a.titleKey, a.titleParams)),
    [entry.artifacts, t],
  );

  return (
    <section data-testid="canvas-entry" data-entry-scope={scopeMatches ? "live" : "stale"}>
      {/* ── the question ────────────────────────────────────────────── */}
      <div className="flex justify-end">
        <p
          data-testid="canvas-question"
          className="
            max-w-[80%] rounded-[10px] bg-surface-hi
            px-3 py-1.5 text-right text-[12.5px] leading-snug text-ink
          "
        >
          {entry.command && (
            <span className="mr-1 font-mono text-[11px] text-ink-mute">
              /{entry.command}
            </span>
          )}
          {entry.question}
        </p>
      </div>

      {/* ── an attachment report ────────────────────────────────────── */}
      {entry.attachment && (
        <p
          data-testid="canvas-attachment"
          className="mt-1 text-[12px] leading-relaxed text-ink-soft"
        >
          {t(entry.attachment.detailKey)}
        </p>
      )}

      {/* ── the plan ────────────────────────────────────────────────── */}
      {entry.steps.length > 0 && (
        <ol className="mt-2 space-y-1" data-testid="canvas-steps">
          {entry.steps.map((s) => (
            <li key={s.id} className="flex items-center gap-2" data-step-status={s.status}>
              <span
                aria-hidden
                className={`h-2 w-2 shrink-0 rounded-full border ${STEP_DOT[s.status] ?? STEP_DOT.pending}`}
              />
              <span className="text-[12px] text-ink-soft">{t(s.labelKey)}</span>
            </li>
          ))}
        </ol>
      )}

      {/* ── the artifacts ───────────────────────────────────────────── */}
      {entry.artifacts.length > 0 && (
        <div className="mt-2 space-y-2">
          {entry.artifacts.map((a) => {
            const turn = getLiveTurn(a.id);
            return (
              <CanvasArtifactCard
                key={a.id}
                artifact={a}
                turn={turn}
                // BOTH halves. A matching scope with no live turn is a
                // restored record whose figures were never written down;
                // a live turn under a changed scope is one period's
                // answer over another period's page.
                stale={!scopeMatches || !turn}
                mode={mode}
                pinned={pinnedIds(a.id, a.kind)}
                onPin={(artifact) => onPin(entry, artifact)}
                onRecompute={() => onRecompute(entry)}
                onJump={onJump}
                periodLabel={periodLabel}
                manifest={a.kind === "export" ? manifest : undefined}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
