// THE CAPSULE — the ask-first surface (⌘K), and the app's ONE glass panel.
//
// ══ WHAT CHANGED, AND WHY ═══════════════════════════════════════════════
//
// This surface used to be a search palette that also had an Ask row. It
// opened with the placeholder "Search pages, actions, periods,
// companies…", stacked FIVE sections of empty state (period status,
// recent questions, a workspace suggestion, actions, every page) for
// eighteen rows, and offered "Ask a question" as one list item among
// them — below "Dashboard".
//
// Every one of those is the same mistake: the surface described what it
// COULD do instead of what it is FOR. It is for asking.
//
//   · the verb is ASK. The placeholder names the period you are asking
//     about, live: "Ask about Dec 2025 — or jump anywhere"
//   · there is NO Ask row. Typing prose IS asking, and Enter answers.
//     The one exception is an EXACT navigation match ("dashboard"),
//     because someone who typed a destination's whole name meant the
//     destination
//   · the empty state is THREE zones — context strip, up to three asks,
//     four jumps — and each renders nothing rather than something empty,
//     so the panel's height is the sum of what is true
//   · everything else lives behind typing, where the router already
//     answers every keystroke in under 5ms and for free
//
// ══ THE MODEL-SPEND RULE ════════════════════════════════════════════════
//
// `lib/capsuleRouter` classifies EVERY keystroke with no model call, and
// `willCallModel(result, index)` is the predicate that says whether
// activating a row costs one. Deleting the Ask row did not weaken that —
// it moved the paid path from "a row you can arrow onto" to ONE function,
// `askModel`, reachable from exactly three places (Enter with no exact
// nav match, ⌘J, and a suggestion the reader confirmed). Navigation,
// entities and actions cannot reach it at all, and the gate asserts that
// by counting network requests rather than by reading this comment.
//
// TWO THINGS NOW STAND IN FRONT OF `askModel`, and both are here rather
// than in the router because this is where Enter is pressed:
//
//   TIER 0     `enterAnswerMode` resolves the question against the local
//              fact index FIRST and, when it resolves, pushes a finished
//              turn instead of asking. No reservation, no request. The
//              preview above the rows used to show that answer for free
//              and then charge for arriving at it; it no longer can.
//   HOW-TO     the router resolves "how do i export the balance sheet"
//              to the imperative inside it and stamps
//              `classification.redirected`; `routerNav` turns that stamp
//              into the destination Enter opens. A navigation question
//              with a question mark on it stays navigation.
//
// `capsuleSpendBoundary.test.tsx` measures this by driving the real
// component and counting requests to the two model seams, because
// measuring the resolver in isolation is a different claim from
// measuring the surface — that gap is exactly how this defect survived.
//
// ══ THE GLASS ═══════════════════════════════════════════════════════════
//
// This is the one surface in the app allowed resting depth, and it earns
// it by floating. It MORPHS out of the header capsule rather than
// appearing beside it (`capsuleMorph`), runs to 720px, and its height is
// its content's.
//
// `sm:mx-auto` below is the horizontal FALLBACK only. When the trigger
// can be measured, `capsuleMorph` overrides left/margin inline and the
// panel centres under the CAPSULE rather than under the viewport — the
// 240px rail makes those two permanently different places, which is the
// 28px of centre drift K6 was failing on.
//
// THE GLASS IS 0.92 FILL + a 24px backdrop blur, and both numbers are
// measured rather than chosen:
//
//   · CONTRAST FIRST. Every text node on this panel was measured through
//     the real composite (scrim → panel → row) in both themes. At the
//     fill below, all of them clear AA (worst node: 5.29 on Paper, 7.67
//     on Terminal). That measurement is what fixes the number — not
//     taste. It is also why this lane's text sits on `ink-soft` rather
//     than `ink-mute`: measured on this panel, `ink-mute` is 3.53 and
//     fails, `ink-soft` is 5.82 and passes.
//   · THE BLUR IS LOAD-BEARING, which an A/B proved. Dropped to
//     `backdrop-blur-none` at a 0.96 fill, the page's OWN TEXT became
//     legible straight through the panel — the r5b capture shows the
//     dashboard heading and its Export button reading through the
//     answer. Translucency without a blur is not glass, it is a hole.
//     The blur is what turns the page behind into the low-frequency
//     wash the AA measurement below is valid against.
//   · SCRIM 50%. It is the other half of the same job: the darker the
//     backdrop, the less the wash can vary, and the closer the measured
//     contrast is to the contrast a reader actually gets over an
//     arbitrary page.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
// Radix primitive directly (not ui/dialog's DialogContent): the shared
// wrapper hard-codes the heavy black/80 overlay, which turns the glass
// panel into fog on Paper. The palette owns a lighter scrim instead.
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  ArrowLeft,
  BookOpen,
  CalendarDays,
  Download,
  Globe,
  PanelLeft,
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
import { foldQuery, routeQuery } from "@/lib/capsuleRouter";
import { buildFactIndex } from "@/lib/capsuleFactIndex";
import { resolveTier0, type Tier0Answer } from "@/lib/capsuleTier0";
import {
  LAT_CAPSULE_OPEN,
  LAT_INDEX_BUILD,
  LAT_TIER0_PAINT,
  mark,
  measure,
} from "@/lib/capsuleLatency";
import { useActivePeriod } from "@/lib/activePeriod";
import { factsFrom } from "@/lib/servedFacts";
import { openAskCfoAi } from "@/components/cfo/chat/openAskCfoAi";
import type { TraceableSource } from "@/lib/traceableSource";

import "./capsuleAnswer/capsuleAnswerI18n";
import {
  CapsuleAnswerPanel,
  type HostCitation,
} from "./capsuleAnswer/CapsuleAnswerPanel";
import { CapsuleTier0Preview } from "./capsuleAnswer/CapsuleTier0Preview";
import { useCapsuleAnswer } from "./capsuleAnswer/useCapsuleAnswer";
// The suggestions / degraded / limits lane's public barrel. Its own
// header names this file as the host, so the mount points live here.
import {
  CapsuleEmptyState,
  recordJump,
  releaseCapsuleAsk,
  rememberCapsuleQuestion,
  reserveCapsuleAsk,
  useCapsuleAskAvailability,
  useCapsuleKeys,
  useCapsuleRecall,
} from "./capsuleEmpty";
import { useCapsuleMorph } from "./capsuleMorph";
import { useCapsuleHeight } from "./capsuleHeight";
import { CapsuleComposer } from "./CapsuleComposer";
import "./capsuleCraftI18n";
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
  /** A destination — eligible to be the EXACT-match Enter target, and
   *  counted for the Jump zone's "most-used" ranking. */
  destination?: boolean;
  /** Extra strings that NAME this row, beyond its label. A company row
   *  is labelled with the company's name but reached by its TICKER, so
   *  typing "TLV" is typing that row's name even though the label says
   *  "Banca Transilvania". Folded before comparison, like the label. */
  exactTokens?: readonly string[];
  run: () => void;
}

/** What Enter does right now. Rendered in the footer, because the whole
 *  point of deleting the Ask row was that a verb does not need a row. */
type Primary =
  | { kind: "ask"; question: string }
  | { kind: "nav"; item: PaletteItem }
  | { kind: "row"; item: PaletteItem; index: number }
  | { kind: "none" };

// Snapshot of the concept catalog — the registry never mutates at runtime.
const ALL_CONCEPTS: Concept[] = Object.values(CONCEPTS_BY_KEY);

/** Router `commandId` → the palette row that runs it.
 *
 *  A cross-lane map, and deliberately a small explicit one: the router
 *  publishes commands as DATA (`CAPSULE_ACTIONS`) and this file builds
 *  the rows that execute them, so something has to join the two. A miss
 *  is survivable — the redirect falls back to "no navigation", which is
 *  the behaviour before the join existed. */
const COMMAND_ITEM_ID: Record<string, string> = {
  "capsule.upload": "act-upload",
  "capsule.export": "act-export",
  "capsule.theme": "act-theme",
  "capsule.newChat": "act-ask",
  "capsule.toggleSidebar": "act-rail",
};

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
  const { periods, goToPeriod, selectedMonth } = usePeriodStepper();
  const { resolvedTheme, setTheme } = useTheme();
  const run = useDailyRun();
  const popoverStack = usePopoverStack();
  const activePeriod = useActivePeriod();
  const { userKey, orgKey } = useCapsuleKeys();
  // ONE predicate for "may this surface spend a model call right now" —
  // the assistant being down and the per-user burst guard collapse into
  // it, and every paid path reads it in one place.
  const askAvailability = useCapsuleAskAvailability(userKey);
  const recall = useCapsuleRecall(orgKey);

  const [query, setQuery] = useState("");
  /** -1 means "no row is selected" — the resting state, where Enter runs
   *  the PRIMARY action rather than a row. Arrowing down enters the list. */
  const [activeIdx, setActiveIdx] = useState(-1);
  /** Tab forces the ask lane even when the query is an exact destination.
   *  It is the escape hatch for "I really do want to ask about the
   *  dashboard", and it is what the live gate presses. */
  const [askForced, setAskForced] = useState(false);
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

  // THE MONTH, AND ONLY EVER A MONTH — resolved the way the HEADER
  // resolves it.
  //
  // Two failures, one field, caught one round apart in the screenshot
  // loop:
  //   r0  `activePeriod.label` sat here as a fallback, so a period with
  //       no `period_end` made the surface say "Period · Meridian
  //       Industries SRL" — a company name in the month slot.
  //   r1  the fallback was removed, and the surface then said nothing at
  //       all while the header, three rows above, said "Aug 2026".
  //
  // Both come from asking a different question of the app than the
  // header asks. `usePeriodStepper().selectedMonth` IS the header's
  // answer — `formatPeriodMonth` of the SELECTED period row — so it is a
  // month by construction and cannot become a company name. The
  // resolved-period date stays as the second source, for a demo period
  // that never reaches the stepper's list.
  const periodMonth = useMemo(
    () => selectedMonth ?? formatPeriodMonth(activePeriod.periodEnd, locale),
    [selectedMonth, activePeriod.periodEnd, locale],
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

  // ── TIER 0: the answer that arrives while you type ──────────────────
  //
  // ONE period — the one that is open. The stepper's other periods carry
  // no statements on the client, and fetching them here would put a
  // network request on the keystroke path, which is the exact thing C4
  // exists to forbid. A single-period index still answers every "what is
  // X" question and honestly REFUSES every comparison ("only one period
  // is loaded"), which is better than a comparison that had to fetch.
  const factIndex = useMemo(() => {
    mark(LAT_INDEX_BUILD);
    const statements = activePeriod.statements;
    const index = buildFactIndex({
      periods:
        statements && activePeriod.id
          ? [
              {
                periodId: activePeriod.id,
                periodLabel: periodMonth ?? "",
                statements,
                metrics: Object.fromEntries(
                  activePeriod.metrics.map((m) => [m.name, m.value]),
                ),
                docId: activePeriod.sourceDocumentFilename ?? undefined,
              },
            ]
          : [],
      activePeriodId: activePeriod.id,
    });
    measure(LAT_INDEX_BUILD, LAT_INDEX_BUILD);
    return index;
  }, [
    activePeriod.statements,
    activePeriod.id,
    activePeriod.metrics,
    activePeriod.sourceDocumentFilename,
    periodMonth,
  ]);

  const tier0: Tier0Answer | null = useMemo(() => {
    const q = query.trim();
    if (!q) return null;
    mark(LAT_TIER0_PAINT);
    const resolved = resolveTier0(q, factIndex);
    // Measured on every keystroke that resolves, so the "instant" claim
    // is a number in `snapshotLatency()` rather than an adjective here.
    if (resolved) measure(LAT_TIER0_PAINT, LAT_TIER0_PAINT);
    return resolved;
  }, [query, factIndex]);

  // The status dot pulses ONCE when a Tier-0 answer actually resolves —
  // a refusal is not a resolution and does not pulse.
  const [pulseKey, setPulseKey] = useState(0);
  const lastPulse = useRef<string>("");
  useEffect(() => {
    const signature =
      tier0 && !tier0.refused && tier0.facts.length > 0
        ? `${tier0.kind}:${tier0.facts.map((f) => f.factKey).join(",")}`
        : "";
    if (!signature || signature === lastPulse.current) {
      lastPulse.current = signature;
      return;
    }
    lastPulse.current = signature;
    setPulseKey((n) => n + 1);
  }, [tier0]);

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
   *  not an error state: the surface still opens, and the empty state
   *  already says why it is unavailable. */
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

  /**
   * ENTER — AND THE SPEND BOUNDARY.
   *
   * ── The defect this shape exists to close ────────────────────────────
   *
   * `resolveTier0` ran in a memo above and fed `CapsuleTier0Preview` as
   * the reader typed, so the answer was on screen, in 0.013ms, with its
   * provenance — and then Enter called `askModel` unconditionally. The
   * question Tier 0 had already answered took a chat reservation and
   * issued a model request anyway. The preview was free; arriving at the
   * same figure was billed.
   *
   * The Tier-0 contract is "INSTANT, ZERO MODEL CALLS, works
   * offline/credits-down", and this line is the only place in the app
   * where that contract can be kept or broken, because it is the only
   * place where pressing Enter costs money.
   *
   * ── Why it is a full turn and not a bigger preview ───────────────────
   *
   * `answerLocally` pushes a FINISHED TURN into the same thread the
   * model path writes to, so the reader gets the fact card, the
   * provenance dot, the citation footer and the follow-up chips — the
   * whole canvas. A Tier-0 answer is an answer. The `interpret` chip on
   * it is the deliberate door to Tier 1: one keystroke, explicitly
   * chosen, and the only way from here to a paid call for this question.
   *
   * ── The order of the two calls ───────────────────────────────────────
   *
   * `answerLocally` first, `askModel` only on its `false`. Not the other
   * way round and not in parallel: `askModel` reserves before it
   * dispatches, so any arrangement where both run has already spent
   * budget by the time the local answer lands.
   */
  const enterAnswerMode = useCallback(
    (question: string) => {
      answer.open();
      setMode("answer");
      onOpenChange(true);
      const q = question.trim();
      if (!q) return;
      setQuery("");
      // The SAME resolution the preview showed, re-run against the same
      // index — pure, synchronous, no network. Re-running is cheaper
      // than threading the memo's value through, and it cannot be stale.
      // G8 PLANT P3 — the short-circuit disabled.
      if (false && answer.answerLocally(q, resolveTier0(q, factIndex))) {
        rememberCapsuleQuestion(orgKey, q);
        return;
      }
      askModel(q);
    },
    [answer, onOpenChange, askModel, factIndex, orgKey],
  );

  useEffect(() => {
    if (open) {
      mark(LAT_CAPSULE_OPEN);
      setActiveIdx(-1);
      setAskForced(false);
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

  /**
   * THE COMMANDS, UNFILTERED.
   *
   * Hoisted out of `items` because `items` filters every row by
   * substring-of-the-query, and `routerNav` needs to find a command by
   * IDENTITY. Caught by K10.d: "how do i upload a trial balance"
   * classifies as the upload ACTION and no palette row survived the
   * filter — no label contains that whole sentence — so the redirect
   * found nothing and Enter fell through to the model. The route half
   * of the redirect never hit this because it builds its own row from
   * the router's `to`; a command has no `to`, only an executor, and the
   * executor lives here.
   */
  const actionItems: PaletteItem[] = useMemo(
    () => [
      {
        id: "act-upload",
        group: t("shell.palette.actions"),
        label: t("shell.palette.upload"),
        hint: t("shell.palette.uploadHint"),
        icon: Upload,
        destination: true,
        run: () => go("/dashboard"),
      },
      {
        id: "act-export",
        group: t("shell.palette.actions"),
        label: t("shell.palette.export"),
        hint: t("shell.palette.exportHint"),
        icon: Download,
        destination: true,
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
        destination: true,
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
        destination: true,
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
        destination: true,
        run: () => {
          try { window.dispatchEvent(new Event(SIDEBAR_TOGGLE_EVENT)); } catch { /* SSR */ }
          close();
        },
      },
    ],
    // `go`/`close`/`setTheme`/`onOpenAi` are render-local closures,
    // behaviorally constant — the same exemption `items` below carries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, mod, resolvedTheme],
  );

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
            destination: true,
            run: () => {
              recordJump(orgKey, `page-${item.to}`);
              go(item.to);
            },
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
        destination: true,
        run: () => {
          recordJump(orgKey, "page-/settings");
          go("/settings");
        },
      });
    }

    // Actions — the list itself lives above (`actionItems`).
    for (const a of actionItems) if (match(a.label, a.hint)) out.push(a);

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
            // Typing a whole ticker IS typing this row's name.
            exactTokens: co.ticker ? [co.ticker] : undefined,
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
  }, [query, groups, periods, categories, skus, companies, actionItems, resolvedTheme, locale, t, mod, orgKey]);

  // ── THE RESTING JUMP ZONE IS GONE ──────────────────────────────────
  //
  // Four ranked destinations used to render under the suggestions, at
  // the same 40px, with the same muted right-hand text. The craft pass
  // deleted the zone (see `CapsuleEmptyState`'s header for the full
  // trade). `recordJump` below still runs on every navigation, so the
  // counts keep accruing and the zone costs nothing to restore.
  //
  // CROSS-LANE NOTE, not a silent drop: `MAX_JUMPS`, `rankByUsage` and
  // `readJumpCounts` are still exported by `capsuleEmpty/index.ts` and
  // are now referenced by no live surface. Left in place rather than
  // deleted — removing a lane's public barrel entries is a bigger blast
  // radius than this pass was asked for. Flagged for the coordinator.

  // ── the primary Enter action ─────────────────────────────────────────
  //
  // THE RULE: Enter answers. It navigates only when the input is EXACTLY
  // the NAME of something you can open — folded, so "Bilanț" and "bilant"
  // both count — because someone who typed a whole name meant it.
  // Anything shorter or longer than an exact name is prose, and prose is
  // a question.
  //
  // "Name" includes a row's `exactTokens`. Caught live in the r2 loop:
  // typing "TLV" put the Banca Transilvania row on screen and still
  // aimed Enter at the model, because the ROW's label is the company's
  // name while the thing the reader typed was its ticker. A row you can
  // see, whose identifier you typed in full, is not a question.
  //
  // `askForced` (Tab) overrides even that. `activeIdx >= 0` overrides
  // everything: an explicitly selected row is an explicit instruction.
  const routed = useMemo(() => routeQuery(query), [query]);

  const exactNav = useMemo(() => {
    const folded = foldQuery(query);
    if (!folded) return null;
    // THE ROUTER HAS A VETO. A query it classifies as `ask` stays a
    // question even if it happens to spell a destination — "is the
    // balance sheet balanced" is not a request for the balance sheet
    // page, and the router's precedence table already knows that. The
    // exact-name test below is the second condition, not the only one.
    if (routed.classification.lane === "ask") return null;
    return (
      items.find((i) => {
        if (foldQuery(i.label) === folded) return i.destination || Boolean(i.exactTokens);
        return (i.exactTokens ?? []).some((tok) => foldQuery(tok) === folded);
      }) ?? null
    );
  }, [items, query, routed]);

  /**
   * THE INTERROGATIVE FORM OF AN ACTION QUERY.
   *
   * "export the balance sheet" is an exact-enough destination phrase and
   * navigates for free. "how do i export the balance sheet" is the same
   * instruction with an opener in front — and it used to reach the model,
   * because the palette's own Enter rule is "exact name, or ask", and a
   * question is never an exact name.
   *
   * The router now resolves that opener away and stamps
   * `classification.redirected`. This reads that stamp and nothing else:
   * without it, honouring the router's navigate lane in general would
   * change Enter for every partial route match ("cash" would open the
   * cash-flow page instead of asking about cash), which is a different
   * decision and not this one.
   */
  const routerNav = useMemo<PaletteItem | null>(() => {
    if (!routed.classification.redirected) return null;
    const row = routed.rows.find((r) => r.kind === "route" || r.kind === "action");
    if (!row) return null;
    if (row.kind === "action" && row.commandId) {
      // `actionItems`, NOT `items`: `items` is filtered by
      // substring-of-the-query and a how-to sentence matches no label.
      return actionItems.find((i) => i.id === COMMAND_ITEM_ID[row.commandId!]) ?? null;
    }
    if (row.kind !== "route" || !row.to) return null;
    const to = row.to;
    return {
      id: row.id,
      group: t("shell.palette.pages"),
      label: row.labelKey ? t(row.labelKey) : to,
      destination: true,
      run: () => {
        recordJump(orgKey, row.id);
        go(to);
      },
    };
    // `go` is a render-local closure over `params`/`navigate`; listing it
    // would defeat the memo without changing behaviour.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routed, actionItems, t, orgKey]);

  const primary: Primary = useMemo(() => {
    if (activeIdx >= 0 && items[activeIdx]) {
      return { kind: "row", item: items[activeIdx], index: activeIdx };
    }
    const q = query.trim();
    if (!q) return { kind: "none" };
    const nav = exactNav ?? routerNav;
    if (nav && !askForced) return { kind: "nav", item: nav };
    return { kind: "ask", question: q };
  }, [activeIdx, items, query, exactNav, routerNav, askForced]);

  useEffect(() => {
    if (activeIdx >= items.length) setActiveIdx(-1);
  }, [items.length, activeIdx]);

  // Keep the active row in view while arrowing.
  useEffect(() => {
    if (activeIdx < 0) return;
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

  function runPrimary() {
    if (primary.kind === "none") return;
    if (primary.kind === "row" || primary.kind === "nav") {
      primary.item.run();
      return;
    }
    // ONE TURN AT A TIME — and this is the THIRD guard, not the only one.
    //
    // The deleted `CapsuleAnswerPanel` composer had `if (!q || busy)
    // return`, so the craft pass moved it here with the composer. Then
    // K10.f's plant was run and stayed GREEN, which is how it came out
    // that `useCapsuleAnswer` already guards the same thing twice
    // (`ask` and `answerLocally` both check `busyRef`). Any ONE of the
    // three stops a second turn; the gate only goes red with all three
    // removed, and the plant record in the craft critique says so
    // rather than claiming this line is load-bearing.
    //
    // It stays because it is the guard at the layer the READER acts on —
    // the keypress — and because a surface whose composer can fire an
    // action the hook will silently drop is a surface with a dead key.
    //
    // Navigation is deliberately NOT guarded: leaving for a page while
    // an answer streams is a legitimate thing to want, and the thread
    // survives on `capsuleThread`'s grace window.
    if (answer.busy) return;
    enterAnswerMode(primary.question);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setAskForced(false);
      setActiveIdx((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      // ⌘K → ArrowUp on an empty box recalls the last question, the way
      // a shell recalls the last command. This is where the recent-
      // questions SECTION went: reachable, not displayed.
      if (!query && activeIdx < 0) {
        const recalled = recall.older();
        if (recalled !== null) {
          setQuery(recalled);
          return;
        }
      }
      // -1 is a real stop: arrowing back off the top returns to the
      // resting state, where Enter answers again.
      setActiveIdx((i) => Math.max(i - 1, -1));
    } else if (e.key === "Tab" && !e.shiftKey) {
      // Tab is the ask lane's escape hatch: it leaves the rows and
      // guarantees Enter answers, whatever the query happens to spell.
      e.preventDefault();
      setActiveIdx(-1);
      setAskForced(true);
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
      runPrimary();
    }
  }

  // ── rows ─────────────────────────────────────────────────────────────
  //
  // Grouped runs with 10px caps labels. The Ask row is gone, so there is
  // no longer a wedged item splitting a group in two — the duplicate-key
  // bug that shape used to cause went with it.
  const grouped: { group: string; entries: { item: PaletteItem; idx: number }[] }[] = [];
  items.forEach((item, idx) => {
    const last = grouped[grouped.length - 1];
    if (last && last.group === item.group) last.entries.push({ item, idx });
    else grouped.push({ group: item.group, entries: [{ item, idx }] });
  });

  /** ONE 36px ROW.
   *
   *  Two things left it in the craft pass, and both were carrying no
   *  information at 680px:
   *
   *    · 4px of height. 40 → 36. Read against the chips above it, that
   *      is what stops the surface looking like one undifferentiated
   *      list of eight equivalent things.
   *    · `item.hint`, on the rows where it said nothing. It is
   *      SUPPRESSED for a `destination` (where it was the rail group —
   *      "Dashboard … Overview", "Scenarios … Analyze", restating a
   *      place the reader had already recognised by name) and for any
   *      row that carries a `trailing` node (where the chip already
   *      says what kind of thing the row is, and "Cash Flow  LEARN"
   *      spent two right-aligned labels on one fact).
   *
   *      It is KEPT everywhere else, because elsewhere it is identity
   *      rather than category: a company row is labelled "Banca
   *      Transilvania" and reached by "TLV", and dropping the hint
   *      would take the ticker off the screen. That is the difference
   *      between deleting decoration and deleting information.
   *
   *  Selection is an accent left rule plus a quiet fill, never a heavy
   *  block highlight. */
  const renderRow = (item: PaletteItem, idx: number) => (
    <button
      id={`palette-item-${idx}`}
      data-idx={idx}
      role="option"
      aria-selected={idx === activeIdx}
      onClick={() => item.run()}
      onMouseEnter={() => setActiveIdx(idx)}
      className={`
        relative flex h-9 w-full items-center gap-3 pl-4 pr-3 text-left
        transition-colors duration-micro
        ${idx === activeIdx ? "bg-bg-2/70" : "hover:bg-bg-2/40"}
      `}
    >
      {idx === activeIdx && (
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
          className={`shrink-0 ${idx === activeIdx ? "text-brand" : "text-ink-soft"}`}
        />
      ) : (
        <span className="w-[14px] shrink-0" aria-hidden />
      )}
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">{item.label}</span>
      {item.hint && !item.destination && !item.trailing && (
        <span className="max-w-[38%] shrink-0 truncate text-[11px] text-ink-soft">
          {item.hint}
        </span>
      )}
      {item.trailing}
      {item.kbd && (
        <kbd className="shrink-0 rounded-sm border border-rule bg-bg-2 px-1.5 py-0.5 font-mono text-[10px] text-ink-soft">
          {item.kbd}
        </kbd>
      )}
    </button>
  );

  const answerMode = mode === "answer";
  const typing = query.trim().length > 0;
  const [composerFocused, setComposerFocused] = useState(false);
  // `enabled` gates the ANIMATION only. The hook still anchors the panel
  // under the capsule in answer mode — the canvas must not jump sideways
  // the moment a question is asked.
  const morph = useCapsuleMorph(open, !answerMode);

  // ── THE CARD'S HEIGHT ───────────────────────────────────────────────
  //
  // Measured from the content and transitioned, so the composer pinned
  // to the bottom edge TRAVELS when the surface grows instead of
  // teleporting. See `capsuleHeight` for why the measurement is not
  // circular. Off below `sm`, where the card is full-bleed chrome
  // rather than a card.
  const [viewport, setViewport] = useState<{ w: number; h: number }>(() => ({
    w: typeof window === "undefined" ? 1440 : window.innerWidth,
    h: typeof window === "undefined" ? 900 : window.innerHeight,
  }));
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () =>
      setViewport({ w: window.innerWidth, h: window.innerHeight });
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const narrow = viewport.w < 640;
  const maxCardHeight = Math.round(viewport.h * (narrow ? 0.82 : 0.7));
  const card = useCapsuleHeight({
    max: maxCardHeight,
    enabled: open && !narrow,
  });

  const placeholder = periodMonth
    ? t("capsuleCraft.composer.placeholder", { period: periodMonth })
    : t("capsuleCraft.composer.placeholderNoPeriod");

  const jumpsOnEnter = primary.kind === "nav" || primary.kind === "row";
  const jumpTarget = jumpsOnEnter ? primary.item.label : undefined;

  /**
   * THE ONE COMPOSER, RENDERED ONCE.
   *
   * Declared here as a value rather than inline in two branches on
   * purpose: two JSX blocks in two branches are two ELEMENTS to React,
   * and remounting the textarea on the search→answer transition would
   * drop focus, drop the caret, and re-run the mount animation — which
   * is the mode switch this composition exists to delete, reintroduced
   * by a reconciliation detail nobody would look at.
   */
  const composer = (
    <div ref={card.composerRef}>
      <CapsuleComposer
        ref={inputRef}
        value={query}
        onChange={(next) => {
          setQuery(next);
          setAskForced(false);
          setActiveIdx(-1);
        }}
        onKeyDown={onKeyDown}
        onSubmit={runPrimary}
        placeholder={placeholder}
        jumps={jumpsOnEnter}
        jumpTarget={jumpTarget}
        // One element, two names. `capsule-followup` is what the answer
        // surface's own screenshot driver reaches for; `capsule-composer`
        // is what the craft gates read. Both point at this textarea.
        testId={answerMode ? "capsule-followup" : "capsule-composer"}
        ariaLabel={t("capsuleEmpty.placeholder.aria")}
        activeDescendant={
          activeIdx >= 0 && items[activeIdx] ? `palette-item-${activeIdx}` : undefined
        }
        focused={composerFocused}
        onFocusChange={setComposerFocused}
        below={
          /* THE KEY LEGEND. ONE line, right aligned, and it names only
             bindings this surface actually has. The brief asked for
             "Tab to jump"; Tab on this surface FORCES THE ASK LANE
             (`askForced`), which is a real, gated affordance — so the
             legend says what Tab does. A legend that describes a
             binding the product does not have is a lie rendered at
             10px, and this pass exists to delete one of those (the
             footer that restated the placeholder), not to add another. */
          <div className="flex justify-end px-3.5 pb-1.5 text-[10px] text-ink-soft">
            <span data-testid="capsule-keys" className="hidden truncate sm:inline">
              {t("capsuleCraft.keys")}
            </span>
          </div>
        }
      />
    </div>
  );

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        {/* Scrim at 40% — enough to sink the page behind the glass so the
            panel's own translucency has something calm to sit on. */}
        <DialogPrimitive.Overlay
          className="
            fixed inset-0 z-50 bg-black/40
            data-[state=open]:animate-in data-[state=open]:fade-in-0
            data-[state=closed]:animate-out data-[state=closed]:fade-out-0
          "
        />
        <DialogPrimitive.Content
          ref={morph.ref as unknown as React.Ref<HTMLDivElement>}
          style={morph.style}
          data-testid="command-palette"
          data-mode={answerMode ? "answer" : "search"}
          data-typing={typing ? "true" : undefined}
          data-morphing={morph.morphing ? "true" : undefined}
          onCloseAutoFocus={(e) => {
            // H6. Radix restores focus to whatever opened the dialog, but
            // this one is opened from AppShell state rather than a
            // DialogTrigger, so nothing owned the restore and Escape left
            // focus on <body>. A keyboard user lost their place and had to
            // Tab from the top of the document (WCAG 2.4.3).
            const bar = document.querySelector<HTMLElement>(
              '[data-testid="header-command-bar"]');
            if (!bar) return;      // no trigger mounted: let Radix decide
            e.preventDefault();
            bar.focus();
          }}
          onEscapeKeyDown={() => {
            // Esc collapses; `capsuleThread` keeps the conversation for
            // ten minutes so reopening resumes it.
            if (answerMode) answer.collapse();
          }}
          // ── THE GLASS, AND THE 14px CARD ───────────────────────────
          //
          // 680px, radius 14, one inner hairline highlight along the top
          // edge (`ring-1 ring-inset` reads as a lit rim on a
          // translucent panel, which is what makes it a pane of
          // something rather than a rectangle of colour), a real depth
          // shadow, and the 24px backdrop blur the A/B proved is
          // load-bearing — without it the page's own text reads
          // straight through the panel.
          className="
            fixed z-50 flex flex-col overflow-hidden
            inset-x-2 top-2 w-auto max-w-[calc(100vw-1rem)]
            sm:inset-x-0 sm:top-[68px] sm:mx-auto sm:w-full sm:max-w-[680px]
            rounded-[14px] border border-rule
            ring-1 ring-inset ring-rule-soft
            bg-[hsl(var(--surface)/0.92)] backdrop-blur-xl
            shadow-2xl
            data-[state=open]:animate-in data-[state=open]:fade-in-0
            data-[state=closed]:animate-out data-[state=closed]:fade-out-0
            motion-reduce:data-[state=open]:animate-none
            motion-reduce:data-[state=closed]:animate-none
          "
        >
          <DialogPrimitive.Title className="sr-only">
            {answerMode ? t("capsuleAnswer.eyebrow") : t("capsuleEmpty.placeholder.aria")}
          </DialogPrimitive.Title>

          {/* THE STACK. Content above, composer below, one animated
              height between them. Nothing here branches on `mode` except
              what goes in the thread — which is the entire point: the
              card the reader is looking at before they ask and the card
              they are looking at afterwards are the same card. */}
          <div
            data-testid="capsule-stack"
            style={
              card.height !== null && !narrow ? { height: card.height } : undefined
            }
            className="
              flex min-h-0 flex-1 flex-col overflow-hidden
              transition-[height] duration-[160ms] ease-quint
              motion-reduce:transition-none
              max-h-[82vh] sm:max-h-[70vh]
            "
          >
            <div
              ref={listRef}
              id="command-palette-list"
              role="listbox"
              aria-busy={answer.busy || undefined}
              className="chat-scroll min-h-0 flex-1 overflow-y-auto"
            >
              <div ref={card.threadRef} className="pb-2 pt-2.5">
                {answerMode ? (
                  <>
                    {/* The way back, as a 24px ghost glyph in the card's
                        own top-left gutter — NOT a header bar. The bar it
                        replaces ("← ANSWER … Esc") announced that the
                        reader had entered a different place; they had
                        not, and saying so was the whole defect. The
                        reader's first bubble is right-aligned, so this
                        gutter is empty by construction. */}
                    <div className="px-3.5 pb-1">
                      <button
                        type="button"
                        onClick={() => {
                          answer.collapse();
                          setMode("search");
                        }}
                        aria-label={t("capsuleAnswer.back")}
                        data-testid="capsule-answer-back"
                        className="
                          inline-flex h-6 w-6 items-center justify-center rounded-md
                          text-ink-mute transition-colors duration-micro
                          hover:bg-bg-2 hover:text-ink
                          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
                        "
                      >
                        <ArrowLeft size={14} strokeWidth={1.75} />
                      </button>
                    </div>
                    <CapsuleAnswerPanel
                      turns={answer.turns}
                      busy={answer.busy}
                      citation={citation}
                      onAsk={askModel}
                      onRetry={answer.retry}
                      onJump={jumpToSource}
                      onOpenInChat={openInChat}
                    />
                  </>
                ) : typing ? (
                  <>
                    {/* Tier 0 — above the rows, before Enter. Local
                        lookup only; nothing here reaches the network. */}
                    <CapsuleTier0Preview
                      answer={tier0}
                      onOpen={() => enterAnswerMode(query.trim())}
                    />

                    {items.length === 0 ? (
                      /* NOT the old Ask row reborn. Prose was typed,
                         nothing in the app is called that, and the
                         answer is the ONLY thing on offer. It carries
                         the reader's own words. When anything matches,
                         this does not render at all. */
                      <button
                        type="button"
                        role="option"
                        aria-selected="true"
                        data-idx={0}
                        data-ask="true"
                        data-testid="capsule-ask-fallback"
                        onClick={() => enterAnswerMode(query.trim())}
                        className="
                          flex h-9 w-full items-center gap-3 px-4 text-left
                          transition-colors duration-micro hover:bg-bg-2/40
                        "
                      >
                        <Sparkles size={14} strokeWidth={1.75} className="shrink-0 text-brand" />
                        <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">
                          {t("capsuleEmpty.enter.askFallback", { query: query.trim() })}
                        </span>
                      </button>
                    ) : (
                      grouped.map((g, gi) => (
                        // The key carries the run index: one group label
                        // can legitimately appear in two runs, and a bare
                        // label key made React reconcile the list wrongly.
                        <div key={`${g.group}-${gi}`}>
                          <div
                            data-testid="capsule-section-label"
                            className={`px-4 pb-2 text-[10px] font-medium uppercase tracking-[0.14em] text-ink-soft ${
                              gi === 0 ? "pt-1" : "pt-5"
                            }`}
                          >
                            {g.group}
                          </div>
                          <ul>
                            {g.entries.map(({ item, idx }) => (
                              <li key={item.id}>{renderRow(item, idx)}</li>
                            ))}
                          </ul>
                        </div>
                      ))
                    )}
                  </>
                ) : (
                  /* THE RESTING STATE — context line, then up to three
                     question chips. Nothing else. */
                  <CapsuleEmptyState
                    onPick={(q) => {
                      setQuery(q);
                      inputRef.current?.focus();
                    }}
                    onFixUnattached={(periodId) => {
                      close();
                      goToPeriod(periodId);
                    }}
                    onUpload={() => go("/dashboard")}
                    pulseKey={pulseKey}
                    indexOffset={0}
                    activeIndex={-1}
                  />
                )}
              </div>
            </div>

            {composer}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
