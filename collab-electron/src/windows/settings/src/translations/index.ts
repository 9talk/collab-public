import { useCallback, useEffect, useState } from "react";
import { en, TranslationKey } from "./en";
import { zh } from "./zh";

export type SupportedLocale = "en" | "zh";

const dictionaries: Record<SupportedLocale, Record<string, string>> = {
  en,
  zh,
};

const FALLBACK = en;

export function useTranslation(api: {
  getPref: (key: string) => Promise<unknown>;
}) {
  const [locale, setLocale] = useState<SupportedLocale>("en");

  useEffect(() => {
    api.getPref("locale")
      .then((v) => {
        if (v === "en" || v === "zh") setLocale(v);
      })
      .catch(() => {});
  }, [api]);

  const t = useCallback(
    (key: TranslationKey): string => {
      const dict = dictionaries[locale] ?? FALLBACK;
      return dict[key] ?? FALLBACK[key] ?? key;
    },
    [locale],
  );

  return { t, locale };
}
