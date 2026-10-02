// AutoMasters — Management: dealer performance, profit centres, Ask CFO AI.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, MessageSquare, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CFOMessageBubble } from "@/components/cfo/chat/CFOMessageBubble";
import type { ChatMessage } from "@/components/cfo/chat/types";
import { cfoApi } from "@/lib/cfoApi";
import { classifyAiFailure, classifyUpstreamAnswer } from "@/lib/aiDegraded";
import { useActiveLocale } from "@/lib/locale";
import { cn } from "@/lib/utils";
import {
  SEGMENTS,
  aiSnapshot,
  alertsFor,
  centreTotals,
  formatMoney,
  funnelFor,
  monthlyRevenue,
  sortCentres,
  type AmData,
  type CentreSort,
  type Segment,
} from "@/lib/automasters/model";
import { Amount, Card, Dot, Empty, Pct, StatusPill } from "./ui";

const SEG_COLOR: Record<Segment, string> = {
  new_cars: "bg-ink",
  service: "bg-info",
  parts: "bg-caution",
  other: "bg-ink-mute",
};

function monthLabel(period: string, locale: string, style: "short" | "long" = "short"): string {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(locale, {
    month: style, ...(style === "long" ? { year: "numeric" } : {}), timeZone: "UTC",
  });
}

// ── Performance ─────────────────────────────────────────────────────────

export function PerformanceView({ data, period, onImport }: { data: AmData; period: string; onImport: () => void }) {
  const { t } = useTranslation();
  const locale = useActiveLocale();
  const year = Number(period.slice(0, 4));
  const months = useMemo(() => monthlyRevenue(data.centres, year), [data.centres, year]);
  const totals = useMemo(() => centreTotals(data.centres, year, period), [data.centres, year, period]);
  const funnel = useMemo(() => funnelFor(data.funnel, period), [data.funnel, period]);
  const [seg, setSeg] = useState<Segment | "all">("all");
  const [sel, setSel] = useState<string>(period);

  if (!months.length) {
    return (
      <Card>
        <Empty title={t("am.empty.performance")} body={t("am.empty.importHint")}
          action={<Button variant="secondary" onClick={onImport}>{t("am.import.open")}</Button>} />
      </Card>
    );
  }

  const shown = (s: Segment) => seg === "all" || seg === s;
  const value = (m: (typeof months)[number]) => SEGMENTS.reduce((a, s) => a + (shown(s) ? m.parts[s] : 0), 0);
  const top = Math.max(...months.map(value), 1);
  const selected = months.find((m) => m.period === sel) ?? months[months.length - 1];
  const revenue = totals.reduce((a, r) => a + r.revenue, 0);
  const margin = totals.reduce((a, r) => a + r.margin, 0);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <Kpi label={t("am.perf.revenueYtd", { year })} value={<Amount value={revenue} />} />
        <Kpi label={t("am.perf.marginYtd", { year })} value={<Amount value={margin} />} />
        <Kpi label={t("am.perf.marginPct")} value={<Pct value={revenue ? (margin / revenue) * 100 : null} />} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card
          title={t("am.perf.revenueByMonth", { year })}
          actions={
            <div role="group" aria-label={t("am.perf.segment")} className="flex flex-wrap gap-1">
              {(["all", ...SEGMENTS] as const).map((s) => (
                <button key={s} type="button" aria-pressed={seg === s} onClick={() => setSeg(s)}
                  className={cn(
                    "inline-flex h-7 items-center gap-1.5 rounded-sm border px-2.5 text-[11.5px] font-medium",
                    seg === s ? "border-ink bg-ink text-bg" : "border-rule bg-surface text-ink-soft hover:text-ink",
                  )}>
                  {s !== "all" && <span aria-hidden className={cn("h-2 w-2 rounded-full", SEG_COLOR[s])} />}
                  {t(`am.seg.${s}`)}
                </button>
              ))}
            </div>
          }
        >
          <div className="flex h-[240px] items-end gap-2" role="list">
            {months.map((m) => (
              <button key={m.period} type="button" role="listitem"
                onClick={() => setSel(m.period)}
                aria-pressed={m.period === selected.period}
                aria-label={`${monthLabel(m.period, locale, "long")}: ${formatMoney(value(m), "EUR", locale)}`}
                className="group flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1.5">
                <div className={cn(
                  "flex w-full max-w-[44px] flex-col-reverse overflow-hidden rounded-[2px]",
                  m.period === selected.period ? "ring-1 ring-ink ring-offset-2 ring-offset-surface" : "opacity-85 group-hover:opacity-100",
                )} style={{ height: `${Math.max(2, (value(m) / top) * 200)}px` }}>
                  {SEGMENTS.filter(shown).map((s) => (
                    <span key={s} className={SEG_COLOR[s]}
                      style={{ height: `${value(m) ? (m.parts[s] / value(m)) * 100 : 0}%` }} />
                  ))}
                </div>
                <span className={cn("text-[11px]", m.period === selected.period ? "font-semibold text-ink" : "text-ink-soft")}>
                  {monthLabel(m.period, locale)}
                </span>
              </button>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-rule pt-3 text-[12.5px]">
            <span className="font-semibold text-ink">{monthLabel(selected.period, locale, "long")}</span>
            {SEGMENTS.filter(shown).map((s) => (
              <span key={s} className="inline-flex items-center gap-1.5 text-ink-soft">
                <span aria-hidden className={cn("h-2 w-2 rounded-full", SEG_COLOR[s])} />
                {t(`am.seg.${s}`)} <Amount value={selected.parts[s]} className="text-ink" />
              </span>
            ))}
          </div>
        </Card>

        <Card title={t("am.perf.funnel", { month: monthLabel(period, locale, "long") })}>
          {funnel.length ? (
            <ol className="space-y-3">
              {funnel.map((f) => (
                <li key={f.stage}>
                  <div className="flex items-baseline justify-between gap-3 text-[13px]">
                    <span className="truncate text-ink">{f.stage}</span>
                    <span className="flex items-baseline gap-2">
                      {f.conversion !== null && (
                        <span className="text-[11.5px] text-ink-soft">{t("am.perf.conversion", { pct: f.conversion })}</span>
                      )}
                      <span className="font-mono tabular-nums font-semibold">{f.count}</span>
                    </span>
                  </div>
                  <div className="mt-1 h-2 rounded-full bg-bg-2">
                    <div className="h-full rounded-full bg-ink" style={{ width: `${f.width}%` }} />
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-[13px] text-ink-soft">{t("am.empty.funnel")}</p>
          )}
        </Card>
      </div>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-md border border-rule bg-surface px-4 py-3">
      <div className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-soft">{label}</div>
      <div className="mt-1.5 text-[22px] font-semibold text-ink">{value}</div>
    </div>
  );
}

// ── Profit centres ──────────────────────────────────────────────────────

export function ProfitCentresView({ data, period, onImport, onAsk }: {
  data: AmData;
  period: string;
  onImport: () => void;
  onAsk: (question: string) => void;
}) {
  const { t } = useTranslation();
  const locale = useActiveLocale();
  const year = Number(period.slice(0, 4));
  const [sort, setSort] = useState<CentreSort>("margin");
  const rows = useMemo(
    () => sortCentres(centreTotals(data.centres, year, period), sort),
    [data.centres, year, period, sort],
  );
  const [selKey, setSelKey] = useState<string | null>(null);

  if (!rows.length) {
    return (
      <Card>
        <Empty title={t("am.empty.centres")} body={t("am.empty.importHint")}
          action={<Button variant="secondary" onClick={onImport}>{t("am.import.open")}</Button>} />
      </Card>
    );
  }

  const sel = rows.find((r) => r.centre === selKey) ?? rows[0];
  const totalRevenue = rows.reduce((a, r) => a + r.revenue, 0);
  const totalMargin = rows.reduce((a, r) => a + r.margin, 0);
  const heads: Array<[CentreSort, string]> = [
    ["revenue", t("am.centres.revenue")],
    ["margin", t("am.centres.margin")],
    ["marginPct", t("am.centres.marginPct")],
    ["vsBudget", t("am.centres.vsBudget")],
  ];
  // Fixed tracks: every row is its own grid, so `auto` columns would size
  // differently per row and the header would not line up.
  const grid = "grid grid-cols-[minmax(120px,1fr)_170px_160px_84px_96px_120px] items-center gap-3";

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <Card title={t("am.centres.title", { through: monthLabel(period, locale, "long") })} bodyClassName="p-0">
        <div className="overflow-x-auto">
          <div className="min-w-[820px]">
            <div className={cn(grid, "h-11 border-b border-rule bg-bg-2 px-4 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-soft")}>
              <span>{t("am.centres.centre")}</span>
              {heads.map(([k, label]) => (
                <button key={k} type="button" onClick={() => setSort(k)} aria-pressed={sort === k}
                  className={cn("flex items-center justify-end gap-1 text-right uppercase", sort === k && "text-ink underline underline-offset-4")}>
                  {label}{sort === k && <ArrowDown size={12} aria-hidden />}
                </button>
              ))}
              <span>{t("am.centres.share")}</span>
            </div>
            {rows.map((r) => {
              const on = r.centre === sel.centre;
              return (
                <button key={r.centre} type="button" onClick={() => setSelKey(r.centre)} aria-pressed={on}
                  className={cn(grid, "min-h-[52px] w-full border-b border-rule-soft border-l-2 px-[14px] text-left text-[13px]",
                    on ? "border-l-brand bg-brand-tint/40" : "border-l-transparent hover:bg-bg-2")}>
                  <span className="font-semibold text-ink">{r.centre}</span>
                  <Amount value={r.revenue} className="text-right" />
                  <Amount value={r.margin} className="text-right font-medium text-ink" />
                  <Pct value={r.marginPct} className="text-right" />
                  <Pct value={r.vsBudgetPct} signed className={cn("text-right", (r.vsBudgetPct ?? 0) < 0 && "text-alert")} />
                  <span className="h-2 rounded-full bg-bg-2" aria-label={`${r.shareOfMargin.toFixed(1)}%`}>
                    <span className="block h-full rounded-full bg-ink" style={{ width: `${Math.max(0, Math.min(100, r.shareOfMargin))}%` }} />
                  </span>
                </button>
              );
            })}
            <div className={cn(grid, "min-h-[52px] border-t border-rule-strong px-4 text-[13px] font-semibold")}>
              <span>{t("am.centres.total")}</span>
              <Amount value={totalRevenue} className="text-right" strong />
              <Amount value={totalMargin} className="text-right" strong />
              <Pct value={totalRevenue ? (totalMargin / totalRevenue) * 100 : null} className="text-right" />
              <span /><span />
            </div>
          </div>
        </div>
      </Card>

      <Card title={t("am.centres.detail", { centre: sel.centre })} className="self-start">
        <div className="space-y-4">
          <div>
            <div className="text-[12px] text-ink-soft">{t("am.centres.marginYtd")}</div>
            <Amount value={sel.margin} className="text-[26px] font-semibold text-ink" />
            {sel.budgetMargin !== null && (
              <div className="mt-1 text-[12.5px] text-ink-soft">
                {t("am.centres.budget")} <Amount value={sel.budgetMargin} />
                <span aria-hidden>{"\u00a0·\u00a0"}</span>
                <Pct value={sel.vsBudgetPct} signed className={(sel.vsBudgetPct ?? 0) < 0 ? "text-alert" : "text-success"} />
              </div>
            )}
          </div>
          {sel.note && <p className="text-[13px] leading-relaxed text-ink">{sel.note}</p>}
          {sel.contributors.length > 0 && (
            <div>
              <div className="pb-1.5 font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-soft">{t("am.centres.contributors")}</div>
              <ul>
                {sel.contributors.map((c) => (
                  <li key={c.name} className="flex min-h-[38px] items-center gap-3 border-t border-rule-soft text-[13px]">
                    <span className="flex-1 truncate">{c.name}</span>
                    <Amount value={c.value} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          <Button variant="secondary" className="w-full"
            onClick={() => onAsk(t("am.ask.aboutCentre", { centre: sel.centre }))}>
            <MessageSquare /> {t("am.ask.cta")}
          </Button>
        </div>
      </Card>
    </div>
  );
}

// ── Ask CFO AI ──────────────────────────────────────────────────────────

const newId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

export function AskView({ data, companyName, initialQuestion, onConsumeInitial }: {
  data: AmData;
  companyName: string | null;
  initialQuestion: string | null;
  onConsumeInitial: () => void;
}) {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const snapshot = useMemo(() => aiSnapshot(data, { company: companyName ?? undefined, today: new Date() }), [data, companyName]);
  const alerts = useMemo(() => alertsFor(data), [data]);
  const suggestions = [t("am.ask.q1"), t("am.ask.q2"), t("am.ask.q3"), t("am.ask.q4")]
    .filter((q) => !messages.some((m) => m.role === "user" && m.content === q));

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    const user: ChatMessage = { id: newId(), role: "user", content: q, createdAt: Date.now() };
    const pending: ChatMessage = { id: newId(), role: "assistant", content: "", createdAt: Date.now(), pending: true };
    const history = [...messages.filter((m) => !m.pending && !m.failed), user];
    setMessages([...history, pending]);
    setDraft("");
    setBusy(true);
    abortRef.current = new AbortController();
    try {
      const r = await cfoApi.chatLlm({
        messages: history.map((m) => ({ role: m.role, content: m.content })),
        dataset_summary: snapshot,
        page: "automasters",
        company_name: companyName ?? "AutoMasters",
        mode: "workspace",
        display_currency: "EUR",
      }, abortRef.current.signal);
      const upstream = classifyUpstreamAnswer(r.answer);
      setMessages((ms) => ms.map((m) => (m.id === pending.id
        ? upstream ? { ...m, pending: false, failed: upstream } : { ...m, content: r.answer, pending: false }
        : m)));
    } catch (e) {
      setMessages((ms) => ms.map((m) => (m.id === pending.id
        ? { ...m, pending: false, failed: classifyAiFailure(e) } : m)));
    } finally {
      setBusy(false);
    }
  };

  // A question handed over from another screen ("Ask CFO AI" on a centre).
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    if (!initialQuestion) return;
    onConsumeInitial();
    void sendRef.current(initialQuestion);
  }, [initialQuestion, onConsumeInitial]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      <Card title={t("am.ask.title")} bodyClassName="p-0">
        <p className="border-b border-rule px-4 py-2.5 text-[12.5px] text-ink-soft">{t("am.ask.grounding")}</p>
        <div className="max-h-[56vh] min-h-[260px] space-y-4 overflow-y-auto px-4 py-5 chat-scroll" aria-live="polite">
          {messages.length === 0 && <p className="text-[14px] text-ink-soft">{t("am.ask.hello")}</p>}
          {messages.map((m, i) => (
            <CFOMessageBubble key={m.id} message={m}
              onRetry={m.failed && i === messages.length - 1
                ? () => {
                  const lastUser = [...messages].reverse().find((x) => x.role === "user");
                  if (lastUser) {
                    setMessages((ms) => ms.filter((x) => x.id !== m.id && x.id !== lastUser.id));
                    void send(lastUser.content);
                  }
                }
                : undefined} />
          ))}
        </div>
        <div className="space-y-3 border-t border-rule px-4 py-3">
          {suggestions.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {suggestions.map((q) => (
                <button key={q} type="button" disabled={busy} onClick={() => void send(q)}
                  className="rounded-sm border border-rule bg-surface px-3 py-1.5 text-left text-[12.5px] text-ink hover:bg-bg-2 disabled:opacity-50">
                  {q}
                </button>
              ))}
            </div>
          )}
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void send(draft); }}>
            <label className="sr-only" htmlFor="am-ask">{t("am.ask.placeholder")}</label>
            <input id="am-ask" value={draft} onChange={(e) => setDraft(e.target.value)}
              placeholder={t("am.ask.placeholder")}
              className="h-10 min-w-0 flex-1 rounded-sm border border-rule bg-surface px-3 text-[14px] text-ink placeholder:text-ink-mute focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
            <Button type="submit" disabled={busy || !draft.trim()}>
              <Send /> {t("am.ask.send")}
            </Button>
          </form>
        </div>
      </Card>

      <Card title={t("am.ask.openAlerts")} className="self-start">
        {alerts.length ? (
          <ul className="space-y-2">
            {alerts.map((a, i) => (
              <li key={i} className="flex items-start gap-2 text-[13px] leading-snug">
                <Dot tone={a.tone === "danger" ? "danger" : "warn"} className="mt-1.5" />
                <span>{t(`am.alert.${a.key}`, { centre: a.centre, count: a.count })}</span>
              </li>
            ))}
          </ul>
        ) : (
          <StatusPill tone="ok">{t("am.alert.none")}</StatusPill>
        )}
      </Card>
    </div>
  );
}
