/**
 * THE HERMETIC BACKEND DOUBLE for the workspace-redesign e2e gates.
 *
 * The browser runs the REAL production bundle (built with
 * VITE_SUPABASE_URL=http://harness.invalid and VITE_API_URL=http://engine.invalid,
 * two hosts that do not resolve), and every request it makes to either host is
 * answered here. Nothing leaves the machine; nothing is written anywhere.
 *
 * The double invents NO engine answer. Everything the engine says is a
 * capture from the real app, committed under e2e/fixtures/workspace_v2/ and
 * held to the live route by tests/engine/test_workspace_v2_gates.py (G7):
 *
 *   features_status.json   GET /api/features/status (workspace_v2 = "preview")
 *   agras_fy2025.json      identify (Agras's balance dropped with Scandia on
 *                          screen), commit, the year tile and GET /api/period
 *                          for the analysed period — the anonymized real
 *                          Agras FY2025 book through the real pipeline
 *   scandia_fy2025.json    the same for Scandia's own FY2025 book
 *
 * What the double owns is STATE: which companies the user has, which
 * periods exist (none for Agras until its analysis finishes — G4), the
 * document row the commit creates and the status it walks through
 * (queued → extracting → mapping → computing → narrating → analyzed, one
 * step per poll of the browser's status backstop, exactly the statuses the
 * pipeline writes), and the preference bags. Supabase REST is modelled only
 * as far as the app reads it; anything unmodelled is answered with an empty
 * result AND recorded in `unhandled`, which each spec prints.
 */
import type { Page, Request, Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIX = resolve(HERE, "fixtures/workspace_v2");

export const SUPABASE_HOST = "harness.invalid";
export const ENGINE_HOST = "engine.invalid";
export const STORAGE_KEY = "sb-harness-auth-token";

export const USER_ID = "5c0a0000-0000-4000-8000-0000000000a1";
export const ORG_SCANDIA = "0a9a0000-0000-4000-8000-000000000051";
export const ORG_AGRAS = "0a9a0000-0000-4000-8000-0000000000a9";

type Json = Record<string, any>;

function fixture(name: string): Json {
  return JSON.parse(readFileSync(resolve(FIX, name), "utf-8"));
}

export const FEATURES = fixture("features_status.json");
export const AGRAS = fixture("agras_fy2025.json");
export const SCANDIA = fixture("scandia_fy2025.json");

/** "Ce contează acum" and the sector document for each captured period,
 *  as the ENGINE composed them over these same two bodies
 *  (frontend/lib/__tests__/fixtures/attention/capture_attention.py; held to
 *  a fresh composition by tests/engine/test_cmdbar_fixtures.py). Keyed by
 *  period id. The double invents neither. */
const ATTENTION_FIX = resolve(HERE, "../frontend/lib/__tests__/fixtures/attention");
function attentionFixture(name: string): Json {
  return JSON.parse(readFileSync(resolve(ATTENTION_FIX, name), "utf-8"));
}
export const ATTENTION: Record<string, Json> = {
  [SCANDIA.period.period.id]: attentionFixture("scandia.attention.json"),
  [AGRAS.period.period.id]: attentionFixture("agras.attention.json"),
};
export const SECTOR_BENCHMARK: Record<string, Json> = {
  [SCANDIA.period.period.id]: attentionFixture("scandia.sector.json"),
  [AGRAS.period.period.id]: attentionFixture("agras.sector.json"),
};

/** The anonymized real Agras FY2025 balance (corpus/saga_10_col_agras). */
export function agrasBalanceBytes(): Buffer {
  return readFileSync(resolve(HERE, "../corpus/saga_10_col_agras/input.xlsx"));
}

/** An unsigned, well-formed JWT: supabase-js decodes it, nobody verifies it. */
function fakeJwt(sub: string): string {
  const b64 = (o: Json) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + 24 * 3600;
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({
    sub,
    aud: "authenticated",
    role: "authenticated",
    email: "owner@example.test",
    exp,
  })}.c2lnbmF0dXJl`;
}

export const USER = {
  id: USER_ID,
  aud: "authenticated",
  role: "authenticated",
  email: "owner@example.test",
  app_metadata: { provider: "email" },
  user_metadata: { full_name: "Owner" },
  created_at: "2026-01-01T00:00:00Z",
};

export function sessionBlob(): Json {
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: fakeJwt(USER_ID),
    refresh_token: "harness-refresh",
    token_type: "bearer",
    expires_in: 24 * 3600,
    expires_at: now + 24 * 3600,
    user: USER,
  };
}

interface Org {
  id: string;
  name: string;
  industry_key: string | null;
  industry_display_name: string | null;
  default_currency: string;
  role: "owner";
  archived_at: string | null;
  purge_after: string | null;
  created_at: string;
}

export interface DoubleOptions {
  theme: "light" | "dark";
  language: "en" | "ro";
  /** Status the analysis holds at (for a progress screenshot); undefined = runs to the end. */
  holdAt?: string;
}

const STEPS = ["queued", "extracting", "mapping", "computing", "narrating", "analyzed"];

export class WorkspaceDouble {
  readonly orgs: Org[] = [
    {
      id: ORG_SCANDIA, name: "Scandia Food SRL", industry_key: "food_manufacturing",
      industry_display_name: null, default_currency: "RON", role: "owner",
      archived_at: null, purge_after: null, created_at: "2026-01-01T00:00:00Z",
    },
    {
      id: ORG_AGRAS, name: "Agras SRL", industry_key: "food_manufacturing",
      industry_display_name: null, default_currency: "RON", role: "owner",
      archived_at: null, purge_after: null, created_at: "2026-01-02T00:00:00Z",
    },
  ];
  readonly orgPrefs: Record<string, Json> = {
    [ORG_SCANDIA]: { cui: "16070576", company_name: "Scandia Food SRL", display_currency: "RON" },
    [ORG_AGRAS]: { cui: "46355095", company_name: "Agras SRL", display_currency: "RON" },
  };
  userPrefs: Json;
  /** Analysed periods by company. Agras has none until its file is analysed. */
  readonly periods: Record<string, Json[]> = {
    [ORG_SCANDIA]: [SCANDIA],
    [ORG_AGRAS]: [],
  };
  /** The documents the commit created: id → row. */
  readonly documents = new Map<string, Json>();
  /** Documents a company already holds (not created by a commit) — e.g. the
   *  failed upload the workspace migration moved into Agras. Served to the
   *  app's own `documents` reads, filtered as PostgREST would. */
  readonly keptDocuments: Json[] = [];
  readonly commits: Json[] = [];
  readonly identifies: Json[] = [];
  readonly unhandled: string[] = [];
  /** Every request the browser made to either doubled host, in order —
   *  `org` is its X-Org-Id. The G6 company-switch gate reads it. */
  readonly requests: { host: string; method: string; path: string; search: string; org: string | null }[] = [];
  /** Every comparatives request: the company asked (X-Org-Id), the period, the prior. */
  readonly comparisons: { org: string | null; period: string; prior: string | null }[] = [];
  holdAt: string | undefined;

  constructor(readonly opts: DoubleOptions) {
    this.holdAt = opts.holdAt;
    this.userPrefs = {
      preview_features: ["workspace_v2"],
      theme: opts.theme,
      view_mode: "pro",
      learning_mode: { mode: "off", coachDismissed: true, tutorialsSeen: {} },
      active_org_id: ORG_SCANDIA,
    };
  }

  /** Let a held analysis continue. */
  release(): void {
    this.holdAt = undefined;
  }

  companyName(orgId: string): string {
    return this.orgs.find((o) => o.id === orgId)?.name ?? "";
  }

  private periodById(id: string): Json | null {
    for (const list of Object.values(this.periods)) {
      const hit = list.find((f) => f.period.period.id === id);
      if (hit) return hit.period;
    }
    return null;
  }

  async install(page: Page): Promise<void> {
    const opts = this.opts;
    await page.addInitScript(
      ({ key, session, theme, language, org }) => {
        try {
          localStorage.setItem(key, JSON.stringify(session));
          localStorage.setItem("cfoai_theme", theme);
          localStorage.setItem("cfo.userLanguage", language);
          localStorage.setItem("cfo-view-mode-v1", "pro");
          localStorage.setItem(
            "cfo:learning-mode:v1",
            JSON.stringify({ mode: "off", coachDismissed: true, tutorialsSeen: {} }),
          );
          localStorage.setItem("cfoai_consent", JSON.stringify({ necessary: true, analytics: false }));
          localStorage.setItem("accuracy_banner_dismissed", "1");
          localStorage.setItem("cfo:header-mode-coachmark-v1", "dismissed");
          // The active workspace, uid-scoped (lib/activeOrg.ts) — first
          // paint only; user_prefs.active_org_id is the durable copy.
          if (!localStorage.getItem("cfoai.active_org")) {
            localStorage.setItem("cfoai.active_org", JSON.stringify({ uid: session.user.id, orgId: org }));
          }
        } catch {
          /* ignore */
        }
      },
      { key: STORAGE_KEY, session: sessionBlob(), theme: opts.theme, language: opts.language, org: ORG_SCANDIA },
    );
    // Nothing leaves the machine — enforced, not left to DNS: a request to
    // any host that is neither the local bundle nor one of the two doubled
    // hosts is aborted and recorded (each spec prints `unhandled`).
    await page.route(
      (url) => !["127.0.0.1", "localhost", SUPABASE_HOST, ENGINE_HOST].includes(url.hostname),
      (route) => {
        const u = new URL(route.request().url());
        this.unhandled.push(`EXTERNAL ${route.request().method()} ${u.hostname}${u.pathname}`);
        return route.abort();
      },
    );
    // The catch-all FIRST: Playwright matches the last-registered route first.
    await page.route(
      (url) => url.hostname === SUPABASE_HOST || url.hostname === ENGINE_HOST,
      (route) => this.handle(route),
    );
  }

  private async handle(route: Route): Promise<void> {
    const req = route.request();
    const url = new URL(req.url());
    this.requests.push({
      host: url.hostname,
      method: req.method(),
      path: url.pathname,
      search: url.search,
      org: req.headers()["x-org-id"] ?? null,
    });
    try {
      if (url.hostname === ENGINE_HOST) return await this.engine(route, req, url);
      if (url.pathname.startsWith("/auth/v1/")) return await this.auth(route, req, url);
      if (url.pathname.startsWith("/rest/v1/")) return await this.rest(route, req, url);
      if (url.pathname.startsWith("/realtime/")) return await route.abort();
      this.unhandled.push(`${req.method()} ${url.pathname}`);
      return await route.fulfill({ status: 404, json: { message: "not in the double" } });
    } catch (err) {
      this.unhandled.push(`THREW ${req.method()} ${url.pathname}: ${String(err)}`);
      return await route.fulfill({ status: 500, json: { message: String(err) } });
    }
  }

  // ── Supabase auth ─────────────────────────────────────────────────────
  private async auth(route: Route, req: Request, url: URL): Promise<void> {
    if (url.pathname === "/auth/v1/user") return route.fulfill({ status: 200, json: USER });
    if (url.pathname === "/auth/v1/token") return route.fulfill({ status: 200, json: sessionBlob() });
    if (url.pathname === "/auth/v1/logout") return route.fulfill({ status: 204, body: "" });
    this.unhandled.push(`${req.method()} ${url.pathname}`);
    return route.fulfill({ status: 200, json: {} });
  }

  // ── Supabase REST (PostgREST) ─────────────────────────────────────────
  private async rest(route: Route, req: Request, url: URL): Promise<void> {
    const table = url.pathname.slice("/rest/v1/".length);
    const wantsObject = (req.headers()["accept"] ?? "").includes("vnd.pgrst.object");
    const one = async (row: Json | null) => {
      if (wantsObject) {
        if (!row) {
          return route.fulfill({
            status: 406,
            json: { code: "PGRST116", details: "The result contains 0 rows", hint: null, message: "JSON object requested, multiple (or no) rows returned" },
          });
        }
        return route.fulfill({ status: 200, json: row });
      }
      return route.fulfill({ status: 200, json: row ? [row] : [] });
    };
    const eq = (col: string) => (url.searchParams.get(col) ?? "").replace(/^eq\./, "");

    if (table === "rpc/list_workspaces") return route.fulfill({ status: 200, json: this.orgs });
    if (table === "rpc/set_user_pref") {
      const body = req.postDataJSON() as Json;
      this.userPrefs = { ...this.userPrefs, [body.p_key]: body.p_value };
      return route.fulfill({ status: 200, json: this.userPrefs });
    }
    if (table === "rpc/set_org_pref") {
      const body = req.postDataJSON() as Json;
      this.orgPrefs[body.p_org_id] = { ...(this.orgPrefs[body.p_org_id] ?? {}), [body.p_key]: body.p_value };
      return route.fulfill({ status: 200, json: this.orgPrefs[body.p_org_id] });
    }
    if (table.startsWith("rpc/")) {
      this.unhandled.push(`RPC ${table}`);
      return route.fulfill({ status: 200, json: null });
    }
    if (table === "user_prefs") {
      if (req.method() !== "GET") return route.fulfill({ status: 201, json: [] });
      return one({ user_id: USER_ID, prefs: this.userPrefs });
    }
    if (table === "org_prefs") {
      if (req.method() !== "GET") return route.fulfill({ status: 201, json: [] });
      const select = url.searchParams.get("select") ?? "";
      const inList = url.searchParams.get("org_id") ?? "";
      if (inList.startsWith("in.(")) {
        const ids = inList.slice(4, -1).split(",").map((s) => s.replace(/"/g, ""));
        const rows = ids
          .filter((id) => this.orgPrefs[id])
          .map((id) =>
            select.includes("cui:")
              ? { org_id: id, cui: this.orgPrefs[id].cui ?? null, company_name: this.orgPrefs[id].company_name ?? null }
              : { org_id: id, prefs: this.orgPrefs[id] },
          );
        return route.fulfill({ status: 200, json: rows });
      }
      const id = eq("org_id");
      return one(this.orgPrefs[id] ? { org_id: id, prefs: this.orgPrefs[id] } : null);
    }
    if (table === "documents" && req.method() === "GET") {
      const id = eq("id");
      if (id && this.documents.has(id)) return one(this.advance(id));
      const org = eq("org_id");
      const periodId = eq("period_id");
      const needsLanguage = url.searchParams.get("detected_language") === "not.is.null";
      const kept = this.keptDocuments.filter(
        (d) =>
          (!id || d.id === id) &&
          (!org || d.org_id === org) &&
          (!periodId || d.period_id === periodId) &&
          (!needsLanguage || d.detected_language != null),
      );
      if (wantsObject) return one(kept[0] ?? null);
      return route.fulfill({ status: 200, json: kept });
    }
    if (table === "profiles" && req.method() === "GET") {
      return one({ id: USER_ID, language: this.opts.language, full_name: "Owner", email: USER.email });
    }
    if (req.method() === "GET") {
      if (!["subscriptions", "alerts", "alert_states", "activity", "chat_threads", "chat_messages",
        "financial_periods", "organizations", "memberships", "founder_cohort_public", "datasets"].includes(table)) {
        this.unhandled.push(`GET /rest/v1/${table}`);
      }
      return wantsObject ? one(null) : route.fulfill({ status: 200, json: [] });
    }
    this.unhandled.push(`${req.method()} /rest/v1/${table}`);
    return route.fulfill({ status: 201, json: [] });
  }

  /** One pipeline step per status poll — never past `holdAt`. */
  private advance(docId: string): Json {
    const doc = this.documents.get(docId)!;
    const i = STEPS.indexOf(doc.status);
    if (i >= 0 && i < STEPS.length - 1 && doc.status !== this.holdAt) {
      doc.status = STEPS[i + 1];
      if (doc.status === "analyzed") {
        // The engine's stage_persist created the period at persist time;
        // it becomes visible to the company page and the dashboard now.
        this.periods[doc.org_id] = [AGRAS];
        doc.period_id = AGRAS.period.period.id;
      }
    }
    return { ...doc };
  }

  // ── The engine ────────────────────────────────────────────────────────
  private async engine(route: Route, req: Request, url: URL): Promise<void> {
    const p = url.pathname;
    const method = req.method();
    if (p === "/health") return route.fulfill({ status: 200, json: { status: "ok" } });
    if (p === "/api/features/status") return route.fulfill({ status: 200, json: FEATURES });

    if (p === "/api/uploads/identify" && method === "POST") {
      const form = multipartFields(req);
      this.identifies.push({ orgHeader: req.headers()["x-org-id"] ?? null, filename: form.__filename });
      // The engine's answer for the Agras balance with Scandia on screen —
      // the capture G7 holds to the live route. After the analysis, the
      // same bytes are a duplicate (G3): the engine names the analysed period.
      const answer = JSON.parse(JSON.stringify(AGRAS.identify));
      const done = [...this.documents.values()].find((d) => d.status === "analyzed");
      if (done) answer.duplicate = { document_id: done.id, period_id: done.period_id, org_id: done.org_id };
      return route.fulfill({ status: 200, json: answer });
    }
    if (p === "/api/uploads/commit" && method === "POST") {
      const form = multipartFields(req);
      this.commits.push(form);
      if (!form.period_end) {
        return route.fulfill({ status: 422, json: { detail: { code: "invalid_period_end", message: "A period is required." } } });
      }
      const target = form.target_org_id;
      if (!this.orgs.some((o) => o.id === target)) {
        return route.fulfill({ status: 403, json: { detail: "Not a member of this company." } });
      }
      const answer = JSON.parse(JSON.stringify(AGRAS.commit));
      if (answer.org_id !== target) {
        // The double only knows what the engine answered for Agras.
        this.unhandled.push(`commit to ${target} (the capture is for ${answer.org_id})`);
        return route.fulfill({ status: 500, json: { detail: "the double holds no capture for this target" } });
      }
      this.documents.set(answer.document_id, {
        id: answer.document_id, org_id: target, uploaded_by: USER_ID, status: "queued",
        original_filename: form.__filename ?? "balanta.xlsx", period_id: null, error: null,
        period_end_hint: form.period_end, scope: "financial", detected_type: "trial_balance",
        created_at: "2026-09-21T10:00:00Z", deleted_at: null,
      });
      return route.fulfill({ status: 200, json: answer });
    }
    const years = /^\/api\/companies\/([^/]+)\/years$/.exec(p);
    if (years) {
      const list = (this.periods[years[1]] ?? []).map((f) => f.years[0]);
      return route.fulfill({ status: 200, json: list });
    }
    const comparison = /^\/api\/period\/([^/?]+)\/comparatives$/.exec(p);
    if (comparison) {
      // THE ENGINE'S WALL, not an engine figure: the route loads both
      // periods with the X-Org-Id company IN THE FILTER
      // (_comparatives.load_period_in_org) and refuses a period that
      // company does not hold, in these words. The double holds no pair of
      // one company's periods, so no comparison document is ever answered.
      const org = req.headers()["x-org-id"] ?? null;
      const prior = url.searchParams.get("prior");
      this.comparisons.push({ org, period: comparison[1], prior });
      const held = new Set((this.periods[org ?? ""] ?? []).map((f) => f.period.period.id as string));
      const missing = !held.has(comparison[1]) ? comparison[1] : !held.has(prior ?? "") ? prior : null;
      if (missing !== null) {
        return route.fulfill({
          status: 404,
          json: { detail: { code: "period_not_in_workspace", message: `period '${missing}' is not in this workspace` } },
        });
      }
      this.unhandled.push(`ENGINE ${method} ${p} (a same-company pair the double holds no capture for)`);
      return route.fulfill({ status: 404, json: { detail: "not in the double" } });
    }
    // The command bar's two documents. Same wall as comparatives: the
    // period must be one the X-Org-Id company holds (the engine loads it
    // org-filtered and answers 404 otherwise).
    const bar = /^\/api\/period\/([^/?]+)\/(attention|sector-benchmark)$/.exec(p);
    if (bar) {
      const org = req.headers()["x-org-id"] ?? null;
      const held = new Set((this.periods[org ?? ""] ?? []).map((f) => f.period.period.id as string));
      if (bar[2] === "attention" && !held.has(bar[1])) {
        return route.fulfill({
          status: 404,
          json: { detail: { code: "period_not_in_workspace", message: `period '${bar[1]}' is not in this workspace` } },
        });
      }
      const doc = (bar[2] === "attention" ? ATTENTION : SECTOR_BENCHMARK)[bar[1]];
      return doc
        ? route.fulfill({ status: 200, json: doc })
        : route.fulfill({ status: 404, json: { detail: "Period not found" } });
    }
    const period = /^\/api\/period\/([^/?]+)$/.exec(p);
    if (period) {
      const body = this.periodById(period[1]);
      return body
        ? route.fulfill({ status: 200, json: body })
        : route.fulfill({ status: 404, json: { detail: "Period not found" } });
    }
    if (p === "/api/org/periods-with-documents") {
      const org = req.headers()["x-org-id"] ?? ORG_SCANDIA;
      const list = (this.periods[org] ?? []).map((f) => {
        const b = f.period;
        const doc = b.period.source_document;
        return {
          period_id: b.period.id, period_label: b.period.period_end, period_start: "2025-01-01",
          period_end: b.period.period_end, is_active: true, currency: "RON",
          documents: [{
            id: doc.id, display_name: doc.filename, original_filename: doc.filename,
            storage_path: `${org}/uploads/${doc.id}.xlsx`, mime_type: null, detected_type: doc.detected_type,
            size_bytes: 1, uploaded_at: "2026-09-21T10:00:00Z", status: doc.status, is_active: true,
          }],
        };
      });
      return route.fulfill({
        status: 200,
        json: { active_period_id: list[0]?.period_id ?? null, periods: list, public_records: [], recently_deleted: [] },
      });
    }
    if (p === "/api/pipeline/recover-stuck") return route.fulfill({ status: 200, json: {} });
    this.unhandled.push(`ENGINE ${method} ${p}`);
    return route.fulfill({ status: 404, json: { detail: "not in the double" } });
  }
}

/** The text fields of a multipart body (the file part's name as `__filename`). */
function multipartFields(req: Request): Record<string, string> {
  const buf = req.postDataBuffer();
  const out: Record<string, string> = {};
  if (!buf) return out;
  const text = buf.toString("latin1");
  const type = req.headers()["content-type"] ?? "";
  const boundary = /boundary=([^;]+)/.exec(type)?.[1];
  if (!boundary) return out;
  for (const part of text.split(`--${boundary}`)) {
    const head = /Content-Disposition: form-data; name="([^"]+)"(?:; filename="([^"]*)")?/i.exec(part);
    if (!head) continue;
    if (head[2] !== undefined) {
      out.__filename = head[2];
      continue;
    }
    const body = part.split("\r\n\r\n").slice(1).join("\r\n\r\n").replace(/\r\n$/, "");
    out[head[1]] = Buffer.from(body, "latin1").toString("utf-8");
  }
  return out;
}

/** Drop `bytes` as `name` onto the page — the window-level drop the app
 *  listens for on every page (UploadDropOverlay). */
export async function dropFile(page: Page, name: string, bytes: Buffer, target = "body"): Promise<void> {
  await page.evaluate(
    ({ b64, name, target }) => {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const file = new File([arr], name, {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const dt = new DataTransfer();
      dt.items.add(file);
      const el = document.querySelector(target) ?? document.body;
      for (const type of ["dragenter", "dragover", "drop"]) {
        el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      }
    },
    { b64: bytes.toString("base64"), name, target },
  );
}

/** What the G6 watch saw, across every navigation of the page. */
export interface HeaderWatch {
  checks: number;
  violations: string[];
}

/**
 * G6 in the browser: on EVERY DOM mutation, the header capsule must name the
 * company the page is about — the company page's title, the `?org=` company
 * of a dashboard, or (2026-09-26) the OWNER of the `?period=` a dashboard
 * shows when no `?org=` pins one (a stale link, Back, a remembered period):
 * `owners` maps a period id to its company. Every check is reported to the
 * test process (`exposeFunction`), so nothing is lost when the page navigates.
 */
export async function installHeaderWatch(
  page: Page,
  names: Record<string, string>,
  owners: Record<string, string> = {},
): Promise<HeaderWatch> {
  const watch: HeaderWatch = { checks: 0, violations: [] };
  await page.exposeFunction("__g6Record", (violation: string | null) => {
    watch.checks += 1;
    if (violation) watch.violations.push(violation);
  });
  await page.addInitScript(({ names, owners }: { names: Record<string, string>; owners: Record<string, string> }) => {
    const w = window as any;
    let last = "";
    const check = () => {
      const header = document.querySelector('[data-testid="header-command-bar"]')?.textContent?.trim() ?? "";
      if (!header) return;
      let expected: string | null = null;
      const title = document.querySelector('[data-testid="company-title"]')?.textContent?.trim();
      if (title && location.pathname.startsWith("/workspace/")) expected = title;
      const params = new URLSearchParams(location.search);
      const org = params.get("org");
      const held = !!document.querySelector('[data-testid="org-param-hold"]');
      if (!expected && org && location.pathname.startsWith("/dashboard") && !held) {
        expected = names[org] ?? null;
      }
      // No `?org=`: the period's own company, once the page is released.
      const period = params.get("period");
      if (!expected && !org && period && owners[period] && location.pathname.startsWith("/dashboard") && !held) {
        expected = names[owners[period]] ?? null;
      }
      if (!expected) return;
      // The capsule truncates at 24 characters; it must still START with
      // the company's name (or the truncated head of it).
      const head = expected.length > 22 ? expected.slice(0, 22) : expected;
      const violation = header.startsWith(head)
        ? null
        : `${location.pathname}${location.search}: header "${header}" over "${expected}"`;
      const key = `${location.href}|${header}|${expected}`;
      if (key === last && !violation) return;
      last = key;
      void w.__g6Record?.(violation);
    };
    new MutationObserver(check).observe(document, { subtree: true, childList: true, characterData: true });
  }, { names, owners });
  return watch;
}
