// Admin notification for feedback (feature request / bug report).
// English-only because the recipient is always Lasse — no user locale matters.
// Distinct visual treatment (kept tighter, no localized footer) so it's
// obvious in the inbox it's an internal admin email rather than a customer-
// facing one.

import { TOKENS } from './tokens.js';
import { sendEmail } from './send.js';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function sendFeedbackNotificationEmail(opts: {
  type: 'feature' | 'bug';
  title: string;
  description: string;
  submitterEmail?: string;
  id: string;
}): Promise<boolean> {
  const recipient = (process.env.FEEDBACK_NOTIFICATION_EMAIL || 'lasse@styretavla.no').trim();
  const typeLabel = opts.type === 'bug' ? 'Bug report' : 'Feature request';
  const titleTrim = opts.title.length > 120 ? opts.title.slice(0, 117) + '…' : opts.title;
  const subject = `[Evenero] ${typeLabel}: ${titleTrim}`;
  const badge = opts.type === 'bug' ? '#dc2626' : TOKENS.accent;

  const text = [
    `${typeLabel}`,
    '',
    `Title: ${opts.title}`,
    '',
    'Description:',
    opts.description,
    '',
    `From: ${opts.submitterEmail || '(anonymous)'}`,
    `Submission ID: ${opts.id}`,
  ].join('\n');

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;font-family:${TOKENS.sans};background:${TOKENS.bgPage};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:${TOKENS.bgCard};border:1px solid ${TOKENS.border};border-radius:6px;">
<tr><td style="padding:24px 28px;border-bottom:1px solid ${TOKENS.hairline};">
<span style="display:inline-block;background:${badge};color:#fff;font-size:11px;font-weight:600;padding:3px 10px;border-radius:3px;letter-spacing:0.06em;text-transform:uppercase;">${typeLabel}</span>
<h2 style="margin:14px 0 0 0;font-family:${TOKENS.serif};font-size:20px;line-height:1.35;color:${TOKENS.textPrimary};">${esc(opts.title)}</h2>
</td></tr>
<tr><td style="padding:22px 28px;color:${TOKENS.textBody};font-size:14px;line-height:1.65;white-space:pre-wrap;">${esc(opts.description)}</td></tr>
<tr><td style="padding:14px 28px;background:${TOKENS.accentSoft};color:${TOKENS.textMuted};font-size:12px;border-top:1px solid ${TOKENS.hairline};">
<div><strong style="color:${TOKENS.textBody};">From:</strong> ${opts.submitterEmail ? esc(opts.submitterEmail) : '<em>(anonymous)</em>'}</div>
<div style="margin-top:4px;"><strong style="color:${TOKENS.textBody};">ID:</strong> <code style="font-family:${TOKENS.mono};color:${TOKENS.textBody};">${esc(opts.id)}</code></div>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  return sendEmail(recipient, subject, text, html);
}
