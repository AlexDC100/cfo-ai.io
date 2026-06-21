// F6.0.5 (2026-06-20) — Scenario what-if store.
//
// React Context store (matching the dashboard / currency / period
// convention — NO zustand in this codebase). Holds the working what-if:
// which levers the user has engaged + their slider values, the loaded
// template (if any), and the covenant set to test against.
//
// The store does NOT hold the cascaded result — that's derived in the page
// via applyCascade(baseline, adjustments) so it stays a pure function of
// (live baseline, adjustments) and re-runs when the period changes. The
// store's job is purely the user's INPUT: engaged levers + covenants.
//
// Persistence: device-local (localStorage `cfo:scenario:v1`). Scenarios are
// inherently exploratory + per-device for Phase 1 — same posture as the
// configurable dashboard. Backend save/share is a later phase.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Adjustment } from "@/lib/scenarios/types";
import {
  SCENARIO_LEVERS,
  leverToAdjustment,
  isNeutralPct,
  type ScenarioLever,
} from "@/lib/scenarios/levers";
import {
  SCENARIO_TEMPLATES,
  getScenarioTemplate,
} from "@/lib/scenarios/templates";
import {
  DEFAULT_RO_COVENANTS,
  type Covenant,
} from "@/lib/scenarios/covenants";

const STORAGE_KEY = "cfo:scenario:v1";
// Stable, deterministic createdAt for derived adjustments. The cascade is
// order-stable (sorted by dependency, not by timestamp) so this value is
// purely cosmetic for the audit note; keeping it constant avoids spurious
// re-renders and keeps applyCascade output deterministic.
const STABLE_TS = "2026-01-01T00:00:00.000Z";

interface PersistShape {
  levers: Record<string, number>;
  templateKey: string | null;
}

interface ScenarioContextValue {
  /** Engaged levers → slider value (native unit). Absent key = not applied. */
  leverValues: Record<string, number>;
  /** The template currently loaded, or null once the user hand-edits. */
  activeTemplateKey: string | null;
  /** Derived cascade adjustments from the engaged levers. */
  adjustments: Adjustment[];
  /** Covenants tested against the scenario (seeded from RO defaults). */
  covenants: Covenant[];
  /** True when at least one lever is engaged (drives "Reset" visibility). */
  isDirty: boolean;

  setLever: (leverKey: string, value: number) => void;
  removeLever: (leverKey: string) => void;
  applyTemplate: (templateKey: string) => void;
  reset: () => void;
}

const ScenarioContext = createContext<ScenarioContextValue | null>(null);

function readPersisted(): PersistShape {
  if (typeof window === "undefined") return { levers: {}, templateKey: null };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { levers: {}, templateKey: null };
    const parsed = JSON.parse(raw) as Partial<PersistShape>;
    const levers: Record<string, number> = {};
    if (parsed.levers && typeof parsed.levers === "object") {
      for (const [k, v] of Object.entries(parsed.levers)) {
        // Only keep levers that still exist + numeric values.
        if (SCENARIO_LEVERS.some((l) => l.key === k) && typeof v === "number" && Number.isFinite(v)) {
          levers[k] = v;
        }
      }
    }
    const templateKey =
      typeof parsed.templateKey === "string" &&
      getScenarioTemplate(parsed.templateKey)
        ? parsed.templateKey
        : null;
    return { levers, templateKey };
  } catch {
    return { levers: {}, templateKey: null };
  }
}

/** Map one template's canonical adjustments back into engaged lever values
 *  (so the lever sliders reflect the template the user picked). */
function templateToLeverValues(templateKey: string): Record<string, number> {
  const tpl = getScenarioTemplate(templateKey);
  if (!tpl) return {};
  const out: Record<string, number> = {};
  for (const adj of tpl.adjustments) {
    const lever = findLeverForTarget(adj.target);
    if (!lever) continue;
    if (adj.operation.type === "pct_change") {
      out[lever.key] = Math.round(adj.operation.value * 100);
    } else if (adj.operation.type === "set_driver") {
      out[lever.key] =
        lever.kind === "rate_pct"
          ? Math.round(adj.operation.driverValue * 100)
          : adj.operation.driverValue;
    } else if (adj.operation.type === "set_value") {
      out[lever.key] = adj.operation.value;
    }
  }
  return out;
}

function findLeverForTarget(
  target: Adjustment["target"],
): ScenarioLever | undefined {
  return SCENARIO_LEVERS.find((l) => {
    if (l.target.type !== target.type) return false;
    if (l.target.type === "concept" && target.type === "concept")
      return l.target.conceptKey === target.conceptKey;
    if (l.target.type === "driver" && target.type === "driver")
      return l.target.driverKey === target.driverKey;
    return false;
  });
}

/** Convert engaged levers → cascade adjustments. Skips pct levers sitting
 *  at neutral 0 (no-op) so a slider returned to centre produces no change. */
function deriveAdjustments(leverValues: Record<string, number>): Adjustment[] {
  const out: Adjustment[] = [];
  for (const lever of SCENARIO_LEVERS) {
    if (!(lever.key in leverValues)) continue;
    const v = leverValues[lever.key];
    if (isNeutralPct(lever, v)) continue;
    out.push(leverToAdjustment(lever, v, `lever-${lever.key}`, STABLE_TS));
  }
  return out;
}

export function ScenarioProvider({ children }: { children: ReactNode }) {
  const [leverValues, setLeverValues] = useState<Record<string, number>>(
    () => readPersisted().levers,
  );
  const [activeTemplateKey, setActiveTemplateKey] = useState<string | null>(
    () => readPersisted().templateKey,
  );

  // Covenants are static defaults for Phase 1 (Settings → Covenants UI is a
  // later phase). Seed once with stable ids derived from the metric so the
  // identity is deterministic across reloads.
  const covenants = useMemo<Covenant[]>(
    () =>
      DEFAULT_RO_COVENANTS.map((c, i) => ({
        ...c,
        id: `default-${c.metric}-${i}`,
      })),
    [],
  );

  const persist = useCallback(
    (levers: Record<string, number>, templateKey: string | null) => {
      if (typeof window === "undefined") return;
      try {
        window.localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ levers, templateKey } satisfies PersistShape),
        );
      } catch {
        /* private mode — fail soft */
      }
    },
    [],
  );

  // Keep localStorage in sync on every change.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    persist(leverValues, activeTemplateKey);
  }, [leverValues, activeTemplateKey, persist]);

  const setLever = useCallback<ScenarioContextValue["setLever"]>(
    (leverKey, value) => {
      setLeverValues((prev) => ({ ...prev, [leverKey]: value }));
      // Hand-editing a lever detaches from the template (it's no longer a
      // faithful copy), but we keep the values that were seeded.
      setActiveTemplateKey(null);
    },
    [],
  );

  const removeLever = useCallback<ScenarioContextValue["removeLever"]>(
    (leverKey) => {
      setLeverValues((prev) => {
        const next = { ...prev };
        delete next[leverKey];
        return next;
      });
      setActiveTemplateKey(null);
    },
    [],
  );

  const applyTemplate = useCallback<ScenarioContextValue["applyTemplate"]>(
    (templateKey) => {
      setLeverValues(templateToLeverValues(templateKey));
      setActiveTemplateKey(templateKey);
    },
    [],
  );

  const reset = useCallback<ScenarioContextValue["reset"]>(() => {
    setLeverValues({});
    setActiveTemplateKey(null);
  }, []);

  const adjustments = useMemo(
    () => deriveAdjustments(leverValues),
    [leverValues],
  );

  const value = useMemo<ScenarioContextValue>(
    () => ({
      leverValues,
      activeTemplateKey,
      adjustments,
      covenants,
      isDirty: Object.keys(leverValues).length > 0,
      setLever,
      removeLever,
      applyTemplate,
      reset,
    }),
    [
      leverValues,
      activeTemplateKey,
      adjustments,
      covenants,
      setLever,
      removeLever,
      applyTemplate,
      reset,
    ],
  );

  return (
    <ScenarioContext.Provider value={value}>
      {children}
    </ScenarioContext.Provider>
  );
}

export function useScenario(): ScenarioContextValue {
  const ctx = useContext(ScenarioContext);
  if (!ctx) {
    return {
      leverValues: {},
      activeTemplateKey: null,
      adjustments: [],
      covenants: [],
      isDirty: false,
      setLever: () => {},
      removeLever: () => {},
      applyTemplate: () => {},
      reset: () => {},
    };
  }
  return ctx;
}

export { SCENARIO_TEMPLATES };
