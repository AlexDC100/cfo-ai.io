import { describe, expect, it } from "vitest";

import { pickActiveSourceDoc } from "@/lib/activeSourceDoc";

describe("pickActiveSourceDoc — the file backing the analysis", () => {
  it("picks the most recently analyzed financial doc among duplicates", () => {
    const docs = [
      { id: "old", status: "analyzed", scope: "financial", updated_at: "2026-05-30T10:00:00Z" },
      { id: "new", status: "analyzed", scope: "financial", updated_at: "2026-08-02T10:00:00Z" },
    ];
    expect(pickActiveSourceDoc(docs)?.id).toBe("new");
  });

  it("ignores SKU-scope documents entirely", () => {
    const docs = [
      { id: "sku", status: "analyzed", scope: "sku", updated_at: "2026-08-03T10:00:00Z" },
      { id: "fin", status: "analyzed", scope: "financial", updated_at: "2026-08-01T10:00:00Z" },
    ];
    expect(pickActiveSourceDoc(docs)?.id).toBe("fin");
  });

  it("falls back to the first non-SKU doc when none analyzed yet", () => {
    const docs = [
      { id: "pending", status: "extracting", scope: "financial", created_at: "2026-08-02T10:00:00Z" },
    ];
    expect(pickActiveSourceDoc(docs)?.id).toBe("pending");
  });

  it("uses uploaded_at when updated_at is absent (workspace feed shape)", () => {
    const docs = [
      { id: "a", status: "analyzed", scope: null, uploaded_at: "2026-06-01T00:00:00Z" },
      { id: "b", status: "analyzed", scope: null, uploaded_at: "2026-08-01T00:00:00Z" },
    ];
    expect(pickActiveSourceDoc(docs)?.id).toBe("b");
  });

  it("returns null for empty input", () => {
    expect(pickActiveSourceDoc([])).toBeNull();
    expect(pickActiveSourceDoc(null)).toBeNull();
  });
});
