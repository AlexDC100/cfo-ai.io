// THE CAPSULE — ZONE 3: jump.
//
// FOUR destinations, collapsed under one label, at the bottom. That is
// the whole navigation affordance of the resting surface.
//
// ── Why four, and why last ────────────────────────────────────────────
//
// The resting surface used to list every page, every action, every recent
// period and the glossary — eighteen rows of navigation shown to someone
// who had not yet said what they wanted. Navigation is not what this
// surface is FOR; it is what it must not lose. So the rest of it moved
// behind a keystroke: type anything and the full router result appears,
// instantly and for free. What stays visible is the short head of that
// list, as a reminder that jumping is still one Enter away.
//
// This component renders rows the HOST supplies. It does not know what a
// route is, does not rank them, and cannot navigate — `onPick` is the
// only way out. Ranking lives with the host because "most-used" is a
// property of the app's own nav state, not of this list.

import { useTranslation } from "react-i18next";
import type { LucideIcon } from "lucide-react";

import "./capsuleEmptyI18n";

/** Four. A fifth row is a menu, and the reader already has one of those
 *  in the rail. */
export const MAX_JUMPS = 4;

export interface CapsuleJumpItem {
  id: string;
  label: string;
  /** Where it sits in the app — the rail group, usually. Display only. */
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
}

export function CapsuleJumpList({
  items,
  onPick,
  activeIndex = -1,
  indexOffset = 0,
}: CapsuleJumpListProps) {
  const { t } = useTranslation();
  if (items.length === 0) return null;

  return (
    <div data-testid="capsule-jump">
      <div className="flex items-baseline gap-2 px-4 pb-1 pt-2.5">
        <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-ink-mute">
          {t("capsuleEmpty.jump.heading")}
        </span>
        <span className="truncate text-[10.5px] text-ink-mute/70">
          {t("capsuleEmpty.jump.hint")}
        </span>
      </div>
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
                  flex h-10 w-full items-center gap-3 px-4 text-left
                  transition-colors duration-micro
                  ${active ? "bg-bg-2" : "hover:bg-bg-2/60"}
                `}
              >
                {item.icon ? (
                  <item.icon size={15} strokeWidth={1.75} className="shrink-0 text-ink-soft" />
                ) : (
                  <span className="w-[15px] shrink-0" aria-hidden />
                )}
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                  {item.label}
                </span>
                {item.hint && (
                  <span className="shrink-0 truncate text-[11px] text-ink-mute">
                    {item.hint}
                  </span>
                )}
                {item.kbd && (
                  <kbd className="shrink-0 rounded-sm border border-rule bg-bg-2 px-1.5 py-0.5 font-mono text-[10px] text-ink-mute">
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
