// alreadyUploaded.ts — where "Already uploaded — open it" leads.
//
// Owner spec (2026-09-21): a duplicate upload (same file bytes, same
// account, same company, same period) is not stored, not analysed and not
// counted; the user is sent to the analysis that already exists. A financial
// document opens its analysed period on the dashboard; while the original is
// still running (no period yet) the dashboard itself, where its progress
// shows. A SKU workbook lives on the Products page.
import type { AlreadyUploaded } from "@/lib/supabase";

export function alreadyUploadedHref(
  dup: Pick<AlreadyUploaded, "periodId">,
  surface: "financial" | "sku" = "financial",
): string {
  if (surface === "sku") return "/products";
  return dup.periodId ? `/dashboard?period=${encodeURIComponent(dup.periodId)}` : "/dashboard";
}
