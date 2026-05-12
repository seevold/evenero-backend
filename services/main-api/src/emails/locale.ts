// Locale resolution for outbound emails.
//
// Priority (strongest first):
//   1. Recipient's saved DB preference (`user.preferred_locale`)
//   2. Explicit locale passed in (e.g., co-host invite form)
//   3. `locale` field in the request body (frontend passing app locale)
//   4. Accept-Language HTTP header (best signal for anonymous visitors)
//   5. DEFAULT_LOCALE ('en')

import type { Request } from 'express';
import {
  isValidLocale,
  getLocaleFromHeader,
  DEFAULT_LOCALE,
} from '../shared/i18n/index.js';
import type { SupportedLocale } from '../shared/i18n/index.js';
import { LOCALE_DATE_CODES } from './tokens.js';

export interface MinimalUser {
  preferred_locale?: string | null;
}

export function resolveEmailLocale(
  req: Request | undefined,
  recipient?: MinimalUser | null,
  explicitLocale?: string | null,
): SupportedLocale {
  // 1. Recipient's saved preference wins — they explicitly chose this language.
  if (recipient?.preferred_locale && isValidLocale(recipient.preferred_locale)) {
    return recipient.preferred_locale;
  }

  // 2. Caller-provided locale (e.g. co-host invite picker, or a saved
  //    reminder.locale captured at signup time).
  if (explicitLocale && isValidLocale(explicitLocale)) {
    return explicitLocale;
  }

  // 3. Locale in request body (frontend includes the app's active locale
  //    for endpoints that send emails to non-logged-in addresses).
  if (req) {
    const bodyLocale = (req.body as any)?.locale;
    if (bodyLocale && isValidLocale(bodyLocale)) return bodyLocale;

    // 4. Browser Accept-Language as final inference.
    return getLocaleFromHeader(req.headers['accept-language'] as string | undefined);
  }

  return DEFAULT_LOCALE;
}

// Locale-aware date formatting for email bodies. Centralized so the same
// rules apply everywhere (events reminder, reminder confirmation, etc.).
export function formatEmailDate(
  date: Date,
  locale: SupportedLocale,
  options: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  },
): string {
  const code = LOCALE_DATE_CODES[locale] || LOCALE_DATE_CODES.en;
  return date.toLocaleDateString(code, options);
}

// Strip emoji and pictographs from a string. Used on event names that
// appear in subject lines because some clients render emoji badly in
// notification previews.
const EMOJI_RE = /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu;
export function stripEmoji(s: string): string {
  return s.replace(EMOJI_RE, '').trim();
}

export { isValidLocale };
export type { SupportedLocale };
