// F6.0.4 (2026-06-20) — Configurable dashboard store.
//
// React Context store (matching the period / currency / learningMode
// convention — NO zustand in this codebase). Holds the user's card
// layout, exposes add / remove / reorder / resize / reset, and persists
// debounced to localStorage + backend (see configApi.ts).
//
// Load order on mount:
//   1. Seed from localStorage synchronously (instant first paint, no
//      flash of defaults).
//   2. Kick an async backend fetch; if it returns a config, adopt it and
//      flip syncSource to "account". On failure, stay on localStorage
//      ("device").
//   3. If neither has anything, DEFAULT_DASHBOARD.

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
import {
  DEFAULT_DASHBOARD,
  MAX_DASHBOARD_CARDS,
  newCardId,
  type CardSize,
  type DashboardCard,
} from "@/types/dashboard";
import {
  fetchRemoteConfig,
  persistRemoteConfig,
  readLocalConfig,
  writeLocalConfig,
  type SyncSource,
} from "@/lib/dashboard/configApi";

interface DashboardContextValue {
  cards: DashboardCard[];
  loaded: boolean;
  /** "device" = localStorage only; "account" = backend sync confirmed. */
  syncSource: SyncSource;
  /** True when the user's layout differs from DEFAULT_DASHBOARD (drives
   *  the visibility of "Reset to default"). */
  isCustomized: boolean;
  /** True when the card cap is reached (disables "Add metric"). */
  atCardLimit: boolean;

  addCard: (conceptKey: string, size?: CardSize) => void;
  removeCard: (cardId: string) => void;
  reorderCards: (orderedIds: string[]) => void;
  resizeCard: (cardId: string, size: CardSize) => void;
  resetToDefault: () => void;
}

const DashboardContext = createContext<DashboardContextValue | null>(null);

function sameLayout(a: DashboardCard[], b: DashboardCard[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((card, i) => {
    const other = b[i];
    return (
      card.conceptKey === other.conceptKey &&
      card.size === other.size &&
      card.order === other.order
    );
  });
}

export function DashboardProvider({ children }: { children: ReactNode }) {
  // Seed synchronously from localStorage so first paint isn't the defaults
  // flashing before the persisted layout loads.
  const [cards, setCards] = useState<DashboardCard[]>(() => {
    const local = readLocalConfig();
    return local?.cards?.length ? normalize(local.cards) : DEFAULT_DASHBOARD;
  });
  const [loaded, setLoaded] = useState(false);
  const [syncSource, setSyncSource] = useState<SyncSource>("device");

  // Debounce backend persist so a drag that fires many reorders doesn't
  // hammer the endpoint. localStorage write is immediate (synchronous);
  // only the network call is debounced.
  const persistTimer = useRef<number | null>(null);

  // RACE GUARD (review #3, 2026-06-20): the mount-time backend fetch is
  // async and can resolve seconds later. If the user adds/removes/reorders
  // a card before it resolves, naively adopting the remote config would
  // silently discard their edit. This flag flips on the first local
  // mutation; the fetch effect refuses to overwrite once it's set.
  const userTouched = useRef(false);

  const persist = useCallback((next: DashboardCard[]) => {
    // Immediate device-local write — never lose config.
    writeLocalConfig(next);
    // Debounced backend write.
    if (persistTimer.current !== null) {
      window.clearTimeout(persistTimer.current);
    }
    persistTimer.current = window.setTimeout(() => {
      void persistRemoteConfig(next).then((ok) => {
        if (ok) setSyncSource("account");
      });
    }, 600);
  }, []);

  // On mount, try the backend. If it has a config, adopt it — UNLESS the
  // user has already edited locally while the fetch was in flight (race
  // guard), in which case the local edit wins and we still mark the sync
  // source as account so the next persist flushes the user's version.
  useEffect(() => {
    let cancelled = false;
    void fetchRemoteConfig().then((remote) => {
      if (cancelled) return;
      if (remote?.cards?.length) {
        if (!userTouched.current) {
          setCards(normalize(remote.cards));
        }
        setSyncSource("account");
      }
      setLoaded(true);
    });
    return () => {
      cancelled = true;
      if (persistTimer.current !== null) {
        window.clearTimeout(persistTimer.current);
      }
    };
  }, []);

  const apply = useCallback(
    (updater: (prev: DashboardCard[]) => DashboardCard[]) => {
      // Mark the layout as user-touched so an in-flight backend fetch
      // can't clobber this edit when it resolves.
      userTouched.current = true;
      setCards((prev) => {
        const next = normalize(updater(prev));
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const addCard = useCallback<DashboardContextValue["addCard"]>(
    (conceptKey, size = "sm") => {
      apply((prev) => {
        if (prev.length >= MAX_DASHBOARD_CARDS) return prev;
        return [
          ...prev,
          { id: newCardId(), conceptKey, size, order: prev.length },
        ];
      });
    },
    [apply],
  );

  const removeCard = useCallback<DashboardContextValue["removeCard"]>(
    (cardId) => {
      apply((prev) => prev.filter((c) => c.id !== cardId));
    },
    [apply],
  );

  const reorderCards = useCallback<DashboardContextValue["reorderCards"]>(
    (orderedIds) => {
      apply((prev) => {
        const byId = new Map(prev.map((c) => [c.id, c]));
        const reordered = orderedIds
          .map((id, idx) => {
            const card = byId.get(id);
            return card ? { ...card, order: idx } : null;
          })
          .filter((c): c is DashboardCard => c !== null);
        // Append any cards not in orderedIds (defensive — shouldn't happen).
        const seen = new Set(orderedIds);
        const leftovers = prev.filter((c) => !seen.has(c.id));
        return [...reordered, ...leftovers];
      });
    },
    [apply],
  );

  const resizeCard = useCallback<DashboardContextValue["resizeCard"]>(
    (cardId, size) => {
      apply((prev) =>
        prev.map((c) => (c.id === cardId ? { ...c, size } : c)),
      );
    },
    [apply],
  );

  const resetToDefault = useCallback<DashboardContextValue["resetToDefault"]>(
    () => {
      apply(() => DEFAULT_DASHBOARD.map((c) => ({ ...c })));
    },
    [apply],
  );

  const value = useMemo<DashboardContextValue>(() => {
    return {
      cards,
      loaded,
      syncSource,
      isCustomized: !sameLayout(cards, DEFAULT_DASHBOARD),
      atCardLimit: cards.length >= MAX_DASHBOARD_CARDS,
      addCard,
      removeCard,
      reorderCards,
      resizeCard,
      resetToDefault,
    };
  }, [
    cards,
    loaded,
    syncSource,
    addCard,
    removeCard,
    reorderCards,
    resizeCard,
    resetToDefault,
  ]);

  return (
    <DashboardContext.Provider value={value}>
      {children}
    </DashboardContext.Provider>
  );
}

export function useDashboard(): DashboardContextValue {
  const ctx = useContext(DashboardContext);
  if (!ctx) {
    // Defensive default for trees that don't mount the provider.
    return {
      cards: DEFAULT_DASHBOARD,
      loaded: true,
      syncSource: "device",
      isCustomized: false,
      atCardLimit: false,
      addCard: () => {},
      removeCard: () => {},
      reorderCards: () => {},
      resizeCard: () => {},
      resetToDefault: () => {},
    };
  }
  return ctx;
}

/** Re-sort by order + renumber 0..n so order is always dense + monotonic. */
function normalize(cards: DashboardCard[]): DashboardCard[] {
  return [...cards]
    .sort((a, b) => a.order - b.order)
    .map((c, i) => ({ ...c, order: i }));
}
