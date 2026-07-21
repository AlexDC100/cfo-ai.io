// Cmd-K-style command palette.
//
// Searches across:
//   · routes (Today / Cash / Profit / Decisions / Products)
//   · synthesized SKUs from the active dataset
//   · categories
//
// Selecting a result navigates and closes. Plain shadcn Dialog (not the
// shadcn Command primitive) so we don't pull in a fresh dependency for
// the simple linear filter.

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Search,
  Sun,
  Coins,
  TrendingUp,
  ListChecks,
  Boxes,
  BookOpen,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { useDailyRun } from "@/lib/runStore";
import { flattenSkus } from "@/lib/cfoDerive";
import { BucketChip } from "./BucketChip";
import { openGlossary } from "@/components/learning/MetricGlossaryDrawer";
import { usePopoverStack } from "@/components/learning/PopoverStackProvider";
import { CONCEPTS_BY_KEY, type Concept } from "@/lib/learning/concepts";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Result =
  | { kind: "route"; label: string; hint: string; to: string; icon: LucideIcon }
  | { kind: "sku"; label: string; hint: string; bucket: string }
  | { kind: "category"; label: string; hint: string; bucket: string }
  | { kind: "glossary"; label: string; hint: string; icon: LucideIcon }
  | { kind: "concept"; label: string; hint: string; conceptKey: string };

const ROUTES: { label: string; hint: string; to: string; icon: LucideIcon }[] = [
  { label: "Today",     hint: "Daily briefing",  to: "/dashboard",     icon: Sun },
  { label: "Balance sheet & P&L", hint: "Financial statements", to: "/dashboard?tab=statements", icon: Coins },
  { label: "Cash flow", hint: "Indirect method", to: "/dashboard?tab=statements#cash-flow", icon: TrendingUp },
  { label: "Decisions", hint: "Action queue",    to: "/decisions", icon: ListChecks },
  { label: "Products",  hint: "SKU explorer",    to: "/products",  icon: Boxes },
];

// F5.0: snapshot of the concept catalog. Built once per module load — the
// registry never mutates at runtime, so this is safe.
const ALL_CONCEPTS: Concept[] = Object.values(CONCEPTS_BY_KEY);

export function SearchDialog({ open, onOpenChange }: Props) {
  const nav = useNavigate();
  const run = useDailyRun();
  const popoverStack = usePopoverStack();
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);

  // Reset query when dialog reopens
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIdx(0);
    }
  }, [open]);

  const skus = useMemo(() => flattenSkus(run), [run]);
  const categories = useMemo(() => {
    const seen = new Set<string>();
    const cats: { name: string; bucket: string }[] = [];
    for (const s of skus) {
      if (s.category && !seen.has(s.category)) {
        seen.add(s.category);
        cats.push({ name: s.category, bucket: s.bucket });
      }
    }
    return cats;
  }, [skus]);

  const results: Result[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out: Result[] = [];

    // Routes always match first when query is empty / matches
    for (const r of ROUTES) {
      if (!q || r.label.toLowerCase().includes(q) || r.hint.toLowerCase().includes(q)) {
        out.push({ kind: "route", ...r });
      }
    }

    // Glossary entry — always visible on empty query; matches q on word stems
    if (!q || "glossary".includes(q) || "metrics".includes(q) || "learn".includes(q)) {
      out.push({
        kind: "glossary",
        label: "Browse glossary",
        hint: "Every concept CFO AI knows",
        icon: BookOpen,
      });
    }

    if (q.length >= 1) {
      // Categories
      for (const c of categories) {
        if (c.name.toLowerCase().includes(q)) {
          out.push({
            kind: "category",
            label: c.name,
            hint: "Category",
            bucket: c.bucket,
          });
          if (out.length > 80) break;
        }
      }
      // SKUs
      for (const s of skus) {
        if (
          s.id.toLowerCase().includes(q) ||
          (s.category?.toLowerCase().includes(q) ?? false)
        ) {
          out.push({
            kind: "sku",
            label: s.id,
            hint: s.category ?? "SKU",
            bucket: s.bucket,
          });
          if (out.length > 80) break;
        }
      }
      // Concepts (F5.0 — opens popover directly)
      for (const c of ALL_CONCEPTS) {
        const nameEn = c.name.en.toLowerCase();
        const nameRo = c.name.ro?.toLowerCase() ?? "";
        const key = c.key.toLowerCase();
        if (nameEn.includes(q) || nameRo.includes(q) || key.includes(q)) {
          out.push({
            kind: "concept",
            label: c.name.en,
            hint: c.category ?? "Concept",
            conceptKey: c.key,
          });
          if (out.length > 80) break;
        }
      }
    }
    return out.slice(0, 16);
  }, [query, skus, categories]);

  // Reset activeIdx when results change (keeps it in bounds)
  useEffect(() => {
    if (activeIdx >= results.length) setActiveIdx(0);
  }, [results.length, activeIdx]);

  function pick(r: Result) {
    if (r.kind === "route") {
      nav(r.to);
    } else if (r.kind === "sku") {
      nav("/products?search=" + encodeURIComponent(r.label));
    } else if (r.kind === "category") {
      nav("/products?search=" + encodeURIComponent(r.label));
    } else if (r.kind === "glossary") {
      openGlossary();
    } else if (r.kind === "concept") {
      // F5.0: push concept onto the global popover stack with center-screen rect.
      const cx = window.innerWidth / 2;
      const cy = window.innerHeight / 2;
      popoverStack.push({
        conceptKey: r.conceptKey,
        value: 0,
        triggerRect: {
          top: cy - 20,
          left: cx - 100,
          right: cx + 100,
          bottom: cy + 20,
          width: 200,
          height: 40,
          x: cx - 100,
          y: cy - 20,
          toJSON: () => ({}),
        } as DOMRect,
      });
    }
    onOpenChange(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && results[activeIdx]) {
      e.preventDefault();
      pick(results[activeIdx]);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="
          p-0 overflow-hidden
          bg-surface dark:bg-bg-2
          border border-rule
          shadow-4
          [&>button.absolute]:hidden
          inset-x-2 top-2 bottom-auto translate-x-0 translate-y-0
          w-auto max-w-[calc(100vw-1rem)] rounded-2xl
          sm:inset-auto sm:top-1/2 sm:left-1/2
          sm:-translate-x-1/2 sm:-translate-y-1/2
          sm:w-full sm:max-w-[560px]
        "
      >
        <DialogTitle className="sr-only">Search</DialogTitle>

        <div className="flex items-center gap-3 px-4 py-3 border-b border-rule">
          <Search size={16} strokeWidth={1.75} className="text-ink-mute shrink-0" />
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search SKUs, categories, or jump to a page…"
            className="
              flex-1 bg-transparent text-[14px] text-ink
              placeholder:text-ink-mute outline-none
            "
          />
          <kbd className="hidden sm:inline-block text-[10.5px] text-ink-mute font-mono px-1.5 py-0.5 rounded border border-rule bg-bg-2 dark:bg-surface-hi">
            esc
          </kbd>
        </div>

        <div className="max-h-[420px] overflow-y-auto py-1.5">
          {results.length === 0 ? (
            <div className="px-4 py-8 text-center text-[13px] text-ink-soft">
              No matches. Try a SKU name, category, or page name.
            </div>
          ) : (
            <ul>
              {results.map((r, idx) => (
                <li key={`${r.kind}-${r.label}-${idx}`}>
                  <button
                    onClick={() => pick(r)}
                    onMouseEnter={() => setActiveIdx(idx)}
                    className={`
                      w-full flex items-center gap-3 px-4 py-2.5 text-left
                      transition-colors
                      ${idx === activeIdx
                        ? "bg-bg-2 dark:bg-surface-hi"
                        : "hover:bg-bg-2/50 dark:hover:bg-surface-hi/50"}
                    `}
                  >
                    {r.kind === "route" ? (
                      <span className="w-7 h-7 rounded-md bg-bg-2 dark:bg-surface grid place-items-center shrink-0 text-ink-soft">
                        <r.icon size={14} strokeWidth={1.75} />
                      </span>
                    ) : r.kind === "glossary" ? (
                      <span className="w-7 h-7 rounded-md bg-[hsl(173,57%,55%)]/15 grid place-items-center shrink-0 text-[hsl(173,57%,55%)]">
                        <r.icon size={14} strokeWidth={1.75} />
                      </span>
                    ) : r.kind === "concept" ? (
                      <span className="w-7 h-7 rounded-md bg-[hsl(173,57%,55%)]/10 grid place-items-center shrink-0 text-[hsl(173,57%,55%)]">
                        <Sparkles size={14} strokeWidth={1.75} />
                      </span>
                    ) : (
                      <span className="w-7 h-7 rounded-md grid place-items-center shrink-0 text-[10px] font-medium uppercase tracking-wider text-ink-mute">
                        {r.kind === "sku" ? "SKU" : "CAT"}
                      </span>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="text-[13.5px] text-ink truncate">{r.label}</div>
                      <div className="text-[11.5px] text-ink-mute mt-0.5 truncate">
                        {r.hint}
                      </div>
                    </div>
                    {r.kind !== "route" && "bucket" in r && (
                      <BucketChip bucket={r.bucket as import("@/lib/cfoApi").Bucket} />
                    )}
                    {r.kind === "concept" && (
                      <span className="text-[10px] uppercase tracking-[0.12em] text-[hsl(173,57%,55%)]/70 font-medium shrink-0">
                        Learn
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="px-4 py-2 border-t border-rule flex items-center justify-between text-[11px] text-ink-mute">
          <span>↑↓ navigate · Enter to select</span>
          <span>{results.length} result{results.length === 1 ? "" : "s"}</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
