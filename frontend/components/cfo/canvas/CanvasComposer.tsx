// THE CANVAS — THE COMPOSER.
//
// DOCKED AT THE BOTTOM, and it never moves. That is the flip, applied
// correctly: the Capsule's composer sits at the bottom of an overlay
// that GROWS, so the input travels down the screen as an answer arrives.
// Here the panel is full height from the first frame, the thread scrolls
// above, and the input's y never changes between empty, typing,
// streaming and answered.
//
// A moving text field is a small thing that costs a lot: it breaks the
// muscle memory of "click there, type", it makes every screenshot of the
// surface look different, and it guarantees layout shift on the exact
// frame the reader is trying to read.
//
// ══ WHAT SITS ABOVE IT ═════════════════════════════════════════════════
//
// Follow-up chips, computed from the last artifact's OWN evidence
// (`buildFollowUps`) — not a static list. A chip that says "compare with
// November" exists because the evidence has a November fact in it. Where
// the evidence supports nothing further, no chips render, and the input
// is the escape hatch.
//
// And the slash menu, when the input starts with "/". It is a menu, not
// an autocomplete: it lists what exists and gets out of the way.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  buildFollowUps,
  type CapsuleFollowUp,
} from "@/components/instrument/shell/capsuleAnswer/capsuleFollowUps";
import type { CapsuleTurn } from "@/components/instrument/shell/capsuleAnswer/capsuleAnswerClient";
import type { ViewMode } from "@/lib/viewMode";

import "./canvasI18n";
import { canvasSlashMenu, parseCanvasSlash } from "./canvasSlash";

export interface CanvasComposerProps {
  onSubmit: (text: string) => void;
  onAttach: (file: File) => void;
  busy: boolean;
  mode: ViewMode;
  /** The most recent finished turn, for the follow-up chips. */
  lastTurn: CapsuleTurn | null;
  /** Grounding line: workspace · period. Reviewed copy, no figures. */
  grounding: string;
}

/** Simple mode gets ONE suggested action; Pro gets the full set. */
function capChips(chips: CapsuleFollowUp[], mode: ViewMode): CapsuleFollowUp[] {
  return mode === "simple" ? chips.slice(0, 1) : chips;
}

export function CanvasComposer({
  onSubmit,
  onAttach,
  busy,
  mode,
  lastTurn,
  grounding,
}: CanvasComposerProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Auto-grow, bounded. The composer may get taller as you type a long
  // question — but its BOTTOM edge is pinned by the flex layout, so the
  // growth pushes the thread up rather than moving the input down.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 148)}px`;
  }, [value]);

  const menu = useMemo(() => canvasSlashMenu(value), [value]);
  const parsed = useMemo(() => parseCanvasSlash(value), [value]);

  const chips = useMemo(() => {
    if (!lastTurn || lastTurn.status !== "done") return [];
    return capChips(
      buildFollowUps({
        evidence: lastTurn.evidence,
        citedFacts: lastTurn.citedFacts,
        deterministic: lastTurn.deterministic,
        degraded: Boolean(lastTurn.degraded),
        tier0: lastTurn.tier0,
      }),
      mode,
    );
  }, [lastTurn, mode]);

  const send = useCallback(
    (text: string) => {
      const q = text.trim();
      if (!q || busy) return;
      onSubmit(q);
      setValue("");
    },
    [busy, onSubmit],
  );

  return (
    <div
      data-testid="canvas-composer-block"
      className="shrink-0 border-t border-rule bg-bg px-4 pb-3 pt-2"
    >
      {/* ── follow-up chips ─────────────────────────────────────────── */}
      {chips.length > 0 && (
        <div className="mb-2" data-testid="canvas-followups">
          {mode === "simple" && (
            <p className="mb-1 text-[10px] uppercase tracking-[0.14em] text-ink-mute">
              {t("canvas.simple.one")}
            </p>
          )}
          <div className="flex flex-wrap gap-1.5">
            {chips.map((c) => (
              <button
                key={c.id}
                type="button"
                data-testid="canvas-followup"
                onClick={() => send(t(c.labelKey, c.labelParams))}
                className="
                  rounded-[8px] border border-rule px-2.5 py-1
                  text-[11.5px] text-ink-soft
                  hover:border-rule-strong hover:text-ink
                  focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand
                "
              >
                {t(c.labelKey, c.labelParams)}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── the slash menu ──────────────────────────────────────────── */}
      {menu.length > 0 && (
        <ul className="mb-2 space-y-0.5" data-testid="canvas-slash-menu">
          {menu.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                data-testid="canvas-slash-item"
                onClick={() => {
                  setValue(`/${c.id} `);
                  inputRef.current?.focus();
                }}
                className="
                  flex w-full items-baseline gap-2 rounded-[8px] px-2 py-1 text-left
                  hover:bg-surface-hi
                  focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand
                "
              >
                <span className="font-mono text-[12px] text-ink">{t(c.labelKey)}</span>
                <span className="truncate text-[11.5px] text-ink-soft">{t(c.hintKey)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* ── the inline hint for a command awaiting its subject ──────── */}
      {parsed && !parsed.ready && (
        <p className="mb-1.5 text-[11.5px] text-ink-soft" data-testid="canvas-slash-hint">
          {t(parsed.command.hintKey)}
        </p>
      )}

      {/* ── the input row ───────────────────────────────────────────── */}
      <div
        className="
          flex items-end gap-2 rounded-[10px] border border-rule bg-surface
          px-2 py-1.5
          focus-within:border-rule-strong
        "
      >
        <button
          type="button"
          data-testid="canvas-attach"
          aria-label={t("canvas.composer.attach")}
          onClick={() => fileRef.current?.click()}
          className="
            shrink-0 rounded-[8px] px-2 py-1 text-[13px] text-ink-soft
            hover:bg-surface-hi hover:text-ink
            focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand
          "
        >
          {/* Plain glyph rather than an icon dependency — one character,
              two themes, no import. */}
          <span aria-hidden>+</span>
        </button>
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          data-testid="canvas-file-input"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onAttach(f);
            e.target.value = "";
          }}
        />
        <textarea
          ref={inputRef}
          data-testid="canvas-composer"
          rows={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(value);
            }
          }}
          placeholder={
            mode === "simple"
              ? t("canvas.composer.placeholderSimple")
              : t("canvas.composer.placeholder")
          }
          // `min-w-0`, and NOT `w-full`. A flex item's default
          // `min-width:auto` refuses to shrink below its content, so at
          // 390 the row's other children held their intrinsic widths and
          // the TEXT FIELD was the one that lost — measured at ~40px,
          // with the placeholder wrapping over five lines. `w-full`
          // made it worse by asserting 100% of a box it was
          // simultaneously being squeezed out of.
          className="
            min-h-[24px] min-w-0 flex-1 resize-none bg-transparent
            text-[13px] leading-relaxed text-ink outline-none
            placeholder:text-ink-mute
          "
        />
        <button
          type="button"
          data-testid="canvas-send"
          disabled={!value.trim() || busy}
          onClick={() => send(value)}
          className="
            shrink-0 rounded-[8px] bg-brand px-2.5 py-1
            text-[11.5px] font-medium text-bg
            disabled:opacity-40
            focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand
          "
        >
          {t("canvas.composer.send")}
        </button>
      </div>

      {/* ── grounding ───────────────────────────────────────────────── */}
      <p className="mt-1.5 truncate text-[11px] text-ink-mute" data-testid="canvas-grounding">
        {grounding}
      </p>
    </div>
  );
}
