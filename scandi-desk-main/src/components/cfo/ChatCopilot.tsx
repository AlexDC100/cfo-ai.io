// CFO AI Copilot — chat surface inside the dark premium app shell.
//
// Right-side glass sheet on desktop (480px), full-screen on mobile. Header
// with title + dataset badge, empty state with grouped starter prompts,
// message list with user (right) + AI (left, structured blocks) bubbles,
// input bar with send button.
//
// Today the responder is deterministic and grounded in the derived dataset
// (see chatResponder.ts). When the AI backend lands the responder becomes
// a fetch to /api/cfo/chat with the same context object.

import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";
import { Sparkles, ArrowUp, X } from "lucide-react";
import { useDailyRun } from "@/lib/runStore";
import { derive } from "@/lib/cfoDerive";
import {
  respond,
  SUGGESTED_PROMPTS,
  type AnswerBlocks,
  type ChatBlock,
} from "@/lib/chatResponder";
import { cfoApi } from "@/lib/cfoApi";

const PAGE_TITLES: Record<string, string> = {
  "/dashboard":     "Today",
  "/decisions":     "Decisions",
  "/products":      "Products",
  "/alerts":        "Alerts",
  "/settings":      "Settings",
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface UserMsg { role: "user"; text: string }
interface AiMsg   { role: "ai";   text: string; answer: AnswerBlocks; pending?: boolean }
type Msg = UserMsg | AiMsg;

export function ChatCopilot({ open, onOpenChange }: Props) {
  const run = useDailyRun();
  const loc = useLocation();
  const currentPage = PAGE_TITLES[loc.pathname] ?? "Landing";
  const ctx = useMemo(() => {
    const { summary, items } = derive(run);
    return { summary, items, costOfCapitalPct: run.costOfCapitalPct };
  }, [run]);

  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on new messages
  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  /** Build a compact, model-friendly snapshot of the operator's portfolio.
   *  Cached on every render via useMemo above, then stringified here so the
   *  LLM endpoint can ground its answers in real numbers.
   *
   *  Stays under ~600 tokens — the system prompt is cache-eligible and we
   *  want the per-turn cost dominated by the user's actual question. */
  function buildDatasetSummary(): string {
    const s = ctx.summary;
    const items = ctx.items;
    const cur = "kEUR";
    const fmt = (n: number) =>
      Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}M EUR` : `${n.toFixed(0)} ${cur}`;

    const buckets: Record<string, string[]> = {};
    for (const i of items) {
      (buckets[i.bucket] ??= []).push(
        `${i.id} (real margin ${i.realMargin.toFixed(1)}%, ${i.dioDays}d DIO, ${fmt(i.absoluteProfit)})`,
      );
    }

    const lines = [
      `Working capital trapped: ${fmt(s.cash_trapped_kron)}`,
      `Recoverable cash potential: ${fmt(s.cash_recovery_potential_kron)}`,
      `Portfolio ROIC: ${s.roic_pct.toFixed(1)}%`,
      `Weighted real margin: ${s.real_margin_pct.toFixed(1)}%`,
      `Cost of capital: ${ctx.costOfCapitalPct.toFixed(1)}%`,
      `Categories analysed: ${s.categories_analyzed}`,
      `Urgent actions queued: ${s.urgent_actions}`,
      "",
      "Decision buckets:",
    ];
    for (const [bucket, entries] of Object.entries(buckets)) {
      lines.push(`  ${bucket}: ${entries.join("; ")}`);
    }
    return lines.join("\n");
  }

  /** Ask the LLM-backed chat endpoint with the full conversation history,
   *  so multi-turn context survives across user turns. Falls back to the
   *  legacy structured /api/cfo/chat (and finally to the local responder)
   *  when Claude isn't available. */
  async function askBackend(history: Array<{ role: "user" | "assistant"; content: string }>):
    Promise<AnswerBlocks | null>
  {
    // 1. Try the conversational LLM endpoint.
    try {
      const res = await cfoApi.chatLlm({
        messages: history,
        dataset_summary: buildDatasetSummary(),
        page: currentPage,
        company_name: "Your workspace",
      });
      if (res.answer && res.answer.trim()) {
        return { blocks: [{ text: res.answer.trim() }] };
      }
    } catch { /* fall through */ }

    // 2. Legacy structured intent endpoint.
    try {
      const lastUser = [...history].reverse().find((m) => m.role === "user");
      if (lastUser) {
        const res = await cfoApi.chat({
          question: lastUser.content,
          company: { name: "Your workspace" },
          skus: [],
          categories: [],
          page: currentPage,
        });
        return { blocks: res.answer.blocks as ChatBlock[] };
      }
    } catch { /* fall through */ }

    return null;
  }

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    setInput("");
    const user: UserMsg = { role: "user", text: trimmed };
    const nextMessages = [...messages, user];
    setMessages(nextMessages);
    setThinking(true);

    // Build conversation history for the LLM call — only role + content,
    // skipping the structured AnswerBlocks (those are render-only).
    const history: Array<{ role: "user" | "assistant"; content: string }> = nextMessages.map((m) =>
      m.role === "user"
        ? { role: "user", content: m.text }
        : {
            role: "assistant",
            // Flatten the AnswerBlocks back to text — for the legacy
            // structured responses this is just the joined text blocks.
            content: m.answer.blocks
              .map((b) => b.text ?? (b.list ? b.list.join("\n• ") : ""))
              .filter(Boolean)
              .join("\n\n"),
          },
    );

    const fromBackend = await askBackend(history);
    const answer = fromBackend ?? respond(trimmed, ctx);
    const ai: AiMsg = { role: "ai", text: trimmed, answer };
    setMessages((m) => [...m, ai]);
    setThinking(false);
  }

  function reset() {
    setMessages([]);
    setInput("");
    setThinking(false);
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="
          w-[calc(100vw-24px)] sm:w-[480px] sm:max-w-[480px]
          p-0 m-3 h-[calc(100dvh-24px)]
          rounded-3xl
          bg-surface
          border border-rule-strong
          shadow-4
          text-ink
          [&>button.absolute]:hidden
          flex flex-col
        "
      >
        {/* Header */}
        <div className="px-5 pt-5 pb-4 border-b border-rule/60">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.12em] text-brand">
                <Sparkles size={12} strokeWidth={2} />
                CFO AI
              </div>
              <SheetTitle asChild>
                <h2 className="mt-1.5 text-[18px] font-medium text-ink leading-tight">
                  CFO AI
                </h2>
              </SheetTitle>
              <p className="mt-1 text-[12px] text-ink-soft leading-snug">
                Ask about cash, margin, inventory, ROIC, and decisions.
              </p>
            </div>
            <button
              onClick={() => onOpenChange(false)}
              aria-label="Close"
              className="text-ink-mute hover:text-ink p-1 -m-1 rounded-md transition-colors"
            >
              <X size={16} strokeWidth={1.75} />
            </button>
          </div>

          {/* Context chips — what the model is grounded in */}
          <div className="mt-3.5 flex flex-wrap items-center gap-1.5">
            <ContextChip label="Page"    value={currentPage} />
            <ContextChip label="Workspace" value="Your workspace" />
          </div>
        </div>

        {/* Messages OR empty state */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-5 space-y-5">
          {messages.length === 0 ? (
            <EmptyState onPrompt={send} />
          ) : (
            <>
              {messages.map((m, i) =>
                m.role === "user" ? (
                  <UserBubble key={i} text={m.text} />
                ) : (
                  <AiBubble key={i} answer={m.answer} />
                ),
              )}
              {thinking && <ThinkingBubble />}
            </>
          )}
        </div>

        {/* Input */}
        <div className="border-t border-rule/60 px-3 py-3">
          {messages.length > 0 && (
            <div className="px-1 pb-2 flex items-center justify-between">
              <span className="text-[11px] text-ink-mute">{messages.length / 2} messages</span>
              <button
                onClick={reset}
                className="text-[11px] text-ink-mute hover:text-ink transition-colors"
              >
                Clear chat
              </button>
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
            className="
              flex items-end gap-2 rounded-xl border border-rule-strong
              bg-bg-2
              focus-within:border-brand focus-within:bg-surface
              transition-colors
              px-3 py-2.5
            "
          >
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
              rows={1}
              placeholder="Ask CFO AI about this portfolio…"
              className="
                flex-1 bg-transparent text-[13.5px] text-ink placeholder:text-ink-mute
                resize-none outline-none leading-[1.5] py-0.5
                max-h-[140px]
              "
            />
            <button
              type="submit"
              disabled={!input.trim()}
              aria-label="Send"
              className="
                inline-flex items-center justify-center
                w-8 h-8 rounded-lg shrink-0
                bg-brand text-bg
                hover:brightness-110 transition
                disabled:opacity-40 disabled:cursor-not-allowed
              "
            >
              <ArrowUp size={14} strokeWidth={2.25} />
            </button>
          </form>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ─── Context chip ─────────────────────────────────────────────────────

function ContextChip({ label, value }: { label: string; value: string }) {
  return (
    <span
      className="
        inline-flex items-center gap-1.5
        rounded-md bg-bg-2 dark:bg-surface-hi
        border border-rule
        px-2 py-1 text-[11px] text-ink-soft
      "
    >
      <span className="text-ink-mute uppercase tracking-[0.08em] text-[10px]">
        {label}
      </span>
      <span className="text-ink">{value}</span>
    </span>
  );
}

// ─── Empty state ─────────────────────────────────────────────────────────

function EmptyState({ onPrompt }: { onPrompt: (q: string) => void }) {
  return (
    <div>
      <div className="rounded-xl border border-rule bg-bg-2 p-5 mb-5">
        <div className="text-[14px] font-medium text-ink">
          What's on your mind?
        </div>
        <p className="mt-1.5 text-[12.5px] text-ink-soft leading-snug">
          I'll answer with numbers from your current dataset, not generic
          analysis. Pick a starter or type a question below.
        </p>
      </div>
      {Object.entries(SUGGESTED_PROMPTS).map(([group, prompts]) => (
        <div key={group} className="mb-4">
          <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute mb-2 px-1">
            {group}
          </div>
          <div className="grid gap-1.5">
            {prompts.map((p) => (
              <button
                key={p}
                onClick={() => onPrompt(p)}
                className="
                  text-left rounded-lg border border-rule
                  bg-surface
                  hover:bg-brand-tint hover:border-brand/40
                  px-3.5 py-2.5 text-[13px] text-ink
                  transition-all duration-150
                "
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Message bubbles ─────────────────────────────────────────────────────

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-tr-md bg-brand/10 dark:bg-surface-hi border border-brand/20 dark:border-rule px-4 py-2.5 text-[13.5px] text-ink leading-relaxed">
        {text}
      </div>
    </div>
  );
}

function ThinkingBubble() {
  return (
    <div className="flex flex-col gap-2.5 max-w-[92%]">
      <div className="inline-flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.12em] text-brand">
        <Sparkles size={10} strokeWidth={2} />
        Copilot
      </div>
      <div className="inline-flex items-center gap-1.5 text-[12px] text-ink-mute">
        <span className="w-1.5 h-1.5 rounded-full bg-ink-mute animate-pulse" />
        <span className="w-1.5 h-1.5 rounded-full bg-ink-mute animate-pulse" style={{ animationDelay: "150ms" }} />
        <span className="w-1.5 h-1.5 rounded-full bg-ink-mute animate-pulse" style={{ animationDelay: "300ms" }} />
        <span className="ml-1">thinking…</span>
      </div>
    </div>
  );
}

function AiBubble({ answer }: { answer: AnswerBlocks }) {
  return (
    <div className="flex flex-col gap-2.5 max-w-[92%]">
      <div className="inline-flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.12em] text-brand">
        <Sparkles size={10} strokeWidth={2} />
        Copilot
      </div>
      <div className="space-y-3">
        {answer.blocks.map((block, i) => (
          <Block key={i} block={block} />
        ))}
      </div>
    </div>
  );
}

function Block({ block }: { block: ChatBlock }) {
  return (
    <div className="space-y-2">
      {block.text && <Markdown text={block.text} />}
      {block.stats && (
        <div className="grid grid-cols-2 gap-2 my-2">
          {block.stats.map((s) => (
            <div
              key={s.label}
              className="rounded-lg border border-rule bg-bg-2 px-3 py-2"
            >
              <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute">
                {s.label}
              </div>
              <div className="mt-1 text-[15px] font-medium text-ink tnum">
                {s.value}
              </div>
            </div>
          ))}
        </div>
      )}
      {block.list && (
        <ul className="space-y-1.5">
          {block.list.map((item, i) => (
            <li
              key={i}
              className="flex gap-2 text-[13px] text-ink-soft leading-[1.5]"
            >
              <span className="text-brand mt-1.5 shrink-0">·</span>
              <span
                className="text-ink/90"
                dangerouslySetInnerHTML={{ __html: renderInline(item) }}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Inline markdown — bold, italic, inline code. Run after escaping the
// underlying text so the only HTML in the output is what we add here. Safe
// even though Claude's response is the input: we escape first.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function renderInline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code class="px-1 py-0.5 rounded bg-bg-2 text-[12.5px] font-mono text-ink">$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong class="text-ink font-medium">$1</strong>')
    .replace(/\*(.+?)\*/g, '<em class="not-italic text-ink-soft">$1</em>');
}

// Block-level markdown for the LLM-generated responses. Parses the answer
// into paragraphs / headers / lists / code blocks. Keeps the surface
// scoped to what Claude actually emits — no link rendering yet, no tables,
// no images. If we need richer rendering later, swap this for react-markdown.
function Markdown({ text }: { text: string }) {
  const segments = parseMarkdown(text);
  return (
    <div className="space-y-2 text-[13.5px] text-ink leading-[1.55]">
      {segments.map((seg, i) => {
        if (seg.kind === "h2") {
          return (
            <h3 key={i} className="text-[14px] font-medium text-ink mt-1.5">
              {seg.text}
            </h3>
          );
        }
        if (seg.kind === "h3") {
          return (
            <h4 key={i} className="text-[12.5px] uppercase tracking-[0.06em] text-ink-soft mt-1.5">
              {seg.text}
            </h4>
          );
        }
        if (seg.kind === "ul") {
          return (
            <ul key={i} className="space-y-1.5">
              {seg.items.map((item, j) => (
                <li key={j} className="flex gap-2 text-ink-soft leading-[1.5]">
                  <span className="text-brand mt-1.5 shrink-0">·</span>
                  <span
                    className="text-ink/90"
                    dangerouslySetInnerHTML={{ __html: renderInline(item) }}
                  />
                </li>
              ))}
            </ul>
          );
        }
        if (seg.kind === "ol") {
          return (
            <ol key={i} className="space-y-1.5">
              {seg.items.map((item, j) => (
                <li key={j} className="flex gap-2 text-ink-soft leading-[1.5]">
                  <span className="text-ink-mute mt-0 shrink-0 w-4 text-right">{j + 1}.</span>
                  <span
                    className="text-ink/90"
                    dangerouslySetInnerHTML={{ __html: renderInline(item) }}
                  />
                </li>
              ))}
            </ol>
          );
        }
        if (seg.kind === "code") {
          return (
            <pre key={i} className="rounded-lg bg-bg-2 border border-rule px-3 py-2 overflow-x-auto text-[12px] font-mono text-ink whitespace-pre">
              {seg.text}
            </pre>
          );
        }
        if (seg.kind !== "p") return null; // exhaustiveness — narrows seg to the paragraph shape
        // paragraph — preserve single newlines as <br> so Claude's
        // intentional line breaks survive.
        return (
          <p
            key={i}
            className="text-ink leading-[1.55]"
            dangerouslySetInnerHTML={{ __html: renderInline(seg.text).replace(/\n/g, "<br />") }}
          />
        );
      })}
    </div>
  );
}

type MdSegment =
  | { kind: "p" | "h2" | "h3" | "code"; text: string }
  | { kind: "ul" | "ol"; items: string[] };

function parseMarkdown(src: string): MdSegment[] {
  const out: MdSegment[] = [];
  const lines = src.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Fenced code block
    if (line.startsWith("```")) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        buf.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      out.push({ kind: "code", text: buf.join("\n") });
      continue;
    }
    // Headers
    if (/^###\s+/.test(line)) {
      out.push({ kind: "h3", text: line.replace(/^###\s+/, "") });
      i++;
      continue;
    }
    if (/^##\s+/.test(line)) {
      out.push({ kind: "h2", text: line.replace(/^##\s+/, "") });
      i++;
      continue;
    }
    if (/^#\s+/.test(line)) {
      // Treat single # like h2 to keep things compact in the bubble.
      out.push({ kind: "h2", text: line.replace(/^#\s+/, "") });
      i++;
      continue;
    }
    // Bullet list
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s+/, ""));
        i++;
      }
      out.push({ kind: "ul", items });
      continue;
    }
    // Numbered list
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ""));
        i++;
      }
      out.push({ kind: "ol", items });
      continue;
    }
    // Blank line
    if (line.trim() === "") {
      i++;
      continue;
    }
    // Paragraph — collect until blank line or block-level start.
    const paraLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !/^(```|#{1,3}\s|[-*]\s|\d+\.\s)/.test(lines[i])) {
      paraLines.push(lines[i]);
      i++;
    }
    out.push({ kind: "p", text: paraLines.join("\n") });
  }
  return out;
}
