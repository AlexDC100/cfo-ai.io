import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import { compression } from "vite-plugin-compression2";
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
      // Dev parity with the prod Caddy proxy: relative `/api/*` calls
      // (TestModeSessionBoot is the main one) reach the local engine
      // instead of falling through to index.html.
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
      },
    },
  },
  // Pre-compress build output (.gz next to each asset ≥1 KB). nginx's
  // `gzip_static on` serves these directly — max compression at zero
  // request-time CPU, and no dependency on Caddy sitting in front.
  plugins: [react(), compression({ threshold: 1024 })],
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
        // manualChunks TRIMMED (2026-08-04). Two groups were removed
        // after they broke the production boot with chunk-level import
        // cycles (the documented Rollup manualChunks + circular-imports
        // hazard):
        //   · "heic2any" — naming it promoted the 1.35 MB lazy decoder
        //     into the entry's static graph (modulepreload on first paint).
        //   · "vendor-charts" (recharts/d3/victory-vendor) — grouping the
        //     d3 micro-packages broke chunk init order ("Cannot access 'E'
        //     before initialization" at boot).
        // Both libraries are only ever `await import()`-ed, so Rollup's
        // default dynamic-boundary chunking already keeps them lazy.
        // The remaining groups are framework code with a clean one-way
        // dependency direction, kept for long-term cache stability.
        manualChunks: (id: string) => {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("/xlsx/") || id.startsWith("xlsx/")) return "xlsx";
          if (
            id.includes("/react/") ||
            id.includes("/react-dom/") ||
            id.includes("/scheduler/")
          ) {
            return "vendor-react";
          }
          if (id.includes("react-router")) return "vendor-router";
          if (id.includes("@tanstack/react-query") || id.includes("@tanstack/query-core")) {
            return "vendor-query";
          }
          if (id.includes("framer-motion") || id.includes("motion-dom") || id.includes("motion-utils")) {
            return "vendor-motion";
          }
          if (id.includes("@radix-ui")) return "vendor-radix";
          if (id.includes("@supabase")) return "vendor-supabase";
          // NOTE: no "vendor-i18n" group — grouping i18next+react-i18next
          // put react-i18next's init ahead of vendor-react's
          // ("createContext of undefined" at boot). Default chunking
          // keeps them ordered correctly.
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
