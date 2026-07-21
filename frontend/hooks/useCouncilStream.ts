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

import { useEffect, useMemo, useRef, useState } from "react";

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

export function useCouncilStream(documentId: string | null | undefined): CouncilStreamState {
  const [state, setState] = useState<CouncilStreamState>(EMPTY);
  const packetId = useRef(0);
  const memberCount = useRef(1);

  useEffect(() => {
    if (!documentId) {
      setState(EMPTY);
      return;
    }
    const supabase = getSupabase();
    if (!supabase) return;

    setState({ ...EMPTY });
    packetId.current = 0;

    const pushPacket = (prev: CouncilStreamState, from: string, to: string, type: string) => {
      packetId.current += 1;
      // Keep the queue bounded — the visualizer only needs the un-drained tail.
      const next = [...prev.packets, { id: packetId.current, from, to, type }];
      return next.length > 40 ? next.slice(-40) : next;
    };

    const channel = supabase
      .channel(`council:${documentId}`, { config: { broadcast: { self: false } } })
      .on("broadcast", { event: "council" }, (msg: { payload?: Record<string, unknown> }) => {
        const p = msg.payload || {};
        const type = String(p.type || "");
        setState((prev) => {
          switch (type) {
            case "started": {
              const members = Array.isArray(p.members) ? (p.members as string[]) : [];
              memberCount.current = Math.max(1, members.length);
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
              return { ...prev, packets: pushPacket(prev, m, m, SEVERITY_PACKET[sev] || "chat") };
            }
            case "member_done": {
              const m = String(p.member || "");
              const verdict = p.verdict ? String(p.verdict) : "";
              const doneCount = Object.values({ ...prev.members, [m]: { active: false } })
                .filter((x) => x.active === false && x.stats).length + 1;
              return {
                ...prev,
                members: { ...prev.members, [m]: { active: false, stats: verdict } },
                progress: [Math.min(100, Math.round((doneCount / memberCount.current) * 100))],
                packets: verdict ? pushPacket(prev, m, "core", VERDICT_PACKET[verdict] || "fact") : prev.packets,
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
        });
      })
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [documentId]);

  return useMemo(() => state, [state]);
}
