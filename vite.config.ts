import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// ──────────────────────────────────────────────────────────────────────
// Vite config — production build tuned 2026-05-26 (perf pass)
//
// Before the perf pass: the app shipped one giant chunk (744 KB
// gzipped) — every page eagerly imported at the App.tsx top. After:
//   · App.tsx lazy-loads every auth-gated route (React.lazy)
//   · This file splits vendor code into stable chunks
//   · esbuild strips console.* + debugger from production output
//
// The vendor-chunk split below is the second win: when we ship a new
// app version, the React/charts/animation chunks stay byte-identical
// and the browser keeps using its cached copy. Only the changed app
// code re-downloads.
// ──────────────────────────────────────────────────────────────────────

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  // Where the app is served from. Defaults to the domain root, which is what
  // the VPS Docker build needs. GitHub Pages project sites live under
  // /<repo>/, so the Pages workflow sets VITE_BASE_PATH=/cfo-ai.io/ for that
  // build only — keeping one config correct for both targets rather than
  // hardcoding a base that would break whichever deploy it wasn't written for.
  base: process.env.VITE_BASE_PATH || "/",

  server: {
    host: "::",
    port: 5173,
    hmr: {
      overlay: false,
    },
    // Dev-only proxy for BVB price charts (2026-07-23): Yahoo's chart API
    // has no CORS headers, so the browser can't call it directly. In dev,
    // /yahoo/* is proxied server-side; publicCompanyPriceHistory.ts uses
    // it as a fallback when the engine isn't running locally. Production
    // never hits this path — the deployed engine serves BVB history via
    // providers/yahoo_bvb.py.
    proxy: {
      "/yahoo": {
        target: "https://query1.finance.yahoo.com",
        changeOrigin: true,
        rewrite: (p: string) => p.replace(/^\/yahoo/, ""),
      },
    },
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./frontend"),
    },
    // Single React copy across the bundle — without dedupe, a transitive
    // dep on a different React minor used to ship a second copy that
    // broke hooks identity. Keep all framework primitives here.
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime", "@tanstack/react-query", "@tanstack/query-core"],
  },

  // Strip developer noise from production. The single explicit
  // console.log in src + framework-emitted logs from React Query,
  // framer-motion devtools, etc. all get removed. `console.warn` /
  // `console.error` are intentionally preserved so real production
  // failures still surface (use them sparingly in app code).
  esbuild: mode === "production"
    ? { drop: ["console", "debugger"], pure: ["console.log", "console.debug", "console.info"] }
    : undefined,

  build: {
    // Bigger threshold for the dynamic-import warning. After lazy-routes
    // each page chunk is in the 100-300 KB range (uncompressed); the
    // default 500 KB threshold floods stdout with non-actionable warnings.
    chunkSizeWarningLimit: 1024,

    rollupOptions: {
      output: {
        // ──────────────────────────────────────────────────────────
        // manualChunks — split vendor code into stable, cacheable chunks.
        //
        // The function form (vs the object map form) lets us match by
        // package PATH instead of by import name, which handles deep
        // imports (`@tanstack/react-query/core/...`) correctly.
        //
        // Chunks are sized to keep each one in the 30-200 KB gzipped
        // range. Smaller than 30 KB and the per-request overhead
        // dominates; larger than 200 KB and we lose the long-term
        // caching benefit (any tiny change in one of the libs
        // invalidates the whole chunk).
        // ──────────────────────────────────────────────────────────
        manualChunks: (id: string) => {
          // CRITICAL: return undefined for libs we don't explicitly name.
          // A catch-all `return "vendor"` would force EVERY node_modules
          // import into one chunk — including `heic2any` (1.3 MB) which
          // is `await import()`-ed at runtime and should stay separate.
          // Rollup's default smart chunking handles the long tail.
          if (!id.includes("node_modules")) return undefined;

          // ── Per-page heavy dynamic imports: keep them as their own
          // chunk so they only load when actually used. ────────────────

          // heic2any: HEIC→JPEG conversion. Lazy-loaded by supabase.ts:618
          // (`await import("heic2any")`) only when a user uploads an
          // iPhone photo. Without an explicit split, my catch-all would
          // glue it into the main vendor chunk and force every visitor
          // to download 1.3 MB they don't need.
          if (id.includes("heic2any")) return "heic2any";

          // xlsx: SpreadsheetML parser used by financialExports.ts to
          // build .xlsx report exports. Dynamic-imported everywhere
          // (export button click, upload parsers), so it only downloads
          // when actually used; this keeps it a stable cache key.
          if (id.includes("/xlsx/") || id.startsWith("xlsx/")) return "xlsx";

          // ── App-wide framework/runtime chunks (stable across deploys
          // → maximum browser-cache hits). ──────────────────────────────

          // React core — bedrock. Almost never changes between releases;
          // gets cached aggressively. Keep VERY small.
          if (
            id.includes("/react/") ||
            id.includes("/react-dom/") ||
            id.includes("/scheduler/")
          ) {
            return "vendor-react";
          }

          // React Router — every page uses it; load once.
          if (id.includes("react-router")) {
            return "vendor-router";
          }

          // React Query (TanStack) — every authenticated page uses it.
          if (id.includes("@tanstack/react-query") || id.includes("@tanstack/query-core")) {
            return "vendor-query";
          }

          // Recharts (and its d3 deps) — Dashboard + Markets only. ~150 KB
          // gzipped. Keep separate so /products doesn't pay for it.
          if (
            id.includes("recharts") ||
            id.includes("/d3-") ||
            id.includes("victory-vendor")
          ) {
            return "vendor-charts";
          }

          // Framer Motion — used across the app but most heavily on
          // animated landing/marketing surfaces. Splitting keeps Dashboard
          // bundle leaner for power users who skip the marketing pages.
          if (id.includes("framer-motion") || id.includes("motion-dom") || id.includes("motion-utils")) {
            return "vendor-motion";
          }

          // Radix UI primitives — used across every page (dialogs,
          // toasts, popovers). Group them so the cache key is stable.
          if (id.includes("@radix-ui")) {
            return "vendor-radix";
          }

          // Supabase — only authenticated pages use it. Split out so the
          // landing page doesn't ship the auth SDK.
          if (id.includes("@supabase")) {
            return "vendor-supabase";
          }

          // i18next + locale loader — used app-wide.
          if (id.includes("i18next") || id.includes("react-i18next")) {
            return "vendor-i18n";
          }

          // Everything else from node_modules → fall through to Rollup's
          // default chunking strategy. Returning undefined lets Rollup
          // create per-package chunks where appropriate AND honor each
          // package's `await import()` boundaries.
          return undefined;
        },
      },
    },

    // Source maps OFF in production by default — generating + shipping
    // them adds ~30% to build time and ~3× artifact size. Flip via env
    // var if a specific debug session needs them.
    sourcemap: process.env.VITE_PROD_SOURCEMAPS === "1",
  },
}));
