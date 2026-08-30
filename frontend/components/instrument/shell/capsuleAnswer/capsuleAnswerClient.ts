// THE CAPSULE — THE ANSWER PIPELINE.
//
//   question
//     └─ plan            (pure keyword tables — capsuleRetrieval)
//        └─ retrieve     (read-only tools; the model is not involved)
//           └─ generate  (FACTS + question; no files, no db, no writes)
//              └─ guard  (numeral ban — capsuleAnswerGuard)
//                 └─ regenerate ONCE on violation
//                    └─ deterministic fallback
//
// Four properties this file is responsible for, each enforced by
// construction rather than by prompt:
//
//   RETRIEVAL FIRST   `runAnswerTurn` cannot reach `generate` without
//                     having awaited `runPlan`. The model receives the
//                     merged evidence and the question; there is no
//                     parameter through which a file, a row handle or a
//                     credential could reach it.
//   NO WRITES         the only transports this module accepts are a
//                     read-only tool caller and a text generator. There
//                     is no mutation surface to misuse — not a disabled
//                     one, an absent one.
//   NO NUMERALS       the guard runs on EVERY completion, including the
//                     regeneration, and its failure path discards the
//                     prose rather than sanitising it. Half-trusted text
//                     is not rendered.
//   CALM DEGRADATION  every failure — engine down, Edge Function down,
//                     upstream 429, abort — resolves to a typed
//                     `AiFailureKind` plus whatever facts DID arrive.
//                     No raw payload is ever placed on the turn (A2).

import {
  classifyUpstreamAnswer,
  reportAiFailure,
  type AiFailureKind,
} from "@/lib/aiDegraded";
import { formatMoneyFrom } from "@/lib/money";
import type { Currency, Rates } from "@/lib/rates";

import {
  guardAnswer,
  toBlocks,
  violationBrief,
  type AnswerBlock,
  type GuardViolation,
  PLACEHOLDER_RE,
} from "./capsuleAnswerGuard";
import {
  runPlan,
  type CapsulePlanStep,
  type ToolTransport,
} from "./capsuleRetrieval";
import {
  emptyEvidence,
  type CapsuleEvidence,
} from "./capsuleAnswerTypes";
import { visualsFrom, type CapsuleVisual } from "./capsuleAnswerVisuals";

// ── the turn ───────────────────────────────────────────────────────────

export type TurnStatus = "retrieving" | "generating" | "done" | "failed";

export interface TraceLine {
  id: string;
  key: string;
  params: Record<string, string>;
  state: "pending" | "ok" | "missing";
}

export interface TurnTiming {
  startedAt: number;
  /** Plan + every tool read, merged. */
  retrievalMs: number | null;
  /** THE latency contract (C9): question submitted → first generated
   *  chunk in hand. Null when generation never started. */
  firstTokenMs: number | null;
  totalMs: number | null;
}

export interface CapsuleTurn {
  id: string;
  question: string;
  status: TurnStatus;
  trace: TraceLine[];
  evidence: CapsuleEvidence;
  /** Guarded prose, ready for `NarrativeText`. Empty on the
   *  deterministic path — the figures speak instead. */
  blocks: AnswerBlock[];
  /** Text as it streams, before the guard has had a chance to run. Never
   *  rendered as prose; the panel shows it only as a progress shimmer. */
  streaming: string;
  visuals: CapsuleVisual[];
  citedFacts: string[];
  /** True when the model's prose was refused and the answer is the
   *  evidence alone. */
  deterministic: boolean;
  /**
   * True when this turn was answered by TIER 0 — the local fact index —
   * with no reservation taken and no request issued.
   *
   * Deliberately separate from `deterministic`. Both turns carry figures
   * and no prose, but they mean opposite things to a reader: a
   * deterministic turn is "the assistant's wording was rejected", a
   * Tier-0 turn is "no assistant was needed". Collapsing them would put
   * an apology under an answer that has nothing to apologise for.
   */
  tier0?: boolean;
  regenerated: boolean;
  violations: GuardViolation[];
  degraded: AiFailureKind | null;
  timing: TurnTiming;
}

export function newTurn(id: string, question: string, startedAt: number): CapsuleTurn {
  return {
    id,
    question,
    status: "retrieving",
    trace: [],
    evidence: emptyEvidence(),
    blocks: [],
    streaming: "",
    visuals: [],
    citedFacts: [],
    deterministic: false,
    tier0: false,
    regenerated: false,
    violations: [],
    degraded: null,
    timing: { startedAt, retrievalMs: null, firstTokenMs: null, totalMs: null },
  };
}

// ── generation transport ───────────────────────────────────────────────

export interface GenerationRequest {
  messages: { role: "user" | "assistant"; content: string }[];
  datasetSummary: string;
  page: string;
  companyName: string | null;
}

/** A generator of text chunks. The Edge Function yields exactly one (it
 *  is not a streaming endpoint); a fixture yields many. The pipeline
 *  measures first-token on the FIRST yield either way, so swapping in a
 *  streaming transport later changes the number, not the code. */
export type GenerationTransport = (
  req: GenerationRequest,
  signal?: AbortSignal,
) => AsyncIterable<string>;

/** Thrown when the Edge Function wrapped an upstream failure in a 200.
 *  Carries only the classified kind — the raw payload stays in
 *  console.debug where `aiDegraded` put it. */
export class UpstreamAnswerFailure extends Error {
  kind: AiFailureKind;
  constructor(kind: AiFailureKind) {
    super("upstream answer failure");
    this.name = "UpstreamAnswerFailure";
    this.kind = kind;
  }
}

/** The live transport: Ask CFO AI's Supabase Edge Function.
 *
 *  `display_currency` / `fx_context` are DELIBERATELY not sent. Those
 *  fields make the Edge Function instruct the model to cite figures in
 *  the reader's display currency — which is precisely the job this
 *  surface takes away from the model and gives to `NarrativeText`.
 *  Sending them would invite the one class of output the guard exists to
 *  reject. */
export function edgeGenerationTransport(): GenerationTransport {
  return async function* generate(req, signal) {
    const { cfoApi } = await import("@/lib/cfoApi");
    const res = await cfoApi.chatLlm(
      {
        messages: req.messages,
        dataset_summary: req.datasetSummary,
        page: req.page,
        company_name: req.companyName ?? undefined,
        mode: "workspace",
      },
      signal,
    );
    const answer = res.answer ?? "";
    // A2: the Edge Function returns upstream failures as a 200 whose
    // answer IS the error string. Intercept it here or it walks onto the
    // surface dressed as an answer.
    const upstream = classifyUpstreamAnswer(answer);
    if (upstream) throw new UpstreamAnswerFailure(upstream);
    yield answer;
  };
}

// ── the brief ──────────────────────────────────────────────────────────

const LANGUAGE_NAME: Record<string, string> = {
  en: "English",
  ro: "Romanian, informal (tu-form)",
};

/** How many prior turns ride along. Four keeps a follow-up coherent
 *  ("and the month before?") without turning a one-line overlay into an
 *  unbounded context bill. */
export const CONTEXT_TURNS = 4;

function factLines(evidence: CapsuleEvidence): string[] {
  return Object.values(evidence.factMeta).map((m) => {
    const scope = m.periodLabel || m.scope || "—";
    return `  ${m.fact} · ${m.unit} · ${scope} · ${m.value}`;
  });
}

/** The compact grounding digest handed to the Edge Function's own
 *  "active workspace snapshot" block. Names and shapes only — the VALUES
 *  live in the brief, where the contract that governs them also lives. */
export function buildDatasetSummary(evidence: CapsuleEvidence): string {
  const lines: string[] = [];
  if (evidence.periods.length) {
    lines.push(`Periods in scope: ${evidence.periods.map((p) => p.label).join(", ")}`);
  }
  if (evidence.currency) lines.push(`Source currency: ${evidence.currency}`);
  const names = Object.keys(evidence.factMeta);
  lines.push(
    names.length
      ? `Retrieved facts: ${names.join(", ")}`
      : "Retrieved facts: none — this question was not grounded in any served figure.",
  );
  if (evidence.gaps.length) {
    lines.push(`Absent: ${evidence.gaps.map((g) => g.code).join(", ")}`);
  }
  if (evidence.limitations.length) {
    lines.push(`Refused reads: ${evidence.limitations.map((l) => l.rule).join(", ")}`);
  }
  lines.push(
    "Figures are rendered by the interface from named facts. The assistant writes placeholders, never numerals.",
  );
  return lines.join("\n");
}

/** The user-turn brief: the contract, the evidence, the question. */
export function buildBrief(
  question: string,
  evidence: CapsuleEvidence,
  language: string,
): string {
  const lang = LANGUAGE_NAME[language] ?? LANGUAGE_NAME.en;
  const facts = factLines(evidence);
  const parts: string[] = [];

  parts.push(
    "ANSWER CONTRACT — this panel renders every figure itself.",
    "",
    "1. Write NO digits. Cite a figure only as a placeholder:",
    "   {{money:FACT_NAME}} for a money fact, {{fact:FACT_NAME}} for any other unit.",
    "2. Only the names under FACTS exist. Never invent, rename or abbreviate one.",
    "3. Do no arithmetic. A difference, ratio or percentage you were not given does not exist.",
    "4. Never write a currency code, a currency symbol, an exchange rate, or a magnitude word.",
    "5. If FACTS is empty or does not reach the question, say plainly what is missing and what",
    "   the reader should do — GAPS gives you both. Never approximate, never reassure.",
    "6. Two to four sentences, or up to four short bullets. No headings, no preamble,",
    "   no restating the question.",
    `7. Answer in ${lang}.`,
    "",
  );

  if (facts.length) {
    parts.push(
      "FACTS — name · unit · period/scope · value.",
      "The value column is REFERENCE ONLY so you can reason about size; transcribing it is a violation.",
      ...facts,
      "",
    );
  } else {
    parts.push("FACTS — none were retrieved for this question.", "");
  }

  if (evidence.gaps.length) {
    parts.push(
      "GAPS — what is absent, and what would close it.",
      ...evidence.gaps
        .slice(0, 8)
        .map((g) => `  ${g.code} · ${g.detail || "—"} · fix: ${g.fix || "—"}`),
      "",
    );
  }
  if (evidence.limitations.length) {
    parts.push(
      "LIMITATIONS — reads that were refused on purpose. State the rule; do not retry it.",
      ...evidence.limitations
        .slice(0, 6)
        .map((l) => `  ${l.rule} · ${l.detail || "—"}`),
      "",
    );
  }

  parts.push("QUESTION", `  ${question.trim()}`);
  return parts.join("\n");
}

// ── the turn runner ────────────────────────────────────────────────────

export interface AnswerTurnInput {
  turnId: string;
  question: string;
  /** Prior turns, oldest first. `answer` is the GUARDED template text —
   *  placeholders intact, so the contract holds across the thread. */
  history: readonly { question: string; answer: string }[];
  plan: readonly CapsulePlanStep[];
  toolTransport: ToolTransport;
  generate: GenerationTransport;
  language: string;
  companyName?: string | null;
  page?: string;
  signal?: AbortSignal;
  onUpdate?: (turn: CapsuleTurn) => void;
  /** Injected clock — the latency harness and the tests need a
   *  deterministic one. */
  now?: () => number;
}

async function collect(
  stream: AsyncIterable<string>,
  onFirst: () => void,
  onChunk: (soFar: string) => void,
): Promise<string> {
  let text = "";
  let first = true;
  for await (const chunk of stream) {
    if (first) {
      first = false;
      onFirst();
    }
    text += chunk;
    onChunk(text);
  }
  return text;
}

/**
 * Run one question end to end. Resolves with the finished turn; pushes
 * every intermediate state through `onUpdate` so the panel can render
 * the retrieval trace while the reads are still in flight.
 */
export async function runAnswerTurn(input: AnswerTurnInput): Promise<CapsuleTurn> {
  const clock = input.now ?? (() => Date.now());
  const t0 = clock();
  let turn = newTurn(input.turnId, input.question, t0);
  turn.trace = input.plan.map((step) => ({
    id: step.id,
    key: step.traceKey,
    params: step.traceParams,
    state: "pending" as const,
  }));
  const emit = () => {
    turn = { ...turn };
    input.onUpdate?.(turn);
  };
  emit();

  // ── 1. RETRIEVE ──────────────────────────────────────────────────────
  const { evidence, outcomes } = await runPlan(
    input.plan,
    input.toolTransport,
    input.signal,
  );
  turn.evidence = evidence;
  turn.trace = outcomes.map((o) => ({
    id: o.step.id,
    key: o.step.traceKey,
    params: o.step.traceParams,
    state: o.ok ? ("ok" as const) : ("missing" as const),
  }));
  turn.timing.retrievalMs = clock() - t0;
  turn.visuals = visualsFrom(evidence);
  turn.status = "generating";
  emit();

  // ── 2. GENERATE ──────────────────────────────────────────────────────
  const datasetSummary = buildDatasetSummary(evidence);
  const messages: GenerationRequest["messages"] = [];
  for (const prior of input.history.slice(-CONTEXT_TURNS)) {
    messages.push({ role: "user", content: prior.question });
    if (prior.answer) messages.push({ role: "assistant", content: prior.answer });
  }
  messages.push({
    role: "user",
    content: buildBrief(input.question, evidence, input.language),
  });

  const req: GenerationRequest = {
    messages,
    datasetSummary,
    page: input.page ?? "Capsule",
    companyName: input.companyName ?? null,
  };

  const guardInput = {
    facts: evidence.facts,
    factUnits: evidence.factUnits,
    literals: [...evidence.literals, ...questionLiterals(input.question)],
  };

  let text = "";
  try {
    text = await collect(
      input.generate(req, input.signal),
      () => {
        turn.timing.firstTokenMs = clock() - t0;
      },
      (soFar) => {
        turn.streaming = soFar;
        emit();
      },
    );
  } catch (err) {
    // Abort is the user closing the surface, not a failure to report.
    if (isAbort(err)) {
      turn.status = "failed";
      turn.timing.totalMs = clock() - t0;
      emit();
      return turn;
    }
    turn.degraded =
      err instanceof UpstreamAnswerFailure ? err.kind : reportAiFailure(err);
    turn.deterministic = true;
    turn.status = "done";
    turn.streaming = "";
    turn.timing.totalMs = clock() - t0;
    emit();
    return turn;
  }

  // ── 3. GUARD ─────────────────────────────────────────────────────────
  let verdict = guardAnswer(text, guardInput);

  // ── 4. ONE regeneration, with the violation quoted back ─────────────
  if (!verdict.ok) {
    turn.regenerated = true;
    turn.violations = verdict.violations;
    emit();
    const retry: GenerationRequest = {
      ...req,
      messages: [
        ...messages,
        { role: "assistant", content: text },
        {
          role: "user",
          content:
            "That answer broke the contract and was rejected before it reached the reader:\n" +
            violationBrief(verdict.violations) +
            "\n\nRewrite it. Same content, same length, placeholders only, no digits.",
        },
      ],
    };
    try {
      const second = await collect(
        input.generate(retry, input.signal),
        () => {},
        (soFar) => {
          turn.streaming = soFar;
          emit();
        },
      );
      const secondVerdict = guardAnswer(second, guardInput);
      if (secondVerdict.ok) {
        text = second;
        verdict = secondVerdict;
      }
    } catch (err) {
      if (!isAbort(err)) {
        turn.degraded =
          err instanceof UpstreamAnswerFailure ? err.kind : reportAiFailure(err);
      }
    }
  }

  // ── 5. RENDER or FALL BACK ───────────────────────────────────────────
  turn.streaming = "";
  if (verdict.ok) {
    turn.blocks = toBlocks(text);
    turn.citedFacts = verdict.citedFacts;
    turn.violations = [];
  } else {
    // The prose is discarded WHOLE. A sanitised half-answer would be a
    // claim nobody wrote and nobody checked.
    turn.blocks = [];
    turn.citedFacts = Object.keys(evidence.factMeta);
    turn.deterministic = true;
    turn.violations = verdict.violations;
  }
  turn.status = "done";
  turn.timing.totalMs = clock() - t0;
  emit();
  return turn;
}

function isAbort(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (typeof err === "object" && err !== null && (err as { name?: string }).name === "AbortError")
  );
}

/** Digit-bearing tokens from the reader's OWN question. Restating the
 *  premise ("if revenue falls 10%") is not the model inventing a figure. */
export function questionLiterals(question: string): string[] {
  return (question ?? "").match(/[\p{L}]*\d[\p{L}\d./%-]*/gu) ?? [];
}

// ── native text (Copy, and the hand-off to full chat) ─────────────────

/**
 * Resolve an answer to plain text in its NATIVE currency.
 *
 * Used by Copy and by "Open in chat", both of which leave this surface
 * for one that has no placeholder renderer. Native + explicitly labelled
 * is the only honest form there: a display-converted figure pasted into
 * a document carries a rate nobody can see, and mixing the two inside
 * one sentence is the 461 defect exactly.
 */
export function answerToNativeText(
  blocks: readonly AnswerBlock[],
  evidence: CapsuleEvidence,
  opts: { locale?: string } = {},
): string {
  const currency = (evidence.currency ?? "RON") as Currency;
  const resolve = (template: string) =>
    template.replace(new RegExp(PLACEHOLDER_RE.source, "g"), (_full, token, fact, rawOpts) => {
      const value = evidence.facts[fact];
      if (typeof value !== "number" || !Number.isFinite(value)) return "—";
      const unit = evidence.factUnits[fact];
      const opt = String(rawOpts ?? "");
      const abs = opt.includes("|abs") ? Math.abs(value) : value;
      if (token === "money" || unit === "money") {
        return formatMoneyFrom(abs, currency, currency, {} as Rates, {
          fractionDigits: 2,
          locale: opts.locale,
        });
      }
      return unit === "percent" ? `${abs}%` : String(abs);
    });

  const lines = blocks.map((b) =>
    b.kind === "bullet" ? `· ${resolve(b.template)}` : resolve(b.template),
  );
  return lines.join("\n\n");
}

/** The figure list a deterministic answer shows instead of prose, in
 *  native units. Same honesty rule as `answerToNativeText`. */
export function evidenceToNativeText(
  evidence: CapsuleEvidence,
  opts: { locale?: string } = {},
): string {
  const currency = (evidence.currency ?? "RON") as Currency;
  return Object.values(evidence.factMeta)
    .map((m) => {
      const scope = m.periodLabel ? ` (${m.periodLabel})` : "";
      const value =
        m.unit === "money"
          ? formatMoneyFrom(m.value, currency, currency, {} as Rates, {
              fractionDigits: 2,
              locale: opts.locale,
            })
          : m.unit === "percent"
          ? `${m.value}%`
          : String(m.value);
      return `${m.metric || m.fact}${scope}: ${value}`;
    })
    .join("\n");
}
