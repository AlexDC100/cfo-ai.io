// useCouncilStream — subscribe to the AI council's live "thinking" for one
// document over a Supabase Realtime *broadcast* channel and map the events
// onto CouncilSphere props.
//
// The backend (engine _ai_council.run_council) broadcasts to the channel
// `council:{documentId}` as the extraction-integrity council runs:
//   started        {members[], files[], account_count}
//   member_active  {member}
//   finding        {member, severity, title}
//   member_done    {member, verdict}
//   verdict        {verdict, confidence, findings}
//   done           {verdict}
//
// This hook accumulates that stream into the shape CouncilSphere expects
// (members activity map, per-file read progress, stage flags) plus a packet
// queue the visualizer drains through the sphere's imperative spawnPacket.
//
// 2026-07-24 — the accumulator moved OUT of the component into a
// module-level per-document entry. Component state meant navigating away
// from the dashboard tore down the channel and lost everything received;
// coming back showed a blank sphere until the next event. Now the channel
// stays subscribed across unmounts (events keep accumulating while the
// user is on another tab) and remounting resumes from the cached state.
// A new documentId supersedes older entries, so at most one stream is
// alive — matching the one-upload-at-a-time uploadStore.

import { useCallback, useSyncExternalStore } from "react";

import { getSupabase } from "@/lib/supabase";

export interface CouncilPacket {
  id: number;
  from: string;
  to: string;
  type: string; // doc | pen | fact | chat | flag | ask | ok | no
}

export interface CouncilStreamState {
  files: { name: string }[];
  progress: number[];
  members: Record<string, { active?: boolean; stats?: string }>;
  phase: string;
  debate: boolean;
  merging: boolean;
  contracting: boolean;
  storyOn: boolean;
  packets: CouncilPacket[];
  verdict: string | null;
}

// finding severity → sphere packet glyph/colour.
const SEVERITY_PACKET: Record<string, string> = { high: "flag", medium: "ask", low: "chat" };
const VERDICT_PACKET: Record<string, string> = { pass: "ok", warn: "ask", fail: "no" };

const EMPTY: CouncilStreamState = {
  files: [], progress: [], members: {}, phase: "", debate: false,
  merging: false, contracting: false, storyOn: false, packets: [], verdict: null,
};

interface StreamEntry {
  state: CouncilStreamState;
  packetId: number;
  memberCount: number;
  channel: ReturnType<NonNullable<ReturnType<typeof getSupabase>>["channel"]> | null;
  listeners: Set<() => void>;
}

const entries = new Map<string, StreamEntry>();

function emit(entry: StreamEntry): void {
  for (const l of entry.listeners) l();
}

function reduce(entry: StreamEntry, p: Record<string, unknown>): CouncilStreamState {
  const prev = entry.state;
  const type = String(p.type || "");

  const pushPacket = (from: string, to: string, pktType: string) => {
    entry.packetId += 1;
    // Keep the queue bounded — the visualizer only needs the un-drained tail.
    const next = [...prev.packets, { id: entry.packetId, from, to, type: pktType }];
    return next.length > 40 ? next.slice(-40) : next;
  };

  switch (type) {
    case "started": {
      const members = Array.isArray(p.members) ? (p.members as string[]) : [];
      entry.memberCount = Math.max(1, members.length);
      const memberMap: CouncilStreamState["members"] = {};
      members.forEach((m) => { memberMap[m] = { active: false }; });
      const files = Array.isArray(p.files)
        ? (p.files as string[]).map((name) => ({ name }))
        : [{ name: "trial balance" }];
      return { ...EMPTY, files, members: memberMap, phase: "Council convening…" };
    }
    case "member_active": {
      const m = String(p.member || "");
      return {
        ...prev,
        members: { ...prev.members, [m]: { ...prev.members[m], active: true } },
        debate: true,
        phase: "Members reviewing the extraction…",
      };
    }
    case "finding": {
      const m = String(p.member || "");
      const sev = String(p.severity || "low");
      return { ...prev, packets: pushPacket(m, m, SEVERITY_PACKET[sev] || "chat") };
    }
    case "member_done": {
      const m = String(p.member || "");
      const verdict = p.verdict ? String(p.verdict) : "";
      const doneCount = Object.values({ ...prev.members, [m]: { active: false } })
        .filter((x) => x.active === false && x.stats).length + 1;
      return {
        ...prev,
        members: { ...prev.members, [m]: { active: false, stats: verdict } },
        progress: [Math.min(100, Math.round((doneCount / entry.memberCount) * 100))],
        packets: verdict ? pushPacket(m, "core", VERDICT_PACKET[verdict] || "fact") : prev.packets,
      };
    }
    case "verdict":
      return {
        ...prev,
        merging: true,
        verdict: p.verdict ? String(p.verdict) : prev.verdict,
        phase: `Chair merging · ${String(p.verdict || "").toUpperCase()}`,
      };
    case "done":
      return {
        ...prev,
        merging: true,
        contracting: true,
        storyOn: true,
        verdict: p.verdict ? String(p.verdict) : prev.verdict,
        phase: "Decided",
      };
    default:
      return prev;
  }
}

function dropEntry(id: string): void {
  const old = entries.get(id);
  if (!old) return;
  if (old.channel) {
    const supabase = getSupabase();
    if (supabase) void supabase.removeChannel(old.channel);
  }
  entries.delete(id);
}

function ensureEntry(documentId: string): StreamEntry {
  const existing = entries.get(documentId);
  if (existing) return existing;

  // One live stream at a time — a new document supersedes older entries
  // (their scans are over; keeping dead channels open would leak).
  for (const id of [...entries.keys()]) {
    if (id !== documentId) dropEntry(id);
  }

  const entry: StreamEntry = {
    state: { ...EMPTY },
    packetId: 0,
    memberCount: 1,
    channel: null,
    listeners: new Set(),
  };
  entries.set(documentId, entry);

  const supabase = getSupabase();
  if (supabase) {
    entry.channel = supabase
      .channel(`council:${documentId}`, { config: { broadcast: { self: false } } })
      .on("broadcast", { event: "council" }, (msg: { payload?: Record<string, unknown> }) => {
        const p = msg.payload || {};
        entry.state = reduce(entry, p);
        // Terminal event — the council is done; the cached state stays
        // (so a remount still shows the final pose) but the channel can go.
        if (String(p.type || "") === "done" && entry.channel) {
          const sb = getSupabase();
          if (sb) void sb.removeChannel(entry.channel);
          entry.channel = null;
        }
        emit(entry);
      })
      .subscribe();
  }
  return entry;
}

export function useCouncilStream(documentId: string | null | undefined): CouncilStreamState {
  const subscribe = useCallback(
    (cb: () => void) => {
      if (!documentId) return () => {};
      const entry = ensureEntry(documentId);
      entry.listeners.add(cb);
      // Deliberately do NOT tear the channel down on unmount — the whole
      // point is that the stream keeps accumulating while the user is on
      // another tab. Superseding (next document) or `done` closes it.
      return () => { entry.listeners.delete(cb); };
    },
    [documentId],
  );
  const getSnapshot = useCallback(
    () => (documentId ? entries.get(documentId)?.state ?? EMPTY : EMPTY),
    [documentId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
}
