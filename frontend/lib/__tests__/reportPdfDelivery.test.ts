// G-P2 — THE DELIVERY: what the file is called, and what the wait says.
//
// Two surfaces, both of which decide something a user sees:
//
//   `services/pdf/filename.mjs` — the name the file lands under, and the
//   string that goes into a `Content-Disposition` header. It is imported
//   here from the SERVICE, not re-implemented, because the service is
//   the single authority for it and a mirrored copy in the test would
//   pass while the shipped one drifted.
//
//   `frontend/lib/reportPdf.ts` — the poll loop's reading of the job.
//
// WHAT THIS FILE REDS ON, once the product is correct (TC-11):
//   · any character reaching a filename that is not `[A-Za-z0-9_]`,
//     which is what makes header injection and path traversal
//     structurally impossible rather than individually handled;
//   · a Romanian name degrading to underscores instead of being
//     transliterated;
//   · the poll loop reading an unknown state as anything but a failure;
//   · a queue position of "unknown" being reported as "next".
//
// WHAT IT CANNOT SEE: the network. `requestReportPdf` is exercised
// against a stubbed `fetch`, so this file proves the state machine, not
// that the engine route exists. That is `scripts/check_report_pdf.mjs`
// and the engine's own route-binding gate.

import { describe, it, expect, vi, afterEach } from "vitest";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain ESM from the sidecar; there is no .d.ts and there
// should not be one, because duplicating the contract in types is the
// same drift this import exists to avoid.
import { reportFilename, filenamePart, filenameIsSafe } from "../../../services/pdf/filename.mjs";

import { parseQueuePosition, pollDelayMs, requestReportPdf } from "@/lib/reportPdf";

const SAFE = /^[A-Za-z0-9_]+\.pdf$/;

describe("§1 the filename is an allowlist, and that is the security property", () => {
  it("produces the shape the owner asked for", () => {
    expect(reportFilename("Agras Impex SRL", "FY2025")).toBe(
      "Agras_Impex_SRL_FY2025_CFO_Report.pdf",
    );
  });

  it("transliterates Romanian rather than shredding it", () => {
    // Both spellings in the wild: comma-below (U+0218/U+021A) and the
    // legacy cedilla (U+015E/U+0162). A name that came back as
    // `SOCIETATEA_AGRICOL_` would look like a bug to the firm that owns it.
    expect(filenamePart("SOCIETATEA AGRICOLĂ ȘTEFAN ȚARĂ", "X")).toBe(
      "SOCIETATEA_AGRICOLA_STEFAN_TARA",
    );
    expect(filenamePart("Şoseaua Ţării", "X")).toBe("Soseaua_Tarii");
  });

  it("cannot be made to traverse a path", () => {
    const name = reportFilename("../../etc/passwd", "..");
    expect(name).toMatch(SAFE);
    expect(name).not.toContain("/");
    expect(name).not.toContain("..");
  });

  it("cannot be made to inject a header", () => {
    // A CR/LF in a `Content-Disposition` value appends a header of the
    // attacker's choosing to the response.
    const name = reportFilename('x"\r\nSet-Cookie: a=b', "FY2025");
    expect(name).toMatch(SAFE);
    expect(name).not.toMatch(/[\r\n"]/);
  });

  it("cannot be made to spoof its own extension", () => {
    // U+202E RIGHT-TO-LEFT OVERRIDE renders `report<RLO>fdp.exe` as
    // `reportexe.pdf` in most file managers. It is the standard
    // filename-spoofing trick, and it is removed, not escaped.
    const name = reportFilename("report‮fdp.exe", "FY2025");
    expect(name).toMatch(SAFE);
    expect(name).not.toContain("‮");
    expect(name.endsWith(".pdf")).toBe(true);
  });

  it("cannot be made to hide the file or grow a second extension", () => {
    expect(reportFilename(".hidden", "FY2025.")).toMatch(SAFE);
    expect(reportFilename("report.pdf", "x")).toBe("report_pdf_x_CFO_Report.pdf");
  });

  it("survives a name Windows refuses outright", () => {
    // `CON.pdf` is not a creatable file on Windows, with or without an
    // extension — the download would fail on the one operating system
    // an accounting firm is likeliest to be using.
    expect(filenamePart("CON", "X")).toBe("_CON");
    expect(filenamePart("con", "X")).toBe("_con");
    expect(filenamePart("COM4", "X")).toBe("_COM4");
  });

  it("names a file even when nothing survives the allowlist", () => {
    // `_CFO_Report.pdf` reads as a bug. A word reads as a name.
    expect(reportFilename("НАЗВАНИЕ", "期間")).toBe("Company_Period_CFO_Report.pdf");
    expect(reportFilename("", "")).toBe("Company_Period_CFO_Report.pdf");
  });

  it("stays inside every filesystem's length limit", () => {
    const name = reportFilename("A".repeat(400), "B".repeat(400));
    expect(name.length).toBeLessThanOrEqual(150);
    expect(filenameIsSafe(name)).toBe(true);
  });

  it("`filenameIsSafe` is the module's own claim, and it holds on hostile input", () => {
    const hostile = [
      "../../etc/passwd",
      'x"\r\nSet-Cookie: a=b',
      "report‮fdp.exe",
      "CON",
      "",
      "НАЗВАНИЕ",
      "  .  ",
      "a\0b",
      "SOCIETATEA AGRICOLĂ",
      "A".repeat(400),
    ];
    for (const company of hostile) {
      const name = reportFilename(company, "FY2025");
      expect(filenameIsSafe(name), `${JSON.stringify(company)} → ${name}`).toBe(true);
      expect(name, `${JSON.stringify(company)} → ${name}`).toMatch(SAFE);
    }
  });
});

describe("§2 the wait has a state, not a spinner", () => {
  it("reads a queue position when the service reported one", () => {
    expect(parseQueuePosition("Waiting for a renderer — 3 ahead")).toBe(3);
  });

  it("reports ABSENT rather than zero when it cannot tell", () => {
    // "we do not know where you are in the queue" and "you are next" are
    // different facts, and a UI that renders 0 states the second one.
    expect(parseQueuePosition("Starting the renderer")).toBeNull();
    expect(parseQueuePosition("")).toBeNull();
  });

  it("polls fast, then backs off, on a fixed ladder", () => {
    // Most renders finish inside a second; a two-second first poll makes
    // a 300 ms job feel slow. Deterministic, so a test can reason about
    // it — no jitter.
    expect([0, 1, 2, 3].map(pollDelayMs)).toEqual([250, 250, 250, 250]);
    expect(pollDelayMs(4)).toBe(600);
    expect(pollDelayMs(10)).toBe(1500);
    expect(pollDelayMs(999)).toBe(1500);
  });
});

describe("§3 the client walks the job to a file", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(responses: Array<() => Response>) {
    let i = 0;
    const calls: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      calls.push(String(url));
      const next = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return Promise.resolve(next());
    });
    return calls;
  }

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  it("queued → rendering → done, and reports each step", async () => {
    const calls = stubFetch([
      () => json(202, { job_id: "j1", state: "queued", progress: "Waiting for a renderer — 2 ahead" }),
      () => json(200, { state: "rendering", progress: "Laying the document out on A4 and paginating it" }),
      () =>
        json(200, {
          state: "done",
          progress: "Ready — 31 pages",
          pages: 31,
          filename: "Agras_FY2025_CFO_Report.pdf",
        }),
      () => new Response(new Blob([new Uint8Array([37, 80, 68, 70])]), { status: 200 }),
    ]);
    const seen: string[] = [];
    const pdf = await requestReportPdf("<html></html>", { company: "Agras", period: "FY2025" }, {
      onProgress: (p) => seen.push(`${p.state}:${p.queuePosition ?? "-"}`),
    });
    expect(seen).toEqual(["queued:2", "rendering:-", "done:-"]);
    expect(pdf.filename).toBe("Agras_FY2025_CFO_Report.pdf");
    expect(pdf.pages).toBe(31);
    expect(calls[0]).toMatch(/\/api\/report\/pdf$/);
    expect(calls[3]).toMatch(/\/api\/report\/pdf\/j1\/file$/);
  });

  it("uses the name the SERVICE decided, never one derived a second time", async () => {
    stubFetch([
      () => json(202, { job_id: "j1", state: "queued", progress: "Starting the renderer" }),
      () => json(200, { state: "done", pages: 2, filename: "Weird_But_Server_Chose_It.pdf" }),
      () => new Response(new Blob([new Uint8Array([1])]), { status: 200 }),
    ]);
    const pdf = await requestReportPdf("<html></html>", { company: "Something Else", period: "X" });
    expect(pdf.filename).toBe("Weird_But_Server_Chose_It.pdf");
  });

  it("surfaces the server's own refusal, not a generic failure", async () => {
    // 503 means "this deployment has no renderer configured" and 401
    // means "your session expired". A user can act on either; "export
    // failed" hides both.
    stubFetch([() => json(503, { detail: "PDF rendering is not configured on this deployment" })]);
    await expect(
      requestReportPdf("<html></html>", { company: "A", period: "B" }),
    ).rejects.toThrow(/not configured/);
  });

  it("a failed render throws the renderer's reason", async () => {
    stubFetch([
      () => json(202, { job_id: "j1", state: "queued", progress: "Starting the renderer" }),
      () => json(200, { state: "failed", error: "Timeout 60000ms exceeded", progress: "Failed" }),
    ]);
    await expect(
      requestReportPdf("<html></html>", { company: "A", period: "B" }),
    ).rejects.toThrow(/Timeout/);
  });

  it("an unrecognised state is a failure, not a silent hang", async () => {
    stubFetch([
      () => json(202, { job_id: "j1", state: "queued", progress: "Starting the renderer" }),
      () => json(200, { state: "elaborating" }),
    ]);
    await expect(
      requestReportPdf("<html></html>", { company: "A", period: "B" }),
    ).rejects.toThrow();
  });

  it("gives up with a message that names what it was waiting on", async () => {
    stubFetch([
      () => json(202, { job_id: "j1", state: "queued", progress: "Waiting for a renderer — 9 ahead" }),
      () => json(200, { state: "queued", progress: "Waiting for a renderer — 9 ahead" }),
    ]);
    await expect(
      requestReportPdf("<html></html>", { company: "A", period: "B" }, { deadlineMs: 400 }),
    ).rejects.toThrow(/still queued/);
  });
});
