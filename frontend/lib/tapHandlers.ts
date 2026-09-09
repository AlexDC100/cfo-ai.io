// Touch-release tap handling for rows inside a scrollable drawer/sheet on
// touch devices (2026-09-08): iOS WebViews turned a fair share of taps
// inside the drawer into nothing — the click never fired after the sheet's
// own touch handling — so these rows act on the touch's RELEASE instead.
// A small movement threshold keeps scrolls from firing; the synthetic
// click that would follow is suppressed so nothing runs twice.
import type React from "react";

// Drawer taps fire on TOUCH RELEASE (2026-09-08 per operator: in the iOS
// shell the first tap on a tab was regularly lost and a second was needed —
// the synthetic click after the touch is what went missing). A clean tap
// (little movement, short) navigates directly and preventDefault() drops
// the follow-up click so nothing double-fires. Mouse/keyboard still use
// the ordinary click path. One module-level start point is enough: one
// finger navigates at a time.
let tapStart: { x: number; y: number; t: number } | null = null;
export function tapHandlers(onTap: () => void) {
  return {
    onTouchStart: (e: React.TouchEvent) => {
      const t = e.touches[0];
      tapStart = t ? { x: t.clientX, y: t.clientY, t: Date.now() } : null;
    },
    onTouchEnd: (e: React.TouchEvent) => {
      const s = tapStart;
      tapStart = null;
      const t = e.changedTouches[0];
      if (!s || !t) return;
      if (Math.abs(t.clientX - s.x) > 10 || Math.abs(t.clientY - s.y) > 10 || Date.now() - s.t > 600) return;
      e.preventDefault();
      onTap();
    },
    onTouchCancel: () => {
      tapStart = null;
    },
  };
}
