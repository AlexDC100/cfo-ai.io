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
  hideLabels = false,
  paused = false,
  forceFinal = false,
}: {
  documentId: string | null;
  scale?: number;
  height?: number;
  /** Hide the council's text layers (member name/role labels + the
   *  phase line) — the fullscreen scanning view shows the sphere pure,
   *  with the page's own pipeline steps carrying the narration. */
  hideLabels?: boolean;
  /** Freeze the sphere's simulation clock (CouncilSphere's own `paused`
   *  prop) and desaturate it — the cancel-confirmation state. */
  paused?: boolean;
  /** Force the sphere into its END POSE (contracting settle + core flare)
   *  regardless of the council stream — driven by the scan view when the
   *  pipeline is "almost done", so the visual resolves in step with the
   *  status even in the debug simulator (which emits no council stream). */
  forceFinal?: boolean;
}) {
  const stream = useCouncilStream(documentId);
  const sphereRef = useRef<SphereHandle | null>(null);
  // -1 = "not seeded yet". The stream cache survives this component's
  // unmount (see useCouncilStream), so on a REMOUNT mid-scan the queue
  // already holds history — seed past it instead of replaying the whole
  // backlog as one burst of packets.
  const drained = useRef(-1);

  // Drain new finding/verdict packets into the sphere's imperative handle.
  useEffect(() => {
    if (drained.current === -1) {
      drained.current = stream.packets.length
        ? stream.packets[stream.packets.length - 1].id
        : 0;
      return;
    }
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
      className={`relative w-full overflow-hidden transition-[filter,opacity] duration-300 ${
        hideLabels ? "[&_.csx-label]:hidden [&_.csx-phase]:hidden" : ""
      } ${paused ? "grayscale opacity-70" : ""}`}
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
            merging={stream.merging || forceFinal}
            contracting={stream.contracting || forceFinal}
            storyOn={false}
            paused={paused}
          />
        </div>
      </div>
    </div>
  );
}
