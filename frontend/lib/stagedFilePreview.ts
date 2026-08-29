// Open a file as a PREVIEW in a new browser tab.
//
// Two entry points:
//   · openStagedFile(file)          — a local (not-yet-uploaded) File from a
//                                     dropzone's staged list.
//   · openUploadedFilePreview(...)  — an already-uploaded document; fetches
//                                     the bytes from a signed URL first.
//
// Why not just window.open(url): spreadsheet formats (xlsx/xls/csv) have no
// native browser viewer, so opening their blob/URL DOWNLOADS the file instead
// of showing it. We parse the workbook (SheetJS, lazy-loaded — already a dep,
// see lib/comparison/parseBudget.ts) and render it as an HTML table. PDFs and
// images DO preview natively, so those open straight from a URL.

import { previewBackButtonHtml } from "@/lib/previewChrome";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isNativePreview(name: string): boolean {
  return /\.(pdf|png|jpe?g|webp|gif|heic|heif|svg)$/i.test(name);
}

// The shell around the preview — dark, readable, tables scroll horizontally.
function previewDocument(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<title>${escapeHtml(title)} — preview</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  /* Standalone document.write preview — cannot read app CSS vars, so the
     Terminal (dark) palette is baked in as literals below. */
  :root { color-scheme: dark light; }
  body { margin: 0; padding: 24px; background: #080D0B; color: #E9EDEB; /* design-lint-allow-hex standalone preview doc */
         font: 14px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  h1 { font-size: 15px; font-weight: 600; margin: 0 0 4px; }
  .sub { font-size: 12px; color: #9EA9A4; margin: 0 0 20px; } /* design-lint-allow-hex standalone preview doc */
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em;
       color: #4EBCA6; margin: 28px 0 8px; } /* design-lint-allow-hex standalone preview doc */
  .scroll { overflow-x: auto; border: 1px solid #222A27; border-radius: 8px; } /* design-lint-allow-hex standalone preview doc */
  table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
  td, th { border: 1px solid #222A27; padding: 5px 9px; white-space: nowrap; /* design-lint-allow-hex standalone preview doc */
           text-align: left; }
  tr:nth-child(even) td { background: #141A18; } /* design-lint-allow-hex standalone preview doc */
  pre { white-space: pre-wrap; word-break: break-word; background: #141A18; /* design-lint-allow-hex standalone preview doc */
        border: 1px solid #222A27; border-radius: 8px; padding: 16px; /* design-lint-allow-hex standalone preview doc */
        font: 12.5px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .err { color: #E0655C; } /* design-lint-allow-hex standalone preview doc */
</style></head>
<body>${previewBackButtonHtml()}<h1>${escapeHtml(title)}</h1><p class="sub">${escapeHtml(subLabel(title))}</p>${body}</body></html>`;
}

// tiny helper so the sub-label stays a plain string
function subLabel(_title: string): string {
  return "File preview";
}

/** Parse `blob` (by filename extension) and render it as HTML into `win`. */
async function renderBlobPreview(win: Window, name: string, blob: Blob): Promise<void> {
  try {
    let body: string;
    const lower = name.toLowerCase();
    if (/\.(xlsx|xls)$/.test(lower)) {
      const XLSX = await import("xlsx");
      const wb = XLSX.read(await blob.arrayBuffer(), { type: "array" });
      body = wb.SheetNames.map((sheet) => {
        const html = XLSX.utils.sheet_to_html(wb.Sheets[sheet]);
        return `<h2>${escapeHtml(sheet)}</h2><div class="scroll">${html}</div>`;
      }).join("");
    } else if (/\.csv$/.test(lower)) {
      const XLSX = await import("xlsx");
      const wb = XLSX.read(await blob.text(), { type: "string" });
      body = `<div class="scroll">${XLSX.utils.sheet_to_html(wb.Sheets[wb.SheetNames[0]])}</div>`;
    } else {
      body = `<pre>${escapeHtml(await blob.text())}</pre>`;
    }
    win.document.open();
    win.document.write(previewDocument(name, body));
    win.document.close();
  } catch (e) {
    win.document.open();
    win.document.write(
      previewDocument(name, `<p class="err">Couldn't render a preview (${escapeHtml(String(e))}).</p>`),
    );
    win.document.close();
  }
}

/** Preview a locally-staged File in a new tab. */
export async function openStagedFile(file: File): Promise<void> {
  if (isNativePreview(file.name)) {
    const url = URL.createObjectURL(file);
    window.open(url, "_blank", "noopener");
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return;
  }
  const win = window.open("", "_blank");
  if (!win) return;
  win.document.write(previewDocument(file.name, `<p class="sub">Rendering preview…</p>`));
  win.document.close();
  await renderBlobPreview(win, file.name, file);
}

/**
 * Preview an already-uploaded document in a new tab. `getUrl` resolves a
 * short-lived signed URL for the stored file (see lib/supabase.signedDocumentUrl).
 * The tab is opened synchronously (pop-up-blocker safe) and filled once the
 * bytes arrive.
 */
export async function openUploadedFilePreview(
  name: string,
  getUrl: () => Promise<string | null>,
): Promise<void> {
  const win = window.open("", "_blank");
  if (!win) return;
  win.document.write(previewDocument(name, `<p class="sub">Loading preview…</p>`));
  win.document.close();
  try {
    const url = await getUrl();
    if (!url) throw new Error("no signed URL");
    // PDFs + images preview natively — just point the tab at the file.
    if (isNativePreview(name)) {
      win.location.href = url;
      return;
    }
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`fetch ${resp.status}`);
    await renderBlobPreview(win, name, await resp.blob());
  } catch (e) {
    win.document.open();
    win.document.write(
      previewDocument(name, `<p class="err">Couldn't load a preview (${escapeHtml(String(e))}).</p>`),
    );
    win.document.close();
  }
}
