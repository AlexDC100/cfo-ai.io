# I18N_REMAINING — Punch-list for full app-wide language coverage

> **Status (2026-05-24):** Infrastructure shipped. Products page Tier 1 done. Remaining 169-file walkthrough is a multi-day team sprint.
> **Owner:** TBD
> **Companion docs:** spec in chat history (operator paste 2026-05-24)

## Why this file exists

A single agent turn ships infrastructure + the highest-visibility fixes; it cannot responsibly translate ~300+ keys into professional Romanian + French financial vocabulary in one pass. This file is the punch-list so the next session (human or agent) picks up where I left off without re-doing the audit.

## What's DONE

| Area | Status | File |
|---|---|---|
| Currency toggle (RON / EUR / USD) | Shipped | `src/components/cfo/CurrencyToggle.tsx`, `src/lib/{rates,money}.ts`, `src/stores/currency.tsx` |
| Real measured extraction accuracy in upload popup | Shipped | `src/pages/cfo/FinancialStatements.tsx` (ExtractionAccuracyBanner) |
| Products page Tier 1 (Expected Format, columns, sort, filters, totals, working capital, datasets) | Shipped | `src/pages/cfo/Products.tsx` + locales |
| `<SourceText lang="ro">` primitive for source-data strings | Shipped | `src/components/ui/SourceText.tsx` |
| `categoryHint()` RO→EN/FR for 30 Romanian categories | Shipped | `src/lib/categoryHints.ts` |
| `I18nError` class — forces every error path through i18n keys | Shipped | `src/lib/i18nError.ts` |
| `useI18nToast()` wrapper — forces toast call sites through i18n | Shipped | `src/lib/toastWithI18n.ts` |
| `useDocumentTitle()` hook — translates `<title>` + re-fires on language switch | Shipped | `src/hooks/useDocumentTitle.ts` |
| `useHtmlLangSync()` — keeps `<html lang>` in sync with i18n.language | Shipped + mounted in `App.tsx` | `src/hooks/useHtmlLangSync.ts` |
| Dev-only `missingKeyHandler` console warning | Shipped | `src/i18n/index.ts` |
| CI coverage gate (`check-i18n-coverage.ts`) | Shipped | `scripts/check-i18n-coverage.ts` |
| `common.*` / `errors.*` / `toasts.*` / `confirmations.*` / `empty.*` / `page.titles.*` universal keys | Shipped en/ro/fr | `src/i18n/locales/{en,ro,fr}.json` |

## What's BLOCKING (must fix before "complete" claim)

Current `npx tsx scripts/check-i18n-coverage.ts` output:
- **5 keys missing in RO**: all under `sidebar.*` — `chat`, `upload`, `reports`, `inventory`, `invoices`
- **44 keys missing in FR**: 7 sidebar keys + 37 settings.* keys (workspace, billing, subscription, security, password, etc.)

These are PRE-EXISTING gaps the gate would have caught earlier if it existed. They're trivial to fill — flat string-by-string translation. Fix them first; the coverage gate then passes baseline so future drift is the only thing it catches.

## DIAGNOSTIC SWEEP — saved to repo

The 7 spec greps were executed; output lives at `/tmp/i18n-sweep/`. Headline numbers:

| Grep | Count | Meaning |
|---|---|---|
| Romanian diacritics in `.tsx`/`.ts` (not in /locales/, /test/) | **112** | Hardcoded Romanian likely-UI strings to wrap |
| `(toast.\|throw new Error\|console.{error,warn})` (not in /test/) | **75** | Async paths — high regression risk, many bypass i18n |
| `(title\|placeholder\|label\|alt\|aria-label)=['"][A-Z]` (not in /test/, not in t()) | **323** | String props with literal capitalized UI copy |
| Common English UI words (`Add\|Save\|Cancel\|...`) bare in JSX | 7 | Low — most are already in t() or come from libraries |
| `.tsx` files in `src/` (excluding tests) | **169** | Total file scope to walk |

Re-run any grep to get fresh per-file detail:
```bash
grep -rnE "[ăâîșțĂÂÎȘȚ]" src/ --include="*.tsx" --include="*.ts" \
  | grep -v "/locales/" | grep -v "/test"
```

## Remaining work — by surface, sized

Per the earlier Plan-agent enumeration of `Products.tsx` (120+ strings across 12 regions) and the spec's full-app scope, these surfaces still need a pass. Effort numbers assume a developer who can read the surface, extract literals, and is comfortable with React + i18next; multiply by 1.5x if a translator review is also required (recommended for RO and FR financial vocabulary).

| Surface | Files | Strings (est.) | Effort | Notes |
|---|---|---|---|---|
| **Dashboard (`FinancialStatements.tsx`)** | 1 (~5000 LOC) | 200+ | 6–8h | Largest file. Hero, KPI cards, briefing, P&L, BS, ratios, valuation, alerts, recommendations |
| **Decision Rules modal** | 1 | 60+ | 3–4h | Preset names + descriptions (5 presets), financing labels, all rule cards, mode selector |
| **Industry Picker modal** | 1 | 30+ | 2h | Title, search, suggested, section headings, save/cancel |
| **Onboarding** | 1 | 40+ | 3h | Multi-step flow, all titles + helper text + button labels |
| **Auth pages (Login, Signup, Reset)** | 3 | 50+ | 3–4h | Form labels, validation messages, links, helper text |
| **Settings — billing/account/subscription panels** | 5 components | 50+ (37 already keyed but not in FR) | 4h | Fill the 37 FR gaps; audit remaining sections |
| **Documents page** | 1 | 30+ | 2h | List headers, active/other/deleted sections, switch action, doc detail |
| **Command Center sidebar / drawer** | ~3 | 30+ | 2h | Filter chips, sort sheet, doc switcher |
| **Products page — Tier 2 (NOT in Tier 1)** | `Products.tsx` | ~60 | 4–6h | InflightCard pipeline stages, ComparisonSection, BottomInsightStrip, StatsStrip, ProcessFlow, AcceptedFormats, EmptyState dropzone, chip-prompt AI strings, mobile row mini-labels |
| **Toast / error sites** | ~50 across many files | 75 call sites | 4–6h | Convert each `toast.error("…")` → `tToast.error('errors.X')` + each `throw new Error("…")` → `throw new I18nError('errors.X')`. Mechanical but tedious |
| **Page `<title>` tags** | ~10 pages | 10 | 1h | One `useDocumentTitle('page.titles.X')` call per page. Keys already exist |
| **404 + error boundary pages** | 2 | 10 | 1h | |
| **Email templates (if any)** | TBD | TBD | TBD | Out of FE scope; backend renders these — needs separate review |

**Total estimated effort: 35–50 hours** for a single dev doing the walkthrough, then translation review. With a translator working in parallel to the dev (recommended), 3 working days end-to-end.

## How to execute (recommended order)

1. **First: close the coverage gate baseline** (1–2h) — fill the 5 RO + 44 FR pre-existing gaps so `check-i18n-coverage.ts` exits 0. Now CI can enforce no new gaps.
2. **Second: wire `useDocumentTitle` into every page** (1h) — one-line change per page, keys already exist. Browser tab titles + screen-reader announcements now respect language.
3. **Third: convert toast + error sites** (4–6h) — refactor the 75 call sites to use `useI18nToast()` + `I18nError`. Add the i18n keys to `toasts.*` and `errors.*` for each new string discovered.
4. **Fourth: walk visible surfaces in priority order** — Dashboard → Decision Rules → Industry Picker → Documents → Settings sub-sections → Onboarding → Auth. Add keys to all three locales as you find new strings.
5. **Fifth: Products Tier 2** — finish the 60-string backlog the Plan agent enumerated (InflightCard, Comparison, etc.).
6. **Sixth: ESLint `react/jsx-no-literals` rule** (intentionally NOT enabled yet — would fail-build on hundreds of legitimate literals across the auth + marketing pages today). Enable AFTER the walkthrough as the regression gate going forward.
7. **Final: QA walkthrough** — full 30+ screenshot grid (3 langs × ~10 surfaces), CI coverage check passes, console clean of `[i18n] Missing key` warnings during full flow.

## Pattern reference — use these primitives

For new strings:
```tsx
import { useTranslation, Trans } from 'react-i18next';
const { t } = useTranslation();
<button>{t('common.save')}</button>
<p><Trans i18nKey="expectedFormat.required" components={{ c1: <code/>, c2: <code/> }} /></p>
```

For toasts:
```tsx
import { useI18nToast } from '@/lib/toastWithI18n';
const tToast = useI18nToast();
tToast.success('toasts.settingsSaved');
tToast.error('errors.uploadFailed', { fileName: f.name });
try { … } catch (e) { tToast.fromError(e); }
```

For errors:
```tsx
import { I18nError } from '@/lib/i18nError';
throw new I18nError('errors.fileTooLarge', { max: '25 MB' });
```

For page titles:
```tsx
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
useDocumentTitle('page.titles.products');
```

For source data (product names, brands, parser column-name examples, Romanian categories):
```tsx
import { SourceText } from '@/components/ui/SourceText';
<SourceText lang="ro">{product.name}</SourceText>
```

For Romanian-category translation hints (English/French UI):
```tsx
import { categoryHint } from '@/lib/categoryHints';
const hint = categoryHint('LEGUME CONSERVATE', i18n.language); // → "canned vegetables"
```

## Acceptance criteria (when this file gets archived)

- [ ] `npx tsx scripts/check-i18n-coverage.ts` exits 0 (zero gaps, zero orphans, zero empty values, zero placeholder mismatches)
- [ ] Manual walkthrough in en/ro/fr — every surface in user spec's section "SCOPE" reads correctly in the selected language
- [ ] Browser console clean of `[i18n] Missing key:` warnings during full walkthrough
- [ ] No `>...< ` JSX literal of likely-UI English/Romanian text outside `/locales/` or `/test/` (re-run sweep grep #3 + #5)
- [ ] All `toast.*` and `throw new Error(…)` sites either route through `useI18nToast` / `I18nError` OR are dev-only (console.error/warn allowed)
- [ ] `<html lang>` updates on language switch (verified via DevTools)
- [ ] Document title updates on language switch (verified via browser tab)
- [ ] Date / number / currency formatting follows the currency display locale (already shipped via `Intl.NumberFormat` in `lib/money.ts`)
- [ ] ESLint `react/jsx-no-literals` rule enabled and CI-blocking (last step — turn this on AFTER the cleanup)
