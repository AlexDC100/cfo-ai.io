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
//
// ── AND THERE IS NO `trailing` EITHER (2026-08-31) ───────────────────
//
// The round that deleted `hint` kept one escape hatch: `trailing`, a
// ReactNode "the row's own domain owns", defended in this file's own
// comment as "a VALUE, not the name of the group the row is filed
// under". Two call sites used it, both passing `<BucketChip>`.
//
// Measured on the shipped build, across a 29-query sweep at both
// viewports: 20 rows at 1440 and 20 at 390 carried a right-aligned
// trailing word, and EVERY ONE of them was one of those two call sites.
// Typing `range` at 1440 put nine rows on screen and nine of nine ended
// in a muted word 495-524 glyph-pixels from their label. Typing `core`
// put four Product rows on screen and ALL FOUR said the identical word
// "Protect".
//
// Four rows saying one word IS the name of a group. The defence was
// wrong on its own terms: a bucket is a value the way a category is a
// value — it takes a handful of values across the whole catalogue, so it
// partitions the list rather than identifying a row in it. The reader
// typing "core" is looking for a SKU, and every SKU they can see is
// wearing the same badge.
//
// So the field is gone, not re-homed. It is not a qualifier either: a
// qualifier earns its ink by DISTINGUISHING one row from a
// same-named sibling (see `CommandPalette`'s collision pass), and
// "Protect" on four consecutive rows distinguishes nothing. The bucket
// is one click away on `/products`, where it sits in a column that IS a
// column, next to the numbers that give it meaning.
//
// It did not become `searchText` either. It never was matchable — it
// only ever rendered — so making it matchable now would be a new feature
// wearing a cleanup's clothes.
//
// ── `data-row-family` ────────────────────────────────────────────────
//
// Every row DECLARES the family it belongs to, and the stamp is
// required by the type rather than sniffed from the id. The reason is
// the same one that produced `data-row-source` one axis over: G4 ran a
// nine-query sweep, reported ZERO offenders, and its own predicate
// called all 20 of the rows above offenders — because not one of those
// nine queries summons a Product row. "The sweep never reached it"
// moved from COMPONENTS to QUERIES and produced the same false green.
//
// A gate can now assert a recorded expectation PER FAMILY, so a family
// that stops being summoned FAILS instead of scoring zero. Adding a new
// family to the palette breaks the build until it is declared here, and
// then breaks the gate until the gate records what it expects of it.

import type { LucideIcon } from "lucide-react";

/** Every kind of row the palette can paint. Adding one is a type error
 *  everywhere until it is listed here AND given a recorded expectation
 *  in `e2e/design/capsule-craft.spec.ts`'s G4 sweep. */
export const CAPSULE_ROW_FAMILIES = [
  "page",     // a rail destination or Settings
  "action",   // upload / export / theme / ask / rail toggle
  "glossary", // the metric glossary opener
  "period",   // switch to a recent period
  "category", // a product category
  "sku",      // one SKU
  "concept",  // a metric from the concept catalogue
  "company",  // a listed company
] as const;

export type CapsuleRowFamily = (typeof CAPSULE_ROW_FAMILIES)[number];

export interface CapsulePaletteRowItem {
  id: string;
  group: string;
  /** REQUIRED. See `data-row-family` in the header — a row that cannot
   *  name its family is a row no census can hold to an expectation. */
  family: CapsuleRowFamily;
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
      data-row-family={item.family}
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
      {item.kbd && (
        <kbd className="shrink-0 rounded-sm border border-rule bg-bg-2 px-1.5 py-0.5 font-mono text-[10px] text-ink-soft">
          {item.kbd}
        </kbd>
      )}
    </button>
  );
}
