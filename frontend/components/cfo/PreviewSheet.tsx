// PreviewSheet — the in-app surface for generated preview documents inside
// the native mobile shell (see lib/previewSheet.ts for why the shell cannot
// use a second tab). Mounted once by AppShell; renders nothing until a
// preview is opened.
//
// Header: the file/template title plus "Back to <tab>", naming the route the
// sheet was opened from. Inside the shell the floating NATIVE button (top-
// left, 44px at 12px inset) turns into a back chevron while a sheet is open,
// so the header leaves that corner clear and carries no second button; in a
// browser (not the normal path — browsers open a tab) it renders its own.

import { useEffect, useRef, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft } from "lucide-react";
import {
  closePreviewSheet,
  getPreviewSheet,
  subscribePreviewSheet,
} from "@/lib/previewSheet";
import { isNativeShell } from "@/lib/nativeShell";
import { SHELL_NAV_ALL } from "./Sidebar";

const getServerSnapshot = () => null;

function originLabel(fromPath: string, t: (k: string) => string): string | null {
  const path = fromPath.split("?")[0];
  let best: { to: string; labelKey: string } | null = null;
  for (const item of SHELL_NAV_ALL) {
    const hit = path === item.to || path.startsWith(item.to.replace(/\/$/, "") + "/");
    if (hit && (!best || item.to.length > best.to.length)) best = item;
  }
  return best ? t(best.labelKey) : null;
}

export function PreviewSheet() {
  const sheet = useSyncExternalStore(subscribePreviewSheet, getPreviewSheet, getServerSnapshot);
  const { t } = useTranslation();
  if (!sheet) return null;
  const inShell = isNativeShell();
  const origin = originLabel(sheet.fromPath, t);
  const backLabel = origin
    ? t("sidebar.previewBackTo", { tab: origin })
    : t("sidebar.previewBack");

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={sheet.title}
      data-testid="preview-sheet"
      className="fixed inset-0 z-50 flex flex-col bg-bg text-ink"
    >
      <header
        className={`flex items-center gap-3 h-14 shrink-0 border-b border-rule ${
          inShell ? "pl-[68px] pr-3" : "px-3"
        }`}
      >
        {!inShell && (
          <button
            type="button"
            onClick={closePreviewSheet}
            data-testid="preview-sheet-back"
            className="inline-flex items-center gap-1 h-9 pl-1.5 pr-3 rounded-md text-[13px] font-medium text-ink hover:bg-bg-2 transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronLeft size={16} strokeWidth={2} />
            {backLabel}
          </button>
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium truncate">{sheet.title}</div>
          {inShell && (
            <div className="text-[11px] text-ink-soft truncate" data-testid="preview-sheet-origin">
              {backLabel}
            </div>
          )}
        </div>
      </header>
      {sheet.html !== null ? (
        <ShadowDocument html={sheet.html} />
      ) : sheet.url !== null ? (
        <iframe title={sheet.title} src={sheet.url} className="flex-1 w-full border-0 bg-paper" />
      ) : (
        <div className="flex-1 flex items-center justify-center text-[13px] text-ink-soft">…</div>
      )}
    </div>
  );
}


// Renders a generated HTML DOCUMENT inline, inside a Shadow DOM, in a normal
// scrolling container. Not an <iframe>: WKWebView (the iOS shell) sizes
// iframes to their content and never scrolls inside them, and a sandboxed
// srcdoc frame rendered as an empty sheet on device (2026-09-08 per
// operator) — while the very same markup rendered fine in Chrome. Shadow DOM
// keeps the document's own <style> rules from leaking into the app and the
// app's from leaking in. The documents are app-generated (SheetJS tables,
// escaped values, no scripts); scripts are stripped anyway.
function ShadowDocument({ html }: { html: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script").forEach((el) => el.remove());
    // The documents style `body`/`:root`; inside a shadow root those select
    // nothing, so retarget them at the wrapper.
    const styles = Array.from(doc.querySelectorAll("style"))
      .map((el) =>
        el.textContent
          ?.replace(/(^|[\s,}])body(?=[\s{,.:[])/g, "$1.cfo-preview-body")
          .replace(/:root\b/g, ":host") ?? "",
      )
      .join("\n");
    const bodyStyle = doc.body?.getAttribute("style") ?? "";
    root.innerHTML =
      `<style>:host{display:block;min-height:100%}.cfo-preview-body{box-sizing:border-box;min-height:100%}\n${styles}</style>` +
      `<div class="cfo-preview-body" style="${bodyStyle.replace(/"/g, "&quot;")}">${doc.body?.innerHTML ?? ""}</div>`;
  }, [html]);
  return (
    <div
      ref={hostRef}
      data-testid="preview-sheet-document"
      className="flex-1 min-h-0 w-full overflow-auto overscroll-contain bg-paper"
      style={{ WebkitOverflowScrolling: "touch" }}
    />
  );
}
