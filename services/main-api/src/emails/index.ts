// Public entry point for all transactional email sending.
//
// Each template lives in its own file under emails/, shares a single layout
// (layout.ts) + design tokens (tokens.ts), and calls the low-level Mailgun
// client (send.ts). Translations come from
// src/shared/i18n/locales/<lang>/emails.json via translateEmail() in i18n.ts.
//
// Locale resolution is the caller's responsibility — use resolveEmailLocale()
// from ./locale.ts at the request handler so the same rules apply to every
// email type.

export { sendEmail } from './send.js';
export { sendPinCodeEmail } from './pin-code.js';
export { sendCoHostInvitationEmail } from './co-host-invite.js';
export { sendReminderConfirmationEmail } from './reminder-confirmation.js';
export { sendEventReminderEmail } from './event-reminder.js';
export { sendZipDownloadEmail } from './zip-download.js';
export { sendFeedbackNotificationEmail } from './feedback-notification.js';
export { resolveEmailLocale, formatEmailDate, stripEmoji } from './locale.js';
export type { SupportedLocale } from './locale.js';
