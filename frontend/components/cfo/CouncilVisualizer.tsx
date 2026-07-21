// CouncilVisualizer — renders the CouncilSphere "AI thinking" canvas scaled
// into a fixed-height box (e.g. the dashboard drop zone) and feeds it the
// live council event stream for one document.
//
// CouncilSphere is natively 1720×860 with the sphere centred at (CX, CY); we
// scale it down and translate so that centre lands in the middle of our box,
// clipping the surrounding canvas padding with overflow-hidden. The hook
// supplies declarative props (members/progress/stage flags); findings arrive
// as a packet queue that we drain through the sphere's imperative
// spawnPacket() handle.

import { useEffect, useRef } from "react";

import CouncilSphere, { SPHERE_LEFT_PAD, SPHERE_TOP_PAD } from "@/components/cfo/CouncilSphere";
import { useCouncilStream } from "@/hooks/useCouncilStream";

// Mirror of the private CX/CY in CouncilSphere (canvas-space sphere centre).
const CX = SPHERE_LEFT_PAD + 360;
const CY = 288 + SPHERE_TOP_PAD;

interface SphereHandle {
  spawnPacket?: (fromId: string, toId: string, type: string) => void;
}

export function CouncilVisualizer({
  documentId,
  scale = 0.42,
  height = 320,
}: {
  documentId: string | null;
  scale?: number;
  height?: number;
}) {
  const stream = useCouncilStream(documentId);
  const sphereRef = useRef<SphereHandle | null>(null);
  const drained = useRef(0);

  // Drain new finding/verdict packets into the sphere's imperative handle.
  useEffect(() => {
    const sphere = sphereRef.current;
    if (!sphere || typeof sphere.spawnPacket !== "function") return;
    for (const pk of stream.packets) {
      if (pk.id > drained.current) {
        try { sphere.spawnPacket(pk.from, pk.to, pk.type); } catch { /* non-fatal */ }
        drained.current = pk.id;
      }
    }
  }, [stream.packets]);

  return (
    <div
      className="relative w-full overflow-hidden"
      style={{ height }}
      data-testid="council-visualizer"
      aria-label="AI council reviewing the extraction"
    >
      <div style={{ position: "absolute", left: "50%", top: "50%" }}>
        <div
          style={{
            transform: `translate(${-CX * scale}px, ${-CY * scale}px) scale(${scale})`,
            transformOrigin: "0 0",
          }}
        >
          <CouncilSphere
            ref={sphereRef}
            files={stream.files}
            progress={stream.progress}
            members={stream.members}
            phase={stream.phase}
            debate={stream.debate}
            merging={stream.merging}
            contracting={stream.contracting}
            storyOn={false}
          />
        </div>
      </div>
    </div>
  );
}
