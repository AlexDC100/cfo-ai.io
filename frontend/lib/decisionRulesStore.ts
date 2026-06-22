// decisionRulesStore.ts — persisted reactive store for the multi-rule
// decision system. Same useSyncExternalStore pattern as
// `src/lib/thresholds.ts` so every subscriber (modal + Products page
// KPI tiles + filter chips) re-renders synchronously on every change.
//
// Storage
// ───────
//   localStorage key: cfo-decision-rules-v3
//   Migration: on first read, if v3 is absent but the v2 single-axis
//   thresholds (`aicfo.thresholds.v1`) carry custom simpleLower/UpperCutoffKrn,
//   the gross_profit rule inherits those cutoffs so the user doesn't lose
//   work crossing the upgrade.
//
// Writes are batched via a 200ms debounce so a slider drag doesn't write
// to localStorage on every animation frame — the in-memory state still
// updates synchronously for snappy UI; only the persistence side is
// throttled. emit() is called immediately so subscribers update in
// lock-step regardless of the debounce.

import { useSyncExternalStore } from "react";

import {
  DEFAULT_FINANCING,
  RULES,
  defaultRulesState,
  type CombinationMode,
  type DecisionRulesState,
  type FinancingParams,
  type RuleState,
  type SkuLite,
} from "./decisionRules";
import { resolvePreset, getPreset } from "./presets";
import { DEFAULTS as LEGACY_THRESHOLDS_DEFAULTS, STORAGE_KEY as LEGACY_THRESHOLDS_KEY } from "./thresholds";

export const STORAGE_KEY = "cfo-decision-rules-v3";
const SAVE_DEBOUNCE_MS = 200;

// ─── In-memory state ───────────────────────────────────────────────────────

let cached: DecisionRulesState | null = null;

function readFromStorage(): DecisionRulesState {
  // Fresh, working copy of the catalog defaults — every read starts here so
  // adding a new rule to the catalog after a user has saved state still
  // surfaces with sensible default thresholds (we merge persisted rule
  // states ON TOP of the defaults rather than wholesale replacing).
  const base = defaultRulesState();

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<DecisionRulesState>;
      if (parsed.combinationMode && isValidMode(parsed.combinationMode)) {
        base.combinationMode = parsed.combinationMode;
      }
      if (parsed.rules && typeof parsed.rules === "object") {
        for (const id of Object.keys(parsed.rules)) {
          const persisted = parsed.rules[id];
          const def = base.rules[id];
          if (!def || !persisted) continue;
          base.rules[id] = mergeRuleState(def, persisted);
        }
      }
      // Financing block — added in turn-19. Honour persisted values when
      // present; fall back to DEFAULT_FINANCING for entries written
      // before this field existed.
      if (parsed.financing && typeof parsed.financing === "object") {
        base.financing = {
          costOfFinancing:
            typeof parsed.financing.costOfFinancing === "number"
              ? parsed.financing.costOfFinancing
              : DEFAULT_FINANCING.costOfFinancing,
          bankSpread:
            typeof parsed.financing.bankSpread === "number"
              ? parsed.financing.bankSpread
              : DEFAULT_FINANCING.bankSpread,
        };
      }
      return base;
    }
  } catch {
    /* corrupt JSON / private mode — fall through to migration path */
  }

  // No v3 entry — try migrating from v2 (the previous turn's
  // single-axis simple cutoffs lived inside the legacy thresholds blob).
  try {
    const legacyRaw = localStorage.getItem(LEGACY_THRESHOLDS_KEY);
    if (legacyRaw) {
      const legacy = JSON.parse(legacyRaw) as Partial<typeof LEGACY_THRESHOLDS_DEFAULTS>;
      const lo = typeof legacy.simpleLowerCutoffKrn === "number" ? legacy.simpleLowerCutoffKrn : null;
      const hi = typeof legacy.simpleUpperCutoffKrn === "number" ? legacy.simpleUpperCutoffKrn : null;
      if (lo !== null || hi !== null) {
        const gp = base.rules["gross_profit"];
        if (gp) {
          base.rules["gross_profit"] = {
            ...gp,
            thresholds: [
              lo ?? gp.thresholds[0],
              hi ?? gp.thresholds[1],
            ],
          };
        }
      }
    }
  } catch {
    /* legacy parse failure is non-fatal — defaults still work */
  }
  return base;
}

function isValidMode(m: unknown): m is CombinationMode {
  return m === "all_agree" || m === "worst_wins" || m === "weighted";
}

function mergeRuleState(base: RuleState, persisted: Partial<RuleState>): RuleState {
  return {
    enabled: typeof persisted.enabled === "boolean" ? persisted.enabled : base.enabled,
    thresholds:
      Array.isArray(persisted.thresholds) && persisted.thresholds.length === 2
        ? [Number(persisted.thresholds[0]), Number(persisted.thresholds[1])]
        : base.thresholds,
    weight:
      typeof persisted.weight === "number" && persisted.weight >= 0 && persisted.weight <= 10
        ? persisted.weight
        : base.weight,
  };
}

// ─── Persistence (debounced) ───────────────────────────────────────────────

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(state: DecisionRulesState) {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* quota / private mode — UI state still works in-memory */
    }
    saveTimer = null;
  }, SAVE_DEBOUNCE_MS);
}

// ─── Subscribers ───────────────────────────────────────────────────────────

const listeners = new Set<() => void>();
function emit() {
  // Listeners fire synchronously so dependent useMemo's recompute in the
  // same render pass as the state change.
  listeners.forEach((cb) => cb());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) {
      cached = null; // force re-read
      emit();
    } else if (e.key === PRESET_STORAGE_KEY) {
      cachedPresetId = undefined; // force re-read
      emit();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

function getSnapshot(): DecisionRulesState {
  if (cached === null) cached = readFromStorage();
  return cached;
}

function getServerSnapshot(): DecisionRulesState {
  return defaultRulesState();
}

// ─── Public API ────────────────────────────────────────────────────────────

export function useDecisionRules(): DecisionRulesState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function readDecisionRules(): DecisionRulesState {
  return getSnapshot();
}

/** Atomic write — pass a producer that returns the new state, OR pass the
 *  state directly. Always emits synchronously and schedules a debounced
 *  localStorage write. */
export function writeDecisionRules(
  next: DecisionRulesState | ((prev: DecisionRulesState) => DecisionRulesState),
): void {
  const prev = getSnapshot();
  const value = typeof next === "function" ? next(prev) : next;
  cached = value;
  scheduleSave(value);
  emit();
}

/** Patch a single rule's state without touching the others. */
export function updateRuleState(
  ruleId: string,
  patch: Partial<RuleState>,
): void {
  writeDecisionRules((prev) => {
    const current = prev.rules[ruleId];
    if (!current) return prev;
    return {
      ...prev,
      rules: {
        ...prev.rules,
        [ruleId]: { ...current, ...patch },
      },
    };
  });
}

export function setCombinationMode(mode: CombinationMode): void {
  writeDecisionRules((prev) => ({ ...prev, combinationMode: mode }));
}

/** Patch the financing assumptions (cost of base capital + bank spread).
 *  Triggers the same useSyncExternalStore emit path as rule edits, so
 *  the Adjusted-GM rule recomputes and the Products page rebuckets
 *  synchronously when the operator drags either financing slider. */
export function setFinancing(patch: Partial<FinancingParams>): void {
  writeDecisionRules((prev) => {
    const current = prev.financing ?? DEFAULT_FINANCING;
    return {
      ...prev,
      financing: {
        costOfFinancing:
          typeof patch.costOfFinancing === "number"
            ? patch.costOfFinancing
            : current.costOfFinancing,
        bankSpread:
          typeof patch.bankSpread === "number"
            ? patch.bankSpread
            : current.bankSpread,
      },
    };
  });
}

export function resetDecisionRulesToDefaults(): void {
  writeDecisionRules(defaultRulesState());
  setActivePresetId(null);
}

// ─── Active preset ─────────────────────────────────────────────────────────

const PRESET_STORAGE_KEY = "cfo-decision-rules-active-preset";

let cachedPresetId: string | null | undefined = undefined;

export function readActivePresetId(): string | null {
  if (cachedPresetId !== undefined) return cachedPresetId;
  try {
    cachedPresetId = localStorage.getItem(PRESET_STORAGE_KEY);
  } catch {
    cachedPresetId = null;
  }
  return cachedPresetId;
}

export function setActivePresetId(id: string | null): void {
  cachedPresetId = id;
  try {
    if (id === null) localStorage.removeItem(PRESET_STORAGE_KEY);
    else localStorage.setItem(PRESET_STORAGE_KEY, id);
  } catch {
    /* private mode */
  }
  emit();
}

/** Hook variant — re-renders on preset change via the same emit() that
 *  fires on rule edits. Reads through the cached presetId so a slider
 *  drag (which calls emit) re-runs hooks of components reading this. */
export function useActivePresetId(): string | null {
  return useSyncExternalStore(subscribe, readActivePresetId, () => null);
}

/**
 * Resolve a preset against the current dataset's percentiles and write
 * the complete state in one shot. Pass the SKU list so percentile-based
 * thresholds ("gmPct.p67" etc.) resolve to absolute numbers from the
 * CURRENT data — the same preset behaves sensibly across portfolios
 * of any shape.
 */
export function applyPresetById(id: string, skus: readonly SkuLite[]): boolean {
  const preset = getPreset(id);
  if (!preset) return false;
  const next = resolvePreset(preset, skus);
  writeDecisionRules(next);
  setActivePresetId(id);
  return true;
}

// Re-export catalog so callers don't have to know about two modules.
export { RULES };
