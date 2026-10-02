// AutoMasters — Finance: payments reconciliation, SAGA / e-Factura exports,
// month close.

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Check, Link2, RotateCcw, Undo2, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { formatDateOnly, formatDateTime, useActiveLocale } from "@/lib/locale";
import { cn } from "@/lib/utils";
import {
  closeHint,
  closeState,
  isFailed,
  proposeMatches,
  reconRows,
  round2,
  STATUS_ORDER,
  type AmData,
  type ExportChannel,
  type ExportStatus,
  type ReconState,
} from "@/lib/automasters/model";
import {
  closeMonth,
  matchPayments,
  openClosePeriod,
  requestExportRetry,
  setCloseCheck,
  unmatchPayment,
} from "@/lib/automasters/data";
import { Amount, BlockedNote, Card, Dot, Empty, Pct, StatusPill, type Tone } from "./ui";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function monthLong(period: string, locale: string): string {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(locale, { month: "long", year: "numeric", timeZone: "UTC" });
}

// ── Payments reconciliation ─────────────────────────────────────────────

export function PaymentsView({ data, orgId, refresh, onImport }: {
  data: AmData;
  orgId: string;
  refresh: () => void;
  onImport: () => void;
}) {
  const { t } = useTranslation();
  const [bankSel, setBankSel] = useState<string | null>(null);
  const [docSel, setDocSel] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const matchedBank = useMemo(() => new Set(data.matches.map((m) => m.bank_line_id)), [data.matches]);
  const matchedDoc = useMemo(() => new Set(data.matches.map((m) => m.document_id)), [data.matches]);
  const proposals = useMemo(() => proposeMatches(data), [data]);
  const suggestedBank = new Set(proposals.map((p) => p.bank_line_id));

  if (!data.bank.length && !data.documents.length) {
    return (
      <Card>
        <Empty title={t("am.empty.payments")} body={t("am.empty.importHint")}
          action={<Button variant="secondary" onClick={onImport}>{t("am.import.open")}</Button>} />
      </Card>
    );
  }

  const bank = data.bank.find((b) => b.id === bankSel && !matchedBank.has(b.id)) ?? null;
  const doc = data.documents.find((d) => d.id === docSel && !matchedDoc.has(d.id)) ?? null;
  const diff = bank && doc ? round2(doc.amount - bank.amount) : 0;
  const currencyClash = !!bank && !!doc && bank.currency !== doc.currency;
  const openBank = data.bank.filter((b) => !matchedBank.has(b.id)).length;

  const run = async (fn: () => Promise<void>, ok?: string) => {
    setSaving(true);
    try {
      await fn();
      if (ok) toast.success(ok);
      refresh();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  const byId = <T extends { id: string }>(list: T[], id: string) => list.find((x) => x.id === id);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <StatusPill tone={openBank ? "warn" : "ok"}>{t("am.pay.openCount", { count: openBank })}</StatusPill>
        <StatusPill tone="muted">{t("am.pay.matchedCount", { count: data.matches.length })}</StatusPill>
        <div className="flex-1" />
        <Button variant="secondary" disabled={saving || !proposals.length}
          onClick={() => run(() => matchPayments(orgId, proposals, "auto"), t("am.pay.autoDone", { count: proposals.length }))}>
          <Wand2 /> {t("am.pay.auto", { count: proposals.length })}
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title={t("am.pay.bank")} bodyClassName="p-0">
          <ul>
            {data.bank.map((b) => {
              const done = matchedBank.has(b.id);
              const on = b.id === bankSel && !done;
              return (
                <li key={b.id}>
                  <button type="button" disabled={done} aria-pressed={on} onClick={() => setBankSel(on ? null : b.id)}
                    className={cn("flex w-full items-center gap-3 border-b border-l-2 border-rule-soft px-4 py-3 text-left",
                      on ? "border-l-brand bg-brand-tint/40" : "border-l-transparent hover:bg-bg-2",
                      done && "opacity-45")}>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-semibold text-ink">{b.payer}</span>
                      <span className="block truncate text-[12px] text-ink-soft">
                        {formatDateOnly(b.booked_on)}{b.reference ? ` · ${b.reference}` : ""}
                      </span>
                    </span>
                    {suggestedBank.has(b.id) && !done && <StatusPill tone="info">{t("am.pay.suggested")}</StatusPill>}
                    {done && <StatusPill tone="ok">{t("am.pay.matched")}</StatusPill>}
                    <Amount value={b.amount} currency={b.currency} className="text-[13px]" />
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>

        <Card title={t("am.pay.documents")} bodyClassName="p-0">
          <ul>
            {data.documents.map((d) => {
              const done = matchedDoc.has(d.id);
              const on = d.id === docSel && !done;
              return (
                <li key={d.id}>
                  <button type="button" disabled={done} aria-pressed={on} onClick={() => setDocSel(on ? null : d.id)}
                    className={cn("flex w-full items-center gap-3 border-b border-l-2 border-rule-soft px-4 py-3 text-left",
                      on ? "border-l-brand bg-brand-tint/40" : "border-l-transparent hover:bg-bg-2",
                      done && "opacity-45")}>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-semibold text-ink">{d.customer}</span>
                      <span className="block truncate text-[12px] text-ink-soft">
                        <span className="font-mono">{d.doc_number}</span> · {t(`am.kind.${d.kind}`)}
                      </span>
                    </span>
                    {done && <StatusPill tone="ok">{t("am.pay.matched")}</StatusPill>}
                    <Amount value={d.amount} currency={d.currency} className="text-[13px]" />
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>
      </div>

      <Card title={t("am.pay.pair")}>
        <div className="flex flex-wrap items-center gap-4">
          <p className="min-w-0 flex-1 text-[13.5px] text-ink">
            {bank && doc ? (
              <>
                {bank.payer} · <Amount value={bank.amount} currency={bank.currency} /> → <span className="font-mono">{doc.doc_number}</span> · <Amount value={doc.amount} currency={doc.currency} />
                {diff !== 0 && !currencyClash && (
                  <span className="ml-2 text-caution">{t("am.pay.difference")} <Amount value={diff} currency={doc.currency} /></span>
                )}
              </>
            ) : t("am.pay.pickBoth")}
          </p>
          <Button disabled={!bank || !doc || saving || currencyClash}
            onClick={() => bank && doc && run(
              () => matchPayments(orgId, [{ bank_line_id: bank.id, document_id: doc.id, difference: diff }], "manual"),
              t("am.pay.matchedToast"),
            ).then(() => { setBankSel(null); setDocSel(null); })}>
            <Link2 /> {t("am.pay.match")}
          </Button>
        </div>
        {currencyClash && <div className="mt-3"><BlockedNote>{t("am.pay.currencyClash")}</BlockedNote></div>}
        {diff !== 0 && bank && doc && !currencyClash && (
          <p className="mt-2 text-[12.5px] text-ink-soft">{t("am.pay.differenceNote")}</p>
        )}
      </Card>

      {data.matches.length > 0 && (
        <Card title={t("am.pay.matchedList")} bodyClassName="p-0">
          <ul>
            {data.matches.map((m) => {
              const b = byId(data.bank, m.bank_line_id);
              const d = byId(data.documents, m.document_id);
              return (
                <li key={m.id} className="flex flex-wrap items-center gap-3 border-b border-rule-soft px-4 py-2.5 text-[13px]">
                  <Dot tone={m.difference ? "warn" : "ok"} />
                  <span className="min-w-0 flex-1 truncate">
                    {b?.payer ?? "—"} → <span className="font-mono">{d?.doc_number ?? "—"}</span>
                    {m.difference !== 0 && <span className="text-ink-soft"> · {t("am.pay.difference")} <Amount value={m.difference} /></span>}
                    {m.method === "auto" && <span className="text-ink-soft"> · {t("am.pay.byAuto")}</span>}
                  </span>
                  {b && <Amount value={b.amount} currency={b.currency} />}
                  <Button variant="ghost" size="sm" disabled={saving} onClick={() => run(() => unmatchPayment(m.id))}>
                    <Undo2 /> {t("am.pay.undo")}
                  </Button>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}

// ── SAGA / e-Factura ────────────────────────────────────────────────────

const EXPORT_TONE: Record<ExportStatus, Tone> = {
  pending: "muted",
  sent: "info",
  accepted: "ok",
  reconciled: "ok",
  error: "danger",
  rejected: "danger",
};

export function ExportsView({ data, refresh, onImport }: { data: AmData; refresh: () => void; onImport: () => void }) {
  const { t } = useTranslation();
  const [channel, setChannel] = useState<ExportChannel>("saga");
  const [selId, setSelId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const rows = useMemo(() => data.exports
    .filter((e) => e.channel === channel)
    .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)
      || b.updated_at.localeCompare(a.updated_at)), [data.exports, channel]);

  if (!data.exports.length) {
    return (
      <Card>
        <Empty title={t("am.empty.exports")} body={t("am.empty.importHint")}
          action={<Button variant="secondary" onClick={onImport}>{t("am.import.open")}</Button>} />
      </Card>
    );
  }

  const sel = rows.find((r) => r.id === selId) ?? rows[0] ?? null;
  const failedCount = (c: ExportChannel) => data.exports.filter((e) => e.channel === c && isFailed(e.status)).length;

  const retry = async (id: string) => {
    setSaving(true);
    try {
      const r = await requestExportRetry(id);
      if (r.ok) toast.success(t("am.exp.retryQueued"));
      else toast.error(t("am.exp.retryRefused"));
      refresh();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div role="tablist" className="flex gap-1 border-b border-rule">
        {(["saga", "efactura"] as const).map((c) => (
          <button key={c} type="button" role="tab" aria-selected={channel === c}
            onClick={() => { setChannel(c); setSelId(null); }}
            className={cn("-mb-px inline-flex h-10 items-center gap-2 border-b-2 px-3 text-[13px] font-semibold",
              channel === c ? "border-brand text-ink" : "border-transparent text-ink-soft hover:text-ink")}>
            {t(`am.exp.${c}`)}
            {failedCount(c) > 0 && <StatusPill tone="danger">{failedCount(c)}</StatusPill>}
          </button>
        ))}
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card bodyClassName="p-0">
          {rows.length === 0 ? (
            <Empty title={t("am.exp.noneInChannel")} />
          ) : (
            <ul>
              {rows.map((r) => {
                const on = sel?.id === r.id;
                return (
                  <li key={r.id}>
                    <button type="button" aria-pressed={on} onClick={() => setSelId(r.id)}
                      className={cn("flex w-full items-center gap-3 border-b border-l-2 border-rule-soft px-4 py-3 text-left",
                        on ? "border-l-brand bg-brand-tint/40" : "border-l-transparent hover:bg-bg-2")}>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-[13px] font-semibold text-ink">{r.ref}</span>
                        <span className="block truncate text-[12px] text-ink-soft">
                          {[r.description, r.counterparty].filter(Boolean).join(" · ")}
                          {r.channel === "saga" && ` · ${t("am.exp.docs", { count: r.doc_count })}`}
                        </span>
                      </span>
                      <Amount value={r.amount} currency={r.currency} className="text-[13px]" />
                      <StatusPill tone={EXPORT_TONE[r.status]}>{t(`am.exp.status.${r.status}`)}</StatusPill>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {sel && (
          <Card title={sel.ref} className="self-start">
            <div className="space-y-4">
              <StatusPill tone={EXPORT_TONE[sel.status]}>{t(`am.exp.status.${sel.status}`)}</StatusPill>
              {sel.error_message && <BlockedNote>{sel.error_message}</BlockedNote>}
              {sel.events.length > 0 && (
                <ol className="space-y-2 border-l border-rule pl-4">
                  {sel.events.map((ev, i) => (
                    <li key={i} className="relative flex flex-col text-[12.5px] leading-snug">
                      <span aria-hidden className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-ink-mute" />
                      <span className="text-ink">{ev.text === "retry_requested" ? t("am.exp.retryEvent") : ev.text}</span>
                      {ev.at && <span className="font-mono text-[11.5px] text-ink-soft">{formatDateTime(ev.at)}</span>}
                    </li>
                  ))}
                </ol>
              )}
              {isFailed(sel.status) && (
                sel.retry_requested_at ? (
                  <p className="text-[12.5px] text-ink-soft">
                    {t("am.exp.retryWaiting", { when: formatDateTime(sel.retry_requested_at) })}
                  </p>
                ) : (
                  <Button className="w-full" disabled={saving} onClick={() => retry(sel.id)}>
                    <RotateCcw /> {t(sel.channel === "saga" ? "am.exp.retrySaga" : "am.exp.retryEf")}
                  </Button>
                )
              )}
              <p className="text-[12px] text-ink-soft">{t("am.exp.dmsOwns")}</p>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

// ── Month close ─────────────────────────────────────────────────────────

const RECON_TONE: Record<ReconState, Tone> = { balanced: "ok", minor: "warn", material: "danger", missing: "muted" };

export function CloseView({ data, orgId, period, refresh }: {
  data: AmData;
  orgId: string;
  period: string;
  refresh: () => void;
}) {
  const { t } = useTranslation();
  const locale = useActiveLocale();
  const { user } = useAuth();
  const [saving, setSaving] = useState(false);
  const state = useMemo(() => closeState(data, period), [data, period]);
  const recon = useMemo(() => reconRows(data.centres, period), [data.centres, period]);

  const run = async (fn: () => Promise<void>) => {
    setSaving(true);
    try {
      await fn();
      refresh();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  const statusTone: Record<typeof state.status, Tone> = { not_started: "muted", open: "muted", review: "warn", closed: "ok" };
  const blockText = state.block?.kind === "open_checks"
    ? t("am.close.blockedChecks", { count: state.block.count })
    : state.block?.kind === "material"
      ? t("am.close.blockedMaterial", { centres: state.block.centres.join(", ") })
      : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-[18px] font-semibold text-ink">{t("am.close.heading", { month: monthLong(period, locale) })}</h2>
        <StatusPill tone={statusTone[state.status]}>{t(`am.close.status.${state.status}`)}</StatusPill>
      </div>

      {state.status === "not_started" ? (
        <Card>
          <Empty title={t("am.close.notStarted")} body={t("am.close.notStartedBody")}
            action={<Button disabled={saving} onClick={() => run(() => openClosePeriod(orgId, period))}>{t("am.close.start")}</Button>} />
        </Card>
      ) : (
        <div className="grid gap-6 xl:grid-cols-[400px_minmax(0,1fr)]">
          <Card title={t("am.close.checklist", { done: state.doneCount, total: state.checks.length })} className="self-start" bodyClassName="p-0">
            <ul>
              {state.checks.map((c) => {
                const hint = closeHint(data, c.check_key, period);
                const frozen = state.status === "closed";
                return (
                  <li key={c.check_key} className="border-b border-rule-soft">
                    <label className={cn("flex min-h-[52px] items-start gap-3 px-4 py-3", !frozen && "cursor-pointer hover:bg-bg-2")}>
                      <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[hsl(var(--success))]"
                        checked={c.done} disabled={frozen || saving}
                        onChange={(e) => run(() => setCloseCheck(orgId, period, c.check_key, e.target.checked, user?.id ?? null))} />
                      <span className="min-w-0 flex-1">
                        <span className={cn("block text-[13.5px]", c.done ? "text-ink-soft" : "font-medium text-ink")}>
                          {t(`am.close.check.${c.check_key}`, c.check_key)}
                        </span>
                        {c.done && c.done_at ? (
                          <span className="block text-[12px] text-ink-soft">{t("am.close.doneAt", { when: formatDateTime(c.done_at) })}</span>
                        ) : hint && (
                          <span className={cn("block text-[12px]", hint.tone === "warn" ? "text-caution" : "text-ink-soft")}>
                            {t(`am.close.hint.${c.check_key}.${hint.tone}`, { count: hint.count })}
                          </span>
                        )}
                      </span>
                      {c.done && <Check size={16} className="mt-0.5 text-success" aria-hidden />}
                    </label>
                  </li>
                );
              })}
            </ul>
          </Card>

          <div className="space-y-6">
            <Card title={t("am.close.recon")} bodyClassName="p-0">
              {recon.length === 0 ? (
                <Empty title={t("am.close.noRecon")} />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[620px] text-[13px]">
                    <thead className="bg-bg-2 text-[11px] uppercase tracking-[0.08em] text-ink-soft">
                      <tr>
                        <th className="h-10 px-4 text-left font-semibold">{t("am.centres.centre")}</th>
                        <th className="px-3 text-right font-semibold">{t("am.close.dms")}</th>
                        <th className="px-3 text-right font-semibold">{t("am.close.ledger")}</th>
                        <th className="px-3 text-right font-semibold">{t("am.close.diff")}</th>
                        <th className="px-4 text-left font-semibold">{t("am.close.state")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recon.map((r) => (
                        <tr key={r.centre} className={cn("border-t border-rule-soft", r.state === "material" && "bg-alert-tint/50")}>
                          <td className="h-11 px-4 font-semibold">{r.centre}</td>
                          <td className="px-3 text-right"><Amount value={r.dms} /></td>
                          <td className="px-3 text-right"><Amount value={r.ledger} /></td>
                          <td className="px-3 text-right">
                            <Amount value={r.difference} />
                            {r.sharePct !== null && r.difference !== 0 && (
                              <span className="ml-1 text-ink-soft">(<Pct value={r.sharePct} />)</span>
                            )}
                          </td>
                          <td className="px-4"><StatusPill tone={RECON_TONE[r.state]}>{t(`am.recon.${r.state}`)}</StatusPill></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="border-t border-rule px-4 py-2.5 text-[12px] text-ink-soft">{t("am.close.reconRule")}</p>
            </Card>

            <Card>
              {state.status === "closed" ? (
                <p className="text-[13.5px] text-ink">
                  {t("am.close.closedAt", {
                    when: formatDateTime(data.periods.find((p) => p.period === period)?.closed_at ?? null),
                  })}
                </p>
              ) : (
                <div className="space-y-3">
                  {blockText && <BlockedNote>{blockText}</BlockedNote>}
                  <Button disabled={!state.canClose || saving}
                    onClick={() => run(async () => {
                      const r = await closeMonth(orgId, period);
                      if ("reason" in r) toast.error(t(`am.close.refused.${r.reason}`));
                      else toast.success(t("am.close.closedToast", { month: monthLong(period, locale) }));
                    })}>
                    {t("am.close.close")}
                  </Button>
                </div>
              )}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
