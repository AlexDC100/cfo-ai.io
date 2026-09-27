// THE COMMAND BAR (⌘K) — the fastest way to do anything in the product,
// and the app's ONE glass panel.
//
// ══ WHAT IT IS (owner spec 2026-09-26, design C2/C3) ═════════════════════
//
//   HEADER   "Caut în {company} · {period}" — the company and period the
//            facts below come from, resolved ONCE (useCmdbarData). A period
//            of another company is never searched under this one's name.
//
//   AT REST  "Ce contează acum": the three most material items for THIS
//            company and period, as the ENGINE ranked them (GET
//            /api/period/{id}/attention), each one line with its served
//            number that opens its evidence; then two or three actions
//            the engine chose from the company's state; recent picks.
//            Never a generic suggestion, never a question that does not
//            fit the company, and a caveat printed ONCE for the panel.
//
//   TYPING   Răspuns · Cont · Pagină · Acțiune · Întreabă CFO AI, in that
//            order, answer first. Every figure is a served figure printed
//            by the printer its own surface uses (cmdbar/cmdbarFigures);
//            ratios come from assembled_metrics.ratio_table only; a Δ is
//            the comparatives column's own change_kind (no % across zero
//            or a sign); the net result says "din contul 121" only when
//            the served anchor says it is; an absent figure says why.
//
// ══ THE SPEND RULE ═══════════════════════════════════════════════════════
//
// The bar spends ZERO model calls. Every group but the last is read from
// payloads already in the query cache — a keystroke fetches nothing
// (commandBar.test.tsx counts requests). "Întreabă CFO AI" is always the
// last row; Tab jumps to it and Enter SENDS the query to the grounded chat
// (openAskCfoAi(q, {send: true})): the chat surface spends, through its
// own pipeline and chat-llm's reservation, not this file.
//
// ══ THE GLASS ════════════════════════════════════════════════════════════
//
// Unchanged from the Capsule: it morphs out of the header pill
// (capsuleMorph), sits on a constant bottom edge (capsuleGeometry), and its
// height is its content's (capsuleHeight). 0.92 fill + a 24px backdrop blur
// over a 40% scrim — every text node was measured to clear AA through that
// composite in both themes, which is why the text sits on `ink-soft`.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import * as DialogPrimitive from "@radix-ui/react-dialog";

import "./shellI18n";
import "@/lib/capsuleRouterI18n";
import { useShellNav } from "@/components/cfo/Sidebar";
import { useActiveLocale } from "@/lib/locale";
import { TAB_SPECS } from "@/lib/financialStatementTabs";
import { CAPSULE_ROUTES } from "@/lib/capsuleRouter";
import { companySwitchHref, periodDashboardHref } from "@/lib/dashboardHref";
import { useFeatureStatus } from "@/lib/features";
import { useWorkspaces } from "@/lib/workspaces";
import { useUploadRoute, useWorkspaceV2 } from "@/lib/previewFeatures";
import { blockedByScan } from "@/lib/scanGuard";
import { storeComparisonPrior } from "@/stores/comparativesView";
import { openAskCfoAi } from "@/components/cfo/chat/openAskCfoAi";
import { getChatShellRef } from "@/components/cfo/chat/sharedShellRef";
import i18n from "@/i18n";
import {
  LAT_CAPSULE_OPEN,
  LAT_CMDBAR_INDEX,
  LAT_CMDBAR_SEARCH,
  mark,
  measure,
} from "@/lib/capsuleLatency";

import { useCapsuleMorph } from "./capsuleMorph";
import { useCapsuleHeight } from "./capsuleHeight";
import { CapsuleComposer } from "./CapsuleComposer";
import { CapsuleTooltipGuard } from "./CapsuleTooltipGuard";
import { capsuleFrame, CAPSULE_BORDER } from "./capsuleGeometry";
import "./cmdbar/cmdbarI18n";
import { CmdbarList } from "./cmdbar/CmdbarList";
import { langOf, servedMoney, type Printer } from "./cmdbar/cmdbarFigures";
import {
  buildCmdbarIndex,
  searchCmdbar,
  type ActionDef,
  type PageDef,
} from "./cmdbar/cmdbarIndex";
import { readRecents, rememberRecent, type CmdbarRecent } from "./cmdbar/cmdbarRecents";
import { rowDomId, type BarRow } from "./cmdbar/cmdbarRows";
import {
  accountMoreView,
  accountView,
  nowActionView,
  nowItemView,
  ratioView,
  statementView,
  type NowActionView,
  type ViewContext,
} from "./cmdbar/cmdbarViews";
import { scopeMonth, useCmdbarData } from "./cmdbar/useCmdbarData";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Ask CFO AI — same handler as the sidebar accent row. */
  onOpenAi: () => void;
}

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

/** Words in BOTH languages for a translation key — a Romanian reader may
 *  type the English name and the other way round. */
function bothLanguages(key: string, vars?: Record<string, unknown>): string[] {
  return [i18n.getFixedT("en")(key, vars), i18n.getFixedT("ro")(key, vars)];
}

const MAX_RESTING_RECENTS = 3;

export function CommandPalette({ open, onOpenChange, onOpenAi }: Props) {
  const { t, i18n: inst } = useTranslation();
  const lang = langOf(inst.language);
  const locale = useActiveLocale();
  const navigate = useNavigate();
  const routeLocation = useLocation();
  const navGroups = useShellNav();
  const { select: selectWorkspace } = useWorkspaces();
  const forecastStatus = useFeatureStatus("forecast");
  const reportsStatus = useFeatureStatus("comprehensive_report");
  const benchmarksStatus = useFeatureStatus("benchmarks");
  const uploadTo = useUploadRoute("/dashboard");
  const workspaceV2 = useWorkspaceV2();
  const featureStatusOf = useCallback(
    (key: string) => (key === "forecast" ? forecastStatus : undefined),
    [forecastStatus],
  );

  const data = useCmdbarData({ open });
  const { scope } = data;
  const month = scopeMonth(scope, locale);
  const currency =
    ((data.body?.statements as { currency?: string } | undefined)?.currency)
    ?? data.body?.period?.currency ?? "RON";
  // ONE currency in the panel: the one the engine served the period in,
  // printed with its code. The header's display toggle is not applied here
  // (a browser conversion is not a served figure, and "din contul 121" on a
  // converted number would be false).
  const printer = useMemo<Printer>(
    () => ({ lang, money: servedMoney(currency, { compact: true }) }),
    [lang, currency],
  );
  const servedRules = data.attention.state === "ok"
    ? (data.attention.data as unknown as { rules?: { sector_position_only?: string[] } }).rules
    : undefined;
  const positionOnly = servedRules?.sector_position_only;
  const ctx = useMemo<ViewContext>(
    () => ({
      printer,
      positionOnly,
      body: data.body,
      comparatives: data.comparatives,
      sector: data.sector,
      periodId: scope.status === "ready" ? scope.periodId : null,
      orgId: scope.status === "ready" ? scope.orgId : null,
    }),
    [printer, positionOnly, data.body, data.comparatives, data.sector, scope.status, scope.periodId, scope.orgId],
  );

  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(-1);
  // Recent picks are one company's: held WITH the company they were read
  // for, and shown only under that company's header (a switch while the bar
  // is open must not leave the company left behind's picks — their links
  // name its periods — under the new one's name).
  const [recentsOf, setRecentsOf] = useState<{ orgId: string | null; list: CmdbarRecent[] }>({ orgId: null, list: [] });
  const recents = useMemo(
    () => (recentsOf.orgId !== null && recentsOf.orgId === scope.orgId ? recentsOf.list : []),
    [recentsOf, scope.orgId],
  );
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  /** Set by type-to-open so the character that opened the bar is kept. */
  const pendingChar = useRef<string | null>(null);

  // ── the header line ────────────────────────────────────────────────
  const company = scope.companyName ?? "";
  const header =
    scope.status === "no_company" ? t("cmdbar.header.noCompany")
    // A switch to a company not in the list yet: no name to print.
    : scope.status === "loading" && !company ? t("cmdbar.header.loading")
    : scope.status === "no_period" ? t("cmdbar.header.noPeriod", { company })
    : scope.status === "other_company" ? t("cmdbar.header.otherCompany", { company })
    : t("cmdbar.header.searching", { company, period: month ?? t("cmdbar.header.loading") });

  // ── what can be opened: pages and actions (host-defined, gated) ────
  const withPeriod = useCallback(
    (to: string) => {
      if (!ctx.periodId) return to;
      const sep = to.includes("?") ? "&" : "?";
      return `${to}${sep}period=${encodeURIComponent(ctx.periodId)}`;
    },
    [ctx.periodId],
  );

  const pages = useMemo<PageDef[]>(() => {
    const out: PageDef[] = [];
    const seen = new Set<string>();
    const push = (p: PageDef) => { if (!seen.has(p.href)) { seen.add(p.href); out.push(p); } };
    // The router's words for a destination — matched on the WHOLE target,
    // so "/dashboard?tab=pl" lends "p&l" to the P&L tab and not to the
    // dashboard's home.
    const routeTokens = (to: string) =>
      CAPSULE_ROUTES.filter((r) => r.to === to).flatMap((r) => r.tokens);
    // The dashboard's statement tabs — the REAL tab ids.
    for (const tab of TAB_SPECS) {
      const href = ctx.periodId && ctx.orgId
        ? `${periodDashboardHref(ctx.orgId, ctx.periodId)}&tab=${tab.id}`
        : `/dashboard?tab=${tab.id}`;
      push({ id: `tab:${tab.id}`, label: t(tab.label), href,
             terms: [...bothLanguages(tab.label), ...routeTokens(`/dashboard?tab=${tab.id}`)] });
    }
    // The rail's own destinations — feature-gated by the registry, so a
    // hidden or coming-soon surface is never offered. The router's tokens
    // for the same target ride along as words that find it.
    for (const g of navGroups) {
      for (const item of g.items) {
        // A coming-soon row renders muted in the rail; here it would be an
        // advertisement for a screen that says "not yet" — not offered.
        if ((item as { pending?: boolean }).pending) continue;
        push({
          id: `rail:${item.to}`, label: t(item.labelKey), href: withPeriod(item.to),
          terms: [...bothLanguages(item.labelKey), ...routeTokens(item.to)],
        });
      }
    }
    if (benchmarksStatus === "active") {
      push({ id: "benchmark", label: t("cmdbar.page.benchmark"), href: withPeriod("/benchmark"), terms: [...bothLanguages("cmdbar.page.benchmark"), ...routeTokens("/benchmark")] });
    }
    if (reportsStatus === "active") {
      push({ id: "report", label: t("cmdbar.page.report"), href: withPeriod("/report"), terms: [...bothLanguages("cmdbar.page.report"), ...routeTokens("/report")] });
    }
    if (forecastStatus === "active") {
      push({ id: "forecast", label: t("cmdbar.page.forecast"), href: withPeriod("/dashboard/forecast"), terms: bothLanguages("cmdbar.page.forecast") });
    }
    push({ id: "settings", label: t("cmdbar.page.settings"), href: "/settings", terms: [...bothLanguages("cmdbar.page.settings"), ...routeTokens("/settings")] });
    // Any company × year, from each company's own years (read on open).
    for (const c of data.companies) {
      for (const y of data.years[c.id] ?? []) {
        push({
          id: `year:${c.id}:${y.period_id}`,
          label: t("cmdbar.page.companyYear", { company: c.name, year: y.year }),
          href: periodDashboardHref(c.id, y.period_id),
          terms: [c.name, String(y.year)],
        });
      }
    }
    return out;
  }, [t, ctx.periodId, ctx.orgId, withPeriod, navGroups, benchmarksStatus, reportsStatus, forecastStatus, data.companies, data.years]);

  const attentionDoc = data.attention.state === "ok" ? data.attention.data : null;

  const actions = useMemo<ActionDef[]>(() => {
    const out: ActionDef[] = [];
    out.push({ id: "upload", label: t("cmdbar.action.upload"), terms: [...bothLanguages("cmdbar.action.upload"), "upload", "incarca", "balanta"] });
    if (scope.orgId && company) {
      out.push({ id: "add-period", label: t("cmdbar.action.addPeriod", { company }), terms: [...bothLanguages("cmdbar.action.addPeriod", { company }), "perioada", "period", "an", "year"] });
    }
    const compare = attentionDoc?.actions.find((a) => a.target.kind === "compare");
    if (compare) {
      out.push({ id: "compare", label: compare.label[lang], terms: [compare.label.ro, compare.label.en, "compara", "compare", "an anterior", "last year"] });
    }
    if (ctx.periodId) {
      out.push({ id: "export-pdf", label: t("cmdbar.action.exportPdf"), terms: [...bothLanguages("cmdbar.action.exportPdf"), "export", "exporta", "pdf", "raport", "banca", "bank"] });
    }
    const bank = attentionDoc?.actions.find((a) => a.target.kind === "forecast_bank_export");
    if (bank && forecastStatus === "active") {
      out.push({ id: "bank-export", label: bank.label[lang], terms: [bank.label.ro, bank.label.en, "banca", "bank"] });
    }
    for (const c of data.companies) {
      if (c.id === scope.orgId) continue;
      out.push({ id: `switch:${c.id}`, label: t("cmdbar.action.switchCompany", { company: c.name }), terms: [c.name, "schimba", "switch", "firma", "company"] });
    }
    return out;
  }, [t, lang, scope.orgId, company, attentionDoc, ctx.periodId, forecastStatus, data.companies]);

  // ── the index: rebuilt when a cached document lands, never per key ──
  const index = useMemo(() => {
    mark(LAT_CMDBAR_INDEX);
    const built = buildCmdbarIndex({ body: data.body, pages, actions });
    measure(LAT_CMDBAR_INDEX, LAT_CMDBAR_INDEX);
    return built;
  }, [data.body, pages, actions]);

  const typing = query.trim().length > 0;

  // ── the rows ───────────────────────────────────────────────────────
  const rows = useMemo<BarRow[]>(() => {
    if (typing) {
      mark(LAT_CMDBAR_SEARCH);
      const results = searchCmdbar(index, query);
      const out: BarRow[] = [];
      for (const g of results.groups) {
        for (const hit of g.hits) {
          const ref = hit.entry.ref;
          if (ref.kind === "statement") out.push({ kind: "answer", id: hit.entry.id, view: statementView(ctx, ref.answer) });
          else if (ref.kind === "ratio") out.push({ kind: "answer", id: hit.entry.id, view: ratioView(ctx, ref.key) });
          else if (ref.kind === "account") out.push({ kind: "account", id: hit.entry.id, view: accountView(ctx, ref.item) });
          else if (ref.kind === "page") out.push({ kind: "page", id: hit.entry.id, label: ref.label, href: ref.href });
          else out.push({ kind: "action", id: hit.entry.id, label: ref.label });
        }
        if (g.group === "account") {
          // The accounts past the cap are counted and opened, never hidden.
          const items = (hits: typeof g.hits) =>
            hits.flatMap((h) => (h.entry.ref.kind === "account" ? [h.entry.ref.item] : []));
          const more = accountMoreView(ctx, results.query, items(g.hits), items(g.rest));
          if (more) out.push({ kind: "account-more", id: more.id, view: more });
        }
      }
      if (results.ask) out.push({ kind: "ask", id: "ask", query: results.ask.query });
      measure(LAT_CMDBAR_SEARCH, LAT_CMDBAR_SEARCH);
      return out;
    }
    const out: BarRow[] = [];
    if (attentionDoc) {
      for (const item of attentionDoc.items) {
        out.push({ kind: "now", id: `now:${item.key}`, view: nowItemView(ctx, item, attentionDoc) });
      }
      for (const a of attentionDoc.actions) {
        if (a.requires_feature && featureStatusOf(a.requires_feature) !== "active") {
          // The engine read the global registry; THIS reader's registry
          // says the feature is not on — offer the engine's own fallback,
          // the CFO report PDF (packs/serving/attention.yaml actions).
          if (a.target.kind === "forecast_bank_export") {
            out.push({
              kind: "now-action", id: "now-action:cfo_report_pdf",
              view: {
                key: "cfo_report_pdf", label: t("cmdbar.action.exportPdf"), requiresFeature: null,
                target: { kind: "report_pdf", route: "/dashboard", tab: "export", period_id: ctx.periodId },
              },
            });
          }
          continue;
        }
        out.push({ kind: "now-action", id: `now-action:${a.key}`, view: nowActionView(ctx, a) });
      }
    }
    for (const r of recents.slice(0, MAX_RESTING_RECENTS)) {
      out.push({ kind: "recent", id: `recent:${r.id}`, recent: r });
    }
    return out;
  }, [typing, index, query, ctx, attentionDoc, recents, featureStatusOf, t]);

  // ONE status line when the rest state has nothing to list — loading,
  // no period, nothing material — never an empty panel.
  const status = useMemo<string | null>(() => {
    if (typing) return null;
    if (scope.status === "no_company" || scope.status === "no_period" || scope.status === "other_company") {
      return t("cmdbar.now.noPeriod");
    }
    if (scope.status === "loading") return t("cmdbar.now.loading");
    if (scope.status === "unreadable") return t("cmdbar.now.unavailable");
    if (data.attention.state === "pending") return t("cmdbar.now.loading");
    if (data.attention.state === "none") return t("cmdbar.now.unavailable");
    if (attentionDoc && attentionDoc.items.length === 0) return t("cmdbar.now.none");
    return null;
  }, [typing, scope.status, data.attention.state, attentionDoc, t]);

  // THE CAVEAT, ONCE: the served caveats joined into one line for the
  // panel, referenced by the listbox's aria-describedby — never per item.
  const caveat = useMemo<string | null>(() => {
    if (typing || !attentionDoc || attentionDoc.items.length === 0) return null;
    const texts = attentionDoc.caveats.map((c) => c.text[lang]).filter(Boolean);
    return texts.length ? texts.join(" ") : null;
  }, [typing, attentionDoc, lang]);

  // ── open / close ───────────────────────────────────────────────────
  useEffect(() => {
    if (open) {
      mark(LAT_CAPSULE_OPEN);
      if (pendingChar.current) {
        setQuery(pendingChar.current);
        pendingChar.current = null;
      } else {
        setQuery("");
      }
      setActiveIdx(-1);
    }
    // Reacts to the OPEN transition only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // The recents of the company being searched — re-read when it changes.
  useEffect(() => {
    if (open) setRecentsOf({ orgId: scope.orgId, list: readRecents(scope.orgId) });
  }, [open, scope.orgId]);

  // Typing selects the answer (the first row); rest selects nothing — in
  // the SAME render that shows the new query (state derived during render),
  // never in an effect after it: the first frame of "stoc", typed after ↓
  // had walked "profit" to its end, was committed with the previous walk's
  // index, past the new list — no row selected until the effect ran (live
  // G8 caught that frame once in the stage CB-J run).
  const selectionKey = `${typing ? "typing" : "rest"}:${query}`;
  const [selectionFor, setSelectionFor] = useState(selectionKey);
  if (selectionFor !== selectionKey) {
    setSelectionFor(selectionKey);
    setActiveIdx(typing ? 0 : -1);
  }

  // Clamp a selection the list has shrunk under. A FUNCTIONAL update: this
  // effect runs in the same commit as the one above, and a clamp computed
  // from this render's (stale) activeIdx would overwrite the fresh 0 — a
  // new, shorter query then landed on "Întreabă CFO AI" instead of its
  // answer (commandBar.test.tsx, cmdbar-keyboard).
  useEffect(() => {
    setActiveIdx((i) => (i >= rows.length ? rows.length - 1 : i));
  }, [rows.length, activeIdx]);

  useEffect(() => {
    if (activeIdx < 0) return;
    const list = listRef.current;
    const el = list?.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    if (!list || !el) return;
    el.scrollIntoView?.({ block: "nearest" });
    // "Întreabă CFO AI" sticks to the bottom of the list, so "nearest" can
    // park the selected row UNDER it (the live keyboard gate saw the P&L
    // page row selected and hidden). Lift the row clear of the sticky row.
    if (el.getAttribute("data-row-kind") === "ask") return;
    const sticky = list.querySelector<HTMLElement>('[data-row-kind="ask"]')?.parentElement;
    if (!sticky) return;
    const covered = el.getBoundingClientRect().bottom - sticky.getBoundingClientRect().top;
    if (covered > 0) list.scrollTop += covered;
  }, [activeIdx]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  }, [query, open]);

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  const go = useCallback(
    (to: string) => {
      close();
      navigate(to);
    },
    [close, navigate],
  );

  /** Open ANOTHER company — the "Switch to <company>" action, and a
   *  company × year row (or recent pick) of another company.
   *
   *  NEVER A SWITCH IN PLACE (review round 2 of stage CB-I). A screen that pins a
   *  company — `?org=`, one of its periods, /workspace/<id> — holds for it
   *  and switches the active company back to it (lib/companyOnScreen). The
   *  action used to call `select()` under the URL on display: on Scandia's
   *  dashboard it put "Agras SRL" in the header over a blank held page (on
   *  Scandia's company page, over Scandia's page), and when the hold's ask
   *  window ran out (HOLD_ASK_WINDOW_MS, 10 s) it switched back to Scandia.
   *  So the bar opens the company's OWN screen (`href`):
   *
   *    redesign on   `href` pins the company, and that screen's hold makes
   *                  the switch — ONE authority. A switch here as well would
   *                  be a second: another cache wipe and remote write, the
   *                  shape of the 2026-09-26 auth-lock flood.
   *    redesign off  no screen holds for a company, so the bar switches, in
   *                  the SAME tick as the navigation — switchOrg writes the
   *                  holder and the header's name synchronously, so the first
   *                  render of `href` already asks as the company it opens.
   *
   *  Nothing re-scopes while an analysis runs: the guard `select()` applies,
   *  checked BEFORE anything moves (a navigation to another company's
   *  screen is a switch too — its hold would make it). */
  const openCompany = useCallback(
    (orgId: string, href: string) => {
      if (blockedByScan("workspace")) {
        close();
        return;
      }
      go(href);
      if (!workspaceV2) void selectWorkspace(orgId);
    },
    [close, go, workspaceV2, selectWorkspace],
  );

  /** The company a company × year row opens (`page:year:<org>:<period>`),
   *  when it is not the company the bar is searching. */
  const otherCompanyOf = useCallback(
    (rowId: string): string | null => {
      const m = /^page:year:([^:]+):/.exec(rowId);
      return m && m[1] !== scope.orgId ? m[1] : null;
    },
    [scope.orgId],
  );

  const remember = useCallback(
    (r: CmdbarRecent) => setRecentsOf({ orgId: scope.orgId, list: rememberRecent(scope.orgId, r) }),
    [scope.orgId],
  );

  /** "Întreabă CFO AI": the question goes to the grounded chat, SENT. The
   *  chat spends through its own pipeline; the bar makes no model call. */
  const askChat = useCallback(
    (q: string) => {
      const question = q.trim();
      close();
      if (!question) {
        onOpenAi();
        return;
      }
      if (routeLocation.pathname.startsWith("/chat")) {
        const handle = getChatShellRef();
        if (handle) {
          handle.ask(question);
          return;
        }
      }
      openAskCfoAi(question, { send: true });
    },
    [close, onOpenAi, routeLocation.pathname],
  );

  const runAttentionAction = useCallback(
    (a: NowActionView) => {
      const target = a.target;
      switch (target.kind) {
        case "compare":
          if (ctx.orgId && target.prior_period_id) storeComparisonPrior(ctx.orgId, target.prior_period_id);
          go(ctx.orgId && ctx.periodId ? `${periodDashboardHref(ctx.orgId, ctx.periodId)}&tab=pl` : "/dashboard");
          return;
        case "upload":
          go(uploadTo);
          return;
        case "forecast_bank_export":
          go(withPeriod(target.route));
          return;
        case "report_pdf":
          go(ctx.orgId && ctx.periodId ? `${periodDashboardHref(ctx.orgId, ctx.periodId)}&tab=${target.tab}` : `/dashboard?tab=${target.tab}`);
          return;
        case "route":
          go(withPeriod(target.route));
          return;
        default:
          return;
      }
    },
    [ctx.orgId, ctx.periodId, go, uploadTo, withPeriod],
  );

  const runAction = useCallback(
    (id: string) => {
      if (id === "upload" || id === "add-period") return go(uploadTo);
      if (id === "export-pdf") {
        return go(ctx.orgId && ctx.periodId ? `${periodDashboardHref(ctx.orgId, ctx.periodId)}&tab=export` : "/dashboard?tab=export");
      }
      const fromDoc = (kind: string) => attentionDoc?.actions.find((a) => a.target.kind === kind);
      if (id === "compare") { const a = fromDoc("compare"); if (a) runAttentionAction(nowActionView(ctx, a)); return; }
      if (id === "bank-export") { const a = fromDoc("forecast_bank_export"); if (a) runAttentionAction(nowActionView(ctx, a)); return; }
      if (id.startsWith("switch:")) {
        const orgId = id.slice("switch:".length);
        openCompany(orgId, companySwitchHref(orgId, data.years[orgId], workspaceV2));
      }
    },
    [go, uploadTo, ctx, attentionDoc, runAttentionAction, openCompany, data.years, workspaceV2],
  );

  const runRow = useCallback(
    (idx: number) => {
      const row = rows[idx];
      if (!row) return;
      switch (row.kind) {
        case "now": return go(row.view.href);
        case "now-action": return runAttentionAction(row.view);
        case "recent":
          if (row.recent.group === "ask" && row.recent.query) return askChat(row.recent.query);
          if (row.recent.group === "action") return runAction(row.recent.id.replace(/^action:/, ""));
          if (row.recent.href) {
            const other = otherCompanyOf(row.recent.id);
            return other ? openCompany(other, row.recent.href) : go(row.recent.href);
          }
          return;
        case "answer":
          remember({ id: row.id, group: "answer", label: row.view.label, href: row.view.href });
          return go(row.view.href);
        case "account":
          remember({ id: row.id, group: "account", label: `${row.view.code} ${row.view.name}`.trim(), href: row.view.href });
          return go(row.view.href);
        case "account-more":
          remember({ id: row.id, group: "account", label: row.view.text, href: row.view.href });
          return go(row.view.href);
        case "page": {
          remember({ id: row.id, group: "page", label: row.label, href: row.href });
          const other = otherCompanyOf(row.id);
          return other ? openCompany(other, row.href) : go(row.href);
        }
        case "action":
          remember({ id: row.id, group: "action", label: row.label });
          return runAction(row.id.replace(/^action:/, ""));
        case "ask":
          remember({ id: `ask:${row.query}`, group: "ask", label: row.query, query: row.query });
          return askChat(row.query);
      }
    },
    [rows, go, runAttentionAction, askChat, runAction, remember, otherCompanyOf, openCompany],
  );

  // ── type-to-open ───────────────────────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
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
  }, [open, onOpenChange]);

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, typing ? 0 : -1));
    } else if (e.key === "Tab" && !e.shiftKey) {
      // Tab jumps to "Întreabă CFO AI" — always the last row.
      e.preventDefault();
      const askIdx = rows.findIndex((r) => r.kind === "ask");
      if (askIdx >= 0) setActiveIdx(askIdx);
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (typing) askChat(query);
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (activeIdx >= 0) runRow(activeIdx);
    }
  }

  // ── the card's frame (unchanged geometry) ──────────────────────────
  const morph = useCapsuleMorph(open, true);
  const [viewport, setViewport] = useState<{ w: number; h: number }>(() => ({
    w: typeof window === "undefined" ? 1440 : window.innerWidth,
    h: typeof window === "undefined" ? 900 : window.innerHeight,
  }));
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const frame = capsuleFrame(viewport.w, viewport.h);
  const card = useCapsuleHeight({ min: 0, max: frame.maxHeight - CAPSULE_BORDER, enabled: open });
  const cardHeight = card.height ?? undefined;
  const [composerFocused, setComposerFocused] = useState(false);

  const activeRow = activeIdx >= 0 ? rows[activeIdx] : undefined;
  const jumps = !!activeRow && activeRow.kind !== "ask";
  const jumpTarget =
    !activeRow ? undefined
    : activeRow.kind === "answer" ? activeRow.view.label
    : activeRow.kind === "account" ? activeRow.view.code
    : activeRow.kind === "account-more" ? activeRow.view.text
    : activeRow.kind === "page" || activeRow.kind === "action" ? activeRow.label
    : activeRow.kind === "now" ? activeRow.view.subject
    : activeRow.kind === "now-action" ? activeRow.view.label
    : activeRow.kind === "recent" ? activeRow.recent.label
    : undefined;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="
            fixed inset-0 z-50 bg-black/40
            data-[state=open]:animate-in data-[state=open]:fade-in-0
            data-[state=closed]:animate-out data-[state=closed]:fade-out-0
          "
        />
        <DialogPrimitive.Content
          ref={morph.ref as unknown as React.Ref<HTMLDivElement>}
          style={{ ...morph.style, top: "auto", bottom: frame.bottomOffset }}
          data-capsule-bottom={String(frame.bottom)}
          data-testid="command-palette"
          data-mode="search"
          data-typing={typing ? "true" : undefined}
          data-morphing={morph.morphing ? "true" : undefined}
          aria-describedby={undefined}
          onCloseAutoFocus={(e) => {
            // Focus returns to the header pill that opened the bar (WCAG 2.4.3).
            const bar = document.querySelector<HTMLElement>('[data-testid="header-command-bar"]');
            if (!bar) return;
            e.preventDefault();
            bar.focus();
          }}
          className="
            fixed z-50 flex flex-col overflow-hidden
            inset-x-2 w-auto max-w-[calc(100vw-1rem)]
            sm:inset-x-0 sm:mx-auto sm:w-full sm:max-w-[680px]
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
          <CapsuleTooltipGuard />
          <DialogPrimitive.Title className="sr-only">{header}</DialogPrimitive.Title>
          <div
            data-testid="capsule-stack"
            data-measured={card.height !== null ? String(card.height) : undefined}
            data-rest-budget={frame.narrow ? undefined : String(frame.restBudget)}
            style={{ height: cardHeight }}
            className="
              flex min-h-0 flex-col overflow-hidden
              transition-[height] duration-[160ms] ease-quint
              motion-reduce:transition-none
              max-h-[70vh]
            "
          >
            <div
              ref={listRef}
              id="command-palette-list"
              className="chat-scroll flex min-h-0 flex-1 flex-col overflow-y-auto"
            >
              <div ref={card.threadRef} className={`pb-3 pt-3 ${typing ? "" : "mt-auto"}`}>
                <CmdbarList
                  header={header}
                  rows={rows}
                  activeIdx={activeIdx}
                  onActivate={setActiveIdx}
                  onRun={runRow}
                  caveat={caveat}
                  status={status}
                  mode={typing ? "typing" : "rest"}
                />
              </div>
            </div>
            <CapsuleComposer
              ref={inputRef}
              blockRef={card.composerRef}
              value={query}
              onChange={(next) => setQuery(next)}
              onKeyDown={onKeyDown}
              onSubmit={() => { if (activeIdx >= 0) runRow(activeIdx); else if (typing) askChat(query); }}
              placeholder={t("cmdbar.placeholder")}
              jumps={jumps}
              jumpTarget={jumpTarget}
              testId="capsule-composer"
              ariaLabel={t("cmdbar.placeholder")}
              activeDescendant={activeIdx >= 0 ? rowDomId(activeIdx) : undefined}
              focused={composerFocused}
              onFocusChange={setComposerFocused}
              above={
                <div className="hidden justify-end px-3.5 pt-1.5 text-[10px] text-ink-soft sm:flex">
                  <span data-testid="capsule-keys" className="truncate">{t("cmdbar.keys")}</span>
                </div>
              }
            />
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
