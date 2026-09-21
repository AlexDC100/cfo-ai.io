// industryLabel.ts — the words for a company's industry, never its key.
//
// A company's industry is stored as a catalog key (`organizations.industry_key`,
// e.g. "food_manufacturing") with an optional stored display name. The
// workspace-settings industries (ORG_INDUSTRIES) have their own translated
// labels; every other key is labelled by the SAME `industry_profiles` catalog
// the engine labels a new company from (GET /api/industry/profiles, RO label
// for RO readers). When none of those can name it, there is no label at all —
// a raw key like "food_manufacturing" is never printed (plain language).
//
// The query key is shared with the confirmation card's industry list
// (UploadFlowHost), so one catalog read serves both.

import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { ORG_INDUSTRIES, orgIndustryDisplayLabel } from "@/components/cfo/OrgIndustryPills";
import { listProfiles, type IndustryProfileSummary } from "@/lib/industryApi";

export const INDUSTRY_CATALOG_QUERY_KEY = ["industry-profiles", "upload-card"] as const;

/** Pure: the readable label for `key`, or null. Exported for tests. */
export function industryLabelFor(
  key: string | null | undefined,
  storedName: string | null | undefined,
  catalog: ReadonlyArray<Pick<IndustryProfileSummary, "key" | "display_name" | "display_name_ro">> | undefined,
  romanian: boolean,
): string | null {
  if (!key) return null;
  if (ORG_INDUSTRIES.some((i) => i.key === key)) return orgIndustryDisplayLabel(key);
  const profile = catalog?.find((p) => p.key === key);
  const fromCatalog = profile ? ((romanian ? profile.display_name_ro : null) || profile.display_name || null) : null;
  if (fromCatalog && fromCatalog.trim()) return fromCatalog.trim();
  const stored = (storedName ?? "").trim();
  return stored && stored !== key ? stored : null;
}

/** The industry catalog (null while unread or unreadable — callers fall back). */
export function useIndustryCatalog(): IndustryProfileSummary[] | undefined {
  const q = useQuery({
    queryKey: INDUSTRY_CATALOG_QUERY_KEY,
    queryFn: () => listProfiles(),
    staleTime: 60 * 60 * 1000,
    retry: false,
  });
  return q.data;
}

/** Hook form of `industryLabelFor` for the reader's language. */
export function useIndustryLabel(key: string | null | undefined, storedName?: string | null): string | null {
  const { i18n } = useTranslation();
  const catalog = useIndustryCatalog();
  return industryLabelFor(key, storedName ?? null, catalog, (i18n.language ?? "").startsWith("ro"));
}
