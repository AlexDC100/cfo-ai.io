// useKeyboardInset — how many px of the LAYOUT viewport the on-screen
// keyboard currently covers (0 when closed, or when the platform resizes
// the whole viewport for the keyboard, in which case nothing overlaps).
//
// Why: on mobile the virtual keyboard often resizes only the VISUAL
// viewport, not the layout viewport — so `sticky bottom-0` elements stay
// pinned to the layout bottom, i.e. BEHIND the keyboard. Offsetting the
// sticky element by this inset keeps it riding above the keyboard, and
// re-measuring on visualViewport `scroll` keeps it pinned there while the
// user scrolls the conversation with the keyboard open.

import { useEffect, useState } from "react";

export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return undefined;
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const next = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
        // <40px is browser-chrome jitter (collapsing URL bar), not a keyboard.
        setInset(next < 40 ? 0 : Math.round(next));
      });
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      cancelAnimationFrame(raf);
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  return inset;
}
