import { SUPPORTED_LOCALES, DEFAULT_LOCALE, type SupportedLocale } from '../schema';

export { SUPPORTED_LOCALES, DEFAULT_LOCALE };
export type { SupportedLocale };

export const LOCALE_NAMES: Record<SupportedLocale, string> = {
  en: 'English',
  nb: 'Norsk',
  sv: 'Svenska',
  es: 'Español'
};

export function isValidLocale(locale: string): locale is SupportedLocale {
  return SUPPORTED_LOCALES.includes(locale as SupportedLocale);
}

export function getLocaleFromHeader(acceptLanguage: string | undefined): SupportedLocale {
  if (!acceptLanguage) return DEFAULT_LOCALE;
  
  const languages = acceptLanguage
    .split(',')
    .map(lang => {
      const [code, quality] = lang.trim().split(';q=');
      return {
        code: code.split('-')[0].toLowerCase(),
        quality: quality ? parseFloat(quality) : 1
      };
    })
    .sort((a, b) => b.quality - a.quality);
  
  for (const { code } of languages) {
    if (code === 'nb' || code === 'no' || code === 'nn') return 'nb';
    if (code === 'sv') return 'sv';
    if (code === 'es') return 'es';
    if (code === 'en') return 'en';
  }
  
  return DEFAULT_LOCALE;
}
