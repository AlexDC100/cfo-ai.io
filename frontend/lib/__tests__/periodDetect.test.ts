// PERIOD DETECTION — the frontend client for the engine's hint-free
// detection service (`/api/period/detect`, Part B), plus the entity
// identity it reads off the same header bytes.
//
// WHY THIS FILE EXISTS
// ────────────────────
// `documents.period_end_hint` is a CONFIRMATION channel: "a human
// confirmed that THIS document belongs to THIS month". PeriodsSection
// filled it with the DROP TARGET's date, so the engine — which ranks
// the hint above its own correct detection precisely because the hint
// is supposed to mean a human confirmation — dutifully filed a 2025
// Carniprod trial balance under 2017-12.
//
// The client below is what makes a REAL confirmation possible: it asks
// the document, never the UI. These tests pin that at the wire.
//
// LAWS UNDER TEST
//   W1  UI state is not an input. The request body carries exactly
//       {filename, extracted} and `extracted` carries only bytes that
//       came off the document.
//   W3  ABSENT != ZERO. "Not detected" is a first-class answer that
//       never degrades into today, the open period, or the drop target.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({
  getSupabase: () => ({
    auth: {
      getSession: async () => ({
        data: { session: { access_token: "jwt-token", user: { id: "u1" } } },
      }),
    },
  }),
}));

vi.mock("@/lib/activePeriod", () => ({
  periodQueryKey: (id: string) => ["period", id],
  fetchPeriodFromApi: vi.fn(async () => ({
    kind: "ok" as const,
    data: { statements: { companyName: "SCANDIA REALESTATE SRL" } },
  })),
}));

import {
  ABSENT_DETECTION,
  buildDetectRequest,
  detectEntityFromHeader,
  detectPeriodFromEvidence,
  entitiesConflict,
  inspectDocument,
  resolvePeriodEntity,
} from "@/lib/periodDetect";

// The real preamble shape of a Romanian trial balance export (the
// production Carniprod case, trimmed).
const CARNIPROD_HEADER = [
  "S.C. CARNIPROD S.R.L.",
  "C.U.I.: RO 1234567   Reg. Com.: J37/123/1994",
  "BALANTA DE VERIFICARE la data de 31.12.2025",
  "Simbol cont  Denumire cont  Sold initial  Rulaj  Sold final",
].join("\n");

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

const ENGINE_ANSWER = {
  proposed_period_end: "2025-12-31",
  confidence: 0.85,
  signal_used: "closing_balance",
  evidence_snippet: "BALANTA DE VERIFICARE la data de 31.12.2025",
  candidates: [
    {
      signal: "closing_balance",
      period_end: "2025-12-31",
      evidence_snippet: "BALANTA DE VERIFICARE la data de 31.12.2025",
    },
    {
      signal: "filename",
      period_end: "2025-12-31",
      evidence_snippet: "Carniprod Trial Balance 2025.xlsx",
    },
  ],
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => jsonResponse(ENGINE_ANSWER));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ─── W1 — the wire carries the document, and nothing else ────────────────

describe("buildDetectRequest — W1: UI state is unrepresentable", () => {
  it("sends exactly {filename, extracted}", () => {
    const body = buildDetectRequest({
      filename: "Carniprod Trial Balance 2025.xlsx",
      headerText: CARNIPROD_HEADER,
    });
    expect(Object.keys(body).sort()).toEqual(["extracted", "filename"]);
  });

  it("carries only document-derived keys inside `extracted`", () => {
    const body = buildDetectRequest({
      filename: "x.xlsx",
      headerText: CARNIPROD_HEADER,
    });
    // The engine's POST model is extra="forbid": anything outside its
    // contract is a 422, so the allowlist here IS the contract.
    for (const key of Object.keys(body.extracted ?? {})) {
      expect(["header_text", "document_text", "preamble"]).toContain(key);
    }
  });

  it("has no channel for the drop target / open period, at any depth", () => {
    const body = buildDetectRequest({
      filename: "x.xlsx",
      headerText: CARNIPROD_HEADER,
    });
    const serialized = JSON.stringify(body).toLowerCase();
    for (const forbidden of [
      "open_period",
      "active_period",
      "target_period",
      "period_id",
      "period_end_hint",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("omits `extracted` entirely when the file's bytes could not be read", () => {
    const body = buildDetectRequest({ filename: "scan.pdf", headerText: "" });
    expect(body.extracted).toBeNull();
    expect(body.filename).toBe("scan.pdf");
  });
});

describe("detectPeriodFromEvidence — the engine's answer, mapped verbatim", () => {
  it("POSTs to /api/period/detect with the bearer token", async () => {
    await detectPeriodFromEvidence({
      filename: "Carniprod Trial Balance 2025.xlsx",
      headerText: CARNIPROD_HEADER,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/period/detect");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer jwt-token",
    );
  });

  it("maps the five contract keys and keeps the candidates", async () => {
    const d = await detectPeriodFromEvidence({
      filename: "Carniprod Trial Balance 2025.xlsx",
      headerText: CARNIPROD_HEADER,
    });
    expect(d.proposedPeriodEnd).toBe("2025-12-31");
    expect(d.signalUsed).toBe("closing_balance");
    expect(d.confidence).toBe(0.85);
    expect(d.evidenceSnippet).toBe("BALANTA DE VERIFICARE la data de 31.12.2025");
    expect(d.candidates).toHaveLength(2);
    expect(d.origin).toBe("engine");
  });

  it("W3 — `signal_used: none` stays ABSENT, never a fallback date", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        proposed_period_end: null,
        confidence: 0,
        signal_used: "none",
        evidence_snippet: null,
        candidates: [],
      }),
    );
    const d = await detectPeriodFromEvidence({ filename: "scan.pdf", headerText: "" });
    expect(d.proposedPeriodEnd).toBeNull();
    expect(d.signalUsed).toBe("none");
    expect(d.confidence).toBe(0);
  });

  it("falls back to the browser reader when the engine is unreachable", async () => {
    fetchMock.mockRejectedValueOnce(new Error("connection refused"));
    const d = await detectPeriodFromEvidence({
      filename: "Carniprod Trial Balance 2025.xlsx",
      headerText: CARNIPROD_HEADER,
    });
    // Still the DOCUMENT's own evidence — just read here instead of there.
    expect(d.proposedPeriodEnd).toBe("2025-12-31");
    expect(d.origin).toBe("browser");
    expect(d.signalUsed).toBe("closing_balance");
  });

  it("W3 — engine down AND nothing readable is ABSENT, not today", async () => {
    fetchMock.mockRejectedValueOnce(new Error("connection refused"));
    const d = await detectPeriodFromEvidence({ filename: "export.xlsx", headerText: "" });
    expect(d.proposedPeriodEnd).toBeNull();
    expect(d.signalUsed).toBe("none");
    expect(d.origin).toBe("unavailable");
    const today = new Date().toISOString().slice(0, 10);
    expect(d.proposedPeriodEnd).not.toBe(today);
  });

  it("ABSENT_DETECTION is the shared shape of 'not detected'", () => {
    expect(ABSENT_DETECTION.proposedPeriodEnd).toBeNull();
    expect(ABSENT_DETECTION.signalUsed).toBe("none");
    expect(ABSENT_DETECTION.confidence).toBe(0);
    expect(ABSENT_DETECTION.candidates).toEqual([]);
  });
});

// ─── entity identity — the second guard's evidence ───────────────────────

describe("detectEntityFromHeader", () => {
  it("reads the company name and CUI off a Romanian trial-balance preamble", () => {
    const e = detectEntityFromHeader(CARNIPROD_HEADER);
    expect(e.name).toBe("S.C. CARNIPROD S.R.L.");
    expect(e.cui).toBe("1234567");
  });

  it("ABSENT != ZERO — an unreadable header yields nulls, never a guess", () => {
    const e = detectEntityFromHeader("");
    expect(e.name).toBeNull();
    expect(e.cui).toBeNull();
  });
});

describe("entitiesConflict — the production Agras/Scandia case", () => {
  it("flags two different companies sharing one month", () => {
    expect(
      entitiesConflict(
        { name: "S.C. CARNIPROD S.R.L.", cui: "1234567", evidence: null },
        { name: "SCANDIA REALESTATE SRL", cui: null, evidence: null },
      ),
    ).toBe(true);
  });

  it("does not flag the same company written differently", () => {
    expect(
      entitiesConflict(
        { name: "S.C. Scandia RealEstate S.R.L.", cui: null, evidence: null },
        { name: "SCANDIA REALESTATE SRL", cui: null, evidence: null },
      ),
    ).toBe(false);
  });

  it("trusts the CUI over the name when both sides have one", () => {
    expect(
      entitiesConflict(
        { name: "SCANDIA FOOD SRL", cui: "RO 1234567", evidence: null },
        { name: "Scandia Food (renamed)", cui: "1234567", evidence: null },
      ),
    ).toBe(false);
    expect(
      entitiesConflict(
        { name: "SCANDIA FOOD SRL", cui: "1234567", evidence: null },
        { name: "SCANDIA FOOD SRL", cui: "7654321", evidence: null },
      ),
    ).toBe(true);
  });

  it("ABSENT on either side never fires the guard", () => {
    const known = { name: "S.C. CARNIPROD S.R.L.", cui: "1234567", evidence: null };
    expect(entitiesConflict(known, { name: null, cui: null, evidence: null })).toBe(false);
    expect(entitiesConflict(null, known)).toBe(false);
    expect(entitiesConflict(known, null)).toBe(false);
  });
});

describe("resolvePeriodEntity — what the target month already holds", () => {
  it("reads the company off the period's own analysis", async () => {
    const e = await resolvePeriodEntity("period-1");
    expect(e?.name).toBe("SCANDIA REALESTATE SRL");
  });
});

describe("inspectDocument — one read, both guards", () => {
  it("returns the detection and the entity from the same bytes", async () => {
    const file = new File([CARNIPROD_HEADER], "Carniprod Trial Balance 2025.csv", {
      type: "text/csv",
    });
    const { detection, entity } = await inspectDocument(file);
    expect(detection.proposedPeriodEnd).toBe("2025-12-31");
    expect(entity.name).toBe("S.C. CARNIPROD S.R.L.");
  });
});
