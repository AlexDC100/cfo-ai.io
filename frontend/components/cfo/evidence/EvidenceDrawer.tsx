// EvidenceDrawer — THE ACCOUNT VIEW (design C4): the receiver for
// `?account=<code>` and `?line=<line key>` on the dashboard.
//
// Every "opens its evidence" link that names an account or a statement line
// lands here: the command bar's Cont rows and statement answers, the items of
// "Ce contează acum" that are a statement line or cite accounts, and the
// learning popover's "open in the statement". What it shows is the served
// period body and nothing else (evidenceView.ts): the leaves as line items
// serve them, a total only where the engine serves one for exactly that
// code, the balance-sheet row the account rolls into with its own served
// amount, the period, the document and each figure's provenance. The
// requested accounts are HIGHLIGHTED and scrolled into view — the
// reader lands on the row the link named, not on a page to search.
//
// Closing drops `account` / `line` (Back does not reopen it); the tab the
// link opened stays, so the statement is what is behind it.

import { useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  ProvenanceAffordance,
  provenanceOf,
  type AmountProvenance,
} from "@/components/instrument/Provenance";
import { useAmountFormatter } from "@/stores/currency";
import { EVIDENCE_ACCOUNT_PARAM, EVIDENCE_LINE_PARAM, realStatementTab } from "@/lib/evidence/evidenceLink";
import { HIGHLIGHT_PARAM, TAB_PARAM } from "@/lib/traceableSource";
import { absentText, langOf, printMoney, type Printer } from "@/components/instrument/shell/cmdbar/cmdbarFigures";

import "./evidenceI18n";
import {
  buildEvidenceModel,
  readEvidenceRequest,
  type EvidenceAccountBlock,
  type EvidenceBody,
  type EvidenceLeaf,
} from "./evidenceView";

export interface EvidenceDrawerProps {
  /** The served period body the dashboard shows. */
  body: EvidenceBody;
  periodLabel: string | null;
  /** The uploaded document behind the period. */
  documentName: string | null;
  currency: string;
}

const HIGHLIGHT_CLASS = "bg-brand-tint/40 ring-1 ring-inset ring-brand/50";

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** What the envelope says about how its rows were read — the same fields
 *  the balance sheet's row cards claim (sheet, method, mapping pack). */
function readingOf(body: EvidenceBody): { sheet?: string; method?: string; pack?: string } {
  const st = body?.statements;
  const cbs = isObj(st) ? st.canonical_bs : null;
  if (!isObj(cbs)) return {};
  const ex = isObj(cbs.extraction) ? cbs.extraction : {};
  return {
    sheet: typeof ex.sheet === "string" ? ex.sheet : undefined,
    method: typeof ex.method === "string" ? ex.method : undefined,
    pack: typeof cbs.mapping_version === "string" ? cbs.mapping_version : undefined,
  };
}

export function EvidenceDrawer({ body, periodLabel, documentName, currency }: EvidenceDrawerProps) {
  const [params, setParams] = useSearchParams();
  const { t, i18n } = useTranslation();
  const lang = langOf(i18n.language);
  const fmt = useAmountFormatter(currency);
  const printer = useMemo<Printer>(() => ({ lang, money: (v: number) => fmt(v) }), [lang, fmt]);

  const request = useMemo(() => readEvidenceRequest(params), [params]);
  const model = useMemo(
    () => (request && body ? buildEvidenceModel(body, request) : null),
    [request, body],
  );
  const reading = useMemo(() => readingOf(body), [body]);
  const source = [documentName, reading.sheet].filter((s): s is string => !!s && s.trim().length > 0).join(" · ");
  const provenance = (accounts: string): AmountProvenance | null =>
    provenanceOf({ accounts, source: source || undefined, method: reading.method, pack: reading.pack });

  const contentRef = useRef<HTMLDivElement | null>(null);
  const open = model !== null;
  const requestKey = request ? `${request.line ?? ""}|${request.accounts.join(",")}` : "";
  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => {
      const el = contentRef.current?.querySelector<HTMLElement>('[data-evidence-target][data-highlighted="true"]');
      el?.scrollIntoView?.({ block: "nearest" });
    }, 60);
    return () => window.clearTimeout(id);
  }, [open, requestKey]);

  const close = (extra?: Record<string, string>) => {
    const next = new URLSearchParams(params);
    next.delete(EVIDENCE_ACCOUNT_PARAM);
    next.delete(EVIDENCE_LINE_PARAM);
    for (const [k, v] of Object.entries(extra ?? {})) next.set(k, v);
    setParams(next, { replace: true });
  };

  if (!model) return null;

  const line = model.line;
  const statementWord = (s: "BS" | "PL" | "pl" | "bs" | null) =>
    s === "PL" || s === "pl" ? t("evidence.statementPL") : t("evidence.statementBS");
  const title = line
    ? line.spec.name[lang]
    : model.accounts.length === 1
      ? model.accounts[0].name
        ? t("evidence.titleAccountNamed", { code: model.accounts[0].code, name: model.accounts[0].name })
        : t("evidence.titleAccount", { code: model.accounts[0].code })
      : t("evidence.titleAccounts", { count: model.accounts.length });
  const meta = documentName
    ? t("evidence.meta", { period: periodLabel ?? "", document: documentName })
    : t("evidence.metaNoDocument", { period: periodLabel ?? "" });
  const accountsHeading = model.cited
    ? t("evidence.citedHeading")
    : line
      ? t("evidence.feedsHeading")
      : t("evidence.accountsHeading");

  return (
    <Sheet open onOpenChange={(o) => { if (!o) close(); }}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-[560px] p-0 bg-bg border-l border-rule flex flex-col"
        data-testid="evidence-drawer"
        data-evidence-line={line?.spec.key ?? undefined}
        data-evidence-accounts={model.request.accounts.join(",") || undefined}
        // Focus the view itself on open, not its first focusable: that is a
        // provenance affordance, and focusing it would pop its card over the
        // figure the reader came to see (and swallow the first Escape).
        onOpenAutoFocus={(e) => { e.preventDefault(); contentRef.current?.focus(); }}
      >
        <div ref={contentRef} tabIndex={-1} className="flex-1 overflow-y-auto px-5 py-5 space-y-5 outline-none">
          <header className="space-y-1 pr-8">
            <div className="text-[10.5px] font-mono uppercase tracking-[0.12em] text-ink-soft">{t("evidence.kicker")}</div>
            <SheetTitle className="text-[16px] font-semibold text-ink leading-snug" data-testid="evidence-title">
              {title}
            </SheetTitle>
            <SheetDescription className="text-[12px] text-ink-soft" data-testid="evidence-meta">
              {meta}
            </SheetDescription>
          </header>

          {model.unknownLine ? (
            <p className="text-[12.5px] text-ink" data-testid="evidence-unknown-line">
              {t("evidence.unknownLine", { line: model.unknownLine })}
            </p>
          ) : null}

          {line ? (
            <section
              className={`rounded-md border border-rule px-4 py-3 space-y-1 ${HIGHLIGHT_CLASS}`}
              data-evidence-target={`line:${line.spec.key}`}
              data-highlighted="true"
              data-testid="evidence-line"
            >
              <div className="text-[10.5px] uppercase tracking-[0.08em] text-ink-soft">{t("evidence.servedFigure")}</div>
              <div className="font-mono tabular-nums text-[18px] text-ink" data-testid="evidence-line-value">
                {printMoney(printer, line.figure.value) ?? absentText(printer, line.figure.refusal)}
              </div>
              <div className="text-[11.5px] text-ink-soft" data-testid="evidence-line-source">
                {t("evidence.servedFrom", { source: line.figure.source })}
              </div>
              {line.derived ? (
                <div className="pt-1 space-y-1.5">
                  <p className="text-[12px] text-ink-2" data-testid="evidence-derived">{t("evidence.derived")}</p>
                  {line.spec.highlight ? (
                    <button
                      type="button"
                      className="text-[12px] text-brand underline underline-offset-2"
                      data-testid="evidence-see-row"
                      onClick={() => close({
                        [TAB_PARAM]: realStatementTab(line.spec.statement) ?? "pl",
                        [HIGHLIGHT_PARAM]: line.spec.highlight as string,
                      })}
                    >
                      {t("evidence.seeRow", { statement: statementWord(line.spec.statement) })}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </section>
          ) : null}

          {line && line.leaves.length > 0 ? (
            <section className="space-y-2" data-testid="evidence-feeds">
              <h3 className="text-[10.5px] uppercase tracking-[0.12em] text-ink-soft font-semibold">{accountsHeading}</h3>
              <LeafTable leaves={line.leaves} fmt={fmt} provenance={provenance} t={t} highlight={false} />
            </section>
          ) : null}
          {line && !line.derived && line.leaves.length === 0 && model.accounts.length === 0 ? (
            <p className="text-[12px] text-ink-soft" data-testid="evidence-no-leaves">{t("evidence.noLeaves")}</p>
          ) : null}

          {model.accounts.length > 0 ? (
            <section className="space-y-3" data-testid="evidence-accounts">
              {line ? (
                <h3 className="text-[10.5px] uppercase tracking-[0.12em] text-ink-soft font-semibold">{accountsHeading}</h3>
              ) : null}
              {model.accounts.map((block) => (
                <AccountBlockView
                  key={block.code}
                  block={block}
                  fmt={fmt}
                  provenance={provenance}
                  t={t}
                  statementWord={statementWord}
                />
              ))}
            </section>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

type Fmt = (v: number | null | undefined) => string;
type T = (key: string, vars?: Record<string, unknown>) => string;

function LeafTable({ leaves, fmt, provenance, t, highlight }: {
  leaves: EvidenceLeaf[];
  fmt: Fmt;
  provenance: (accounts: string) => AmountProvenance | null;
  t: T;
  /** Highlight the leaves that ARE a requested code. */
  highlight: boolean;
}) {
  return (
    <table className="w-full text-[12.5px]">
      <thead>
        <tr className="text-[10.5px] uppercase tracking-[0.06em] text-ink-mute">
          <th scope="col" className="py-1 pr-2 text-left font-medium">{t("evidence.colCode")}</th>
          <th scope="col" className="py-1 px-2 text-left font-medium">{t("evidence.colName")}</th>
          <th scope="col" className="py-1 pl-2 text-right font-medium">{t("evidence.colAmount")}</th>
        </tr>
      </thead>
      <tbody>
        {leaves.map((l) => {
          const lit = highlight && l.exact;
          return (
            <tr
              key={`${l.code}:${l.bucket}`}
              className={`border-t border-rule-soft ${lit ? HIGHLIGHT_CLASS : ""}`}
              data-testid="evidence-leaf"
              data-evidence-target={`leaf:${l.code}`}
              data-account-code={l.code}
              data-highlighted={lit ? "true" : undefined}
            >
              <td className="py-1 pr-2 font-mono tabular-nums text-ink">{l.code}</td>
              <td className="py-1 px-2 text-ink-2">{l.name}</td>
              <td className="py-1 pl-2 text-right font-mono tabular-nums text-ink" data-cell="amount">
                <ProvenanceAffordance provenance={provenance(l.code)} value={l.amount}>
                  {fmt(l.amount)}
                </ProvenanceAffordance>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function AccountBlockView({ block, fmt, provenance, t, statementWord }: {
  block: EvidenceAccountBlock;
  fmt: Fmt;
  provenance: (accounts: string) => AmountProvenance | null;
  t: T;
  statementWord: (s: "BS" | "PL" | null) => string;
}) {
  return (
    <div
      className={`rounded-md border border-rule px-4 py-3 space-y-2 ${HIGHLIGHT_CLASS}`}
      data-testid="evidence-account"
      data-evidence-target={`account:${block.code}`}
      data-account-code={block.code}
      data-highlighted="true"
      data-absent={block.absent ? "true" : undefined}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-mono tabular-nums text-[13px] text-ink">{block.code}</span>
        <span className="text-[11px] text-ink-soft">{block.statement ? statementWord(block.statement) : ""}</span>
      </div>
      {block.name ? <div className="text-[12.5px] text-ink-2">{block.name}</div> : null}

      {block.absent ? (
        <p className="text-[12.5px] text-ink" data-testid="evidence-absent">{t("evidence.absent", { code: block.code })}</p>
      ) : null}

      {block.total ? (
        <div className="space-y-0.5" data-testid="evidence-total">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[12px] text-ink">{t("evidence.total", { code: block.code })}</span>
            <span className="font-mono tabular-nums text-[13px] text-ink">
              <ProvenanceAffordance provenance={provenance(block.code)} value={block.total.amount}>
                {fmt(block.total.amount)}
              </ProvenanceAffordance>
            </span>
          </div>
          <div className="text-[11px] text-ink-soft">
            {t("evidence.totalSource", { label: block.total.label, source: block.total.source })}
          </div>
          {block.leaves.length === 0 && block.total.leafIds.length > 0 ? (
            <div className="text-[11px] text-ink-soft" data-testid="evidence-leaf-ids">
              {t("evidence.leafIds", { ids: block.total.leafIds.join(", ") })}
            </div>
          ) : null}
        </div>
      ) : !block.absent && !block.leaves.some((l) => l.exact) ? (
        <p className="text-[11.5px] text-ink-soft" data-testid="evidence-no-total">{t("evidence.noTotal", { code: block.code })}</p>
      ) : null}

      {block.leaves.length > 0 ? (
        <>
          {block.leaves.length > 1 ? (
            <div className="text-[11px] text-ink-soft">{t("evidence.leafCount", { count: block.leaves.length })}</div>
          ) : null}
          <LeafTable leaves={block.leaves} fmt={fmt} provenance={provenance} t={t} highlight />
        </>
      ) : null}

      {block.rollups.length > 0 ? (
        <div className="pt-1 space-y-1" data-testid="evidence-rollups">
          <div className="text-[10.5px] uppercase tracking-[0.08em] text-ink-soft">{t("evidence.rollupHeading")}</div>
          <ul className="space-y-0.5">
            {block.rollups.map((r) => (
              <li key={r.id} className="flex items-baseline justify-between gap-3 text-[12px]" data-testid="evidence-rollup" data-row-id={r.id}>
                <span className="text-ink-2">{t("evidence.rollupRow", { label: r.label, codes: r.codes.join(", ") })}</span>
                <span className="font-mono tabular-nums text-ink">
                  <ProvenanceAffordance provenance={provenance(r.codes.join(", "))} value={r.amount}>
                    {fmt(r.amount)}
                  </ProvenanceAffordance>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
