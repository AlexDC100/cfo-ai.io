// DEV-ONLY design-review harness for the findings surface.
//
// Why this exists rather than shooting /dashboard alone: no period in the
// test-mode stack carries contract rows yet (the persistence lane has not
// landed), so a dashboard screenshot shows the LEGACY fallback and says
// nothing about this lane's work. This page mounts the real components,
// with the real token sheet, against the REAL engine payload — the same
// `engineFixture.ts` the tests use, which is `RankedReport.to_payload()`
// dumped verbatim from `_finding` + `_finding_rank`.
//
// It is not part of the production build: `vite build` has exactly one
// entry (index.html at the repo root), so this HTML file is served in dev
// and never bundled. It is also excluded from the app's router, so there
// is no way to reach it from a signed-in session.
//
// Served at:
//   http://localhost:5173/frontend/components/cfo/findings/__preview__/
//
// Query flags (the screenshot script drives these):
//   ?mode=simple|pro   pin the view-mode dial
//   ?state=findings|silence
//   ?checks=open       render All checks expanded, for review shots
//   ?theme=light|dark

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";

import "@/index.css";
import "@/i18n";
import { CurrencyProvider } from "@/stores/currency";
import { buildFindingsReport } from "@/lib/findings";

import { AllChecksList } from "../AllChecksList";
import { FindingsPanel } from "../FindingsPanel";
import { ENGINE_REPORT, ENGINE_SILENCE } from "../__tests__/engineFixture";

const params = new URLSearchParams(window.location.search);

const mode = params.get("mode");
if (mode === "simple" || mode === "pro") {
  try {
    localStorage.setItem("cfo-view-mode-v1", mode);
  } catch {
    /* private mode — the dial falls back to its own default */
  }
}

const theme = params.get("theme");
if (theme === "dark" || theme === "light") {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.dataset.theme = theme;
}

// The state follows the entry file (index.html / silence.html) so the
// shared screenshot script can address it as a plain route — a query
// string would end up inside the PNG filename.
const state =
  params.get("state") ??
  (window.location.pathname.includes("silence") ? "silence" : "findings");
const report =
  state === "silence"
    ? buildFindingsReport({ report: { surfaced: [] }, silence: ENGINE_SILENCE })
    : buildFindingsReport(ENGINE_REPORT);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CurrencyProvider>
      <MemoryRouter>
        <div className="min-h-screen bg-bg px-6 py-8">
          <div className="mx-auto max-w-[900px]">
            <p className="mb-5 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-mute">
              findings harness · {state} · {mode ?? "default"} · engine payload
            </p>
            <FindingsPanel report={report} />
            {params.get("checks") === "open" || window.location.pathname.includes("checks") ? (
              <div className="mt-6">
                <AllChecksList report={report} defaultOpen />
              </div>
            ) : null}
          </div>
        </div>
      </MemoryRouter>
    </CurrencyProvider>
  </StrictMode>,
);
