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
import { Sparkles, Copy, Check } from "lucide-react";
import { useState } from "react";
import type { ChatMessage } from "./types";

interface Props {
  message: ChatMessage;
}

export function CFOMessageBubble({ message }: Props) {
  const isUser = message.role === "user";
  if (isUser) return <UserBubble message={message} />;
  return <AssistantBubble message={message} />;
}

// ─── User bubble ─────────────────────────────────────────────────
function UserBubble({ message }: Props) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="flex justify-end mb-5"
      data-role="user"
    >
      <div className="max-w-[78%] sm:max-w-[68%]">
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
function AssistantBubble({ message }: Props) {
  const [copied, setCopied] = useState(false);
  async function onCopy() {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch { /* no-op — clipboard blocked in some contexts */ }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: "easeOut" }}
      className="group mb-6"
      data-role="assistant"
    >
      {/* Eyebrow — CFO AI mark + grounded caption */}
      <div className="flex items-center gap-1.5 mb-1.5 text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium">
        <span className="inline-flex items-center justify-center h-4 w-4 rounded-full bg-brand/15 text-brand-d">
          <Sparkles size={9} strokeWidth={2.25} />
        </span>
        <span className="text-ink-soft">CFO AI</span>
        {message.groundedPeriod && !message.pending && (
          <>
            <span className="text-ink-mute/60">·</span>
            <span className="normal-case tracking-normal text-ink-mute">
              grounded in <span className="text-ink-soft">{message.groundedPeriod}</span>
            </span>
          </>
        )}
      </div>

      {/* Body card */}
      <div className="relative rounded-2xl rounded-tl-md border border-rule bg-surface/80 dark:bg-bg-2/40 backdrop-blur-sm px-5 py-4 text-[14px] leading-[1.65] text-ink shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
        <MiniMarkdown text={message.content} />

        {/* Copy action — discoverable on hover, not loud */}
        {message.content && !message.pending && (
          <button
            type="button"
            onClick={onCopy}
            aria-label="Copy message"
            className="absolute top-2.5 right-2.5 opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center justify-center h-7 w-7 rounded-md text-ink-mute hover:text-ink hover:bg-bg-2/60"
          >
            {copied ? <Check size={13} className="text-emerald-600" /> : <Copy size={13} strokeWidth={1.75} />}
          </button>
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
        if (b.kind === "h3") return <h3 key={i} className="font-serif text-[16.5px] text-ink mt-1 first:mt-0">{renderInline(b.text)}</h3>;
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
    if (t.kind === "code") return <code key={k} className="px-1 py-0.5 rounded text-[12.5px] bg-bg-2/70 font-mono text-ink break-all">{t.v}</code>;
    if (t.kind === "link") return <a key={k} href={t.v} target="_blank" rel="noreferrer" className="text-brand-d underline underline-offset-2 hover:text-brand break-all">{t.v}</a>;
    return <span key={k}>{t.v}</span>;
  });
}

function ext(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "FILE";
  return name.slice(dot + 1).slice(0, 4).toUpperCase();
}
