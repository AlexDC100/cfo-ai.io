// THE CANVAS — THE PANEL.
//
//   ┌───────────────────────────────────────┬─────────────────────────┐
//   │                                       │ workspace · period · ●  │
//   │                                       ├───────┬─────────────────┤
//   │          the app, still there          │ rail  │  thread ↑       │
//   │                                       │       │  (scrolls)      │
//   │                                       │       ├─────────────────┤
//   │                                       │       │  composer       │
//   └───────────────────────────────────────┴───────┴─────────────────┘
//
// A full-height RIGHT-SIDE WORKSPACE, not a dropdown. The distinction is
// not decoration: a dropdown is something you dismiss to get back to
// your work, and this is something you work ALONGSIDE. The dashboard
// stays on screen, the period stepper stays reachable, and the artifacts
// you build sit next to the statement they were built from.
//
// ══ THE THREE GEOMETRY RULES ═══════════════════════════════════════════
//
// R1  THE COMPOSER NEVER MOVES. The panel is 100dvh from the first
//     frame. Thread scrolls; composer is pinned by flex. Empty, typing,
//     streaming and answered all put the input at the same y.
// R2  MIN 480px. Below that an artifact card stops being readable — a
//     figure list wraps, a comparison visual collapses — and a canvas
//     that cannot hold an artifact is a chat window.
// R3  RESIZABLE AND REMEMBERED, by drag and by keyboard. The handle is
//     a real focusable `separator` with arrow keys, because a
//     mouse-only resize is not a resize for everyone.
//
// ══ ⌘J ═════════════════════════════════════════════════════════════════
//
// ⌘K stays the Capsule: navigation, entities, actions, and Tier-0
// answers that arrive without spending anything. ⌘J opens this. The
// split is the product's whole shape — one surface for GETTING
// SOMEWHERE, one for MAKING SOMETHING — and the Capsule keeps its speed
// precisely because generative work left it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";

import { useCapsuleKeys } from "@/components/instrument/shell/capsuleEmpty/capsuleKeys";
import { useActivePeriod } from "@/lib/activePeriod";
import {
  deleteCanvasThread,
  type CanvasArtifactRef,
  type CanvasEntry,
} from "@/lib/canvasThread";
import { factsFrom } from "@/lib/servedFacts";
import type { TraceableSource } from "@/lib/traceableSource";
import { useViewMode } from "@/lib/viewMode";

import "./canvasI18n";
// Side-effect import: fills the artifact registry. Without it the seam
// is empty and eleven finished renderers are unreachable from the app —
// the static gate's L8.
import "./canvasArtifactBridge";
import { CanvasComposer } from "./CanvasComposer";
import { CanvasEmpty } from "./CanvasEmpty";
import { CanvasEntryView } from "./CanvasEntryView";
import { CanvasRail } from "./CanvasRail";
import { getLiveTurn, useLiveTurnVersion } from "./canvasLiveTurns";
import { isPinned, toggleCanvasPin, useCanvasPins } from "./canvasPin";
import { useCanvas } from "./useCanvas";

export const CANVAS_MIN_WIDTH = 480;
/**
 * The shipped default, and why it is not the minimum.
 *
 * 480 is the floor for the PANEL. The THREAD gets the panel minus the
 * rail, so a 560px default with a 180px rail left the document 380px
 * wide — under the floor the panel declares for exactly the reason the
 * floor exists (r1/D6). The rail is now 156 and the default 620, so the
 * document opens at 464 and reaches the floor as soon as the reader
 * widens it by 16px. Below `md` the rail is an overlay and the document
 * gets the whole panel.
 */
export const CANVAS_DEFAULT_WIDTH = 620;
export const CANVAS_WIDTH_KEY = "cfo-canvas-width-v1";

export interface CanvasPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Read the remembered width, clamped. A stored value below the minimum
 *  (an older build, a hand-edited key) is corrected rather than trusted. */
function storedWidth(): number {
  try {
    const raw = Number(window.localStorage.getItem(CANVAS_WIDTH_KEY));
    if (!Number.isFinite(raw) || raw <= 0) return CANVAS_DEFAULT_WIDTH;
    return Math.max(CANVAS_MIN_WIDTH, Math.min(raw, 1100));
  } catch {
    return CANVAS_DEFAULT_WIDTH;
  }
}

const TRUST_TONE: Record<string, string> = {
  balanced: "bg-success",
  reconciled: "bg-success",
  minor_drift: "bg-caution",
  needs_review: "bg-caution",
  material_imbalance: "bg-alert",
  unverified: "bg-ink-mute",
};

const TRUST_LABEL: Record<string, string> = {
  balanced: "canvas.header.trustBalanced",
  reconciled: "canvas.header.trustAdjusted",
  minor_drift: "canvas.header.trustAdjusted",
  needs_review: "canvas.header.trustAdjusted",
  material_imbalance: "canvas.header.trustImbalance",
  unverified: "canvas.header.trustUnverified",
};

export function CanvasPanel({ open, onOpenChange }: CanvasPanelProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const mode = useViewMode();
  const activePeriod = useActivePeriod();
  const { orgKey } = useCapsuleKeys();
  const pins = useCanvasPins(orgKey);
  const canvas = useCanvas();
  useLiveTurnVersion();

  const [width, setWidth] = useState<number>(() => storedWidth());
  const [expanded, setExpanded] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  /** Below `md` the rail is a temporary overlay, off by default. */
  const [railOpen, setRailOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

  // ── the trust dot ────────────────────────────────────────────────────
  //
  // Through `factsFrom` — the ONE sanctioned gateway. Reading
  // `statements.canonical_bs` directly here would be a second opinion
  // about the same verdict, and the import-boundary gate exists to stop
  // exactly that.
  const trust = useMemo(() => {
    const statements = activePeriod.statements;
    const facts = statements ? factsFrom(statements) : null;
    if (!facts || !facts.isCanonical) return null;
    return facts.presentStatus(statements?.currency ?? "RON").band;
  }, [activePeriod.statements]);

  // ── width persistence ────────────────────────────────────────────────
  useEffect(() => {
    try {
      window.localStorage.setItem(CANVAS_WIDTH_KEY, String(width));
    } catch {
      /* private mode */
    }
  }, [width]);

  const onHandleDown = useCallback((e: React.PointerEvent) => {
    dragging.current = true;
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }, []);

  const onHandleMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const next = window.innerWidth - e.clientX;
    setWidth(Math.max(CANVAS_MIN_WIDTH, Math.min(next, Math.min(1100, window.innerWidth - 120))));
  }, []);

  const onHandleUp = useCallback(() => {
    dragging.current = false;
  }, []);

  // ── escape closes ────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return undefined;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onOpenChange(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  // ── keep the newest entry in view ────────────────────────────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [canvas.entries.length, canvas.liveVersion]);

  const jumpToSource = useCallback(
    (source: TraceableSource) => {
      const next = new URLSearchParams(params);
      next.set("tab", source.statement === "pl" ? "pnl" : source.statement);
      next.set("highlight", source.bucket);
      navigate({ pathname: "/dashboard", search: `?${next.toString()}` });
    },
    [params, navigate],
  );

  const onPin = useCallback(
    (entry: CanvasEntry, artifact: CanvasArtifactRef) => {
      toggleCanvasPin(orgKey, {
        id: `${artifact.id}:${artifact.kind}`,
        question: entry.question,
        kind: artifact.kind,
        titleKey: artifact.titleKey,
        titleParams: artifact.titleParams,
        pinnedAt: Date.now(),
        threadId: canvas.threadId,
        entryId: artifact.id,
      });
    },
    [orgKey, canvas.threadId],
  );

  // The turn the follow-up chips are computed from: the last artifact of
  // the last entry that actually has a live turn. Not "the last entry" —
  // a stale or pending one would produce chips about nothing.
  const lastTurn = useMemo(() => {
    for (let i = canvas.entries.length - 1; i >= 0; i -= 1) {
      const entry = canvas.entries[i];
      if (entry.scope !== canvas.scope) continue;
      for (let j = entry.artifacts.length - 1; j >= 0; j -= 1) {
        const turn = getLiveTurn(entry.artifacts[j].id);
        if (turn && turn.status === "done") return turn;
      }
    }
    return null;
    // `liveVersion` is the dependency that matters — the turns mutate
    // in place in module state and the entries array does not change
    // when they do.
  }, [canvas.entries, canvas.scope, canvas.liveVersion]);

  const grounding = useMemo(() => {
    const parts = [
      canvas.companyName || t("canvas.header.noWorkspace"),
      canvas.periodLabel || t("canvas.header.noPeriod"),
    ];
    return parts.join(" · ");
  }, [canvas.companyName, canvas.periodLabel, t]);

  if (!open) return null;

  return (
    <aside
      data-testid="canvas-panel"
      role="complementary"
      aria-label={t("canvas.title")}
      // ── z-45, AND THIS IS A FUNCTIONAL FIX, NOT A COSMETIC ONE ─────
      //
      // `TopHeader` is `fixed top-0 inset-x-0 z-40` and the canvas was
      // z-40 too. Equal z, and the header won: its 36px round avatar
      // (`account-menu-trigger`) painted directly on top of the canvas
      // header's close button at every viewport width. r1 and r2 both
      // recorded it as "the harness banner's dismiss circle" and both
      // were WRONG — a DOM scan for round elements near the header found
      // one, and it was the app's own avatar. Two rounds of a plausible
      // story, refuted by one measurement.
      //
      // It is not a paint bug. The avatar took the pointer, so THE
      // CANVAS COULD NOT BE CLOSED BY ITS OWN CLOSE BUTTON.
      //
      // `z-[45]` (an arbitrary value — Tailwind ships no `z-45` and the
      // config adds no zIndex scale, so the bare class would silently
      // no-op). 45 is the app's existing "above the header, below the modals"
      // rung (TopHeader uses z-45 for its own portal); Radix sheets and
      // dialogs stay above at z-50+, which is correct — a modal should
      // cover the canvas.
      className="
        fixed right-0 top-0 z-[45] flex h-[100dvh] flex-col
        border-l border-rule bg-bg
      "
      style={{ width: expanded ? "100vw" : `min(${width}px, 100vw)` }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer.files?.[0];
        if (file) canvas.attach(file);
      }}
    >
      {/* ── the resize handle ───────────────────────────────────────── */}
      {!expanded && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("canvas.resize")}
          aria-valuenow={width}
          aria-valuemin={CANVAS_MIN_WIDTH}
          tabIndex={0}
          data-testid="canvas-resize"
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") setWidth((w) => Math.min(1100, w + 24));
            if (e.key === "ArrowRight") setWidth((w) => Math.max(CANVAS_MIN_WIDTH, w - 24));
          }}
          className="
            absolute left-0 top-0 h-full w-1.5 cursor-col-resize
            hover:bg-brand/30
            focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand
          "
        />
      )}

      {/* ── the context header ──────────────────────────────────────── */}
      <header
        data-testid="canvas-header"
        className="flex shrink-0 items-center gap-2 border-b border-rule px-4 py-2.5"
      >
        {/* ── WHICH HALF SURVIVES THE TRUNCATION ─────────────────────
            r2's 390 capture read "Meridian Industries SRL · FY20…" — one
            `truncate` over both halves, so the ellipsis ate the PERIOD.
            That is the wrong half to lose: which company you are in is
            already on every other surface, while which period the
            figures below belong to is the thing this header exists to
            say. So the company name is the shrinking element and the
            period is `shrink-0`. */}
        <span className="flex min-w-0 flex-1 items-baseline gap-1 text-[12.5px] text-ink">
          <span className="min-w-0 truncate">
            {canvas.companyName || t("canvas.header.noWorkspace")}
          </span>
          <span className="shrink-0 text-ink-mute">
            {" · "}
            {canvas.periodLabel || t("canvas.header.noPeriod")}
          </span>
        </span>
        {trust && (
          <span
            className="flex shrink-0 items-center gap-1"
            data-testid="canvas-trust"
            data-trust-band={trust}
            title={t(TRUST_LABEL[trust] ?? "canvas.header.trustUnverified")}
          >
            <span
              aria-hidden
              className={`h-1.5 w-1.5 rounded-full ${TRUST_TONE[trust] ?? "bg-ink-mute"}`}
            />
            <span className="sr-only">
              {t("canvas.header.trustLabel")}:{" "}
              {t(TRUST_LABEL[trust] ?? "canvas.header.trustUnverified")}
            </span>
          </span>
        )}
        <button
          type="button"
          data-testid="canvas-rail-toggle"
          aria-label={railOpen ? t("canvas.rail.hide") : t("canvas.rail.show")}
          aria-expanded={railOpen}
          onClick={() => setRailOpen((v) => !v)}
          className="
            shrink-0 rounded-[8px] px-2 py-1 text-[13px] leading-none text-ink-soft md:hidden
            hover:bg-surface-hi hover:text-ink
            focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand
          "
        >
          <span aria-hidden>≡</span>
        </button>
        <button
          type="button"
          data-testid="canvas-expand"
          onClick={() => setExpanded((v) => !v)}
          className="
            shrink-0 rounded-[8px] px-2 py-1 text-[11px] text-ink-soft
            hover:bg-surface-hi hover:text-ink
            focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand
          "
        >
          {t("canvas.openFullPage")}
        </button>
        <button
          type="button"
          data-testid="canvas-close"
          aria-label={t("canvas.close")}
          onClick={() => onOpenChange(false)}
          className="
            shrink-0 rounded-[8px] px-2 py-1 text-[13px] leading-none text-ink-soft
            hover:bg-surface-hi hover:text-ink
            focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand
          "
        >
          <span aria-hidden>×</span>
        </button>
      </header>

      {/* ── rail + thread ───────────────────────────────────────────── */}
      <div className="flex min-h-0 flex-1">
        {/* PERSISTENT at md and up. */}
        <CanvasRail
          className="hidden md:flex"
          threads={canvas.threads}
          currentId={canvas.threadId}
          onOpen={canvas.openThread}
          onNew={canvas.newThread}
          onDelete={(id) => deleteCanvasThread(orgKey, id)}
        />
        {/* TEMPORARY below md. A 156px column on a 390px screen is 40%
            of the reader's document; the threads are still one tap away
            rather than removed. */}
        {railOpen && (
          <div className="absolute inset-0 z-20 flex md:hidden" data-testid="canvas-rail-overlay">
            <CanvasRail
              className="bg-bg"
              threads={canvas.threads}
              currentId={canvas.threadId}
              onOpen={(id) => {
                canvas.openThread(id);
                setRailOpen(false);
              }}
              onNew={() => {
                canvas.newThread();
                setRailOpen(false);
              }}
              onDelete={(id) => deleteCanvasThread(orgKey, id)}
            />
            <button
              type="button"
              aria-label={t("canvas.rail.hide")}
              onClick={() => setRailOpen(false)}
              className="flex-1 bg-bg/70"
            />
          </div>
        )}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div
            ref={scrollRef}
            data-testid="canvas-thread"
            className="chat-scroll min-h-0 flex-1 overflow-y-auto"
          >
            {canvas.entries.length === 0 ? (
              <CanvasEmpty mode={mode} onPick={canvas.submit} />
            ) : (
              // 4px row rhythm. The THREAD is tight so the CARDS can
              // breathe — that contrast is what makes this read as a
              // document rather than a transcript.
              <div className="space-y-1 px-4 py-4">
                {canvas.entries.map((entry) => (
                  <CanvasEntryView
                    key={entry.id}
                    entry={entry}
                    scope={canvas.scope}
                    mode={mode}
                    periodLabel={canvas.periodLabel}
                    pinnedIds={(entryId, kind) => isPinned(pins, entryId, kind)}
                    onPin={onPin}
                    onRecompute={canvas.recompute}
                    onJump={jumpToSource}
                  />
                ))}
              </div>
            )}
          </div>

          <CanvasComposer
            onSubmit={canvas.submit}
            onAttach={canvas.attach}
            busy={canvas.busy}
            mode={mode}
            lastTurn={lastTurn}
            grounding={grounding}
          />
        </div>
      </div>

      {/* ── the drop veil ───────────────────────────────────────────── */}
      {dragOver && (
        <div
          data-testid="canvas-dropzone"
          className="
            pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center
            border-2 border-dashed border-brand bg-bg/90 px-8 text-center
          "
        >
          <p className="text-[14px] font-medium text-ink">{t("canvas.attach.drop")}</p>
          <p className="mt-1 max-w-[42ch] text-[12px] leading-relaxed text-ink-soft">
            {t("canvas.attach.dropHint")}
          </p>
        </div>
      )}
    </aside>
  );
}
