// THE CAPSULE — ONE RESULT ROW.
//
// Extracted out of `CommandPalette.tsx` for a reason that cost this
// surface a whole round: the category column was removed from
// `CapsuleJumpList` — which renders ZERO rows in the state that was
// complained about — while `CommandPalette`'s own inline `renderRow`,
// the thing that actually paints those rows, kept it. 13 rows, 13
// trailing category words, and a jsdom test that drove the wrong
// component reported the fix as landed.
//
// A row renderer that lives in its own file can be driven directly by a
// test, and it can stamp its own identity into the DOM. Both are here.
//
// ── `data-row-source` ────────────────────────────────────────────────
//
// Every row this file paints carries `data-row-source="palette-row"`.
// `CapsuleJumpList` stamps `jump-row`, `CapsuleSuggestionList` stamps
// `suggestion`. A gate can then census rows BY THE COMPONENT THAT
// RENDERED THEM and print the tally, so "the fix was applied to a
// component that renders nothing here" is a zero on a line rather than
// an invisible assumption.
//
// ── NO TRAILING CATEGORY COLUMN ──────────────────────────────────────
//
// The row used to end in a right-aligned muted word: the rail group for
// a page ("Dashboard … Overview"), the concept's category for a metric
// ("Free cash flow … Cash Flow"), the literal word "Category" for a
// product category, "Switch period" repeated down every period row under
// a section already labelled RECENT PERIODS. Measured on the shipped
// build: 13 of 13 rows in the typing state at 1440 carried one, and 13
// of 13 at 390.
//
// It is gone, and the field it came from is gone with it. What a row
// needs in order to be RECOGNISED — a company's ticker, when the label
// is the company's name — is a `qualifier`, and a qualifier renders
// INLINE, immediately after the label, inside the same truncating line.
// The distinction is not cosmetic:
//
//   · a COLUMN parks a second word against the right edge of a 680px
//     row. Every row then has two focal points at the same two x
//     positions, which is what makes eight different choices read as one
//     undifferentiated list — the complaint, exactly;
//   · a QUALIFIER is part of the row's name. "Banca Transilvania · TLV"
//     is one phrase the eye reads left to right and stops reading when
//     it has found its row.
//
// The old field was called `hint`, and "hint" is what let it hold a
// category on one row and an identity on the next. There is no `hint`
// here. A string that is only for MATCHING is `searchText` and is never
// rendered; a string that is part of the row's name is `qualifier` and
// is never right-aligned.

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export interface CapsulePaletteRowItem {
  id: string;
  group: string;
  label: string;
  /**
   * Part of the row's NAME, rendered inline after the label. A ticker, a
   * disambiguator — never a category, never a section, never a verb the
   * section label above already said.
   */
  qualifier?: string;
  /**
   * Extra text the filter matches against. NEVER RENDERED. It exists so
   * a row can be reachable by a word that is not on screen without that
   * word claiming screen space.
   */
  searchText?: string;
  icon?: LucideIcon;
  /** A key cap ("⌘J"). Right-aligned, and permitted: it names a
   *  keystroke, which is not a category and is different on every row
   *  that has one. */
  kbd?: string;
  /** A trailing node the row's own domain owns — the products bucket
   *  chip. Permitted for the same reason: it is a VALUE, not the name of
   *  the group the row is filed under. */
  trailing?: ReactNode;
  destination?: boolean;
  exactTokens?: readonly string[];
  run: () => void;
}

export interface CapsulePaletteRowProps {
  item: CapsulePaletteRowItem;
  /** Flat index across every list the host keeps in one keyboard order. */
  index: number;
  active: boolean;
  onActivate: (index: number) => void;
}

/** ONE 36px ROW. Selection is an accent left rule plus a quiet fill,
 *  never a heavy block highlight. */
export function CapsulePaletteRow({
  item,
  index,
  active,
  onActivate,
}: CapsulePaletteRowProps) {
  return (
    <button
      id={`palette-item-${index}`}
      data-idx={index}
      data-row-source="palette-row"
      role="option"
      aria-selected={active}
      onClick={() => item.run()}
      onMouseEnter={() => onActivate(index)}
      className={`
        relative flex h-9 w-full items-center gap-3 pl-4 pr-3 text-left
        transition-colors duration-micro
        ${active ? "bg-bg-2/70" : "hover:bg-bg-2/40"}
      `}
    >
      {active && (
        <span
          aria-hidden
          data-testid="capsule-row-rule"
          className="absolute inset-y-0 left-0 w-[2px] bg-brand"
        />
      )}
      {item.icon ? (
        <item.icon
          size={14}
          strokeWidth={1.75}
          className={`shrink-0 ${active ? "text-brand" : "text-ink-soft"}`}
        />
      ) : (
        <span className="w-[14px] shrink-0" aria-hidden />
      )}
      {/* ONE LINE, ONE FOCAL POINT. The qualifier lives inside the same
          truncating span as the label, so it cannot acquire its own
          right-hand column no matter how short the label gets. */}
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">
        {item.label}
        {item.qualifier && (
          <span data-testid="capsule-row-qualifier" className="text-ink-soft">
            {" · "}
            {item.qualifier}
          </span>
        )}
      </span>
      {item.trailing}
      {item.kbd && (
        <kbd className="shrink-0 rounded-sm border border-rule bg-bg-2 px-1.5 py-0.5 font-mono text-[10px] text-ink-soft">
          {item.kbd}
        </kbd>
      )}
    </button>
  );
}
