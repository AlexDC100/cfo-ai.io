// F5.0 Phase 1.5 — One renderer to rule them all.
//
// Mounted ONCE at the app root inside PopoverStackProvider. Reads the
// stack and paints every popover. This single-renderer pattern means:
//   · z-index always works (one render tree, not N portals from N
//     LearnableNumber components scattered across the app)
//   · the nested popover stacks visually above the parent without
//     fighting Radix's focus-trap-per-popover machinery
//   · the back/close/esc handlers live in ONE place

import { AnimatePresence } from "framer-motion";
import { usePopoverStack } from "./PopoverStackProvider";
import { LearningPopover } from "./LearningPopover";

export function PopoverStackRenderer() {
  const { stack, pop, clear } = usePopoverStack();
  return (
    <AnimatePresence>
      {stack.map((entry, idx) => (
        <LearningPopover
          key={entry.id}
          entry={entry}
          depth={idx}
          isTop={idx === stack.length - 1}
          stackSize={stack.length}
          onBack={pop}
          onClose={clear}
        />
      ))}
    </AnimatePresence>
  );
}
