import { SUPPORTED_LOCALES, DEFAULT_LOCALE, LOCALE_NAMES, isValidLocale, getLocaleFromHeader } from './config';
import type { SupportedLocale } from './config';

import enCommon from './locales/en/common.json';
import enPages from './locales/en/pages.json';
import enEmails from './locales/en/emails.json';
import enNotifications from './locales/en/notifications.json';

import nbCommon from './locales/nb/common.json';
import nbPages from './locales/nb/pages.json';
import nbEmails from './locales/nb/emails.json';
import nbNotifications from './locales/nb/notifications.json';

import svCommon from './locales/sv/common.json';
import svPages from './locales/sv/pages.json';
import svEmails from './locales/sv/emails.json';
import svNotifications from './locales/sv/notifications.json';

import esCommon from './locales/es/common.json';
import esPages from './locales/es/pages.json';
import esEmails from './locales/es/emails.json';
import esNotifications from './locales/es/notifications.json';

export const resources = {
  en: {
    common: enCommon,
    pages: enPages,
    emails: enEmails,
    notifications: enNotifications
  },
  nb: {
    common: nbCommon,
    pages: nbPages,
    emails: nbEmails,
    notifications: nbNotifications
  },
  sv: {
    common: svCommon,
    pages: svPages,
    emails: svEmails,
    notifications: svNotifications
  },
  es: {
    common: esCommon,
    pages: esPages,
    emails: esEmails,
    notifications: esNotifications
  }
} as const;

export type TranslationNamespace = keyof typeof resources.en;
export type TranslationResources = typeof resources;

export {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  LOCALE_NAMES,
  isValidLocale,
  getLocaleFromHeader
};
export type { SupportedLocale };
