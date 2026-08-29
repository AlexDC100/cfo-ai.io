// THE INSTRUMENT — CommandPalette (⌘K): the one showcase glass surface.
//
// Translucent backdrop-blur panel, shadow-2xl (it floats — the only place
// resting depth is allowed). Keyboard-first: ⌘K opens, arrows navigate,
// Enter executes, Esc closes; fully operable without a pointer.
//
// Groups: Pages (the exact rail destinations, via useShellNav — one list,
// two surfaces), Actions (upload, export, theme, Ask CFO AI ⌘J, toggle
// rail ⌘.), Recent periods, Companies (static BVB universe), plus the
// dataset search the old ⌘K dialog carried (SKUs, categories, learning
// concepts, glossary) so nothing regressed in the swap.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
// Radix primitive directly (not ui/dialog's DialogContent): the shared
// wrapper hard-codes the heavy black/80 overlay, which turns the glass
// panel into fog on Paper. The palette owns a lighter overlay instead.
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  BookOpen,
  CalendarDays,
  Download,
  Globe,
  PanelLeft,
  Search,
  Sparkles,
  SunMoon,
  Upload,
  type LucideIcon,
} from "lucide-react";

import "./shellI18n";
import { modKeyLabel } from "./shellI18n";
import { useShellNav, SIDEBAR_TOGGLE_EVENT } from "@/components/cfo/Sidebar";
import { Settings as SettingsIcon } from "lucide-react";
import { usePeriodStepper } from "@/lib/usePeriodStepper";
import { useActiveLocale } from "@/lib/locale";
import { formatPeriodMonth } from "@/lib/orgPeriods";
import { staticBvbRows } from "@/lib/bvbStaticUniverse";
import { useTheme } from "@/theme";
import { useDailyRun } from "@/lib/runStore";
import { flattenSkus } from "@/lib/cfoDerive";
import { BucketChip } from "@/components/cfo/BucketChip";
import { openGlossary } from "@/components/learning/MetricGlossaryDrawer";
import { usePopoverStack } from "@/components/learning/PopoverStackProvider";
import { CONCEPTS_BY_KEY, type Concept } from "@/lib/learning/concepts";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Ask CFO AI — same handler as ⌘J. */
  onOpenAi: () => void;
}

interface PaletteItem {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon?: LucideIcon;
  /** Right-aligned shortcut hint ("⌘J"). Display only. */
  kbd?: string;
  /** Right-aligned custom trailing (bucket chip, Learn tag). */
  trailing?: React.ReactNode;
  run: () => void;
}

// Snapshot of the concept catalog — the registry never mutates at runtime.
const ALL_CONCEPTS: Concept[] = Object.values(CONCEPTS_BY_KEY);

export function CommandPalette({ open, onOpenChange, onOpenAi }: Props) {
  const { t } = useTranslation();
  const locale = useActiveLocale();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const groups = useShellNav();
  const { periods, goToPeriod } = usePeriodStepper();
  const { resolvedTheme, setTheme } = useTheme();
  const run = useDailyRun();
  const popoverStack = usePopoverStack();

  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIdx(0);
    }
  }, [open]);

  const period = params.get("period");
  const withPeriod = (to: string) => {
    if (!period) return to;
    const sep = to.includes("?") ? "&" : "?";
    return `${to}${sep}period=${encodeURIComponent(period)}`;
  };

  const close = () => onOpenChange(false);
  const go = (to: string) => {
    navigate(withPeriod(to));
    close();
  };

  const mod = modKeyLabel();
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
  const companies = useMemo(() => staticBvbRows(), []);

  const items: PaletteItem[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (...hay: Array<string | null | undefined>) =>
      !q || hay.some((h) => (h ?? "").toLowerCase().includes(q));
    const out: PaletteItem[] = [];

    // Pages — the rail's own destinations plus Settings.
    for (const g of groups) {
      for (const item of g.items) {
        const label = t(item.labelKey);
        if (match(label, g.label)) {
          out.push({
            id: `page-${item.to}`,
            group: t("shell.palette.pages"),
            label,
            hint: g.label,
            icon: item.icon,
            kbd: item.shortcutKey ? `${mod}${item.shortcutKey}` : undefined,
            run: () => go(item.to),
          });
        }
      }
    }
    const settingsLabel = t("sidebar.settings");
    if (match(settingsLabel)) {
      out.push({
        id: "page-/settings",
        group: t("shell.palette.pages"),
        label: settingsLabel,
        icon: SettingsIcon,
        run: () => go("/settings"),
      });
    }

    // Actions.
    const actions: PaletteItem[] = [
      {
        id: "act-upload",
        group: t("shell.palette.actions"),
        label: t("shell.palette.upload"),
        hint: t("shell.palette.uploadHint"),
        icon: Upload,
        run: () => go("/dashboard"),
      },
      {
        id: "act-export",
        group: t("shell.palette.actions"),
        label: t("shell.palette.export"),
        hint: t("shell.palette.exportHint"),
        icon: Download,
        run: () => go("/dashboard?tab=export"),
      },
      {
        id: "act-theme",
        group: t("shell.palette.actions"),
        label:
          resolvedTheme === "dark"
            ? t("shell.theme.toPaper")
            : t("shell.theme.toTerminal"),
        hint: t("shell.theme.label"),
        icon: SunMoon,
        run: () => {
          setTheme(resolvedTheme === "dark" ? "light" : "dark");
          close();
        },
      },
      {
        id: "act-ask",
        group: t("shell.palette.actions"),
        label: t("shell.palette.askAi"),
        hint: t("shell.palette.askAiHint"),
        icon: Sparkles,
        kbd: `${mod}J`,
        run: () => {
          close();
          onOpenAi();
        },
      },
      {
        id: "act-rail",
        group: t("shell.palette.actions"),
        label: t("shell.palette.toggleSidebar"),
        hint: t("shell.palette.toggleSidebarHint"),
        icon: PanelLeft,
        kbd: `${mod}.`,
        run: () => {
          try { window.dispatchEvent(new Event(SIDEBAR_TOGGLE_EVENT)); } catch { /* SSR */ }
          close();
        },
      },
    ];
    for (const a of actions) if (match(a.label, a.hint)) out.push(a);

    // Glossary — ported from the old ⌘K dialog.
    if (match(t("panels.search.browseGlossary"), "glossary", "metrics", "learn")) {
      out.push({
        id: "act-glossary",
        group: t("shell.palette.learn"),
        label: t("panels.search.browseGlossary"),
        hint: t("panels.search.browseGlossaryHint"),
        icon: BookOpen,
        run: () => {
          close();
          openGlossary();
        },
      });
    }

    // Recent periods — formatted labels only, never ids (D11).
    const periodRows = periods
      .map((p) => ({
        id: p.period_id,
        label: formatPeriodMonth(p.period_end, locale) ?? "—",
      }))
      .filter((p) => match(p.label))
      .slice(0, q ? 8 : 5);
    for (const p of periodRows) {
      out.push({
        id: `period-${p.id}`,
        group: t("shell.palette.periods"),
        label: p.label,
        hint: t("shell.palette.switchPeriod"),
        icon: CalendarDays,
        run: () => {
          close();
          goToPeriod(p.id);
        },
      });
    }

    // Query-only groups — the palette stays calm when empty.
    if (q.length >= 1) {
      for (const c of categories) {
        if (c.name.toLowerCase().includes(q)) {
          out.push({
            id: `cat-${c.name}`,
            group: t("shell.palette.products"),
            label: c.name,
            hint: t("panels.search.categoryHint"),
            trailing: <BucketChip bucket={c.bucket as import("@/lib/cfoApi").Bucket} />,
            run: () => go(`/products?search=${encodeURIComponent(c.name)}`),
          });
          if (out.length > 60) break;
        }
      }
      for (const s of skus) {
        if (s.id.toLowerCase().includes(q) || (s.category?.toLowerCase().includes(q) ?? false)) {
          out.push({
            id: `sku-${s.id}`,
            group: t("shell.palette.products"),
            label: s.id,
            hint: s.category ?? "SKU",
            trailing: <BucketChip bucket={s.bucket as import("@/lib/cfoApi").Bucket} />,
            run: () => go(`/products?search=${encodeURIComponent(s.id)}`),
          });
          if (out.length > 60) break;
        }
      }
      for (const c of ALL_CONCEPTS) {
        const nameEn = c.name.en.toLowerCase();
        const nameRo = c.name.ro?.toLowerCase() ?? "";
        if (nameEn.includes(q) || nameRo.includes(q) || c.key.toLowerCase().includes(q)) {
          out.push({
            id: `concept-${c.key}`,
            group: t("shell.palette.learn"),
            label: c.name.en,
            hint: c.category ?? t("panels.search.conceptHint"),
            trailing: (
              <span className="shrink-0 text-[10px] font-medium uppercase tracking-[0.12em] text-brand-dark">
                {t("panels.search.learnTag")}
              </span>
            ),
            run: () => {
              // Concept popovers anchor center-screen from the palette.
              const cx = window.innerWidth / 2;
              const cy = window.innerHeight / 2;
              close();
              popoverStack.push({
                conceptKey: c.key,
                value: 0,
                triggerRect: {
                  top: cy - 20, left: cx - 100, right: cx + 100, bottom: cy + 20,
                  width: 200, height: 40, x: cx - 100, y: cy - 20,
                  toJSON: () => ({}),
                } as DOMRect,
              });
            },
          });
          if (out.length > 60) break;
        }
      }
    }
    if (q.length >= 2) {
      let added = 0;
      for (const co of companies) {
        const ticker = (co.ticker ?? "").toLowerCase();
        const name = (co.companyName ?? "").toLowerCase();
        if (ticker.includes(q) || name.includes(q)) {
          out.push({
            id: `company-${co.ticker}`,
            group: t("shell.palette.companies"),
            label: co.companyName ?? co.ticker,
            hint: `${co.ticker} · ${t("shell.palette.company")}`,
            icon: Globe,
            run: () => go(`/dashboard/public/${encodeURIComponent(co.ticker)}`),
          });
          if (++added >= 6) break;
        }
      }
    }

    return out.slice(0, 18);
    // Helpers referenced above (go/close/goToPeriod/onOpenAi/setTheme) are
    // re-created per render but behaviorally constant — listing them would
    // defeat the memo without changing results.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, groups, periods, categories, skus, companies, resolvedTheme, locale, t, mod]);

  useEffect(() => {
    if (activeIdx >= items.length) setActiveIdx(0);
  }, [items.length, activeIdx]);

  // Keep the active row in view while arrowing.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && items[activeIdx]) {
      e.preventDefault();
      items[activeIdx].run();
    }
  }

  // Group the flat list for rendering while keeping flat indices for
  // keyboard navigation.
  const grouped: { group: string; entries: { item: PaletteItem; idx: number }[] }[] = [];
  items.forEach((item, idx) => {
    const last = grouped[grouped.length - 1];
    if (last && last.group === item.group) last.entries.push({ item, idx });
    else grouped.push({ group: item.group, entries: [{ item, idx }] });
  });

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="
            fixed inset-0 z-50 bg-black/30
            data-[state=open]:animate-in data-[state=open]:fade-in-0
            data-[state=closed]:animate-out data-[state=closed]:fade-out-0
          "
        />
        <DialogPrimitive.Content
          data-testid="command-palette"
          className="
            fixed z-50 overflow-hidden
            bg-[hsl(var(--surface)/0.9)] backdrop-blur-xl
            border border-rule
            shadow-2xl
            inset-x-2 top-2
            w-auto max-w-[calc(100vw-1rem)] rounded-lg
            sm:inset-x-auto sm:top-[112px] sm:left-1/2
            sm:-translate-x-1/2
            sm:w-full sm:max-w-[600px]
            duration-overlay
            data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95
            data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95
          "
        >
          <DialogPrimitive.Title className="sr-only">{t("common.search")}</DialogPrimitive.Title>

        <div className="flex items-center gap-3 border-b border-rule-soft px-4 py-3">
          <Search size={16} strokeWidth={1.75} className="shrink-0 text-ink-mute" />
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t("shell.palette.placeholder")}
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-list"
            aria-activedescendant={items[activeIdx] ? `palette-item-${activeIdx}` : undefined}
            className="flex-1 bg-transparent text-[14px] text-ink placeholder:text-ink-mute outline-none"
          />
          <kbd className="hidden sm:inline-block rounded-sm border border-rule bg-bg-2 px-1.5 py-0.5 font-mono text-[10.5px] text-ink-mute">
            esc
          </kbd>
        </div>

        <div
          ref={listRef}
          id="command-palette-list"
          role="listbox"
          className="max-h-[min(420px,60vh)] overflow-y-auto py-1.5"
        >
          {items.length === 0 ? (
            <div className="px-4 py-8 text-center text-[13px] text-ink-soft">
              {t("shell.palette.noResults")}
            </div>
          ) : (
            grouped.map((g) => (
              <div key={g.group}>
                <div className="px-4 pb-1 pt-2 text-[10px] font-medium uppercase tracking-[0.14em] text-ink-mute">
                  {g.group}
                </div>
                <ul>
                  {g.entries.map(({ item, idx }) => (
                    <li key={item.id}>
                      {/* Single-line dense rows — a command surface, not a
                          content list: label left, muted hint right. */}
                      <button
                        id={`palette-item-${idx}`}
                        data-idx={idx}
                        role="option"
                        aria-selected={idx === activeIdx}
                        onClick={() => item.run()}
                        onMouseEnter={() => setActiveIdx(idx)}
                        className={`
                          flex h-9 w-full items-center gap-3 px-4 text-left
                          transition-colors duration-micro
                          ${idx === activeIdx ? "bg-bg-2" : "hover:bg-bg-2/60"}
                        `}
                      >
                        {item.icon ? (
                          <item.icon
                            size={15}
                            strokeWidth={1.75}
                            className="shrink-0 text-ink-soft"
                          />
                        ) : (
                          <span className="w-[15px] shrink-0" aria-hidden />
                        )}
                        <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                          {item.label}
                        </span>
                        {item.hint && (
                          <span className="max-w-[45%] shrink-0 truncate text-[11px] text-ink-mute">
                            {item.hint}
                          </span>
                        )}
                        {item.trailing}
                        {item.kbd && (
                          <kbd className="shrink-0 rounded-sm border border-rule bg-bg-2 px-1.5 py-0.5 font-mono text-[10px] text-ink-mute">
                            {item.kbd}
                          </kbd>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>

          <div className="flex items-center justify-between border-t border-rule-soft px-4 py-2 text-[11px] text-ink-mute">
            <span>{t("shell.palette.navHint")}</span>
            <span className="font-mono tabular-nums">{items.length}</span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
