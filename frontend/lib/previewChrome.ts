// previewChrome — shared "← Back" affordance for GENERATED preview documents
// (example trial balances, template views, staged/uploaded file previews).
//
// Those previews are written with document.write into a window.open tab. In a
// desktop browser that's a real second tab, but inside the iOS/Android shell
// the WebView disables multiple windows (setSupportMultipleWindows={false}),
// so the preview REPLACES the app in the same WebView and there is no visible
// way back (2026-08-18 per operator). The injected button covers every case:
//   1. real popup tab            → window.close()
//   2. same-WebView with history → history.back()
//   3. neither works             → location.replace(fallback) after a short
//      grace period (pagehide cancels it when back() did navigate)
//
// Inject the returned snippet anywhere inside the generated <body>. It also
// pads the top of the body so the fixed button never covers the heading.

export function previewBackButtonHtml(fallbackHref = "/dashboard"): string {
  const onclick =
    "(function(){" +
    "if(window.opener&&window.opener!==window){window.close();return;}" +
    `var t=setTimeout(function(){location.replace('${fallbackHref}')},400);` +
    "window.addEventListener('pagehide',function(){clearTimeout(t)});" +
    `if(history.length>1){history.back();}else{clearTimeout(t);location.replace('${fallbackHref}');}` +
    "})()";
  return (
    "<style>body{padding-top:64px !important}</style>" +
    `<button type="button" aria-label="Back to CFO AI" onclick="${onclick.replace(/"/g, "&quot;")}" ` +
    'style="position:fixed;top:14px;left:14px;z-index:99;display:inline-flex;align-items:center;gap:6px;' +
    // Standalone document.write preview — cannot read app CSS vars; Paper palette baked in.
    "height:36px;padding:0 14px;border-radius:999px;border:1px solid #E3E3DC;background:#FAFAF7;color:#0B0E0D;" + // design-lint-allow-hex standalone document.write preview
    'font:600 13px system-ui,Segoe UI,Arial,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.18);cursor:pointer">' +
    "&#8592; Back</button>"
  );
}
