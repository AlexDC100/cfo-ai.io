// THE COCKPIT'S ONE CONVERSATION WITH THE ENGINE.
//
// Every slider move and every case switch is a request to the REAL engine
// (POST /api/forecast/{id}/cockpit). Nothing is computed here while the
// reader waits: the last answer the server actually produced stays on screen,
// marked as recomputing, until the next one arrives.
//
// THREE RULES, each one a defect this product has already shipped elsewhere:
//
//   · DEBOUNCED. A drag fires dozens of input events; the engine is asked
//     once, after the quiet period the payload states (`client.debounce_ms`),
//     or the owner's ~250 ms (lib/forecastCockpit SPEC_DEBOUNCE_MS) until it
//     states one. The first read goes out at once.
//   · LATEST RESPONSE WINS. Every request carries a sequence number; an answer
//     that is not the answer to the LATEST request is cached and never shown,
//     and the request it belonged to is aborted when a newer one supersedes
//     it. A slow answer to an old slider position can never overwrite the
//     answer to the position the reader is looking at.
//   · SAME INPUTS, SAME ANSWER (gate F3). An answer is cached by its request
//     identity, so moving a slider back, or resetting to the case, lands on
//     the bytes the engine served for exactly that request — "reset → base
//     exactly" (gate F4) is a cache read of the base answer, not a second
//     opinion about it.

import { useEffect, useMemo, useRef, useState } from "react";

import { cfoApi } from "@/lib/cfoApi";
import {
  cockpitRequestBody,
  cockpitRequestKey,
  readCockpit,
  SPEC_DEBOUNCE_MS,
  type CockpitRequest,
  type CockpitView,
} from "@/lib/forecastCockpit";

export interface CockpitAnswer {
  readonly key: string;
  readonly cockpit: CockpitView;
  /** The request body that produced this answer (the bank export re-sends
   *  it to POST .../cockpit/export, so the PDF is this very answer). */
  readonly body: { case_id: string; levers: Record<string, string> };
  /** Wall time of the round trip that produced this answer, measured in the
   *  browser (the walk reads it; the engine's own recompute_ms is separate). */
  readonly roundTripMs: number;
}

export interface EngineRefusal {
  readonly text: string;
  readonly field: string | null;
}

export interface CockpitState {
  /** The last answer the SERVER produced for the latest request that has an
   *  answer — never a figure made here. */
  readonly shown: CockpitAnswer | null;
  /** A request for the reader's current position is waiting or in flight. */
  readonly recomputing: boolean;
  /** The engine refused the reader's current position, in its own words. */
  readonly refusal: EngineRefusal | null;
  /** A payload that broke its own contract (a producer defect). */
  readonly contractError: string | null;
  /** `shown` is not the answer to the reader's current position. */
  readonly stale: boolean;
}

/** How many answers are kept per page visit. Enough to walk every case and
 *  back; bounded so a long session cannot grow it without end. */
const CACHE_LIMIT = 32;

/** THE ENGINE'S REFUSAL, IN ITS OWN WORDS: a 422 detail {code, text, field}
 *  arrives on the error; anything else falls back to the message. */
export function readEngineRefusal(err: unknown): EngineRefusal | null {
  const detail = (err as { detail?: unknown } | null)?.detail;
  if (detail && typeof detail === "object") {
    const r = detail as { text?: unknown; field?: unknown };
    if (typeof r.text === "string" && r.text.length > 0) {
      return { text: r.text, field: typeof r.field === "string" ? r.field : null };
    }
  }
  const message = (err as Error | null)?.message;
  return typeof message === "string" && message.length > 0 ? { text: message, field: null } : null;
}

function isAbort(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === "AbortError";
}

function parse(
  payload: unknown,
  key: string,
  body: CockpitAnswer["body"],
  roundTripMs: number,
): CockpitAnswer | { error: string } {
  try {
    const cockpit = readCockpit(payload);
    if (!cockpit) return { error: "the response is not the forecast cockpit" };
    return { key, cockpit, body, roundTripMs };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export function useCockpit(periodId: string, request: CockpitRequest): CockpitState {
  const key = useMemo(() => cockpitRequestKey(request), [request]);
  // A position is already the exact decimal the wire carries (LeverPositions):
  // nothing here reads a scale, so no answer can re-interpret a request.
  const requestRef = useRef(request);
  requestRef.current = request;

  const cache = useRef(new Map<string, CockpitAnswer>());
  const seq = useRef(0);
  const inflight = useRef<AbortController | null>(null);

  const [shown, setShown] = useState<CockpitAnswer | null>(null);
  const [sentKey, setSentKey] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<EngineRefusal | null>(null);
  const [contractError, setContractError] = useState<string | null>(null);
  const [inFlightKey, setInFlightKey] = useState<string | null>(null);

  const debounceMs = shown?.cockpit.debounceMs ?? SPEC_DEBOUNCE_MS;

  // A different book is a different conversation.
  useEffect(() => {
    cache.current.clear();
    setShown(null);
    setSentKey(null);
    setRefusal(null);
    setContractError(null);
    return () => inflight.current?.abort();
  }, [periodId]);

  // DEBOUNCE: the first read goes at once; a known answer is shown at once;
  // anything else waits for the reader to stop moving.
  useEffect(() => {
    if (key === sentKey) return undefined;
    const known = cache.current.get(key);
    if (known || sentKey === null) {
      setSentKey(key);
      return undefined;
    }
    const id = setTimeout(() => setSentKey(key), debounceMs);
    return () => clearTimeout(id);
  }, [key, sentKey, debounceMs]);

  // SEND: one request per settled position; the newest supersedes the rest.
  useEffect(() => {
    if (sentKey === null || !periodId) return;
    const known = cache.current.get(sentKey);
    const mine = ++seq.current;
    inflight.current?.abort();
    inflight.current = null;
    if (known) {
      setShown(known);
      setRefusal(null);
      setContractError(null);
      setInFlightKey(null);
      return;
    }
    const controller = new AbortController();
    inflight.current = controller;
    setInFlightKey(sentKey);
    const body = cockpitRequestBody(requestRef.current);
    const started = performance.now();
    cfoApi
      .forecastCockpit(periodId, body, controller.signal)
      .then((payload) => {
        const answer = parse(payload, sentKey, body, Math.round(performance.now() - started));
        if ("error" in answer) {
          if (mine === seq.current) {
            setContractError(answer.error);
            setInFlightKey(null);
          }
          return;
        }
        cache.current.set(sentKey, answer);
        if (cache.current.size > CACHE_LIMIT) {
          const oldest = cache.current.keys().next().value;
          if (oldest !== undefined) cache.current.delete(oldest);
        }
        if (mine !== seq.current) return; // not the latest: kept, never shown
        setShown(answer);
        setRefusal(null);
        setContractError(null);
        setInFlightKey(null);
      })
      .catch((err: unknown) => {
        if (isAbort(err) || mine !== seq.current) return;
        setRefusal(readEngineRefusal(err));
        setInFlightKey(null);
      });
  }, [sentKey, periodId]);

  return {
    shown,
    recomputing: key !== sentKey || inFlightKey !== null,
    refusal: key === sentKey ? refusal : null,
    contractError,
    stale: shown !== null && shown.key !== key,
  };
}
