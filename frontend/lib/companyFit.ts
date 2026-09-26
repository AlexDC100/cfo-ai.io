// companyFit.ts — which questions FIT this company (design C3, the swap
// test for suggestions).
//
// A rent-only debt-service coverage question is a property company's
// question. Offered to a food manufacturer it is the "generic suggestion"
// the owner ruled out (2026-09-26: "never a question that doesn't fit the
// company — no 'rent-only DSCR' on a manufacturer"). Whether a company is
// a property / rental business is READ, never inferred here:
//
//   · the workspace's own industry key (organizations.industry_key,
//     chosen at onboarding: real_estate, real_estate_residential, …); or
//   · the engine's structural industry signal on the served period
//     (`industry_signal`, structural-industry-signal/1 — the ACCOUNT MIX:
//     rent income, investment property), and only when it is DECIDED.
//
// Unknown is not rental: with neither signal, the question is not offered.

export interface CompanyFitInput {
  industryKey?: string | null;
  industrySignal?: { family?: unknown; verdict?: unknown } | null;
}

export function isRentalCompany(input: CompanyFitInput): boolean {
  const key = (input.industryKey ?? "").toLowerCase();
  if (key.startsWith("real_estate")) return true;
  const sig = input.industrySignal;
  return !!sig && sig.verdict === "decided" && sig.family === "real_estate";
}
