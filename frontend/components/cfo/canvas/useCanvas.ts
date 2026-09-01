// THE CANVAS — the hook that binds the surface to the engine.
//
// Everything stateful about asking lives here so the components stay
// rendering surfaces. It is the Capsule's `useCapsuleAnswer` grown a
// second and third lane, and it keeps that hook's most important
// property: THE THREE TIERS ARE THREE DIFFERENT CLOSURES, and each can
// only reach what its own scope contains.
//
//   TIER 0   `answerLocally`  — the local fact index. No AbortController,
//            no tool transport, no generator in scope. It CANNOT spend,
//            and not because it checks a flag: because there is nothing
//            in the closure to spend with. Dependency list is `[]`.
//
//   ENGINE   `runEngineOnly`  — read-only tools. `toolTransport` is in
//            scope; `generate` is NOT. This is the lane every slash
//            command and every plan step runs in, and it is the literal
//            shape of the law: the engine computes, and no model is
//            reachable from here to compose anything about it.
//
//   MODEL    `runModel`       — the only closure in this file that holds
//            `generate`. One call site, guarded by a reservation.
//
// A question descends the tiers and stops at the first that answers it.
// The order is not an optimisation, it is the money boundary: `askModel`
// reserves before it dispatches, so any arrangement where two tiers run
// together has already spent by the time the cheaper one lands. That
// defect shipped once on the Capsule (`enterAnswerMode`'s comment
// records it) and this file is written to make it unrepresentable.
//
// ══ WHAT IS DIFFERENT FROM THE CAPSULE ═════════════════════════════════
//
// The Capsule's thread is module state with a ten-minute expiry. The
// canvas keeps SEVERAL threads, per workspace, across reloads — so the
// durable half goes to `lib/canvasThread` (questions, no figures) and
// the volatile half to `canvasLiveTurns` (figures, this session only).
// This hook is what keeps the two in step: every write appends the entry
// AND parks the turn, and a restored entry with no turn is exactly what
// the surface renders as stale.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";

import {
  newTurn,
  runAnswerTurn,
  edgeGenerationTransport,
  type CapsuleTurn,
  type GenerationTransport,
} from "@/components/instrument/shell/capsuleAnswer/capsuleAnswerClient";
import {
  planRetrieval,
  runPlan,
  type RetrievalContext,
  type ToolTransport,
} from "@/components/instrument/shell/capsuleAnswer/capsuleRetrieval";
import { engineToolTransport } from "@/components/instrument/shell/capsuleAnswer/capsuleToolsApi";
import { tier0Turn } from "@/components/instrument/shell/capsuleAnswer/capsuleTier0Turn";
import { visualsFrom } from "@/components/instrument/shell/capsuleAnswer/capsuleAnswerVisuals";
import { reserveCapsuleAsk, releaseCapsuleAsk } from "@/components/instrument/shell/capsuleEmpty/capsuleAskGuard";
import { useCapsuleAskAvailability } from "@/components/instrument/shell/capsuleEmpty/useCapsuleAsk";
import { useCapsuleKeys } from "@/components/instrument/shell/capsuleEmpty/capsuleKeys";
import { rememberCapsuleQuestion } from "@/components/instrument/shell/capsuleEmpty/capsuleRecents";
import { buildFactIndex } from "@/lib/capsuleFactIndex";
import { resolveTier0, type Tier0Answer } from "@/lib/capsuleTier0";
import { useActivePeriod } from "@/lib/activePeriod";
import { usePeriodStepper } from "@/lib/usePeriodStepper";
import { useActiveLocale } from "@/lib/locale";
import { formatPeriodMonth } from "@/lib/orgPeriods";
import {
  appendCanvasEntry,
  newCanvasId,
  patchCanvasEntry,
  scopeKey,
  setCurrentCanvasThread,
  useCanvasStore,
  type CanvasArtifactKind,
  type CanvasEntry,
  type CanvasStepRecord,
  type CanvasThread,
} from "@/lib/canvasThread";

import { CANVAS_ARTIFACT_TITLE_KEY } from "./canvasI18n";
import { dropLiveTurn, getLiveTurn, setLiveTurn, useLiveTurnVersion } from "./canvasLiveTurns";
import { canvasSlashMenu, parseCanvasSlash, slashQuestion, type CanvasSlashCommand } from "./canvasSlash";
import { planFor, planIsGenerative, type CanvasPlan } from "./canvasPlan";
import {
  attachmentLooksSupported,
  stageCanvasAttachment,
} from "./canvasAttach";

export interface CanvasApi {
  /** The open thread's id. Stable across renders; a thread row is only
   *  written to storage on its first real entry. */
  threadId: string;
  threads: readonly CanvasThread[];
  entries: readonly CanvasEntry[];
  /** The period scope entries are being answered against right now. */
  scope: string;
  periodLabel: string | null;
  companyName: string | null;
  busy: boolean;
  /** True when a model call is possible at all (assistant up, burst
   *  guard open). Read by the composer to explain a refusal BEFORE the
   *  reader presses Enter. */
  modelAvailable: boolean;
  submit: (text: string) => void;
  recompute: (entry: CanvasEntry) => void;
  attach: (file: File) => void;
  newThread: () => void;
  openThread: (id: string) => void;
  slashMenu: (input: string) => readonly CanvasSlashCommand[];
  /** For the composer's inline hint. */
  parseSlash: typeof parseCanvasSlash;
  /** Bumps whenever a live turn changes — components read turns through
   *  `getLiveTurn` and re-render on this. */
  liveVersion: number;
}

function stepRecords(plan: CanvasPlan): CanvasStepRecord[] {
  return plan.steps.map((s) => ({ id: s.id, labelKey: s.labelKey, status: "pending" as const }));
}

function artifactRef(id: string, kind: CanvasArtifactKind) {
  return { id, kind, titleKey: CANVAS_ARTIFACT_TITLE_KEY[kind] ?? "canvas.artifact.figures" };
}

/**
 * Build a finished turn from evidence the ENGINE returned.
 *
 * `blocks` stays empty on purpose: this lane never composed a sentence,
 * so it must not carry one. The figures speak, exactly as they do on a
 * Tier-0 turn and on a deterministic fallback.
 */
function engineTurn(
  id: string,
  question: string,
  evidence: CapsuleTurn["evidence"],
  startedAt: number,
): CapsuleTurn {
  const base = newTurn(id, question, startedAt);
  return {
    ...base,
    status: "done",
    evidence,
    visuals: visualsFrom(evidence),
    citedFacts: Object.keys(evidence.factMeta),
    deterministic: false,
    timing: { ...base.timing, totalMs: Date.now() - startedAt },
  };
}

export interface UseCanvasOptions {
  /** Test seams. Default to the live engine + Edge Function. */
  toolTransport?: ToolTransport;
  generate?: GenerationTransport;
}

export function useCanvas(opts: UseCanvasOptions = {}): CanvasApi {
  const { i18n } = useTranslation();
  const locale = useActiveLocale();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const activePeriod = useActivePeriod();
  const { periods, selectedMonth } = usePeriodStepper();
  const { userKey, orgKey } = useCapsuleKeys();
  const askAvailability = useCapsuleAskAvailability(userKey);
  const store = useCanvasStore(orgKey);
  const liveVersion = useLiveTurnVersion();

  const abortRef = useRef<AbortController | null>(null);
  /** Mirrors the derived `busy` for `submit`, which is defined above the
   *  memo that computes it. Same pattern as `useCapsuleAnswer`. */
  const busyRef = useRef(false);
  /**
   * "A submit has been accepted but its turn is not observable yet."
   *
   * NOT the whole busy signal — see `busy` below. The first draft used a
   * plain `setBusy(true)` cleared by `window.setTimeout(finish, 400)`,
   * which unlocked the composer 400ms after DISPATCH while the answer was
   * still streaming. A second Enter then called `newController()`, which
   * aborts the previous controller — silently cancelling the answer the
   * reader was waiting for. A timer is not a completion signal.
   */
  const [dispatching, setDispatching] = useState(false);

  // ── the open thread ──────────────────────────────────────────────────
  //
  // Lazy, like the chat store's: "New thread" writes nothing. An empty
  // placeholder row would appear in the rail on every device and be the
  // first thing the reader sees, which is the exact litter §16 Milestone
  // B recorded.
  const [localThreadId, setLocalThreadId] = useState<string>(() => newCanvasId());
  const threadId = store.currentThreadId ?? localThreadId;
  const thread = store.threads.find((t) => t.id === threadId) ?? null;
  const entries = useMemo(() => thread?.entries ?? [], [thread]);

  // ── THE PERIOD LABEL, AND THE THIRD SOURCE ─────────────────────────
  //
  // The first two sources are the Capsule's, and they are right for the
  // reason its own comment gives: `selectedMonth` IS the header's answer,
  // so it is a month by construction and cannot become a company name.
  //
  // They are also both null for a period that never reaches the stepper
  // and carries no `period_end` — the demo workspace is exactly that, and
  // r1's captures caught the result: the canvas header read "No period"
  // three inches from a page header reading "FY2025", over figures the
  // thread itself labelled "Dec 2025".
  //
  // The third source is what the PAGE reads (`statements.periodLabel`).
  // It is a period label by construction too, so it cannot reintroduce
  // the company-name defect, and using it means the canvas and the page
  // can never disagree about which period is on screen.
  const periodMonth = useMemo(
    () =>
      selectedMonth ??
      formatPeriodMonth(activePeriod.periodEnd, locale) ??
      activePeriod.statements?.periodLabel ??
      null,
    [selectedMonth, activePeriod.periodEnd, activePeriod.statements, locale],
  );

  const periodOptions = useMemo(
    () =>
      periods.map((p) => ({
        id: p.period_id,
        label: formatPeriodMonth(p.period_end, locale) ?? p.period_id,
      })),
    [periods, locale],
  );

  const retrieval = useMemo<RetrievalContext>(
    () => ({
      periodId: activePeriod.id,
      periodLabel: periodMonth,
      periods: periodOptions,
    }),
    [activePeriod.id, periodMonth, periodOptions],
  );

  const scope = scopeKey(activePeriod.id);

  // ── Tier 0's index — the same single-period build the Capsule uses ───
  //
  // One period, the one that is open. Fetching the others here would put
  // a network request on the keystroke path. A single-period index still
  // answers every "what is X" and honestly refuses every comparison,
  // which is what the ENGINE lane below is for.
  const factIndex = useMemo(() => {
    const statements = activePeriod.statements;
    return buildFactIndex({
      periods:
        statements && activePeriod.id
          ? [
              {
                periodId: activePeriod.id,
                periodLabel: periodMonth ?? "",
                statements,
                metrics: Object.fromEntries(activePeriod.metrics.map((m) => [m.name, m.value])),
                docId: activePeriod.sourceDocumentFilename ?? undefined,
              },
            ]
          : [],
      activePeriodId: activePeriod.id,
    });
  }, [
    activePeriod.statements,
    activePeriod.id,
    activePeriod.metrics,
    activePeriod.sourceDocumentFilename,
    periodMonth,
  ]);

  const toolTransport = useMemo(
    () => opts.toolTransport ?? engineToolTransport(),
    [opts.toolTransport],
  );
  const generate = useMemo(
    () => opts.generate ?? edgeGenerationTransport(),
    [opts.generate],
  );

  // ════════════════════════════════════════════════════════════════════
  // TIER 0 — cannot spend, by construction
  // ════════════════════════════════════════════════════════════════════
  //
  // Dependency list `[]`. Nothing that reaches a network is in scope.
  // Adding one here would be visible in the diff as a new dependency,
  // which is the point of writing it this way.
  const answerLocally = useCallback(
    (entryId: string, question: string, tier0: Tier0Answer | null): boolean => {
      const turn = tier0Turn(entryId, question, tier0, Date.now());
      if (!turn) return false;
      setLiveTurn(entryId, turn);
      return true;
    },
    [],
  );

  // ════════════════════════════════════════════════════════════════════
  // ENGINE — read-only tools. `generate` is NOT in this closure.
  // ════════════════════════════════════════════════════════════════════
  const runEngineOnly = useCallback(
    async (entryId: string, probe: string, signal: AbortSignal): Promise<boolean> => {
      const steps = planRetrieval(probe, retrieval);
      if (steps.length === 0) return false;
      const started = Date.now();
      const result = await runPlan(steps, toolTransport, signal);
      if (signal.aborted) return false;
      if (Object.keys(result.evidence.factMeta).length === 0 && result.evidence.rows.length === 0) {
        // An honest empty. The turn still lands so the card can say the
        // engine returned nothing — an absent card would read as "the
        // step never ran".
        setLiveTurn(entryId, engineTurn(entryId, probe, result.evidence, started));
        return false;
      }
      setLiveTurn(entryId, engineTurn(entryId, probe, result.evidence, started));
      return true;
    },
    [retrieval, toolTransport],
  );

  // ════════════════════════════════════════════════════════════════════
  // MODEL — the ONE closure holding `generate`
  // ════════════════════════════════════════════════════════════════════
  const runModel = useCallback(
    (entryId: string, question: string, signal: AbortSignal) => {
      const plan = planRetrieval(question, retrieval);
      setLiveTurn(entryId, newTurn(entryId, question, Date.now()));
      void runAnswerTurn({
        turnId: entryId,
        question,
        history: [],
        plan,
        toolTransport,
        generate,
        language: (i18n.language ?? "en").toLowerCase().startsWith("ro") ? "ro" : "en",
        companyName: activePeriod.label ?? null,
        page: "Canvas",
        signal,
        onUpdate: (t) => setLiveTurn(entryId, t),
      });
    },
    [retrieval, toolTransport, generate, i18n.language, activePeriod.label],
  );

  /** The one place a canvas question reaches the model. Reservation
   *  first, released if the dispatch throws — credits are live. */
  const askModel = useCallback(
    (entryId: string, question: string, signal: AbortSignal): boolean => {
      if (!askAvailability.available) return false;
      const decision = reserveCapsuleAsk(userKey);
      if (!decision.allowed) return false;
      try {
        runModel(entryId, question, signal);
        return true;
      } catch (err) {
        releaseCapsuleAsk(userKey);
        throw err;
      }
    },
    [askAvailability.available, userKey, runModel],
  );

  // ── the router ───────────────────────────────────────────────────────

  const newController = useCallback(() => {
    abortRef.current?.abort();
    const c = new AbortController();
    abortRef.current = c;
    return c;
  }, []);

  const runPlanEntry = useCallback(
    async (entryId: string, plan: CanvasPlan, signal: AbortSignal) => {
      const steps = stepRecords(plan);
      const artifacts: { id: string; kind: CanvasArtifactKind; titleKey: string }[] = [];
      for (let i = 0; i < plan.steps.length; i += 1) {
        if (signal.aborted) return;
        const step = plan.steps[i];
        steps[i] = { ...steps[i], status: "running" };
        patchCanvasEntry(orgKey, threadId, entryId, { steps: [...steps] }, Date.now());
        let ok = true;
        if (step.probe) {
          // Each step parks its OWN turn, keyed by a per-step entry id,
          // so every step is an artifact the reader can open — not a
          // status line that dissolves into one merged answer.
          ok = await runEngineOnly(`${entryId}:${step.id}`, step.probe, signal);
        }
        if (signal.aborted) return;
        steps[i] = { ...steps[i], status: ok || !step.probe ? "done" : "failed" };
        artifacts.push(artifactRef(`${entryId}:${step.id}`, step.artifact));
        patchCanvasEntry(
          orgKey,
          threadId,
          entryId,
          { steps: [...steps], artifacts: [...artifacts] },
          Date.now(),
        );
      }
    },
    [orgKey, threadId, runEngineOnly],
  );

  const submit = useCallback(
    (text: string) => {
      const raw = (text ?? "").trim();
      if (!raw || busyRef.current) return;
      const now = Date.now();
      const entryId = newCanvasId();
      const controller = newController();

      const slash = parseCanvasSlash(raw);
      const plan = slash ? null : planFor(raw);

      const question = slash ? slashQuestion(slash) : raw;
      const entry: CanvasEntry = {
        id: entryId,
        question,
        askedAt: now,
        scope,
        command: slash ? slash.command.id : null,
        steps: plan ? stepRecords(plan) : [],
        artifacts: [],
        attachment: null,
      };
      appendCanvasEntry(orgKey, threadId, entry, now);
      rememberCapsuleQuestion(orgKey, question);
      setDispatching(true);

      // Clears the DISPATCH gap only. Once a turn exists, `busy` above
      // tracks the pipeline's own status and this flag is irrelevant.
      const finish = () => setDispatching(false);

      // ── 1. A PLAN. Every shipped plan is engine-only; a future
      //       generative one descends to the model lane instead.
      if (plan && !planIsGenerative(plan)) {
        void runPlanEntry(entryId, plan, controller.signal).finally(finish);
        return;
      }

      // ── 2. A SLASH COMMAND. Deterministic: no intent routing at all.
      if (slash && slash.ready && !slash.command.generative) {
        const kind = slash.command.artifact;
        patchCanvasEntry(orgKey, threadId, entryId, { artifacts: [artifactRef(entryId, kind)] }, now);
        // Tier 0 first even here — "/table total assets" is a lookup and
        // must not pay for a round trip the client can answer.
        if (answerLocally(entryId, question, resolveTier0(question, factIndex))) {
          finish();
          return;
        }
        void runEngineOnly(entryId, question, controller.signal).finally(finish);
        return;
      }

      // ── 3. TIER 0. The zero-spend boundary, inherited from K10.
      if (answerLocally(entryId, question, resolveTier0(question, factIndex))) {
        patchCanvasEntry(
          orgKey,
          threadId,
          entryId,
          { artifacts: [artifactRef(entryId, "figures")] },
          now,
        );
        finish();
        return;
      }

      // ── 4. THE MODEL. Only here.
      patchCanvasEntry(
        orgKey,
        threadId,
        entryId,
        { artifacts: [artifactRef(entryId, slash ? slash.command.artifact : "explain")] },
        now,
      );
      // `askModel` → `runModel` parks a `retrieving` turn SYNCHRONOUSLY,
      // so from the moment it returns true the derived `busy` covers it
      // and the dispatch gap is over. No timer.
      askModel(entryId, question, controller.signal);
      finish();
    },
    [
      scope,
      orgKey,
      threadId,
      newController,
      runPlanEntry,
      answerLocally,
      factIndex,
      runEngineOnly,
      askModel,
    ],
  );

  const recompute = useCallback(
    (entry: CanvasEntry) => {
      dropLiveTurn(entry.id);
      submit(entry.command ? `/${entry.command} ${entry.question}` : entry.question);
    },
    [submit],
  );

  // ── attach ───────────────────────────────────────────────────────────
  //
  // Stages and routes. It does NOT upload — see `canvasAttach.ts` for
  // why a second ingestion path is the thing this must not become.
  const attach = useCallback(
    (file: File) => {
      const now = Date.now();
      const entryId = newCanvasId();
      const supported = attachmentLooksSupported(file.name);
      appendCanvasEntry(
        orgKey,
        threadId,
        {
          id: entryId,
          question: file.name,
          askedAt: now,
          scope,
          command: null,
          steps: [],
          artifacts: [],
          attachment: {
            filename: file.name,
            outcome: supported ? "queued" : "failed",
            detailKey: supported ? "canvas.attach.queued" : "canvas.attach.unsupported",
          },
        },
        now,
      );
      if (!supported) return;
      stageCanvasAttachment(file, now);
      const period = params.get("period");
      navigate(period ? `/dashboard?period=${encodeURIComponent(period)}` : "/dashboard");
    },
    [orgKey, threadId, scope, navigate, params],
  );

  // ── threads ──────────────────────────────────────────────────────────

  const newThread = useCallback(() => {
    abortRef.current?.abort();
    const id = newCanvasId();
    setLocalThreadId(id);
    setCurrentCanvasThread(orgKey, null);
    setDispatching(false);
  }, [orgKey]);

  const openThread = useCallback(
    (id: string) => {
      abortRef.current?.abort();
      setCurrentCanvasThread(orgKey, id);
      setDispatching(false);
    },
    [orgKey],
  );

  useEffect(() => () => abortRef.current?.abort(), []);

  /**
   * BUSY IS DERIVED, not timed. A turn is in flight when the pipeline
   * says so — `retrieving` or `generating` — and the composer stays
   * locked for exactly that long. `dispatching` covers the gap between
   * accepting a submit and the turn becoming observable.
   *
   * `liveVersion` is the dependency that matters: the turns mutate in
   * module state and the `entries` array does not change when they do.
   */
  const busy = useMemo(() => {
    if (dispatching) return true;
    for (const entry of entries) {
      for (const artifact of entry.artifacts) {
        const turn = getLiveTurn(artifact.id);
        if (turn && (turn.status === "retrieving" || turn.status === "generating")) return true;
      }
    }
    return false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatching, entries, liveVersion]);
  busyRef.current = busy;

  return {
    threadId,
    threads: store.threads,
    entries,
    scope,
    periodLabel: periodMonth ?? null,
    companyName: activePeriod.label ?? null,
    busy,
    modelAvailable: askAvailability.available,
    submit,
    recompute,
    attach,
    newThread,
    openThread,
    slashMenu: canvasSlashMenu,
    parseSlash: parseCanvasSlash,
    liveVersion,
  };
}
