// THE CAPSULE — the hook that binds the pipeline to the thread.
//
// Everything stateful about asking a question lives here so the palette
// stays a rendering surface: plan → run → patch the thread, one
// in-flight turn at a time, with an AbortController the overlay can pull
// when the reader leaves.
//
// The thread itself is module state (`capsuleThread`), not component
// state, because the overlay unmounts on close and the conversation has
// to survive that. This hook never owns the turns; it only appends to
// and patches them.

import { useCallback, useEffect, useMemo, useRef } from "react";

import {
  answerToNativeText,
  edgeGenerationTransport,
  evidenceToNativeText,
  newTurn,
  runAnswerTurn,
  type CapsuleTurn,
  type GenerationTransport,
} from "./capsuleAnswerClient";
import {
  planRetrieval,
  type RetrievalContext,
  type ToolTransport,
} from "./capsuleRetrieval";
import { tier0Turn } from "./capsuleTier0Turn";
import type { Tier0Answer } from "@/lib/capsuleTier0";
import { engineToolTransport } from "./capsuleToolsApi";
import {
  collapseThread,
  openThread,
  patchTurn,
  pushTurn,
  useCapsuleThread,
} from "./capsuleThread";

export interface UseCapsuleAnswerOptions {
  retrieval: RetrievalContext;
  companyName: string | null;
  language: string;
  page?: string;
  /** Test / harness seams. Default to the live engine + Edge Function. */
  toolTransport?: ToolTransport;
  generate?: GenerationTransport;
}

export interface CapsuleAnswerApi {
  turns: readonly CapsuleTurn[];
  busy: boolean;
  ask: (question: string) => void;
  /**
   * Answer WITHOUT the model, from a Tier-0 resolution the caller
   * already has in hand.
   *
   * Returns true when the turn was taken. False means "Tier 0 does not
   * answer this" and the caller must fall through to `ask` — which is
   * the ONLY path in this hook that reaches a transport. The separation
   * is the point: `answerLocally` has no `AbortController`, no
   * `runAnswerTurn`, no `generate`, so it cannot spend even by mistake.
   */
  answerLocally: (question: string, tier0: Tier0Answer | null) => boolean;
  retry: (turn: CapsuleTurn) => void;
  /** Escape — keeps the thread alive for its grace window. */
  collapse: () => void;
  /** Enter answer mode for the current scope. Returns true when an
   *  existing thread was resumed. */
  open: () => boolean;
  /** The whole thread as chat-ready native text, for the hand-off. */
  transcript: () => { question: string; answer: string }[];
}

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `turn-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  }
}

/** The guarded TEMPLATE text of a finished turn — placeholders intact.
 *  This is what rides into the model's context on the next turn, so the
 *  contract holds across a whole thread instead of being re-argued each
 *  time. */
export function turnTemplateText(turn: CapsuleTurn): string {
  return turn.blocks
    .map((b) => (b.kind === "bullet" ? `- ${b.template}` : b.template))
    .join("\n\n");
}

export function useCapsuleAnswer(opts: UseCapsuleAnswerOptions): CapsuleAnswerApi {
  const thread = useCapsuleThread();
  const abortRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);

  const toolTransport = useMemo(
    () => opts.toolTransport ?? engineToolTransport(),
    [opts.toolTransport],
  );
  const generate = useMemo(
    () => opts.generate ?? edgeGenerationTransport(),
    [opts.generate],
  );

  // The scope key: a thread asked about Dec 2025 must not reappear over
  // Jan 2026's figures.
  const scope = `${opts.retrieval.periodId ?? "none"}`;

  const busy = thread.turns.some((t) => t.status === "retrieving" || t.status === "generating");
  busyRef.current = busy;

  const run = useCallback(
    (question: string, history: { question: string; answer: string }[]) => {
      const controller = new AbortController();
      abortRef.current?.abort();
      abortRef.current = controller;

      const id = newId();
      const plan = planRetrieval(question, opts.retrieval);
      pushTurn(newTurn(id, question, Date.now()));
      void runAnswerTurn({
        turnId: id,
        question,
        history,
        plan,
        toolTransport,
        generate,
        language: opts.language,
        companyName: opts.companyName,
        page: opts.page ?? "Capsule",
        signal: controller.signal,
        onUpdate: patchTurn,
      });
    },
    [opts.retrieval, opts.language, opts.companyName, opts.page, toolTransport, generate],
  );

  const ask = useCallback(
    (question: string) => {
      const q = question.trim();
      if (!q || busyRef.current) return;
      const history = thread.turns
        .filter((t) => t.status === "done" && t.blocks.length > 0)
        .map((t) => ({ question: t.question, answer: turnTemplateText(t) }));
      run(q, history);
    },
    [run, thread.turns],
  );

  const answerLocally = useCallback(
    (question: string, tier0: Tier0Answer | null) => {
      const q = question.trim();
      if (!q || busyRef.current) return false;
      const turn = tier0Turn(newId(), q, tier0, Date.now());
      if (!turn) return false;
      pushTurn(turn);
      return true;
    },
    [],
  );

  const retry = useCallback(
    (turn: CapsuleTurn) => {
      if (busyRef.current) return;
      run(turn.question, []);
    },
    [run],
  );

  const collapse = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    collapseThread();
  }, []);

  const open = useCallback(() => openThread(scope), [scope]);

  const transcript = useCallback(
    () =>
      thread.turns
        .filter((t) => t.status === "done")
        .map((t) => ({
          question: t.question,
          // A figures-only turn (Tier 0, or a deterministic fallback)
          // has no blocks. Handing chat an EMPTY answer would move the
          // question across and drop the figures that answered it.
          answer: t.blocks.length
            ? answerToNativeText(t.blocks, t.evidence)
            : evidenceToNativeText(t.evidence),
        })),
    [thread.turns],
  );

  // Leaving the surface for good must not leave a request in flight
  // billing tokens for an answer nobody will read.
  useEffect(() => () => abortRef.current?.abort(), []);

  return {
    turns: thread.turns,
    busy,
    ask,
    answerLocally,
    retry,
    collapse,
    open,
    transcript,
  };
}
