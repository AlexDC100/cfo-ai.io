// Premium message bubble for the CFO AI chat.
//
// Two visual languages share this component:
//   · user turn   — right-aligned, soft brand-tint pill, compact, capped width
//   · assistant turn — left-aligned, glass-style card with subtle border,
//                      readable line-height, light markdown rendering
//
// Markdown rendering is intentionally minimal (no new runtime deps —
// react-markdown is NOT in the dep tree and the spec forbids adding
// providers). We handle the four formatting bits the model actually
// uses in financial output: ## / ### headers, bullet lists,
// **bold**, `code`, and paragraph breaks. Anything else falls through
// as plain text inside a <p>.
//
// The bubble also surfaces the "Grounded in workspace snapshot · …"
// caption when the assistant turn was sent with workspace context.

import { motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ChatMessage } from "./types";

interface Props {
  message: ChatMessage;
  /** Type the text out character-by-character on first appearance. Only
   *  the list's freshly-arrived assistant turn gets this; ignored for
   *  user turns and for history loaded from storage. */
  animate?: boolean;
  /** Called on each reveal tick so the list can keep the view pinned to
   *  the bottom while the answer types out. */
  onType?: () => void;
}

export function CFOMessageBubble({ message, animate = false, onType }: Props) {
  const isUser = message.role === "user";
  if (isUser) return <UserBubble message={message} />;
  // Stop pressed mid-generation — a muted marker in the assistant slot
  // (left side, same placement as an answer), like Claude's "Interrupted".
  if (message.interrupted) return <InterruptedMarker />;
  return <AssistantBubble message={message} animate={animate} onType={onType} />;
}

// ─── Interrupted marker ──────────────────────────────────────────
function InterruptedMarker() {
  const { t } = useTranslation();
  return (
    <motion.div className="mb-6 max-w-[1000px]" data-role="assistant" data-testid="chat-interrupted">
      <div className="text-[13.5px] leading-[1.65] italic text-ink-mute select-none">
        {t("chatX.interrupted")}
      </div>
    </motion.div>
  );
}

// ─── Typewriter hook ─────────────────────────────────────────────
// Reveals `full` progressively when `enabled`. Long answers are revealed
// in larger chunks so the total duration stays bounded (~4s cap) rather
// than scaling linearly with length; short answers type per character.
function useTypewriter(full: string, enabled: boolean, onTick?: () => void) {
  const [count, setCount] = useState(enabled ? 0 : full.length);
  const onTickRef = useRef(onTick);
  onTickRef.current = onTick;

  useEffect(() => {
    if (!enabled) {
      setCount(full.length);
      return;
    }
    let i = 0;
    setCount(0);
    const step = Math.max(1, Math.ceil(full.length / 240));
    const id = window.setInterval(() => {
      i += step;
      const next = Math.min(i, full.length);
      setCount(next);
      onTickRef.current?.();
      if (next >= full.length) window.clearInterval(id);
    }, 16);
    return () => window.clearInterval(id);
    // Re-run only if the text itself changes (or animation toggles).
  }, [full, enabled]);

  return { shown: full.slice(0, count), done: count >= full.length };
}

// ─── User bubble ─────────────────────────────────────────────────
function UserBubble({ message }: Props) {
  return (
    <motion.div
      className="flex justify-end mb-5"
      data-role="user"
    >
      <div className="max-w-[88%] sm:max-w-[760px]">
        <div className="rounded-2xl rounded-tr-md bg-brand-tint/70 dark:bg-brand/[0.14] border border-brand/15 px-4 py-2.5 text-[14px] leading-relaxed text-ink whitespace-pre-wrap">
          {message.content}
        </div>
        {message.attachments && message.attachments.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5 justify-end">
            {message.attachments.map((a) => (
              <span
                key={a.id}
                className="inline-flex items-center gap-1.5 rounded-md border border-rule bg-surface px-2 py-0.5 text-[11px] text-ink-soft"
              >
                <span className="text-ink-mute uppercase tracking-[0.06em] text-[10px]">{ext(a.name)}</span>
                <span className="truncate max-w-[140px]">{a.name}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
}

// ─── Assistant bubble ────────────────────────────────────────────
function AssistantBubble({ message, animate = false, onType }: Props) {
  // Freeze the animate decision at mount. The list flips `animate` back to
  // false on the very next render (once it's marked the id as seen); without
  // this latch that flip would snap the reveal to full text instantly.
  const animateAtMount = useRef(animate);
  const { shown, done } = useTypewriter(message.content, animateAtMount.current, onType);
  const typing = !done;

  return (
    <motion.div
      className="mb-6 max-w-[1000px]"
      data-role="assistant"
    >
      {/* Body — plain text, no card / label / copy button. */}
      <div className="text-[14px] leading-[1.65] text-ink">
        <MiniMarkdown text={shown} />
        {/* Blinking caret while the answer is still typing out. */}
        {typing && (
          <span
            aria-hidden
            className="inline-block w-[2px] h-[1.05em] translate-y-[0.15em] ml-0.5 bg-ink/70 animate-pulse"
          />
        )}
      </div>
    </motion.div>
  );
}

// ─── Minimal markdown ────────────────────────────────────────────
// Render the small set of formatting marks the model actually uses
// in financial answers. No external dep. Inline:
//   **bold**     → <strong>
//   `code`       → <code>
// Block:
//   ## heading   → <h3>
//   ### heading  → <h4>
//   - / * bullet → <ul><li>
//   blank line   → paragraph break
//
// Anything else passes through as plain text inside <p>.

function MiniMarkdown({ text }: { text: string }) {
  if (!text) return null;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  type Block =
    | { kind: "p"; text: string[] }
    | { kind: "h3"; text: string }
    | { kind: "h4"; text: string }
    | { kind: "ul"; items: string[] };
  const blocks: Block[] = [];
  let para: string[] = [];
  let ul: string[] = [];
  function flushPara() {
    if (para.length) { blocks.push({ kind: "p", text: para }); para = []; }
  }
  function flushUl() {
    if (ul.length) { blocks.push({ kind: "ul", items: ul }); ul = []; }
  }
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { flushPara(); flushUl(); continue; }
    const h3 = /^###\s+(.*)$/.exec(line);
    if (h3) { flushPara(); flushUl(); blocks.push({ kind: "h4", text: h3[1] }); continue; }
    const h2 = /^##\s+(.*)$/.exec(line);
    if (h2) { flushPara(); flushUl(); blocks.push({ kind: "h3", text: h2[1] }); continue; }
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (li) { flushPara(); ul.push(li[1]); continue; }
    flushUl();
    para.push(line);
  }
  flushPara(); flushUl();

  return (
    <div className="space-y-3 first:mt-0 last:mb-0">
      {blocks.map((b, i) => {
        if (b.kind === "h3") return <h3 key={i} className="font-semibold text-[16.5px] text-ink mt-1 first:mt-0">{renderInline(b.text)}</h3>;
        if (b.kind === "h4") return <h4 key={i} className="font-semibold text-[14.5px] text-ink mt-0.5 first:mt-0">{renderInline(b.text)}</h4>;
        if (b.kind === "ul") return (
          <ul key={i} className="space-y-1 pl-4 list-disc marker:text-ink-mute/70">
            {b.items.map((it, j) => <li key={j} className="text-[14px] leading-relaxed">{renderInline(it)}</li>)}
          </ul>
        );
        // paragraph — preserve hard breaks inside a block
        return (
          <p key={i} className="text-[14px] leading-[1.65] whitespace-pre-line">
            {b.text.map((ln, j) => <span key={j}>{renderInline(ln)}{j < b.text.length - 1 ? "\n" : ""}</span>)}
          </p>
        );
      })}
    </div>
  );
}

function renderInline(text: string): React.ReactNode {
  // Tokenise on **bold**, `code`, and bare URLs. Order matters —
  // codespans win over bold so we don't accidentally bold ``...``.
  const tokens: Array<{ kind: "text" | "bold" | "code" | "link"; v: string }> = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(https?:\/\/[^\s)]+)/g;
  let i = 0; let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > i) tokens.push({ kind: "text", v: text.slice(i, m.index) });
    if (m[1]) tokens.push({ kind: "code", v: m[1].slice(1, -1) });
    else if (m[2]) tokens.push({ kind: "bold", v: m[2].slice(2, -2) });
    else if (m[3]) tokens.push({ kind: "link", v: m[3] });
    i = m.index + m[0].length;
  }
  if (i < text.length) tokens.push({ kind: "text", v: text.slice(i) });

  return tokens.map((t, k) => {
    if (t.kind === "bold") return <strong key={k} className="font-semibold text-ink">{t.v}</strong>;
    if (t.kind === "code") return <code key={k} className="px-1 py-0.5 rounded text-[12.5px] bg-bg-2/70 text-ink break-all">{t.v}</code>;
    if (t.kind === "link") return <a key={k} href={t.v} target="_blank" rel="noreferrer" className="text-brand-d underline underline-offset-2 hover:text-brand break-all">{t.v}</a>;
    return <span key={k}>{t.v}</span>;
  });
}

function ext(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "FILE";
  return name.slice(dot + 1).slice(0, 4).toUpperCase();
}
