// THE INSTRUMENT — CommandPalette (⌘K): the one showcase glass surface,
// and now the ANSWER SURFACE.
//
// Translucent backdrop-blur panel, shadow-2xl (it floats — the only place
// resting depth is allowed). Keyboard-first: ⌘K opens, typing anywhere
// unfocused opens, ⌘J opens straight into Ask, arrows navigate, Tab jumps
// to Ask, Enter runs, ⌘Enter hands off to full chat, Esc collapses.
//
// Groups: Pages (the exact rail destinations, via useShellNav — one list,
// two surfaces), Actions (upload, export, theme, Ask CFO AI ⌘J, toggle
// rail ⌘.), Recent periods, Companies (static BVB universe), plus the
// dataset search the old ⌘K dialog carried (SKUs, categories, learning
// concepts, glossary) so nothing regressed in the swap.
//
// ── ANSWER MODE (Part B) ──────────────────────────────────────────────
//
// Enter on the Ask row does not navigate. The overlay grows IN PLACE:
// the question pins to the top of the thread, the answer builds below it,
// and a follow-up input keeps focus at the bottom. No route change, no
// second window — the question was asked here, so it is answered here.
// Escape collapses back to search and keeps the thread alive for ten
// minutes (`capsuleThread`), because "read the answer → jump to the
// source cell → come back and ask the follow-up" is the common move.
//
// ── The model-spend rule ──────────────────────────────────────────────
//
// The intent router (`lib/capsuleRouter`) classifies EVERY keystroke with
// no model call, and the Ask row is the only row whose activation costs
// one. Typing "cash flow" and pressing Enter navigates, for free —
// `willCallModel` is the predicate, and it is asserted per-fixture in the
// router's own gate. This surface honours it by construction: the model
// pipeline is reachable from exactly one branch of `activate()`.
//
// The palette keeps its own richer catalogue (SKUs, concepts, periods,
// companies) alongside the router's lanes; what it takes from the router
// is the LANE DECISION and the Ask row's placement invariant — exactly
// one Ask row, at index 0 or 1, so it is always one keystroke away.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
// Radix primitive directly (not ui/dialog's DialogContent): the shared
// wrapper hard-codes the heavy black/80 overlay, which turns the glass
// panel into fog on Paper. The palette owns a lighter overlay instead.
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  ArrowLeft,
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
import "@/lib/capsuleRouterI18n";
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
import { routeQuery } from "@/lib/capsuleRouter";
import { useActivePeriod } from "@/lib/activePeriod";
import { factsFrom } from "@/lib/servedFacts";
import { openAskCfoAi } from "@/components/cfo/chat/openAskCfoAi";
import type { TraceableSource } from "@/lib/traceableSource";

import "./capsuleAnswer/capsuleAnswerI18n";
import {
  CapsuleAnswerPanel,
  type HostCitation,
} from "./capsuleAnswer/CapsuleAnswerPanel";
import { useCapsuleAnswer } from "./capsuleAnswer/useCapsuleAnswer";
// The suggestions / degraded / limits lane's public barrel. Its own
// header names this file as the host, so the mount points live here.
import {
  CapsuleAskRowNotice,
  CapsuleEmptyState,
  releaseCapsuleAsk,
  rememberCapsuleQuestion,
  reserveCapsuleAsk,
  useCapsuleAskAvailability,
  useCapsuleKeys,
  useCapsuleRecall,
} from "./capsuleEmpty";
import { handOffThreadToChat } from "./capsuleAnswer/capsuleChatHandoff";
import type { RetrievalContext } from "./capsuleAnswer/capsuleRetrieval";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Ask CFO AI — same handler as the sidebar accent row. */
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
  /** The ONE row whose activation costs a model call. */
  ask?: boolean;
  /** Ask row only: the model is unavailable, so activation is inert. */
  blocked?: boolean;
  run: () => void;
}

// Snapshot of the concept catalog — the registry never mutates at runtime.
const ALL_CONCEPTS: Concept[] = Object.values(CONCEPTS_BY_KEY);

/** True when the focus is somewhere the reader is already typing — the
 *  type-to-open shortcut must never steal a character from a form. */
function isEditable(el: Element | null): boolean {
  if (!el) return false;
  const node = el as HTMLElement;
  if (node.isContentEditable) return true;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** Another overlay already owns the keyboard. */
function modalOpen(): boolean {
  if (typeof document === "undefined") return false;
  return Boolean(document.querySelector('[role="dialog"],[aria-modal="true"]'));
}

export function CommandPalette({ open, onOpenChange, onOpenAi }: Props) {
  const { t, i18n } = useTranslation();
  const locale = useActiveLocale();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const groups = useShellNav();
  const { periods, goToPeriod } = usePeriodStepper();
  const { resolvedTheme, setTheme } = useTheme();
  const run = useDailyRun();
  const popoverStack = usePopoverStack();
  const activePeriod = useActivePeriod();
  const { userKey, orgKey } = useCapsuleKeys();
  // ONE predicate for "may this surface spend a model call right now" —
  // the assistant being down and the per-user burst guard collapse into
  // it, and the Ask row reads it in one place.
  const askAvailability = useCapsuleAskAvailability(userKey);
  const recall = useCapsuleRecall(orgKey);

  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [mode, setMode] = useState<"search" | "answer">("search");
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  /** Set by type-to-open so the character that opened the palette is not
   *  swallowed by the mount. */
  const pendingChar = useRef<string | null>(null);

  // ── the answer pipeline ──────────────────────────────────────────────

  const periodOptions = useMemo(
    () =>
      periods.map((p) => ({
        id: p.period_id,
        label: formatPeriodMonth(p.period_end, locale) ?? p.period_id,
      })),
    [periods, locale],
  );

  // The MONTH, not the workspace label. `activePeriod.label` is the
  // friendly workspace name — usually the company — and putting that
  // where a period belongs makes the retrieval trace read "Reading
  // revenue · Meridian Industries SRL" and the citation footer claim a
  // company name is a period.
  const periodMonth = useMemo(
    () => formatPeriodMonth(activePeriod.periodEnd, locale),
    [activePeriod.periodEnd, locale],
  );

  // `ctx` identity keys the router's memo AND the retrieval plan, so it
  // must be a stable object rather than a fresh literal per render.
  const retrieval = useMemo<RetrievalContext>(
    () => ({
      periodId: activePeriod.id,
      periodLabel: periodMonth,
      periods: periodOptions,
    }),
    [activePeriod.id, periodMonth, periodOptions],
  );

  const answer = useCapsuleAnswer({
    retrieval,
    companyName: activePeriod.label ?? null,
    language: (i18n.language ?? "en").toLowerCase().startsWith("ro") ? "ro" : "en",
  });

  const citation = useMemo<HostCitation>(() => {
    const statements = activePeriod.statements;
    const facts = statements ? factsFrom(statements) : null;
    if (!facts || !facts.isCanonical) {
      return {
        periodLabel: periodMonth,
        sourceFile: activePeriod.sourceDocumentFilename,
        trustLabel: null,
        trustTone: "neutral",
      };
    }
    const presentation = facts.presentStatus(statements?.currency ?? "RON");
    const isRo = (i18n.language ?? "en").toLowerCase().startsWith("ro");
    const tone: HostCitation["trustTone"] =
      presentation.band === "material_imbalance"
        ? "alert"
        : presentation.band === "balanced"
        ? "success"
        : presentation.band === "unverified"
        ? "neutral"
        : "caution";
    return {
      periodLabel: periodMonth,
      sourceFile: activePeriod.sourceDocumentFilename,
      trustLabel: isRo ? presentation.displayRo : presentation.displayEn,
      trustTone: tone,
    };
  }, [
    activePeriod.statements,
    activePeriod.sourceDocumentFilename,
    periodMonth,
    i18n.language,
  ]);

  /** The ONE place a question reaches the model.
   *
   *  `reserveCapsuleAsk` is taken BEFORE the dispatch and released if the
   *  dispatch never happens — credits are live and billing, so a stuck
   *  Enter key must cost one answer, not six. A refused reservation is
   *  not an error state: the surface still opens, and the Ask row already
   *  says why it is unavailable. */
  const askModel = useCallback(
    (question: string) => {
      const q = question.trim();
      if (!q) return;
      if (!askAvailability.available) return;
      const decision = reserveCapsuleAsk(userKey);
      if (!decision.allowed) return;
      try {
        answer.ask(q);
        rememberCapsuleQuestion(orgKey, q);
      } catch (err) {
        releaseCapsuleAsk(userKey);
        throw err;
      }
    },
    [answer, askAvailability.available, userKey, orgKey],
  );

  const enterAnswerMode = useCallback(
    (question: string) => {
      answer.open();
      setMode("answer");
      onOpenChange(true);
      const q = question.trim();
      if (q) {
        setQuery("");
        askModel(q);
      }
    },
    [answer, onOpenChange, askModel],
  );

  useEffect(() => {
    if (open) {
      setActiveIdx(0);
      if (pendingChar.current) {
        setQuery(pendingChar.current);
        pendingChar.current = null;
        setMode("search");
      } else if (mode !== "answer") {
        setQuery("");
      }
    } else {
      // Closing collapses the thread rather than dropping it — the grace
      // window in `capsuleThread` is what makes "Esc, check the cell,
      // come back" work.
      if (mode === "answer") answer.collapse();
      setMode("search");
    }
    // `mode`/`answer` are intentionally out: this effect reacts to the
    // OPEN transition only, and listing them would re-run it mid-thread.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  /** A provenance dot leaves the overlay for the statement row it names;
   *  the thread survives on the ten-minute grace so the reader can come
   *  straight back to the follow-up. */
  const jumpToSource = useCallback(
    (source: TraceableSource) => {
      const next = new URLSearchParams(params);
      next.set("tab", source.statement === "pl" ? "pnl" : source.statement);
      next.set("highlight", source.bucket);
      answer.collapse();
      onOpenChange(false);
      navigate({ pathname: "/dashboard", search: `?${next.toString()}` });
    },
    [params, navigate, answer, onOpenChange],
  );

  const openInChat = useCallback(() => {
    const turns = answer.transcript();
    void (async () => {
      const moved = await handOffThreadToChat(turns, {
        periodId: activePeriod.id,
        periodLabel: activePeriod.label,
      });
      // Degraded hand-off: seed the composer with the last question
      // rather than leaving a dead button.
      if (!moved) openAskCfoAi(turns[turns.length - 1]?.question ?? "");
      answer.collapse();
      onOpenChange(false);
      navigate(withPeriod("/chat"));
    })();
    // `withPeriod` is a render-local closure over `params`; listing it
    // would defeat the callback without changing behaviour.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answer, activePeriod.id, activePeriod.label, navigate, onOpenChange, params]);

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

  const hostItems: PaletteItem[] = useMemo(() => {
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

  // ── the Ask row + INV-1 ──────────────────────────────────────────────
  //
  // The router decides the LANE; the placement invariant is the router's
  // (`askIndex <= 1`) and this list honours it: Ask is row 0 when the
  // query reads as a question or nothing matched, row 1 otherwise. Enter
  // on the default row of a navigate / entity / action query is therefore
  // always free.
  const items: PaletteItem[] = useMemo(() => {
    const q = query.trim();
    const router = routeQuery(q);
    const askRow: PaletteItem = {
      id: "capsule.ask",
      group: t("capsuleRouter.group.ask"),
      label: q
        ? t("capsuleRouter.ask.row", { query: q })
        : t("capsuleRouter.ask.rowEmpty"),
      hint: askAvailability.block ? undefined : t("capsuleRouter.ask.hint"),
      icon: Sparkles,
      kbd: askAvailability.block ? undefined : `${mod}J`,
      ask: true,
      // A blocked ask still renders a row — it is the one place that
      // explains WHY — but activating it does nothing.
      blocked: Boolean(askAvailability.block),
      trailing: askAvailability.block ? (
        <CapsuleAskRowNotice block={askAvailability.block} />
      ) : undefined,
      run: () => {
        if (askAvailability.block) return;
        enterAnswerMode(q);
      },
    };
    const askAt =
      router.classification.lane === "ask" || hostItems.length === 0 ? 0 : 1;
    const next = [...hostItems];
    next.splice(askAt, 0, askRow);
    return next;
  }, [hostItems, query, t, mod, enterAnswerMode, askAvailability.block]);

  const askIndex = useMemo(() => items.findIndex((i) => i.ask), [items]);

  useEffect(() => {
    if (activeIdx >= items.length) setActiveIdx(0);
  }, [items.length, activeIdx]);

  // Keep the active row in view while arrowing.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  // Auto-grow the question field — a long question must be readable
  // before it is sent, and Shift+Enter has to have somewhere to go.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  }, [query, open, mode]);

  // ── global keys: ⌘J into Ask, and type-to-open ──────────────────────
  //
  // Registered in the CAPTURE phase at window so ⌘J is claimed BEFORE
  // AppShell's bubble-phase handler (which routes ⌘J to the full chat
  // page) ever sees it. `stopPropagation` on a window-capture listener
  // ends the dispatch, so no shared file had to be edited for this
  // binding — flagged as a cross-lane note rather than a silent grab.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && !e.shiftKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        e.stopPropagation();
        enterAnswerMode("");
        return;
      }
      if (open || meta || e.altKey) return;
      if (e.key.length !== 1) return;
      if (!/[\p{L}\p{N}]/u.test(e.key)) return;
      if (isEditable(document.activeElement) || modalOpen()) return;
      e.preventDefault();
      pendingChar.current = e.key;
      onOpenChange(true);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onOpenChange, enterAnswerMode]);

  function activate(index: number) {
    const item = items[index];
    if (!item) return;
    item.run();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      // ⌘K → ArrowUp on an empty box recalls the last question, the way
      // a shell recalls the last command. With text in the box it is
      // plain row navigation.
      if (!query) {
        const recalled = recall.older();
        if (recalled !== null) {
          setQuery(recalled);
          return;
        }
      }
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Tab" && !e.shiftKey && askIndex >= 0) {
      // Tab always lands on Ask — the second half of the router's
      // one-keystroke guarantee, for readers already several rows down.
      e.preventDefault();
      setActiveIdx(askIndex);
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      const q = query.trim();
      close();
      openAskCfoAi(q || undefined);
      navigate(withPeriod("/chat"));
    } else if (e.key === "Enter" && e.shiftKey) {
      // Newline — the field is a textarea precisely so a long question
      // can be composed here instead of in a different surface.
    } else if (e.key === "Enter") {
      e.preventDefault();
      activate(activeIdx);
    }
  }

  // ── rendering the flat list without breaking the keyboard order ─────
  //
  // The Ask row is wedged at index 1 (INV-1), which lands it INSIDE the
  // first group — splitting "Pages" into two runs. Two things follow,
  // and the first one was a real bug found in the screenshot loop:
  //
  //   · two runs meant two <div key="Pages">. Duplicate keys make React
  //     stop reconciling that list properly: rows from earlier renders
  //     survived, every row reported `data-idx="0"`, and the highlight
  //     sat on all of them at once.
  //   · even keyed correctly, "PAGES / Dashboard / ASK / … / PAGES /
  //     Workspaces" reads as a bug to the eye.
  //
  // So the top rows — the best match plus the Ask row — render as an
  // unheaded band, and headings resume below it. Flat indices are
  // untouched, so keyboard order and visual order still agree row for
  // row, which is what the router's one-keystroke guarantee rests on.
  const bandEnd = Math.min(askIndex + 1, items.length);
  const band = items.slice(0, bandEnd).map((item, idx) => ({ item, idx }));
  const grouped: { group: string; entries: { item: PaletteItem; idx: number }[] }[] = [];
  items.slice(bandEnd).forEach((item, i) => {
    const idx = bandEnd + i;
    const last = grouped[grouped.length - 1];
    if (last && last.group === item.group) last.entries.push({ item, idx });
    else grouped.push({ group: item.group, entries: [{ item, idx }] });
  });

  /** One dense row. Shared by the top band and the grouped runs so the
   *  two can never drift apart in style or in behaviour. */
  const renderRow = (item: PaletteItem, idx: number) => (
    // Single-line dense rows — a command surface, not a content list:
    // label left, muted hint right.
    <button
      id={`palette-item-${idx}`}
      data-idx={idx}
      data-ask={item.ask ? "true" : undefined}
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
        <item.icon size={15} strokeWidth={1.75} className="shrink-0 text-ink-soft" />
      ) : (
        <span className="w-[15px] shrink-0" aria-hidden />
      )}
      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{item.label}</span>
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
  );

  const answerMode = mode === "answer";

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
          data-mode={answerMode ? "answer" : "search"}
          onEscapeKeyDown={() => {
            // Esc collapses; `capsuleThread` keeps the conversation for
            // ten minutes so reopening resumes it.
            if (answerMode) answer.collapse();
          }}
          className={`
            fixed z-50 flex flex-col overflow-hidden
            ${answerMode
              // AA over dense prose. The glass survives as blur + a
              // near-opaque fill; at 0.9 the body text on this panel
              // sits on whatever happens to be behind it, and the
              // contract is "AA contrast or drop the glass".
              ? "bg-[hsl(var(--surface)/0.97)]"
              : "bg-[hsl(var(--surface)/0.9)]"}
            backdrop-blur-xl
            border border-rule
            shadow-2xl
            inset-x-2 top-2
            w-auto max-w-[calc(100vw-1rem)] rounded-lg
            sm:inset-x-auto sm:top-[112px] sm:left-1/2
            sm:-translate-x-1/2
            sm:w-full ${answerMode ? "sm:max-w-[680px]" : "sm:max-w-[600px]"}
            duration-overlay
            transition-[max-width] motion-reduce:transition-none
            data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95
            data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95
            motion-reduce:data-[state=open]:animate-none motion-reduce:data-[state=closed]:animate-none
          `}
        >
          <DialogPrimitive.Title className="sr-only">
            {answerMode ? t("capsuleAnswer.eyebrow") : t("common.search")}
          </DialogPrimitive.Title>

          {answerMode ? (
            <>
              <div className="flex items-center gap-2 border-b border-rule-soft px-3 py-2">
                <button
                  type="button"
                  onClick={() => {
                    answer.collapse();
                    setMode("search");
                  }}
                  aria-label={t("capsuleAnswer.back")}
                  data-testid="capsule-answer-back"
                  className="
                    inline-flex h-7 w-7 items-center justify-center rounded-sm
                    text-ink-mute transition-colors duration-micro
                    hover:bg-bg-2 hover:text-ink
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
                  "
                >
                  <ArrowLeft size={15} strokeWidth={1.75} />
                </button>
                <span className="flex-1 text-[10px] font-medium uppercase tracking-[0.14em] text-ink-mute">
                  {t("capsuleAnswer.eyebrow")}
                </span>
                <kbd className="hidden sm:inline-block rounded-sm border border-rule bg-bg-2 px-1.5 py-0.5 font-mono text-[10.5px] text-ink-mute">
                  {t("capsuleAnswer.backHint")}
                </kbd>
              </div>
              <CapsuleAnswerPanel
                className="max-h-[min(560px,72vh)] transition-[max-height] duration-overlay motion-reduce:transition-none"
                turns={answer.turns}
                busy={answer.busy}
                citation={citation}
                onAsk={askModel}
                onRetry={answer.retry}
                onJump={jumpToSource}
                onOpenInChat={openInChat}
              />
            </>
          ) : (
            <>
              <div className="flex items-start gap-3 border-b border-rule-soft px-4 py-3">
                <Search size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-ink-mute" />
                <textarea
                  ref={inputRef}
                  autoFocus
                  rows={1}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={onKeyDown}
                  placeholder={t("shell.palette.placeholder")}
                  role="combobox"
                  aria-expanded="true"
                  aria-controls="command-palette-list"
                  aria-activedescendant={items[activeIdx] ? `palette-item-${activeIdx}` : undefined}
                  className="
                    max-h-24 flex-1 resize-none bg-transparent text-[14px] leading-6
                    text-ink placeholder:text-ink-mute outline-none
                  "
                />
                <kbd className="mt-0.5 hidden sm:inline-block rounded-sm border border-rule bg-bg-2 px-1.5 py-0.5 font-mono text-[10.5px] text-ink-mute">
                  esc
                </kbd>
              </div>

              <div
                ref={listRef}
                id="command-palette-list"
                role="listbox"
                className="max-h-[min(420px,60vh)] overflow-y-auto py-1.5"
              >
                {/* With the box empty the suggestions lane owns this
                    space: workspace context, its own trust line, the
                    period-aware suggestions and the recent questions.
                    It is CLICK-ONLY here (no `activeIndex`/`indexOffset`)
                    — the flat keyboard order below it stays exactly what
                    the router's placement invariant describes, and no
                    row silently changes index when a suggestion list
                    grows. Wiring its rows into the arrow-key order is a
                    follow-up both lanes should design together. */}
                {!query.trim() && <CapsuleEmptyState onPick={(q) => enterAnswerMode(q)} />}
                {items.length === 0 ? (
                  <div className="px-4 py-8 text-center text-[13px] text-ink-soft">
                    {t("shell.palette.noResults")}
                  </div>
                ) : (
                  <>
                    {/* The top band: best match + Ask, no heading. */}
                    <ul>
                      {band.map(({ item, idx }) => (
                        <li key={item.id}>{renderRow(item, idx)}</li>
                      ))}
                    </ul>
                    {grouped.map((g, gi) => (
                      // The key carries the run index: one group label can
                      // legitimately appear in two runs, and a bare label
                      // key made React reconcile the list wrongly.
                      <div key={`${g.group}-${gi}`}>
                        <div className="px-4 pb-1 pt-2 text-[10px] font-medium uppercase tracking-[0.14em] text-ink-mute">
                          {g.group}
                        </div>
                        <ul>
                          {g.entries.map(({ item, idx }) => (
                            <li key={item.id}>{renderRow(item, idx)}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </>
                )}
              </div>

              <div className="flex items-center justify-between border-t border-rule-soft px-4 py-2 text-[11px] text-ink-mute">
                <span>{t("shell.palette.navHint")}</span>
                <span className="font-mono tabular-nums">{items.length}</span>
              </div>
            </>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
