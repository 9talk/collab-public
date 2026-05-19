export const en = {
  settings: "Settings",
  appearance: "Appearance",
  theme: "Theme",
  light: "Light",
  dark: "Dark",
  system: "System",
  language: "Language",
  general: "General",
  about: "About",
  version: "Version",
} as const satisfies Record<string, string>;

export type TranslationKey = keyof typeof en;
export type TranslationDict = Record<TranslationKey, string>;
