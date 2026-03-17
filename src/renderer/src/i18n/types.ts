export const SUPPORTED_LOCALES = [
  "zh-CN",
  "en",
] as const

export type Locale = (typeof SUPPORTED_LOCALES)[number]
export type LocalePreference = "system" | Locale
export type TranslationValues = Record<string, string | number>
export type Translate = (key: string, values?: TranslationValues) => string
export type LocaleDirection = "ltr" | "rtl"

export interface Dictionary {
  [key: string]: string | Dictionary
}

export interface LocaleOption {
  code: Locale
  label: string
  direction: LocaleDirection
}
