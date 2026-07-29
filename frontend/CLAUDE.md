# Frontend — code map (read this before exploring)

Concise orientation for the CFO AI web app so you don't have to grep the tree.
The root `CLAUDE.md` is the *financial-analysis methodology* + deploy protocols;
**this** file is the *code* map. Keep it short and current.

## Stack
- **Vite + React 18 + TypeScript**, React Router, TanStack Query, Zustand-style
  context stores, Tailwind CSS, Radix UI primitives, framer-motion, Supabase JS.
- Path alias: **`@/` → `frontend/`** (see `vite.config.ts`). Import app code as
  `@/components/...`, `@/lib/...`, never long relative paths.
- Backend is a **Python FastAPI engine** at `src/engine/` (separate app). The FE
  talks to it over `**/api/cfo/***` via `@/lib/cfoApi.ts`. Engine changes follow
  the deploy protocol in the **root** `CLAUDE.md §14` (host source → rebuild;
  never `docker cp`).
  **Exception: Ask CFO AI chat** (`cfoApi.chatLlm`) does NOT go to the engine —
  it calls a Supabase Edge Function (`supabase/functions/chat-llm/`) directly,
  so chat works with the engine fully stopped. Everything else (Today/Cash/
  Profit/Products/decisions/exports/pipeline) still needs the engine running.
  See root `CLAUDE.md` §"Milestone D" for why and what's duplicated where.

## Commands (run from repo root)
- `npm run dev` — Vite dev server · `npm run build` — prod build
- `npm run lint` — eslint · `npm test` — vitest (unit) · `npm run test:e2e` — Playwright
- Typecheck: `npx tsc --noEmit -p tsconfig.json` (run this after edits)
- Deploy FE: `docker compose build frontend && docker compose up -d frontend`
  (no `docker cp` shortcut exists for FE — every change rebuilds from source).

## Directory map (`frontend/`)
- `App.tsx` — router + lazy routes (all app routes are here).
- `main.tsx` — entry; providers (query client, theme, i18n, auth).
- `pages/cfo/*` — one file per route (e.g. `Chat.tsx`, `Dashboard*`, `Products.tsx`,
  `Landing.tsx` — landing is self-contained HTML+CSS in a string).
- `components/cfo/*` — the app surfaces. Subfolders: `chat/` (Ask CFO AI),
  `command/`, `industry/`, `pricing/`, `products/`, `navValuation*`.
- `components/ui/*` — shadcn/Radix primitives (Button, Sheet, Dialog, …).
- `components/{dashboard,landing,learning,public-companies,valuation,comparison}/*`.
- `lib/*` — non-UI logic: `cfoApi.ts` (backend client), `auth.tsx`,
  `activePeriod.ts` (the loaded period, threaded via `?period=<id>` in the URL),
  `currency.ts`, `features.ts`, statement builders (`buildPlStatement`, `buildBsStatement`,
  `buildCashFlowStatement`, `buildNavCascade`), `money.ts`/`formatRon.ts`.
- `stores/*` — React-context stores (`currency`, `dashboard`, `scenario`, `budget`, `learningMode`).
- `hooks/*`, `i18n/*` (RO/EN), `config/*`, `styles/*`, `theme/*`.
- `index.css` — design tokens + global utilities (see below). `App.css` — app-shell CSS.

## App shell / layout
- `AppShell` is mounted **once** by `AppLayout` (a shared React Router layout route
  in `App.tsx`) — authed pages render into its `<Outlet>`, so switching tabs swaps
  only page content and never remounts the sidebar/header (no full-page refresh).
  Pages return their content directly (NOT wrapped in `<AppShell>`). Exceptions:
  `PublicCompanyIntelligence` (`/public-companies`) picks its own shell.
- `components/cfo/AppShell.tsx`: fixed **`TopHeader`** (64px, `pt-16` offset on
  `<main>`), persistent left **`Sidebar`** (240px, `lg:pl-[268px]`, collapses to a
  rail; mobile = Sheet drawer), right slide-over panels (Docs `⌘D`, Datasets
  `⌘⇧D`, Ask CFO AI panel), Command Center (`⌘K` search).
- `TopHeader` also renders **`BackendStatusIndicator`** (+ `lib/useBackendStatus.ts`,
  polls `${API_URL}/health` every 20s + on focus/online) — a dot showing whether the
  FastAPI **engine** is reachable. Scoped to the engine only; it says nothing about
  Ask CFO AI chat, which runs on a Supabase Edge Function and works engine-down.
- Content is clamped to `max-w-[1760px]` **except `/chat`**, which opts out so the
  chat scroller reaches the screen's right edge.

## Ask CFO AI chat (`components/cfo/chat/`)
- `CFOChatShell.tsx` — orchestrator; `variant="page"` (full `/chat`, `Chat.tsx`) and
  `variant="panel"` (slide-over from `AppShell`). Owns the send pipeline
  (`cfoApi.chatLlm`) and mounts the store.
- `useChatStore.ts` — localStorage-backed conversations (shape mirrors a future
  Supabase table). `deriveTitle()` makes concise titles from the first message.
- `CFOMessageList` (scroller + `topInset`/`bottomInset`), `CFOMessageBubble`,
  `CFOTypingIndicator`, `CFOComposer` (transparent overlay input), `CFOHistorySidebar`
  (search + icon-only New chat + list with hover delete), `CFOEmptyState`.
- On `/chat` the conversation is full-width and full-height, scrolling **under** the
  translucent header and the bottom composer overlay.

## Design system (use tokens, not hex)
- Colors are CSS vars in `index.css`, theme-aware (light/dark via `next-themes`) and
  exposed as Tailwind classes (`tailwind.config.ts`):
  `text-ink` / `ink-soft` / `ink-mute`, `bg-bg` / `bg-2` / `surface`,
  `border-rule` / `rule-soft`, **`brand`** (`brand`, `brand-dark`, `brand-light`,
  `brand-tint`) = teal `#5CD3C5`. Gradients: `.bg-gradient-cfo` (the teal landing
  gradient), `.bg-gradient-hero/warm/cool/money`.
- Fonts: `font-mono` = JetBrains Mono (uppercase, letter-spaced eyebrows/labels),
  `font-serif` = Instrument Serif (big display numbers). Numbers use `tabular-nums`.
- `.chat-scroll` (in `index.css`) = app-themed thin scrollbar, thumb inset from the edge.
- Prefer editing tokens over hardcoding; style **both** light and dark.

## Conventions
- Money via `<Money>`/`MoneyValue` + `stores/currency` (global RON⇄display toggle).
- Every page reads the active period from `?period=<id>`; keep it on nav links.
- No emoji in product copy. Keep comments matching the file's existing density.
- After UI edits, run `npx tsc --noEmit` before declaring done.

> Recent FE work log lives in the **root** `CLAUDE.md §15` (dated changelog).
