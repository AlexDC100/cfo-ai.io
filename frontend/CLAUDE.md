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
- `npm run dev` — Vite dev server · `npm run dev:docker` — the same server inside
  Docker (compose service `frontend-dev`, profile `dev`; proxies `/api` to the
  `backend` container; port 5173 on the LAN) · `npm run dev:app` — the
  PRODUCTION build rebuilt on change and served on :5173 (~77 requests a
  page instead of ~560; what to point the phone at when load time matters;
  no HMR) · `npm run build` — prod build
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
- `CFOMessageList` (the ONLY scroller; `padTop`/`padBottom`; ref handle
  `scrollToBottom(smooth)`; re-pins on its own resize), `CFOMessageBubble`,
  `CFOTypingIndicator`, `CFOComposer` (in-flow input, never fixed), `CFOHistorySidebar`
  (search + icon-only New chat + list with hover delete), `CFOEmptyState`.
- `/chat` (2026-09-10) is a **fixed-height column**: AppShell gives it the viewport
  below the header with no padding (`chatPage` in `AppShell.tsx`, `html.chat-page-open`
  locks document scroll), the message list scrolls inside it and the composer sits in
  flow at the bottom. Nothing on the page is `position: fixed` — in the iOS WebView a
  fixed composer over a scrolling document lagged and its caret drifted.
- **Anchor on send** (2026-09-10): a message the user just sent glides to the top
  of the list and the answer types out under it; `CFOMessageList` grows a tail
  spacer (`chat-tail-space`, sized on the DOM, never state) so a short thread has
  the room, and gives it back as the answer fills it. Dropped on conversation switch.
- **Inside the native shell** the composer, the top-right "…" disc (a SwiftUI Menu:
  chat title, Rename, Delete chat), the drawer's held-chat menu (native action sheet
  → native text prompt for Rename) and the delete confirm are all NATIVE
  (`lib/nativeShell.ts`: `composer` / `chrome.trash` + `chatTitle` / `dialog` incl.
  kind `prompt` / `haptic` / `notify` messages; replies arrive as `cfo:native-action`
  events `composer-*`, `chat-rename`, `chat-delete`, `dialog`). The browser keeps
  `ChatItemMenu` (hold a drawer row / the "…" disc → lifted row + Rename / Delete).
  An answer that lands while the app is backgrounded becomes a local notification
  (`chatTurns.ts` → `postNotify`). The drawer ticks a haptic on open/close and on
  entering a tab, and its nav always scrolls (`overflow-y-scroll` + content ≥ 100%+1px).

## Report a problem (`pages/cfo/ReportProblem.tsx`, 2026-09-10)
- `/report-problem` — message + up to 5 attachments (base64 in JSON) →
  `cfoApi.sendReport` → engine `POST /api/report` (`src/engine/api/_report.py`)
  → Resend (`_email.send_email` with `attachments`) to `SITE.reportsEmail`
  (reports@cfo-ai.io; engine env `REPORTS_INBOX_EMAIL` overrides). Reached from
  the drawer's Support section and the rail's System group (`sidebar-report`).
  Needs `RESEND_API_KEY` + a verified `RESEND_FROM` on the engine; without them
  the page shows the "email us directly" failure.

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
