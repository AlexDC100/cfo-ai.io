// Typing indicator that occupies the place of an assistant turn while
// the API call is in flight. Three pulsing dots inside the same glass
// card style as a real assistant bubble — so the layout doesn't jump
// when the actual answer arrives.

import { motion } from "framer-motion";
import { Sparkles } from "lucide-react";

export function CFOTypingIndicator({ grounded }: { grounded?: string | null }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="mb-6"
      data-testid="chat-typing"
    >
      <div className="flex items-center gap-1.5 mb-1.5 text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium">
        <span className="inline-flex items-center justify-center h-4 w-4 rounded-full bg-brand/15 text-brand-d">
          <Sparkles size={9} strokeWidth={2.25} />
        </span>
        <span className="text-ink-soft">CFO AI</span>
        {grounded && (
          <>
            <span className="text-ink-mute/60">·</span>
            <span className="normal-case tracking-normal text-ink-mute">
              grounded in <span className="text-ink-soft">{grounded}</span>
            </span>
          </>
        )}
      </div>

      <div className="rounded-2xl rounded-tl-md border border-rule bg-surface/80 dark:bg-bg-2/40 backdrop-blur-sm px-5 py-4">
        <div className="flex items-center gap-1.5">
          <Dot delay={0} />
          <Dot delay={0.15} />
          <Dot delay={0.3} />
        </div>
      </div>
    </motion.div>
  );
}

function Dot({ delay }: { delay: number }) {
  return (
    <motion.span
      className="h-1.5 w-1.5 rounded-full bg-ink-mute/70"
      animate={{ opacity: [0.3, 1, 0.3], y: [0, -2, 0] }}
      transition={{ duration: 1.1, repeat: Infinity, ease: "easeInOut", delay }}
    />
  );
}
