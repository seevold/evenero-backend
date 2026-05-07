import i18n from 'i18next';
import { resources, DEFAULT_LOCALE, isValidLocale, getLocaleFromHeader } from '@shared/i18n';
import type { SupportedLocale, TranslationNamespace } from '@shared/i18n';

let initialized = false;

export async function initServerI18n() {
  if (initialized) return;
  
  await i18n.init({
    resources,
    fallbackLng: DEFAULT_LOCALE,
    defaultNS: 'common',
    ns: ['common', 'pages', 'emails', 'notifications'],
    interpolation: {
      escapeValue: false
    }
  });
  
  initialized = true;
}

initServerI18n();

export function translate(
  locale: SupportedLocale | string | undefined,
  key: string,
  options?: Record<string, unknown>
): string {
  const validLocale = locale && isValidLocale(locale) ? locale : DEFAULT_LOCALE;
  return i18n.t(key, { lng: validLocale, ...options }) as string;
}

export function translateEmail(
  locale: SupportedLocale | string | undefined,
  key: string,
  options?: Record<string, unknown>
): string {
  return translate(locale, `emails:${key}`, options);
}

export function translateNotification(
  locale: SupportedLocale | string | undefined,
  key: string,
  options?: Record<string, unknown>
): string {
  return translate(locale, `notifications:${key}`, options);
}

export function getLocaleForUser(
  userPreferredLocale: string | null | undefined,
  acceptLanguageHeader: string | undefined
): SupportedLocale {
  if (userPreferredLocale && isValidLocale(userPreferredLocale)) {
    return userPreferredLocale;
  }
  return getLocaleFromHeader(acceptLanguageHeader);
}

export { isValidLocale, getLocaleFromHeader, DEFAULT_LOCALE };
export type { SupportedLocale };
