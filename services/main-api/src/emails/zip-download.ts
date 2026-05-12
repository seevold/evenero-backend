import { translateEmail as te } from '../i18n.js';
import type { SupportedLocale } from './locale.js';
import { stripEmoji } from './locale.js';
import { renderEmail, type Block } from './layout.js';
import { sendEmail } from './send.js';

export async function sendZipDownloadEmail(
  email: string,
  eventName: string,
  zipUrl: string,
  fileCount: number,
  zipSizeMB: number,
  locale: SupportedLocale,
): Promise<boolean> {
  const cleanEventName = stripEmoji(eventName);
  const subject = te(locale, 'zipReady.subject', { eventName: cleanEventName });
  const fileCountLabel = te(locale, 'zipReady.fileCountLabel');
  const sizeLabel = te(locale, 'zipReady.sizeLabel');

  const blocks: Block[] = [
    { type: 'eyebrow', text: te(locale, 'zipReady.eyebrow') },
    { type: 'heading', text: te(locale, 'zipReady.title') },
    { type: 'paragraph', text: te(locale, 'zipReady.body', { eventName: cleanEventName }) },
    {
      type: 'note',
      text: `${fileCount} ${fileCountLabel}  ·  ${zipSizeMB} MB ${sizeLabel}`,
    },
    { type: 'button', label: te(locale, 'zipReady.downloadButton'), href: zipUrl },
    { type: 'note', tone: 'warning', text: te(locale, 'zipReady.expiry') },
  ];

  const { html, text } = renderEmail({
    lang: locale,
    footer: te(locale, 'common.footer'),
    blocks,
  });

  return sendEmail(email, subject, text, html);
}
