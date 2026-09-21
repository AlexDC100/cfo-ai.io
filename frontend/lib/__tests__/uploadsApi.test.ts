// The frontend half of the workspace-redesign upload contract — exact routes,
// exact fields, exact answers. Plus the words the card uses for "where a value
// came from", and the redesign's RO/EN strings.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/apiHeaders", () => ({
  authOrgHeaders: vi.fn(async () => ({ Authorization: "Bearer tok", "X-Org-Id": "org-active" })),
}));
vi.mock("@/lib/supabase", () => ({ getSupabase: () => null }));

import {
  commitUpload,
  fetchCompanyYears,
  identifyUpload,
  normalizeIdentify,
  UploadApiError,
} from "@/lib/uploadsApi";
import { sourceKey, sourcePhrase } from "@/components/cfo/upload/identitySources";
import en from "@/i18n/locales/en.json";
import ro from "@/i18n/locales/ro.json";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const IDENTIFY_BODY = {
  content_hash: "abc",
  identity: {
    cui: "RO7654321",
    company_name: "Agras SA",
    period_end: "2025-12-31",
    caen_code: "0111",
    industry_key: "agriculture",
    industry_label: "Agriculture",
    sources: { cui: { signal: "document_header", evidence: "CUI 7654321" }, period_end: { signal: "period_line" } },
  },
  target: { org_id: "agras", name: "Agras SA", is_new: false, reason: "cui_match" },
  duplicate: null,
  companies: [{ org_id: "agras", name: "Agras SA", cui: "RO7654321" }],
};

describe("POST /api/uploads/identify", () => {
  it("multipart `file`, the bearer, and X-Org-Id = the company ON SCREEN", async () => {
    fetchMock.mockResolvedValue(json(200, IDENTIFY_BODY));
    const file = new File(["x"], "balanta.xls");
    const res = await identifyUpload(file, "org-on-screen");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toMatch(/\/api\/uploads\/identify$/);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ Authorization: "Bearer tok", "X-Org-Id": "org-on-screen" });
    expect((init.body as FormData).get("file")).toBeInstanceOf(File);
    expect(res.target).toEqual({ org_id: "agras", name: "Agras SA", is_new: false, reason: "cui_match" });
    expect(res.identity.sources.cui).toEqual({ signal: "document_header", evidence: "CUI 7654321" });
  });

  it("an error answer is an error, never a guessed identity", async () => {
    fetchMock.mockResolvedValue(json(422, { detail: "Fișierul nu e o balanță." }));
    await expect(identifyUpload(new File(["x"], "a.pdf"), null)).rejects.toThrow("Fișierul nu e o balanță.");
  });

  it("a malformed body is refused", () => {
    expect(() => normalizeIdentify({ identity: {} })).toThrow(UploadApiError);
  });

  it("a duplicate carries document, period and company", () => {
    const n = normalizeIdentify({ ...IDENTIFY_BODY, duplicate: { document_id: "d1", period_id: "p1", org_id: "agras" } });
    expect(n.duplicate).toEqual({ document_id: "d1", period_id: "p1", org_id: "agras" });
  });
});

describe("POST /api/uploads/commit", () => {
  it("existing company: target_org_id + period_end + industry_key, no create_company", async () => {
    fetchMock.mockResolvedValue(json(200, { status: "queued", document_id: "d1", org_id: "agras", company_name: "Agras SA" }));
    const res = await commitUpload({
      file: new File(["x"], "b.xls"),
      targetOrgId: "agras",
      periodEnd: "2025-12-31",
      industryKey: "agriculture",
      onScreenOrgId: "scandia",
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toMatch(/\/api\/uploads\/commit$/);
    const form = init.body as FormData;
    expect(form.get("target_org_id")).toBe("agras");
    expect(form.get("create_company")).toBeNull();
    expect(form.get("period_end")).toBe("2025-12-31");
    expect(form.get("industry_key")).toBe("agriculture");
    expect(init.headers["X-Org-Id"]).toBe("scandia");
    expect(res).toEqual({ status: "queued", document_id: "d1", org_id: "agras", company_name: "Agras SA" });
  });

  it("new company: create_company JSON {name,cui,caen_code,industry_key}, no target_org_id", async () => {
    fetchMock.mockResolvedValue(json(200, { status: "queued", document_id: "d2", org_id: "new", company_name: "Carniprod SRL" }));
    await commitUpload({
      file: new File(["x"], "c.pdf"),
      createCompany: { name: "Carniprod SRL", cui: "RO999", caen_code: "1011", industry_key: "manufacturing" },
      periodEnd: "2025-12-31",
    });
    const form = fetchMock.mock.calls[0]![1].body as FormData;
    expect(form.get("target_org_id")).toBeNull();
    expect(JSON.parse(String(form.get("create_company")))).toEqual({
      name: "Carniprod SRL",
      cui: "RO999",
      caen_code: "1011",
      industry_key: "manufacturing",
    });
  });

  it("duplicate → {status:'duplicate', …} straight through", async () => {
    fetchMock.mockResolvedValue(
      json(200, { status: "duplicate", document_id: "d0", period_id: "p0", org_id: "agras", company_name: "Agras SA" }),
    );
    const res = await commitUpload({ file: new File(["x"], "b.xls"), targetOrgId: "agras", periodEnd: "2025-12-31" });
    expect(res).toEqual({ status: "duplicate", document_id: "d0", period_id: "p0", org_id: "agras", company_name: "Agras SA" });
  });

  it("402 → the plan's extra-document question, exactly as /api/pipeline/run asks it", async () => {
    fetchMock.mockResolvedValue(
      json(402, {
        detail: {
          code: "extra_doc_confirmation_required",
          plan_key: "starter",
          docs_used: 5,
          docs_included: 5,
          extra_doc_eur: 3,
          message: "This will be an extra document.",
        },
      }),
    );
    const res = await commitUpload({ file: new File(["x"], "b.xls"), targetOrgId: "agras", periodEnd: "2025-12-31" });
    expect(res).toEqual({
      status: "needs_confirmation",
      confirmation: { planKey: "starter", docsUsed: 5, docsIncluded: 5, extraDocEur: 3, message: "This will be an extra document." },
    });
  });

  it("the engine's word on whether a company was created travels through", async () => {
    fetchMock.mockResolvedValue(
      json(200, { status: "queued", document_id: "d3", org_id: "o", company_name: "C SRL", created_company: false, period_end: "2025-12-31" }),
    );
    const res = await commitUpload({
      file: new File(["x"], "b.xls"),
      createCompany: { name: "C SRL", cui: "RO1", caen_code: null, industry_key: null },
      periodEnd: "2025-12-31",
    });
    expect(res).toEqual({ status: "queued", document_id: "d3", org_id: "o", company_name: "C SRL", created_company: false });
  });

  it("403 (not my company) is a refusal with the engine's words", async () => {
    fetchMock.mockResolvedValue(json(403, { detail: "Not a member of this organization." }));
    const res = await commitUpload({ file: new File(["x"], "b.xls"), targetOrgId: "x", periodEnd: "2025-12-31" });
    expect(res).toEqual({ status: "refused", message: "Not a member of this organization.", httpStatus: 403 });
  });
});

describe("GET /api/companies/{org_id}/years", () => {
  it("reads the served rows, in year order, absent stays absent", async () => {
    fetchMock.mockResolvedValue(
      json(200, [
        { period_id: "p25", year: 2025, period_end: "2025-12-31", revenue: 118_600_000, revenue_change_pct: 7.0 },
        { period_id: "p24", year: 2024, period_end: "2024-12-31", revenue: null, revenue_change_pct: null },
      ]),
    );
    const rows = await fetchCompanyYears("agras");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toMatch(/\/api\/companies\/agras\/years$/);
    expect(init.headers["X-Org-Id"]).toBe("agras");
    expect(rows.map((r) => r.year)).toEqual([2024, 2025]);
    expect(rows[0]!.revenue).toBeNull();
    expect(rows[1]!.revenue_change_pct).toBe(7.0);
  });
});

describe("where a value came from — the card's phrase per signal", () => {
  // The engine's own tokens (company_identity.py, _period_detect.SIGNALS).
  it.each([
    ["document_header_cui", "cui", "document_header"],
    ["registry_name_match", "cui", "registry"],
    ["filename_registry_match", "cui", "filename"],
    ["operator_verified", "cui", "verified"],
    ["registry", "company_name", "registry"],
    ["document_header_label", "company_name", "document_header"],
    ["document_header_title", "company_name", "document_header"],
    ["sheet_name", "company_name", "sheet"],
    ["filename", "company_name", "filename"],
    ["document_header", "caen_code", "document_header"],
    ["caen_catalogue", "industry_key", "caen"],
    ["in_document", "period_end", "period_line"],
    ["closing_balance", "period_end", "closing_balance"],
    ["user_confirmed", "period_end", "user"],
    // Families, and the honest minimum for anything unknown.
    ["on_screen_company", undefined, "on_screen_company"],
    ["anaf_registry", undefined, "registry"],
    ["something_new", undefined, "document"],
    ["none", "period_end", "document"],
    ["", undefined, "document"],
    [undefined, undefined, "document"],
  ])("%s (%s) → %s", (signal, field, phrase) => {
    expect(sourcePhrase(signal as string | undefined, field as string | undefined)).toBe(phrase);
    expect(sourceKey(signal as string | undefined, field as string | undefined)).toBe(`wsV2.from.${phrase}`);
  });

  it("every phrase the mapping can produce exists in both languages", () => {
    const phrases = [
      "document_header", "period_line", "closing_balance", "registry", "caen", "sheet",
      "filename", "verified", "on_screen_company", "company_settings", "user", "document",
    ];
    const from = (lang: unknown) => ((lang as { wsV2: { from: Record<string, string> } }).wsV2.from);
    for (const p of phrases) {
      expect(from(en)[p], `en ${p}`).toBeTruthy();
      expect(from(ro)[p], `ro ${p}`).toBeTruthy();
    }
  });
});

describe("the redesign's strings", () => {
  type Tree = Record<string, unknown>;
  const flat = (o: Tree, p = ""): Record<string, string> =>
    Object.entries(o).reduce<Record<string, string>>((acc, [k, v]) => {
      const key = p ? `${p}.${k}` : k;
      if (v && typeof v === "object") Object.assign(acc, flat(v as Tree, key));
      else acc[key] = String(v);
      return acc;
    }, {});
  const EN = flat((en as unknown as Tree).wsV2 as Tree);
  const RO = flat((ro as unknown as Tree).wsV2 as Tree);
  // Plural forms differ by language (RO has `_few`); compare base keys.
  const base = (k: string) => k.replace(/_(one|few|many|other)$/, "");

  it("RO and EN carry the same keys, every one filled", () => {
    expect([...new Set(Object.keys(RO).map(base))].sort()).toEqual([...new Set(Object.keys(EN).map(base))].sort());
    for (const v of [...Object.values(EN), ...Object.values(RO)]) expect(v.trim()).not.toBe("");
  });

  it("no 'source' / 'attachment' language, in either", () => {
    for (const v of Object.values(EN)) expect(v).not.toMatch(/\b(source|attachment|attached)\b/i);
    for (const v of Object.values(RO)) expect(v).not.toMatch(/surs[ăae]|ata[șs]a/i);
  });

  it("the owner's words, exactly", () => {
    expect(RO["card.analyse"]).toBe("Analizează");
    expect(RO["card.change"]).toBe("Modifică");
    expect(RO["card.newCompany"]).toBe("Companie nouă");
    expect(RO["duplicate.open"]).toBe("Deja încărcat — deschide");
    expect(RO["from.document_header"]).toBe("din antetul documentului");
    expect(RO["from.registry"]).toBe("din registrul ONRC/MF");
    expect(EN["duplicate.open"]).toBe("Already uploaded — open it");
    expect(EN["from.document_header"]).toBe("from the document header");
  });
});
