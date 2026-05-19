import { en, TranslationDict, TranslationKey } from "./en";
import { zh } from "./zh";

export type { TranslationKey, TranslationDict };
export type SupportedLocale = "en" | "zh";

const dictionaries: Record<SupportedLocale, TranslationDict> = { en, zh };

export function useTranslation(locale: SupportedLocale = "en") {
  const dict = dictionaries[locale] ?? dictionaries.en;
  const t = (key: TranslationKey): string => dict[key] ?? key;
  return { t, locale };
}
