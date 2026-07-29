// Typing indicator that occupies the place of an assistant turn while
// the API call is in flight. Three pulsing dots inside the same glass
// card style as a real assistant bubble — so the layout doesn't jump
// when the actual answer arrives.

import { motion } from "framer-motion";

export function CFOTypingIndicator(_props: { grounded?: string | null }) {
  return (
    <motion.div
      className="mb-6"
      data-testid="chat-typing"
    >
      <div className="flex items-center gap-1.5 py-1.5">
        <Dot delay={0} />
        <Dot delay={0.15} />
        <Dot delay={0.3} />
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
