// uploadNotices.ts — the bell's record of finished analyses.
//
// The bell (NotificationsMenu) reads the org's persisted alerts. An analysis
// finishing is a different kind of news — it belongs to the USER who dropped
// the file, it can concern a company other than the one open now, and it must
// be there after the toast is gone. So it is its own small list: written by
// the upload flow host when a job reaches analyzed/failed, read by the bell
// (unread count on the badge, entries above the alerts), device-local and
// capped. Only the workspace redesign writes it, so with that flag off the
// bell is exactly what it was.

import { useSyncExternalStore } from "react";

export const NOTICES_STORAGE_KEY = "cfo-upload-notices-v1";
const MAX_NOTICES = 20;

export interface UploadNotice {
  /** The analysed document — one notice per document. */
  id: string;
  kind: "done" | "failed";
  companyName: string;
  orgId: string;
  periodId: string | null;
  filename: string;
  error: string | null;
  at: number;
  read: boolean;
}

let notices: UploadNotice[] | null = null;
const listeners = new Set<() => void>();

function read(): UploadNotice[] {
  if (notices) return notices;
  try {
    const raw = localStorage.getItem(NOTICES_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    notices = (Array.isArray(parsed) ? parsed : []).filter(
      (n): n is UploadNotice => !!n && typeof (n as UploadNotice).id === "string",
    );
  } catch {
    notices = [];
  }
  return notices;
}

function write(next: UploadNotice[]): void {
  notices = next;
  try {
    localStorage.setItem(NOTICES_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* private mode — the list still works in memory */
  }
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === NOTICES_STORAGE_KEY) {
      notices = null;
      cb();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

const EMPTY: UploadNotice[] = [];

export function useUploadNotices(): UploadNotice[] {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}

export function pushUploadNotice(n: Omit<UploadNotice, "at" | "read">): void {
  const next: UploadNotice = { ...n, at: Date.now(), read: false };
  write([next, ...read().filter((x) => x.id !== n.id)].slice(0, MAX_NOTICES));
}

export function markUploadNoticesRead(): void {
  const list = read();
  if (!list.some((n) => !n.read)) return;
  write(list.map((n) => (n.read ? n : { ...n, read: true })));
}

export function unreadUploadNotices(list: UploadNotice[]): number {
  return list.filter((n) => !n.read).length;
}

/** Test-only. */
export function __resetUploadNoticesForTest(): void {
  write([]);
}
