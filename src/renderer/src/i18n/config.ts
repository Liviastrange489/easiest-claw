import {
  type Locale,
  type LocaleDirection,
  type LocaleOption,
  type LocalePreference,
  SUPPORTED_LOCALES,
} from "./types"

export const DEFAULT_LOCALE: Locale = "en"
export const DEFAULT_LOCALE_PREFERENCE: LocalePreference = "system"
export const LOCALE_PREFERENCE_COOKIE = "mossb-locale-preference"
export const LOCALE_PREFERENCE_STORAGE_KEY = "mossb-locale-preference"

export const LOCALE_OPTIONS: LocaleOption[] = [
  { code: "zh-CN", label: "简体中文", direction: "ltr" },
  { code: "en", label: "English", direction: "ltr" },
]

const LOCALE_MAP = new Map(LOCALE_OPTIONS.map((option) => [option.code, option]))

export const isLocale = (value: string | null | undefined): value is Locale =>
  SUPPORTED_LOCALES.includes(value as Locale)

export const getLocaleLabel = (locale: Locale): string =>
  LOCALE_MAP.get(locale)?.label ?? locale

export const getLocaleDirection = (locale: Locale): LocaleDirection =>
  LOCALE_MAP.get(locale)?.direction ?? "ltr"

const normalizeLocale = (value: string | null | undefined): Locale | null => {
  if (!value) return null

  const normalized = value.trim().toLowerCase().replace(/_/g, "-")

  if (normalized.startsWith("zh")) return "zh-CN"
  if (normalized.startsWith("en")) return "en"

  return null
}

export const parseLocalePreference = (
  value: string | null | undefined
): LocalePreference => {
  if (value === "system") return "system"
  if (isLocale(value)) return value
  return DEFAULT_LOCALE_PREFERENCE
}

export const resolveLocaleFromAcceptLanguage = (
  headerValue: string | null | undefined
): Locale => {
  const candidates = (headerValue ?? "")
    .split(",")
    .map((entry) => entry.split(";")[0]?.trim())
    .filter(Boolean)

  for (const candidate of candidates) {
    const locale = normalizeLocale(candidate)
    if (locale) return locale
  }

  return DEFAULT_LOCALE
}

export const resolveLocaleFromNavigator = (
  languages: readonly string[] | null | undefined
): Locale => {
  const candidates = Array.isArray(languages)
    ? languages
    : typeof navigator !== "undefined"
      ? navigator.languages ?? [navigator.language]
      : []

  for (const candidate of candidates) {
    const locale = normalizeLocale(candidate)
    if (locale) return locale
  }

  return DEFAULT_LOCALE
}

export const resolveLocale = (
  preference: LocalePreference,
  detectedLocale: Locale
): Locale => (preference === "system" ? detectedLocale : preference)
