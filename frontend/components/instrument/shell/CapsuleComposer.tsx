// THE CAPSULE — THE COMPOSER.
//
// Not an input. A composer: the thing at the bottom of every surface
// where a person says something to something else.
//
// ── What a form field looks like, and why this is not one ─────────────
//
// The r0 capture shows the defect in one frame: a 616px hard-bordered
// rounded rectangle with a focus ring, sitting alone at the TOP of the
// panel with the content list below it. That is a search box. A reader
// looking at it knows exactly what to do with it — type a query and get
// a list — which is the wrong promise, because this surface answers.
//
// Three changes, all of them subtraction:
//
//   · THE BOX IS GONE. The composer's only edge is a hairline along its
//     top and a 2px accent underline that grows in on focus. Nothing
//     encloses the text. The raised fill (`bg-2/40`) is what separates
//     it from the thread above, which is the same separation a chat
//     composer uses and needs no border to state.
//   · IT IS AT THE BOTTOM. Content stacks above it, in the place
//     answers appear, so the resting state is already the shape of a
//     conversation and pressing Enter relayouts nothing.
//   · IT NEVER MOVES. It is the last flex child of a card whose height
//     is animated (`capsuleHeight`), so growth travels; it does not jump.
//
// ── The verb is live ──────────────────────────────────────────────────
//
// The glyph on the left states what Enter will do, and it changes:
// Sparkles while the answer is the primary action, a magnifier the
// moment the query spells a destination exactly. The send button's
// ACCESSIBLE NAME changes with it — "Ask" or "Open Dashboard" — because
// a button that says one thing and does another is the defect the header
// lane already fixed once on the trigger's aria-label (K1-d).
//
// ── ⌘↵ says what it does ──────────────────────────────────────────────
//
// The brief asked for a ⌘↵ hint beside the send affordance. ⌘↵ on this
// surface does NOT send — it hands the thread to the full chat page.
// A bare "⌘↵" glyph next to a send button reads as "this is how you
// send", so the hint carries its two words. It appears only while the
// composer is focused AND non-empty, which is the only moment the
// binding is reachable.

import { forwardRef, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUp, Search, Sparkles } from "lucide-react";

import "./capsuleCraftI18n";
import "./capsuleEmpty/capsuleEmptyI18n";

export interface CapsuleComposerProps {
  value: string;
  onChange: (next: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  /** Pressed the send affordance — the same action Enter runs. */
  onSubmit: () => void;
  placeholder: string;
  /** True when Enter would NAVIGATE rather than answer. Drives the glyph
   *  and the send button's accessible name. */
  jumps: boolean;
  /** Where Enter would go, for the send button's name. */
  jumpTarget?: string;
  /** `capsule-composer` at rest, `capsule-followup` once a thread is
   *  open — one element, and both names are load-bearing elsewhere. */
  testId: string;
  ariaLabel: string;
  activeDescendant?: string;
  focused: boolean;
  onFocusChange: (focused: boolean) => void;
  /** Chips that belong to the next thing the reader could say. Rendered
   *  ABOVE the input, inside the composer block, so they travel with it. */
  above?: ReactNode;
  /** The key legend. BELOW the input row, at the card's bottom edge —
   *  above it, it read as a floating label stranded between the content
   *  and the box it described. */
  below?: ReactNode;
  disabled?: boolean;
}

export const CapsuleComposer = forwardRef<HTMLTextAreaElement, CapsuleComposerProps>(
  function CapsuleComposer(
    {
      value,
      onChange,
      onKeyDown,
      onSubmit,
      placeholder,
      jumps,
      jumpTarget,
      testId,
      ariaLabel,
      activeDescendant,
      focused,
      onFocusChange,
      above,
      below,
      disabled,
    },
    ref,
  ) {
    const { t } = useTranslation();
    const filled = value.trim().length > 0;
    const sendLabel =
      jumps && jumpTarget
        ? t("capsuleCraft.composer.go", { target: jumpTarget })
        : t("capsuleCraft.composer.send");

    return (
      <div
        data-testid="capsule-composer-block"
        data-focused={focused ? "true" : undefined}
        className="
          relative shrink-0 border-t border-rule-soft
          bg-[hsl(var(--bg-2)/0.45)]
        "
      >
        {above}

        <div className="flex items-end gap-2.5 px-3.5 pb-2.5 pt-2.5">
          {/* THE VERB, as one glyph. Same family as the header trigger's,
              so the control and the surface it opens agree. */}
          {jumps ? (
            <Search
              size={16}
              strokeWidth={1.75}
              data-testid="capsule-verb-icon"
              data-verb="jump"
              aria-hidden
              className="mb-[9px] shrink-0 text-ink-soft"
            />
          ) : (
            <Sparkles
              size={16}
              strokeWidth={1.75}
              data-testid="capsule-verb-icon"
              data-verb="ask"
              aria-hidden
              className={`mb-[9px] shrink-0 transition-colors duration-micro ${
                filled ? "text-brand" : "text-ink-soft"
              }`}
            />
          )}

          <textarea
            ref={ref}
            rows={1}
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={() => onFocusChange(true)}
            onBlur={() => onFocusChange(false)}
            placeholder={placeholder}
            aria-label={ariaLabel}
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-list"
            aria-activedescendant={activeDescendant}
            data-testid={testId}
            // 15px and leading-7: the brief's "generous line-height,
            // visible cursor". `max-h-[84px]` is three of those lines,
            // after which it scrolls rather than growing further — the
            // card must not be pushed off the screen by a paragraph.
            // ── WHERE THE HARD-BORDERED BOX ACTUALLY CAME FROM ──────
            //
            // Not from this file, and not from the file it replaced.
            // `index.css` carries a global
            //     :where(… textarea …):focus-visible {
            //       box-shadow: var(--ring-focus); border-radius: … }
            // and this composer AUTOFOCUSES the moment the surface
            // opens — so the ring was on in every screenshot ever taken
            // of this surface, permanently, and read as a 616px
            // rounded-rectangle border around the input. That is the
            // "it reads as a FORM FIELD" complaint, and rewriting the
            // markup without this line would not have touched it.
            //
            // `:where()` contributes ZERO specificity, so the global
            // selector is (0,1,0) and a single utility class beats it.
            // The stylesheet itself is another lane's file and is not
            // edited.
            //
            // THE FOCUS INDICATOR IS NOT LOST, it is replaced: the 2px
            // accent underline below animates in on `focused`, spans
            // the composer's full width, and is joined by a brand
            // caret. WCAG 2.4.7 wants a visible focus indicator, not a
            // box.
            className="
              max-h-[84px] min-h-[28px] flex-1 resize-none bg-transparent
              py-0.5 text-[15px] leading-7 text-ink caret-brand
              placeholder:text-ink-soft outline-none
              focus-visible:shadow-none focus:shadow-none
            "
          />

          {/* ⌘↵ — only while it is reachable, and it says what it does. */}
          <span
            aria-hidden
            data-testid="capsule-fullchat-hint"
            className={`
              mb-[7px] hidden shrink-0 items-center gap-1 text-[10px] text-ink-soft
              transition-opacity duration-micro sm:inline-flex
              ${focused && filled ? "opacity-100" : "pointer-events-none opacity-0"}
            `}
          >
            <kbd className="rounded-sm border border-rule bg-bg px-1 py-px font-mono text-[9.5px]">
              ⌘↵
            </kbd>
            {t("capsuleCraft.composer.fullChatKeys")}
          </span>

          {/* SEND — the pointer's half of Enter. Quiet until there is
              something to send, so it never advertises an empty action. */}
          <button
            type="button"
            onClick={onSubmit}
            disabled={!filled || disabled}
            aria-label={sendLabel}
            data-testid="capsule-send"
            data-armed={filled ? "true" : "false"}
            className={`
              mb-1 inline-flex h-7 w-7 shrink-0 items-center justify-center
              rounded-lg transition-all duration-micro
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
              ${
                filled
                  // `text-bg`, the app's one convention for a brand fill
                  // (UploadDialog, SourceFilesRow, sonner). Light theme:
                  // near-white on #0E7C6B. Dark: near-black on the teal.
                  ? "bg-brand text-bg hover:brightness-110"
                  : "bg-bg-2 text-ink-mute"
              }
            `}
          >
            <ArrowUp size={14} strokeWidth={2.25} />
          </button>
        </div>

        {below}

        {/* THE ONE EDGE. A hairline the accent grows over on focus —
            drawn ON the border rather than beside it, so nothing in the
            card moves when it appears. */}
        <span
          aria-hidden
          data-testid="capsule-underline"
          className={`
            pointer-events-none absolute bottom-0 left-0 h-[2px] bg-brand
            transition-all duration-overlay ease-quint motion-reduce:transition-none
            ${focused || filled ? "w-full opacity-100" : "w-0 opacity-0"}
          `}
        />
      </div>
    );
  },
);
