// cmdbarRecents.ts — recent picks, per company, on this device.
//
// A PICKED ROW is remembered (a figure, an account, a page, an action, a
// question sent to CFO AI) — not every keystroke. Device-local by design
// (CLAUDE.md §16 Milestone C: what describes this screen stays in
// localStorage), keyed by company so one company's habits never follow the
// reader into another. Every read and write is wrapped: private mode,
// blocked storage or a corrupt value degrade to "no recents", never to a
// broken bar.

export const RECENTS_KEY_PREFIX = "cfo:cmdbar-recents:v1:";
export const MAX_RECENTS = 5;

export interface CmdbarRecent {
  /** The row's id (answer:net_result, account:411101:ar, page:…). */
  id: string;
  group: "answer" | "account" | "page" | "action" | "ask";
  /** What the row was called when picked (a label, never a figure: the
   *  figure is re-read from the served facts when the row is picked
   *  again). */
  label: string;
  /** Where it went; for an ask, the question. */
  href?: string;
  query?: string;
}

function key(orgId: string): string {
  return `${RECENTS_KEY_PREFIX}${orgId}`;
}

function isRecent(v: unknown): v is CmdbarRecent {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.id === "string" && typeof r.label === "string" && typeof r.group === "string";
}

export function readRecents(orgId: string | null): CmdbarRecent[] {
  if (!orgId || typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(key(orgId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isRecent).slice(0, MAX_RECENTS) : [];
  } catch {
    return [];
  }
}

export function rememberRecent(orgId: string | null, recent: CmdbarRecent): CmdbarRecent[] {
  if (!orgId || typeof window === "undefined") return [];
  // Only the fields of the shape are kept: the label is a NAME (the row's
  // figure is never stored — it is re-read from the served facts).
  const clean: CmdbarRecent = {
    id: recent.id, group: recent.group, label: recent.label,
    ...(recent.href ? { href: recent.href } : {}),
    ...(recent.query ? { query: recent.query } : {}),
  };
  try {
    const next = [clean, ...readRecents(orgId).filter((r) => r.id !== clean.id)].slice(0, MAX_RECENTS);
    window.localStorage.setItem(key(orgId), JSON.stringify(next));
    return next;
  } catch {
    return [];
  }
}
