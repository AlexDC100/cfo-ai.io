// THE CANVAS — THE THREAD RAIL.
//
// Quiet on purpose. It is a list of documents you have built for this
// company, and it must not compete with the document you are looking at:
// no background of its own, no icons, one hairline separating it from
// the thread, and the delete affordance appears on hover rather than
// sitting on every row waiting to be misclicked.
//
// PER WORKSPACE. The rail reads `lib/canvasThread`'s org-scoped store,
// so a RON manufacturer's threads never appear inside a EUR property
// vehicle — the same split §16 Milestone C applies to company
// preferences, for the same reason: carrying one company's material into
// another's screen is not a cosmetic bug.
//
// Titles are DERIVED, never generated: `deriveCanvasTitle` is a pure
// string transform of the first question. A model call to name a
// conversation would be paying for chrome.

import { useTranslation } from "react-i18next";

import { useActiveLocale } from "@/lib/locale";
import type { CanvasThread } from "@/lib/canvasThread";

import "./canvasI18n";

export interface CanvasRailProps {
  threads: readonly CanvasThread[];
  currentId: string;
  onOpen: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  /** Placement is the PANEL's decision, not the rail's — it is a
   *  persistent column at md and up, and a temporary overlay below,
   *  where a fixed 180px column would take 46% of a 390px screen. */
  className?: string;
}

export function CanvasRail({
  threads,
  currentId,
  onOpen,
  onNew,
  onDelete,
  className = "",
}: CanvasRailProps) {
  const { t } = useTranslation();
  const locale = useActiveLocale();

  return (
    <nav
      data-testid="canvas-rail"
      aria-label={t("canvas.rail.title")}
      className={`flex w-[156px] shrink-0 flex-col border-r border-rule ${className}`}
    >
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-[10px] uppercase tracking-[0.14em] text-ink-mute">
          {t("canvas.rail.title")}
        </span>
        <button
          type="button"
          data-testid="canvas-new-thread"
          onClick={onNew}
          aria-label={t("canvas.rail.new")}
          className="
            rounded-[8px] px-1.5 py-0.5 text-[13px] leading-none text-ink-soft
            hover:bg-surface-hi hover:text-ink
            focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand
          "
        >
          <span aria-hidden>+</span>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {threads.length === 0 ? (
          <p className="px-1.5 py-1 text-[11.5px] leading-snug text-ink-mute">
            {t("canvas.rail.empty")}
          </p>
        ) : (
          <ul className="space-y-px">
            {threads.map((th) => {
              const active = th.id === currentId;
              return (
                <li key={th.id} className="group relative">
                  <button
                    type="button"
                    data-testid="canvas-thread-row"
                    data-thread-active={active ? "1" : "0"}
                    onClick={() => onOpen(th.id)}
                    className={`
                      w-full rounded-[8px] px-2 py-1.5 pr-6 text-left
                      focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand
                      ${active ? "bg-surface-hi" : "hover:bg-surface"}
                    `}
                  >
                    <span
                      className={`block truncate text-[12px] leading-snug ${
                        active ? "text-ink" : "text-ink-soft"
                      }`}
                    >
                      {th.title || t("canvas.rail.untitled")}
                    </span>
                    <span className="mt-0.5 block truncate text-[10px] text-ink-mute">
                      {new Date(th.updatedAt).toLocaleDateString(locale, {
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                  </button>
                  <button
                    type="button"
                    data-testid="canvas-thread-delete"
                    aria-label={t("canvas.rail.delete")}
                    onClick={() => onDelete(th.id)}
                    className="
                      absolute right-1 top-1.5 hidden rounded-[8px] px-1 py-0.5
                      text-[11px] leading-none text-ink-mute
                      hover:text-ink group-hover:block
                      focus-visible:block focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand
                    "
                  >
                    <span aria-hidden>×</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </nav>
  );
}
