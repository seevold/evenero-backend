// Strukturert markør for logg-baserte alarmer — speiler main-api sin EMAIL_SEND-
// markør (services/main-api/src/emails/send.ts) slik at Cloud Logging-alarmene
// (marker="EMAIL_SEND" AND ok=false) også fanger web-api sine e-post-feil
// (support, print-bekreftelse, print-shipped, fulfillment-alarm).

export function redactEmail(addr: string): string {
  const at = addr.indexOf('@');
  return at > 0 ? `${addr[0]}***${addr.slice(at)}` : '***';
}

export function errorCodeForStatus(status: number): string {
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_5xx';
  return 'provider_4xx';
}

export function logEmailSend(fields: {
  ok: boolean;
  type: string;
  to: string;
  status?: number;
  errorCode?: string;
  id?: string;
}): void {
  console.log(JSON.stringify({ marker: 'EMAIL_SEND', provider: 'mailgun', ...fields }));
}
