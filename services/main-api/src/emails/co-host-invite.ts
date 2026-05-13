import { translateEmail as te } from '../i18n.js';
import type { SupportedLocale } from './locale.js';
import { stripEmoji } from './locale.js';
import { renderEmail, type Block } from './layout.js';
import { sendEmail } from './send.js';

export async function sendCoHostInvitationEmail(
  email: string,
  eventName: string,
  inviterName: string,
  /** Primær-CTA: login-URL med redirect til manage-siden. */
  loginUrl: string,
  /** Sekundær (mindre) lenke: direkte til galleriet uten innlogging. */
  galleryUrl: string,
  locale: SupportedLocale,
  /** Inviter's email — used as Reply-To so the recipient can ask them about it. */
  inviterEmail?: string,
): Promise<boolean> {
  const cleanEventName = stripEmoji(eventName);
  const subject = te(locale, 'coHostInvite.subject', { eventName: cleanEventName });

  // The permissions list is now properly translated (the old template
  // hardcoded English in the HTML even though the JSON had translations).
  // We split the multi-line "permissionsList" value on newlines so each
  // bullet renders as a list item.
  const permissionsListRaw = te(locale, 'coHostInvite.permissionsList');
  const permissionItems = permissionsListRaw
    .split('\n')
    .map(line => line.replace(/^[•·\-\*]\s*/, '').trim())
    .filter(Boolean);

  const blocks: Block[] = [
    { type: 'eyebrow', text: te(locale, 'coHostInvite.eyebrow') },
    { type: 'heading', text: te(locale, 'coHostInvite.title') },
    { type: 'paragraph', text: te(locale, 'coHostInvite.body', { inviterName, eventName: cleanEventName }) },
    { type: 'divider' },
    { type: 'subheading', text: cleanEventName },
    { type: 'paragraph', text: te(locale, 'coHostInvite.description') },
    { type: 'paragraph', text: te(locale, 'coHostInvite.permissions'), align: 'center' },
    { type: 'list', items: permissionItems },
    { type: 'button', label: te(locale, 'coHostInvite.acceptButton'), href: loginUrl },
    // Sekundær (mindre) lenke — klikkbar small-tekst rett under primær-CTA.
    { type: 'linkText', label: te(locale, 'coHostInvite.viewGalleryLink'), href: galleryUrl },
    { type: 'small', text: te(locale, 'coHostInvite.dashboardNote') },
    { type: 'spacer', size: 'sm' },
    { type: 'small', text: te(locale, 'coHostInvite.ignore') },
  ];

  const { html, text } = renderEmail({
    lang: locale,
    preheader: te(locale, 'coHostInvite.preheader', { inviterName, eventName: cleanEventName }),
    footer: te(locale, 'common.footer'),
    blocks,
  });

  // Reply-To points at the inviter — recipient can reply to ask
  // "is this you?" directly instead of bouncing off noreply@.
  return sendEmail(email, subject, text, html, { replyTo: inviterEmail });
}
