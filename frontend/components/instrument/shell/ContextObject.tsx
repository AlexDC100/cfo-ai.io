// THE INSTRUMENT — ContextObject: the header's named context chip.
//
// "Scandia Food · Dec 2025" — workspace identity and active period as ONE
// object, sitting left in the command deck. Click opens a switcher popover:
// recent periods (filterable), workspaces, and a link into the upload flow.
//
// The `?period=<UUID>` stays a URL concern only — rows render formatted
// month labels, never ids (D11). Period navigation goes through
// usePeriodStepper's goToPeriod so the scan guard and the switch overlay
// behave exactly as they do for every other period switch in the app.

import { useMemo, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Check, ChevronDown, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";

import "./shellI18n";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useWorkspaceName } from "@/lib/workspaceName";
import { useWorkspaces } from "@/lib/workspaces";
import { usePeriodStepper } from "@/lib/usePeriodStepper";
import { useActiveLocale } from "@/lib/locale";
import { formatPeriodMonth } from "@/lib/orgPeriods";
import { useUploadRoute, useWorkspaceV2 } from "@/lib/previewFeatures";

/** "Workspace · Dec 2025" as a plain string — the Capsule renders the
 *  identity inline instead of mounting the whole popover component.
 *  Same sources, same formatting, same D11 rule: formatted labels only,
 *  never the ?period UUID. */
export function useCapsuleLabel(): string {
  const { t } = useTranslation();
  const locale = useActiveLocale();
  const workspaceName = useWorkspaceName();
  const { selectedEnd } = usePeriodStepper();
  const { pathname } = useLocation();
  const workspaceV2 = useWorkspaceV2();
  // The header describes the SCREEN (2026-09-26). Home (/workspace, the
  // redesign) is about all the companies, not the one last opened: the
  // capsule names the screen, never a company over a screen that is not
  // that company's.
  if (workspaceV2 && pathname === "/workspace") return t("wsV2.home.title");
  // A month the header cannot resolve — the period list still loading, or a
  // company with no analysed year — is LEFT OUT, never replaced by today's
  // month. That fallback dates from the permanent empty current-month period
  // every workspace used to carry; G4 (2026-09-21) creates no period without
  // an analysed file, so today's month would name a period that does not
  // exist ("Agras SRL · Sept 2026" over a company whose only year is 2025).
  const periodLabel = formatPeriodMonth(selectedEnd, locale);
  const name = (workspaceName ?? "").trim();
  const full = name && periodLabel ? `${name} \u00b7 ${periodLabel}` : name || periodLabel || "";
  // 24ch truncation per the directive; the title attr carries the rest.
  return full.length > 24 ? full.slice(0, 23).trimEnd() + "\u2026" : full;
}

export function ContextObject() {
  const { t } = useTranslation();
  const locale = useActiveLocale();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const workspaceName = useWorkspaceName();
  const { workspaces, currentId, select } = useWorkspaces();
  const { periods, selectedEnd, goToPeriod } = usePeriodStepper();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  // Nothing resolvable names no month (see useCapsuleLabel): the permanent
  // current-month period this used to fall back to is no longer created (G4).
  const periodLabel = formatPeriodMonth(selectedEnd, locale);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = periods.map((p) => ({
      id: p.period_id,
      label: formatPeriodMonth(p.period_end, locale) ?? "—",
      end: p.period_end,
    }));
    const filtered = q ? all.filter((r) => r.label.toLowerCase().includes(q)) : all;
    return filtered.slice(0, 9);
  }, [periods, query, locale]);

  const selectedId = params.get("period");

  function pickPeriod(id: string) {
    setOpen(false);
    goToPeriod(id);
  }

  function pickWorkspace(id: string) {
    setOpen(false);
    if (id !== currentId) void select(id);
  }

  const period = params.get("period");
  const uploadTo = useUploadRoute(
    period ? `/dashboard?period=${encodeURIComponent(period)}` : "/dashboard",
  );
  function goUpload() {
    setOpen(false);
    navigate(uploadTo);
  }

  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (!v) setQuery(""); }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="context-object"
          aria-label={t("shell.context.openLabel")}
          className="
            group inline-flex h-8 min-w-0 items-center gap-1.5 rounded-sm
            border border-rule bg-transparent px-2.5
            text-[12.5px] text-ink
            hover:bg-bg-2 transition-colors duration-micro
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
          "
        >
          <span className="max-w-[160px] truncate font-medium">
            {workspaceName || t("shell.context.noWorkspace")}
          </span>
          {periodLabel && (
            <>
              <span aria-hidden className="text-ink-mute">·</span>
              <span
                data-testid="context-object-period"
                className="whitespace-nowrap font-mono text-[11px] uppercase tracking-[0.1em] tabular-nums text-ink-soft"
              >
                {periodLabel}
              </span>
            </>
          )}
          <ChevronDown
            size={12}
            strokeWidth={2}
            className="shrink-0 text-ink-mute transition-transform duration-micro group-data-[state=open]:rotate-180"
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={8}
        className="w-[280px] rounded-md border-rule bg-surface p-0 shadow-3"
        data-testid="context-object-popover"
      >
        {/* Periods */}
        <div className="border-b border-rule-soft px-3 pb-1 pt-2.5">
          <div className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-ink-mute">
            {t("shell.context.periods")}
          </div>
          {periods.length > 6 && (
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("shell.context.filterPlaceholder")}
              className="mb-1.5 h-7 w-full rounded-sm border border-rule bg-bg-2 px-2 text-[12px] text-ink placeholder:text-ink-mute outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          )}
          {rows.length === 0 ? (
            <p className="px-1 pb-2 pt-0.5 text-[12px] leading-relaxed text-ink-soft">
              {t("shell.context.noPeriods")}
            </p>
          ) : (
            <ul className="-mx-1 pb-1.5">
              {rows.map((r) => {
                const active = selectedId ? r.id === selectedId : r.end === selectedEnd;
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => pickPeriod(r.id)}
                      className={`
                        flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left
                        transition-colors duration-micro
                        ${active ? "text-ink" : "text-ink-soft hover:bg-bg-2 hover:text-ink"}
                      `}
                    >
                      <span className="font-mono text-[11.5px] uppercase tracking-[0.08em] tabular-nums">
                        {r.label}
                      </span>
                      {active && <Check size={13} strokeWidth={2} className="text-brand-dark" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Workspaces */}
        {workspaces.length > 0 && (
          <div className="border-b border-rule-soft px-3 pb-1.5 pt-2.5">
            <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.14em] text-ink-mute">
              {t("shell.context.workspaces")}
            </div>
            <ul className="-mx-1">
              {workspaces.slice(0, 6).map((w) => {
                const active = w.id === currentId;
                return (
                  <li key={w.id}>
                    <button
                      type="button"
                      onClick={() => pickWorkspace(w.id)}
                      className={`
                        flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-[12.5px]
                        transition-colors duration-micro
                        ${active ? "text-ink font-medium" : "text-ink-soft hover:bg-bg-2 hover:text-ink"}
                      `}
                    >
                      <span className="truncate">{w.name}</span>
                      {active && <Check size={13} strokeWidth={2} className="shrink-0 text-brand-dark" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* Upload entry — the one way to grow the period list from here. */}
        <div className="px-3 py-1.5">
          <button
            type="button"
            onClick={goUpload}
            data-testid="context-object-upload"
            className="-mx-1 flex w-[calc(100%+8px)] items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12.5px] text-ink-soft transition-colors duration-micro hover:bg-bg-2 hover:text-ink"
          >
            <Upload size={13} strokeWidth={1.75} className="text-brand-dark" />
            {t("shell.context.upload")}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
