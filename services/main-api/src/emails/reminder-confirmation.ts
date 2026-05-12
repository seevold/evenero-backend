import { translateEmail as te } from '../i18n.js';
import type { SupportedLocale } from './locale.js';
import { formatEmailDate, stripEmoji } from './locale.js';
import { renderEmail, type Block } from './layout.js';
import { sendEmail } from './send.js';

export async function sendReminderConfirmationEmail(
  email: string,
  eventName: string,
  galleryUrl: string,
  scheduledDate: Date,
  locale: SupportedLocale,
): Promise<boolean> {
  const cleanEventName = stripEmoji(eventName);
  const subject = te(locale, 'reminderConfirmation.subject', { eventName: cleanEventName });
  const formattedDate = formatEmailDate(scheduledDate, locale);

  const blocks: Block[] = [
    { type: 'eyebrow', text: te(locale, 'reminderConfirmation.eyebrow') },
    { type: 'heading', text: te(locale, 'reminderConfirmation.title') },
    { type: 'paragraph', text: te(locale, 'reminderConfirmation.body', { eventName: cleanEventName }) },
    { type: 'note', tone: 'success', text: te(locale, 'reminderConfirmation.scheduledFor', { date: formattedDate }) },
    { type: 'paragraph', text: te(locale, 'reminderConfirmation.galleryLink') },
    { type: 'button', label: te(locale, 'reminderConfirmation.viewGalleryButton'), href: galleryUrl },
    { type: 'small', text: te(locale, 'reminderConfirmation.changeReminder') },
  ];

  const { html, text } = renderEmail({
    lang: locale,
    footer: te(locale, 'common.footer'),
    blocks,
  });

  return sendEmail(email, subject, text, html);
}
