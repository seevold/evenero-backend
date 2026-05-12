import { translateEmail as te } from '../i18n.js';
import type { SupportedLocale } from './locale.js';
import { renderEmail, type Block } from './layout.js';
import { sendEmail } from './send.js';

export async function sendPinCodeEmail(
  email: string,
  pinCode: string,
  locale: SupportedLocale,
  loginUrl?: string,
): Promise<boolean> {
  const subject = te(locale, 'pinCode.subject');

  const blocks: Block[] = [
    { type: 'eyebrow', text: te(locale, 'pinCode.eyebrow') },
    { type: 'heading', text: te(locale, 'pinCode.title') },
    { type: 'paragraph', text: te(locale, 'pinCode.body') },
    { type: 'code', value: pinCode },
  ];

  if (loginUrl) {
    blocks.push({ type: 'button', label: te(locale, 'pinCode.loginButton'), href: loginUrl });
    blocks.push({ type: 'small', text: te(locale, 'pinCode.orEnterManually') });
  }

  blocks.push({ type: 'divider' });
  blocks.push({ type: 'small', text: te(locale, 'pinCode.expiry') });
  blocks.push({ type: 'small', text: te(locale, 'pinCode.ignore') });

  const { html, text } = renderEmail({
    lang: locale,
    footer: te(locale, 'common.footer'),
    blocks,
  });

  return sendEmail(email, subject, text, html);
}
