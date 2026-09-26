// cmdbarRows.ts — the rows the keyboard walks, in the order they paint.
// One flat list per state; the component renders it under group headings
// and `activeIdx` indexes into it, so ↑↓ can never select a row the reader
// cannot see.

import type { AccountView, FigureView, NowActionView, NowItemView } from "./cmdbarViews";
import type { CmdbarRecent } from "./cmdbarRecents";

/** Every row kind the bar can paint — the family list the craft gate
 *  (scripts/check_capsule_craft.mjs F2b) holds the live spec's
 *  FAMILY_EXPECT table to, so a kind added here without a live
 *  expectation reds there. */
export const CMDBAR_ROW_KINDS = [
  "now",
  "now-action",
  "recent",
  "answer",
  "account",
  "page",
  "action",
  "ask",
] as const;

export type BarRow =
  | { kind: "now"; id: string; view: NowItemView }
  | { kind: "now-action"; id: string; view: NowActionView }
  | { kind: "recent"; id: string; recent: CmdbarRecent }
  | { kind: "answer"; id: string; view: FigureView }
  | { kind: "account"; id: string; view: AccountView }
  | { kind: "page"; id: string; label: string; href: string }
  | { kind: "action"; id: string; label: string }
  | { kind: "ask"; id: string; query: string };

/** The group heading a row runs under (a heading, never a per-row label). */
export type BarSection = "now" | "nowActions" | "recent" | "answer" | "account" | "page" | "action" | "ask";

export function sectionOf(row: BarRow): BarSection {
  switch (row.kind) {
    case "now": return "now";
    case "now-action": return "nowActions";
    case "recent": return "recent";
    default: return row.kind;
  }
}

export function rowDomId(idx: number): string {
  return `cmdbar-row-${idx}`;
}
