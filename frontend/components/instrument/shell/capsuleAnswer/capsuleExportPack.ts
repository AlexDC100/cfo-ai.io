// THE CAPSULE — "Add to export pack", device-local.
//
// Which answers a reader has set aside for an export describes THIS
// browser at THIS moment, not the user and not the company — so it is
// localStorage, like the findings pack (`lib/findings.ts`
// `exportPackKeys`) and unlike anything in `user_prefs` / `org_prefs`.
//
// It is a SEPARATE store from the findings pack on purpose: that one is
// keyed by finding key and its consumers resolve those keys back into
// finding rows. An answer has no finding key, and pushing a synthetic
// one into a namespace someone else resolves would produce a phantom
// finding in their export.
//
// What is stored is the NATIVE-currency rendering plus its citation —
// never the placeholder template. A pack entry has to survive being read
// by an export that has no placeholder renderer and no rate table, and a
// native figure with its currency spelled out is the only form that is
// still true there.

const KEY = "cfo-capsule-export-pack-v1";
const MAX_ENTRIES = 40;

export interface CapsulePackEntry {
  id: string;
  question: string;
  /** Native-currency text. Already resolved — no placeholders. */
  answer: string;
  currency: string | null;
  periods: string[];
  snapshot: string | null;
  /** Engine trust verdict at the time it was added, verbatim. */
  trust: string | null;
  addedAt: number;
}

type Listener = () => void;
const listeners = new Set<Listener>();
let cache: CapsulePackEntry[] | null = null;

function read(): CapsulePackEntry[] {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    cache = Array.isArray(parsed) ? (parsed as CapsulePackEntry[]) : [];
  } catch {
    cache = [];
  }
  return cache;
}

function write(next: CapsulePackEntry[]): void {
  cache = next.slice(-MAX_ENTRIES);
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* storage unavailable — the selection still works for this session */
  }
  for (const l of listeners) l();
}

export function packEntries(): CapsulePackEntry[] {
  return read();
}

export function inPack(id: string): boolean {
  return read().some((e) => e.id === id);
}

/** Toggle. Returns the membership state AFTER the call. */
export function togglePack(entry: CapsulePackEntry): boolean {
  const current = read();
  if (current.some((e) => e.id === entry.id)) {
    write(current.filter((e) => e.id !== entry.id));
    return false;
  }
  write([...current, entry]);
  return true;
}

export function clearPack(): void {
  write([]);
}

export function subscribePack(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Test hook — the module cache is otherwise immortal within a file. */
export function __resetCapsulePackForTests(): void {
  cache = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
