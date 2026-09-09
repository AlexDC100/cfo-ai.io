// Report a problem (2026-09-10 per operator): a message plus optional
// screenshots / files, mailed to the reports inbox (SITE.reportsEmail)
// through the engine (`POST /api/report` → Resend). Reached from the
// sidebar's "Report a problem" row.

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Paperclip, Send, X } from "lucide-react";
import { cfoApi } from "@/lib/cfoApi";
import { useAuth } from "@/lib/auth";
import { isNativeShell } from "@/lib/nativeShell";
import { SITE } from "@/config/site";

const MAX_FILES = 5;
const MAX_TOTAL = 12 * 1024 * 1024;

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function ReportProblem() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const total = files.reduce((n, f) => n + f.size, 0);
  const canSend = message.trim().length > 0 && state !== "sending" && total <= MAX_TOTAL && files.length <= MAX_FILES;

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    setError(null);
    setFiles((cur) => {
      const next = [...cur, ...Array.from(list)].slice(0, MAX_FILES);
      if (cur.length + list.length > MAX_FILES) setError(t("reportX.tooMany", { n: MAX_FILES }));
      if (next.reduce((n, f) => n + f.size, 0) > MAX_TOTAL) setError(t("reportX.tooLarge"));
      return next;
    });
  };

  const send = async () => {
    if (!canSend) return;
    setState("sending");
    setError(null);
    try {
      const encoded = await Promise.all(files.map(async (f) => ({ name: f.name, type: f.type || "application/octet-stream", content: await readBase64(f) })));
      await cfoApi.sendReport({
        message: message.trim(),
        email: user?.email ?? (email.trim() || undefined),
        page: window.location.pathname,
        platform: isNativeShell() ? "ios-shell" : "web",
        files: encoded,
      });
      setState("sent");
      setMessage("");
      setFiles([]);
    } catch (e) {
      setState("failed");
      setError(e instanceof Error && e.message ? e.message : t("reportX.failed", { email: SITE.reportsEmail }));
    }
  };

  return (
    <div className="mx-auto w-full max-w-[640px] px-4 sm:px-6 pt-6 pb-10" data-testid="report-problem">
      <h1 className="text-[20px] font-semibold text-ink">{t("reportX.title")}</h1>
      <p className="mt-1 text-[13px] text-ink-soft">{t("reportX.intro")}</p>

      {state === "sent" ? (
        <div className="mt-6 rounded-xl border border-rule bg-surface px-4 py-4" data-testid="report-sent">
          <p className="text-[14px] font-medium text-ink">{t("reportX.sent")}</p>
          <p className="mt-1 text-[13px] text-ink-soft">{t("reportX.sentBody", { email: SITE.reportsEmail })}</p>
          <button type="button" onClick={() => setState("idle")} className="mt-3 text-[13px] text-brand-dark dark:text-brand-light underline underline-offset-2">
            {t("reportX.another")}
          </button>
        </div>
      ) : (
        <form
          className="mt-5 space-y-4"
          onSubmit={(e) => { e.preventDefault(); void send(); }}
        >
          <label className="block">
            <span className="sr-only">{t("reportX.messageLabel")}</span>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={t("reportX.placeholder")}
              rows={7}
              maxLength={8000}
              data-testid="report-message"
              className="w-full resize-y rounded-xl border border-rule bg-surface px-4 py-3 text-[14px] leading-relaxed text-ink placeholder:text-ink-mute outline-none focus:border-brand"
            />
          </label>

          {!user && (
            <label className="block">
              <span className="text-[12px] text-ink-soft">{t("reportX.emailLabel")}</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t("reportX.emailPlaceholder")}
                data-testid="report-email"
                className="mt-1 w-full rounded-xl border border-rule bg-surface px-4 py-2.5 text-[14px] text-ink placeholder:text-ink-mute outline-none focus:border-brand"
              />
            </label>
          )}

          {files.length > 0 && (
            <ul className="flex flex-wrap gap-2" data-testid="report-files">
              {files.map((f, i) => (
                <li key={`${f.name}-${i}`} className="inline-flex items-center gap-2 rounded-full border border-rule bg-surface pl-3 pr-1.5 py-1 text-[12px] text-ink">
                  <span className="max-w-[180px] truncate">{f.name}</span>
                  <span className="text-ink-mute">{fmtSize(f.size)}</span>
                  <button type="button" aria-label={t("reportX.remove")} onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))} className="grid h-5 w-5 place-items-center rounded-full text-ink-soft hover:text-ink hover:bg-bg-2">
                    <X size={12} strokeWidth={2} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {error && <p className="text-[12.5px] text-red-600" data-testid="report-error">{error}</p>}

          <div className="flex items-center gap-3">
            <input
              ref={inputRef}
              type="file"
              multiple
              accept="image/*,.pdf,.xlsx,.xls,.csv,.txt,.log,.json"
              className="hidden"
              onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }}
              data-testid="report-file-input"
            />
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={files.length >= MAX_FILES}
              data-testid="report-attach"
              className="inline-flex items-center gap-2 rounded-full border border-rule bg-surface px-3.5 py-2 text-[13px] text-ink hover:bg-bg-2 disabled:opacity-40 transition-colors duration-micro"
            >
              <Paperclip size={15} strokeWidth={1.75} />
              {t("reportX.attach")}
            </button>
            <span className="text-[11.5px] text-ink-mute">{t("reportX.attachHint")}</span>
            <button
              type="submit"
              disabled={!canSend}
              data-testid="report-send"
              className="ml-auto inline-flex items-center gap-2 rounded-full bg-brand px-4 py-2 text-[13px] font-semibold text-paper hover:bg-brand-dark disabled:opacity-40 transition-colors duration-micro"
            >
              <Send size={14} strokeWidth={2} />
              {state === "sending" ? t("reportX.sending") : t("reportX.send")}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
