// F6.0.4 (2026-06-20) — Concept picker (Add metric).
//
// A right-side Sheet listing every F5.0 concept the dashboard can render
// as a card, grouped by category, searchable, with already-added concepts
// filtered out. Tapping a concept adds it as a card + closes the sheet.
//
// Only concepts that the resolver can compute a value for are offered
// (SUPPORTED_CONCEPT_KEYS ∩ CONCEPTS_BY_KEY) so the user can never add a
// dead em-dash card.
//
// Mobile: the Sheet is full-width (w-full) so the search + list use the
// whole screen; desktop caps at max-w-md.

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";
import { CONCEPTS_BY_KEY } from "@/lib/learning/concepts";
import { SUPPORTED_CONCEPT_KEYS } from "@/lib/dashboard/resolveConceptValue";
import type { Concept } from "@/lib/learning/concepts/_schema";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onClose: () => void;
  onSelect: (conceptKey: string) => void;
  /** Concept keys already on the dashboard — filtered out of the list. */
  excludeKeys: string[];
}

export function ConceptPicker({ open, onClose, onSelect, excludeKeys }: Props) {
  const [search, setSearch] = useState("");

  // Addable concepts = supported by resolver ∩ in registry ∩ not already added.
  const addable = useMemo<Concept[]>(() => {
    const excluded = new Set(excludeKeys);
    return Object.values(CONCEPTS_BY_KEY)
      .filter(
        (c) =>
          SUPPORTED_CONCEPT_KEYS.has(c.key) && !excluded.has(c.key),
      )
      .sort((a, b) => a.name.en.localeCompare(b.name.en));
  }, [excludeKeys]);

  const filtered = useMemo<Concept[]>(() => {
    const q = search.trim().toLowerCase();
    if (!q) return addable;
    return addable.filter(
      (c) =>
        c.name.en.toLowerCase().includes(q) ||
        c.name.ro.toLowerCase().includes(q) ||
        c.key.toLowerCase().includes(q) ||
        (c.shortDefinition?.en ?? "").toLowerCase().includes(q),
    );
  }, [addable, search]);

  // Group by category, preserving a sensible category order.
  const grouped = useMemo(() => {
    const map = new Map<string, Concept[]>();
    for (const c of filtered) {
      const arr = map.get(c.category) ?? [];
      arr.push(c);
      map.set(c.category, arr);
    }
    return [...map.entries()];
  }, [filtered]);

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        data-testid="concept-picker"
        className="w-full sm:max-w-md p-0 flex flex-col bg-surface"
      >
        <div className="px-5 pt-5 pb-3 border-b border-rule">
          <SheetTitle className="text-[18px] font-medium text-ink mb-3">
            Add a metric
          </SheetTitle>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-mute" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search metrics…"
              data-testid="concept-picker-search"
              autoFocus
              className="
                w-full h-10 pl-9 pr-3 rounded-lg
                bg-bg-2 border border-rule
                text-[14px] text-ink placeholder:text-ink-mute
                outline-none focus:border-[hsl(173,57%,55%)]/50
              "
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto overscroll-contain px-2.5 py-2">
          {grouped.map(([category, items]) => (
            <div key={category} className="mb-3">
              <div className="text-[10px] uppercase tracking-[0.14em] text-ink-mute px-2.5 mb-1 font-medium">
                {category}
              </div>
              {items.map((concept) => (
                <button
                  key={concept.key}
                  type="button"
                  onClick={() => {
                    onSelect(concept.key);
                    onClose();
                  }}
                  data-testid={`concept-option-${concept.key}`}
                  className={cn(
                    "w-full text-left px-2.5 py-2.5 rounded-lg",
                    "min-h-[52px]",
                    "hover:bg-bg-2 active:bg-bg-2 transition-colors",
                  )}
                >
                  <div className="text-[13.5px] font-medium text-ink">
                    {concept.name.en}
                  </div>
                  {concept.shortDefinition && (
                    <div className="text-[11.5px] text-ink-soft mt-0.5 line-clamp-1">
                      {concept.shortDefinition.en}
                    </div>
                  )}
                </button>
              ))}
            </div>
          ))}

          {filtered.length === 0 && (
            <div className="text-center py-10 text-[13px] text-ink-soft">
              {search
                ? `No metrics match "${search}"`
                : "Every available metric is already on your dashboard."}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
