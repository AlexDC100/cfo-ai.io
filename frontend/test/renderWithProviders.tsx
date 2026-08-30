// Shared render helper — mounts a component inside the same context
// providers the real application mounts it inside.
//
// ── WHY THIS EXISTS ───────────────────────────────────────────────────
// `useCurrency()` throws by design when it cannot find a <CurrencyProvider>:
//
//     "useCurrency must be used inside <CurrencyProvider>"
//
// That is deliberate (stores/currency.tsx) — it prevents the "silent fallback
// to the wrong currency" class of bug, which is exactly the kind of defect
// this project cares most about. It is good product design.
//
// But it means any test that renders a subtree which *anywhere inside it*
// reaches for currency must supply the provider. AccountMenu started
// rendering <CurrencyToggle /> and 10 tests in accountMenu.test.tsx broke at
// once — not because the component regressed, but because a bare
// `render(<X />)` no longer resembles how X is mounted in the app.
//
// Patching that one file with one provider would fix those 10 tests and
// leave the trap fully armed for the next component that grows a context
// dependency. The recurring cost is the missing shared helper, so that is
// what this file is. Tests state WHAT they render; the helper owns HOW it is
// mounted, and stays in step with App.tsx in one place.
//
// ── WHAT IS AND IS NOT INCLUDED ───────────────────────────────────────
// Mirrors App.tsx's provider stack, in the same nesting order, EXCEPT
// <AuthProvider>. Auth needs a live Supabase session; tests that need a user
// mock "@/lib/auth" instead, which is both faster and deterministic. Every
// provider here is pure client-side context with no required network:
// CurrencyProvider kicks off a background rate fetch on mount but renders
// synchronously from bundled fallback rates, so it is safe offline.
//
// Router: MemoryRouter, because components reach for useNavigate/useLocation
// and jsdom has no history. Pass `route` to control the initial entry.

import type { ReactElement, ReactNode } from "react";
import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ThemeProvider } from "@/theme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CurrencyProvider } from "@/stores/currency";
import { LearningModeProvider } from "@/stores/learningMode";
import { PopoverStackProvider } from "@/components/learning/PopoverStackProvider";

/**
 * A QueryClient with retries off and no cache carried between tests.
 * Retries would turn a deliberate error-path assertion into a timeout, and a
 * shared cache would let one test's data satisfy another test's fetch — the
 * order-dependent-green failure mode.
 */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

export interface ProvidersOptions {
  /** Initial router entry. Defaults to "/". */
  route?: string;
  /** Supply a pre-seeded client when a test needs to prime the cache. */
  queryClient?: QueryClient;
}

/**
 * The provider stack on its own, for the cases where a test needs to drive
 * `render` itself (custom container, `rerender` with different props, etc.).
 */
export function TestProviders({
  children,
  route = "/",
  queryClient,
}: ProvidersOptions & { children: ReactNode }): ReactElement {
  const client = queryClient ?? createTestQueryClient();
  return (
    <ThemeProvider defaultTheme="light" enableSystem={false}>
      <QueryClientProvider client={client}>
        <CurrencyProvider>
          <TooltipProvider>
            <MemoryRouter initialEntries={[route]}>
              <LearningModeProvider>
                <PopoverStackProvider>{children}</PopoverStackProvider>
              </LearningModeProvider>
            </MemoryRouter>
          </TooltipProvider>
        </CurrencyProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

/**
 * Drop-in replacement for testing-library's `render` that mounts `ui` inside
 * the application's providers. Returns the standard RenderResult, so
 * `screen`, `rerender`, `unmount` and friends behave exactly as usual.
 */
export function renderWithProviders(
  ui: ReactElement,
  options: ProvidersOptions & Omit<RenderOptions, "wrapper"> = {},
): RenderResult {
  const { route, queryClient, ...renderOptions } = options;
  return render(ui, {
    wrapper: ({ children }) => (
      <TestProviders route={route} queryClient={queryClient}>
        {children}
      </TestProviders>
    ),
    ...renderOptions,
  });
}
