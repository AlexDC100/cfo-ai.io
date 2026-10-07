// The upload portal — "From phone" in every upload section of the web app on
// a PC. Ported from DocVex's Import window (components/PhoneUploadModal).
//
//   <PhoneUploadButton surface="products" onFiles={stageFile} single />
//
// opens a window with a QR code the phone scans, by one of two routes (a
// segmented switch):
//
//   CFO AI cloud   lib/phoneUpload/cloud — any connection; the phone encrypts
//                  every file with a key that exists only in the QR code.
//   Local network  lib/phoneUpload/local — the CFO AI engine on this
//                  computer serves the page and takes the files; only when the
//                  engine runs locally (PHONE_UPLOAD_LOCAL=1).
//
// What the phone sends WAITS in the window, ticked. "Import" hands the ticked
// files to the section's own `onFiles` — exactly what its file picker would
// have done, so every section keeps its own handling (the workspace's
// identify → confirm card, Products' sales file, the budget card, the chat
// attach) — and tells the phone which were imported and which left out.
// Closing with files still waiting asks first, then rejects them.
//
// This module builds NO file input and NO drop target (gate G5,
// components/cfo/upload/__tests__/oneUploadComponent.test.ts): the phone's
// picker is on the phone page (public/phone-upload.html).
//
// Shown on PCs only: a fine pointer, and never inside the native shell — a
// phone does not scan its own screen.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, FileText, Loader2, RefreshCw, Smartphone } from "lucide-react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { isNativeShell } from "@/lib/nativeShell";
import { currentOrgId } from "@/lib/supabase";
import { decideCloud, startCloudPortal, stopCloudPortal, watchCloudPortal, type CloudPortal } from "@/lib/phoneUpload/cloud";
import { decideLocal, startLocalPortal, stopLocalPortal, watchLocalPortal, type LocalPortal } from "@/lib/phoneUpload/local";
import type { Arrival, PortalError, PortalRoute, PortalSurface } from "@/lib/phoneUpload/types";

// ── Where it shows ─────────────────────────────────────────────────────

/** True on a PC: a fine pointer (mouse / trackpad), not the native app. */
export function isPortalHost(): boolean {
  if (typeof window === "undefined") return false;
  if (isNativeShell()) return false;
  try {
    return window.matchMedia("(pointer: fine)").matches;
  } catch {
    return true;
  }
}

// ── The QR code ────────────────────────────────────────────────────────

function Qr({ value }: { value: string }) {
  const [svg, setSvg] = useState("");
  useEffect(() => {
    let cancelled = false;
    if (!value) {
      setSvg("");
      return undefined;
    }
    import("qrcode")
      .then((mod) => {
        const QR = (mod as unknown as { default?: typeof mod }).default ?? mod;
        // Dark on white whatever the theme: phones read a light ground best.
        return QR.toString(value, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#111111", light: "#ffffff" } });
      })
      .then((s) => {
        if (!cancelled) setSvg(s);
      })
      .catch(() => {
        if (!cancelled) setSvg("");
      });
    return () => {
      cancelled = true;
    };
  }, [value]);
  return (
    <div
      data-testid="phone-portal-qr"
      aria-label="QR code"
      role="img"
      className="h-[200px] w-[200px] overflow-hidden rounded-md border border-rule bg-white p-1 [&_svg]:h-full [&_svg]:w-full"
      // The SVG is produced by the qrcode library from our own URL.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

const fmtBytes = (n: number) => {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1048576) return `${Math.round(v / 1024)} KB`;
  return `${(v / 1048576).toFixed(1)} MB`;
};

type RouteState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "error"; error: string }
  | { phase: "ready"; portal: CloudPortal | LocalPortal };

// ── The window ─────────────────────────────────────────────────────────

export interface PhoneUploadPortalProps {
  open: boolean;
  onClose: () => void;
  surface: PortalSurface;
  /** The section's own file handler — what its picker calls. */
  onFiles: (files: File[]) => void;
  accept?: string;
  /** The section takes one file. */
  single?: boolean;
}

export function PhoneUploadPortal({ open, onClose, surface, onFiles, accept, single }: PhoneUploadPortalProps) {
  const { t } = useTranslation();
  const [route, setRoute] = useState<PortalRoute>("cloud");
  const [cloud, setCloud] = useState<RouteState>({ phase: "idle" });
  const [local, setLocal] = useState<RouteState>({ phase: "idle" });
  const [arrivals, setArrivals] = useState<Arrival[]>([]);
  const [leftOut, setLeftOut] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const stops = useRef<{ cloud?: () => void; local?: () => void }>({});
  const sessions = useRef<{ cloud?: string; local?: string }>({});

  const sink = useCallback((a: Arrival) => {
    setArrivals((list) => {
      const i = list.findIndex((x) => x.key === a.key);
      if (i === -1) return [a, ...list];
      const next = [...list];
      next[i] = { ...next[i], ...a };
      return next;
    });
  }, []);

  const startCloud = useCallback(
    async (fresh = false) => {
      stops.current.cloud?.();
      setCloud({ phase: "loading" });
      const orgId = await currentOrgId().catch(() => null);
      const res = await startCloudPortal({ surface, orgId, fresh, accept, single });
      if (!res.ok) {
        setCloud({ phase: "error", error: (res as PortalError).error });
        return;
      }
      sessions.current.cloud = res.sessionId;
      stops.current.cloud = watchCloudPortal(res, sink);
      setCloud({ phase: "ready", portal: res });
    },
    [surface, accept, single, sink],
  );

  const startLocal = useCallback(
    async (fresh = false) => {
      stops.current.local?.();
      setLocal({ phase: "loading" });
      const res = await startLocalPortal({ surface, fresh, accept, single });
      if (!res.ok) {
        setLocal({ phase: "error", error: (res as PortalError).error });
        return;
      }
      sessions.current.local = res.sessionId;
      stops.current.local = watchLocalPortal(res.sessionId, sink);
      setLocal({ phase: "ready", portal: res });
    },
    [surface, accept, single, sink],
  );

  // Open → start both routes (each keeps its own address); close → pause.
  useEffect(() => {
    if (!open) return undefined;
    setArrivals([]);
    setLeftOut(new Set());
    void startCloud();
    void startLocal();
    return () => {
      stops.current.cloud?.();
      stops.current.local?.();
      stops.current = {};
      if (sessions.current.cloud) void stopCloudPortal(sessions.current.cloud);
      if (sessions.current.local) void stopLocalPortal(sessions.current.local);
      sessions.current = {};
      setCloud({ phase: "idle" });
      setLocal({ phase: "idle" });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const waiting = useMemo(() => arrivals.filter((a) => a.state === "waiting" && a.file), [arrivals]);
  const ticked = useMemo(() => waiting.filter((a) => !leftOut.has(a.key)), [waiting, leftOut]);

  const decide = useCallback((a: Arrival, status: "accepted" | "rejected") => {
    if (a.route === "cloud") return decideCloud(a.id, status);
    const sid = sessions.current.local;
    return sid ? decideLocal(sid, a.id, status) : Promise.resolve();
  }, []);

  const importTicked = () => {
    const take = single ? ticked.slice(0, 1) : ticked;
    const takenKeys = new Set(take.map((a) => a.key));
    if (take.length) onFiles(take.map((a) => a.file!));
    for (const a of waiting) void decide(a, takenKeys.has(a.key) ? "accepted" : "rejected");
    setArrivals([]);
    onClose();
  };

  const requestClose = () => {
    if (waiting.length) setConfirming(true);
    else onClose();
  };
  const discardAndClose = () => {
    for (const a of waiting) void decide(a, "rejected");
    setConfirming(false);
    setArrivals([]);
    onClose();
  };

  const toggle = (a: Arrival) =>
    setLeftOut((s) => {
      const next = new Set(s);
      if (next.has(a.key)) next.delete(a.key);
      else next.add(a.key);
      return next;
    });

  const state = route === "cloud" ? cloud : local;
  const section = t(`phoneUpload.sections.${surface}`);
  const errorText = (code: string) => t(`phoneUpload.errors.${code}`, { defaultValue: t("phoneUpload.errors.failed") });

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? requestClose() : undefined)}>
      <DialogContent className="max-w-[640px]" data-testid="phone-portal">
        <DialogHeader>
          <DialogTitle>{t("phoneUpload.title")}</DialogTitle>
          <DialogDescription>{t("phoneUpload.intro", { section })}</DialogDescription>
        </DialogHeader>

        {/* The route switch */}
        <div role="radiogroup" aria-label={t("phoneUpload.routeLabel")} className="inline-flex w-full rounded-md border border-rule p-0.5">
          {(["cloud", "local"] as const).map((r) => (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={route === r}
              data-testid={`phone-portal-route-${r}`}
              onClick={() => setRoute(r)}
              className={cn(
                "flex-1 rounded-sm px-3 py-1.5 text-left transition-colors duration-micro",
                route === r ? "bg-brand-tint text-ink" : "text-ink-soft hover:bg-bg-2",
              )}
            >
              <span className="block text-[13px] font-medium">{t(r === "cloud" ? "phoneUpload.routeCloud" : "phoneUpload.routeLocal")}</span>
              <span className="block text-[11px] text-ink-mute">{t(r === "cloud" ? "phoneUpload.routeCloudHint" : "phoneUpload.routeLocalHint")}</span>
            </button>
          ))}
        </div>

        {/* The code and what it does */}
        <section className="flex flex-col gap-4 sm:flex-row">
          <div className="grid h-[200px] w-[200px] shrink-0 place-items-center self-center">
            {state.phase === "ready" ? (
              <Qr value={state.portal.url} />
            ) : state.phase === "error" ? (
              <span className="px-3 text-center text-[12.5px] text-ink-soft" data-testid="phone-portal-error">
                {errorText(state.error)}
              </span>
            ) : (
              <span className="flex items-center gap-2 text-[12.5px] text-ink-soft">
                <Loader2 size={14} className="animate-spin" aria-hidden />
                {t("phoneUpload.preparing")}
              </span>
            )}
          </div>
          <div className="min-w-0 flex-1 space-y-2 text-[12.5px] text-ink-soft">
            <ul className="list-disc space-y-1 pl-4">
              <li>{t(route === "cloud" ? "phoneUpload.pointCloud1" : "phoneUpload.pointLocal1")}</li>
              <li>{t(route === "cloud" ? "phoneUpload.pointCloud2" : "phoneUpload.pointLocal2")}</li>
            </ul>
            {state.phase === "ready" && (
              <p>
                {t("phoneUpload.sameAddress")}{" "}
                <button
                  type="button"
                  title={t("phoneUpload.newAddressTip")}
                  onClick={() => void (route === "cloud" ? startCloud(true) : startLocal(true))}
                  className="inline-flex items-center gap-1 font-medium text-brand-dark underline-offset-2 hover:underline dark:text-brand-light"
                >
                  <RefreshCw size={11} aria-hidden />
                  {t("phoneUpload.newAddress")}
                </button>
              </p>
            )}
            {state.phase === "ready" && route === "local" && "urls" in state.portal && (
              <>
                <p className="break-all font-mono text-[11px] text-ink-mute">{state.portal.urls[0]}</p>
                {state.portal.urls.length > 1 && (
                  <details className="text-[11px]">
                    <summary className="cursor-pointer">{t("phoneUpload.otherAddresses")}</summary>
                    <ul className="mt-1 space-y-0.5 font-mono text-ink-mute">
                      {state.portal.urls.slice(1).map((u) => (
                        <li key={u} className="break-all">{u}</li>
                      ))}
                    </ul>
                  </details>
                )}
                {state.portal.inContainer && <p className="text-[11.5px] text-caution">{t("phoneUpload.containerHint")}</p>}
              </>
            )}
            {state.phase === "error" && (
              <button
                type="button"
                onClick={() => void (route === "cloud" ? startCloud() : startLocal())}
                className="inline-flex h-8 items-center rounded-sm border border-rule px-3 text-[12.5px] font-medium text-ink hover:bg-bg-2"
              >
                {t("phoneUpload.tryAgain")}
              </button>
            )}
          </div>
        </section>

        {/* What arrived */}
        <section aria-live="polite" className="border-t border-rule pt-3">
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <h3 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-soft">{t("phoneUpload.received")}</h3>
            {waiting.length > 0 && <span className="text-[11px] text-ink-mute">{t("phoneUpload.tickHint")}</span>}
          </div>
          {arrivals.length === 0 ? (
            <p className="text-[12.5px] text-ink-mute">{t("phoneUpload.receivedEmpty")}</p>
          ) : (
            <ul className="max-h-[220px] space-y-1 overflow-y-auto" data-testid="phone-portal-arrivals">
              {arrivals.map((a) => {
                const on = a.state === "waiting" && !leftOut.has(a.key);
                return (
                  <li key={a.key}>
                    <button
                      type="button"
                      disabled={a.state !== "waiting"}
                      onClick={() => toggle(a)}
                      aria-pressed={a.state === "waiting" ? on : undefined}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-sm px-2 py-1.5 text-left transition-colors duration-micro",
                        a.state === "waiting" && "hover:bg-bg-2",
                        a.state === "waiting" && !on && "opacity-50",
                      )}
                    >
                      <span
                        className={cn(
                          "grid h-5 w-5 shrink-0 place-items-center rounded-full border",
                          on ? "border-brand bg-brand text-paper" : "border-rule-strong",
                        )}
                        aria-hidden
                      >
                        {on && <Check size={12} strokeWidth={3} />}
                        {a.state === "taking" && <Loader2 size={11} className="animate-spin text-ink-soft" />}
                      </span>
                      <FileText size={15} className="shrink-0 text-ink-soft" aria-hidden />
                      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{a.name}</span>
                      <span className={cn("shrink-0 text-[11.5px] tabular-nums", a.state === "error" ? "text-alert" : "text-ink-mute")}>
                        {a.state === "error"
                          ? errorText(a.error || "failed")
                          : a.state === "taking"
                            ? t("phoneUpload.taking")
                            : fmtBytes(a.size)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <footer className="flex flex-wrap items-center justify-end gap-3 border-t border-rule pt-3">
          {single && ticked.length > 1 && <span className="mr-auto text-[11.5px] text-ink-mute">{t("phoneUpload.singleNote")}</span>}
          {!single && waiting.length > ticked.length && (
            <span className="mr-auto text-[11.5px] text-ink-mute">
              {t("phoneUpload.leftOut", { count: waiting.length - ticked.length })}
            </span>
          )}
          <button
            type="button"
            data-testid="phone-portal-import"
            disabled={ticked.length === 0}
            onClick={importTicked}
            className="inline-flex h-9 items-center justify-center rounded-sm bg-brand px-4 text-[13px] font-medium text-paper transition-colors duration-micro hover:bg-brand-dark disabled:opacity-50"
          >
            {ticked.length ? t("phoneUpload.import", { count: single ? 1 : ticked.length }) : t("phoneUpload.importNone")}
          </button>
        </footer>

        {confirming && (
          <div role="alertdialog" aria-modal="true" className="absolute inset-0 grid place-items-center rounded-lg bg-bg/80 p-6 backdrop-blur-[2px]">
            <div className="max-w-[360px] rounded-md border border-rule bg-surface p-5 text-center shadow-lg">
              <p className="text-[15px] font-semibold text-ink">{t("phoneUpload.discardTitle")}</p>
              <p className="mt-1.5 text-[12.5px] text-ink-soft">{t("phoneUpload.discardBody")}</p>
              <div className="mt-4 flex justify-center gap-2">
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="inline-flex h-9 items-center rounded-sm border border-rule px-4 text-[13px] font-medium text-ink hover:bg-bg-2"
                >
                  {t("phoneUpload.keep")}
                </button>
                <button
                  type="button"
                  onClick={discardAndClose}
                  className="inline-flex h-9 items-center rounded-sm bg-alert px-4 text-[13px] font-medium text-paper hover:opacity-90"
                >
                  {t("phoneUpload.discard")}
                </button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── The button every upload section carries ────────────────────────────

export interface PhoneUploadButtonProps extends Omit<PhoneUploadPortalProps, "open" | "onClose"> {
  /** "button" (icon + label) or "icon" (a small square, for tight spots). */
  variant?: "button" | "icon";
  disabled?: boolean;
  className?: string;
}

export function PhoneUploadButton({ variant = "button", disabled, className, ...portal }: PhoneUploadButtonProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [host] = useState(isPortalHost);
  if (!host) return null;
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        data-testid={`phone-upload-button-${portal.surface}`}
        title={t("phoneUpload.buttonTip")}
        aria-label={variant === "icon" ? t("phoneUpload.buttonTip") : undefined}
        onClick={(e) => {
          // Inside a clickable tile, the click must not also open the picker.
          e.stopPropagation();
          setOpen(true);
        }}
        onKeyDown={(e) => e.stopPropagation()}
        className={cn(
          variant === "icon"
            ? "inline-grid h-8 w-8 place-items-center rounded-sm text-ink-soft hover:bg-bg-2 hover:text-ink"
            : "inline-flex h-9 items-center justify-center gap-1.5 rounded-sm border border-rule bg-transparent px-3 text-[13px] font-medium text-ink transition-colors duration-micro hover:bg-bg-2",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
          className,
        )}
      >
        <Smartphone size={variant === "icon" ? 16 : 14} strokeWidth={1.75} aria-hidden />
        {variant === "button" && t("phoneUpload.button")}
      </button>
      {open && (
        <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} className="contents">
          <PhoneUploadPortal {...portal} open={open} onClose={() => setOpen(false)} />
        </span>
      )}
    </>
  );
}
