// THE CAPSULE — ZONE 3: jump.
//
// Destinations under one label. This component renders rows the HOST
// supplies. It does not know what a route is, does not rank them, and
// cannot navigate — `onPick` is the only way out. Ranking lives with the
// host because "most-used" is a property of the app's own nav state.
//
// ══ THE CRAFT PASS ════════════════════════════════════════════════════
//
// TWO subtractions, both of them things the r0 capture proved carry no
// information at this size:
//
//   · THE CATEGORY LABEL IS GONE. Every row printed its rail group
//     right-aligned and muted — "Dashboard … Overview", "Scenarios …
//     Analyze". Four rows, four labels, two distinct values, and the
//     reader is choosing between four NAMED places they already
//     recognise. The label answered a question nobody asked and gave
//     every row a second focal point at the far end of a 680px line.
//     `hint` survives in the type only because the host's own result
//     rows (companies, SKUs) genuinely disambiguate with it; this
//     list's four destinations never did.
//   · THE ROWS ARE 36px, not 40. Combined with the chips above them,
//     that is the density difference that stops the surface reading as
//     one undifferentiated list.
//
// The selected row wears an ACCENT LEFT RULE and a quiet fill, not a
// heavy block highlight: the rule states position, the fill states
// warmth, and neither of them shouts over the four labels the reader is
// actually comparing.

import { useTranslation } from "react-i18next";
import type { LucideIcon } from "lucide-react";

import "./capsuleEmptyI18n";

/** Four. A fifth row is a menu, and the reader already has one of those
 *  in the rail. */
export const MAX_JUMPS = 4;

export interface CapsuleJumpItem {
  id: string;
  label: string;
  /** Where it sits in the app — the rail group, usually. NOT RENDERED by
   *  this list (see the header); kept because the host's own rows share
   *  the type and do render it. */
  hint?: string;
  icon?: LucideIcon;
  /** Right-aligned shortcut hint. Display only; the host owns the binding. */
  kbd?: string;
}

export interface CapsuleJumpListProps {
  items: readonly CapsuleJumpItem[];
  onPick: (item: CapsuleJumpItem) => void;
  activeIndex?: number;
  indexOffset?: number;
  /** The section label above the rows. The host suppresses it at rest,
   *  where navigation is not what the surface is offering. */
  heading?: boolean;
}

export function CapsuleJumpList({
  items,
  onPick,
  activeIndex = -1,
  indexOffset = 0,
  heading = true,
}: CapsuleJumpListProps) {
  const { t } = useTranslation();
  if (items.length === 0) return null;

  return (
    <div data-testid="capsule-jump">
      {heading && (
        <div
          data-testid="capsule-section-label"
          className="px-4 pb-2 pt-5 text-[10px] font-medium uppercase tracking-[0.14em] text-ink-soft"
        >
          {t("capsuleEmpty.jump.heading")}
        </div>
      )}
      <ul>
        {items.slice(0, MAX_JUMPS).map((item, i) => {
          const idx = indexOffset + i;
          const active = idx === activeIndex;
          return (
            <li key={item.id}>
              <button
                type="button"
                data-testid="capsule-jump-row"
                data-idx={idx}
                role="option"
                aria-selected={active}
                onClick={() => onPick(item)}
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
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">
                  {item.label}
                </span>
                {item.kbd && (
                  <kbd className="shrink-0 rounded-sm border border-rule bg-bg-2 px-1.5 py-0.5 font-mono text-[10px] text-ink-soft">
                    {item.kbd}
                  </kbd>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
