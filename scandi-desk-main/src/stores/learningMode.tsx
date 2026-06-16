// F5.0 Step 1 (CFO AI Learn) — Learning-mode store.
//
// Three modes:
//   · "guided"  — first-time users. Visible gradient underlines, page-tour
//                 "Guide me" CTAs visible, first-run LearningCoach card.
//   · "subtle"  — returning users. Underline only on hover / focus. Guide
//                 me still available from the Glossary drawer.
//   · "off"     — affordances hidden. Numbers stay clickable (via keyboard
//                 or the future "/learn" route) but no visible hotspots,
//                 no coach, no tours.
//
// Persistence:
//   localStorage key: cfo:learning-mode:v1 — { mode, coachDismissed, tutorialsSeen }
//
// Default behavior:
//   First load → "guided" + coach not yet dismissed.
//   When the user dismisses the LearningCoach (or completes their first
//   guided tour), we flip them to "subtle" and set coachDismissed=true.
//   Settings → Learning lets them switch among all three at any time.
//
// CSS hookup:
//   The provider mirrors `mode` onto <html data-learning-mode="…"> so
//   src/styles/learning.css can branch via attribute selectors. Pure
//   CSS, zero JS-driven re-renders of LearnableNumber.
//
// Provider pattern follows src/stores/currency.tsx exactly — React
// Context with a memoised value + localStorage rehydrate. No new state
// library introduced.

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

export type LearningMode = "guided" | "subtle" | "off";

interface LearningModeState {
  mode: LearningMode;
  /** Has the user dismissed the first-run LearningCoach? Independent of
   *  the active mode so the coach never reappears once dismissed even
   *  if the user flips back to Guided. */
  coachDismissed: boolean;
  /** Per-page tutorial completion ledger. Key is the page identifier
   *  (e.g. "balance-sheet", "valuation"). Value is true when the user
   *  has finished or skipped that page's PageGuideOverlay tour. */
  tutorialsSeen: Record<string, boolean>;
}

interface LearningModeContextValue extends LearningModeState {
  setMode: (mode: LearningMode) => void;
  dismissCoach: () => void;
  markTutorialSeen: (pageId: string) => void;
  resetAll: () => void;
}

const STORAGE_KEY = "cfo:learning-mode:v1";

const DEFAULT_STATE: LearningModeState = {
  mode: "guided",
  coachDismissed: false,
  tutorialsSeen: {},
};

const LearningModeContext = createContext<LearningModeContextValue | null>(null);

function readPersisted(): LearningModeState {
  if (typeof window === "undefined") return DEFAULT_STATE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw) as Partial<LearningModeState>;
    const mode: LearningMode =
      parsed.mode === "subtle" || parsed.mode === "off"
        ? parsed.mode
        : "guided";
    return {
      mode,
      coachDismissed: parsed.coachDismissed === true,
      tutorialsSeen:
        parsed.tutorialsSeen && typeof parsed.tutorialsSeen === "object"
          ? parsed.tutorialsSeen
          : {},
    };
  } catch {
    return DEFAULT_STATE;
  }
}

function persist(state: LearningModeState) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* private mode etc. — silently ignore */
  }
}

export function LearningModeProvider({ children }: { children: ReactNode }) {
  // SSR-safe init: read on first render (lazy initial state).
  const [state, setState] = useState<LearningModeState>(() => readPersisted());

  // Mirror `mode` onto <html data-learning-mode="…"> so learning.css can
  // branch via attribute selectors. Pure CSS, zero re-render on toggle.
  // Runs once on mount AND whenever `mode` changes.
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.dataset.learningMode = state.mode;
  }, [state.mode]);

  // Persist on every change. Debounced via microtask so a burst of
  // updates (e.g. resetAll) only writes once per tick.
  const pendingPersistRef = useRef(false);
  useEffect(() => {
    if (pendingPersistRef.current) return;
    pendingPersistRef.current = true;
    queueMicrotask(() => {
      pendingPersistRef.current = false;
      persist(state);
    });
  }, [state]);

  const setMode = useCallback((mode: LearningMode) => {
    setState((s) => ({ ...s, mode }));
  }, []);

  const dismissCoach = useCallback(() => {
    setState((s) => {
      // First dismissal: also flip the user to Subtle so they don't see
      // intrusive page tours on subsequent navigation. Returning users
      // who later opt back into Guided keep coachDismissed=true.
      const nextMode: LearningMode = s.mode === "guided" ? "subtle" : s.mode;
      return { ...s, coachDismissed: true, mode: nextMode };
    });
  }, []);

  const markTutorialSeen = useCallback((pageId: string) => {
    setState((s) => ({
      ...s,
      tutorialsSeen: { ...s.tutorialsSeen, [pageId]: true },
    }));
  }, []);

  const resetAll = useCallback(() => {
    setState(DEFAULT_STATE);
  }, []);

  const value = useMemo<LearningModeContextValue>(
    () => ({
      ...state,
      setMode,
      dismissCoach,
      markTutorialSeen,
      resetAll,
    }),
    [state, setMode, dismissCoach, markTutorialSeen, resetAll],
  );

  return (
    <LearningModeContext.Provider value={value}>
      {children}
    </LearningModeContext.Provider>
  );
}

/** Read the active learning mode + actions. Outside the provider returns
 *  a safe "guided" stub so individual LearnableNumber call sites can't
 *  crash a page if the provider hasn't been mounted yet. */
export function useLearningMode(): LearningModeContextValue {
  const ctx = useContext(LearningModeContext);
  if (!ctx) {
    return {
      ...DEFAULT_STATE,
      setMode: () => {},
      dismissCoach: () => {},
      markTutorialSeen: () => {},
      resetAll: () => {},
    };
  }
  return ctx;
}
