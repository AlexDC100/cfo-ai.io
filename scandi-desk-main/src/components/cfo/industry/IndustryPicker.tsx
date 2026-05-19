// IndustryPicker — the Phase D replacement for IndustryConfirmModal.
//
// Differences from the legacy modal
// ─────────────────────────────────
//   · Reads from the new /api/industry/* surface (industry_key, not CAEN).
//   · Shows the full DetectResponse (primary + 3 alternatives) instead of a
//     single suggestion.
//   · Catalog is sectioned by `sector` (90+ industries) with search.
//   · Persists via POST /api/industry/assignment/{period_id} — writes to
//     company_industry_assignments + industry_change_audit_log + busts
//     benchmark_reports cache server-side.
//   · Lock toggle is a first-class control in the footer.
//   · Recalc button runs detection on demand (returns 409 if locked).
//
// Composition: keeps the same right-side slide-in shell + backdrop +
// ESC-to-close keyboard handling as the legacy modal so existing tests
// targeting `[data-testid=industry-modal-backdrop]` keep passing.

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, Lock, RefreshCw, Search, Unlock, X } from "lucide-react";

import { useToast } from "@/hooks/use-toast";
import { useIndustryAssignment } from "@/hooks/useIndustryAssignment";
import type {
  IndustryProfileDetail,
  IndustryProfileSummary,
  PeerCandidateRow,
} from "@/lib/industryApi";
import {
  IndustryApiError,
  getProfile,
  listProfiles,
  searchIndustries,
} from "@/lib/industryApi";
import {
  INDUSTRY_GROUP_LABELS,
  type IndustryGroupKey,
  sectorOrderIndex,
  sectorToDisplayGroup,
} from "@/lib/industryGroups";

import { IndustrySuggestionCard, candidateToUpsertBody } from "./IndustrySuggestionCard";

interface Props {
  periodId: string;
  open: boolean;
  onClose: () => void;
  /** Called after a successful save / recalc / lock-toggle. */
  onChanged?: () => void;
}

export function IndustryPicker({ periodId, open, onClose, onChanged }: Props) {
  const { toast } = useToast();
  const closeRef = useRef<HTMLButtonElement>(null);

  // The hook is the single source of truth — assignment, detection,
  // mutating state, all in one place. Component-local state is for
  // the in-flight pick before the user clicks Save.
  const {
    assignment,
    detection,
    loading: assignmentLoading,
    mutating,
    error,
    periodNotFound,
    save,
    toggleLock,
    recalc,
  } = useIndustryAssignment(open ? periodId : null);

  const [profiles, setProfiles] = useState<IndustryProfileSummary[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [searchResults, setSearchResults] = useState<IndustryProfileSummary[] | null>(null);
  /** The user's in-flight selection, persisted only when they click Save. */
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  /** Detail row for the pending industry — fetched on demand so we can
   *  show the internal-brand note ("Sadu and Bucegi are brands within
   *  the Scandia group, not separate industry classifications") when
   *  relevant. */
  const [pendingDetail, setPendingDetail] = useState<IndustryProfileDetail | null>(null);

  // ── Open / close lifecycle ────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Sync pendingKey to the persisted choice on first load so the
  // checkbox / radio reflects what's currently saved.
  useEffect(() => {
    if (!open) {
      setPendingKey(null);
      setSearchTerm("");
      setSearchResults(null);
      return;
    }
    if (assignment) setPendingKey(assignment.selected_industry_key);
    else if (detection?.primary) setPendingKey(detection.primary.industry_key);
  }, [open, assignment, detection]);

  // ── Profile catalog (sector-grouped) ──────────────────────────
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setProfilesLoading(true);
    listProfiles()
      .then((rows) => { if (!cancelled) setProfiles(rows); })
      .catch(() => { if (!cancelled) setProfiles([]); })
      .finally(() => { if (!cancelled) setProfilesLoading(false); });
    return () => { cancelled = true; };
  }, [open]);

  // ── Pending-industry detail (for internal-brand note) ────────
  // We fetch the full detail only for the industry the user is hovering
  // on (pendingKey), not every catalog row. That keeps the picker
  // light: one detail fetch per selection change, debounced via the
  // cancelled flag. The detail surfaces `peers.is_internal_brand_default`
  // which becomes the "Sadu/Bucegi are Scandia brands" callout for the
  // food_manufacturing case (and any other industry where users
  // confuse internal brands with peer companies).
  useEffect(() => {
    if (!open || !pendingKey) { setPendingDetail(null); return; }
    let cancelled = false;
    getProfile(pendingKey)
      .then((d) => { if (!cancelled) setPendingDetail(d); })
      .catch(() => { if (!cancelled) setPendingDetail(null); });
    return () => { cancelled = true; };
  }, [open, pendingKey]);

  // ── Debounced server-side search ──────────────────────────────
  useEffect(() => {
    const q = searchTerm.trim();
    if (q.length < 2) {
      setSearchResults(null);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(() => {
      searchIndustries(q, 30)
        .then((rows) => { if (!cancelled) setSearchResults(rows); })
        .catch(() => { if (!cancelled) setSearchResults([]); });
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [searchTerm]);

  // ── Grouped catalog for the body list ─────────────────────────
  // Roll raw `sector` keys (food_manufacturing, real_estate, …) up to
  // human display groups (Food & FMCG, Real Estate, …) and order them
  // per the product taxonomy in `industryGroups.ts`. Within a group,
  // sort by display_name so the long Food & FMCG list reads top-down.
  const groupedBySector = useMemo<[IndustryGroupKey, IndustryProfileSummary[]][]>(() => {
    const rows = searchResults ?? profiles;
    const out = new Map<IndustryGroupKey, IndustryProfileSummary[]>();
    for (const r of rows) {
      const group = sectorToDisplayGroup(r.sector);
      if (!out.has(group)) out.set(group, []);
      out.get(group)!.push(r);
    }
    // Sort each group's rows alphabetically by display_name.
    for (const [, rs] of out) {
      rs.sort((a, b) => a.display_name.localeCompare(b.display_name));
    }
    // Sort groups by taxonomy order (Food & FMCG first, etc).
    return Array.from(out.entries()).sort(
      ([a], [b]) =>
        sectorOrderIndex(
          // Look up a representative sector for each group via reverse-mapping.
          // Cheap trick: pick the first row's sector in that group.
          (out.get(a)?.[0]?.sector ?? "") as string,
        ) -
        sectorOrderIndex((out.get(b)?.[0]?.sector ?? "") as string),
    );
  }, [profiles, searchResults]);

  // ── Actions ───────────────────────────────────────────────────

  const handleSave = async () => {
    if (!pendingKey) return;
    if (pendingKey === assignment?.selected_industry_key) {
      toast({ title: "No change — same industry already selected." });
      return;
    }
    const row = await save({
      selected_industry_key: pendingKey,
      source: "user_override",
      locked_by_user: true,
      reason: "Picked from IndustryPicker.",
    });
    if (row) {
      toast({ title: "Industry updated", description: row.selected_industry_key });
      onChanged?.();
    } else if (error) {
      toast({
        title: "Couldn't save industry",
        description: humanizeError(error),
        variant: "destructive",
      });
    }
  };

  const handleRecalc = async () => {
    if (assignment?.locked_by_user) {
      toast({
        title: "Assignment is locked",
        description: "Unlock first to let auto-detection drive the choice.",
      });
      return;
    }
    const row = await recalc();
    if (row) {
      toast({ title: "Re-detected", description: row.selected_industry_key });
      setPendingKey(row.selected_industry_key);
      onChanged?.();
    } else if (error) {
      toast({
        title: "Recalc failed",
        description: humanizeError(error),
        variant: "destructive",
      });
    }
  };

  const handleLockToggle = async () => {
    if (!assignment) return;
    const row = await toggleLock(!assignment.locked_by_user);
    if (row) {
      toast({ title: row.locked_by_user ? "Assignment locked" : "Assignment unlocked" });
      onChanged?.();
    }
  };

  const handlePickAlternative = async (key: string) => {
    // Picking inline from the suggestion card persists immediately
    // (the user clearly intends to switch); skip the Save button.
    const cand = detection?.candidates.find((c) => c.industry_key === key);
    if (!cand) {
      setPendingKey(key);
      return;
    }
    const row = await save(candidateToUpsertBody(cand));
    if (row) {
      toast({ title: "Industry updated", description: row.selected_industry_key });
      setPendingKey(row.selected_industry_key);
      onChanged?.();
    }
  };

  if (!open) return null;

  return (
    <>
      <div
        data-testid="industry-modal-backdrop"
        onClick={onClose}
        aria-hidden
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150"
      />
      <aside
        data-testid="industry-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby="industry-picker-title"
        className="
          fixed right-0 top-0 bottom-0 z-50
          w-[100vw] sm:w-[92vw] sm:max-w-[560px]
          bg-surface border-l border-rule shadow-2xl
          flex flex-col
          motion-safe:animate-in motion-safe:slide-in-from-right
          motion-safe:duration-200 motion-safe:ease-out
        "
      >
        <header className="flex items-start justify-between gap-3 px-5 py-4 border-b border-rule">
          <div className="min-w-0">
            <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium">
              Industry classification
            </div>
            <h2 id="industry-picker-title" className="font-serif text-[22px] text-ink leading-tight mt-1">
              {assignment ? "Change industry" : "Set industry"}
            </h2>
            <p className="text-[12px] text-ink-mute mt-1">
              The selected industry drives every benchmark, peer comparison
              and target tier on the rest of the dashboard.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close panel"
            className="text-ink-mute hover:text-ink p-1 rounded-md hover:bg-bg-2 transition-colors shrink-0"
          >
            <X size={18} strokeWidth={1.75} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
          {assignmentLoading && (
            <div className="text-center py-8 text-[13px] text-ink-mute">
              <Loader2 size={16} className="inline animate-spin mr-1.5" />
              Loading suggestions…
            </div>
          )}

          {/* Stale-URL state — the period referenced in `?period=...`
              doesn't exist on the backend (HTTP 404 from /detect/{id}).
              Most common cause: the document was permanent-deleted and
              `_maybe_drop_empty_period` cascaded the period row.
              Render a redirect-out banner instead of a broken picker
              with "Recalc failed: Period not found" toasts. See
              diagnostics/SET_INDUSTRY_PERIOD_NOT_FOUND_2026-05-18.md
              (defect D1). */}
          {!assignmentLoading && periodNotFound && (
            <StaleUrlBanner
              onClose={onClose}
              periodId={periodId}
            />
          )}

          {/* Detection card — only when the period DOES exist. Without
              this guard the suggestion card would render its empty
              state on top of the stale-URL banner. */}
          {!assignmentLoading && !periodNotFound && detection && (
            <IndustrySuggestionCard
              detection={detection}
              selectedKey={pendingKey ?? assignment?.selected_industry_key ?? null}
              onPickCandidate={(c) => void handlePickAlternative(c.industry_key)}
            />
          )}

          {/* Pending-industry context — readable label, CAEN summary,
              internal-brand note. Only renders when the user has a
              candidate selected (pendingKey != null) so it doesn't
              clutter the picker on first open. */}
          {!periodNotFound && pendingDetail && (
            <PendingIndustryContext detail={pendingDetail} />
          )}

          {/* Search + manual pick — hidden when periodNotFound because
              saving requires a valid period; offering the picker here
              would let the user pick an industry that can't be
              persisted (the recalc/save endpoints also 404). */}
          {!periodNotFound && (
          <section data-testid="industry-search-section" className="space-y-2">
            <label className="block text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium">
              Pick from the full catalog
            </label>
            <div className="relative">
              <Search size={14} strokeWidth={1.75} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-mute" />
              <input
                type="search"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search by industry name or alias…"
                className="w-full h-10 rounded-md border border-rule bg-surface pl-9 pr-3 text-[13px] text-ink"
              />
            </div>

            <div className="max-h-[340px] overflow-y-auto border border-rule rounded-md divide-y divide-rule">
              {profilesLoading && (
                <div className="px-3 py-4 text-[12px] text-ink-mute inline-flex items-center gap-2">
                  <Loader2 size={12} className="animate-spin" /> Loading catalog…
                </div>
              )}
              {!profilesLoading && groupedBySector.length === 0 && (
                <div className="px-3 py-4 text-[12px] text-ink-mute">
                  No matches.
                </div>
              )}
              {!profilesLoading && groupedBySector.map(([group, rows]) => (
                <div key={group}>
                  <div className="px-3 py-1.5 bg-bg-2/60 text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium">
                    {INDUSTRY_GROUP_LABELS[group]}
                  </div>
                  {rows.map((r) => (
                    <label
                      key={r.key}
                      className={
                        "flex items-start gap-2.5 px-3 py-2 cursor-pointer hover:bg-bg-2 " +
                        (pendingKey === r.key ? "bg-bg-2" : "")
                      }
                    >
                      <input
                        type="radio"
                        name="industry-pick"
                        value={r.key}
                        checked={pendingKey === r.key}
                        onChange={() => setPendingKey(r.key)}
                        className="mt-0.5"
                      />
                      <div className="min-w-0">
                        <div className="text-[13px] text-ink">{r.display_name}</div>
                        {r.display_name_ro && r.display_name_ro !== r.display_name && (
                          <div className="text-[11px] text-ink-mute">{r.display_name_ro}</div>
                        )}
                      </div>
                    </label>
                  ))}
                </div>
              ))}
            </div>
          </section>
          )}

          {/* Error surface */}
          {error && (
            <div
              data-testid="industry-picker-error"
              className="rounded-md border border-amber-300/60 bg-amber-50/60 px-3 py-2 text-[12px] text-amber-800"
            >
              {humanizeError(error)}
            </div>
          )}
        </div>

        <footer className="border-t border-rule px-5 py-4 flex items-center justify-between gap-2 flex-wrap">
          <div className="inline-flex items-center gap-2">
            <button
              type="button"
              data-testid="industry-picker-recalc"
              onClick={() => void handleRecalc()}
              // Disable Re-detect when the period is gone — the
              // recalc endpoint returns 404 in that state and the
              // generic "Recalc failed: Period not found" toast is
              // exactly the failure mode the stale-URL banner is
              // replacing.
              disabled={mutating || assignment?.locked_by_user || periodNotFound}
              className="h-9 px-3 rounded-md border border-rule bg-surface text-[12.5px] text-ink hover:bg-bg-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
            >
              <RefreshCw size={12} strokeWidth={1.75} />
              Re-detect
            </button>
            {assignment && (
              <button
                type="button"
                data-testid="industry-picker-lock"
                onClick={() => void handleLockToggle()}
                disabled={mutating || periodNotFound}
                className="h-9 px-3 rounded-md border border-rule bg-surface text-[12.5px] text-ink hover:bg-bg-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
              >
                {assignment.locked_by_user ? <Lock size={12} /> : <Unlock size={12} />}
                {assignment.locked_by_user ? "Locked" : "Unlocked"}
              </button>
            )}
          </div>
          <div className="inline-flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-9 px-3 rounded-md border border-rule bg-surface text-[13px] text-ink hover:bg-bg-2 transition-colors"
            >
              {periodNotFound ? "Close" : "Cancel"}
            </button>
            <button
              type="button"
              data-testid="industry-picker-save"
              onClick={() => void handleSave()}
              disabled={
                mutating || !pendingKey || periodNotFound ||
                pendingKey === assignment?.selected_industry_key
              }
              className="h-9 px-4 rounded-md bg-ink text-paper text-[13px] font-medium hover:bg-ink/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
            >
              {mutating && <Loader2 size={13} className="animate-spin" />}
              Save
            </button>
          </div>
        </footer>
      </aside>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────
// StaleUrlBanner — replaces the picker body when the period referenced
// in `?period=...` doesn't exist server-side (HTTP 404 from /detect/{id}).
// Most common cause: the document was permanent-deleted and the
// orchestrator cascaded the period row via `_maybe_drop_empty_period`.
// See diagnostics/SET_INDUSTRY_PERIOD_NOT_FOUND_2026-05-18.md.
// ─────────────────────────────────────────────────────────────────────

function StaleUrlBanner({
  onClose,
  periodId,
}: {
  onClose: () => void;
  periodId: string;
}) {
  const navigate = useNavigate();
  return (
    <section
      data-testid="industry-picker-stale-url"
      className="rounded-xl border border-amber-300/60 bg-amber-50/50 p-4 space-y-3"
    >
      <div>
        <div className="text-[10.5px] uppercase tracking-[0.1em] text-amber-700 font-medium">
          Analysis no longer exists
        </div>
        <h3 className="mt-1 text-[15px] font-medium text-ink">
          This period was removed or has expired
        </h3>
        <p className="mt-1.5 text-[12.5px] text-ink-soft leading-relaxed">
          The link references an analysis that's no longer on file —
          most commonly because the source document was permanently
          deleted. Industry classification can't be changed for an
          analysis that doesn't exist.
        </p>
        <code className="mt-1.5 inline-block text-[10.5px] text-ink-mute bg-bg-2 border border-rule rounded px-1.5 py-0.5 font-mono">
          period={periodId.slice(0, 8)}…
        </code>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            onClose();
            navigate("/dashboard");
          }}
          className="h-9 px-3.5 rounded-md bg-ink text-paper text-[13px] font-medium hover:bg-ink/90 transition-colors"
          data-testid="industry-picker-stale-url-go-dashboard"
        >
          Go to dashboard
        </button>
        <button
          type="button"
          onClick={onClose}
          className="h-9 px-3 rounded-md border border-rule bg-surface text-[13px] text-ink hover:bg-bg-2 transition-colors"
        >
          Close
        </button>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────
// PendingIndustryContext — readable label + CAEN summary + internal-brand
// note for the user's in-flight pick. Renders the "Sadu and Bucegi are
// brands within the Scandia group, not separate industry classifications"
// callout when the chosen industry has peer_candidates flagged with
// `is_internal_brand_default = true`.
// ─────────────────────────────────────────────────────────────────────

function PendingIndustryContext({ detail }: { detail: IndustryProfileDetail }) {
  const internalBrands: PeerCandidateRow[] = detail.peers.filter(
    (p) => p.is_internal_brand_default,
  );
  const externalPeers: PeerCandidateRow[] = detail.peers.filter(
    (p) => !p.is_internal_brand_default,
  );
  const primaryCaen = detail.caen_mappings[0];

  return (
    <section
      data-testid="industry-pending-context"
      className="rounded-xl border border-rule bg-bg-2/40 p-4 space-y-2.5"
    >
      <div>
        <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium">
          Selected industry
        </div>
        <div className="mt-1 text-[15px] font-medium text-ink">
          {detail.display_name}
        </div>
        {primaryCaen && (
          <div className="mt-0.5 text-[12px] text-ink-soft">
            CAEN {primaryCaen.caen_code} — {primaryCaen.caen_label_en}
          </div>
        )}
        {detail.description && (
          <p className="mt-1.5 text-[12px] text-ink-soft leading-relaxed">
            {detail.description}
          </p>
        )}
      </div>

      {/* Internal-brand note — shows when this industry has peers
          flagged is_internal_brand_default. Example: Scandia →
          Sadu/Bucegi appear here so users don't add them as peers. */}
      {internalBrands.length > 0 && (
        <div
          data-testid="industry-internal-brand-note"
          className="rounded-lg border border-blue-200 bg-blue-50/60 px-3 py-2 text-[12px] text-blue-900"
        >
          <strong className="font-semibold">
            {internalBrands.map((b) => b.company_name).join(", ")}
          </strong>{" "}
          {internalBrands.length === 1 ? "is" : "are"} {" "}
          internal brands within this group — not separate industry
          classifications. They appear in the company's own portfolio,
          not as external peer candidates.
        </div>
      )}

      {externalPeers.length > 0 && (
        <div className="text-[11.5px] text-ink-mute">
          <span className="uppercase tracking-[0.08em] font-medium">
            Typical peers:
          </span>{" "}
          {externalPeers.slice(0, 5).map((p) => p.company_name).join(" · ")}
        </div>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Error helper
// ─────────────────────────────────────────────────────────────────────

function humanizeError(err: IndustryApiError): string {
  if (err.status === 409) {
    return "Assignment is locked. Unlock first to let auto-detection change it.";
  }
  if (err.status === 422) {
    return "The selected industry isn't a known active industry — refresh and try again.";
  }
  if (err.status === 401) return "Session expired. Sign in again.";
  if (err.status === 403) return "You don't have access to this period.";
  if (err.status === 404) return "Period not found.";
  return err.message;
}
