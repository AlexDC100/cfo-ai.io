// CmdbarList — the command bar's body: the header line, then ONE listbox of
// rows under group headings, in a fixed order, with the panel's caveat
// printed once.
//
//   at rest   Ce contează acum (the served attention items) · Acțiuni ·
//             Recente
//   typing    Răspuns · Cont · Pagină · Acțiune · Întreabă CFO AI (last)
//
// A heading is ONE label above a run of rows, never a word parked beside
// each row (check_capsule_craft F2). Every row is an option the keyboard
// walks; `data-idx` is its index in the flat list the host holds.

import { useTranslation } from "react-i18next";
import {
  ArrowUpRight,
  BookOpen,
  Building2,
  Clock,
  FileText,
  Hash,
  ListTree,
  Sparkles,
  Upload,
} from "lucide-react";

import "./cmdbarI18n";
import { rowDomId, sectionOf, type BarRow, type BarSection } from "./cmdbarRows";
import type { Chip } from "./cmdbarViews";

export const CAVEAT_ID = "cmdbar-caveat";
export const HEADER_ID = "cmdbar-scope";

const SECTION_KEY: Record<BarSection, string> = {
  now: "cmdbar.now.title",
  nowActions: "cmdbar.now.actions",
  recent: "cmdbar.group.recent",
  answer: "cmdbar.group.answer",
  account: "cmdbar.group.account",
  page: "cmdbar.group.page",
  action: "cmdbar.group.action",
  ask: "cmdbar.group.ask",
};

/** Every row's and heading's test id, written out: a live gate's selector
 *  must be findable in the source that emits it (check_capsule_craft F5),
 *  and a template literal is not. */
const ROW_TESTID: Record<BarRow["kind"], string> = {
  now: "cmdbar-row-now",
  "now-action": "cmdbar-row-now-action",
  recent: "cmdbar-row-recent",
  answer: "cmdbar-row-answer",
  account: "cmdbar-row-account",
  "account-more": "cmdbar-row-account-more",
  page: "cmdbar-row-page",
  action: "cmdbar-row-action",
  ask: "cmdbar-row-ask",
};
const HEADING_TESTID: Record<BarSection, string> = {
  now: "cmdbar-heading-now",
  nowActions: "cmdbar-heading-now-actions",
  recent: "cmdbar-heading-recent",
  answer: "cmdbar-heading-answer",
  account: "cmdbar-heading-account",
  page: "cmdbar-heading-page",
  action: "cmdbar-heading-action",
  ask: "cmdbar-heading-ask",
};

export interface CmdbarListProps {
  header: string;
  rows: BarRow[];
  activeIdx: number;
  onActivate: (idx: number) => void;
  onRun: (idx: number) => void;
  /** The ONE caveat line for the panel (joined served caveats), or null. */
  caveat: string | null;
  /** A single status line when there are no rows to show (loading, no
   *  period, nothing material). */
  status: string | null;
  mode: "rest" | "typing";
}

function ChipText({ chip }: { chip: Chip }) {
  return (
    <span
      data-chip-state={chip.state}
      className={chip.state === "ok" ? "text-ink-soft" : "italic text-ink-soft"}
    >
      {chip.text}
    </span>
  );
}

function Sep() {
  return <span aria-hidden="true" className="px-1 text-ink-soft">·</span>;
}

function RowBody({ row }: { row: BarRow }) {
  const { t } = useTranslation();
  switch (row.kind) {
    case "now": {
      const v = row.view;
      return (
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-[12.5px] text-ink">{v.subject}</span>
            <span data-figure="now" className="shrink-0 font-mono text-[12.5px] tabular-nums text-ink">{v.figure}</span>
            {v.context && <span className="truncate text-[11.5px] text-ink-soft">{v.context}</span>}
          </span>
          {v.basis && <span data-basis className="block truncate text-[11px] text-ink-soft">{v.basis}</span>}
        </span>
      );
    }
    case "answer": {
      const v = row.view;
      const chips: Chip[] = [];
      if (v.change) chips.push(v.change);
      for (const r of v.ratios) chips.push({ state: "ok", text: r });
      if (v.sector) chips.push(v.sector);
      return (
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-[12.5px] text-ink">{v.label}</span>
            {v.value !== null ? (
              <span data-figure="answer" className="shrink-0 font-mono text-[13px] font-medium tabular-nums text-ink">{v.value}</span>
            ) : (
              <span data-absent className="truncate text-[12px] italic text-ink-soft">{v.absent}</span>
            )}
            {v.tag && <span className="shrink-0 text-[11px] text-ink-soft">{v.tag}</span>}
          </span>
          {(chips.length > 0 || v.basis) && (
            <span className="block truncate text-[11px]">
              {chips.map((c, i) => (
                <span key={i}>{i > 0 && <Sep />}<ChipText chip={c} /></span>
              ))}
              {v.basis && <>{chips.length > 0 && <Sep />}<span data-basis className="text-ink-soft">{v.basis}</span></>}
            </span>
          )}
        </span>
      );
    }
    case "account": {
      const v = row.view;
      return (
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 font-mono text-[12px] tabular-nums text-ink">{v.code}</span>
            <span className="truncate text-[12.5px] text-ink">{v.name}</span>
            {v.value !== null ? (
              <span data-figure="account" className="ml-auto shrink-0 font-mono text-[12.5px] tabular-nums text-ink">{v.value}</span>
            ) : (
              <span data-absent className="ml-auto shrink-0 text-[12px] italic text-ink-soft">{v.absent}</span>
            )}
          </span>
          <span className="block truncate text-[11px] text-ink-soft">
            {v.statement}
            {v.keyMetric && <><Sep />{v.keyMetric}</>}
            {v.basis && <><Sep /><span data-basis>{v.basis}</span></>}
          </span>
        </span>
      );
    }
    case "account-more":
      return <span data-more={row.view.more} className="text-[12px] text-ink-soft">{row.view.text}</span>;
    case "now-action":
      return <span className="truncate text-[12.5px] text-ink">{row.view.label}</span>;
    case "recent":
      return <span className="truncate text-[12.5px] text-ink">{row.recent.label}</span>;
    case "page":
    case "action":
      return <span className="truncate text-[12.5px] text-ink">{row.label}</span>;
    case "ask":
      return (
        <span className="truncate text-[12.5px] text-ink">
          {row.query ? t("cmdbar.ask.row", { query: row.query }) : t("cmdbar.ask.empty")}
        </span>
      );
  }
}

function RowIcon({ row }: { row: BarRow }) {
  const cls = "shrink-0 text-ink-soft";
  switch (row.kind) {
    case "answer": return <Hash size={13} strokeWidth={1.75} className={cls} />;
    case "account": return <BookOpen size={13} strokeWidth={1.75} className={cls} />;
    case "account-more": return <ListTree size={13} strokeWidth={1.75} className={cls} />;
    case "page": return <FileText size={13} strokeWidth={1.75} className={cls} />;
    case "action":
    case "now-action":
      return row.id.includes("upload") || row.id.includes("add")
        ? <Upload size={13} strokeWidth={1.75} className={cls} />
        : row.id.includes("switch")
          ? <Building2 size={13} strokeWidth={1.75} className={cls} />
          : <ArrowUpRight size={13} strokeWidth={1.75} className={cls} />;
    case "recent": return <Clock size={13} strokeWidth={1.75} className={cls} />;
    case "ask": return <Sparkles size={13} strokeWidth={1.75} className="shrink-0 text-brand" />;
    case "now": return <span aria-hidden="true" className="w-[13px] shrink-0 text-center font-mono text-[11px] text-ink-soft">{row.view.rank}</span>;
  }
}

export function CmdbarList({ header, rows, activeIdx, onActivate, onRun, caveat, status, mode }: CmdbarListProps) {
  const { t } = useTranslation();
  let lastSection: BarSection | null = null;
  // The caveat qualifies "Ce contează acum", so it sits directly under
  // those items — visible without scrolling past the actions — and once.
  const lastNowIdx = rows.reduce((acc, r, i) => (r.kind === "now" ? i : acc), -1);
  const caveatNode = caveat ? (
    <p
      id={CAVEAT_ID}
      data-testid="cmdbar-caveat"
      className="px-4 pb-1 pt-1.5 text-[11px] leading-snug text-ink-soft"
    >
      {caveat}
    </p>
  ) : null;
  return (
    <div data-testid="cmdbar" data-mode={mode} className="flex flex-col">
      <p
        id={HEADER_ID}
        data-testid="cmdbar-scope"
        className="truncate px-4 pb-1.5 text-[11px] text-ink-soft"
      >
        {header}
      </p>
      {status && (
        <p data-testid="cmdbar-status" className="px-4 py-2 text-[12.5px] text-ink-soft">{status}</p>
      )}
      <div
        role="listbox"
        aria-labelledby={HEADER_ID}
        aria-describedby={caveat ? CAVEAT_ID : undefined}
        data-testid="cmdbar-rows"
      >
        {rows.map((row, idx) => {
          const section = sectionOf(row);
          const heading = section !== lastSection;
          lastSection = section;
          const active = idx === activeIdx;
          // "Întreabă CFO AI" is always the LAST row, and stays in view:
          // when the groups above it outgrow the card it sticks to the
          // bottom of the list instead of scrolling away.
          const sticky = row.kind === "ask"
            ? "sticky bottom-0 z-[1] bg-[hsl(var(--surface)/0.97)] backdrop-blur-sm"
            : "";
          return (
            <div key={`${row.id}:${idx}`} role="presentation" className={sticky || undefined}>
              {heading && (
                <div
                  role="presentation"
                  data-testid={HEADING_TESTID[section]}
                  className="px-4 pb-1 pt-2.5 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-ink-soft"
                >
                  {t(SECTION_KEY[section])}
                </div>
              )}
              <div
                id={rowDomId(idx)}
                role="option"
                aria-selected={active}
                data-idx={idx}
                data-row-kind={row.kind}
                data-row-id={row.id}
                data-testid={ROW_TESTID[row.kind]}
                onMouseMove={() => { if (!active) onActivate(idx); }}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onRun(idx)}
                className={`flex min-h-9 w-full cursor-pointer items-center gap-3 px-4 py-1.5 text-left transition-colors duration-micro ${
                  active ? "bg-bg-2" : "hover:bg-bg-2/60"
                }`}
              >
                <RowIcon row={row} />
                <RowBody row={row} />
              </div>
              {idx === lastNowIdx && caveatNode}
            </div>
          );
        })}
      </div>
      {lastNowIdx < 0 && caveatNode}
    </div>
  );
}
