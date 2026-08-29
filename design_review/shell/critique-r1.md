# Shell — critique r1

- **Hierarchy** — Header reads correctly left→right (context object · command bar · trust/actions); rail groups (OVERVIEW/ANALYZE/EXPLORE/ASK) scan instantly; active row's 2px accent rule + ink text confirmed on /settings. TrustChip correctly absent on the legacy demo period (no fake trust).
- **Density** — Rail rows (36px) and header (56px) right; palette rows are the miss: two-line rows ~50px tall make eight pages feel like a page of content. Go single-line (label left, muted hint right).
- **Contrast** — The palette sits under the shared dialog overlay (black/80): in Paper theme the "glass" reads muddy and page text ghosts through rows. Needs its own lighter overlay + panel at ~0.9 opacity so blur reads as glass, not fog.
- **Soul** — Collapse animation with crossfading labels is smooth; icons stay dead-center at 64px; hairline section dividers in collapsed mode are quiet and right. One accent only: the active rule (+ brand sparkles for Ask).
- **Consistency** — Context chip, command bar, kbd hints share rounded-sm + hairline + mono idiom with Panel/Chip. Drawer preserved exactly (currency row, account row, notifications, 44px targets).

**Actions for r2:** palette overlay/opacity + single-line dense rows; re-shoot /dashboard /products /settings + /chat both themes.
