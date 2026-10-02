// AutoMasters — the CFO side of the AutoMasters dealership app, as a custom
// solution inside CFO AI (route /solutions/automasters/:section).
//
// The AutoMasters desktop app runs the dealership (sales, stock, service,
// workshop, parts); its Finance and Management screens live here:
//
//   Management · Performance · Profit centres · Ask CFO AI
//   Finance    · Payments · SAGA & e-Factura · Month close
//
// Shown only to accounts an operator linked to `automasters` on the Admin
// page, for the workspace (company) that is active. Data comes from the
// am_* tables — written by the desktop app, or by "Import data" with an
// `automasters.cfo.v1` JSON export until that link is wired.

import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { NavLink, Navigate, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { FileJson, Upload } from "lucide-react";
import { PageHeader } from "@/components/cfo/ui/PageHeader";
import { RouteFallback } from "@/components/cfo/RouteFallback";
import { FilePickerInput } from "@/components/cfo/upload/UploadDrop";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useMySolutions } from "@/lib/customSolutions";
import { useActiveOrg } from "@/lib/org";
import { useActiveLocale } from "@/lib/locale";
import { cn } from "@/lib/utils";
import { importAmData, useAmData, useAmRefresh } from "@/lib/automasters/data";
import {
  EMPTY_DATA,
  IMPORT_FORMAT,
  knownPeriods,
  parseImport,
  periodOf,
  type ImportPayload,
} from "@/lib/automasters/model";
import { AskView, PerformanceView, ProfitCentresView } from "./ManagementViews";
import { CloseView, ExportsView, PaymentsView } from "./FinanceViews";
import { Card, Empty } from "./ui";
import "./amI18n";

const AM_SECTIONS = [
  { id: "performance", group: "management" },
  { id: "profit-centres", group: "management" },
  { id: "ask", group: "management" },
  { id: "payments", group: "finance" },
  { id: "exports", group: "finance" },
  { id: "close", group: "finance" },
] as const;

type SectionId = (typeof AM_SECTIONS)[number]["id"];
const BASE = "/solutions/automasters";

export default function AutoMasters() {
  const { t } = useTranslation();
  const { section } = useParams<{ section?: string }>();
  const navigate = useNavigate();
  const { has, loading: grantsLoading } = useMySolutions();
  const { org, loading: orgLoading } = useActiveOrg();
  const orgId = org?.id ?? null;
  const allowed = has("automasters");
  const q = useAmData(orgId, allowed);
  const refresh = useAmRefresh(orgId);
  const data = q.data ?? EMPTY_DATA;

  const periods = useMemo(() => knownPeriods(data), [data]);
  // The chosen month rides in ?month= so it survives switching sections
  // (the app shell remounts the page per path). Not ?period= — that is the
  // analysis period id every other CFO AI page reads.
  const [params, setParams] = useSearchParams();
  const periodPick = params.get("month");
  const period = periodPick && periods.includes(periodPick) ? periodPick : periods[0] ?? periodOf(new Date());
  const setPeriodPick = (p: string) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    next.set("month", p);
    return next;
  }, { replace: true });
  const monthQuery = periodPick ? `?month=${encodeURIComponent(periodPick)}` : "";
  const [importOpen, setImportOpen] = useState(false);
  // A question handed to Ask CFO AI from another screen travels in the
  // router state: the app shell remounts the page on every path change.
  const location = useLocation();
  const askQuestion = (location.state as { ask?: string } | null)?.ask ?? null;
  const consumeAsk = useCallback(
    () => navigate(location.pathname + location.search, { replace: true, state: null }),
    [navigate, location.pathname, location.search],
  );

  if (grantsLoading || orgLoading) return <RouteFallback />;
  if (!allowed) {
    return (
      <div className="mx-auto max-w-[720px] py-16">
        <Card>
          <Empty title={t("am.noAccess.title")} body={t("am.noAccess.body")} />
        </Card>
      </div>
    );
  }
  const current = AM_SECTIONS.find((s) => s.id === section);
  if (!current) return <Navigate to={`${BASE}/performance${monthQuery}`} replace />;
  const id = current.id as SectionId;

  const openImport = () => setImportOpen(true);
  const ask = (question: string) => navigate(`${BASE}/ask${monthQuery}`, { state: { ask: question } });
  const usesPeriod = id === "performance" || id === "profit-centres" || id === "close";

  return (
    <div className="space-y-6 pb-16" data-testid="automasters-page">
      <PageHeader
        eyebrow={t("am.eyebrow")}
        title={t(`am.section.${id}`)}
        subtitle={org ? t("am.subtitle", { company: org.name }) : undefined}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {usesPeriod && (
              <PeriodPicker periods={periods.length ? periods : [period]} value={period} onChange={setPeriodPick} />
            )}
            <Button variant="secondary" onClick={openImport}>
              <Upload /> {t("am.import.open")}
            </Button>
          </div>
        }
      />

      <nav aria-label="AutoMasters" className="flex flex-wrap gap-x-6 gap-y-2 border-b border-rule">
        {(["management", "finance"] as const).map((g) => (
          <div key={g} className="flex items-center gap-1">
            <span className="mr-1 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-soft">{t(`am.group.${g}`)}</span>
            {AM_SECTIONS.filter((s) => s.group === g).map((s) => (
              <NavLink key={s.id} to={`${BASE}/${s.id}${monthQuery}`}
                className={({ isActive }) => cn(
                  "-mb-px inline-flex h-10 items-center border-b-2 px-2.5 text-[13px] font-semibold",
                  isActive ? "border-brand text-ink" : "border-transparent text-ink-soft hover:text-ink",
                )}>
                {t(`am.section.${s.id}`)}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      {!orgId ? (
        <Card><Empty title={t("am.noWorkspace")} /></Card>
      ) : q.isError ? (
        <Card>
          <Empty title={t("am.loadError")} body={(q.error as Error)?.message}
            action={<Button variant="secondary" onClick={() => q.refetch()}>{t("am.retry")}</Button>} />
        </Card>
      ) : q.isLoading ? (
        <RouteFallback />
      ) : id === "performance" ? (
        <PerformanceView data={data} period={period} onImport={openImport} />
      ) : id === "profit-centres" ? (
        <ProfitCentresView data={data} period={period} onImport={openImport} onAsk={ask} />
      ) : id === "ask" ? (
        <AskView data={data} companyName={org?.name ?? null} initialQuestion={askQuestion} onConsumeInitial={consumeAsk} />
      ) : id === "payments" ? (
        <PaymentsView data={data} orgId={orgId} refresh={refresh} onImport={openImport} />
      ) : id === "exports" ? (
        <ExportsView data={data} refresh={refresh} onImport={openImport} />
      ) : (
        <CloseView data={data} orgId={orgId} period={period} refresh={refresh} />
      )}

      {orgId && (
        <ImportDialog open={importOpen} onOpenChange={setImportOpen} orgId={orgId}
          onDone={() => { setImportOpen(false); refresh(); }} />
      )}
    </div>
  );
}

function PeriodPicker({ periods, value, onChange }: { periods: string[]; value: string; onChange: (p: string) => void }) {
  const { t } = useTranslation();
  const locale = useActiveLocale();
  const label = (p: string) => {
    const [y, m] = p.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(locale, { month: "long", year: "numeric", timeZone: "UTC" });
  };
  return (
    <label className="inline-flex items-center gap-2 text-[12.5px] text-ink-soft">
      {t("am.period")}
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className="h-9 rounded-sm border border-rule bg-surface px-2 text-[13px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {periods.map((p) => <option key={p} value={p}>{label(p)}</option>)}
      </select>
    </label>
  );
}

function ImportDialog({ open, onOpenChange, orgId, onDone }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  orgId: string;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const fileRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<{ payload: ImportPayload; counts: Record<string, number>; name: string } | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const reset = () => { setParsed(null); setErrors([]); };

  const onFile = async (file: File | undefined) => {
    reset();
    if (!file) return;
    let raw: unknown;
    try {
      raw = JSON.parse(await file.text());
    } catch {
      setErrors([t("am.import.notJson")]);
      return;
    }
    const r = parseImport(raw);
    // `in` narrows the union; `r.ok` does not with strictNullChecks off.
    if ("errors" in r) setErrors(r.errors);
    else setParsed({ payload: r.payload, counts: r.counts, name: file.name });
  };

  const save = async () => {
    if (!parsed) return;
    setSaving(true);
    try {
      await importAmData(orgId, parsed.payload);
      toast.success(t("am.import.done"));
      reset();
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{t("am.import.title")}</DialogTitle>
          <DialogDescription>{t("am.import.body", { format: IMPORT_FORMAT })}</DialogDescription>
        </DialogHeader>
        <FilePickerInput ref={fileRef} accept="application/json,.json"
          onFiles={(files) => void onFile(files[0])} />
        <div className="flex items-center gap-3">
          <Button variant="secondary" onClick={() => fileRef.current?.click()}>
            <FileJson /> {t("am.import.choose")}
          </Button>
          <span className="truncate text-[13px] text-ink-soft">{parsed?.name ?? t("am.import.noFile")}</span>
        </div>
        {parsed && (
          <div className="rounded-sm border border-rule bg-bg-2 px-3 py-2 text-[13px]">
            <p className="font-semibold text-ink">{parsed.name}</p>
            <ul className="mt-1 grid grid-cols-2 gap-x-4 text-ink-soft">
              {Object.entries(parsed.counts).map(([k, v]) => (
                <li key={k}>{t(`am.import.count.${k}`)}: <span className="font-mono text-ink">{v}</span></li>
              ))}
            </ul>
            <p className="mt-2 text-[12px] text-ink-soft">{t("am.import.upsertNote")}</p>
          </div>
        )}
        {errors.length > 0 && (
          <div role="alert" className="max-h-[200px] overflow-y-auto rounded-sm bg-alert-tint px-3 py-2 text-[12.5px] text-alert">
            <p className="font-semibold">{t("am.import.refused")}</p>
            <ul className="mt-1 list-disc pl-4">{errors.slice(0, 30).map((e, i) => <li key={i}>{e}</li>)}</ul>
          </div>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>{t("am.cancel")}</Button>
          <Button disabled={!parsed || saving} onClick={save}>{t("am.import.save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
