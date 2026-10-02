// AutoMasters screens — each mounts on the sample export and shows what the
// model says it should; the writes and the chat call go to mocks.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import i18n from "@/i18n";
import { renderWithProviders } from "@/test/renderWithProviders";
import sample from "../../../../../docs/automasters/sample-import.json";
import { EMPTY_DATA, parseImport, type AmData } from "@/lib/automasters/model";
import "../amI18n";

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));

const writes = vi.hoisted(() => ({
  matchPayments: vi.fn(async (..._a: unknown[]) => {}),
  unmatchPayment: vi.fn(async (..._a: unknown[]) => {}),
  requestExportRetry: vi.fn(async (..._a: unknown[]) => ({ ok: true })),
  openClosePeriod: vi.fn(async (..._a: unknown[]) => {}),
  setCloseCheck: vi.fn(async (..._a: unknown[]) => {}),
  closeMonth: vi.fn(async (..._a: unknown[]) => ({ ok: true })),
}));
vi.mock("@/lib/automasters/data", () => writes);

const chat = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ answer: "Used Cars is 6.1% under budget.", model: null, usage: null })));
vi.mock("@/lib/cfoApi", async (orig) => ({
  ...(await orig<typeof import("@/lib/cfoApi")>()),
  cfoApi: { chatLlm: chat },
}));

import { AskView, PerformanceView, ProfitCentresView } from "../ManagementViews";
import { CloseView, ExportsView, PaymentsView } from "../FinanceViews";

function data(extra: Partial<AmData> = {}): AmData {
  const r = parseImport(sample);
  if ("errors" in r) throw new Error(r.errors.join());
  const p = r.payload;
  return {
    ...EMPTY_DATA,
    bank: p.bank_lines.map((b, i) => ({ ...b, id: `b${i}` })),
    documents: p.documents.map((d, i) => ({ ...d, id: `d${i}` })),
    exports: p.exports.map((e, i) => ({ ...e, id: `e${i}`, retry_requested_at: null, updated_at: "2026-09-24T10:00:00Z" })),
    centres: p.centres,
    funnel: p.funnel,
    ...extra,
  };
}

const noop = () => {};

beforeEach(async () => {
  await i18n.changeLanguage("en");
  Object.values(writes).forEach((f) => f.mockClear());
  chat.mockClear();
});

describe("Management", () => {
  it("performance: year-to-date figures, month bars and the funnel", () => {
    renderWithProviders(<PerformanceView data={data()} period="2026-09" onImport={noop} />);
    expect(screen.getByText("Revenue 2026 to date")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(9 + 5);
    expect(screen.getByText("Expression of Interest")).toBeTruthy();
    expect(screen.getByText("88% from previous")).toBeTruthy();
  });

  it("performance: empty state points at the import", () => {
    renderWithProviders(<PerformanceView data={EMPTY_DATA} period="2026-09" onImport={noop} />);
    expect(screen.getByText("No monthly figures yet")).toBeTruthy();
  });

  it("profit centres: sorted by margin, detail follows the selection, Ask hands over a question", () => {
    const onAsk = vi.fn();
    renderWithProviders(<ProfitCentresView data={data()} period="2026-09" onImport={noop} onAsk={onAsk} />);
    expect(screen.getByText("Detail · New Cars")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Used Cars/ }));
    expect(screen.getByText("Detail · Used Cars")).toBeTruthy();
    expect(screen.getByText(/two trade-ins over 120 days/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Ask CFO AI/ }));
    expect(onAsk).toHaveBeenCalledWith("How is the Used Cars profit centre doing against budget, and why?");
  });

  it("ask: sends the question with the dealership snapshot and shows the answer", async () => {
    renderWithProviders(
      <AskView data={data()} companyName="Bitton FR" initialQuestion={null} onConsumeInitial={noop} />,
    );
    expect(screen.getByText("Warranty: material DMS ↔ ledger difference")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Which profit centres are below budget, and why?" }));
    await waitFor(() => expect(screen.getByText("Used Cars is 6.1% under budget.")).toBeTruthy());
    const req = chat.mock.calls[0][0] as { mode: string; dataset_summary: string; messages: unknown[] };
    expect(req.mode).toBe("workspace");
    expect(req.dataset_summary).toContain("Warranty: DMS 46200.00 vs ledger 42780.00");
    expect(req.messages).toEqual([{ role: "user", content: "Which profit centres are below budget, and why?" }]);
  });

  it("ask: a question handed over from another screen is sent once", async () => {
    const consume = vi.fn();
    renderWithProviders(
      <AskView data={data()} companyName={null} initialQuestion="What is blocking the close?" onConsumeInitial={consume} />,
    );
    await waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
    expect(consume).toHaveBeenCalled();
  });
});

describe("Finance", () => {
  it("payments: auto-match sends the DMS's suggestions", async () => {
    renderWithProviders(<PaymentsView data={data()} orgId="org" refresh={noop} onImport={noop} />);
    fireEvent.click(screen.getByRole("button", { name: /Auto-match \(4\)/ }));
    await waitFor(() => expect(writes.matchPayments).toHaveBeenCalled());
    const [org, pairs, method] = writes.matchPayments.mock.calls[0] as unknown as [string, unknown[], string];
    expect(org).toBe("org");
    expect(pairs).toHaveLength(4);
    expect(method).toBe("auto");
  });

  it("payments: a manual pair states its difference", async () => {
    renderWithProviders(<PaymentsView data={data()} orgId="org" refresh={noop} onImport={noop} />);
    const [bankRow, docRow] = screen.getAllByRole("button", { name: /Dan Constantinescu/ });
    fireEvent.click(bankRow);
    fireEvent.click(docRow);
    expect(screen.getByText("The difference is booked as an accounting note by Finance.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Match$/ }));
    await waitFor(() => expect(writes.matchPayments).toHaveBeenCalled());
    const pairs = writes.matchPayments.mock.calls[0][1] as unknown as Array<{ difference: number }>;
    expect(pairs[0].difference).toBe(12.5);
  });

  it("exports: failed first, error shown, retry asks the DMS", async () => {
    renderWithProviders(<ExportsView data={data()} refresh={noop} onImport={noop} />);
    expect(screen.getByText(/Account 4111 is not mapped/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Reprocess the batch/ }));
    await waitFor(() => expect(writes.requestExportRetry).toHaveBeenCalledWith("e0"));
    fireEvent.click(screen.getByRole("tab", { name: /RO e-Factura/ }));
    expect(screen.getByText(/the buyer's CUI is not valid/)).toBeTruthy();
  });

  it("close: not started offers to start", async () => {
    renderWithProviders(<CloseView data={data()} orgId="org" period="2026-09" refresh={noop} />);
    fireEvent.click(screen.getByRole("button", { name: "Start the close" }));
    await waitFor(() => expect(writes.openClosePeriod).toHaveBeenCalledWith("org", "2026-09"));
  });

  it("close: blocked by the material centre, with the reason beside the button", () => {
    const d = data({
      periods: [{ period: "2026-09", status: "open", closed_at: null }],
      checks: [{ period: "2026-09", check_key: "fx_rate", position: 0, done: true, done_at: null }],
    });
    renderWithProviders(<CloseView data={d} orgId="org" period="2026-09" refresh={noop} />);
    expect(screen.getByText(/Close blocked: material difference in Warranty/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Close the month" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Minor drift")).toBeTruthy();
  });

  it("close: ticking a check writes it", async () => {
    const d = data({
      periods: [{ period: "2026-09", status: "open", closed_at: null }],
      checks: [{ period: "2026-09", check_key: "saga_export_clean", position: 0, done: false, done_at: null }],
    });
    renderWithProviders(<CloseView data={d} orgId="org" period="2026-09" refresh={noop} />);
    expect(screen.getByText("1 SAGA batch in error")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(writes.setCloseCheck).toHaveBeenCalledWith("org", "2026-09", "saga_export_clean", true, "u1"));
  });
});
