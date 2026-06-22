import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

/**
 * CUR-FIX (universal coverage) — regression guard for the currency pipeline.
 *
 * Every monetary value displayed in the app must route through the canonical
 * <Money> component (or the `useAmountFormatter` / `formatMoneyFrom` helpers
 * those build on). Free-form `RON` / `EUR` / `USD` / `€` / `$` string
 * concatenation re-introduces the "some pages convert, some don't" bug class
 * the CUR-FIX-A → G sweep was designed to eliminate.
 *
 * The lint rule below catches the two most common shapes that escape:
 *   1. A string literal that ends in a currency code or starts with a
 *      currency symbol followed by digits.
 *   2. A `.toLocaleString(locale, { style: "currency", ... })` call that
 *      hard-codes a currency outside the Money implementation files.
 *
 * Files explicitly OK to bypass the rule (the implementation surface itself,
 * billing pricing that's intentionally currency-independent, i18n locale
 * strings, and tests) are scoped out via the `overrides` block.
 */
const CURRENCY_RESTRICTED_SYNTAX = [
  {
    // Catches hardcoded money strings like "$1,234", "€918.5K", "1,500 RON",
    // "12 kRON". Currency CODES (RON/EUR/USD) only match when adjacent to
    // a digit so we don't trip on documentation comments or type-literal
    // strings. Currency SYMBOLS ($/€) only match when followed by digits.
    selector:
      "Literal[value=/^\\s*[€$£]\\s*\\d|\\d\\s*(RON|EUR|USD|kRON|MRON)\\b|\\b(RON|EUR|USD|kRON|MRON)\\s*\\d/i]",
    message:
      "CUR-FIX: hardcoded money string. Use <Money amount={value} fromCurrency={...} /> or formatMoneyFrom(...) instead.",
  },
  {
    // Catches `new Intl.NumberFormat(..., { style: 'currency' })`. Plain
    // `toLocaleString` with numeric options (counts/days) doesn't trip —
    // only the explicit currency-formatter shape.
    selector:
      "NewExpression[callee.object.name='Intl'][callee.property.name='NumberFormat'] Property[key.name='style'][value.value='currency']",
    message:
      "CUR-FIX: `new Intl.NumberFormat(..., { style: 'currency', ... })` bypasses the global currency toggle. Use <Money /> or useAmountFormatter(...) instead.",
  },
];

export default tseslint.config(
  { ignores: ["dist"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
      "no-restricted-syntax": ["warn", ...CURRENCY_RESTRICTED_SYNTAX],
    },
  },
  // Allow-list: implementation files of the Money pipeline + intentional
  // currency-independent surfaces (billing) + i18n locales + tests.
  {
    files: [
      "src/components/ui/Money.tsx",
      "src/components/cfo/MoneyValue.tsx",
      "src/components/cfo/CurrencyToggle.tsx",
      "src/lib/money.ts",
      "src/lib/format.ts",
      "src/lib/formatRon.ts",
      "src/lib/currency.ts",
      "src/lib/rates.ts",
      "src/stores/currency.tsx",
      "src/i18n/**",
      "src/pages/cfo/Settings.tsx",
      "src/pages/billing/**",
      "src/lib/financialExports.ts",
      "src/lib/publicCompany*.ts",
      "**/*.test.{ts,tsx}",
      "**/__tests__/**",
    ],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
);
