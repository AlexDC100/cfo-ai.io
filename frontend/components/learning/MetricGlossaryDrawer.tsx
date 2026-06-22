// F5.0 Step 3 (CFO AI Learn) — Searchable glossary drawer.
//
// Lists every registered concept, grouped by category, with a search
// bar that filters on name + short definition. Clicking a concept
// pushes a stack entry — the same popover the inline LearnableNumber
// surfaces use, so the explanation depth is identical.
//
// Mounted globally (alongside PopoverStackProvider): the trigger is a
// small "Glossary" pill in the TopHeader. Open/close state is owned
// here so any caller can toggle it via window event without prop
// drilling.
//
// Mobile: vaul bottom sheet. Desktop: right-side slide-in panel.

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Search, X, BookOpen } from "lucide-react";
import { Drawer } from "vaul";
import { useIsMobile } from "@/hooks/use-mobile";
import { usePopoverStack } from "./PopoverStackProvider";
import { CONCEPTS_BY_KEY, type Concept, type ConceptCategory } from "@/lib/learning/concepts";
import { cn } from "@/lib/utils";

const GLOSSARY_EVENT = "cfo-learn:open-glossary";

/** Imperative API — fire this event from any component to open the
 *  glossary drawer. Used by the TopHeader trigger; could be wired into
 *  Cmd+K command palette later. */
export function openGlossary(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(GLOSSARY_EVENT));
  }
}

export function MetricGlossaryDrawer() {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function handler() {
      setOpen(true);
    }
    window.addEventListener(GLOSSARY_EVENT, handler);
    return () => window.removeEventListener(GLOSSARY_EVENT, handler);
  }, []);

  if (isMobile) {
    return (
      <Drawer.Root open={open} onOpenChange={setOpen} shouldScaleBackground>
        <Drawer.Portal>
          <Drawer.Overlay className="fixed inset-0 z-[145] bg-black/45" />
          <Drawer.Content
            className="
              fixed bottom-0 inset-x-0 z-[155]
              bg-[rgba(18,20,22,0.96)] backdrop-blur-2xl
              rounded-t-3xl
              border-t border-white/[0.08]
              max-h-[92dvh]
              pb-[max(20px,env(safe-area-inset-bottom))]
              shadow-[0_-12px_60px_-8px_rgba(0,0,0,0.6)]
              flex flex-col
              text-white
            "
          >
            <div className="flex justify-center pt-3 pb-1 shrink-0" aria-hidden>
              <div className="w-9 h-1 rounded-full bg-white/20" />
            </div>
            <GlossaryContent onClose={() => setOpen(false)} />
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>
    );
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-[145] bg-black/35"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <motion.aside
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className="
              fixed top-0 right-0 bottom-0 z-[155]
              w-[420px] max-w-[calc(100vw-24px)]
              bg-[rgba(18,20,22,0.94)] backdrop-blur-2xl
              border-l border-white/[0.08]
              shadow-[-24px_0_80px_-12px_rgba(0,0,0,0.55),inset_1px_0_0_rgba(255,255,255,0.04)]
              flex flex-col
              text-white
            "
            data-testid="metric-glossary"
            role="dialog"
            aria-label="Metric glossary"
          >
            <GlossaryContent onClose={() => setOpen(false)} />
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

function GlossaryContent({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { push } = usePopoverStack();

  // Focus the search input on mount.
  useEffect(() => {
    const t = window.setTimeout(() => inputRef.current?.focus(), 60);
    return () => window.clearTimeout(t);
  }, []);

  // Group by category, then filter by query.
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all: Concept[] = Object.values(CONCEPTS_BY_KEY);
    const byCat = new Map<ConceptCategory, Concept[]>();
    for (const c of all) {
      if (q) {
        const hay = (
          c.name.en +
          " " +
          c.name.ro +
          " " +
          c.shortDefinition.en +
          " " +
          c.shortDefinition.ro +
          " " +
          c.key
        ).toLowerCase();
        if (!hay.includes(q)) continue;
      }
      const list = byCat.get(c.category) ?? [];
      list.push(c);
      byCat.set(c.category, list);
    }
    // Stable sort within each category by display name.
    for (const list of byCat.values()) {
      list.sort((a, b) => a.name.en.localeCompare(b.name.en));
    }
    // Order categories with the analyst-traffic order first.
    const ORDER: ConceptCategory[] = [
      "Profitability",
      "Liquidity",
      "Working Capital",
      "Leverage & Solvency",
      "Coverage",
      "Efficiency",
      "Valuation",
      "Cash Flow",
      "Risk & Credit",
      "Benchmark",
      "Inventory",
      "Public Company",
      "Source Account",
      "Romanian RAS",
    ];
    return ORDER.filter((cat) => byCat.has(cat)).map((cat) => ({
      category: cat,
      concepts: byCat.get(cat)!,
    }));
  }, [query]);

  const totalShown = groups.reduce((acc, g) => acc + g.concepts.length, 0);

  const handlePick = (c: Concept) => {
    // Open with value=0 as a placeholder; the inline computation +
    // narrative still render with structure, just without the live
    // figure. Same UX as Lookup-style browsing of a dictionary.
    push({
      conceptKey: c.key,
      value: 0,
    });
    onClose();
  };

  return (
    <>
      {/* Header */}
      <header className="px-5 pt-5 pb-3 shrink-0 border-b border-white/[0.06] relative">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent" />
        <div className="flex items-center justify-between gap-3">
          <div className="inline-flex items-center gap-2">
            <BookOpen className="w-3.5 h-3.5 text-[hsl(165,75%,68%)]" />
            <h2 className="text-[14px] font-semibold leading-none tracking-tight">
              Finance glossary
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            data-testid="glossary-close"
            className="
              w-7 h-7 rounded-full
              bg-white/[0.06] hover:bg-white/[0.14]
              grid place-items-center
              text-white/75 hover:text-white
              transition-colors
              -mt-1 -mr-0.5
            "
          >
            <X className="w-3 h-3" />
          </button>
        </div>
        <p className="text-[11.5px] text-white/55 mt-2">
          {totalShown} concept{totalShown === 1 ? "" : "s"} — every line, every ratio, every source account.
        </p>
        {/* Search */}
        <div className="mt-3 relative">
          <Search className="w-3.5 h-3.5 text-white/45 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search EBITDA, current ratio, ROIC…"
            data-testid="glossary-search"
            className="
              w-full pl-9 pr-3 py-2 rounded-lg
              bg-white/[0.05] border border-white/[0.08]
              text-[13px] text-white placeholder:text-white/35
              focus:outline-none focus:border-[hsl(165,75%,55%)]/30 focus:bg-white/[0.08]
              transition-colors
            "
          />
        </div>
      </header>

      {/* Body — scrollable */}
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-2.5 py-3">
        {groups.length === 0 ? (
          <div className="text-center text-[13px] text-white/55 px-5 py-10">
            No concepts match "{query}".
          </div>
        ) : (
          groups.map(({ category, concepts }) => (
            <section key={category} className="mb-4 last:mb-2">
              <div
                className={cn(
                  "px-2.5 mb-1.5",
                  "text-[10px] uppercase tracking-[0.14em] text-white/45 font-semibold",
                )}
              >
                {category}
              </div>
              <div className="space-y-0.5">
                {concepts.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    onClick={() => handlePick(c)}
                    data-testid={`glossary-item-${c.key}`}
                    className="
                      w-full text-left
                      px-2.5 py-2 rounded-md
                      hover:bg-white/[0.06]
                      transition-colors
                      group
                    "
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-[12.5px] font-medium text-white/95 group-hover:text-white">
                        {c.name.en}
                      </span>
                      <code className="text-[10px] font-mono text-white/35 shrink-0">
                        {c.key}
                      </code>
                    </div>
                    <p className="text-[11.5px] text-white/55 mt-0.5 leading-snug line-clamp-2">
                      {c.shortDefinition.en}
                    </p>
                  </button>
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </>
  );
}
