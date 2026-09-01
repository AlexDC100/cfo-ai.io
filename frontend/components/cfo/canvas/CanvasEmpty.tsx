// THE CANVAS — THE EMPTY STATE.
//
// Three suggestions, computed from THIS workspace's state, and never a
// starter list. If the state yields two, two render. If it yields none,
// none render and the surface says why — because the one thing an empty
// canvas may not do is print plausible-looking filler that has nothing
// to do with the company on screen.
//
// The engine for that already exists and is already gated:
// `lib/capsuleSuggestions.buildCapsuleSuggestions` (pure, deterministic,
// S1–S4) fed by `capsuleEmpty/useCapsuleSnapshot` (the one hook that
// reads live app state for it). This component reuses BOTH rather than
// growing a second opinion about what is interesting in a workspace —
// two surfaces suggesting different things from the same data would be
// a bug the reader could see.
//
// What is different here is only the shape: the canvas has room, so each
// suggestion carries its BASIS line — the honest sentence about where it
// came from. In the Capsule's overlay that line lives behind a hover.
//
// ══ NO FIGURE APPEARS IN A SUGGESTION ══════════════════════════════════
//
// S1, inherited: a suggestion is a QUESTION. Every interpolated label
// has already passed `looksLikeFigure` upstream, and this component adds
// no interpolation of its own.

import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import "@/components/instrument/shell/capsuleEmpty/capsuleEmptyI18n";
import { useCapsuleSnapshot } from "@/components/instrument/shell/capsuleEmpty/useCapsuleSnapshot";
import { buildCapsuleSuggestions } from "@/lib/capsuleSuggestions";
import type { ViewMode } from "@/lib/viewMode";

import "./canvasI18n";
import { CANVAS_SLASH_COMMANDS } from "./canvasSlash";

export interface CanvasEmptyProps {
  mode: ViewMode;
  onPick: (question: string) => void;
}

export function CanvasEmpty({ mode, onPick }: CanvasEmptyProps) {
  const { t } = useTranslation();
  const { snapshot } = useCapsuleSnapshot();

  const suggestions = useMemo(
    () => buildCapsuleSuggestions(snapshot, mode),
    [snapshot, mode],
  );

  // Simple mode gets ONE suggested action; Pro gets the full set. Same
  // rule the composer's chips follow, so the dial means one thing across
  // the surface.
  const shown = mode === "simple" ? suggestions.slice(0, 1) : suggestions;

  return (
    <div className="px-4 py-6" data-testid="canvas-empty">
      <h3 className="text-[15px] font-medium tracking-tight text-ink">
        {t("canvas.empty.title")}
      </h3>
      <p className="mt-1 max-w-[46ch] text-[12.5px] leading-relaxed text-ink-soft">
        {t("canvas.empty.lead")}
      </p>

      {shown.length > 0 ? (
        <ul className="mt-4 space-y-2" data-testid="canvas-suggestions">
          {shown.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                data-testid="canvas-suggestion"
                data-suggestion-kind={s.kind}
                onClick={() => onPick(t(s.labelKey, s.labelParams))}
                className="
                  w-full rounded-[10px] border border-rule bg-surface px-3 py-2 text-left
                  hover:border-rule-strong
                  focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand
                "
              >
                <span className="block text-[12.5px] leading-snug text-ink">
                  {t(s.labelKey, s.labelParams)}
                </span>
                {/* THE BASIS LINE. Every suggestion names where it came
                    from, so "why is it asking me this" is answerable
                    without opening anything. */}
                <span className="mt-0.5 block text-[11px] leading-snug text-ink-mute">
                  {t(s.basisKey, s.labelParams)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-[12.5px] text-ink-soft" data-testid="canvas-empty-nostate">
          {t("canvas.empty.noState")}
        </p>
      )}

      {/* ── the commands ────────────────────────────────────────────
          THE ONE PIECE OF STATIC COPY ON THIS SURFACE, and it earns its
          place by being a REFERENCE rather than a suggestion: it tells
          you what the surface can do, it does not pretend to know what
          you should ask.
          It is hidden below `sm`. r1's 390 capture showed six static
          rows sitting under ONE computed suggestion — the priority
          inverted, boilerplate outweighing the thing the workspace
          actually said. On a phone the one-line hint does the same job,
          and typing "/" opens the full menu above the composer. */}
      <p className="mt-6 text-[10px] uppercase tracking-[0.14em] text-ink-mute sm:hidden">
        {t("canvas.empty.slashLeadShort")}
      </p>
      <p className="mt-6 hidden text-[10px] uppercase tracking-[0.14em] text-ink-mute sm:block">
        {t("canvas.empty.slashLead")}
      </p>
      <ul className="mt-1.5 hidden space-y-0.5 sm:block" data-testid="canvas-empty-commands">
        {CANVAS_SLASH_COMMANDS.map((c) => (
          <li key={c.id} className="flex items-baseline gap-2">
            <span className="font-mono text-[11.5px] text-ink-soft">{t(c.labelKey)}</span>
            <span className="truncate text-[11.5px] text-ink-mute">{t(c.hintKey)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
