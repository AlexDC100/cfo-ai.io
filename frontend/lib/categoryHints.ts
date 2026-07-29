// Category translation hints for the Products page.
//
// Romanian category codes (LEGUME CONSERVATE, TON, MURATURI, etc.) are
// source data — they come straight from the user's uploaded SKU export
// and stay as-is in the table (wrapped in <SourceText lang="ro"> for
// screen-reader correctness). But when the UI language is English or
// French, an inline italic hint helps non-Romanian readers parse what
// the category MEANS without losing the source identity:
//
//   LEGUME CONSERVATE  (canned vegetables)
//                       ^^^^^^^^^^^^^^^^^^ from CATEGORY_HINTS
//
// Brand names (NAVODUL PLIN, ROUA, TAPAS, ANNABELLA...) are proper nouns
// — NO translation hint. Product names same.
//
// Maintenance: this list grows over time as new categories surface in
// uploads. The lookup is a no-op for unknown categories (returns null),
// so missing entries degrade gracefully — the category just renders
// without a hint until someone adds the mapping.

export type CategoryHintLocale = "en" | "fr";

export const CATEGORY_HINTS: Record<CategoryHintLocale, Record<string, string>> = {
  en: {
    "LEGUME CONSERVATE":    "canned vegetables",
    "MURATURI":             "pickles",
    "TON":                  "tuna",
    "TON FILE":             "tuna fillet",
    "SARDINE":              "sardines",
    "MACROU":               "mackerel",
    "MACROU FILE":          "mackerel fillet",
    "HERING":               "herring",
    "HERING FILE":          "herring fillet",
    "SOMON":                "salmon",
    "PASTRAV":              "trout",
    "SPROT":                "sprat",
    "PASTA TOMATE":         "tomato paste",
    "JELEURI":              "jellies",
    "COMPOT":               "fruit compote",
    "DULCEATA":             "fruit preserves",
    "ZACUSCA":              "zacuscă (vegetable spread)",
    "SIROP":                "syrup",
    "SUC":                  "juice",
    "SUC DE ROSII":         "tomato juice",
    "SOSURI":               "sauces",
    "OTET":                 "vinegar",
    "MUSTAR":               "mustard",
    "ULEI":                 "oil",
    "SUPE INSTANT NOODLES": "instant noodle soups",
    "PET FOOD":             "pet food",
    "FRUCTE NOBILE":        "premium fruits",
    "ALTE MARFURI":         "other goods",
    "MANC CONGELATE CRUDE": "raw frozen food",
    "MANCARE PESTE":        "fish products",
  },
  fr: {
    "LEGUME CONSERVATE":    "légumes en conserve",
    "MURATURI":             "cornichons",
    "TON":                  "thon",
    "TON FILE":             "filet de thon",
    "SARDINE":              "sardines",
    "MACROU":               "maquereau",
    "MACROU FILE":          "filet de maquereau",
    "HERING":               "hareng",
    "HERING FILE":          "filet de hareng",
    "SOMON":                "saumon",
    "PASTRAV":              "truite",
    "SPROT":                "sprat",
    "PASTA TOMATE":         "concentré de tomate",
    "JELEURI":              "gelées",
    "COMPOT":               "compote de fruits",
    "DULCEATA":             "confitures",
    "ZACUSCA":              "zacusca (tartinade de légumes)",
    "SIROP":                "sirop",
    "SUC":                  "jus",
    "SUC DE ROSII":         "jus de tomate",
    "SOSURI":               "sauces",
    "OTET":                 "vinaigre",
    "MUSTAR":               "moutarde",
    "ULEI":                 "huile",
    "SUPE INSTANT NOODLES": "soupes nouilles instantanées",
    "PET FOOD":             "aliments pour animaux",
    "FRUCTE NOBILE":        "fruits premium",
    "ALTE MARFURI":         "autres marchandises",
    "MANC CONGELATE CRUDE": "aliments congelés crus",
    "MANCARE PESTE":        "produits à base de poisson",
  },
};

/** Look up a translation hint for a Romanian category code.
 *  Returns null when the locale isn't supported (e.g. UI is Romanian or
 *  German — RO native readers don't need a hint; DE doesn't have a
 *  dictionary yet), or when the category isn't in the dictionary.
 *  Case-insensitive lookup since uploads sometimes vary capitalization. */
export function categoryHint(category: string | null | undefined, uiLang: string): string | null {
  if (!category) return null;
  const lang = uiLang.startsWith("en") ? "en" : uiLang.startsWith("fr") ? "fr" : null;
  if (!lang) return null;
  const dict = CATEGORY_HINTS[lang];
  // Exact match first (cheapest); then case-insensitive walk.
  if (dict[category]) return dict[category];
  const upper = category.trim().toUpperCase();
  for (const k of Object.keys(dict)) {
    if (k.toUpperCase() === upper) return dict[k];
  }
  return null;
}
