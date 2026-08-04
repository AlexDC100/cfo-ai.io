// Date-only strings must render identically in every viewer timezone —
// backend dates are UTC and a period ending 2025-12-01 must never show
// as November for a viewer west of Greenwich. Run under multiple TZs:
//   TZ=Asia/Dubai npx vitest run frontend/lib/__tests__/localeDates.test.ts
//   TZ=America/New_York npx vitest run frontend/lib/__tests__/localeDates.test.ts
// (vitest.config runs it under the machine default too.)

import { describe, expect, it } from "vitest";

import { formatDateOnly } from "@/lib/locale";
import { formatPeriodMonth, formatPeriodYear } from "@/lib/orgPeriods";

describe(`date-only rendering is timezone-proof (TZ=${process.env.TZ ?? "default"})`, () => {
  it("first-of-month period end stays in its own month", () => {
    expect(formatPeriodMonth("2025-12-01")).toBe("Dec 2025");
    expect(formatPeriodMonth("2026-01-01")).toBe("Jan 2026");
  });

  it("last-of-month period end stays in its own month", () => {
    expect(formatPeriodMonth("2025-12-31")).toBe("Dec 2025");
  });

  it("year label never shifts across the new-year boundary", () => {
    expect(formatPeriodYear("2026-01-01")).toBe("2026");
    expect(formatPeriodYear("2025-12-31")).toBe("2025");
  });

  it("locale-aware month names follow the requested locale", () => {
    expect(formatPeriodMonth("2025-12-31", "ro-RO")).toMatch(/dec\.? 2025/i);
  });

  it("formatDateOnly pins to UTC", () => {
    // en-GB medium date for 1 Dec — would be "30 Nov" in New York without
    // the timeZone pin.
    expect(formatDateOnly("2025-12-01")).toContain("Dec");
    expect(formatDateOnly("2025-12-01")).toContain("1");
  });
});
