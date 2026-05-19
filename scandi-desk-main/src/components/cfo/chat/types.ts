// Shared types for the CFO AI chat experience.
//
// The chat surface ships in TWO mounted modes that share these types
// (and the components / store / hooks under this folder):
//
//   1. The full /chat page (src/pages/cfo/Chat.tsx) — three-column
//      workspace: history sidebar · message stream · sticky composer.
//   2. A slide-over panel (CFOChatPanel) — opened from the top-right
//      "Ask CFO AI" button on every non-/chat route. Uses the SAME
//      conversation engine, message components, and composer.
//
// Conversation history lives in localStorage on the client for now
// (frontend persistence; schema-ready for a future backend table).
// The shape mirrors what a Supabase `chat_conversations` /
// `chat_messages` pair would persist.

export type ChatRole = "user" | "assistant";

export interface ChatAttachment {
  /** Stable id (uuid-ish). */
  id: string;
  /** Filename shown to the user. */
  name: string;
  /** Size in bytes (for the chip caption). */
  size: number;
  /** MIME type. */
  type: string;
  /** Processing status the chip surfaces. */
  status: "queued" | "uploading" | "reading" | "extracting" | "ready" | "error";
  /** Optional human-readable error message. */
  error?: string;
}

export interface ChatMessage {
  /** Stable id (uuid-ish). */
  id: string;
  role: ChatRole;
  /** Markdown-ish plain text the assistant returned, or the user prompt. */
  content: string;
  /** Unix ms. Drives sorting + grouping. */
  createdAt: number;
  /** For assistant turns that ran with a workspace snapshot. Empty
   *  string when grounded only in open-domain knowledge. */
  groundedPeriod?: string | null;
  /** Optional attachments included with this turn (user role only). */
  attachments?: ChatAttachment[];
  /** Set on the assistant turn while the request is in flight. */
  pending?: boolean;
}

export interface ChatConversation {
  id: string;
  /** Short title — derived from the first user message after the first
   *  exchange, or "New conversation" until then. The user can rename. */
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Stamped with whatever ?period= was active when this conversation
   *  was created. Lets the history sidebar group by period later. */
  organizationId?: string | null;
  periodId?: string | null;
  periodLabel?: string | null;
  messages: ChatMessage[];
}

/** Localstorage key for the conversation store. Bumped only on
 *  shape-breaking changes; minor field additions can be tolerated
 *  by the migration in `loadConversations()`.                       */
export const CHAT_STORAGE_KEY = "cfo-ai-chat-history-v1";
