// Low-level Mailgun client. Templates render via layout.ts and hand the
// finished html/text to sendEmail() here.

function getMailgunConfig() {
  const apiKey = process.env.MAILGUN_API_KEY || '';
  const domain = process.env.MAILGUN_DOMAIN || 'www.evenero.com';
  const baseUrl = process.env.MAILGUN_API_BASE || 'https://api.eu.mailgun.net/v3';
  const fromAddress = process.env.MAILGUN_FROM || `noreply@${domain}`;
  const fromName = process.env.MAILGUN_FROM_NAME || 'Evenero';

  if (!apiKey) {
    console.warn('[EMAIL] MAILGUN_API_KEY not set — emails will be logged, not sent');
  }

  return {
    apiKey,
    domain,
    baseUrl,
    from: `${fromName} <${fromAddress}>`,
  };
}

const mailgunConfig = getMailgunConfig();

// Staging/prod-test safety net: when EMAIL_WHITELIST_TO is set, every outbound
// email rutes til den adressen i stedet for ekte mottaker. X-Original-To-header
// bevarer opprinnelig mottaker. Subject-linjen forblir uendret slik at e-posten
// ser identisk ut med hva en kunde vil motta — viktig for UX-verifisering.
// Sporbarhet via Cloud Run-logs + X-Original-To når man vil se hvor mailen
// "egentlig" skulle.
function applyStagingWhitelist(to: string): { actualTo: string; isRerouted: boolean } {
  const whitelist = process.env.EMAIL_WHITELIST_TO;
  if (whitelist && whitelist.trim() !== '') {
    return { actualTo: whitelist.trim(), isRerouted: true };
  }
  return { actualTo: to, isRerouted: false };
}

function redactEmail(addr: string): string {
  const at = addr.indexOf('@');
  return at > 0 ? `${addr[0]}***${addr.slice(at)}` : '***';
}

function errorCodeForStatus(status: number): string {
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_5xx';
  return 'provider_4xx';
}

// Strukturert markør for logg-baserte alarmer. Cloud Run sender stdout-JSON til
// Cloud Logging som jsonPayload → én alarm på marker="EMAIL_SEND" AND ok=false
// fanger neste e-post-utfall (kvotestopp/5xx/timeout) som ellers var usynlig.
function logEmailSend(fields: {
  ok: boolean;
  provider: string;
  status?: number;
  errorCode?: string;
  to: string;
  id?: string;
}): void {
  console.log(JSON.stringify({ marker: 'EMAIL_SEND', ...fields }));
}

export interface SendEmailOptions {
  /**
   * Address replies should go to. For invitations, set this to the
   * inviter's address so the recipient can reply directly. Omit for
   * verification codes / system notifications.
   */
  replyTo?: string;
}

export async function sendEmail(
  to: string,
  subject: string,
  text?: string,
  html?: string,
  opts: SendEmailOptions = {},
): Promise<boolean> {
  const { actualTo, isRerouted } = applyStagingWhitelist(to);

  if (!mailgunConfig.apiKey) {
    console.warn('[EMAIL] MAILGUN_API_KEY not set — logging instead of sending');
    console.log(`[EMAIL] To: ${actualTo}${isRerouted ? ` (rerouted from ${to})` : ''}`);
    console.log(`[EMAIL] Subject: ${subject}`);
    if (opts.replyTo) console.log(`[EMAIL] Reply-To: ${opts.replyTo}`);
    if (text) console.log(`[EMAIL] Text: ${text.substring(0, 200)}…`);
    logEmailSend({ ok: true, provider: 'log', to: redactEmail(actualTo) });
    return true;
  }

  try {
    const form = new URLSearchParams();
    form.append('from', mailgunConfig.from);
    form.append('to', actualTo);
    form.append('subject', subject);
    if (text) form.append('text', text);
    if (html) form.append('html', html);
    if (isRerouted) form.append('h:X-Original-To', to);
    if (opts.replyTo) form.append('h:Reply-To', opts.replyTo);

    const url = `${mailgunConfig.baseUrl}/${mailgunConfig.domain}/messages`;
    const auth = Buffer.from(`api:${mailgunConfig.apiKey}`).toString('base64');

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(`[EMAIL] Mailgun ${response.status}: ${body.substring(0, 300)}`);
      logEmailSend({
        ok: false,
        provider: 'mailgun',
        status: response.status,
        errorCode: errorCodeForStatus(response.status),
        to: redactEmail(actualTo),
      });
      return false;
    }

    const data = (await response.json()) as { id?: string; message?: string };
    console.log(
      `[EMAIL] Sent ${data.id || '(no id)'} to ${actualTo}${isRerouted ? ` (rerouted from ${to})` : ''}`,
    );
    logEmailSend({ ok: true, provider: 'mailgun', id: data.id, to: redactEmail(actualTo) });
    return true;
  } catch (error: any) {
    console.error('[EMAIL] Failed to send via Mailgun:', error?.message || error);
    logEmailSend({ ok: false, provider: 'mailgun', errorCode: 'timeout_or_network', to: redactEmail(actualTo) });
    return false;
  }
}
