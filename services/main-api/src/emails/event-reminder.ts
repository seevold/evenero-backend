import { translateEmail as te } from '../i18n.js';
import type { SupportedLocale } from './locale.js';
import { stripEmoji } from './locale.js';
import { renderEmail, type Block } from './layout.js';
import { sendEmail } from './send.js';

export async function sendEventReminderEmail(
  email: string,
  eventName: string,
  galleryUrl: string,
  locale: SupportedLocale,
): Promise<boolean> {
  const cleanEventName = stripEmoji(eventName);
  const subject = te(locale, 'eventReminder.subject', { eventName: cleanEventName });

  // Order: lead-in copy → CTA → secondary supporting note.
  // Old layout had a paragraph *after* the button which buried the
  // hint and made the CTA feel mid-message instead of the climax.
  const blocks: Block[] = [
    { type: 'eyebrow', text: te(locale, 'eventReminder.eyebrow') },
    { type: 'heading', text: te(locale, 'eventReminder.title') },
    { type: 'subheading', text: cleanEventName },
    { type: 'paragraph', text: te(locale, 'eventReminder.body', { eventName: cleanEventName }) },
    { type: 'paragraph', text: te(locale, 'eventReminder.uploadPrompt') },
    { type: 'paragraph', text: te(locale, 'eventReminder.viewOthers') },
    { type: 'button', label: te(locale, 'eventReminder.viewGallery'), href: galleryUrl },
    { type: 'small', text: te(locale, 'eventReminder.downloadHint') },
  ];

  const { html, text } = renderEmail({
    lang: locale,
    preheader: te(locale, 'eventReminder.preheader', { eventName: cleanEventName }),
    footer: te(locale, 'common.footer'),
    blocks,
  });

  return sendEmail(email, subject, text, html);
}
